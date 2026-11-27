/**
 * The current period of an hour package (specs/20261112-project-hours T3; AC-1.1, AC-1.2, AC-1.3, AC-1.9, plan §
 * Consumption). Pure: the package and a Zurich business day in, `{ from, to, ended }` or `null` out. Dates are
 * `YYYY-MM-DD`, both ends inclusive, so a window of hours-api's `day BETWEEN from AND to` is the period.
 */
import { describe, expect, it } from "bun:test";
import { packagePeriod, type PackagePeriod } from "./packagePeriod";

const yearly = (startDate: string) => ({ kind: "yearly" as const, startDate, expiryDate: null });
const capacity = (startDate: string, expiryDate: string | null) => ({ kind: "capacity" as const, startDate, expiryDate });
const period = (from: string, to: string, ended = false): PackagePeriod => ({ from, to, ended });

describe("packagePeriod — yearly (AC-1.1, AC-1.2)", () => {
  it("is no period before the start date, and period 0 from the start date to the day before its first anniversary", () => {
    const pkg = yearly("2026-03-15");
    expect(packagePeriod(pkg, "2026-03-14")).toBeNull();
    expect(packagePeriod(pkg, "2026-03-15")).toEqual(period("2026-03-15", "2027-03-14"));
    expect(packagePeriod(pkg, "2026-09-01")).toEqual(period("2026-03-15", "2027-03-14"));
    expect(packagePeriod(pkg, "2027-03-14")).toEqual(period("2026-03-15", "2027-03-14")); // the last day of period 0
  });

  it("moves to period k on the anniversary, each period standing alone (nothing carried over, D28)", () => {
    const pkg = yearly("2026-03-15");
    expect(packagePeriod(pkg, "2027-03-15")).toEqual(period("2027-03-15", "2028-03-14")); // period 1 starts on the anniversary
    expect(packagePeriod(pkg, "2028-03-14")).toEqual(period("2027-03-15", "2028-03-14"));
    expect(packagePeriod(pkg, "2030-01-01")).toEqual(period("2029-03-15", "2030-03-14")); // period 3
    expect(packagePeriod(pkg, "2056-03-15")).toEqual(period("2056-03-15", "2057-03-14")); // period 30
  });

  it("ends a period on the last day of the month before the anniversary when it falls on the 1st", () => {
    expect(packagePeriod(yearly("2026-01-01"), "2026-06-01")).toEqual(period("2026-01-01", "2026-12-31"));
    expect(packagePeriod(yearly("2026-01-01"), "2027-01-01")).toEqual(period("2027-01-01", "2027-12-31"));
    expect(packagePeriod(yearly("2026-12-01"), "2027-05-05")).toEqual(period("2026-12-01", "2027-11-30"));
    expect(packagePeriod(yearly("2026-03-01"), "2026-03-01")).toEqual(period("2026-03-01", "2027-02-28"));
    expect(packagePeriod(yearly("2027-03-01"), "2027-03-01")).toEqual(period("2027-03-01", "2028-02-29")); // a leap February
  });

  it("falls an anniversary on 29 February on 28 February in a common year, and back on the 29th in a leap year", () => {
    const pkg = yearly("2024-02-29");
    expect(packagePeriod(pkg, "2024-02-29")).toEqual(period("2024-02-29", "2025-02-27"));
    expect(packagePeriod(pkg, "2025-02-27")).toEqual(period("2024-02-29", "2025-02-27"));
    expect(packagePeriod(pkg, "2025-02-28")).toEqual(period("2025-02-28", "2026-02-27")); // 28 Feb, there is no 29th in 2025
    expect(packagePeriod(pkg, "2026-02-27")).toEqual(period("2025-02-28", "2026-02-27"));
    expect(packagePeriod(pkg, "2026-02-28")).toEqual(period("2026-02-28", "2027-02-27"));
    expect(packagePeriod(pkg, "2027-02-28")).toEqual(period("2027-02-28", "2028-02-28")); // ends the day before 2028-02-29
    expect(packagePeriod(pkg, "2028-02-28")).toEqual(period("2027-02-28", "2028-02-28"));
    expect(packagePeriod(pkg, "2028-02-29")).toEqual(period("2028-02-29", "2029-02-27")); // the 29th again: counted from the START, not from 28 Feb
  });

  it("always has ended false: a yearly package does not expire (AC-1.9)", () => {
    expect(packagePeriod(yearly("2020-01-01"), "2026-11-27")?.ended).toBe(false);
    // The database refuses an expiry on a yearly package (terms_hour_package_expiry_capacity_only); were one given, it is not read.
    expect(packagePeriod({ kind: "yearly", startDate: "2026-03-15", expiryDate: "2027-01-01" }, "2030-01-01")).toEqual(
      period("2029-03-15", "2030-03-14"),
    );
  });

  it("tiles the calendar: every day is inside its period and a period starts the day after the previous one ended", () => {
    // Two leap cycles from a 29 February start, a 1 March start, and a 31 December start.
    for (const start of ["2024-02-29", "2026-03-01", "2025-12-31"]) {
      const pkg = yearly(start);
      let previous: PackagePeriod | null = null;
      for (let day = start; day <= "2036-03-02"; day = addDays(day, 1)) {
        const current = packagePeriod(pkg, day);
        expect(current).not.toBeNull();
        const { from, to } = current!;
        expect(from <= day && day <= to).toBe(true);
        if (previous !== null && previous.from !== from) {
          expect(from).toBe(addDays(previous.to, 1)); // no gap, no overlap
          expect(day).toBe(from); // and it changes exactly on its first day
        }
        previous = current;
      }
    }
  });
});

