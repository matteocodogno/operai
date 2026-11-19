/**
 * The month boundary is Europe/Zurich's, in both halves of the year, against an
 * independent oracle (T19, specs/20261118-refund-accounting-export; AC-5.1, AC-5.5;
 * ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-...; plan § Test
 * strategy "Extra tests", row 1).
 *
 * `months.test.ts` pins the named instants of the plan. This file attacks the
 * property behind them: for EVERY instant of 2026 and 2027, `currentMonth`,
 * `lastCompletedMonth`, `lastFetchableMonth`, `isFetchableMonth`, `fetchableMonths`
 * and `displayWindow` agree with a second implementation that shares no code and
 * no library with `months.ts`: a table of the European summer-time rule (CEST,
 * UTC+2, from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday
 * of October; CET, UTC+1, otherwise) and plain integer arithmetic on UTC getters.
 * A fixed +1 offset, a UTC calendar, or the process's own time zone would each be
 * caught, on the hour that differs.
 *
 * Pure and DB-free.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  currentMonth,
  displayWindow,
  FX_FETCH_GRACE_DAYS,
  FX_FIRST_MONTH,
  fetchableMonths,
  isFetchableMonth,
  lastCompletedMonth,
  lastFetchableMonth,
} from "./months";

const HOUR = 3_600_000;
const MINUTE = 60_000;

// ─── The oracle ──────────────────────────────────────────────────────────────

/** The last Sunday of a month, as a day of month (EU rule). */
function lastSunday(year: number, monthIndex: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const weekday = new Date(Date.UTC(year, monthIndex, lastDay)).getUTCDay(); // 0 = Sunday
  return lastDay - weekday;
}

/** Hours Europe/Zurich is ahead of UTC at the instant `t`: 2 in summer time, 1 otherwise. */
function zurichOffsetHours(t: number): 1 | 2 {
  const year = new Date(t).getUTCFullYear();
  const summerStart = Date.UTC(year, 2, lastSunday(year, 2), 1); // 01:00 UTC, last Sunday of March
  const summerEnd = Date.UTC(year, 9, lastSunday(year, 9), 1); // 01:00 UTC, last Sunday of October
  return t >= summerStart && t < summerEnd ? 2 : 1;
}

/** The Zurich calendar date at `t`, by shifting the instant and reading UTC getters. */
function oracleDate(t: number): { year: number; month: number; day: number } {
  const shifted = new Date(t + zurichOffsetHours(t) * HOUR);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

const key = (year: number, month: number): string => `${year}-${String(month).padStart(2, "0")}`;
/** `monthsBack` months before (year, month). */
function back(year: number, month: number, monthsBack: number): string {
  const index = year * 12 + (month - 1) - monthsBack;
  return key(Math.floor(index / 12), (index % 12) + 1);
}

const oracle = (t: number) => {
  const { year, month, day } = oracleDate(t);
  return {
    current: key(year, month),
    lastCompleted: back(year, month, 1),
    lastFetchable: day >= FX_FETCH_GRACE_DAYS ? back(year, month, 1) : back(year, month, 2),
  };
};

/** Every month key from `from` to `to`, newest first (a second implementation of the range, by string keys). */
function range(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = to.split("-").map(Number) as [number, number];
  while (key(y, m) >= from) {
    out.push(key(y, m));
    m -= 1;
    if (m === 0) {
      y -= 1;
      m = 12;
    }
  }
  return out;
}

const nextMonth = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? key(y + 1, 1) : key(y, m + 1);
};

const START = Date.UTC(2026, 0, 1);
const END = Date.UTC(2028, 0, 1);

/** Checks every function of `months.ts` against the oracle at `t`. */
function expectAgrees(t: number): void {
  const now = new Date(t);
  const want = oracle(t);
  const label = `${now.toISOString()}`;
  if (currentMonth(now) !== want.current) throw new Error(`${label}: currentMonth ${currentMonth(now)} != ${want.current}`);
  if (lastCompletedMonth(now) !== want.lastCompleted) throw new Error(`${label}: lastCompletedMonth ${lastCompletedMonth(now)} != ${want.lastCompleted}`);
  if (lastFetchableMonth(now) !== want.lastFetchable) throw new Error(`${label}: lastFetchableMonth ${lastFetchableMonth(now)} != ${want.lastFetchable}`);
}

// ─── The oracle itself is sane ───────────────────────────────────────────────

