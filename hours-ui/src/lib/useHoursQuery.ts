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

export type HoursPages<P> = {
  /** The first page, with the loading / error states of `useHoursQuery`. */
  first: HoursQueryState<P>
  /** The pages after the first, in order. Empty unless the first page is the one they were asked after. */
  more: P[]
  loadingMore: boolean
  /** The last `loadMore` failed: the pages above stay, and `loadMore` asks for the same cursor again. */
  moreFailed: boolean
  hasMore: boolean
  loadMore: () => void
  /** Asks the first page again (a Retry, a refresh after a save); the later pages are forgotten with it. */
  reload: () => void
}

type MorePages<P> = { base: P; pages: P[]; loading: boolean; failed: boolean }

/**
 * useHoursPages — a cursor-paged read: the first page as `useHoursQuery` gives it, and the later pages
 * asked one at a time with `loadMore` (specs/029-time-tracking T25; design S1 "Paging", D48).
 *
 * - `loadMore` asks for the cursor of the LAST page held; while one is in flight, or when the last page has
 *   no cursor, it asks nothing.
 * - A failed `loadMore` keeps every page already held (each was complete when read, D48), sets `moreFailed`,
 *   and the next `loadMore` asks for the same cursor again.
 * - The later pages belong to the first page they were asked after: a new key, or a `reload`, makes a new
 *   first page, so they are gone in that very render (never an old page under new filters), the request in
 *   flight is aborted and its answer, however late, is dropped. The same on unmount.
 */
export const useHoursPages = <P extends { nextCursor: string | null }>(
  key: string | null,
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<P>,
): HoursPages<P> => {
  const { state: first, reload } = useHoursQuery(key, (signal) => fetchPage(undefined, signal))
  const base = first.status === 'loaded' ? first.data : null

  const [held, setHeld] = useState<MorePages<P> | null>(null)
  const current = base !== null && held !== null && held.base === base ? held : null
  const pages = current?.pages ?? []
  const last = pages.at(-1) ?? base
  const hasMore = last !== null && last.nextCursor !== null

  const fetchRef = useRef(fetchPage)
  useEffect(() => {
    fetchRef.current = fetchPage
  })

  const inFlight = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      inFlight.current?.abort()
      inFlight.current = null
    },
    [base],
  )

  const loadMore = () => {
    if (base === null || last === null || last.nextCursor === null || inFlight.current !== null) return
    const controller = new AbortController()
    inFlight.current = controller
    setHeld({ base, pages, loading: true, failed: false })
    const settle = (next: MorePages<P>) => {
      if (controller.signal.aborted) return
      inFlight.current = null
      setHeld(next)
    }
    fetchRef.current(last.nextCursor, controller.signal).then(
      (page) => settle({ base, pages: [...pages, page], loading: false, failed: false }),
      () => settle({ base, pages, loading: false, failed: true }),
    )
  }

  return {
    first,
    more: pages,
    loadingMore: current?.loading ?? false,
    moreFailed: current?.failed ?? false,
    hasMore,
    loadMore,
    reload,
  }
}
