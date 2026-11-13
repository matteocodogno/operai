/**
 * The local rules of an entry (specs/029 T14; plan § Entries): the day, the duration, the note, and the
 * clock that says what today is. Pure: no database, no owner. The route that applies them is write.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { ID_MAX_LENGTH as LISTS_ID_MAX, isWellFormedId } from "../lists/idRule";
import { ID_MAX_LENGTH as LABELS_ID_MAX, satisfiesIdRule } from "../labels/idRule";
import { FIRST_DAY, NOTE_MAX_CODE_POINTS, countCodePoints, isBlank, isCalendarDay, isValidMinutes } from "./rules";
import { BUSINESS_ZONE, todayIn } from "./today";

describe("isCalendarDay (plan § Entries, 'A day'; AC-1.3)", () => {
  it("accepts a real calendar day from 2000-01-01 to 9999-12-31, leap days included", () => {
    for (const day of ["2000-01-01", "2000-02-29", "2024-02-29", "2026-11-13", "2026-12-31", "2400-02-29", "9999-12-31"]) {
      expect(isCalendarDay(day)).toBe(true);
    }
    expect(FIRST_DAY).toBe("2000-01-01");
  });

  it("refuses a day the calendar does not have, which a parser would roll over to another day", () => {
    // Bun reads `new Date("2026-02-30")` as 2026-03-02: these must not be stored as the day after.
    for (const day of ["2026-02-30", "2025-02-29", "2026-02-31", "2026-04-31", "2100-02-29", "2026-13-01", "2026-00-10", "2026-11-00", "2026-11-31"]) {
      expect(isCalendarDay(day)).toBe(false);
    }
  });

  it("refuses a day before 2000-01-01, the year-0 and year-0-99 forms Date.UTC would read as 19xx included", () => {
    for (const day of ["1999-12-31", "1999-01-01", "1026-11-13", "0226-11-13", "0100-01-01", "0050-01-01", "0000-01-01"]) {
      expect(isCalendarDay(day)).toBe(false);
    }
  });

  it("refuses anything that is not exactly YYYY-MM-DD in ASCII digits", () => {
    for (const day of [
      "",
      " ",
      "2026-2-01",
      "2026-11-1",
      "26-11-13",
      "20261113",
      "2026/11/13",
      "2026.11.13",
      "13.11.2026",
      "2026-11-13T00:00:00Z",
      "2026-11-13T00:00:00",
      "2026-11-13 ",
      " 2026-11-13",
      "2026-11-13\n",
      "\n2026-11-13",
      "+2026-11-13",
      "２０２６-１１-１３", // full-width digits
      "٢٠٢٦-١١-١٣", // Arabic-indic digits
      "2026-11-13\u0000",
      "9999-12-32",
      "10000-01-01",
      "+010000-01-01",
      "-000001-01-01",
      "x".repeat(10_000),
    ]) {
      expect(isCalendarDay(day)).toBe(false);
    }
  });
});

describe("isValidMinutes (AC-1.2)", () => {
  it("is true for exactly the 48 whole half-hours from 30 to 1440 minutes", () => {
    const valid: number[] = [];
    for (let minutes = -100; minutes <= 1600; minutes++) if (isValidMinutes(minutes)) valid.push(minutes);
    expect(valid).toEqual(Array.from({ length: 48 }, (_, i) => 30 * (i + 1)));
    expect(valid[0]).toBe(30);
    expect(valid.at(-1)).toBe(1440);
  });

  it("refuses a duration that is not a whole number, however close to a half-hour", () => {
    for (const minutes of [30.5, 29.999, 60.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -30]) {
      expect(isValidMinutes(minutes)).toBe(false);
    }
  });
});

describe("a note counts Unicode code points, as the database CHECK does (plan § Entries, 'Counting a note and a name')", () => {
  it("counts an emoji once, though it is two UTF-16 units", () => {
    expect(NOTE_MAX_CODE_POINTS).toBe(1000);
    expect(countCodePoints("😀")).toBe(1);
    expect(countCodePoints("😀".repeat(1000))).toBe(1000);
    expect("😀".repeat(1000).length).toBe(2000);
    expect(countCodePoints("a😀b")).toBe(3);
    expect(countCodePoints("")).toBe(0);
    expect(countCodePoints("é")).toBe(1);
  });
});

describe("a blank note is no note (plan § Entries, 'A blank note'; spec A7)", () => {
  it("is blank when trim leaves nothing: empty, spaces, tabs, line breaks, no-break spaces", () => {
    for (const note of ["", " ", "   ", " \n\t", "\r\n", " ", " ", "﻿", "　"]) expect(isBlank(note)).toBe(true);
  });

  it("is not blank when anything else is there, a zero-width space and a lone dot included", () => {
    for (const note of ["a", " a ", ".", "0", "​", "  text "]) expect(isBlank(note)).toBe(false);
  });
});

describe("todayIn (AC-1.3): today is a day in Europe/Zurich, not in UTC", () => {
  it("23:30Z on 2026-11-12 is already 2026-11-13 in Zurich (winter time, UTC+1)", () => {
    expect(BUSINESS_ZONE).toBe("Europe/Zurich");
    expect(todayIn("Europe/Zurich", new Date("2026-11-12T23:30:00Z"))).toBe("2026-11-13");
    expect(todayIn("UTC", new Date("2026-11-12T23:30:00Z"))).toBe("2026-11-12");
  });

  it("changes day at 23:00Z in winter and at 22:00Z in summer (UTC+2)", () => {
    expect(todayIn("Europe/Zurich", new Date("2026-11-12T22:59:59Z"))).toBe("2026-11-12");
    expect(todayIn("Europe/Zurich", new Date("2026-11-12T23:00:00Z"))).toBe("2026-11-13");
    expect(todayIn("Europe/Zurich", new Date("2026-07-12T21:59:59Z"))).toBe("2026-07-12");
    expect(todayIn("Europe/Zurich", new Date("2026-07-12T22:00:00Z"))).toBe("2026-07-13");
  });

  it("follows the daylight-saving changes of 2026 (29 March and 25 October)", () => {
    expect(todayIn("Europe/Zurich", new Date("2026-03-28T22:59:59Z"))).toBe("2026-03-28");
    expect(todayIn("Europe/Zurich", new Date("2026-03-28T23:00:00Z"))).toBe("2026-03-29");
    expect(todayIn("Europe/Zurich", new Date("2026-10-24T21:59:59Z"))).toBe("2026-10-24");
    expect(todayIn("Europe/Zurich", new Date("2026-10-24T22:00:00Z"))).toBe("2026-10-25");
  });

  it("gives a zero-padded YYYY-MM-DD that the day rule accepts", () => {
    const day = todayIn("Europe/Zurich", new Date("2026-01-05T10:00:00Z"));
    expect(day).toBe("2026-01-05");
    expect(isCalendarDay(day)).toBe(true);
  });

  it("defaults to the real clock", () => {
    expect(isCalendarDay(todayIn(BUSINESS_ZONE))).toBe(true);
  });
});

describe("the id rule has ONE implementation (T14; plan amendment 2026-11-13)", () => {
  it("is the same function and the same bound under src/lists and src/labels", () => {
    expect(satisfiesIdRule).toBe(isWellFormedId);
    expect(LABELS_ID_MAX).toBe(LISTS_ID_MAX);
    expect(LISTS_ID_MAX).toBe(64);
  });
});