describe("the oracle (a check on the check)", () => {
  it("knows the 2026 and 2027 switches: last Sunday of March and of October", () => {
    expect([lastSunday(2026, 2), lastSunday(2026, 9), lastSunday(2027, 2), lastSunday(2027, 9)]).toEqual([29, 25, 28, 31]);
    expect(zurichOffsetHours(Date.UTC(2026, 2, 29, 0, 59))).toBe(1);
    expect(zurichOffsetHours(Date.UTC(2026, 2, 29, 1, 0))).toBe(2);
    expect(zurichOffsetHours(Date.UTC(2026, 9, 25, 0, 59))).toBe(2);
    expect(zurichOffsetHours(Date.UTC(2026, 9, 25, 1, 0))).toBe(1);
    expect(zurichOffsetHours(Date.UTC(2026, 6, 1))).toBe(2);
    expect(zurichOffsetHours(Date.UTC(2026, 11, 1))).toBe(1);
  });
});

// ─── The sweep ───────────────────────────────────────────────────────────────

describe("every half hour of 2026 and 2027 agrees with the oracle", () => {
  it("currentMonth, lastCompletedMonth and lastFetchableMonth", () => {
    let points = 0;
    for (let t = START; t < END; t += 30 * MINUTE) {
      expectAgrees(t);
      points++;
    }
    expect(points).toBe(((END - START) / (30 * MINUTE)));
  });

  it("isFetchableMonth, fetchableMonths and displayWindow are consistent with them (hourly)", () => {
    for (let t = START; t < END; t += HOUR) {
      const now = new Date(t);
      const want = oracle(t);

      // The current month is never fetchable, and neither is anything after the newest fetchable one.
      expect(isFetchableMonth(want.current, now)).toBe(false);
      expect(isFetchableMonth(nextMonth(want.lastFetchable), now)).toBe(false);
      expect(isFetchableMonth(want.lastFetchable, now)).toBe(true);

      // The default fetch set is every fetchable month from the first one, newest first.
      expect(fetchableMonths(now)).toEqual(range(FX_FIRST_MONTH, want.lastFetchable));

      // The table lists completed months only, newest first, from the first one.
      expect(displayWindow(now)).toEqual(range(FX_FIRST_MONTH, want.lastCompleted));
    }
  });

  it("the set only ever grows by one month at a time, on day 5 at Zurich midnight, and never shrinks", () => {
    let previous = lastFetchableMonth(new Date(START));
    const changes: { at: string; to: string }[] = [];
    for (let t = START; t < END; t += 15 * MINUTE) {
      const now = lastFetchableMonth(new Date(t));
      expect(now >= previous).toBe(true);
      if (now !== previous) {
        expect(now).toBe(nextMonth(previous));
        changes.push({ at: new Date(t).toISOString(), to: now });
        previous = now;
      }
    }
    // 24 months in two years: one change per month, each exactly when day 5 begins in Zurich.
    expect(changes).toHaveLength(24);
    for (const change of changes) {
      const day5Midnight = Date.parse(change.at);
      expect(oracleDate(day5Midnight)).toMatchObject({ day: FX_FETCH_GRACE_DAYS });
      expect(oracleDate(day5Midnight - 15 * MINUTE).day).toBe(FX_FETCH_GRACE_DAYS - 1);
    }
  });
});

// ─── The exact instants, both sides of each boundary, in both halves of the year ──

/** The UTC instant at which Zurich's calendar reads `year-month-day 00:00`. */
function zurichMidnight(year: number, month: number, day: number): number {
  const asUtc = Date.UTC(year, month - 1, day);
  // A Zurich midnight is 1 or 2 hours before UTC midnight; pick the one the oracle confirms.
  for (const offset of [1, 2] as const) {
    const candidate = asUtc - offset * HOUR;
    if (zurichOffsetHours(candidate) === offset) return candidate;
  }
  throw new Error(`no Zurich midnight on ${year}-${month}-${day}`);
}

