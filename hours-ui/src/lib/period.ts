/**
 * period — the Period filter of My hours and Everyone's hours: the presets as `from`/`to`, and the
 * Custom range's rules (specs/029-time-tracking, AC-4.4; design S1 "Period").
 *
 * Everything is arithmetic on calendar days written `YYYY-MM-DD`, done in UTC on the date alone, so a
 * time zone or a daylight-saving change cannot move a boundary. "Today" is not read here: the caller
 * passes `todayZurich()` (the day hours-api itself uses for `future_day`), so the presets and the
 * server agree and a test can name the day.
 *
 * A preset is the whole calendar span (a week Monday to Sunday, a month, a year), not "up to today":
 * no entry can be dated after today (`future_day`), so the entries are the same, and the period shown in
 * Custom (and in the exported file's name) is the period the person chose. Every preset is at most 366
 * days, the longest span hours-api takes (plan § Entries); Custom is held to the same bound here so the
 * server's 400 is not how the person finds out.
 */

export const PERIODS = ['thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'thisYear', 'custom'] as const
export type Period = (typeof PERIODS)[number]
export type PresetPeriod = Exclude<Period, 'custom'>
export type DateRange = { from: string; to: string }

/** What is wrong with a Custom range, by field. */
export type RangeErrors = { from?: 'required'; to?: 'required' | 'before-from' | 'too-long' }

export const DEFAULT_PERIOD: Period = 'thisMonth'

/** The longest range the server accepts, counting both end days (plan § Entries: "span ≤ 366 days"). */
export const MAX_SPAN_DAYS = 366

const DAY_MS = 86_400_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Midnight UTC of a `YYYY-MM-DD`, or `null` when the text is not a day on the calendar (30 February). */
const dayOf = (text: string): number | null => {
  const parts = ISO_DATE.exec(text)
  if (!parts) return null
  const ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  return isoOf(ms) === text ? ms : null
}

const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The days of a range, both ends included (one day is a span of 1). Both dates must be valid. */
export const spanDays = (from: string, to: string): number => {
  const start = dayOf(from)
  const end = dayOf(to)
  if (start === null || end === null) throw new TypeError(`spanDays: expected two YYYY-MM-DD days, got ${from}, ${to}`)
  return Math.round((end - start) / DAY_MS) + 1
}

const rangeBetween = (start: number, end: number): DateRange => ({ from: isoOf(start), to: isoOf(end) })

/** A preset as `from`/`to`; `today` is a `YYYY-MM-DD` (hours-ui passes `todayZurich()`). */
export const presetRange = (period: PresetPeriod, today: string): DateRange => {
  const now = dayOf(today)
  if (now === null) throw new TypeError(`presetRange: expected a YYYY-MM-DD day, got ${today}`)
  const date = new Date(now)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  // Monday is 0: JavaScript counts Sunday as 0, so a Sunday is the last day of the week that began six days ago.
  const sinceMonday = (date.getUTCDay() + 6) % 7

  switch (period) {
    case 'thisWeek':
      return rangeBetween(now - sinceMonday * DAY_MS, now - sinceMonday * DAY_MS + 6 * DAY_MS)
    case 'lastWeek':
      return rangeBetween(now - (sinceMonday + 7) * DAY_MS, now - (sinceMonday + 1) * DAY_MS)
    case 'thisMonth':
      // Day 0 of the next month is the last day of this one.
      return rangeBetween(Date.UTC(year, month, 1), Date.UTC(year, month + 1, 0))
    case 'lastMonth':
      return rangeBetween(Date.UTC(year, month - 1, 1), Date.UTC(year, month, 0))
    case 'thisYear':
      return rangeBetween(Date.UTC(year, 0, 1), Date.UTC(year, 11, 31))
  }
}

/**
 * What is wrong with a typed range, by field; `{}` is a range that can be sent. A date that is empty or
 * not on the calendar is "required" (an `<input type="date">` holds '' until its date is complete).
 */
export const rangeErrors = (from: string, to: string): RangeErrors => {
  const start = dayOf(from)
  const end = dayOf(to)
  const errors: RangeErrors = {}
  if (start === null) errors.from = 'required'
  if (end === null) errors.to = 'required'
  if (start !== null && end !== null) {
    if (end < start) errors.to = 'before-from'
    else if (spanDays(from, to) > MAX_SPAN_DAYS) errors.to = 'too-long'
  }
  return errors
}

/**
 * The range a view sends, or `null` while there is none to send (a Custom range with an error). A preset
 * ignores `from` and `to`, which only Custom reads.
 */
export const rangeOf = (
  period: Period,
  from: string,
  to: string,
  today: string,
): { range: DateRange | null; errors: RangeErrors } => {
  if (period !== 'custom') return { range: presetRange(period, today), errors: {} }
  const errors = rangeErrors(from, to)
  return { range: Object.keys(errors).length === 0 ? { from, to } : null, errors }
}
