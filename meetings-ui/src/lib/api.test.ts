import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import { ApiError, getJson, ifMatch, isStaleWrite, query, requestJson, sendJson } from './api'

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json', ...headers } })

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
})

const catchError = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError)
    return error as ApiError
  }
  throw new Error('expected the call to reject')
}

const lastInit = (): RequestInit => vi.mocked(apiFetch).mock.calls.at(-1)![1] as RequestInit
const lastHeaders = (): Record<string, string> => lastInit().headers as Record<string, string>

describe('requests', () => {
  it('GET goes through shell/session apiFetch against meetings-api', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { items: [] }))
    await expect(getJson('/meetings')).resolves.toEqual({ items: [] })
    expect(apiFetch).toHaveBeenCalledWith('http://meetings-api.test/meetings', undefined)
  })

  it('forwards the init verbatim, e.g. an AbortSignal', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, {}))
    const controller = new AbortController()
    await getJson('/meetings', { signal: controller.signal })
    expect(lastInit().signal).toBe(controller.signal)
  })

  it('a mutation of a versioned record sends If-Match with the quoted version (ADR-0038)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { id: 't1' }))
    await sendJson('/templates/t1', 'PATCH', { name: 'New' }, 7)
    expect(lastInit().method).toBe('PATCH')
    expect(lastHeaders()['If-Match']).toBe('"7"')
    expect(lastHeaders()['Content-Type']).toBe('application/json')
    expect(JSON.parse(lastInit().body as string)).toEqual({ name: 'New' })
  })

  it('a body-less POST sends no body and no Content-Type', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(202, { id: 'm1' }))
    await sendJson('/meetings/m1/retry', 'POST')
    expect(lastInit().body).toBeUndefined()
    expect(lastHeaders()['Content-Type']).toBeUndefined()
    expect(lastHeaders()['If-Match']).toBeUndefined()
  })

  it('a version of 0 still sends If-Match (0 is a version, not "absent")', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, {}))
    await sendJson('/templates/t1', 'PATCH', {}, 0)
    expect(lastHeaders()['If-Match']).toBe('"0"')
  })

  it('a 204 resolves undefined', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 204 }))
    await expect(sendJson('/meetings/m1', 'DELETE')).resolves.toBeUndefined()
  })

  it('requestJson can target another origin (the auth directory)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { users: [] }))
    await requestJson('http://auth.test', '/authz/users/directory')
    expect(vi.mocked(apiFetch).mock.calls[0]![0]).toBe('http://auth.test/authz/users/directory')
  })
})

describe('errors', () => {
  it('maps a Problem body to ApiError with code and top-level extras', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      json(409, {
        type: 't',
        title: 'Conflict',
        status: 409,
        detail: 'Locked',
        code: 'chunks_missing',
        missing: [2, 5],
      }),
    )
    const error = await catchError(getJson('/meetings/m1/recording/stop'))
    expect(error.status).toBe(409)
    expect(error.code).toBe('chunks_missing')
    expect(error.detail).toBe('Locked')
    expect(error.extras).toEqual({ missing: [2, 5] })
  })

  it('reads Retry-After on a 429 (ai_rate_limited tells the person when to retry)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      json(429, { title: 'Too Many Requests', status: 429, code: 'ai_rate_limited' }, { 'Retry-After': '12' }),
    )
    expect((await catchError(getJson('/x'))).retryAfterSeconds).toBe(12)
  })

  it('ignores a Retry-After that is an HTTP date', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(429, { title: 'x' }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }))
    expect((await catchError(getJson('/x'))).retryAfterSeconds).toBeNull()
  })

  it('falls back to the HTTP status when the body is not JSON', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('oops', { status: 502, statusText: 'Bad Gateway' }))
    const error = await catchError(getJson('/x'))
    expect(error.status).toBe(502)
    expect(error.title).toBe('Bad Gateway')
    expect(error.code).toBeUndefined()
  })

  it('falls back to the HTTP status when the body is JSON but not an object', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(500, ['nope']))
    expect((await catchError(getJson('/x'))).status).toBe(500)
  })

  it('a network failure is not an ApiError: the rejection propagates', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(getJson('/x')).rejects.toBeInstanceOf(TypeError)
  })

  it('isStaleWrite is true for 409 version_conflict and for 428, and nothing else', () => {
    expect(isStaleWrite(new ApiError({ status: 409, title: 'c', code: 'version_conflict' }))).toBe(true)
    expect(isStaleWrite(new ApiError({ status: 428, title: 'p', code: 'precondition_required' }))).toBe(true)
    expect(isStaleWrite(new ApiError({ status: 409, title: 'c', code: 'template_name_taken' }))).toBe(false)
    expect(isStaleWrite(new TypeError('network'))).toBe(false)
  })
})

describe('helpers', () => {
  it('ifMatch quotes the version as a strong ETag', () => {
    expect(ifMatch(12)).toBe('"12"')
  })

  it('query keeps only defined, non-empty values and encodes them', () => {
    expect(query({ q: '', status: undefined, page: 2, open: true, ownerId: null })).toBe('?page=2&open=true')
    expect(query({ q: 'Q4 & plan' })).toBe('?q=Q4+%26+plan')
    expect(query({})).toBe('')
  })

  it('query keeps a page of 0 and a false flag (falsy is not empty)', () => {
    expect(query({ page: 0, archived: false })).toBe('?page=0&archived=false')
  })
})
