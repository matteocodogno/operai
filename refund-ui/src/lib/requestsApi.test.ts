/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/requestsApi.ts (T16, specs/007-refund-service/
 * tasks.md) — the typed employee-facing operations built on refundApi.ts's
 * generic plumbing. Strategy mirrors refundApi.test.ts: `shell/session`'s
 * `apiFetch` is mocked at the module level.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import { ApiError } from './refundApi'
import * as requestsApi from './requestsApi'
import { SubmitValidationApiError } from './requestsApi'

const REFUND_API_URL = 'http://refund-api.test'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.stubEnv('VITE_REFUND_API_URL', REFUND_API_URL)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('request-level operations', () => {
  it('list() GETs /requests', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, []))
    await requestsApi.list()
    expect(String(vi.mocked(apiFetch).mock.calls[0]?.[0])).toBe(`${REFUND_API_URL}/requests`)
  })

  it('create() POSTs /requests with no body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(201, { id: 'r1' }))
    await requestsApi.create()
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests`)
    expect(init?.method).toBe('POST')
  })

  it('get(id) GETs /requests/:id and throws ApiError(404) when not owned/in-scope', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(404, { type: 'about:blank', title: 'Not Found', status: 404 }),
    )
    await expect(requestsApi.get('r1')).rejects.toMatchObject({ status: 404 })
  })

  it('remove(id) DELETEs /requests/:id', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 204 }))
    await requestsApi.remove('r1')
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1`)
    expect(init?.method).toBe('DELETE')
  })
})

describe('line-level operations', () => {
  const payload = {
    date: '2026-07-01',
    type: 'stationery' as const,
    motivo: 'Pens',
    requestedAmountCents: 1000,
    entity: 'welld_it' as const,
  }

  it('addLine POSTs /requests/:id/lines', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(201, { id: 'l1' }))
    await requestsApi.addLine('r1', payload)
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1/lines`)
    expect(init?.method).toBe('POST')
  })

  it('updateLine PUTs /requests/:id/lines/:lineId', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { id: 'l1' }))
    await requestsApi.updateLine('r1', 'l1', payload)
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1/lines/l1`)
    expect(init?.method).toBe('PUT')
  })

  it('removeLine DELETEs /requests/:id/lines/:lineId, 409 when not draft', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(409, { type: 'about:blank', title: 'Conflict', status: 409, detail: 'Only draft requests can be edited' }),
    )
    await expect(requestsApi.removeLine('r1', 'l1')).rejects.toMatchObject({ status: 409 })
  })
})

describe('submit', () => {
  it('POSTs /requests/:id/submit and returns the updated request on 200', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { id: 'r1', status: 'submitted' }))
    const result = await requestsApi.submit('r1')
    expect(result).toMatchObject({ status: 'submitted' })
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/requests/r1/submit`)
    expect(init?.method).toBe('POST')
  })

  it('throws SubmitValidationApiError with offendingLineIds on 422', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(422, {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Some lines are incomplete',
        offendingLineIds: ['l1', 'l2'],
      }),
    )

    const error = await requestsApi.submit('r1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SubmitValidationApiError)
    expect((error as SubmitValidationApiError).offendingLineIds).toEqual(['l1', 'l2'])
    expect((error as SubmitValidationApiError).status).toBe(422)
  })

  it('throws the ordinary ApiError (not SubmitValidationApiError) on other non-2xx statuses', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(404, { type: 'about:blank', title: 'Not Found', status: 404 }),
    )
    const error = await requestsApi.submit('r1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).not.toBeInstanceOf(SubmitValidationApiError)
  })
})

describe('withdraw', () => {
  it('POSTs /requests/:id/withdraw, 409 when status is not submitted', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(409, { type: 'about:blank', title: 'Conflict', status: 409 }),
    )
    await expect(requestsApi.withdraw('r1')).rejects.toMatchObject({ status: 409 })
  })

  it('returns the updated (draft) request on 200', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { id: 'r1', status: 'draft' }))
    const result = await requestsApi.withdraw('r1')
    expect(result).toMatchObject({ status: 'draft' })
  })
})
