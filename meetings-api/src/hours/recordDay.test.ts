import { describe, expect, it } from "bun:test";
import { zurichDay, zurichInstant } from "./recordDay";

// The Zurich calendar of the hours notices (specs/20261112-meeting-hours T9; plan § Where meetings-api records a notice, A35,
// A37): the day a meeting falls on and the instant a future day starts to count. Pure: the clock is a parameter.

describe("zurichDay: the calendar day of an instant in Europe/Zurich (A35)", () => {
  it("is the next day when UTC is still on the previous one, in winter (23:30Z is 00:30 CET)", () => {
    expect(zurichDay(new Date("2026-01-14T23:30:00.000Z"))).toBe("2026-01-15");
  });

  it("is the next day when UTC is still on the previous one, in summer (22:30Z is 00:30 CEST)", () => {
    expect(zurichDay(new Date("2026-07-14T22:30:00.000Z"))).toBe("2026-07-15");
  });

  it("is the same day just before Zurich's midnight and flips exactly at it", () => {
    expect(zurichDay(new Date("2026-01-14T22:59:59.999Z"))).toBe("2026-01-14");
    expect(zurichDay(new Date("2026-01-14T23:00:00.000Z"))).toBe("2026-01-15");
    expect(zurichDay(new Date("2026-07-14T21:59:59.999Z"))).toBe("2026-07-14");
    expect(zurichDay(new Date("2026-07-14T22:00:00.000Z"))).toBe("2026-07-15");
  });
});

describe("zurichInstant: when a Zurich day plus some minutes is, as an instant (A37: 00:01)", () => {
  it("00:01 on a winter day is 23:01Z the evening before (CET, +01:00)", () => {
    expect(zurichInstant("2026-01-15", 1).toISOString()).toBe("2026-01-14T23:01:00.000Z");
  });

  it("00:01 on a summer day is 22:01Z the evening before (CEST, +02:00)", () => {
    expect(zurichInstant("2026-07-15", 1).toISOString()).toBe("2026-07-14T22:01:00.000Z");
  });

  it("00:01 on the day the clocks go forward (Sun 29 Mar 2026, switch at 02:00) is still CET: 23:01Z", () => {
    expect(zurichInstant("2026-03-29", 1).toISOString()).toBe("2026-03-28T23:01:00.000Z");
  });

  it("00:01 on the day the clocks go back (Sun 25 Oct 2026, switch at 03:00) is still CEST: 22:01Z", () => {
    expect(zurichInstant("2026-10-25", 1).toISOString()).toBe("2026-10-24T22:01:00.000Z");
  });

  it("round-trips: the day of that instant is the day asked for, and two minutes earlier is the day before", () => {
    for (const day of ["2026-01-15", "2026-03-29", "2026-07-15", "2026-10-25", "2026-12-31", "2027-03-28"]) {
      const at = zurichInstant(day, 1);
      expect(zurichDay(at)).toBe(day);
      expect(zurichDay(new Date(at.getTime() - 2 * 60_000))).not.toBe(day);
    }
  });
});
