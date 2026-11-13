/**
 * useHoursQuery — one read of My hours / Everyone's hours, keyed by what it asks (specs/029-time-tracking
 * T24; design F4 step 1: "filters apply on change; stale answers are discarded").
 *
 * The caller names the read with a `key` (the filters, serialised) and gives `run`, which fetches with
 * the `AbortSignal` it is handed. The hook then guarantees what a filtered, live view needs:
 *
 * - a new `key` is `loading` in the same render, so the previous key's data is never shown under the new
 *   filters, even for one frame;
 * - an answer (or failure) of a request that is no longer wanted is discarded however late it arrives
 *   (each outcome carries the request it answered, and the request is aborted as soon as it is
 *   superseded, when the key goes away and on unmount);
 * - `key === null` asks nothing and is `idle` (a Custom range that cannot be sent);
 * - the same key does not ask again when `run` is a new function on every render, and the `run` used is
 *   the latest at the moment the key changed;
 * - `reload` asks again for the same key (a Retry, a refresh after a save), showing `loading` meanwhile.
 *
 * It is deliberately not a cache: a view that changes its filters back asks again, because a cached
 * answer could be one booking out of date (plan R7: totals are read live).
 */
import { useEffect, useRef, useState } from 'react'

export type HoursQueryState<T> =
  { status: 'idle' } | { status: 'loading' } | { status: 'loaded'; data: T } | { status: 'error'; error: unknown }

type Outcome<T> = { request: string; ok: true; data: T } | { request: string; ok: false; error: unknown }

export const useHoursQuery = <T>(
  key: string | null,
  run: (signal: AbortSignal) => Promise<T>,
): { state: HoursQueryState<T>; reload: () => void } => {
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome<T> | null>(null)

  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })

  // A reload is a new request for the same key.
  const request = key === null ? null : `${attempt}:${key}`

  useEffect(() => {
    if (request === null) return
    const controller = new AbortController()
    runRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setOutcome({ request, ok: true, data })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ request, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [request])

  const state: HoursQueryState<T> =
    request === null
      ? { status: 'idle' }
      : outcome?.request !== request
        ? { status: 'loading' }
        : outcome.ok
          ? { status: 'loaded', data: outcome.data }
          : { status: 'error', error: outcome.error }

  return { state, reload: () => setAttempt((current) => current + 1) }
}
