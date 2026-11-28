/**
 * The Zurich calendar of the hours notices (specs/20261112-meeting-hours T9; plan § Where meetings-api records a notice, A35, A37).
 *
 * hours-api puts a meeting on the calendar day of its start in `Europe/Zurich` (A35) and records nothing for a day that is
 * after today (A37). So when a meeting's day is still ahead, meetings-api queues a second delivery for the minute that day
 * begins to count: 00:01 Zurich. Both questions are answered here with the same `Intl` approach as hours-api's
 * `src/entries/today.ts` (a second copy, not a shared file: the two services share only their wire).
 *
 * Pure: no clock is read, every instant is a parameter.
 */

/** The business's calendar (wellD operates in Italy and Switzerland, both Central European Time). */
export const HOURS_ZONE = "Europe/Zurich";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: HOURS_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // `h23`: midnight is 00, never 24 (some engines print "24" for `hour12: false`).
  hourCycle: "h23",
});

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** What a wall clock in Zurich shows at `at`. Numeric parts, so the result never depends on a locale's date pattern. */
function wallClockAt(at: Date): WallClock {
  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = formatter.formatToParts(at).find((candidate) => candidate.type === type);
    if (found === undefined) throw new Error(`zurich: no ${type} for ${at.toISOString()}`);
    return Number(found.value);
  };
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour") % 24, minute: part("minute"), second: part("second") };
}

const two = (n: number): string => String(n).padStart(2, "0");

/** The calendar day it is in Zurich at `at`, as `YYYY-MM-DD`. */
export function zurichDay(at: Date): string {
  const wall = wallClockAt(at);
  return `${String(wall.year).padStart(4, "0")}-${two(wall.month)}-${two(wall.day)}`;
}

/** How far Zurich's wall clock is ahead of UTC at `at`, in milliseconds (the offset: +1 h in winter, +2 h in summer). */
function offsetAt(at: Date): number {
  const wall = wallClockAt(at);
  // The instant's own milliseconds are not on the wall clock's seconds: leave them out of the comparison.
  const whole = at.getTime() - at.getUTCMilliseconds();
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - whole;
}

/**
 * The instant at which Zurich's wall clock reads `day` (`YYYY-MM-DD`) plus `minutesAfterMidnight`.
 *
 * Two passes of "wall clock minus the offset in force": the first guess uses the offset at the wall time read as UTC, which can
 * be an hour off near a change, the second corrects it. Clocks change at 02:00 and 03:00 on a Sunday, so for the minutes just
 * after midnight, the only use here, the answer is exact and the offset is the one the day starts under.
 */
export function zurichInstant(day: string, minutesAfterMidnight: number): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, date, 0, minutesAfterMidnight);
  const first = wall - offsetAt(new Date(wall));
  return new Date(wall - offsetAt(new Date(first)));
}
