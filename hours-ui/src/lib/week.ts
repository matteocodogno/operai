/**
 * week — the calendar arithmetic of the Week view of My hours (specs/20261116-record-hours-in-place T8; AC-5.3,
 * AC-5.4, AC-5.5; plan § Components, § My hours' address): the seven days of a week, the Monday of the week
 * holding a day, the week an address names, and the previous and next week.
 *
 * Weeks run Monday to Sunday, all seven days shown (WA1). Like `period.ts`, everything is arithmetic on
 * calendar days written `YYYY-MM-DD`, done in UTC on the date alone, so a time zone or a daylight-saving
 * change cannot move a day, and "today" is never read here: the caller passes `todayZurich()` (the day
 * hours-api itself uses for `future_day`), so a test can name the day.
 */
import { MIN_DAY } from './period'

const DAY_MS = 86_400_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Midnight UTC of a `YYYY-MM-DD`, or `null` when the text is not a day on the calendar (30 February). */
const dayOf = (text: string): number | null => {
  const parts = ISO_DATE.exec(text)
  if (!parts) return null
  const ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  return isoOf(ms) === text ? ms : null
}

const requireDay = (name: string, text: string): number => {
  const ms = dayOf(text)
  if (ms === null) throw new TypeError(`${name}: expected a YYYY-MM-DD day, got ${text}`)
  return ms
}

/** The day `days` after `ms`, as text; `null` outside the calendar the format writes (years 100 to 9999). */
const addDays = (ms: number, days: number): string | null => {
  const text = isoOf(ms + days * DAY_MS)
  return dayOf(text) === null ? null : text
}

/** Monday is 0: JavaScript counts Sunday as 0, so a Sunday is the last day of the week that began six days ago. */
const sinceMonday = (ms: number): number => (new Date(ms).getUTCDay() + 6) % 7

/** The Monday of the week holding `day` (a Monday is its own). */
export const mondayOf = (day: string): string => {
  const ms = requireDay('mondayOf', day)
  return isoOf(ms - sinceMonday(ms) * DAY_MS)
}

const requireMonday = (name: string, monday: string): number => {
  const ms = requireDay(name, monday)
  if (sinceMonday(ms) !== 0) throw new TypeError(`${name}: expected a Monday, got ${monday}`)
  return ms
}

/**
 * The Monday `weeks` weeks after `monday` (negative: before) — the navigator's previous (-1) and next (+1)
 * week (AC-5.5). A caller bug (not a Monday, not a whole number of weeks) is a `TypeError`; a week outside the
 * calendar the format can write (before the year 100, after 9999) is a `RangeError`.
 */
export const shiftWeek = (monday: string, weeks: number): string => {
  const start = requireMonday('shiftWeek', monday)
  if (!Number.isInteger(weeks)) throw new TypeError(`shiftWeek: expected a whole number of weeks, got ${weeks}`)
  const shifted = addDays(start, weeks * 7)
  if (shifted === null) throw new RangeError(`shiftWeek: ${weeks} weeks from ${monday} is outside the calendar`)
  return shifted
}

/**
 * The Monday of the week an address names (`?week=<day>`, AC-5.5): the week holding that day, whichever day of
 * the week it is; this week (the one holding `today`, AC-5.4) when the address names none or names anything
 * that is not a week hours-api would answer for — text, a day that is not on the calendar, a week that begins
 * before the first day it takes (`MIN_DAY`) or ends after the last year the format holds — and when it names a week
 * after this one: the future is not shown (AC-5.29). A pasted link never reaches the API as a request it would refuse
 * (the rule of `HoursFiltersState`). `today` is a `YYYY-MM-DD` (hours-ui passes `todayZurich()`); one that is not a
 * day is a caller bug, a `TypeError`.
 */
export const readWeekParam = (search: Record<string, unknown>, today: string): string => {
  const thisWeek = mondayOf(today)
  const named = search['week']
  if (typeof named !== 'string' || dayOf(named) === null) return thisWeek
  const monday = mondayOf(named)
  return monday >= MIN_DAY && monday <= thisWeek && addDays(dayOf(monday)!, 6) !== null ? monday : thisWeek
}

/** The seven days of the week that begins on `monday`, Monday first, Sunday last (AC-5.3). */
export const weekDays = (monday: string): string[] => {
  const start = requireMonday('weekDays', monday)
  return Array.from({ length: 7 }, (_, index) => isoOf(start + index * DAY_MS))
}
