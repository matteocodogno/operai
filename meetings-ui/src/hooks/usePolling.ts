import { useCallback, useEffect, useRef, useState } from 'react'
import { nextDelay } from '../lib/backoff'
import type { Fetcher } from './useResource'

export type PollingOptions<T> = {
  /** The wait before the first re-poll (default 2 s). */
  baseMs?: number
  /** Each wait is the previous one times this (default 1.5). */
  factor?: number
  /** The wait never grows past this (default 15 s). */
  maxMs?: number
  /** Polling stops for good once this holds for the latest data; absent means "never stop". */
  until?: (data: T) => boolean
  /** `false` loads and polls nothing (the meeting is not in a state worth watching). */
  enabled?: boolean
}

export type PollingState<T> = {
  /** `idle` = disabled and nothing loaded; `error` = the LATEST poll failed (`data` may still hold the last good one). */
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: T | null
  error: unknown
  /** Fetches now and restarts the wait from the base (the page's Retry, or after a write changed the state). */
  retry: () => void
}

type Outcome<T> = { fetcher: Fetcher<T>; data: T | null; error: unknown; failed: boolean }

/**
 * usePolling — watches a resource that changes on the server while the person waits (a meeting in
 * `processing`, a summary `generating`; design.md F9, F10). It fetches at once, then again after a
 * wait that grows from `baseMs` by `factor` to `maxMs` (`lib/backoff.ts`), until `until(data)` holds.
 *
 *   - A failed poll keeps the last good `data`, sets `error`, and keeps polling on the same schedule
 *     so a brief outage recovers on its own; the page decides whether to show the error.
 *   - A hidden tab fetches nothing (the wait still runs), so a background tab costs no requests.
 *   - `fetcher` must be stable (`useCallback`), like `useResource`: a new fetcher (another meeting)
 *     restarts the loop and never shows the old data. The request is aborted on unmount, and an
 *     answer that arrives afterwards is ignored.
 */
export function usePolling<T>(
  fetcher: Fetcher<T>,
  { baseMs = 2000, factor = 1.5, maxMs = 15000, until, enabled = true }: PollingOptions<T> = {},
): PollingState<T> {
  const [restart, setRestart] = useState(0)
  const [outcome, setOutcome] = useState<Outcome<T> | null>(null)
  // The latest `until` without restarting the loop each time the caller passes a fresh closure.
  const untilRef = useRef(until)
  useEffect(() => {
    untilRef.current = until
  })

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let delay = Math.min(baseMs, maxMs)

    const schedule = () => {
      timer = setTimeout(() => void tick(), delay)
      delay = nextDelay(delay, { factor, maxMs })
    }

    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) {
        schedule()
        return
      }
      try {
        const data = await fetcher(controller.signal)
        if (controller.signal.aborted) return
        setOutcome({ fetcher, data, error: null, failed: false })
        if (untilRef.current?.(data)) return
      } catch (error) {
        if (controller.signal.aborted) return
        setOutcome((previous) => ({
          fetcher,
          data: previous !== null && previous.fetcher === fetcher ? previous.data : null,
          error,
          failed: true,
        }))
      }
      schedule()
    }

    void tick()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [fetcher, enabled, baseMs, factor, maxMs, restart])

  const retry = useCallback(() => setRestart((current) => current + 1), [])

  const current = outcome !== null && outcome.fetcher === fetcher ? outcome : null
  return {
    status: current === null ? (enabled ? 'loading' : 'idle') : current.failed ? 'error' : 'ready',
    data: current?.data ?? null,
    error: current?.error ?? null,
    retry,
  }
}
