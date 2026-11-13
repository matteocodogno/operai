/**
 * What "today" is (specs/029 T14; plan § Entries, AC-1.3): a day in `Europe/Zurich`, the business's own
 * calendar, never UTC. At 23:30Z on 12 November the people recording hours are already on the 13th, so a
 * `day` of the 13th is today and not "after today" (`future_day`).
 *
 * The clock is the one thing here that is outside the system: `todayIn` takes it as a parameter, and the
 * route reads it through `today()`, which a test can fix (`__setClockForTests`).
 */

/** The business's calendar (wellD operates in Italy and Switzerland, both Central European Time). */
export const BUSINESS_ZONE = "Europe/Zurich";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    // `formatToParts` and numeric parts, so the result does not depend on a locale's date pattern.
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The calendar day it is at `now` in `timeZone`, as `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const part = (type: "year" | "month" | "day"): string => {
    const found = formatterFor(timeZone)
      .formatToParts(now)
      .find((candidate) => candidate.type === type);
    if (found === undefined) throw new Error(`todayIn: no ${type} for ${timeZone}`);
    return found.value;
  };
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

let clock: () => Date = () => new Date();

/** Today in the business's calendar, on the clock the process (or a test) runs. */
export const today = (): string => todayIn(BUSINESS_ZONE, clock());

/** Test seam: `null` puts the real clock back. */
export function __setClockForTests(now: (() => Date) | null): void {
  clock = now ?? (() => new Date());
}
