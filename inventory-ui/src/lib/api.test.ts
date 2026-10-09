import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getInventoryApiBaseUrl: vi.fn(() => 'http://inventory-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import { ApiError, deleteJson, getJson, requestJson, sendJson } from './api'

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

describe('getJson / sendJson / deleteJson — requests', () => {
  it('GET goes through shell/session apiFetch against inventory-api and parses the 200 body', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { items: [], nextCursor: null }))

    await expect(getJson('/assets?limit=50')).resolves.toEqual({ items: [], nextCursor: null })

    expect(apiFetch).toHaveBeenCalledWith('http://inventory-api.test/assets?limit=50', undefined)
  })

  it('forwards the RequestInit (an AbortSignal) to apiFetch', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, {}))
    const signal = new AbortController().signal

    await getJson('/scope', { signal })

    expect(apiFetch).toHaveBeenCalledWith('http://inventory-api.test/scope', { signal })
  })

  it('sendJson sends the method, a JSON Content-Type and the serialised body', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(201, { assets: [] }))

    await sendJson('/assets', 'POST', { entity: 'welld_ch' })

    expect(apiFetch).toHaveBeenCalledWith('http://inventory-api.test/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity: 'welld_ch' }),
    })
  })

  it('sendJson without a body (status transitions) sends no body and no Content-Type', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { id: 'a-1' }))

    await sendJson('/assets/a-1/receive', 'POST')

    expect(apiFetch).toHaveBeenCalledWith('http://inventory-api.test/assets/a-1/receive', { method: 'POST' })
  })

  it('resolves undefined on a bodyless 204', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 204 }))

    await expect(sendJson('/me/assignments/x/decline', 'POST')).resolves.toBeUndefined()
  })

  it('deleteJson sends DELETE and resolves on 204', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 204 }))

    await expect(deleteJson('/x/1')).resolves.toBeUndefined()
    expect(apiFetch).toHaveBeenCalledWith('http://inventory-api.test/x/1', { method: 'DELETE' })
  })

  it('requestJson targets any base URL (the directory call goes to auth, not inventory-api)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { users: [] }))

    await requestJson('http://auth.test', '/authz/users/directory')

    expect(apiFetch).toHaveBeenCalledWith('http://auth.test/authz/users/directory', undefined)
  })
})

describe('Problem JSON → ApiError {status, code, detail, extras}', () => {
  it('maps status, code and detail', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      json(409, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Asset is disposed',
        code: 'asset_disposed',
      }),
    )

    const error = await catchError(sendJson('/assets/a-1/lost', 'POST'))

    expect(error.status).toBe(409)
    expect(error.code).toBe('asset_disposed')
    expect(error.detail).toBe('Asset is disposed')
    expect(error.title).toBe('Conflict')
    expect(error.extras).toEqual({})
  })

  it('collects the extension members (serialNumber, assetId, year, from, field) into extras', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      json(409, {
        type: 'x',
        title: 'Conflict',
        status: 409,
        code: 'serial_conflict',
        serialNumber: 'SN-1',
        assetId: 'a-9',
      }),
    )

    const error = await catchError(sendJson('/assets', 'POST', {}))

    expect(error.code).toBe('serial_conflict')
    expect(error.extras).toEqual({ serialNumber: 'SN-1', assetId: 'a-9' })
  })

  it('keeps `instance` out of extras', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(404, { title: 'Not found', status: 404, instance: '/assets/zz' }))

    const error = await catchError(getJson('/assets/zz'))

    expect(error.extras).toEqual({})
  })

  it('a 422 with a `field` member exposes it through extras', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(422, { title: 'Invalid', status: 422, field: 'usefulLifeYears' }))

    const error = await catchError(sendJson('/rules', 'POST', {}))

    expect(error.status).toBe(422)
    expect(error.code).toBeUndefined()
    expect(error.extras).toEqual({ field: 'usefulLifeYears' })
  })

  it('a 429 carries Retry-After as retryAfterSeconds (the directory copy shows "{n} seconds")', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(429, { title: 'Too many', status: 429 }, { 'Retry-After': '12' }))

    const error = await catchError(requestJson('http://auth.test', '/authz/users/directory'))

    expect(error.status).toBe(429)
    expect(error.retryAfterSeconds).toBe(12)
  })

  it('retryAfterSeconds is null when the header is absent or not a whole number of seconds', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(429, { title: 'x', status: 429 }))
    vi.mocked(apiFetch).mockResolvedValueOnce(
      json(429, { title: 'x', status: 429 }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    )

    expect((await catchError(getJson('/a'))).retryAfterSeconds).toBeNull()
    expect((await catchError(getJson('/b'))).retryAfterSeconds).toBeNull()
  })

  it('a non-JSON error body falls back to a synthetic problem built from the HTTP status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    )

    const error = await catchError(getJson('/assets'))

    expect(error.status).toBe(502)
    expect(error.title).toBe('Bad Gateway')
    expect(error.code).toBeUndefined()
    expect(error.detail).toBeUndefined()
    expect(error.extras).toEqual({})
  })

  it('a JSON body that is not an object (null, an array) also falls back to the status', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(500, null))
    vi.mocked(apiFetch).mockResolvedValueOnce(json(503, ['x']))

    expect((await catchError(getJson('/a'))).status).toBe(500)
    expect((await catchError(getJson('/b'))).status).toBe(503)
  })

  it('a non-string `code` is ignored rather than trusted', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(409, { title: 'x', status: 409, code: 42 }))

    const error = await catchError(getJson('/a'))

    expect(error.code).toBeUndefined()
  })

  it('a network failure (fetch rejects) is not an ApiError — callers show the generic retry banner', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(getJson('/assets')).rejects.toBeInstanceOf(TypeError)
  })
})
