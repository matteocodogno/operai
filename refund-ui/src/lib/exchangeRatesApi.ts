/**
 * exchangeRatesApi — the monthly CHF exchange rates (specs/20261118-refund-accounting-export, plan.md
 * § API contracts → Exchange rates): `settings:read` to read, `settings:manage` to fetch or correct.
 *
 * A source failure is NOT an HTTP error: `POST /exchange-rates/fetch` answers 200 with `outcome: "failed"`
 * and the rates untouched, and the last attempt is part of the GET (AC-5.6). A rate travels as
 * `rateMicros` (integer) and as the server's display string; the UI shows the string and never converts.
 */

import { getJson, sendJson } from './refundApi'

/** The currencies that have a rate (CHF is the base and has none). */
export type RateCurrency = 'EUR' | 'USD' | 'GBP'

export type RateOrigin = 'fetched' | 'corrected'

export type RateHistoryEntry = { origin: RateOrigin; rate: string; at: string; byEmail: string }

export type MissingRate = { status: 'missing' }

export type RecordedRate = {
  status: RateOrigin
  rateMicros: number
  /** `"0.9246"` */
  rate: string
  fetchedAt?: string
  sourceUrl?: string
  correctedAt?: string
  correctedByEmail?: string
  history: RateHistoryEntry[]
}

export type Rate = MissingRate | RecordedRate

export type ExchangeRateMonth = {
  /** `"2026-03"` */
  month: string
  rates: Record<RateCurrency, Rate>
}

/** `ok` recorded something or nothing new, `failed` the source did not give a usable answer, `not_fetchable` the month is not published yet, `disabled` fetching is switched off. */
export type FetchOutcome = 'ok' | 'failed' | 'not_fetchable' | 'disabled'

export type LastFetch = {
  at: string
  outcome: FetchOutcome
  /** `timeout`, `http_<status>`, `parse`, `month_mismatch`, `currency_missing`. */
  errorCode: string | null
  month: string
}

export type ExchangeRates = {
  /** Newest first. */
  months: ExchangeRateMonth[]
  lastFetch: LastFetch | null
  /** True when the server wants the view to fetch the missing rates once. */
  fetchDue: boolean
}

export type FetchAttempt = {
  month: string
  outcome: FetchOutcome
  errorCode: string | null
  /** What this attempt newly recorded (`{ EUR: 924600 }`), or `null`/empty when nothing. */
  recorded: Record<string, number> | null
}

export type FetchResult = { attempts: FetchAttempt[]; lastFetch: LastFetch | null }

/** `GET /exchange-rates?from=YYYY-MM&to=YYYY-MM`: with no window, the server's default (from 2026-01 to the last completed month). */
export const listExchangeRates = (window: { from?: string; to?: string } = {}): Promise<ExchangeRates> => {
  const query = new URLSearchParams()
  if (window.from) query.set('from', window.from)
  if (window.to) query.set('to', window.to)
  const qs = query.toString()
  return getJson<ExchangeRates>(`/exchange-rates${qs ? `?${qs}` : ''}`)
}

/** `POST /exchange-rates/fetch` (`settings:manage`). With no months: every fetchable month that lacks a rate. */
export const fetchExchangeRates = (months?: string[]): Promise<FetchResult> =>
  sendJson<FetchResult>('/exchange-rates/fetch', 'POST', months ? { months } : {})

/**
 * `PUT /exchange-rates/:month/:currency` (`settings:manage`): `rate` is a string (`^\d{1,4}(\.\d{1,6})?$`, > 0).
 * 422 `invalid_rate` / `currency_not_convertible` / `month_not_completed`. Answers with the whole month row.
 */
export const putExchangeRate = (month: string, currency: RateCurrency, rate: string): Promise<ExchangeRateMonth> =>
  sendJson<ExchangeRateMonth>(`/exchange-rates/${encodeURIComponent(month)}/${encodeURIComponent(currency)}`, 'PUT', {
    rate,
  })
