/**
 * Unit tests for the month window (T5, specs/20261118-refund-accounting-export;
 * AC-5.1, AC-5.5; the extra test "Month boundary in Europe/Zurich" of the plan).
 *
 * The month boundary is the Europe/Zurich calendar, not UTC: all instants below
 * are written in UTC with their Zurich wall-clock time next to them.
 */

import { describe, expect, it } from "bun:test";
import {
  currentMonth,
  displayWindow,
  fetchableMonths,
  FX_FETCH_GRACE_DAYS,
  FX_FIRST_MONTH,
  isFetchableMonth,
  isMonthKey,
  lastCompletedMonth,
  lastFetchableMonth,
} from "./months";

const at = (iso: string) => new Date(iso);

describe("constants", () => {
  it("the grace period is 5 days and the first month is 2026-01", () => {
    expect(FX_FETCH_GRACE_DAYS).toBe(5);
    expect(FX_FIRST_MONTH).toBe("2026-01");
  });
});

describe("the grace boundary is day 5 in Europe/Zurich, not UTC (CET, winter)", () => {
  it("2026-11-04T23:30Z = 2026-11-05 00:30 Zurich: October is fetchable", () => {
    expect(lastFetchableMonth(at("2026-11-04T23:30:00Z"))).toBe("2026-10");
    expect(isFetchableMonth("2026-10", at("2026-11-04T23:30:00Z"))).toBe(true);
  });

  it("2026-11-04T22:30Z = 2026-11-04 23:30 Zurich (day 4): October is NOT fetchable yet", () => {
    expect(lastFetchableMonth(at("2026-11-04T22:30:00Z"))).toBe("2026-09");
    expect(isFetchableMonth("2026-10", at("2026-11-04T22:30:00Z"))).toBe(false);
    expect(isFetchableMonth("2026-09", at("2026-11-04T22:30:00Z"))).toBe(true);
  });

  it("the exact instant: 2026-11-04T23:00:00Z (Zurich midnight) flips, one millisecond earlier does not", () => {
    expect(lastFetchableMonth(at("2026-11-04T22:59:59.999Z"))).toBe("2026-09");
    expect(lastFetchableMonth(at("2026-11-04T23:00:00.000Z"))).toBe("2026-10");
  });
});

describe("the grace boundary in CEST (summer, UTC+2)", () => {
  it("2026-07-04T22:00Z = 2026-07-05 00:00 Zurich: June becomes fetchable; 21:59:59.999Z does not", () => {
    expect(lastFetchableMonth(at("2026-07-04T21:59:59.999Z"))).toBe("2026-05");
    expect(lastFetchableMonth(at("2026-07-04T22:00:00.000Z"))).toBe("2026-06");
  });
});

describe("around the CET/CEST switches (2026-03-29 and 2026-10-25) nothing moves", () => {
  it("the day stays 29 March across the spring switch (01:00Z): same answers before and after", () => {
    const before = at("2026-03-29T00:30:00Z"); // 01:30 CET
    const after = at("2026-03-29T01:30:00Z"); // 03:30 CEST
    for (const now of [before, after]) {
      expect(currentMonth(now)).toBe("2026-03");
      expect(lastCompletedMonth(now)).toBe("2026-02");
      expect(lastFetchableMonth(now)).toBe("2026-02");
    }
  });

  it("the day stays 25 October across the autumn switch (01:00Z): same answers before and after", () => {
    const before = at("2026-10-25T00:30:00Z"); // 02:30 CEST
    const after = at("2026-10-25T01:30:00Z"); // 02:30 CET
    for (const now of [before, after]) {
      expect(currentMonth(now)).toBe("2026-10");
      expect(lastCompletedMonth(now)).toBe("2026-09");
      expect(lastFetchableMonth(now)).toBe("2026-09");
    }
  });

  it("the month boundary follows the local calendar on the switch weekends too", () => {
    // 2026-03-31T22:00Z is 2026-04-01 00:00 CEST: April has begun, March is completed but not fetchable.
    expect(currentMonth(at("2026-03-31T21:59:59Z"))).toBe("2026-03");
    expect(currentMonth(at("2026-03-31T22:00:00Z"))).toBe("2026-04");
    // 2026-10-31T23:00Z is 2026-11-01 00:00 CET.
    expect(currentMonth(at("2026-10-31T22:59:59Z"))).toBe("2026-10");
    expect(currentMonth(at("2026-10-31T23:00:00Z"))).toBe("2026-11");
  });
});

describe("the current month is never fetchable", () => {
  it("not on its first day, not on day 5, not on its last day", () => {
    for (const iso of ["2026-11-01T00:30:00Z", "2026-11-05T12:00:00Z", "2026-11-30T22:59:00Z"]) {
      expect(isFetchableMonth("2026-11", at(iso))).toBe(false);
      expect(fetchableMonths(at(iso))).not.toContain("2026-11");
    }
  });

  it("nor is any future month", () => {
    expect(isFetchableMonth("2026-12", at("2026-11-18T12:00:00Z"))).toBe(false);
    expect(isFetchableMonth("2027-05", at("2026-11-18T12:00:00Z"))).toBe(false);
  });

  it("a completed month is not fetchable before the grace day, and is from then on", () => {
    expect(isFetchableMonth("2026-10", at("2026-11-01T12:00:00Z"))).toBe(false);
    expect(isFetchableMonth("2026-10", at("2026-11-04T12:00:00Z"))).toBe(false);
    expect(isFetchableMonth("2026-10", at("2026-11-05T12:00:00Z"))).toBe(true);
    expect(isFetchableMonth("2026-10", at("2026-11-30T12:00:00Z"))).toBe(true);
  });
});

