/**
 * The current period of an hour package (specs/20261112-project-hours T3; plan § Consumption, AC-1.1 – AC-1.3, AC-1.9, ledger
 * D28, D83, A51). Pure and derived on read, never stored (ADR 20260714-invitation-lifecycle-derived-expiry-state posture):
 * the package and a business day (`lib/businessDay.ts`, Europe/Zurich) in, the window hours are compared with out.
 *
 *   yearly    period *k* is `[start + 12k months, start + 12(k+1) months − 1 day]`, *k* the one holding `today`. Each period
 *             stands alone: hours not used in one are not carried into the next (D28). An anniversary on 29 February falls on
 *             28 February in a common year, always counted from the START date (so 2028 is on the 29th again), which keeps
 *             the periods contiguous: no day belongs to two, none to neither. Never `ended`.
 *   capacity  `[start, expiry]` up to and including the expiry day; after it the same window stays, the final figure, with
 *             `ended: true` (D83). Without an expiry it is open-ended: `[start, today]`.
 *   before the start date no period is current (A51): `null`; hours recorded before it count in no period.
 *
 * Dates are `YYYY-MM-DD` and both ends are inclusive, so hours-api's `day BETWEEN windowFrom AND windowTo` is the period. The
 * arithmetic is on the calendar's integers, with no `Date`: no timezone, no daylight-saving hour, no two-digit-year rule.
 * specs/20261112-project-alerts will raise alerts from the same function (plan R6), which is why it lives in projects-api.
 */

/** A package's current window, both ends inclusive; `ended` only for a capacity package past its expiry (D83). */
export interface PackagePeriod {
  readonly from: string;
  readonly to: string;
  readonly ended: boolean;
}

/** What the period reads of an hour package (the view's `hourPackage` less its hours). */
export interface PeriodPackage {
  readonly kind: "capacity" | "yearly";
  readonly startDate: string;
  readonly expiryDate: string | null;
}

interface Ymd {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const parse = (date: string): Ymd => {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
};

const format = ({ year, month, day }: Ymd): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (isLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/** The `k`-th anniversary of `start`: same month and day `k` years on, the 29th of February clamped to the month's last day. */
const anniversary = (start: Ymd, k: number): Ymd => {
  const year = start.year + k;
  return { year, month: start.month, day: Math.min(start.day, daysInMonth(year, start.month)) };
};

const dayBefore = ({ year, month, day }: Ymd): Ymd => {
  if (day > 1) return { year, month, day: day - 1 };
  const [previousYear, previousMonth] = month === 1 ? [year - 1, 12] : [year, month - 1];
  return { year: previousYear, month: previousMonth, day: daysInMonth(previousYear, previousMonth) };
};

/**
 * The period of `pkg` that `today` (a `YYYY-MM-DD` business day) is in, or `null` before its start date.
 * Dates compare as strings: `YYYY-MM-DD` sorts as the calendar does.
 */
export function packagePeriod(pkg: PeriodPackage, today: string): PackagePeriod | null {
  if (today < pkg.startDate) return null;

  if (pkg.kind === "capacity") {
    if (pkg.expiryDate === null) return { from: pkg.startDate, to: today, ended: false };
    return { from: pkg.startDate, to: pkg.expiryDate, ended: today > pkg.expiryDate };
  }

  // Yearly. The anniversaries are monotone in k and the k-th lies in the year start + k, so the period holding `today` is
  // the one that began in today's year (k = years elapsed) or, when that anniversary is still to come, the year before.
  const start = parse(pkg.startDate);
  const now = parse(today);
  const elapsed = now.year - start.year;
  const k = format(anniversary(start, elapsed)) <= today ? elapsed : elapsed - 1;
  return {
    from: format(anniversary(start, k)),
    to: format(dayBefore(anniversary(start, k + 1))),
    ended: false,
  };
}
