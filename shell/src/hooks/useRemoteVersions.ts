/**
 * useRemoteVersions — resolves each mounted remote's OWN build-time version
 * for display in the About dialog (AboutModal.tsx), independently of the
 * umbrella suite version `appInfo.ts`/`APP_VERSION` already shows.
 *
 * Each remote (estimai-ui, refund-ui, admin-ui, notify-ui) exposes a tiny
 * `./version` federated module (see each remote's src/version.ts +
 * vite.config.ts `exposes`) carrying its own package.json version, baked in
 * at ITS OWN build time — the same same-directory-safe `readFileSync('./package.json')`
 * pattern every remote's vite.config.ts already uses for shared-singleton
 * `requiredVersion`s, just additionally exposed across the federation seam
 * instead of only read locally.
 *
 * A remote's `./version` module can fail to resolve for reasons that have
 * NOTHING to do with whether the remote itself is healthy right now: the
 * remote's origin can be unreachable, the remote can be mid cold-start, or —
 * the case that matters most going forward, since every app in this suite
 * deploys independently — the remote can simply PREDATE this change and not
 * expose `./version` at all yet. None of that may ever throw into the About
 * dialog or block it from rendering: each remote's version resolves
 * independently, raced against a short timeout, and every failure shape
 * (rejected import, timeout, missing/malformed export) degrades the same
 * way, to `undefined` — AboutModal renders that as a muted "—" row, never an
 * error, and the modal itself renders immediately with whatever is already
 * known, updating each row as its own promise settles rather than waiting
 * for the slowest remote.
 */
import { useEffect, useState } from 'react'

/** How long a single remote's `./version` import is given before it's treated as unavailable. */
export const REMOTE_VERSION_TIMEOUT_MS = 1500

export interface RemoteVersionSource {
  /** Matches runtimeRemotes.ts's remote names — the suite's canonical remote id set. */
  id: 'estimai' | 'refund' | 'admin' | 'notify'
  /** Human-readable label for the About dialog row. */
  label: string
  /** Loads the remote's exposed `./version` module. Called fresh every resolution — never memoized across calls. */
  loader: () => Promise<{ REMOTE_VERSION?: unknown }>
}

// One entry per suite remote — mirrors runtimeRemotes.ts's four-remote set.
// Deliberately includes `notify`, even though it's absent from
// lib/tools.ts's TOOLS registry: TOOLS is the permission-gated SIDEBAR
// (which tools can this signed-in user navigate to), this is "every remote
// the shell can ever mount" — a strictly wider set, and the right one for a
// dialog describing the software itself rather than what one user can see.
export const REMOTE_VERSION_SOURCES: readonly RemoteVersionSource[] = [
  { id: 'estimai', label: 'EstimAI', loader: () => import('estimai/version') },
  { id: 'refund', label: 'Refund', loader: () => import('refund/version') },
  { id: 'admin', label: 'Admin', loader: () => import('admin/version') },
  { id: 'notify', label: 'Notify', loader: () => import('notify/version') },
]

function isVersionString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

/**
 * Resolves one remote's version. Never throws/rejects — a rejected import, a
 * timeout, and a missing/malformed export are all indistinguishable to the
 * caller, on purpose: AboutModal only ever needs "known" vs. "not known
 * right now", never a reason why.
 */
async function resolveOne(source: RemoteVersionSource, timeoutMs: number): Promise<string | undefined> {
  try {
    const mod = await Promise.race([source.loader(), rejectAfter(timeoutMs)])
    return isVersionString(mod?.REMOTE_VERSION) ? mod.REMOTE_VERSION : undefined
  } catch {
    return undefined
  }
}

/**
 * Kicks off all remotes' version resolutions in parallel and updates state
 * as EACH ONE settles, independently — callers (AboutModal) must render
 * immediately with the initial (all-unknown) state and let rows fill in as
 * their own promise resolves, never blocking on `Promise.all`/the slowest
 * remote.
 */
export function useRemoteVersions(
  sources: readonly RemoteVersionSource[] = REMOTE_VERSION_SOURCES,
  timeoutMs: number = REMOTE_VERSION_TIMEOUT_MS,
): Partial<Record<RemoteVersionSource['id'], string>> {
  const [versions, setVersions] = useState<Partial<Record<RemoteVersionSource['id'], string>>>({})

  useEffect(() => {
    let cancelled = false

    for (const source of sources) {
      resolveOne(source, timeoutMs).then((version) => {
        if (!cancelled) {
          setVersions((current) => ({ ...current, [source.id]: version }))
        }
      })
    }

    return () => {
      cancelled = true
    }
  }, [sources, timeoutMs])

  return versions
}
