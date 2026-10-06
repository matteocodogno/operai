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

import { confirmAssignment, declineAssignment, getMyDevices } from './meApi'

const device = {
  assetId: 'a-1',
  description: 'MacBook Pro',
  category: 'laptop',
  serialNumber: 'SN1',
  assignedAt: '2026-10-01',
}

describe('meApi — JWT-only /me/* routes', () => {
  it('GET /me/devices returns the held and pending lists', async () => {
    const body = { devices: [device], pending: [{ ...device, assignmentId: 'as-1' }] }
    vi.mocked(apiFetch).mockResolvedValue(ok(200, body))

    await expect(getMyDevices()).resolves.toEqual(body)

    expect(lastRequest()).toMatchObject({ url: `${BASE}/me/devices`, method: 'GET' })
  })

  it('POST /me/assignments/{id}/confirm has no body and returns the device', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { device }))

    await expect(confirmAssignment('as-1')).resolves.toEqual({ device })

    expect(lastRequest()).toMatchObject({
      url: `${BASE}/me/assignments/as-1/confirm`,
      method: 'POST',
      rawBody: undefined,
    })
  })

  it('POST /me/assignments/{id}/decline resolves undefined on 204', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(204))

    await expect(declineAssignment('as-1')).resolves.toBeUndefined()

    expect(lastRequest()).toMatchObject({ url: `${BASE}/me/assignments/as-1/decline`, method: 'POST' })
  })

  it('encodes the assignment id into the path', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(204))

    await declineAssignment('a/b c')

    expect(lastRequest().url).toBe(`${BASE}/me/assignments/a%2Fb%20c/decline`)
  })

  it.each([
    ['confirm', confirmAssignment],
    ['decline', declineAssignment],
  ])('%s: 409 assignment_not_pending maps to the known error', async (_name, call) => {
    vi.mocked(apiFetch).mockResolvedValue(problem(409, { code: 'assignment_not_pending' }))

    const error = await rejection(call('as-1'))

    expect(toInventoryError(error)).toEqual({
      code: 'assignment_not_pending',
      status: 409,
      detail: undefined,
      extras: {},
    })
  })

  it.each([
    ['confirm', confirmAssignment],
    ['decline', declineAssignment],
  ])('%s: 404 (not addressed to the caller or unknown) is a plain ApiError with no code', async (_name, call) => {
    vi.mocked(apiFetch).mockResolvedValue(problem(404))

    const error = await rejection(call('as-1'))

    expect(error.status).toBe(404)
    expect(toInventoryError(error)).toBeNull()
  })
})
