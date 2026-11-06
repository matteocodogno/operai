/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePolling } from './usePolling'

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})

const OPTIONS = { baseMs: 1000, factor: 2, maxMs: 4000 }

describe('usePolling', () => {
  it('loads immediately, then reports the data', async () => {
    const fetcher = vi.fn(async () => 'a')
    const { result } = renderHook(() => usePolling(fetcher, { ...OPTIONS, until: () => true }))
    expect(result.current.status).toBe('loading')
    await flush()
    expect(result.current.status).toBe('ready')
    expect(result.current.data).toBe('a')
  })

  it('polls again after the base wait, then with a growing wait up to the cap', async () => {
    const fetcher = vi.fn(async () => 'processing')
    renderHook(() => usePolling(fetcher, { ...OPTIONS, until: () => false }))
    await flush() // t=0   → call 1
    expect(fetcher).toHaveBeenCalledTimes(1)
    await flush(999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await flush(1) // t=1000 → call 2
    expect(fetcher).toHaveBeenCalledTimes(2)
    await flush(2000) // t=3000 → call 3 (waited 2000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    await flush(4000) // t=7000 → call 4 (waited 4000, the cap)
    expect(fetcher).toHaveBeenCalledTimes(4)
    await flush(4000) // t=11000 → call 5 (still the cap)
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('stops for good once `until` is satisfied', async () => {
    let status = 'processing'
    const fetcher = vi.fn(async () => status)
    const { result } = renderHook(() => usePolling(fetcher, { ...OPTIONS, until: (value) => value === 'ready' }))
    await flush()
    status = 'ready'
    await flush(1000)
    expect(result.current.data).toBe('ready')
    const calls = fetcher.mock.calls.length
    await flush(60_000)
    expect(fetcher).toHaveBeenCalledTimes(calls)
  })

  it('keeps the last good data when a poll fails, reports the error, and recovers on the next poll', async () => {
    let fail = false
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error('offline')
      return 'good'
    })
    const { result } = renderHook(() => usePolling(fetcher, { ...OPTIONS, until: () => false }))
    await flush()
    fail = true
    await flush(1000)
    expect(result.current.status).toBe('error')
    expect(result.current.data).toBe('good')
    expect((result.current.error as Error).message).toBe('offline')
    fail = false
    await flush(2000)
    expect(result.current.status).toBe('ready')
    expect(result.current.error).toBeNull()
  })

  it('a first failure with no data is an error with data null (the page shows Retry)', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('boom')
    })
    const { result } = renderHook(() => usePolling(fetcher, { ...OPTIONS, until: () => false }))
    await flush()
    expect(result.current.status).toBe('error')
    expect(result.current.data).toBeNull()
  })

  it('retry() fetches at once and restarts the wait from the base', async () => {
    const fetcher = vi.fn(async () => 'processing')
    const { result } = renderHook(() => usePolling(fetcher, { ...OPTIONS, until: () => false }))
    await flush()
    await flush(1000)
    await flush(2000) // waits are now at 4000 next
    expect(fetcher).toHaveBeenCalledTimes(3)
    await act(async () => {
      result.current.retry()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetcher).toHaveBeenCalledTimes(4)
    await flush(1000) // back to the base wait
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('skips the fetch while the tab is hidden and resumes when it is shown', async () => {
    const fetcher = vi.fn(async () => 'processing')
    renderHook(() => usePolling(fetcher, { ...OPTIONS, until: () => false }))
    await flush()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await flush(10_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    await flush(4000)
    expect(fetcher.mock.calls.length).toBeGreaterThan(1)
  })

  it('does not poll when disabled', async () => {
    const fetcher = vi.fn(async () => 'a')
    renderHook(() => usePolling(fetcher, { ...OPTIONS, enabled: false }))
    await flush(10_000)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('aborts the request in flight and stops on unmount', async () => {
    let signal: AbortSignal | undefined
    const fetcher = vi.fn(async (s: AbortSignal) => {
      signal = s
      return 'processing'
    })
    const { unmount } = renderHook(() => usePolling(fetcher, { ...OPTIONS, until: () => false }))
    await flush()
    unmount()
    expect(signal?.aborted).toBe(true)
    await flush(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('a new fetcher (another meeting) never shows the old data', async () => {
    const first = vi.fn(async () => 'meeting-1')
    const second = vi.fn(async () => 'meeting-2')
    const { result, rerender } = renderHook(({ fetcher }) => usePolling(fetcher, { ...OPTIONS, until: () => true }), {
      initialProps: { fetcher: first },
    })
    await flush()
    expect(result.current.data).toBe('meeting-1')
    rerender({ fetcher: second })
    expect(result.current.data).toBeNull()
    expect(result.current.status).toBe('loading')
    await flush()
    expect(result.current.data).toBe('meeting-2')
  })

  it('an answer that arrives after unmount is ignored', async () => {
    let resolve: (value: string) => void = () => undefined
    const fetcher = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    const { result, unmount } = renderHook(() => usePolling(fetcher, { ...OPTIONS, until: () => true }))
    await flush()
    unmount()
    await act(async () => resolve('late'))
    expect(result.current.data).toBeNull()
  })
})