describe("packagePeriod — capacity (AC-1.3, AC-1.9)", () => {
  const pkg = capacity("2026-12-01", "2027-06-30");

  it("is no period before the start date", () => {
    expect(packagePeriod(pkg, "2026-11-30")).toBeNull();
    expect(packagePeriod(capacity("2026-12-01", null), "2026-11-30")).toBeNull();
  });

  it("with an expiry is the start date to the expiry, not ended up to and including the expiry day", () => {
    expect(packagePeriod(pkg, "2026-12-01")).toEqual(period("2026-12-01", "2027-06-30"));
    expect(packagePeriod(pkg, "2027-03-01")).toEqual(period("2026-12-01", "2027-06-30"));
    expect(packagePeriod(pkg, "2027-06-30")).toEqual(period("2026-12-01", "2027-06-30")); // the expiry day itself is still in
  });

  it("after the expiry stays the same period, the final figure, with ended true (D83)", () => {
    expect(packagePeriod(pkg, "2027-07-01")).toEqual(period("2026-12-01", "2027-06-30", true));
    expect(packagePeriod(pkg, "2035-01-01")).toEqual(period("2026-12-01", "2027-06-30", true));
  });

  it("without an expiry is the start date to today, open-ended, never ended", () => {
    const open = capacity("2026-12-01", null);
    expect(packagePeriod(open, "2026-12-01")).toEqual(period("2026-12-01", "2026-12-01")); // the start day: one day
    expect(packagePeriod(open, "2027-02-15")).toEqual(period("2026-12-01", "2027-02-15"));
    expect(packagePeriod(open, "2040-01-01")).toEqual(period("2026-12-01", "2040-01-01"));
  });

  it("an expiry on the start date is a one-day package, ended the day after", () => {
    const oneDay = capacity("2026-12-01", "2026-12-01");
    expect(packagePeriod(oneDay, "2026-12-01")).toEqual(period("2026-12-01", "2026-12-01"));
    expect(packagePeriod(oneDay, "2026-12-02")).toEqual(period("2026-12-01", "2026-12-01", true));
  });
});

/** `day` plus `count` days, on the calendar (UTC arithmetic: no daylight-saving hour to trip over). */
function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
