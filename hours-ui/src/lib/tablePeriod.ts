/**
 * tablePeriod — everything that differs by period in the table view of My hours (specs/20261116-record-hours-in-place
 * T18; plan § `TablePeriod`, decisions 8 and 9; AC-5.3, AC-5.4, AC-5.5): the days a period reads and draws, the period
 * holding a day, the current one, the previous and the next, and the day the date field shows. The fold (`tableGrid`),
 * the card (`TableView`), the cell dialog and the page take a `TablePeriod` and know nothing else about how one kind
 * differs from another.
 *
 * The union has two members, the week (T18) and the month (T22: AC-5.25–5.29). The date field's rules are here too
 * (T23: AC-5.30, AC-5.31, R16): the days it offers (`pickBounds`) and the period a day typed or picked names
 * (`pickedPeriod`). The availability of the previous and the next period and the clamp to today (T20) say nothing a month
 * cannot say: each is a comparison of first days, which is how the month joins them.
 *
 * Like `week.ts` and `period.ts`, everything is arithmetic on days written `YYYY-MM-DD`, done in UTC on the date alone,
 * so a time zone or a daylight-saving change cannot move a day, and "today" is never read here: the caller passes
 * `todayZurich()`. A caller bug (a `monday` that is not a Monday, a `today` that is not a day, a fractional `n`) is a
 * `TypeError`, as in `week.ts`.
 */
import { MIN_DAY } from './period'
import { monthDays, monthFirstDay, monthLastDay, monthOf, shiftMonth } from './month'
import { mondayOf, shiftWeek, weekDays } from './week'

export type TablePeriodKind = 'week' | 'month'

/**
 * What the table view shows: a week, by its Monday (`YYYY-MM-DD`, always a Monday), or a calendar month (`YYYY-MM`,
 * the key `formatMonth` and the address take).
 */
export type TablePeriod = { kind: 'week'; monday: string } | { kind: 'month'; month: string }

/**
 * The days of the period, consecutive and ascending: seven for a week, Monday first (AC-5.3), 28 to 31 for a month, the
 * 1st to the last (AC-5.25).
 */
export const daysOf = (period: TablePeriod): string[] =>
  period.kind === 'week' ? weekDays(period.monday) : monthDays(period.month)

/** The period's first day: what a read asks `from` (AC-5.4). */
export const firstDayOf = (period: TablePeriod): string =>
  period.kind === 'week' ? weekDays(period.monday)[0]! : monthFirstDay(period.month)

/** The period's last day: what a read asks `to` (AC-5.4). */
export const lastDayOf = (period: TablePeriod): string =>
  period.kind === 'week' ? weekDays(period.monday)[6]! : monthLastDay(period.month)

/**
 * One key for a period, `week:<Monday>` or `month:<YYYY-MM>`: what the card remembers a sideways scroll position under
 * (design G18). Never shown. A period that is not one is a `TypeError`, as every function here says.
 */
export const periodKey = (period: TablePeriod): string => {
  firstDayOf(period)
  return period.kind === 'week' ? `week:${period.monday}` : `month:${period.month}`
}

/** The period of `kind` that holds `day`, whichever day of it that is (AC-5.30). */
export const holding = (kind: TablePeriodKind, day: string): TablePeriod =>
  kind === 'week' ? { kind: 'week', monday: mondayOf(day) } : { kind: 'month', month: monthOf(day) }

/** The period of `kind` holding today: where My hours opens (AC-5.4) and what "This week" returns to (AC-5.5). */
export const current = (kind: TablePeriodKind, today: string): TablePeriod => holding(kind, today)

/** Whether `period` is the one holding today. */
export const isCurrent = (period: TablePeriod, today: string): boolean =>
  firstDayOf(period) === firstDayOf(current(period.kind, today))

/**
 * The period `n` whole periods after `period` (negative: before): the navigator's previous (-1) and next (+1) (AC-5.5).
 * A week is `n` times seven days, a month `n` calendar months (December to January and back). A period outside the
 * calendar the format can write is a `RangeError`, as `shiftWeek` and `shiftMonth` say.
 */
export const shift = (period: TablePeriod, n: number): TablePeriod =>
  period.kind === 'week'
    ? { kind: 'week', monday: shiftWeek(period.monday, n) }
    : { kind: 'month', month: shiftMonth(period.month, n) }

/**
 * The day the date field shows for `period` (AC-5.30): today while the period holds it, else the period's first day. It
 * is what the address says, never what was just picked, so the field keeps no state of its own.
 */
export const referenceDay = (period: TablePeriod, today: string): string =>
  isCurrent(period, today) ? today : firstDayOf(period)

/**
 * Whether the period after `period` can be shown: only while `period` is before the current one (AC-5.5, AC-5.28). The
 * future is not browsed, so the navigator's Next is unavailable on the current period and nothing asks for one after it.
 */
export const hasNext = (period: TablePeriod, today: string): boolean =>
  firstDayOf(period) < firstDayOf(current(period.kind, today))

