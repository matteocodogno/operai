/**
 * @vitest-environment jsdom
 *
 * exchangeRatesApi (T21, specs/20261118-refund-accounting-export): URLs, query, bodies and error `code` passthrough.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'
import { fetchExchangeRates, listExchangeRates, putExchangeRate } from './exchangeRatesApi'

const BASE = 'http://refund-api.test'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const lastCall = () => {
  const [url, init] = vi.mocked(apiFetch).mock.calls[0]
  return {
    url: String(url),
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }
}

beforeEach(() => {
  vi.stubEnv('VITE_REFUND_API_URL', BASE)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('listExchangeRates', () => {
  it('GETs the default window with no query', async () => {
    const body = { months: [], lastFetch: null, fetchDue: false }
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, body))
    await expect(listExchangeRates()).resolves.toEqual(body)
    expect(lastCall()).toMatchObject({ url: `${BASE}/exchange-rates`, method: 'GET' })
  })

  it('passes from and to as a query, either alone or both', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { months: [], lastFetch: null, fetchDue: false }))
    await listExchangeRates({ from: '2026-01', to: '2026-10' })
    expect(lastCall().url).toBe(`${BASE}/exchange-rates?from=2026-01&to=2026-10`)

    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { months: [], lastFetch: null, fetchDue: false }))
    await listExchangeRates({ from: '2026-03' })
    expect(lastCall().url).toBe(`${BASE}/exchange-rates?from=2026-03`)
  })

  it('throws a 403 for a caller without settings:read', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(403, { title: 'Forbidden', status: 403 }))
    await expect(listExchangeRates()).rejects.toMatchObject({ status: 403 })
  })
})

describe('fetchExchangeRates', () => {
  it('POSTs an empty body for "every missing month"', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { attempts: [], lastFetch: null }))
    await fetchExchangeRates()
    expect(lastCall()).toEqual({ url: `${BASE}/exchange-rates/fetch`, method: 'POST', body: {} })
  })

  it('POSTs the months asked for', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { attempts: [], lastFetch: null }))
    await fetchExchangeRates(['2026-10'])
    expect(lastCall().body).toEqual({ months: ['2026-10'] })
  })

  it('returns a failed attempt as a 200 result, not an error (AC-5.6)', async () => {
    const result = {
      attempts: [{ month: '2026-10', outcome: 'failed', errorCode: 'timeout', recorded: null }],
      lastFetch: { at: '2026-11-18T09:14:00Z', outcome: 'failed', errorCode: 'timeout', month: '2026-10' },
    }
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, result))
    await expect(fetchExchangeRates()).resolves.toEqual(result)
  })
})

describe('putExchangeRate', () => {
  it('PUTs the rate as a string to the month and currency', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(200, { month: '2026-03', rates: {} }))
    await putExchangeRate('2026-03', 'EUR', '0.9246')
    expect(lastCall()).toEqual({ url: `${BASE}/exchange-rates/2026-03/EUR`, method: 'PUT', body: { rate: '0.9246' } })
  })

  it.each(['invalid_rate', 'currency_not_convertible', 'month_not_completed'])(
    'passes the 422 %s through',
    async (code) => {
      vi.mocked(apiFetch).mockResolvedValueOnce(json(422, { title: 'Unprocessable', status: 422, code }))
      await expect(putExchangeRate('2026-11', 'EUR', '0.9')).rejects.toMatchObject({ status: 422, code })
    },
  )
})