describe("year boundary", () => {
  it("2027-01-05 Zurich: December 2026 fetchable; 2027-01-04 23:59 Zurich: not yet (November is)", () => {
    expect(lastFetchableMonth(at("2027-01-04T22:59:00Z"))).toBe("2026-11");
    expect(lastFetchableMonth(at("2027-01-04T23:00:00Z"))).toBe("2026-12");
  });

  it("New Year's Eve 23:30 UTC is already 2027 in Zurich: the current month is 2027-01", () => {
    expect(currentMonth(at("2026-12-31T23:30:00Z"))).toBe("2027-01");
    expect(lastCompletedMonth(at("2026-12-31T23:30:00Z"))).toBe("2026-12");
    expect(lastFetchableMonth(at("2026-12-31T23:30:00Z"))).toBe("2026-11");
  });

  it("January: the last completed month is December of the year before", () => {
    expect(lastCompletedMonth(at("2027-01-10T12:00:00Z"))).toBe("2026-12");
  });
});

describe("fetchableMonths: the default fetch set", () => {
  it("lists every fetchable month from 2026-01, newest first", () => {
    expect(fetchableMonths(at("2026-11-18T12:00:00Z"))).toEqual([
      "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01",
    ]);
  });

  it("before day 5 the newest completed month is not in it", () => {
    expect(fetchableMonths(at("2026-11-03T12:00:00Z"))[0]).toBe("2026-09");
  });

  it("is empty until January 2026 has become fetchable (2026-02-05)", () => {
    expect(fetchableMonths(at("2026-01-20T12:00:00Z"))).toEqual([]);
    expect(fetchableMonths(at("2026-02-04T12:00:00Z"))).toEqual([]);
    expect(fetchableMonths(at("2026-02-05T12:00:00Z"))).toEqual(["2026-01"]);
  });

  it("is empty long before the feature", () => {
    expect(fetchableMonths(at("2020-06-15T12:00:00Z"))).toEqual([]);
  });

  it("an earlier month is fetchable by isFetchableMonth even though the default set starts at 2026-01", () => {
    expect(isFetchableMonth("2025-12", at("2026-11-18T12:00:00Z"))).toBe(true);
    expect(fetchableMonths(at("2026-11-18T12:00:00Z"))).not.toContain("2025-12");
  });
});

describe("displayWindow: completed months only, newest first (AC-5.2, AC-5.5)", () => {
  it("2026-11-18: 2026-10 down to 2026-01, and not the current month", () => {
    const window = displayWindow(at("2026-11-18T12:00:00Z"));
    expect(window).toEqual([
      "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01",
    ]);
    expect(window).not.toContain("2026-11");
  });

  it("lists a just-ended month from its first day, although it is not fetchable until day 5", () => {
    const now = at("2026-11-01T12:00:00Z");
    expect(displayWindow(now)[0]).toBe("2026-10");
    expect(fetchableMonths(now)[0]).toBe("2026-09");
  });

  it("adds an earlier month a non-CHF line needs, in order, once", () => {
    const window = displayWindow(at("2026-11-18T12:00:00Z"), ["2025-12", "2025-11", "2025-12"]);
    expect(window.slice(-3)).toEqual(["2026-01", "2025-12", "2025-11"]);
    expect(window.filter((m) => m === "2025-12")).toHaveLength(1);
  });

  it("a needed month already inside the window changes nothing", () => {
    const base = displayWindow(at("2026-11-18T12:00:00Z"));
    expect(displayWindow(at("2026-11-18T12:00:00Z"), ["2026-03", "2026-10"])).toEqual(base);
  });

  it("a needed month that is not completed (the current or a future one) is left out", () => {
    const base = displayWindow(at("2026-11-18T12:00:00Z"));
    expect(displayWindow(at("2026-11-18T12:00:00Z"), ["2026-11", "2026-12", "2027-03"])).toEqual(base);
  });

  it("accepts any iterable of needed months", () => {
    expect(displayWindow(at("2026-11-18T12:00:00Z"), new Set(["2025-10"])).at(-1)).toBe("2025-10");
  });

  it("is empty before any month of the window has completed", () => {
    expect(displayWindow(at("2026-01-20T12:00:00Z"))).toEqual([]);
    expect(displayWindow(at("2026-02-01T12:00:00Z"))).toEqual(["2026-01"]);
  });

  it("sorts across a year boundary: 2027-02-10 lists 2027-01, 2026-12 ... 2026-01", () => {
    const window = displayWindow(at("2027-02-10T12:00:00Z"));
    expect(window.slice(0, 3)).toEqual(["2027-01", "2026-12", "2026-11"]);
    expect(window.at(-1)).toBe("2026-01");
    expect(window).toHaveLength(13);
  });

  it("a malformed needed month is a programming error", () => {
    expect(() => displayWindow(at("2026-11-18T12:00:00Z"), ["2025-1"])).toThrow(RangeError);
    expect(() => displayWindow(at("2026-11-18T12:00:00Z"), ["nope"])).toThrow(RangeError);
  });
});

describe("input validation", () => {
  it("an invalid date is a programming error", () => {
    expect(() => lastFetchableMonth(new Date("nope"))).toThrow(RangeError);
    expect(() => fetchableMonths(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("isMonthKey accepts YYYY-MM only", () => {
    expect(isMonthKey("2026-03")).toBe(true);
    for (const bad of ["2026-3", "2026-13", "2026-00", "26-03", "2026-03-01", "", " 2026-03", null, undefined, 202603]) {
      expect(isMonthKey(bad)).toBe(false);
    }
  });

  it("isFetchableMonth throws on a malformed month rather than answering false", () => {
    expect(() => isFetchableMonth("2026-3", at("2026-11-18T12:00:00Z"))).toThrow(RangeError);
  });
});
