/**
 * @vitest-environment jsdom
 *
 * useHoursQuery — one read keyed by what it asks (specs/029-time-tracking T24, design F4 step 1:
 * "stale answers are discarded"). The three reads of a filter change (the entries, the chosen totals,
 * the day totals) and the lists each use it, so the rules are proven here once: a key change shows
 * loading at once, never the previous key's data; an answer for an older key is discarded however late
 * it arrives; a request that is no longer wanted is aborted; and `reload` asks again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { deferred } from '../test-support/fakeApi'
import { useHoursQuery } from './useHoursQuery'

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
