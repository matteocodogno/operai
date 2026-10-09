/**
 * @vitest-environment jsdom
 *
 * useScope (T28, specs/015-hardware-inventory; plan.md § API contracts
 * `GET /scope`; design.md Resolutions G1/G11): loads the entities each
 * capability covers and derives "empty" — both lists empty — which the tool
 * layout turns into the "no entity in your scope" state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { Scope } from '../lib/types'

const { getScope } = vi.hoisted(() => ({ getScope: vi.fn() }))
vi.mock('../lib/scopeApi', () => ({ getScope }))

import { useScope } from './useScope'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  getScope.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('useScope', () => {
  it('is loading until GET /scope answers, then ready with the scope', async () => {
    const pending = deferred<Scope>()
    getScope.mockReturnValue(pending.promise)

    const { result } = renderHook(() => useScope())
    expect(result.current.status).toBe('loading')
    expect(result.current.scope).toBeNull()

    await act(async () => pending.resolve({ asset: ['welld_ch'], ledger: ['welld_ch', 'welld_it'] }))

    expect(result.current.status).toBe('ready')
    expect(result.current.scope).toEqual({ asset: ['welld_ch'], ledger: ['welld_ch', 'welld_it'] })
    expect(result.current.isEmpty).toBe(false)
  })

  it('is not empty when only one capability covers an entity', async () => {
    getScope.mockResolvedValue({ asset: [], ledger: ['welld_it'] })

    const { result } = renderHook(() => useScope())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.isEmpty).toBe(false)
  })

  it('is empty when both lists are empty — a user with tool access but no entity', async () => {
    getScope.mockResolvedValue({ asset: [], ledger: [] })

    const { result } = renderHook(() => useScope())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.isEmpty).toBe(true)
  })

  it('is never "empty" before the scope has loaded', () => {
    getScope.mockReturnValue(new Promise(() => undefined))

    const { result } = renderHook(() => useScope())

    expect(result.current.isEmpty).toBe(false)
  })

  it('reports an ApiError (503 auth unavailable) as an error, keeping the error for the banner', async () => {
    const error = new ApiError({ status: 503, title: 'Service Unavailable' })
    getScope.mockRejectedValue(error)

    const { result } = renderHook(() => useScope())
    await waitFor(() => expect(result.current.status).toBe('error'))

    expect(result.current.error).toBe(error)
    expect(result.current.scope).toBeNull()
    expect(result.current.isEmpty).toBe(false)
  })

  it('reports a network failure as an error too', async () => {
    getScope.mockRejectedValue(new TypeError('Failed to fetch'))

    const { result } = renderHook(() => useScope())
    await waitFor(() => expect(result.current.status).toBe('error'))

    expect(result.current.error).toBeInstanceOf(TypeError)
  })

  it('retry() goes back to loading and fetches again', async () => {
    getScope.mockRejectedValueOnce(new ApiError({ status: 503, title: 'x' }))
    getScope.mockResolvedValueOnce({ asset: ['welld_ch'], ledger: [] })

    const { result } = renderHook(() => useScope())
    await waitFor(() => expect(result.current.status).toBe('error'))

    act(() => result.current.retry())
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(getScope).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
    expect(result.current.scope).toEqual({ asset: ['welld_ch'], ledger: [] })
  })

  it('does not fetch while disabled (a user with neither capability), and is idle', () => {
    const { result } = renderHook(() => useScope(false))

    expect(getScope).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
    expect(result.current.isEmpty).toBe(false)
  })

  it('fetches once it becomes enabled (capabilities arrive after the first render)', async () => {
    getScope.mockResolvedValue({ asset: ['welld_ch'], ledger: [] })

    const { result, rerender } = renderHook(({ enabled }) => useScope(enabled), { initialProps: { enabled: false } })
    expect(getScope).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(getScope).toHaveBeenCalledTimes(1)
  })

  it('aborts the request on unmount, and ignores an answer that arrives after it', async () => {
    const pending = deferred<Scope>()
    getScope.mockReturnValue(pending.promise)

    const { unmount } = renderHook(() => useScope())
    const init = getScope.mock.calls[0][0] as RequestInit
    expect(init.signal?.aborted).toBe(false)

    unmount()

    expect(init.signal?.aborted).toBe(true)
    await act(async () => pending.reject(new DOMException('Aborted', 'AbortError')))
  })

  it('does not let a stale answer overwrite a retry that superseded it', async () => {
    const first = deferred<Scope>()
    const second = deferred<Scope>()
    getScope.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const { result } = renderHook(() => useScope())
    act(() => result.current.retry())

    await act(async () => second.resolve({ asset: ['welld_it'], ledger: [] }))
    await act(async () => first.resolve({ asset: ['welld_ch'], ledger: [] }))

    expect(result.current.scope).toEqual({ asset: ['welld_it'], ledger: [] })
  })
})
