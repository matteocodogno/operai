import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getInventoryApiBaseUrl: vi.fn(() => 'http://inventory-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import { ApiError } from './api'
import { toInventoryError } from './types'

const BASE = 'http://inventory-api.test'

const ok = (status: number, body?: unknown): Response =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const problem = (status: number, body: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ title: 'Problem', status, ...body }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })

/** The method, URL and parsed JSON body of the single request a call made. */
const lastRequest = () => {
  const [url, init] = vi.mocked(apiFetch).mock.calls.at(-1) as [string, RequestInit | undefined]
  return {
    url,
    method: init?.method ?? 'GET',
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    rawBody: init?.body,
  }
}

const rejection = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected the call to reject')
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})

import { getScope } from './scopeApi'

describe('scopeApi', () => {
  it('GET /scope returns the entities each capability covers', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { asset: ['welld_ch'], ledger: [] }))

    await expect(getScope()).resolves.toEqual({ asset: ['welld_ch'], ledger: [] })

    expect(lastRequest()).toMatchObject({ url: `${BASE}/scope`, method: 'GET' })
  })

  it('forwards an AbortSignal', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { asset: [], ledger: [] }))
    const signal = new AbortController().signal

    await getScope({ signal })

    expect(vi.mocked(apiFetch).mock.calls[0][1]).toEqual({ signal })
  })

  it('503 (auth unavailable, no code) rejects with status 503 and maps to no known inventory error', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(503))

    const error = await rejection(getScope())

    expect(error.status).toBe(503)
    expect(toInventoryError(error)).toBeNull()
  })
})
