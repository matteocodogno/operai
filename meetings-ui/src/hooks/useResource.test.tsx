/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useResource } from './useResource'

describe('useResource', () => {
  it('starts loading, then reports the data', async () => {
    const fetcher = vi.fn(async () => 'a')
    const { result } = renderHook(() => useResource(fetcher))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.data).toBe('a')
    expect(result.current.error).toBeNull()
  })

  it('reports the thrown value as the error, with no data', async () => {
    const failure = new Error('nope')
    // A fetcher must be stable (see useResource): an inline arrow would be a new load on every render.
    const fetcher = async () => Promise.reject(failure)
    const { result } = renderHook(() => useResource(fetcher))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe(failure)
    expect(result.current.data).toBeNull()
  })

  it('retry loads again and shows loading in between', async () => {
    let calls = 0
    const fetcher = vi.fn(async () => ++calls)
    const { result } = renderHook(() => useResource(fetcher))
    await waitFor(() => expect(result.current.data).toBe(1))
    act(() => result.current.retry())
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.data).toBe(2))
  })

  it('replace swaps in a value a write returned, without calling the fetcher again', async () => {
    const fetcher = vi.fn(async () => 'old')
    const { result } = renderHook(() => useResource(fetcher))
    await waitFor(() => expect(result.current.data).toBe('old'))
    act(() => result.current.replace('new'))
    expect(result.current.data).toBe('new')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('a slow answer for a superseded fetcher never replaces the newer one', async () => {
    let releaseFirst: (value: string) => void = () => undefined
    const first = vi.fn(() => new Promise<string>((resolve) => (releaseFirst = resolve)))
    const second = vi.fn(async () => 'second')
    const { result, rerender } = renderHook(({ fetcher }) => useResource(fetcher), { initialProps: { fetcher: first } })
    rerender({ fetcher: second })
    await waitFor(() => expect(result.current.data).toBe('second'))
    await act(async () => releaseFirst('first'))
    expect(result.current.data).toBe('second')
  })

  it('aborts the request on unmount', async () => {
    let signal: AbortSignal | undefined
    const fetcher = (s: AbortSignal) => {
      signal = s
      return new Promise<string>(() => undefined)
    }
    const { unmount } = renderHook(() => useResource(fetcher))
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})
