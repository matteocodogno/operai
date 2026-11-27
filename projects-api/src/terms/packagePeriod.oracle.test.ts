/**
 * QE (specs/20261112-project-hours, AC-1.1, AC-1.2, AC-1.3, AC-1.9, A51): `packagePeriod` against an independent oracle.
 *
 * `packagePeriod.test.ts` pins hand-picked vectors. This file derives the expected period from the SPEC's rule with a different
 * implementation (JavaScript `Date` arithmetic in UTC, brute-force search for the period, a clamp written as "the month must not
 * overflow") over every start day of a leap cycle and every `today` for years after it, and checks the three properties the
 * spec states in words: each yearly period is 12 months from its start (AC-1.2), exactly one period holds every day from the
 * start on and consecutive days move between periods only at an anniversary (no gap, no overlap), and nothing is current
 * before the start (A51). A capacity package is `[start, expiry]` with `ended` only after the expiry (AC-1.3, AC-1.9).
 */
import { describe, expect, it } from "bun:test";
import { packagePeriod } from "./packagePeriod";

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const utc = (y: number, m0: number, d: number): Date => new Date(Date.UTC(y, m0, d));
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** The k-th anniversary of `start`: k years on, the 29th of February clamped to the 28th when the year has none. */
const anniversary = (start: string, k: number): string => {
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const candidate = utc(y + k, m - 1, d);
  return candidate.getUTCMonth() === m - 1 ? iso(candidate) : iso(utc(y + k, m, 0));
};

/** Brute force: the greatest k whose anniversary is on or before today. */
const oracleYearly = (start: string, today: string): { from: string; to: string } | null => {
  if (today < start) return null;
  let k = 0;
  while (anniversary(start, k + 1) <= today) k += 1;
  return { from: anniversary(start, k), to: addDays(anniversary(start, k + 1), -1) };
};

describe("packagePeriod against an independent oracle (AC-1.1, AC-1.2, A51)", () => {
  it("a yearly package: every start day of a leap cycle, every day for the following years, matches the oracle and has no gap or overlap", () => {
    let checked = 0;
    // 2023-01-01 .. 2024-12-31 covers a common year then a leap year, so 29 February starts and clamped anniversaries are in it.
    for (let s = utc(2023, 0, 1); s <= utc(2024, 11, 31); s = new Date(s.getTime() + 86_400_000)) {
      const start = iso(s);
      // The anniversary arithmetic is the same for any start: sample every day for six years, plus the days before the start.
      let previous: { from: string; to: string } | null = null;
      for (let t = new Date(s.getTime() - 3 * 86_400_000); iso(t) <= addDays(start, 6 * 366); t = new Date(t.getTime() + 86_400_000)) {
        const today = iso(t);
        const got = packagePeriod({ kind: "yearly", startDate: start, expiryDate: null }, today);
        const want = oracleYearly(start, today);
        if (want === null) {
          expect(got).toBeNull(); // A51: before the start no period is current
        } else {
          expect(got).toEqual({ ...want, ended: false });
          expect(got!.from <= today && today <= got!.to).toBe(true); // the period holds today
          if (previous !== null) {
            // consecutive days: the same period, or a move exactly at the boundary (previous ends the day before this one starts)
            const same = previous.from === got!.from && previous.to === got!.to;
            const moved = addDays(previous.to, 1) === got!.from && got!.from === today;
            expect(same || moved).toBe(true);
          }
          previous = { from: got!.from, to: got!.to };
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(300_000);
  });

  it("a yearly period is always a month-aligned 12 months: its end is the day before the next anniversary of the SAME start", () => {
    for (const start of ["2024-02-29", "2024-03-31", "2023-12-31", "2025-01-31", "2024-02-28"]) {
      for (let k = 0; k < 9; k += 1) {
        const from = anniversary(start, k);
        const period = packagePeriod({ kind: "yearly", startDate: start, expiryDate: null }, from);
        expect(period).toEqual({ from, to: addDays(anniversary(start, k + 1), -1), ended: false });
        // the day before an anniversary still belongs to the period that is ending
        if (k > 0) {
          expect(packagePeriod({ kind: "yearly", startDate: start, expiryDate: null }, addDays(from, -1))!.to).toBe(addDays(from, -1));
        }
      }
    }
  });

  it("a capacity package: [start, expiry], `ended` only the day AFTER the expiry, open-ended to today, null before the start (AC-1.3, AC-1.9, A51)", () => {
    for (const start of ["2026-01-01", "2024-02-29"]) {
      for (const span of [0, 1, 30, 400]) {
        const expiry = addDays(start, span);
        for (let n = -3; n <= span + 5; n += 1) {
          const today = addDays(start, n);
          const got = packagePeriod({ kind: "capacity", startDate: start, expiryDate: expiry }, today);
          if (n < 0) expect(got).toBeNull();
          else expect(got).toEqual({ from: start, to: expiry, ended: n > span });
        }
      }
      for (const n of [-1, 0, 1, 500]) {
        const today = addDays(start, n);
        const got = packagePeriod({ kind: "capacity", startDate: start, expiryDate: null }, today);
        if (n < 0) expect(got).toBeNull();
        else expect(got).toEqual({ from: start, to: today, ended: false });
      }
    }
  });
});
