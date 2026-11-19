import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

import { ApiError, getJson, sendJson } from './api'

const problemResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

beforeEach(() => {
  apiFetch.mockReset()
})

describe('getJson / sendJson', () => {
  it('calls the base URL the shell provides and parses the JSON answer', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    await expect(getJson('/v1/me')).resolves.toEqual({ ok: 1 })
    expect(apiFetch).toHaveBeenCalledWith('http://accounting-api.test/v1/me', undefined)
  })

  it('forwards an abort signal verbatim', async () => {
    apiFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    const { signal } = new AbortController()
    await getJson('/v1/me', { signal })
    expect(apiFetch.mock.calls[0]?.[1]).toEqual({ signal })
  })

  it('resolves undefined for a bodyless 204', async () => {
    apiFetch.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(sendJson('/v1/x', 'POST')).resolves.toBeUndefined()
  })

  it('sends a JSON body with its content type, and no body header when there is none', async () => {
    apiFetch.mockResolvedValue(new Response('{}', { status: 201 }))
    await sendJson('/v1/entities/welld_ch/ledger-accounts', 'POST', { number: '5905', name: 'Cassa' })
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://accounting-api.test/v1/entities/welld_ch/ledger-accounts')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(init.body).toBe('{"number":"5905","name":"Cassa"}')

    apiFetch.mockResolvedValue(new Response('{}', { status: 201 }))
    await sendJson('/v1/x', 'POST')
    const [, bare] = apiFetch.mock.calls[1] as [string, RequestInit]
    expect(bare.headers).toEqual({})
    expect(bare.body).toBeUndefined()
  })
})

describe('ApiError', () => {
  it('turns a Problem body into code, detail and extras (fields, reactivate)', async () => {
    apiFetch.mockResolvedValue(
      problemResponse(
        422,
        {
          type: 'about:blank',
          title: 'Invalid',
          status: 422,
          code: 'invalid_ledger_account',
          detail: 'No.',
          fields: [{ field: 'number', reason: 'format' }],
        },
        { 'Retry-After': '7' },
      ),
    )
    const error = (await getJson('/v1/x').catch((e: unknown) => e)) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(422)
    expect(error.code).toBe('invalid_ledger_account')
    expect(error.detail).toBe('No.')
    expect(error.extras).toEqual({ fields: [{ field: 'number', reason: 'format' }] })
    expect(error.retryAfterSeconds).toBe(7)
  })

  it('falls back to the HTTP status for an unparseable or non-object body', async () => {
    apiFetch.mockResolvedValueOnce(new Response('<html>', { status: 502 }))
    const html = (await getJson('/v1/x').catch((e: unknown) => e)) as ApiError
    expect(html.status).toBe(502)
    expect(html.code).toBeUndefined()

    apiFetch.mockResolvedValueOnce(problemResponse(500, ['x']))
    const array = (await getJson('/v1/x').catch((e: unknown) => e)) as ApiError
    expect(array.status).toBe(500)
  })

  it('lets a network failure propagate as it is, not as an ApiError', async () => {
    apiFetch.mockImplementation(async () => {
      throw new TypeError('Failed to fetch')
    })
    const error = await getJson('/v1/x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).not.toBeInstanceOf(ApiError)
  })

  it('ignores a Retry-After that is not whole seconds', async () => {
    apiFetch.mockResolvedValue(
      problemResponse(503, { status: 503 }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    )
    const error = (await getJson('/v1/x').catch((e: unknown) => e)) as ApiError
    expect(error.retryAfterSeconds).toBeNull()
  })
})
