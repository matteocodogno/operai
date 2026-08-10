/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/reviewApi.ts (T18, specs/007-refund-service/
 * tasks.md). Strategy mirrors requestsApi.test.ts: `shell/session`'s
 * `apiFetch` is mocked at the module level.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import { approve, listQueue, reject, setApprovedTotal } from './reviewApi'

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

describe('listQueue', () => {
  it('GETs /review/requests', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, []))
    await listQueue()
    expect(String(vi.mocked(apiFetch).mock.calls[0]?.[0])).toBe(`${REFUND_API_URL}/review/requests`)
  })

  it('throws ApiError(403) when request:review is entirely absent (AC-5.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(403, { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'No review grant.' }),
    )
    await expect(listQueue()).rejects.toMatchObject({ status: 403 })
  })
})

describe('setApprovedTotal', () => {
  it('PUTs the approved-total sub-route with { approvedTotalCents }', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { id: 'l1', approvedTotalCents: 800 }))
    await setApprovedTotal('r1', 'l1', 800)
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/review/requests/r1/lines/l1/approved-total`)
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ approvedTotalCents: 800 })
  })

  it('throws ApiError(409) once decided (AC-7.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(409, { type: 'about:blank', title: 'Conflict', status: 409 }),
    )
    await expect(setApprovedTotal('r1', 'l1', 800)).rejects.toMatchObject({ status: 409 })
  })
})

describe('approve / reject', () => {
  it('approve POSTs /review/requests/:id/approve with no body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { id: 'r1', status: 'approved' }))
    const result = await approve('r1')
    expect(result).toMatchObject({ status: 'approved' })
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/review/requests/r1/approve`)
    expect(init?.method).toBe('POST')
  })

  it('reject POSTs /review/requests/:id/reject with { motivation }', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { id: 'r1', status: 'rejected' }))
    await reject('r1', 'Missing receipt.')
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/review/requests/r1/reject`)
    expect(JSON.parse(init?.body as string)).toEqual({ motivation: 'Missing receipt.' })
  })

  it('reject throws ApiError(422) on an empty motivation (defense-in-depth, AC-7.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(422, {
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'motivation is required',
      }),
    )
    await expect(reject('r1', '')).rejects.toMatchObject({ status: 422 })
  })
})
