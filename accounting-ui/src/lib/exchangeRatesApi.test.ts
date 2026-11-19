import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, problem } from '../test-support/fakeApi'
import { ApiError } from './api'
import { fetchExchangeRates, listExchangeRates, putExchangeRate } from './exchangeRatesApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

afterEach(() => vi.clearAllMocks())

const urlOf = (call: number) => String(apiFetch.mock.calls[call]![0])
const initOf = (call: number) => apiFetch.mock.calls[call]![1] as RequestInit

const LIST_BODY = {
  entity: 'welld_ch',
  ownCurrency: 'CHF',
  currencies: ['EUR', 'USD', 'GBP'],
  source: { name: 'bazg' },
  months: [
    {
      month: '2026-03',
      rates: {
        EUR: { status: 'fetched', rateMicros: 924600, rate: '0.9246' },
        USD: { status: 'corrected', rateMicros: 810200, rate: '0.8102' },
        GBP: { status: 'missing' },
      },
    },
  ],
  lastFetch: { at: '2026-11-18T09:14:00Z', outcome: 'ok', errorCode: null, month: '2026-10' },
  fetchDue: true,
}

describe('exchangeRatesApi (T31, plan § API contracts, G5)', () => {
  it('lists under the entity’s path, with the window only when asked for', async () => {
    apiFetch.mockImplementation(fakeApi({ 'GET /v1/entities/welld_ch/exchange-rates': () => ({ status: 200, body: LIST_BODY }) }))
    const rates = await listExchangeRates('welld_ch')
    expect(urlOf(0)).toBe('http://accounting-api.test/v1/entities/welld_ch/exchange-rates')
    await listExchangeRates('welld_ch', { from: '2026-01', to: '2026-10' })
    expect(urlOf(1)).toBe('http://accounting-api.test/v1/entities/welld_ch/exchange-rates?from=2026-01&to=2026-10')
    expect(rates).toEqual({
      ownCurrency: 'CHF',
      currencies: ['EUR', 'USD', 'GBP'],
      source: { name: 'bazg' },
      months: [
        {
          month: '2026-03',
          rates: {
            EUR: { status: 'fetched', rateMicros: 924600, rate: '0.9246' },
            USD: { status: 'corrected', rateMicros: 810200, rate: '0.8102' },
            GBP: { status: 'missing' },
          },
        },
      ],
      lastFetch: { at: '2026-11-18T09:14:00Z', outcome: 'ok', errorCode: null, month: '2026-10' },
      fetchDue: true,
    })
  })

  it('keeps no history, no who and no when on a rate (UX-8, D18)', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /v1/entities/welld_ch/exchange-rates': () => ({
          status: 200,
          body: {
            ...LIST_BODY,
            months: [
              {
                month: '2026-03',
                rates: { EUR: { status: 'fetched', rateMicros: 1, rate: '1', history: [{ byEmail: 'x@welld.ch' }], correctedByEmail: 'x@welld.ch', fetchedAt: 'now' } },
              },
            ],
          },
        }),
      }),
    )
    const rates = await listExchangeRates('welld_ch')
    expect(JSON.stringify(rates)).not.toMatch(/history|byEmail|fetchedAt|correctedBy|sourceUrl/)
  })

  it('reads WellD Italia: no source, no currencies, and never fetchDue', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /v1/entities/welld_it/exchange-rates': () => ({
          status: 200,
          body: { entity: 'welld_it', ownCurrency: 'EUR', currencies: [], source: null, months: [], lastFetch: null, fetchDue: true },
        }),
      }),
    )
    const rates = await listExchangeRates('welld_it')
    expect(rates.source).toBeNull()
    expect(rates.currencies).toEqual([])
    // with no source nothing is due, whatever the server says
    expect(rates.fetchDue).toBe(false)
  })

  it('reads defensively: an unknown rate status is missing, a missing currency is missing, fetchDue only when literally true', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'GET /v1/entities/welld_ch/exchange-rates': () => ({
          status: 200,
          body: {
            ...LIST_BODY,
            fetchDue: 'yes',
            lastFetch: { at: 'x', outcome: 'exploded', errorCode: null, month: '2026-10' },
            months: [null, { month: 7 }, { month: '2026-02', rates: { EUR: { status: 'weird', rate: '1' }, USD: { status: 'fetched', rate: '1' } } }],
          },
        }),
      }),
    )
    const rates = await listExchangeRates('welld_ch')
    expect(rates.fetchDue).toBe(false)
    expect(rates.lastFetch).toBeNull()
    expect(rates.months).toEqual([
      { month: '2026-02', rates: { EUR: { status: 'missing' }, USD: { status: 'missing' }, GBP: { status: 'missing' } } },
    ])
  })

  it('fetches with POST and NO trigger: an empty body for every fetchable month, or the months asked', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'POST /v1/entities/welld_ch/exchange-rates/fetch': () => ({
          status: 200,
          body: {
            attempts: [
              { month: '2026-03', outcome: 'ok', errorCode: null, recorded: { EUR: 924600 } },
              { month: '2026-02', outcome: 'not_fetchable', errorCode: null, recorded: null },
              { month: '2026-01', outcome: 'exploded' },
              'junk',
            ],
            deferredMonths: ['2025-12', 3],
            lastFetch: LIST_BODY.lastFetch,
          },
        }),
      }),
    )
    const result = await fetchExchangeRates('welld_ch')
    expect(initOf(0).method).toBe('POST')
    expect(JSON.parse(String(initOf(0).body))).toEqual({})
    await fetchExchangeRates('welld_ch', ['2026-03'])
    expect(JSON.parse(String(initOf(1).body))).toEqual({ months: ['2026-03'] })
    expect(String(initOf(0).body)).not.toContain('trigger')
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(['ok', 'not_fetchable'])
    expect(result.attempts[0]!.recorded).toEqual({ EUR: 924600 })
    expect(result.deferredMonths).toEqual(['2025-12'])
    expect(result.lastFetch?.outcome).toBe('ok')
  })

  it('a fetch answer without deferredMonths reads as none', async () => {
    apiFetch.mockImplementation(
      fakeApi({ 'POST /v1/entities/welld_ch/exchange-rates/fetch': () => ({ status: 200, body: { attempts: [], lastFetch: null } }) }),
    )
    expect((await fetchExchangeRates('welld_ch')).deferredMonths).toEqual([])
  })

  it('a refused fetch is an ApiError with its code (no_rate_source)', async () => {
    apiFetch.mockImplementation(fakeApi({ 'POST /v1/entities/welld_it/exchange-rates/fetch': () => problem(422, 'no_rate_source') }))
    const error = await fetchExchangeRates('welld_it').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('no_rate_source')
  })

  it('corrects with PUT {rate} on month and currency, encoded, and answers the month row', async () => {
    apiFetch.mockImplementation(
      fakeApi({
        'PUT /v1/entities/welld_ch/exchange-rates/2026-03/EUR': () => ({
          status: 200,
          body: { month: '2026-03', rates: { EUR: { status: 'corrected', rateMicros: 930000, rate: '0.93' } } },
        }),
      }),
    )
    const row = await putExchangeRate('welld_ch', '2026-03', 'EUR', '0.93', ['EUR'])
    expect(initOf(0).method).toBe('PUT')
    expect(JSON.parse(String(initOf(0).body))).toEqual({ rate: '0.93' })
    expect(row).toEqual({ month: '2026-03', rates: { EUR: { status: 'corrected', rateMicros: 930000, rate: '0.93' } } })
  })

  it.each([
    ['an empty 200 body', () => ({ status: 200 })],
    ['a 200 that is not a month row', () => ({ status: 200, body: { ok: true } })],
  ])('reads %s as "nothing recorded" (null)', async (_name, answer) => {
    apiFetch.mockImplementation(fakeApi({ 'PUT /v1/entities/welld_ch/exchange-rates/2026-03/EUR': answer }))
    expect(await putExchangeRate('welld_ch', '2026-03', 'EUR', '0.93', ['EUR'])).toBeNull()
  })

  it('a refused correction is an ApiError, never read as a no-op', async () => {
    apiFetch.mockImplementation(fakeApi({ 'PUT /v1/entities/welld_ch/exchange-rates/2026-03/EUR': () => problem(422, 'invalid_rate') }))
    const error = await putExchangeRate('welld_ch', '2026-03', 'EUR', '0', ['EUR']).catch((e: unknown) => e)
    expect((error as ApiError).code).toBe('invalid_rate')
  })
})
