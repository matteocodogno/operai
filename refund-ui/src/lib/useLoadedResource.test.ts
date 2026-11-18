/**
 * @vitest-environment jsdom
 *
 * useLoadedResource (T21, specs/20261118-refund-accounting-export): loading / loaded / error / forbidden, reload keeping
 * the data on screen, replace, a disabled load, and stale answers being dropped.
 */

import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { ApiError } from './refundApi'
import { useLoadedResource } from './useLoadedResource'

const problem = (status: number) => new ApiError({ type: 't', title: 'x', status })

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useLoadedResource', () => {
  it('starts loading and then holds the loaded data', async () => {
    const { result } = renderHook(() => useLoadedResource(() => Promise.resolve({ n: 1 })))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('loaded'))
    expect(result.current.status === 'loaded' && result.current.data).toEqual({ n: 1 })
  })

  it('is forbidden on a 403 and error (with the error) on anything else', async () => {
    const forbidden = renderHook(() => useLoadedResource(() => Promise.reject(problem(403))))
    await waitFor(() => expect(forbidden.result.current.status).toBe('forbidden'))

    const failure = problem(500)
    const failed = renderHook(() => useLoadedResource(() => Promise.reject(failure)))
    await waitFor(() => expect(failed.result.current.status).toBe('error'))
    expect(failed.result.current.status === 'error' && failed.result.current.error).toBe(failure)

    const network = renderHook(() => useLoadedResource(() => Promise.reject(new TypeError('offline'))))
    await waitFor(() => expect(network.result.current.status).toBe('error'))
  })

  it('does not call the loader while disabled and reads as forbidden (the card is left out)', async () => {
    const loader = vi.fn(() => Promise.resolve(1))
    const { result, rerender } = renderHook(({ enabled }) => useLoadedResource(loader, enabled), {
      initialProps: { enabled: false },
    })
    expect(result.current.status).toBe('forbidden')
    expect(loader).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(result.current.status).toBe('loaded'))
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('does not reload when the loader is a new inline function on every render', async () => {
    const calls = vi.fn()
    const { result, rerender } = renderHook(() =>
      useLoadedResource(() => {
        calls()
        return Promise.resolve('x')
      }),
    )
    await waitFor(() => expect(result.current.status).toBe('loaded'))
    rerender()
    rerender()
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('reload keeps the old data visible until the new answer arrives, then shows it', async () => {
    const second = deferred<string>()
    const loader = vi.fn().mockResolvedValueOnce('one').mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useLoadedResource<string>(loader))
    await waitFor(() => expect(result.current.status).toBe('loaded'))

    act(() => result.current.reload())
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
    expect(result.current.status === 'loaded' && result.current.data).toBe('one')

    await act(async () => second.resolve('two'))
    expect(result.current.status === 'loaded' && result.current.data).toBe('two')
  })

  it('reload after an error goes back through loading', async () => {
    const retry = deferred<string>()
    const loader = vi.fn().mockRejectedValueOnce(problem(500)).mockReturnValueOnce(retry.promise)
    const { result } = renderHook(() => useLoadedResource<string>(loader))
    await waitFor(() => expect(result.current.status).toBe('error'))

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.status).toBe('loading'))
    await act(async () => retry.resolve('ok'))
    expect(result.current.status).toBe('loaded')
  })

  it('a reload that fails replaces the data with the error', async () => {
    const loader = vi.fn().mockResolvedValueOnce('one').mockRejectedValueOnce(problem(500))
    const { result } = renderHook(() => useLoadedResource<string>(loader))
    await waitFor(() => expect(result.current.status).toBe('loaded'))
    act(() => result.current.reload())
    await waitFor(() => expect(result.current.status).toBe('error'))
  })

  it('replace shows the given data at once, without another request', async () => {
    const loader = vi.fn(() => Promise.resolve('one'))
    const { result } = renderHook(() => useLoadedResource<string>(loader))
    await waitFor(() => expect(result.current.status).toBe('loaded'))
    act(() => result.current.replace('fresh'))
    expect(result.current.status === 'loaded' && result.current.data).toBe('fresh')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('drops a stale answer that arrives after a newer reload', async () => {
    const slow = deferred<string>()
    const fast = deferred<string>()
    const loader = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    const { result } = renderHook(() => useLoadedResource<string>(loader))
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1))

    act(() => result.current.reload())
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2))
    await act(async () => fast.resolve('new'))
    await act(async () => slow.resolve('old'))
    expect(result.current.status === 'loaded' && result.current.data).toBe('new')
  })

  it('sets no state after unmount', async () => {
    const late = deferred<string>()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = renderHook(() => useLoadedResource<string>(() => late.promise))
    unmount()
    await act(async () => late.resolve('x'))
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
