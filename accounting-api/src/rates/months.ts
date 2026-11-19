/**
 * Pure, DB-free month arithmetic for the exchange-rate feature
 * (T5, specs/20261118-refund-accounting-export; AC-5.1, AC-5.5; ADR
 * 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-...;
 * plan "FX source rules").
 *
 * Two different questions, two different windows:
 *
 * - FETCHABLE: may Refund ask the federal source for this month's average?
 *   Only a COMPLETED month, and only from day {@link FX_FETCH_GRACE_DAYS} of
 *   the following month (Europe/Zurich). The source also answers for the
 *   current and for future months, so "it returned a value" is not evidence
 *   that the value is final (plan R2). The current month is never fetchable.
 * - DISPLAYED: which months does the Settings table list? Every COMPLETED month
 *   from {@link FX_FIRST_MONTH}, newest first, plus any earlier completed month
 *   a non-CHF line needs. A just-ended month is listed from its first day (as
 *   "missing") before it becomes fetchable on day 5.
 *
 * Months travel as `YYYY-MM` strings. "Now" is a parameter so the month
 * boundary, which depends on the Europe/Zurich calendar and not on UTC, is
 * testable; the Zurich date comes from `Intl`, so the CET/CEST switch is
 * handled by the platform's time-zone data and not by arithmetic here.
 */

/** The source's grace period: a month is fetchable from this day of the following month (Europe/Zurich). */
export const FX_FETCH_GRACE_DAYS = 5;

/** The first month of the default display window and of the default fetch (specs/20261118: the first month with exported lines). */
export const FX_FIRST_MONTH = "2026-01";

const ZURICH = "Europe/Zurich";
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

const zurichDateParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZURICH,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** `true` for a well-formed `YYYY-MM` month key. */
export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY.test(value);
}

/** Months since year 0, so that month arithmetic is integer arithmetic. */
function toIndex(month: string): number {
  const match = MONTH_KEY.exec(month);
  if (!match) throw new RangeError(`not a YYYY-MM month: ${JSON.stringify(month)}`);
  return Number(match[1]) * 12 + (Number(match[2]) - 1);
}

function fromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** The calendar date in Europe/Zurich at the instant `now`. */
function zurichToday(now: Date): { year: number; month: number; day: number } {
  if (Number.isNaN(now.getTime())) throw new RangeError("now is not a valid date");
  const parts = zurichDateParts.formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

/** The month containing `now` in Europe/Zurich. The one month that is never fetchable. */
export function currentMonth(now: Date): string {
  const { year, month } = zurichToday(now);
  return fromIndex(year * 12 + (month - 1));
}

/** The newest COMPLETED month: the month before the current one (Europe/Zurich). */
export function lastCompletedMonth(now: Date): string {
  const { year, month } = zurichToday(now);
  return fromIndex(year * 12 + (month - 1) - 1);
}

/**
 * The newest month Refund may fetch: the last completed month once day
 * {@link FX_FETCH_GRACE_DAYS} of the current month (Europe/Zurich) has begun,
 * else the month before that.
 */
export function lastFetchableMonth(now: Date): string {
  const { year, month, day } = zurichToday(now);
  const current = year * 12 + (month - 1);
  return fromIndex(day >= FX_FETCH_GRACE_DAYS ? current - 1 : current - 2);
}

/** May Refund ask the source for `month` at `now`? Never for the current or a future month. */
export function isFetchableMonth(month: string, now: Date): boolean {
  return toIndex(month) <= toIndex(lastFetchableMonth(now));
}

/**
 * The months the default fetch covers (`POST /exchange-rates/fetch` without a
 * body, `fetchDue`): every fetchable month from {@link FX_FIRST_MONTH} to
 * {@link lastFetchableMonth}, newest first. Empty before the first month has
 * become fetchable.
 */
export function fetchableMonths(now: Date): string[] {
  return monthRange(FX_FIRST_MONTH, lastFetchableMonth(now));
}

/**
 * The months the exchange-rate table lists (AC-5.2, AC-5.5): every COMPLETED
 * month from {@link FX_FIRST_MONTH}, plus each of `neededMonths` that is
 * completed (an earlier month a non-CHF line needs a rate for), newest first,
 * without duplicates. A needed month that is not completed yet (a line dated
 * this month) is left out: nothing can be fetched for it and the table lists
 * completed months only.
 *
 * @param neededMonths `YYYY-MM` keys; a malformed key is a programming error and throws
 */
export function displayWindow(now: Date, neededMonths: Iterable<string> = []): string[] {
  const newest = toIndex(lastCompletedMonth(now));
  const indexes = new Set<number>();
  for (let index = newest; index >= toIndex(FX_FIRST_MONTH); index--) indexes.add(index);
  for (const needed of neededMonths) {
    const index = toIndex(needed);
    if (index <= newest) indexes.add(index);
  }
  return [...indexes].sort((a, b) => b - a).map(fromIndex);
}

/** `from`..`to` inclusive, newest first; empty when `to` is before `from`. */
function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let index = toIndex(to); index >= toIndex(from); index--) out.push(fromIndex(index));
  return out;
}
