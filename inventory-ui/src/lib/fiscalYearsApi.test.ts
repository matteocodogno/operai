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
import { closeFiscalYear, getFiscalYear, listFiscalYears } from './fiscalYearsApi'

describe('fiscalYearsApi', () => {
  it('GET /fiscal-years?entity returns the years with their closable flag', async () => {
    const years = [{ year: 2025, status: 'open', closedAt: null, closable: true }]
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { years }))

    await expect(listFiscalYears('welld_ch')).resolves.toEqual({ years })

    expect(lastRequest()).toMatchObject({ url: `${BASE}/fiscal-years?entity=welld_ch`, method: 'GET' })
  })

  it('GET /fiscal-years/{entity}/{year} returns the roll-forward view', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(200, { entity: 'welld_it', year: 2025 }))

    await expect(getFiscalYear('welld_it', 2025)).resolves.toEqual({ entity: 'welld_it', year: 2025 })

    expect(lastRequest()).toMatchObject({ url: `${BASE}/fiscal-years/welld_it/2025`, method: 'GET' })
  })

  it('GET year: 404 (out of scope or before the first year) is a plain ApiError', async () => {
    vi.mocked(apiFetch).mockResolvedValue(problem(404))

    expect((await rejection(getFiscalYear('welld_it', 1999))).status).toBe(404)
  })

  it('POST /fiscal-years/{entity}/{year}/close has no body and returns the closed view', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(201, { entity: 'welld_ch', year: 2025, status: 'closed' }))

    await expect(closeFiscalYear('welld_ch', 2025)).resolves.toMatchObject({ status: 'closed' })

    expect(lastRequest()).toMatchObject({
      url: `${BASE}/fiscal-years/welld_ch/2025/close`,
      method: 'POST',
      rawBody: undefined,
    })
  })

  it.each(['previous_year_open', 'already_closed', 'nothing_to_close'])(
    'close: 409 %s maps to the known error',
    async (code) => {
      vi.mocked(apiFetch).mockResolvedValue(problem(409, { code }))

      expect(toInventoryError(await rejection(closeFiscalYear('welld_ch', 2025)))).toMatchObject({
        code,
        status: 409,
        extras: {},
      })
    },
  )
})
