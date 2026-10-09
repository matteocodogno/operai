import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getInventoryApiBaseUrl: vi.fn(() => 'http://inventory-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import { ApiError } from './api'

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

import { listDirectory } from './directoryApi'

describe('directoryApi — calls auth, not inventory-api (plan R4)', () => {
  it('GET /authz/users/directory against the auth base URL', async () => {
    const users = [{ id: 'u1', name: 'Ada', email: 'ada@welld.ch', entity: 'welld_ch' }]
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { users }))

    await expect(listDirectory()).resolves.toEqual({ users })

    expect(lastRequest()).toMatchObject({ url: 'http://auth.test/authz/users/directory', method: 'GET' })
  })

  it('429 exposes Retry-After as retryAfterSeconds for the "try again in {n} seconds" copy', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ title: 'Too many', status: 429 }), {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    )

    const error = await rejection(listDirectory())

    expect(error.status).toBe(429)
    expect(error.retryAfterSeconds).toBe(30)
  })

  it('403 (caller lacks asset:manage) is a plain ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(403))

    expect((await rejection(listDirectory())).status).toBe(403)
  })
})
