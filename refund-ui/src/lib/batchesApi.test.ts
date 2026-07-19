/**
 * @vitest-environment jsdom
 *
 * Unit tests for src/lib/batchesApi.ts (T9, specs/008-refund-monthly-
 * processing/tasks.md). Strategy mirrors reviewApi.test.ts/requestsApi.test.ts:
 * `shell/session`'s `apiFetch` is mocked at the module level — no live
 * refund-api is required (its batch routes, T1-T8, are not implemented yet).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import { compile, discard, get, getPdfUrl, list, listCandidates, markPaid, sendEmail } from './batchesApi'

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

describe('listCandidates', () => {
  it('GETs /batches/candidates with no query when no cutoff is given', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { cutoff: '2026-07-19T00:00:00Z', requestCount: 0, subtotals: [], employees: [] }))
    await listCandidates()
    expect(String(vi.mocked(apiFetch).mock.calls[0]?.[0])).toBe(`${REFUND_API_URL}/batches/candidates`)
  })

  it('GETs /batches/candidates?cutoff=<ISO> when a cutoff is given', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { cutoff: '2026-07-19T00:00:00Z', requestCount: 0, subtotals: [], employees: [] }))
    await listCandidates('2026-07-19T00:00:00Z')
    expect(String(vi.mocked(apiFetch).mock.calls[0]?.[0])).toBe(
      `${REFUND_API_URL}/batches/candidates?cutoff=${encodeURIComponent('2026-07-19T00:00:00Z')}`,
    )
  })

  it('throws ApiError(403) when request:review is entirely absent (AC-1.8)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(403, { type: 'about:blank', title: 'Forbidden', status: 403 }),
    )
    await expect(listCandidates()).rejects.toMatchObject({ status: 403 })
  })
})

describe('compile', () => {
  it('POSTs /batches with { cutoff } when given', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(201, { id: 'b1', status: 'compiled' }))
    await compile('2026-07-19T00:00:00Z')
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/batches`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ cutoff: '2026-07-19T00:00:00Z' })
  })

  it('throws ApiError(422) on an empty candidate set (AC-1.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(422, { type: 'about:blank', title: 'Unprocessable Entity', status: 422 }),
    )
    await expect(compile()).rejects.toMatchObject({ status: 422 })
  })
})

describe('list', () => {
  it('GETs /batches (history, every status, AC-8.2)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, []))
    await list()
    expect(String(vi.mocked(apiFetch).mock.calls[0]?.[0])).toBe(`${REFUND_API_URL}/batches`)
  })
})

describe('get', () => {
  it('GETs /batches/:id', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { id: 'b1', status: 'compiled' }))
    await get('b1')
    expect(String(vi.mocked(apiFetch).mock.calls[0]?.[0])).toBe(`${REFUND_API_URL}/batches/b1`)
  })

  it('throws ApiError(404) for a nonexistent batch', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(404, { type: 'about:blank', title: 'Not Found', status: 404 }))
    await expect(get('missing')).rejects.toMatchObject({ status: 404 })
  })
})

describe('getPdfUrl', () => {
  it('GETs /batches/:id/pdf-url', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { url: 'https://eu-bucket/x', expiresAt: '2026-07-19T00:01:00Z' }))
    await getPdfUrl('b1')
    expect(String(vi.mocked(apiFetch).mock.calls[0]?.[0])).toBe(`${REFUND_API_URL}/batches/b1/pdf-url`)
  })
})

describe('sendEmail', () => {
  it('POSTs /batches/:id/email with no body, available regardless of batch status (AC-3.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { emailStatus: 'sent' }))
    await sendEmail('b1')
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/batches/b1/email`)
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeUndefined()
  })
})

describe('markPaid', () => {
  it('POSTs /batches/:id/mark-paid with no body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { id: 'b1', status: 'paid' }))
    const result = await markPaid('b1')
    expect(result).toMatchObject({ status: 'paid' })
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/batches/b1/mark-paid`)
    expect(init?.method).toBe('POST')
  })

  it('throws ApiError(409) once already resolved (AC-4.3)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(409, { type: 'about:blank', title: 'Conflict', status: 409 }))
    await expect(markPaid('b1')).rejects.toMatchObject({ status: 409 })
  })

  it('throws ApiError(403) without request:approve specifically (AC-4.4)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(403, { type: 'about:blank', title: 'Forbidden', status: 403 }))
    await expect(markPaid('b1')).rejects.toMatchObject({ status: 403 })
  })
})

describe('discard', () => {
  it('POSTs /batches/:id/discard with no body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, { id: 'b1', status: 'discarded' }))
    const result = await discard('b1')
    expect(result).toMatchObject({ status: 'discarded' })
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]
    expect(String(url)).toBe(`${REFUND_API_URL}/batches/b1/discard`)
    expect(init?.method).toBe('POST')
  })

  it('throws ApiError(409) once already resolved (AC-6.2)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(409, { type: 'about:blank', title: 'Conflict', status: 409 }))
    await expect(discard('b1')).rejects.toMatchObject({ status: 409 })
  })
})