describe("the instants that matter, 1 ms either side", () => {
  const MONTHS = Array.from({ length: 24 }, (_, i) => ({ year: 2026 + Math.floor(i / 12), month: (i % 12) + 1 }));

  it("the first of every month flips currentMonth at Zurich midnight (CET in winter, CEST in summer)", () => {
    for (const { year, month } of MONTHS) {
      const midnight = zurichMidnight(year, month, 1);
      const before = new Date(midnight - 1);
      const at = new Date(midnight);
      expect(currentMonth(at)).toBe(key(year, month));
      expect(currentMonth(before)).toBe(back(year, month, 1));
      expect(lastCompletedMonth(at)).toBe(back(year, month, 1));
      expect(lastCompletedMonth(before)).toBe(back(year, month, 2));
    }
  });

  it("day 5 of every month makes the previous month fetchable at Zurich midnight, not at UTC midnight and not an hour off", () => {
    for (const { year, month } of MONTHS) {
      const midnight = zurichMidnight(year, month, FX_FETCH_GRACE_DAYS);
      const completed = back(year, month, 1);
      expect(isFetchableMonth(completed, new Date(midnight - 1))).toBe(false);
      expect(isFetchableMonth(completed, new Date(midnight))).toBe(true);
      expect(lastFetchableMonth(new Date(midnight))).toBe(completed);
      expect(lastFetchableMonth(new Date(midnight - 1))).toBe(back(year, month, 2));
    }
  });

  it("the two winters and two summers give different UTC instants for the same Zurich midnight, and both are right", () => {
    // Winter: 2026-11-05 00:00 CET = 2026-11-04T23:00Z. Summer: 2026-07-05 00:00 CEST = 2026-07-04T22:00Z.
    expect(new Date(zurichMidnight(2026, 11, 5)).toISOString()).toBe("2026-11-04T23:00:00.000Z");
    expect(new Date(zurichMidnight(2026, 7, 5)).toISOString()).toBe("2026-07-04T22:00:00.000Z");
    expect(isFetchableMonth("2026-10", new Date("2026-11-04T22:59:59.999Z"))).toBe(false);
    expect(isFetchableMonth("2026-10", new Date("2026-11-04T23:00:00.000Z"))).toBe(true);
    expect(isFetchableMonth("2026-06", new Date("2026-07-04T21:59:59.999Z"))).toBe(false);
    expect(isFetchableMonth("2026-06", new Date("2026-07-04T22:00:00.000Z"))).toBe(true);
  });

  it("the CET/CEST switches themselves: the weekend of 2026-03-29 and 2026-10-25 never moves a boundary", () => {
    // Spring forward at 01:00Z on 2026-03-29 (02:00 -> 03:00 local): still March everywhere around it.
    for (const iso of ["2026-03-29T00:30:00Z", "2026-03-29T01:00:00Z", "2026-03-29T01:30:00Z", "2026-03-29T12:00:00Z"]) {
      expect(currentMonth(new Date(iso))).toBe("2026-03");
      expect(lastFetchableMonth(new Date(iso))).toBe("2026-02"); // it is the 29th: February is fetchable (day >= 5), March is not
    }
    // Fall back at 01:00Z on 2026-10-25 (03:00 -> 02:00 local): the hour 02:00-03:00 happens twice, still October.
    for (const iso of ["2026-10-24T23:30:00Z", "2026-10-25T00:30:00Z", "2026-10-25T01:00:00Z", "2026-10-25T01:30:00Z", "2026-10-25T12:00:00Z"]) {
      expect(currentMonth(new Date(iso))).toBe("2026-10");
      expect(lastFetchableMonth(new Date(iso))).toBe("2026-09");
    }
  });

  it("the last evening of March and of October straddle the month at different UTC hours (the fixed-offset trap)", () => {
    // 2026-03-31 is CEST: 23:30 local = 21:30Z, midnight local = 22:00Z.
    expect(currentMonth(new Date("2026-03-31T21:59:59.999Z"))).toBe("2026-03");
    expect(currentMonth(new Date("2026-03-31T22:00:00.000Z"))).toBe("2026-04");
    // A fixed +1 would say April only from 23:00Z; the hour 22:00-23:00Z must already be April.
    expect(currentMonth(new Date("2026-03-31T22:30:00.000Z"))).toBe("2026-04");
    // 2026-10-31 is CET: midnight local = 23:00Z. A fixed +2 would say November from 22:00Z; it must still be October.
    expect(currentMonth(new Date("2026-10-31T22:30:00.000Z"))).toBe("2026-10");
    expect(currentMonth(new Date("2026-10-31T23:00:00.000Z"))).toBe("2026-11");
  });

  it("New Year: 2026-12-31T23:00Z is already 2027-01 in Zurich", () => {
    expect(currentMonth(new Date("2026-12-31T22:59:59.999Z"))).toBe("2026-12");
    expect(currentMonth(new Date("2026-12-31T23:00:00.000Z"))).toBe("2027-01");
    expect(lastCompletedMonth(new Date("2026-12-31T23:00:00.000Z"))).toBe("2026-12");
    expect(lastFetchableMonth(new Date("2026-12-31T23:00:00.000Z"))).toBe("2026-11");
  });
});

// ─── Not the process's time zone ─────────────────────────────────────────────

describe("the answer does not depend on the time zone of the process", () => {
  const original = process.env["TZ"];
  afterAll(() => {
    if (original === undefined) delete process.env["TZ"];
    else process.env["TZ"] = original;
  });

  for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Kiritimati", "Europe/London"]) {
    it(`TZ=${zone}`, () => {
      process.env["TZ"] = zone;
      // The switch must have taken effect, or this test would prove nothing.
      const probe = new Date("2026-07-04T22:00:00Z");
      const localHour = probe.getHours();
      expect(localHour).toBe({ UTC: 22, "America/Los_Angeles": 15, "Asia/Tokyo": 7, "Pacific/Kiritimati": 12, "Europe/London": 23 }[zone as string]!);
      for (let t = START; t < END; t += HOUR) expectAgrees(t);
    });
  }
});
