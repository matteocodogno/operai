/**
 * runtimeRemotes — production runtime resolution for the shell's federated
 * remote URLs (T17, specs/20260709-suite-shell, AC-5.3, plan.md Deploy + Risk R6).
 *
 * PROBLEM this solves: `shell/vite.config.ts` declares `estimai`/`refund`/
 * `admin` remote entries using `process.env['ESTIMAI_REMOTE_URL']` /
 * `process.env['REFUND_REMOTE_URL']` / `process.env['ADMIN_REMOTE_URL']`,
 * read at Vite CONFIG-EVALUATION time (i.e. at `vite build`). Those values
 * are baked as literal strings into the
 * shell's compiled bundle — changing which URL the shell points a remote at
 * (e.g. because a remote's origin moved) requires re-running `vite build`
 * for the shell, i.e. a shell rebuild, even though the shell's own code
 * hasn't changed. That contradicts AC-5.3 / plan.md's Deploy section
 * ("a remote can be redeployed without rebuilding the shell or the other
 * remotes") and Risk R6 ("remote URLs are injected via runtime env vars,
 * not build-baked").
 *
 * MECHANISM: `@module-federation/runtime`'s `registerRemotes(remotes, {
 * force: true })` lets already-declared remotes (the ones from
 * vite.config.ts) be OVERRIDDEN at runtime, before they are first loaded —
 * this is MF2's first-class "dynamic remotes" API, not an internal hack.
 * This module resolves the override URLs at page-load time (in the
 * browser, on every request) from, in priority order:
 *
 *   1. `window.__OPERAI_RUNTIME_CONFIG__` — set by a plain, non-hashed
 *      script (see index.html) that can be swapped independently of the
 *      shell's JS bundle.
 *   2. A same-origin `GET /runtime-config.json` (a static file in
 *      `shell/public/`, fetched with `cache: 'no-store'` so a redeploy of
 *      just that file is picked up immediately, not served stale from the
 *      HTTP cache).
 *
 * If neither source yields a value for a given remote, this resolves to an
 * EMPTY list for that remote and `main.tsx` skips `registerRemotes`
 * entirely for it — the remote falls through to whatever vite.config.ts
 * baked at build time (the existing, unchanged behavior). This is
 * deliberately additive/fail-safe: local dev and the T16 e2e suite (which
 * run entirely off the build-time `ESTIMAI_REMOTE_URL`/`REFUND_REMOTE_URL`/
 * `ADMIN_REMOTE_URL` env vars, see playwright.config.ts) never ship a
 * `runtime-config.json`, so `fetch()` 404s, this resolves to `{}`, and
 * behavior is byte-for-byte identical to before this file existed.
 *
 * `admin` (specs/20260713-auth-roles-permissions, T27) was added to this override
 * list following the exact same shape as `estimai`/`refund` above — no new
 * mechanism, just a third optional key so the Admin (Roles & Permissions)
 * remote's origin can be repointed the same way, per AC-5.3 / ADR 20260709-suite-frontend-module-federation.
 *
 * `notify` (specs/20260713-notification-center, T13) follows the identical shape —
 * a fourth optional key so the notification center remote's origin can be
 * repointed the same way. Unlike `estimai`/`refund`/`admin`, the shell route
 * that mounts it (`/notify/$`, src/router.tsx) is deliberately NOT
 * app-access-gated (plan.md "Shell changes") — that's a routing/permissions
 * concern, orthogonal to this module's job of resolving WHERE the remote's
 * code is served from.
 *
 * `inventory` (specs/20261006-hardware-inventory, T41) follows the identical shape —
 * a fifth optional key. One remote, TWO shell routes (ADR 20261006-ungated-second-federated-entry-of-a-gated-remote): the gated
 * `/inventory/$` tool route and the ungated `/devices` route both resolve their
 * code from this single entry; where it is served from is orthogonal to who may
 * reach which route.
 *
 * `hours` (specs/20261112-time-tracking, T23) follows the identical shape — a further optional key.
 * Its one entry is mounted at the UNGATED `/hours/$` route (ADR 20261112-hours-ui-ungated-remote); where its code is served
 * from is, again, orthogonal to who may reach the route.
 *
 * HONEST SCOPE NOTE (see T17 report): for the common production case — a
 * remote redeployed at its EXISTING, stable custom-domain URL — the shell
 * never needs `runtime-config.json` to change at all, because the URL
 * itself didn't change; only the content served at it did. This module's
 * value is decoupling the shell's *code* from the exact remote origin, so
 * that if an origin ever needs to change (domain migration, pointing prod
 * at a hotfix deploy) a static JSON file can be updated instead of the
 * shell being rebuilt. It does not, by itself, eliminate deploying that one
 * static file when an origin genuinely changes.
 */

