/**
 * The business day (specs/20261112-project-hours T3; AC-1.1, AC-1.9): the calendar day in Europe/Zurich, never UTC, the
 * rule of hours-api `src/entries/today.ts`. An hour package's current period is cut at this day, and a day on which
 * hours are recorded is a Zurich day, so the two must agree around midnight UTC.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { BUSINESS_ZONE, __setClockForTests, businessDay } from "./businessDay";

afterEach(() => __setClockForTests(null));

describe("businessDay", () => {
  it("is the Europe/Zurich calendar day", () => {
    expect(BUSINESS_ZONE).toBe("Europe/Zurich");
  });

  it("is already the next day at 23:30Z in winter (CET, UTC+1)", () => {
    expect(businessDay(new Date("2026-11-12T23:30:00Z"))).toBe("2026-11-13");
    expect(businessDay(new Date("2026-11-12T22:59:59Z"))).toBe("2026-11-12");
    expect(businessDay(new Date("2026-11-12T23:00:00Z"))).toBe("2026-11-13");
  });

  it("is already the next day from 22:00Z in summer (CEST, UTC+2)", () => {
    expect(businessDay(new Date("2026-07-12T21:59:59Z"))).toBe("2026-07-12");
    expect(businessDay(new Date("2026-07-12T22:00:00Z"))).toBe("2026-07-13");
  });

  it("follows the daylight-saving change, not a fixed offset", () => {
    // 2026-03-29 01:00Z is when Zurich moves from CET to CEST: before it midnight is 23:00Z, after it 22:00Z.
    expect(businessDay(new Date("2026-03-28T22:59:59Z"))).toBe("2026-03-28");
    expect(businessDay(new Date("2026-03-28T23:00:00Z"))).toBe("2026-03-29");
    expect(businessDay(new Date("2026-03-29T21:59:59Z"))).toBe("2026-03-29");
    expect(businessDay(new Date("2026-03-29T22:00:00Z"))).toBe("2026-03-30");
  });

  it("crosses a year end and a leap day on the Zurich calendar", () => {
    expect(businessDay(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
    expect(businessDay(new Date("2028-02-28T23:00:00Z"))).toBe("2028-02-29");
    expect(businessDay(new Date("2027-02-28T23:00:00Z"))).toBe("2027-03-01"); // no 29 February in 2027
  });

  it("reads the clock the process (or a test) runs when no instant is given", () => {
    __setClockForTests(() => new Date("2026-11-12T23:30:00Z"));
    expect(businessDay()).toBe("2026-11-13");
    __setClockForTests(null);
    expect(businessDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
