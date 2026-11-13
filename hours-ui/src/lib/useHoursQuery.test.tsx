/**
 * @vitest-environment jsdom
 *
 * useHoursQuery — one read keyed by what it asks (specs/029-time-tracking T24, design F4 step 1:
 * "stale answers are discarded"). The three reads of a filter change (the entries, the chosen totals,
 * the day totals) and the lists each use it, so the rules are proven here once: a key change shows
 * loading at once, never the previous key's data; an answer for an older key is discarded however late
 * it arrives; a request that is no longer wanted is aborted; and `reload` asks again. `useHoursPages` adds
 * the later pages of a cursor-paged read (T25, D48): they are asked one at a time from the last page's
 * cursor, a failed one keeps the pages already shown, and a new key or a reload forgets them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { deferred } from '../test-support/fakeApi'
import { useHoursPages, useHoursQuery } from './useHoursQuery'

afterEach(() => cleanup())

describe('useHoursQuery', () => {
  it('asks nothing while there is no key: idle', () => {
    const run = vi.fn()
    const { result } = renderHook(() => useHoursQuery<string>(null, run))
    expect(result.current.state).toEqual({ status: 'idle' })
    expect(run).not.toHaveBeenCalled()
  })

  it('is loading from the first render and loaded with the answer', async () => {
    const answer = deferred<string>()
    const { result } = renderHook(() => useHoursQuery('a', () => answer.promise))
    expect(result.current.state).toEqual({ status: 'loading' })

    await act(async () => answer.resolve('one'))

    expect(result.current.state).toEqual({ status: 'loaded', data: 'one' })
  })

  it('is an error carrying what was thrown when the read fails', async () => {
    const failure = new Error('boom')
    const { result } = renderHook(() => useHoursQuery('a', () => Promise.reject(failure)))
    await act(async () => undefined)
    expect(result.current.state).toEqual({ status: 'error', error: failure })
  })

  it('asks again for another key, and is loading at once, never showing the previous key’s data', async () => {
    const run = vi.fn<(signal: AbortSignal) => Promise<string>>(() => Promise.resolve('answer'))
    const { result, rerender } = renderHook(({ key }) => useHoursQuery(key, run), { initialProps: { key: 'a' } })
    await act(async () => undefined)
    expect(result.current.state).toEqual({ status: 'loaded', data: 'answer' })

    const second = deferred<string>()
    run.mockReturnValueOnce(second.promise)
    rerender({ key: 'b' })

    expect(result.current.state).toEqual({ status: 'loading' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('discards an answer that arrives after the key changed, however late', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const run = vi.fn<(signal: AbortSignal) => Promise<string>>()
    run.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(({ key }) => useHoursQuery(key, run), { initialProps: { key: 'a' } })

    rerender({ key: 'b' })
    await act(async () => second.resolve('for b'))
    expect(result.current.state).toEqual({ status: 'loaded', data: 'for b' })

    // The answer to the first key lands late, and a failure of it would be as unwelcome.
    await act(async () => first.resolve('for a'))
    expect(result.current.state).toEqual({ status: 'loaded', data: 'for b' })
  })

  it('discards the failure of a request that is no longer wanted', async () => {
    const first = deferred<string>()
    const run = vi.fn<(signal: AbortSignal) => Promise<string>>()
    run.mockReturnValueOnce(first.promise).mockResolvedValueOnce('for b')
    const { result, rerender } = renderHook(({ key }) => useHoursQuery(key, run), { initialProps: { key: 'a' } })

    rerender({ key: 'b' })
    await act(async () => undefined)
    await act(async () => first.reject(new Error('late failure')))

    expect(result.current.state).toEqual({ status: 'loaded', data: 'for b' })
  })

  it('aborts the request in flight when the key changes, and when it unmounts', async () => {
    const signals: AbortSignal[] = []
    const run = (signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<string>(() => undefined)
    }
    const { rerender, unmount } = renderHook(({ key }) => useHoursQuery(key, run), { initialProps: { key: 'a' } })
    expect(signals[0]!.aborted).toBe(false)

    rerender({ key: 'b' })
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)

    unmount()
    expect(signals[1]!.aborted).toBe(true)
  })

  it('aborts the request when the key goes away (nothing to ask any more)', async () => {
    const signals: AbortSignal[] = []
    const run = (signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<string>(() => undefined)
    }
    const { result, rerender } = renderHook(({ key }) => useHoursQuery(key, run), {
      initialProps: { key: 'a' as string | null },
    })
    rerender({ key: null })
    expect(signals[0]!.aborted).toBe(true)
    expect(result.current.state).toEqual({ status: 'idle' })
  })

  it('does not ask again for the same key, even when `run` is a new function on every render', async () => {
    const calls = vi.fn()
    const { rerender } = renderHook(() =>
      useHoursQuery('a', () => {
        calls()
        return Promise.resolve('x')
      }),
    )
    await act(async () => undefined)
    rerender()
    rerender()
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('uses the latest `run` for the key it asks (the closure of the render that changed the key)', async () => {
    const seen: string[] = []
    const { rerender } = renderHook(
      ({ key, text }) =>
        useHoursQuery(key, () => {
          seen.push(text)
          return Promise.resolve(text)
        }),
      { initialProps: { key: 'a', text: 'first' } },
    )
    rerender({ key: 'b', text: 'second' })
    await act(async () => undefined)
    expect(seen).toEqual(['first', 'second'])
  })

  it('reload asks again, showing loading, and also after a failure', async () => {
    const run = vi.fn<(signal: AbortSignal) => Promise<string>>()
    run.mockRejectedValueOnce(new Error('first try')).mockResolvedValueOnce('second try')
    const { result } = renderHook(() => useHoursQuery('a', run))
    await act(async () => undefined)
    expect(result.current.state.status).toBe('error')

    act(() => result.current.reload())
    expect(result.current.state).toEqual({ status: 'loading' })
    await act(async () => undefined)

    expect(run).toHaveBeenCalledTimes(2)
    expect(result.current.state).toEqual({ status: 'loaded', data: 'second try' })
  })

  it('a reload while one is in flight supersedes it: the first answer is dropped', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const run = vi.fn<(signal: AbortSignal) => Promise<string>>()
    run.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useHoursQuery('a', run))

    act(() => result.current.reload())
    await act(async () => first.resolve('old'))
    expect(result.current.state).toEqual({ status: 'loading' })

    await act(async () => second.resolve('new'))
    expect(result.current.state).toEqual({ status: 'loaded', data: 'new' })
  })
})

type Page = { items: string[]; nextCursor: string | null }
const page = (items: string[], nextCursor: string | null = null): Page => ({ items, nextCursor })

describe('useHoursPages (D48)', () => {
  /** A paged source that answers by cursor, and records the cursors it was asked for. */
  const source = (pages: Record<string, Page>) => {
    const asked: (string | undefined)[] = []
    const fetchPage = vi.fn((cursor: string | undefined) => {
      asked.push(cursor)
      return Promise.resolve(pages[cursor ?? 'first']!)
    })
    return { asked, fetchPage }
  }

  it('is the first page of useHoursQuery, with nothing after it and hasMore from its cursor', async () => {
    const { fetchPage } = source({ first: page(['a'], 'c2') })
    const { result } = renderHook(() => useHoursPages('k', fetchPage))
    expect(result.current.first).toEqual({ status: 'loading' })
    expect(result.current.hasMore).toBe(false)

    await act(async () => undefined)

    expect(result.current.first).toEqual({ status: 'loaded', data: page(['a'], 'c2') })
    expect(result.current.more).toEqual([])
    expect(result.current.hasMore).toBe(true)
    expect(fetchPage).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
  })

  it('loadMore asks for the cursor of the last page and appends the answer; no cursor left is hasMore false', async () => {
    const { asked, fetchPage } = source({
      first: page(['a'], 'c2'),
      c2: page(['b'], 'c3'),
      c3: page(['c']),
    })
    const { result } = renderHook(() => useHoursPages('k', fetchPage))
    await act(async () => undefined)

    act(() => result.current.loadMore())
    expect(result.current.loadingMore).toBe(true)
    await act(async () => undefined)
    expect(result.current.more).toEqual([page(['b'], 'c3')])
    expect(result.current.loadingMore).toBe(false)
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    await act(async () => undefined)

    expect(asked).toEqual([undefined, 'c2', 'c3'])
    expect(result.current.more).toEqual([page(['b'], 'c3'), page(['c'])])
    expect(result.current.hasMore).toBe(false)
  })

  it('a second loadMore while one is in flight, or with no cursor left, asks nothing', async () => {
    const slow = deferred<Page>()
    const fetchPage = vi.fn((cursor: string | undefined) =>
      cursor === undefined ? Promise.resolve(page(['a'], 'c2')) : slow.promise,
    )
    const { result } = renderHook(() => useHoursPages('k', fetchPage))
    await act(async () => undefined)

    act(() => result.current.loadMore())
    act(() => result.current.loadMore())
    expect(fetchPage).toHaveBeenCalledTimes(2)

    await act(async () => slow.resolve(page(['b'])))
    act(() => result.current.loadMore())
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('a failed loadMore keeps the pages already shown, says so, and loadMore again retries the SAME cursor', async () => {
    const failure = new Error('503')
    const fetchPage = vi.fn<(cursor: string | undefined, signal: AbortSignal) => Promise<Page>>()
    fetchPage
      .mockResolvedValueOnce(page(['a'], 'c2'))
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(page(['b']))
    const { result } = renderHook(() => useHoursPages('k', fetchPage))
    await act(async () => undefined)

    act(() => result.current.loadMore())
    await act(async () => undefined)

    expect(result.current.moreFailed).toBe(true)
    expect(result.current.loadingMore).toBe(false)
    expect(result.current.first).toEqual({ status: 'loaded', data: page(['a'], 'c2') })
    expect(result.current.hasMore).toBe(true)

    act(() => result.current.loadMore())
    expect(result.current.moreFailed).toBe(false)
    expect(result.current.loadingMore).toBe(true)
    await act(async () => undefined)

    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'c2', 'c2'])
    expect(result.current.more).toEqual([page(['b'])])
  })

  it('a new key forgets the later pages at once and aborts the one in flight; its late answer is dropped', async () => {
    const slow = deferred<Page>()
    const signals: AbortSignal[] = []
    const fetchPage = vi.fn((cursor: string | undefined, signal: AbortSignal) => {
      signals.push(signal)
      if (cursor === 'c2') return slow.promise
      return Promise.resolve(page(['a'], 'c2'))
    })
    const { result, rerender } = renderHook(({ key }) => useHoursPages(key, fetchPage), {
      initialProps: { key: 'one' },
    })
    await act(async () => undefined)
    act(() => result.current.loadMore())
    expect(result.current.loadingMore).toBe(true)

    rerender({ key: 'two' })

    expect(signals[1]!.aborted).toBe(true)
    expect(result.current.more).toEqual([])
    expect(result.current.loadingMore).toBe(false)
    expect(result.current.first).toEqual({ status: 'loading' })
    await act(async () => undefined)
    await act(async () => slow.resolve(page(['late'])))
    expect(result.current.more).toEqual([])
  })

  it('a new key after a loaded extra page shows no extra page from the old key, even for one render', async () => {
    const fetchPage = vi.fn((cursor: string | undefined) =>
      Promise.resolve(cursor === undefined ? page(['a'], 'c2') : page(['b'])),
    )
    const { result, rerender } = renderHook(({ key }) => useHoursPages(key, fetchPage), {
      initialProps: { key: 'one' },
    })
    await act(async () => undefined)
    act(() => result.current.loadMore())
    await act(async () => undefined)
    expect(result.current.more).toHaveLength(1)

    rerender({ key: 'two' })
    expect(result.current.more).toEqual([])
    expect(result.current.hasMore).toBe(false)

    await act(async () => undefined)
    expect(result.current.more).toEqual([])
    expect(result.current.hasMore).toBe(true)
  })

  it('reload asks the first page again and forgets the later pages and a failed load', async () => {
    const fetchPage = vi.fn<(cursor: string | undefined, signal: AbortSignal) => Promise<Page>>()
    fetchPage
      .mockResolvedValueOnce(page(['a'], 'c2'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(page(['a2'], 'c9'))
    const { result } = renderHook(() => useHoursPages('k', fetchPage))
    await act(async () => undefined)
    act(() => result.current.loadMore())
    await act(async () => undefined)
    expect(result.current.moreFailed).toBe(true)

    act(() => result.current.reload())
    expect(result.current.first).toEqual({ status: 'loading' })
    expect(result.current.moreFailed).toBe(false)
    await act(async () => undefined)

    expect(result.current.first).toEqual({ status: 'loaded', data: page(['a2'], 'c9') })
    expect(result.current.more).toEqual([])
    expect(result.current.hasMore).toBe(true)
  })

  it('aborts a load in flight when it unmounts', async () => {
    const signals: AbortSignal[] = []
    const fetchPage = vi.fn((cursor: string | undefined, signal: AbortSignal) => {
      signals.push(signal)
      return cursor === undefined ? Promise.resolve(page(['a'], 'c2')) : new Promise<Page>(() => undefined)
    })
    const { result, unmount } = renderHook(() => useHoursPages('k', fetchPage))
    await act(async () => undefined)
    act(() => result.current.loadMore())

    unmount()

    expect(signals[1]!.aborted).toBe(true)
  })
})
