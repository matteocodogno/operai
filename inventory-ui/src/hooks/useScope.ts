import { useCallback, useEffect, useState } from 'react'
import { getScope } from '../lib/scopeApi'
import type { Scope } from '../lib/types'

export type ScopeState = {
  /** `idle` only when the hook is disabled (the caller holds no capability). */
  status: 'idle' | 'loading' | 'ready' | 'error'
  scope: Scope | null
  /** True once loaded and BOTH capability lists are empty: tool access, but no entity (design Resolutions G1/G11). */
  isEmpty: boolean
  /** The thrown value of a failed load (an `ApiError`, or a network `TypeError`); null otherwise. */
  error: unknown
  /** Loads again after a failure. */
  retry: () => void
}

type Outcome = { attempt: number; scope: Scope; error?: undefined } | { attempt: number; scope?: undefined; error: unknown }

/**
 * useScope — loads `GET /scope`, the entities each capability covers for the
 * caller (T28, specs/015-hardware-inventory; plan.md § API contracts), and
 * derives "empty" for the "no entity in your scope" state.
 *
 * `enabled` is false for a caller with no capability (the layout renders
 * PermissionDenied and must not call the API). Loading is derived — an outcome
 * counts only for the attempt that produced it — so a retry shows `loading`
 * without a synchronous setState in the effect, and a stale answer from a
 * superseded attempt can never overwrite a newer one. The request is aborted
 * on unmount and on re-run.
 */
export function useScope(enabled = true): ScopeState {
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    getScope({ signal: controller.signal }).then(
      (scope) => {
        if (!controller.signal.aborted) setOutcome({ attempt, scope })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ attempt, error })
      },
    )
    return () => controller.abort()
  }, [enabled, attempt])

  const retry = useCallback(() => setAttempt((current) => current + 1), [])

  const current = enabled && outcome?.attempt === attempt ? outcome : null
  const status: ScopeState['status'] = !enabled
    ? 'idle'
    : current === null
      ? 'loading'
      : current.scope !== undefined
        ? 'ready'
        : 'error'
  const scope = current?.scope ?? null

  return {
    status,
    scope,
    isEmpty: scope !== null && scope.asset.length === 0 && scope.ledger.length === 0,
    error: current?.error ?? null,
    retry,
  }
}
