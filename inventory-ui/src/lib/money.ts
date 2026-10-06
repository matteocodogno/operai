/**
 * money — `formatMoney(cents, currency)` and the money-input parser
 * (T25, specs/015-hardware-inventory; design.md § Component inventory: "Money
 * display: refund-ui/src/lib/money.ts formatMoney (EUR/CHF supported)").
 *
 * Re-authored from `refund-ui/src/lib/money.ts` (a remote cannot import
 * another remote's source, ADR-0006) keeping `formatMoney` and
 * `formatMoneyAmount` behaviour-for-behaviour; the refund-only helpers
 * (`describeApprovedAmount`, `formatRatePerKm`) and the USD/GBP suffixes are
 * not carried over — inventory-api carries EUR and CHF only (plan.md).
 *
 * Input is always **integer minor units** (cents) — inventory-api never puts a
 * float amount on the wire. The output is the suite convention, `x,xx €` /
 * `x,xx CHF`: comma decimal separator, no thousands separator, an explicit
 * currency label so a figure is never a bare, unitless number. Formatting is
 * integer arithmetic only (no `cents / 100`, no `Intl.NumberFormat`, whose
 * output depends on the runtime's ICU data), so the same cents render the same
 * characters in every environment. Components only DISPLAY money; they never
 * compute with it (the shared schedule-vectors rule).
 */

import type { Currency } from './types'

const CURRENCY_SUFFIX: Record<Currency, string> = {
  EUR: '€',
  CHF: 'CHF',
}

const requireInteger = (name: string, cents: number): void => {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`${name}: cents must be an integer, got ${cents}`)
  }
}

const toMajorString = (cents: number): string => {
  const negative = cents < 0
  const absCents = Math.abs(cents)
  const whole = Math.trunc(absCents / 100)
  const decimals = (absCents % 100).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole},${decimals}`
}

/**
 * Formats integer minor units as `x,xx €` / `x,xx CHF` — always exactly two
 * decimal digits. A non-integer or non-finite input is a programmer error and
 * throws rather than rendering a wrong amount.
 */
export const formatMoney = (cents: number, currency: Currency): string => {
  requireInteger('formatMoney', cents)
  return `${toMajorString(cents)} ${CURRENCY_SUFFIX[currency]}`
}

/**
 * Formats minor units WITHOUT a currency label (`154,00`). Only for a value
 * that sits beside one already carrying its currency; never for a standalone
 * figure.
 */
export const formatMoneyAmount = (cents: number): string => {
  requireInteger('formatMoneyAmount', cents)
  return toMajorString(cents)
}

const AMOUNT_INPUT = /^(\d+)(?:[.,](\d{1,2}))?$/

/**
 * Parses what a user types into a money field (`45.50`, `45,5`, `1299`) into
 * integer cents, or `null` when it is not a valid non-negative amount with at
 * most two decimals — callers treat `null` as "not a valid amount yet", never
 * as 0.
 *
 * Ported from refund-ui's `amountToCents` and tightened for a purchase price:
 * it parses the decimal STRING exactly (no `Math.round(n * 100)`, where
 * `1.15 * 100` is 114.99999999999999), accepts the comma the suite displays,
 * and refuses a third decimal instead of silently rounding a price.
 */
export const amountToCents = (raw: string): number | null => {
  const match = AMOUNT_INPUT.exec(raw.trim())
  if (match === null) return null
  const [, whole, fraction = ''] = match
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}