/**
 * Whether the period before `period` can be shown: while it begins on or after `MIN_DAY`, the first day hours-api answers
 * for (plan decision 12). A defensive rule no AC asks for: the navigator never writes an address the reader would refuse.
 */
export const hasPrevious = (period: TablePeriod): boolean => firstDayOf(shift(period, -1)) >= MIN_DAY

/**
 * `period`, or the current period of its kind when it is after it (AC-5.29): an address naming the future shows the
 * present, with Next unavailable. The same rule `readWeekParam` applies to a `week` in an address, for a period that is
 * already made.
 */
export const clamp = (period: TablePeriod, today: string): TablePeriod => {
  const now = current(period.kind, today)
  return firstDayOf(period) > firstDayOf(now) ? now : period
}

/** Whether any of the seven days of the week that begins on `monday` is in `month`: the first day on or before its last, the last on or after its first. */
const weekTouches = (monday: string, month: string): boolean =>
  monday <= monthLastDay(month) && weekDays(monday)[6]! >= monthFirstDay(month)

/**
 * `period` as `kind` — what the Period switch asks for, keeping the time in view (AC-5.26, AC-5.27; ledger D25, D26).
 *
 * - **Week to month** (AC-5.26, D25): the current month when the week is the current week, also when it straddles two months
 *   (Monday 30 November – Sunday 6 December 2026 on 2 December is December: the month holding today); otherwise the month
 *   holding the week's Monday. Never a month after the current one.
 * - **Month to week** (AC-5.27, D26), in this order: the week the month was reached from (`left`, the address's `week`: a
 *   Monday) when any of its seven days is in the month; else the current week when any of its days is; else the first
 *   week whose Monday is in the month (November 2026, whose 1st is a Sunday: Monday 2 November, not Monday 26 October).
 *   A week left that is after the current week is not the week left (the future is not shown, AC-5.29); with none left
 *   the current week stands for it. So week, month, week lands on the week left, a past one included.
 * - The kind already shown: `period` itself.
 *
 * A caller bug (a `left` that is not a Monday, a period that is not one, a `today` that is not a day) is a `TypeError`.
 */
export const switchTo = (period: TablePeriod, kind: TablePeriodKind, today: string, left?: string): TablePeriod => {
  if (period.kind === kind) return period
  if (period.kind === 'week') {
    return isCurrent(period, today) ? current('month', today) : { kind: 'month', month: monthOf(period.monday) }
  }
  const thisMonday = mondayOf(today)
  // The week left must be a real Monday even when it is not used; a future one is dropped, as the address would drop it.
  const leftMonday = left === undefined ? undefined : (weekDays(left), left)
  if (leftMonday !== undefined && leftMonday <= thisMonday && weekTouches(leftMonday, period.month))
    return { kind: 'week', monday: leftMonday }
  if (weekTouches(thisMonday, period.month)) return { kind: 'week', monday: thisMonday }
  const first = monthFirstDay(period.month)
  const firstMonday = mondayOf(first)
  return { kind: 'week', monday: firstMonday === first ? first : shiftWeek(firstMonday, 1) }
}

/**
 * The first and the last day the period date field offers (AC-5.31, D20): `max` is today, never a day after it, and `min` is
 * the first day of the earliest period the address accepts, so no day the field offers names a period that begins before
 * `MIN_DAY` and would be shown as the current one instead. `MIN_DAY` is a Saturday: the first week a pick can name begins on
 * the Monday after it, `2000-01-03`, while the first month begins on `2000-01-01` itself. A `today` that is not a day is a
 * caller bug, a `TypeError`.
 */
export const pickBounds = (kind: TablePeriodKind, today: string): { min: string; max: string } => {
  monthOf(today)
  if (kind === 'month') return { min: monthFirstDay(monthOf(MIN_DAY)), max: today }
  const monday = mondayOf(MIN_DAY)
  return { min: monday >= MIN_DAY ? monday : shiftWeek(monday, 1), max: today }
}

const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/

/** Whether `text` is a day on the calendar, written `YYYY-MM-DD` with a four-digit year (30 February is not). */
const isCalendarDay = (text: string): boolean => {
  const parts = DAY_TEXT.exec(text)
  if (!parts) return false
  const ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  return new Date(ms).toISOString().slice(0, 10) === text
}

/**
 * The period of `kind` that the date field's text asks for, or `null` when it asks for none (AC-5.30, AC-5.31; R16): only a
 * complete day within `pickBounds` names a period. A native date input holds `''` until its date is complete, and typed digit
 * by digit it passes through days of no use — the years 0002, 0020, 0202, a year of five or six digits — which are all
 * outside the bounds, so nothing names a period until the person has a day worth showing. A day after today, a day before
 * the first period and text that is not a day name nothing, and none of them throws. Whether the period named is the one
 * already shown is for the caller to say.
 */
export const pickedPeriod = (kind: TablePeriodKind, text: string, today: string): TablePeriod | null => {
  const { min, max } = pickBounds(kind, today)
  if (!isCalendarDay(text) || text < min || text > max) return null
  return holding(kind, text)
}
