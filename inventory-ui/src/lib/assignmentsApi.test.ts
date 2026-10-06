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
import { cancelAssignment, createAssignment } from './assignmentsApi'

const asset = { id: 'a-1', status: 'in_stock' }

describe('assignmentsApi — manager side', () => {
  it('POST /assets/{id}/assignments sends {assigneeUserId} and returns the asset', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(201, asset))

    await expect(createAssignment('a-1', 'u-7')).resolves.toEqual(asset)

    expect(lastRequest()).toMatchObject({
      url: `${BASE}/assets/a-1/assignments`,
      method: 'POST',
      body: { assigneeUserId: 'u-7' },
    })
  })

  it.each([
    ['invalid_transition', 409, { from: 'assigned' }, { from: 'assigned' }],
    ['assignment_pending', 409, { assignmentId: 'as-3' }, { assignmentId: 'as-3' }],
    ['unknown_user', 422, {}, {}],
    ['asset_disposed', 409, {}, {}],
  ])('create: %s maps to the known error', async (code, status, wire, extras) => {
    vi.mocked(apiFetch).mockResolvedValue(problem(status, { code, ...wire }))

    expect(toInventoryError(await rejection(createAssignment('a-1', 'u-7')))).toMatchObject({ code, status, extras })
  })

  it('POST /assignments/{id}/cancel has no body and returns the asset', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, asset))

    await expect(cancelAssignment('as-3')).resolves.toEqual(asset)

    expect(lastRequest()).toMatchObject({ url: `${BASE}/assignments/as-3/cancel`, method: 'POST', rawBody: undefined })
  })

  it('cancel: 409 assignment_not_pending maps to the known error; 404 is a plain ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(409, { code: 'assignment_not_pending' }))
    vi.mocked(apiFetch).mockResolvedValueOnce(problem(404))

    expect(toInventoryError(await rejection(cancelAssignment('as-3')))).toMatchObject({
      code: 'assignment_not_pending',
      status: 409,
    })
    expect((await rejection(cancelAssignment('as-3'))).status).toBe(404)
  })
})
