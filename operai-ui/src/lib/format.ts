import { resolveLocale } from './i18n'
import type { Locale } from './i18n'

/**
 * The suite's formatters (INC-26, INC-27): one way to show a date, a time, an
 * amount and a number, on `Intl`. Display only — APIs exchange ISO 8601 dates
 * and integer minor units (ADR-0025); never parse what these return.
 *
 *   formatDate('2026-10-31')            31.10.2026   (both languages)
 *   formatDateTime('2026-10-31T14:05Z') 31.10.2026 15:05
 *   formatDateLong('2026-10-31')        31 October 2026 / 31 ottobre 2026
 *   formatRelative(date)                3 hours ago / 3 ore fa (a week or older: formatDate)
 *   formatMoney(1234550, 'EUR')         EUR 12,345.50 / 12.345,50 EUR
 *   formatAmount(1234550)               12,345.50 / 12.345,50
 *   formatNumber(0.3, { style: 'percent' })
 *
 * Numeric dates are day.month.year in both languages, as Rimborsi and
 * Inventory already showed them (wellD works in Italy and Switzerland; a
 * slash date is ambiguous for anyone used to the US order). Numbers follow the
 * language: Italian uses a decimal comma and groups thousands with a dot
 * from five digits up (CLDR: 1234,50 but 12.345,50). A negative
 * value gets a real minus sign (U+2212), not a hyphen.
 */

const NUMBER_LOCALE: Record<Locale, string> = { en: 'en-GB', it: 'it-IT' }

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A Date for an ISO string; a date-only string is the calendar day, never shifted by the time zone. */
const toDate = (value: string | Date): Date => {
  if (value instanceof Date) return value
  const dateOnly = DATE_ONLY.exec(value)
  return dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(value)
}

const pad = (n: number) => String(n).padStart(2, '0')

const minus = (text: string) => text.replace(/^-|(?<=\s)-/, '−')

export function formatDate(value: string | Date): string {
  const date = toDate(value)
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`
}

export function formatDateTime(value: string | Date): string {
  const date = toDate(value)
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatDateLong(value: string | Date, locale: Locale = resolveLocale()): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale], { day: 'numeric', month: 'long', year: 'numeric' }).format(
    toDate(value),
  )
}

const RELATIVE_STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
]

/** "3 hours ago" / "3 ore fa"; anything a week or older is a plain date. */
export function formatRelative(value: string | Date, now: Date = new Date(), locale: Locale = resolveLocale()): string {
  let delta = (toDate(value).getTime() - now.getTime()) / 1000
  const format = new Intl.RelativeTimeFormat(NUMBER_LOCALE[locale], { numeric: 'auto' })
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(delta) < size) return format.format(Math.round(delta), unit)
    delta /= size
  }
  return formatDate(value)
}

const assertMinorUnits = (name: string, minor: number) => {
  if (!Number.isSafeInteger(minor)) throw new TypeError(`${name}: expected integer minor units, got ${minor}`)
}

/** An amount with its ISO currency code. `minor` is integer cents (ADR-0025). */
export function formatMoney(minor: number, currency: string, locale: Locale = resolveLocale()): string {
  assertMinorUnits('formatMoney', minor)
  return minus(
    new Intl.NumberFormat(NUMBER_LOCALE[locale], { style: 'currency', currency, currencyDisplay: 'code' }).format(
      minor / 100,
    ),
  ).replace(/[\u00a0\u202f]/g, ' ')
}

/** An amount without a currency, for a cell or field whose currency is shown beside it. */
export function formatAmount(minor: number, locale: Locale = resolveLocale()): string {
  assertMinorUnits('formatAmount', minor)
  return minus(
    new Intl.NumberFormat(NUMBER_LOCALE[locale], { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      minor / 100,
    ),
  )
}

/** Any other number: a count, a percentage (`{ style: 'percent' }`), a duration in days. */
export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = {},
  locale: Locale = resolveLocale(),
): string {
  return minus(new Intl.NumberFormat(NUMBER_LOCALE[locale], options).format(value))
}

export type DurationStyle = 'clock' | 'spoken'

type DurationFormatCtor = new (
  locale: string,
  options: { style: 'long'; secondsDisplay?: 'always' },
) => { format(duration: { hours: number; minutes: number; seconds: number }): string }

/**
 * A length of time given in milliseconds. Whole seconds only (the remainder is
 * dropped, as a clock does); a negative duration is shown as zero and a
 * non-finite one throws, like the money formatters.
 *
 *   formatDuration(3_723_000, { style: 'clock' })    01:02:03   (hours are never capped: 100:00:00)
 *   formatDuration(3_723_000, { style: 'spoken' })   1 hour, 2 minutes, 3 seconds / 1 ora, 2 minuti e 3 secondi
 *
 * `clock` is for a timer, a segment time or a citation; `spoken` is for an
 * `aria-label` or a sentence. Spoken uses `Intl.DurationFormat` where the
 * browser has it and the same words from `Intl.NumberFormat` units otherwise.
 */
export function formatDuration(
  ms: number,
  options: { style: DurationStyle },
  locale: Locale = resolveLocale(),
): string {
  if (!Number.isFinite(ms)) throw new TypeError(`formatDuration: expected a finite number of milliseconds, got ${ms}`)
  const total = Math.floor(Math.max(0, ms) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (options.style === 'clock') return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`

  const intlLocale = NUMBER_LOCALE[locale]
  const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatCtor }).DurationFormat
  if (DurationFormat) {
    // An all-zero duration formats as an empty string unless seconds are forced.
    const zero = total === 0
    return new DurationFormat(
      intlLocale,
      zero ? { style: 'long', secondsDisplay: 'always' } : { style: 'long' },
    ).format({
      hours,
      minutes,
      seconds,
    })
  }
  const parts: Array<[number, 'hour' | 'minute' | 'second']> = [
    [hours, 'hour'],
    [minutes, 'minute'],
    [seconds, 'second'],
  ]
  const words = parts
    .filter(([value, unit]) => value > 0 || (total === 0 && unit === 'second'))
    .map(([value, unit]) =>
      new Intl.NumberFormat(intlLocale, { style: 'unit', unit, unitDisplay: 'long' }).format(value),
    )
  return new Intl.ListFormat(intlLocale, { type: 'unit', style: 'long' }).format(words)
}
