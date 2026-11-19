/**
 * month — the calendar arithmetic of the table view's month (specs/20261116-record-hours-in-place T22; plan § Components,
 * § The address of My hours; AC-5.25, AC-5.29): the days of a calendar month, the month holding a day, the month before
 * and after, and the month an address names.
 *
 * A month is written `YYYY-MM`, the key `formatMonth` and the address take. Like `week.ts` and `period.ts`, everything is
 * arithmetic on days written `YYYY-MM-DD`, done in UTC on the date alone, so a time zone or a daylight-saving change cannot
 * move a day, and "today" is never read here: the caller passes `todayZurich()`. A caller bug (a month that is not written
 * `YYYY-MM`, a fractional `n`, a `today` that is not a day) is a `TypeError`, as in `week.ts`; a month outside the calendar
 * the format can write (before the year 100, after 9999) is a `RangeError`.
 *
 * It does not import `week.ts` or `tablePeriod.ts`: `tablePeriod.ts` is built on both, and the week's own reading of an
 * address (`readWeekParam`) cannot depend on a module that depends on it.
 */
import { MIN_DAY } from './period'

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** The first month hours-api answers for: the month of `MIN_DAY`. The format is fixed-width, so months compare as text. */
export const MIN_MONTH = MIN_DAY.slice(0, 7)

const FIRST_YEAR = 100
const LAST_YEAR = 9999

const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Whether `text` is a day on the calendar (30 February is not), in a year the format writes. */
const isDay = (text: string): boolean => {
  const parts = ISO_DATE.exec(text)
  if (!parts) return false
  return isoOf(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))) === text
}

/** `[year, month 1–12]` of a `YYYY-MM`; a caller bug is a `TypeError`, a year the format cannot hold a `RangeError`. */
const partsOf = (name: string, month: string): [number, number] => {
  const parts = MONTH_KEY.exec(month)
  if (!parts) throw new TypeError(`${name}: expected a YYYY-MM month, got ${month}`)
  const year = Number(parts[1])
  if (year < FIRST_YEAR) throw new RangeError(`${name}: ${month} is outside the calendar`)
  return [year, Number(parts[2])]
}

const keyOf = (year: number, monthNumber: number): string =>
  `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`

/** The month holding `day` (AC-5.30). */
export const monthOf = (day: string): string => {
  if (!isDay(day)) throw new TypeError(`monthOf: expected a YYYY-MM-DD day, got ${day}`)
  return day.slice(0, 7)
}

/** The first day of `month`: the `from` of its read (AC-5.25). */
export const monthFirstDay = (month: string): string => {
  const [year, monthNumber] = partsOf('monthFirstDay', month)
  return `${keyOf(year, monthNumber)}-01`
}

/** The last day of `month`: the `to` of its read (AC-5.25). Day 0 of the next month is the last day of this one. */
export const monthLastDay = (month: string): string => {
  const [year, monthNumber] = partsOf('monthLastDay', month)
  return isoOf(Date.UTC(year, monthNumber, 0))
}

/** Every day of `month`, the 1st to the last, consecutive and ascending: 28 to 31 (AC-5.25). */
export const monthDays = (month: string): string[] => {
  const last = Number(monthLastDay(month).slice(8))
  return Array.from({ length: last }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`)
}

/**
 * The month `n` months after `month` (negative: before) by the calendar — the navigator's previous (-1) and next (+1)
 * month (AC-5.5), December to January and back across a year. A fractional `n` is a `TypeError`.
 */
export const shiftMonth = (month: string, n: number): string => {
  const [year, monthNumber] = partsOf('shiftMonth', month)
  if (!Number.isInteger(n)) throw new TypeError(`shiftMonth: expected a whole number of months, got ${n}`)
  const index = year * 12 + (monthNumber - 1) + n
  const shiftedYear = Math.floor(index / 12)
  if (shiftedYear < FIRST_YEAR || shiftedYear > LAST_YEAR)
    throw new RangeError(`shiftMonth: ${n} months from ${month} is outside the calendar`)
  return keyOf(shiftedYear, (index % 12) + 1)
}

/** `text` when it is a `YYYY-MM` with a month from 01 to 12, else `null`: what is a month before any rule about which. */
export const parseMonth = (text: unknown): string | null =>
  typeof text === 'string' && MONTH_KEY.test(text) ? text : null

/**
 * The month an address names (`?month=<YYYY-MM>`, AC-5.2): the current month (the one holding `today`, AC-5.4) when the
 * address names none or names anything that is not a month hours-api would answer for — text that is not a strict
 * `YYYY-MM`, a month before the first it takes (`MIN_MONTH`) — and when it names a month after the current one: the future
 * is not shown (AC-5.29). A pasted link never reaches the API as a request it would refuse. `today` is a `YYYY-MM-DD`
 * (hours-ui passes `todayZurich()`); one that is not a day is a caller bug, a `TypeError`.
 */
export const readMonthParam = (search: Record<string, unknown>, today: string): string => {
  const thisMonth = monthOf(today)
  const named = parseMonth(search['month'])
  return named !== null && named >= MIN_MONTH && named <= thisMonth ? named : thisMonth
}
