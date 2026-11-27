/**
 * What "today" is for an hour package (specs/20261112-project-hours T3; plan § Components, AC-1.1, AC-1.9): a day in
 * `Europe/Zurich`, the business's own calendar, never UTC. It is the rule of hours-api `src/entries/today.ts` (a day on
 * which hours are recorded is a Zurich day), so a package's current period and the entries that fall in it agree around
 * midnight UTC: at 23:30Z on 12 November a person recording hours is already on the 13th, and so is the package.
 *
 * The clock is the one thing here that is outside the system: `businessDay` takes the instant as a parameter, and without
 * one reads the process's clock, which a test can fix (`__setClockForTests`).
 */

/** The business's calendar (wellD operates in Italy and Switzerland, both Central European Time). */
export const BUSINESS_ZONE = "Europe/Zurich";

// `formatToParts` and numeric parts, so the result does not depend on a locale's date pattern.
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

let clock: () => Date = () => new Date();

/** The calendar day it is at `now` (default: the process's clock) in Europe/Zurich, as `YYYY-MM-DD`. */
export function businessDay(now: Date = clock()): string {
  const parts = formatter.formatToParts(now);
  const part = (type: "year" | "month" | "day"): string => {
    const found = parts.find((candidate) => candidate.type === type);
    if (found === undefined) throw new Error(`businessDay: no ${type} for ${BUSINESS_ZONE}`);
    return found.value;
  };
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** Test seam: `null` puts the real clock back. */
export function __setClockForTests(now: (() => Date) | null): void {
  clock = now ?? (() => new Date());
}
