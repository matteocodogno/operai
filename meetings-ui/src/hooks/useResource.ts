import { useCallback, useEffect, useState } from 'react'

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>

export type ResourceState<T> = {
  status: 'loading' | 'ready' | 'error'
  data: T | null
  /** The thrown value of a failed load (an `ApiError`, or a network `TypeError`). */
  error: unknown
  /** Loads again (after a failure, or after a write elsewhere changed the data). */
  retry: () => void
  /** Replaces the loaded value with one a write returned, without a round trip. */
  replace: (data: T) => void
}

type Outcome<T> =
  | { fetcher: Fetcher<T>; attempt: number; ok: true; data: T }
  | { fetcher: Fetcher<T>; attempt: number; ok: false; error: unknown }

/**
 * useResource — loads `fetcher` and tracks one of loading / ready / error.
 *
 * `fetcher` must be stable (`useCallback`): a new fetcher — new filters, a new
 * page, another meeting — is a new load. An outcome counts only for the fetcher
 * and attempt that produced it, so a slow answer for page 1 can never replace
 * page 2, and a retry shows `loading` without a synchronous setState inside the
 * effect (the crm-ui / inventory-ui `useResource` pattern). The request is
 * aborted on unmount and whenever it is superseded.
 */
export function useResource<T>(fetcher: Fetcher<T>): ResourceState<T> {
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome<T> | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetcher(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setOutcome({ fetcher, attempt, ok: true, data })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ fetcher, attempt, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [fetcher, attempt])

  const retry = useCallback(() => setAttempt((current) => current + 1), [])
  const replace = useCallback((data: T) => setOutcome({ fetcher, attempt, ok: true, data }), [fetcher, attempt])

  const current = outcome !== null && outcome.fetcher === fetcher && outcome.attempt === attempt ? outcome : null
  return {
    status: current === null ? 'loading' : current.ok ? 'ready' : 'error',
    data: current?.ok ? current.data : null,
    error: current !== null && !current.ok ? current.error : null,
    retry,
    replace,
  }
}
