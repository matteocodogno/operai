/**
 * exchangeRatesApi — one entity's monthly exchange rates (moved from refund-ui, where it was WellD CH's only;
 * specs/20261119-accounting, plan § API contracts, G5, design UX-8, UX-9):
 *
 *   GET  /v1/entities/{entity}/exchange-rates?from=YYYY-MM&to=YYYY-MM
 *        200 { entity, ownCurrency, currencies: ["EUR","USD","GBP"], source: { name: "bazg" } | null,
 *              months: [ { month, rates: { EUR: Rate, … } } ], lastFetch: { at, outcome, errorCode, month } | null, fetchDue }
 *        `currencies` is `[]` and `source` null for WellD Italia: no official source yet (AC-2.11, D19)
 *   POST /v1/entities/{entity}/exchange-rates/fetch   { months? }       manage (AC-2.9)
 *        200 { attempts: [ { month, outcome, errorCode, recorded } ], deferredMonths, lastFetch }   (G5: the 20261118 shape kept)
 *        422 no_rate_source
 *   PUT  /v1/entities/{entity}/exchange-rates/{month}/{currency}   { rate: "0.9300" }     manage
 *        200 the month row, or 200 with no row when the rate is the one in effect · 422 invalid_rate | month_not_completed |
 *        currency_not_convertible
 *
 * What changed against refund-ui: paths under the entity; no `trigger` in the fetch body (the server derives who asks, D4); no
 * `fetchedAt`, `history`, `sourceUrl` or `correctedBy…` on a rate (no history drawer, UX-8; no who or when, D18, G13); the
 * entity's own currency, its currencies and its source come with the list.
 *
 * A source failure is NOT an HTTP error: the fetch answers 200 with `outcome: "failed"` and the rates untouched, and the last
 * attempt is part of the GET (AC-2.8). A rate travels as `rateMicros` (integer) and as the server's display string; the UI shows
 * the string and never converts. The answers are read defensively, as `readMe` does: what this build cannot vouch for is dropped
 * or read as the safe value (an unknown rate status is `missing`, `fetchDue` is true only when it is literally `true`).
 */

import { getJson, sendJson } from './api'
import type { EntityId } from './meApi'

/** A currency code the entity lists (EUR, USD, GBP for WellD CH). The entity's own currency has none. */
export type RateCurrency = string

export type RateOrigin = 'fetched' | 'corrected'

export type MissingRate = { status: 'missing' }

export type RecordedRate = {
  status: RateOrigin
  rateMicros: number
  /** `"0.9246"` */
  rate: string
}

export type Rate = MissingRate | RecordedRate

export type ExchangeRateMonth = {
  /** `"2026-03"` */
  month: string
  rates: Record<RateCurrency, Rate>
}

/**
 * `ok` recorded something or nothing new, `failed` the source did not give a usable answer, `not_fetchable` the month is not
 * published yet, `disabled` fetching is switched off, `throttled` it was asked again within 15 minutes and nothing was written
 * (informational, not an error).
 */
export type FetchOutcome = 'ok' | 'failed' | 'not_fetchable' | 'disabled' | 'throttled'

const OUTCOMES: readonly FetchOutcome[] = ['ok', 'failed', 'not_fetchable', 'disabled', 'throttled']

export type LastFetch = {
  at: string
  outcome: FetchOutcome
  /** `timeout`, `http_<status>`, `parse`, `month_mismatch`, `currency_missing`. */
  errorCode: string | null
  month: string
}

/** Where an entity's rates come from; `null` where no official source is chosen yet (AC-2.11). */
export type RateSource = { name: string }

export type ExchangeRates = {
  /** The unit rates are quoted in: CHF for WellD CH. */
  ownCurrency: string
  /** The currencies that have a rate, in column order. Empty with no source. */
  currencies: RateCurrency[]
  source: RateSource | null
  /** Newest first. */
  months: ExchangeRateMonth[]
  lastFetch: LastFetch | null
  /** True when the server wants a manager's view to fetch the missing rates once (D26). */
  fetchDue: boolean
}

export type FetchAttempt = {
  month: string
  outcome: FetchOutcome
  errorCode: string | null
  /** What this attempt newly recorded (`{ EUR: 924600 }`), or `null`/empty when nothing. */
  recorded: Record<string, number> | null
}

