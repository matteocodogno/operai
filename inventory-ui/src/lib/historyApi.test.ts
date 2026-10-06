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

import { getAssetHistory } from './historyApi'

describe('historyApi', () => {
  it('GET /assets/{id}/history returns typed events', async () => {
    const events = [
      {
        id: 'e1',
        action: 'assignment_confirmed',
        actor: { id: 'system:import', name: null, status: 'system' },
        at: '2026-10-01T10:00:00.000Z',
        changes: [{ field: 'holder', from: null, to: { id: 'u1', name: 'Ada', status: 'active' } }],
      },
    ]
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { events }))

    await expect(getAssetHistory('a-1')).resolves.toEqual({ events })

    expect(lastRequest()).toMatchObject({ url: `${BASE}/assets/a-1/history`, method: 'GET' })
  })

  it('404 (unknown or out of scope) is a plain ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(404))

    const error = await rejection(getAssetHistory('nope'))

    expect(error.status).toBe(404)
    expect(toInventoryError(error)).toBeNull()
  })
})