export interface RuntimeRemoteConfig {
  estimai?: string
  refund?: string
  admin?: string
  notify?: string
  inventory?: string
  /** specs/20261101-crm: the CRM remote's remoteEntry.js. */
  crm?: string
  /** specs/20261104-meetings: the Meetings remote's remoteEntry.js (three mountable entries + ./version). */
  meetings?: string
  /** specs/20261103-projects: the Projects remote's remoteEntry.js. */
  projects?: string
  /** specs/20261116-letterhead-service: the Letterheads remote's remoteEntry.js. */
  letterheads?: string
  /** specs/20261112-time-tracking: the Hours remote's remoteEntry.js (one entry, ungated, plus ./version). */
  hours?: string
}

declare global {
  interface Window {
    /**
     * Optional runtime override, set by a static (non-Vite-bundled) script
     * — e.g. `<script src="/runtime-config.js"></script>` in index.html,
     * served and swappable independently of the hashed JS bundle. Not
     * populated by default; absent in local dev and the T16 e2e suite.
     */
    __OPERAI_RUNTIME_CONFIG__?: RuntimeRemoteConfig
  }
}

/** Shape `@module-federation/runtime`'s `registerRemotes` expects (mirrors vite.config.ts's static remote entries). */
export interface RuntimeRemoteEntry {
  name: 'estimai' | 'refund' | 'admin' | 'notify' | 'inventory' | 'crm' | 'meetings' | 'projects' | 'letterheads' | 'hours'
  entry: string
  type: 'module'
  entryGlobalName: string
  shareScope: string
}

async function loadRuntimeConfig(): Promise<RuntimeRemoteConfig> {
  if (typeof window !== 'undefined' && window.__OPERAI_RUNTIME_CONFIG__) {
    return window.__OPERAI_RUNTIME_CONFIG__
  }
  try {
    const response = await fetch('/runtime-config.json', { cache: 'no-store' })
    if (!response.ok) {
      return {}
    }
    const data = (await response.json()) as RuntimeRemoteConfig
    return data ?? {}
  } catch {
    // No runtime-config.json (404), a network error, or invalid JSON — all
    // treated the same: no runtime override, fall through to the build-time
    // remotes declared in vite.config.ts. Never throws.
    return {}
  }
}

/**
 * Resolves runtime overrides for the `estimai`/`refund`/`admin` remotes.
 * Returns an empty array when no runtime config is present (local dev, e2e,
 * or a production deploy that hasn't opted into runtime-config.json because
 * its remotes' custom domains are already stable — see module doc).
 */
export async function resolveRuntimeRemotes(): Promise<RuntimeRemoteEntry[]> {
  const config = await loadRuntimeConfig()
  const remotes: RuntimeRemoteEntry[] = []

  if (config.estimai) {
    remotes.push({
      name: 'estimai',
      entry: config.estimai,
      type: 'module',
      entryGlobalName: 'estimai',
      shareScope: 'default',
    })
  }

  if (config.refund) {
    remotes.push({
      name: 'refund',
      entry: config.refund,
      type: 'module',
      entryGlobalName: 'refund',
      shareScope: 'default',
    })
  }

  if (config.admin) {
    remotes.push({
      name: 'admin',
      entry: config.admin,
      type: 'module',
      entryGlobalName: 'admin',
      shareScope: 'default',
    })
  }

  if (config.notify) {
    remotes.push({
      name: 'notify',
      entry: config.notify,
      type: 'module',
      entryGlobalName: 'notify',
      shareScope: 'default',
    })
  }

  if (config.inventory) {
    remotes.push({
      name: 'inventory',
      entry: config.inventory,
      type: 'module',
      entryGlobalName: 'inventory',
      shareScope: 'default',
    })
  }

  if (config.crm) {
    remotes.push({
      name: 'crm',
      entry: config.crm,
      type: 'module',
      entryGlobalName: 'crm',
      shareScope: 'default',
    })
  }

  if (config.meetings) {
    remotes.push({
      name: 'meetings',
      entry: config.meetings,
      type: 'module',
      entryGlobalName: 'meetings',
      shareScope: 'default',
    })
  }

  if (config.projects) {
    remotes.push({
      name: 'projects',
      entry: config.projects,
      type: 'module',
      entryGlobalName: 'projects',
      shareScope: 'default',
    })
  }

  if (config.letterheads) {
    remotes.push({
      name: 'letterheads',
      entry: config.letterheads,
      type: 'module',
      entryGlobalName: 'letterheads',
      shareScope: 'default',
    })
  }

  if (config.hours) {
    remotes.push({
      name: 'hours',
      entry: config.hours,
      type: 'module',
      entryGlobalName: 'hours',
      shareScope: 'default',
    })
  }

  return remotes
}