export type FetchResult = {
  attempts: FetchAttempt[]
  /** Months over the server's limit per call, not attempted: fetching again continues with them. Absent reads as none. */
  deferredMonths: string[]
  lastFetch: LastFetch | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asOutcome = (value: unknown): FetchOutcome | null =>
  OUTCOMES.find((outcome) => outcome === value) ?? null

const readLastFetch = (value: unknown): LastFetch | null => {
  if (!isRecord(value)) return null
  const outcome = asOutcome(value.outcome)
  if (outcome === null || typeof value.at !== 'string') return null
  return {
    at: value.at,
    outcome,
    errorCode: typeof value.errorCode === 'string' ? value.errorCode : null,
    month: typeof value.month === 'string' ? value.month : '',
  }
}

const readRate = (value: unknown): Rate => {
  if (
    isRecord(value) &&
    (value.status === 'fetched' || value.status === 'corrected') &&
    typeof value.rate === 'string' &&
    typeof value.rateMicros === 'number'
  ) {
    return { status: value.status, rateMicros: value.rateMicros, rate: value.rate }
  }
  return { status: 'missing' }
}

const readMonth = (value: unknown, currencies: readonly RateCurrency[]): ExchangeRateMonth | null => {
  if (!isRecord(value) || typeof value.month !== 'string') return null
  const raw = isRecord(value.rates) ? value.rates : {}
  // One entry per listed currency: a currency the row does not carry is missing, never absent (the table has a cell for it).
  return { month: value.month, rates: Object.fromEntries(currencies.map((currency) => [currency, readRate(raw[currency])])) }
}

const readRates = (body: unknown): ExchangeRates => {
  const record = isRecord(body) ? body : {}
  const currencies = Array.isArray(record.currencies)
    ? record.currencies.filter((currency): currency is string => typeof currency === 'string')
    : []
  const source = isRecord(record.source) && typeof record.source.name === 'string' ? { name: record.source.name } : null
  const months = Array.isArray(record.months)
    ? record.months.flatMap((row) => readMonth(row, currencies) ?? [])
    : []
  return {
    ownCurrency: typeof record.ownCurrency === 'string' ? record.ownCurrency : '',
    currencies,
    source,
    months,
    lastFetch: readLastFetch(record.lastFetch),
    // Only a literal `true` makes a view fetch on its own: with no source there is nothing to fetch.
    fetchDue: record.fetchDue === true && source !== null,
  }
}

const readFetchResult = (body: unknown): FetchResult => {
  const record = isRecord(body) ? body : {}
  const attempts = Array.isArray(record.attempts)
    ? record.attempts.flatMap((attempt): FetchAttempt[] => {
        if (!isRecord(attempt) || typeof attempt.month !== 'string') return []
        const outcome = asOutcome(attempt.outcome)
        if (outcome === null) return []
        const recorded = isRecord(attempt.recorded)
          ? Object.fromEntries(Object.entries(attempt.recorded).filter(([, micros]) => typeof micros === 'number'))
          : null
        return [
          {
            month: attempt.month,
            outcome,
            errorCode: typeof attempt.errorCode === 'string' ? attempt.errorCode : null,
            recorded: recorded as Record<string, number> | null,
          },
        ]
      })
    : []
  return {
    attempts,
    deferredMonths: Array.isArray(record.deferredMonths)
      ? record.deferredMonths.filter((month): month is string => typeof month === 'string')
      : [],
    lastFetch: readLastFetch(record.lastFetch),
  }
}

const path = (entity: EntityId, rest = ''): string => `/v1/entities/${encodeURIComponent(entity)}/exchange-rates${rest}`

/** `GET …/exchange-rates?from&to`: with no window, the server's default (from 2026-01 to the last completed month). */
export const listExchangeRates = async (
  entity: EntityId,
  window: { from?: string; to?: string } = {},
  init?: RequestInit,
): Promise<ExchangeRates> => {
  const query = new URLSearchParams()
  if (window.from) query.set('from', window.from)
  if (window.to) query.set('to', window.to)
  const qs = query.toString()
  return readRates(await getJson<unknown>(`${path(entity)}${qs ? `?${qs}` : ''}`, init))
}

/**
 * `POST …/exchange-rates/fetch` (manage). With no months: every fetchable month that lacks a rate. There is NO `trigger`: the
 * server tells a manager's request from a consumer's by the caller (D4).
 */
export const fetchExchangeRates = async (entity: EntityId, months?: string[]): Promise<FetchResult> =>
  readFetchResult(await sendJson<unknown>(path(entity, '/fetch'), 'POST', months ? { months } : {}))

/**
 * `PUT …/exchange-rates/{month}/{currency}` (manage): `rate` is a string (`0.9300`, above 0, below 1000, at most 6 decimals).
 * 422 `invalid_rate` / `currency_not_convertible` / `month_not_completed`. Answers with the whole month row, or `null` when the
 * server says nothing was recorded because the rate is the one in effect (a 200 with no row): the caller reads the list again.
 */
export const putExchangeRate = async (
  entity: EntityId,
  month: string,
  currency: RateCurrency,
  rate: string,
  currencies: readonly RateCurrency[],
): Promise<ExchangeRateMonth | null> => {
  let body: unknown
  try {
    body = await sendJson<unknown>(`${path(entity)}/${encodeURIComponent(month)}/${encodeURIComponent(currency)}`, 'PUT', {
      rate,
    })
  } catch (error) {
    // A 200 with an empty body is the no-op answer; `requestJson` only knows 204 as bodyless, so it surfaces as a JSON syntax error.
    if (error instanceof SyntaxError) return null
    throw error
  }
  return readMonth(body, currencies)
}
