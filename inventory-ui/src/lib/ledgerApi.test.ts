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
import { disposeAsset } from './ledgerApi'

const body = { disposedOn: '2026-10-05', reason: 'sold' as const, salePriceCents: 12000 }

describe('ledgerApi — dispose', () => {
  it('POST /assets/{id}/dispose sends the body and returns the asset', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { id: 'a-1', status: 'disposed' }))

    await expect(disposeAsset('a-1', body)).resolves.toEqual({ id: 'a-1', status: 'disposed' })

    expect(lastRequest()).toMatchObject({ url: `${BASE}/assets/a-1/dispose`, method: 'POST', body })
  })

  it('omits salePriceCents when the reason carries none', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, {}))

    await disposeAsset('a-1', { disposedOn: '2026-10-05', reason: 'scrapped' })

    expect(lastRequest().body).toEqual({ disposedOn: '2026-10-05', reason: 'scrapped' })
  })

  it.each([
    ['asset_disposed', 409, {}, {}],
    ['assignment_pending', 409, { assignmentId: 'as-1' }, { assignmentId: 'as-1' }],
    ['fiscal_year_closed', 409, { year: 2025 }, { year: 2025 }],
    ['disposed_before_purchase', 422, {}, {}],
    ['sale_price_not_allowed', 422, {}, {}],
  ])('%s maps to the known error', async (code, status, wire, extras) => {
    vi.mocked(apiFetch).mockResolvedValue(problem(status, { code, ...wire }))

    expect(toInventoryError(await rejection(disposeAsset('a-1', body)))).toMatchObject({ code, status, extras })
  })

  it('403 (manager-only caller) is a plain ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(403))

    expect((await rejection(disposeAsset('a-1', body))).status).toBe(403)
  })
})
