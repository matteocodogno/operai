/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/refundApi.ts — the thin, generic refund-api call
 * plumbing (T14, specs/007-refund-service/tasks.md).
 *
 * Strategy (mirrors admin-ui/src/lib/adminApi.test.ts / estimai-ui/src/lib/
 * estimatesApi.test.ts): `shell/session`'s `apiFetch` is mocked at the module
 * level so tests control the raw Response objects and inspect exactly what
 * was sent — base URL sourced from `VITE_REFUND_API_URL` via `vi.stubEnv`,
 * never hardcoded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import { ApiError, deleteJson, getJson, refundApiBase, sendJson } from './refundApi'

const REFUND_API_URL = 'http://refund-api.test'

const makeResponse = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

beforeEach(() => {
  vi.stubEnv('VITE_REFUND_API_URL', REFUND_API_URL)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('refundApiBase', () => {
  it('reads VITE_REFUND_API_URL — never hardcoded', () => {
    expect(refundApiBase()).toBe(REFUND_API_URL)
  })
})

describe('getJson', () => {
  it('GETs the given path against refundApiBase() and returns the parsed body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(200, { id: 'r1' }))

    const result = await getJson<{ id: string }>('/requests/r1')

    expect(result).toEqual({ id: 'r1' })
    const [url] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1`)
  })

  it('throws ApiError with the RFC 7807 fields on a non-2xx response', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(404, {
        type: 'https://httpstatuses.com/404',
        title: 'Not Found',
        status: 404,
        detail: 'No such request',
        instance: '/requests/r1',
      }),
    )

    await expect(getJson('/requests/r1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      title: 'Not Found',
      detail: 'No such request',
    })
  })

  it('synthesizes a Problem from the HTTP status when the error body is not valid JSON', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response('not json', { status: 503, statusText: 'Service Unavailable' }),
    )

    await expect(getJson('/review/requests')).rejects.toMatchObject({
      status: 503,
      title: 'Service Unavailable',
    })
  })
})

describe('sendJson', () => {
  it('sends a JSON body with the given method and Content-Type, and returns the parsed response', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(makeResponse(201, { id: 'l1' }))

    const result = await sendJson<{ id: string }>('/requests/r1/lines', 'POST', {
      date: '2026-07-01',
      type: 'travel_km',
      motivo: 'Client visit',
      requestedAmountCents: 4550,
      entity: 'welld_it',
      km: 120,
    })

    expect(result).toEqual({ id: 'l1' })
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1/lines`)
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toMatchObject({ requestedAmountCents: 4550 })
  })

  it('throws ApiError on a non-2xx response (e.g. 422 line validation)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(422, {
        type: 'https://httpstatuses.com/422',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'km is required for travel_km',
      }),
    )

    await expect(sendJson('/requests/r1/lines', 'POST', {})).rejects.toBeInstanceOf(ApiError)
  })
})

describe('deleteJson', () => {
  it('sends a DELETE with no body and resolves on 204', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(deleteJson('/requests/r1')).resolves.toBeUndefined()
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1`)
    expect(init?.method).toBe('DELETE')
  })

  it('throws ApiError on a non-2xx response (e.g. 409 not-a-draft)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeResponse(409, {
        type: 'https://httpstatuses.com/409',
        title: 'Conflict',
        status: 409,
        detail: 'Only draft requests can be deleted',
      }),
    )

    await expect(deleteJson('/requests/r1')).rejects.toMatchObject({ status: 409 })
  })
})
