/**
 * `desiredEntries` — what a meeting's facts say its automatic entries should be (specs/20261112-meeting-hours T4;
 * plan § "Applying a notice" step 3, § Test strategy "Also: U vectors for A36 … and A35"). Pure: facts, the
 * release day and today go in, a map of person → { day, minutes } comes out. No database, no clock (today is
 * passed in), so every case here is a plain value.
 */
import { describe, expect, it, setSystemTime } from "bun:test";
import type { MeetingHoursFacts } from "../lib/meetingHoursWire";
import { desiredEntries } from "./desired";

const SINCE = "2026-11-24";
const TODAY = "2026-11-30";

/** A meeting on 25 November 2026 (10:00 in Zurich), one hour long, a creator and two other people. */
const facts = (over: Partial<MeetingHoursFacts> = {}): MeetingHoursFacts => ({
  startsAt: "2026-11-25T09:00:00.000Z",
  durationMs: 3_600_000,
  creatorId: "user-creator",
  participantIds: ["user-a", "user-b"],
  ...over,
});

const entries = (f: MeetingHoursFacts | null, since = SINCE, today = TODAY) => [...desiredEntries(f, since, today)];

describe("who gets an entry, on which day, for how long (AC-1.1, AC-1.2)", () => {
  it("the creator and each Operai participant get the meeting's day and its rounded duration", () => {
    expect(entries(facts())).toEqual([
      ["user-creator", { day: "2026-11-25", minutes: 60 }],
      ["user-a", { day: "2026-11-25", minutes: 60 }],
      ["user-b", { day: "2026-11-25", minutes: 60 }],
    ]);
  });

  it("a creator who is also listed as a participant gets one entry, not two (AC-1.2)", () => {
    const desired = entries(facts({ participantIds: ["user-a", "user-creator", "user-b"] }));
    expect(desired.map(([userId]) => userId)).toEqual(["user-creator", "user-a", "user-b"]);
  });

  it("a creator the participants do not list still gets theirs, alone if nobody else took part (AC-1.1, AC-3.3)", () => {
    expect(entries(facts({ participantIds: [] }))).toEqual([["user-creator", { day: "2026-11-25", minutes: 60 }]]);
  });
});

/** `h:mm:ss.mmm` as milliseconds, so a vector reads as the duration the plan names. */
const clock = (h: number, m: number, s = 0, ms = 0) => ((h * 60 + m) * 60 + s) * 1000 + ms;

describe("the duration, rounded to the nearest 30 minutes (A36; AC-1.1, AC-3.2)", () => {
  // The plan's vectors: a half step rounds UP, never below 30 minutes, never above 24 hours.
  it.each([
    ["1 ms: never below 30 minutes", 1, 30],
    ["14:59.999 is under a quarter hour and still 30: the floor", clock(0, 14, 59, 999), 30],
    ["44:59.999 rounds down to 30", clock(0, 44, 59, 999), 30],
    ["45:00 is half a step: rounds up to 1 h", clock(0, 45), 60],
    ["1:00:00 is exactly 1 h", clock(1, 0), 60],
    ["1:14:59 rounds down to 1 h", clock(1, 14, 59), 60],
    ["1:15:00 is half a step: rounds up to 1 h 30", clock(1, 15), 90],
    ["23:44:59 rounds down to 23 h 30", clock(23, 44, 59), 1410],
    ["23:45:00 rounds up to 24 h", clock(23, 45), 1440],
    ["30 h: never above 24 hours", clock(30, 0), 1440],
    ["the largest duration the wire takes", 2_147_483_647, 1440],
  ])("%s", (_label, durationMs, minutes) => {
    expect(desiredEntries(facts({ durationMs }), SINCE, TODAY).get("user-creator")?.minutes).toBe(minutes);
  });

  it("every duration lands on a whole half hour from 30 minutes to 24 hours, what the minutes CHECK holds", () => {
    for (let durationMs = 1; durationMs <= clock(25, 0); durationMs += 61_313) {
      const minutes = desiredEntries(facts({ durationMs }), SINCE, TODAY).get("user-creator")?.minutes;
      expect(minutes !== undefined && minutes >= 30 && minutes <= 1440 && minutes % 30 === 0, `${durationMs} ms`).toBe(true);
    }
  });
});

describe("the meeting's day is its calendar day in Europe/Zurich (A35; AC-1.1, AC-3.1)", () => {
  // `since` and `today` are far apart here, so only the day itself is under test.
  const dayOf = (startsAt: string) => desiredEntries(facts({ startsAt }), "2000-01-01", "9999-12-31").get("user-creator")?.day;

  it("23:30 UTC on a winter day (UTC+1) is already the next day in Zurich", () => {
    expect(dayOf("2026-11-24T23:30:00Z")).toBe("2026-11-25");
  });

  it("23:30 UTC on a summer day (UTC+2) is already the next day in Zurich", () => {
    expect(dayOf("2026-07-14T23:30:00Z")).toBe("2026-07-15");
  });

  it("the day turns at Zurich's midnight: 22:59:59 UTC in winter is 23:59:59, 23:00:00 is midnight", () => {
    expect(dayOf("2026-11-24T22:59:59Z")).toBe("2026-11-24");
    expect(dayOf("2026-11-24T23:00:00Z")).toBe("2026-11-25");
  });

  it("and at 22:00 UTC in summer", () => {
    expect(dayOf("2026-07-14T21:59:59Z")).toBe("2026-07-14");
    expect(dayOf("2026-07-14T22:00:00Z")).toBe("2026-07-15");
  });

  it("the offset a time is written with does not change the instant: 00:30+01:00 is 23:30 UTC the day before, 00:30 in Zurich", () => {
    expect(dayOf("2026-11-25T00:30:00+01:00")).toBe("2026-11-25");
    expect(dayOf("2026-11-25T00:30:00+05:00")).toBe("2026-11-24"); // 19:30 UTC, 20:30 in Zurich, the day before
    expect(dayOf("2026-11-24T20:00:00-05:00")).toBe("2026-11-25"); // 01:00 UTC, 02:00 in Zurich
  });

  it("follows the zone's own calendar through both clock changes, never a fixed offset", () => {
    // 29 March 2026: 02:00 CET becomes 03:00 CEST (01:00 UTC). 25 October 2026: 03:00 CEST becomes 02:00 CET (01:00 UTC).
    expect(dayOf("2026-03-28T22:59:59Z")).toBe("2026-03-28"); // CET, 23:59:59
    expect(dayOf("2026-03-28T23:00:00Z")).toBe("2026-03-29"); // CET midnight
    expect(dayOf("2026-03-29T21:59:59Z")).toBe("2026-03-29"); // CEST, 23:59:59
    expect(dayOf("2026-03-29T22:00:00Z")).toBe("2026-03-30"); // CEST midnight
    expect(dayOf("2026-10-24T22:30:00Z")).toBe("2026-10-25"); // CEST, 00:30
    expect(dayOf("2026-10-25T22:30:00Z")).toBe("2026-10-25"); // CET again, 23:30: still the 25th
    expect(dayOf("2026-10-25T23:00:00Z")).toBe("2026-10-26"); // CET midnight
  });
});

describe("the release day and today bound the meeting's day (AC-1.5, A37)", () => {
  const on = (startsAt: string, since: string, today: string) => entries(facts({ startsAt }), since, today).length;

  it("a meeting on the day before the release day records nothing (AC-1.5)", () => {
    expect(on("2026-11-23T10:00:00Z", "2026-11-24", "2026-11-30")).toBe(0);
  });

  it("a meeting on the release day itself records (the bound is inclusive)", () => {
    expect(on("2026-11-24T10:00:00Z", "2026-11-24", "2026-11-30")).toBe(3);
  });

  it("a meeting on a day after today records nothing until that day (A37)", () => {
    expect(on("2026-12-01T10:00:00Z", "2026-11-24", "2026-11-30")).toBe(0);
  });

  it("a meeting today records (the bound is inclusive), and the same meeting records once today has come to its day (A37)", () => {
    expect(on("2026-11-30T10:00:00Z", "2026-11-24", "2026-11-30")).toBe(3);
    expect(on("2026-12-01T10:00:00Z", "2026-11-24", "2026-12-01")).toBe(3);
  });

  it("the bounds are in Zurich's days: 23:30 UTC on the 24th is the 25th there, so it counts from a release day of the 25th", () => {
    expect(on("2026-11-24T23:30:00Z", "2026-11-25", "2026-11-30")).toBe(3);
    expect(on("2026-11-24T23:30:00Z", "2026-11-26", "2026-11-30")).toBe(0);
  });

  it("and not yet today: 23:30 UTC on the 25th is the 26th in Zurich, after a today of the 25th", () => {
    expect(on("2026-11-25T23:30:00Z", "2026-11-24", "2026-11-25")).toBe(0);
    expect(on("2026-11-25T23:30:00Z", "2026-11-24", "2026-11-26")).toBe(3);
  });

  it("a release day after today leaves no day that is both", () => {
    expect(on("2026-11-25T10:00:00Z", "2026-11-26", "2026-11-25")).toBe(0);
  });
});

describe("what it does with a startsAt it cannot read", () => {
  it("throws rather than answering 'nobody': an empty answer would remove real entries (apply parses with the wire first, so this is unreachable)", () => {
    for (const startsAt of ["", "not a date", "2026-11-24T23:59:60Z", "2026-13-40T10:00:00Z"]) {
      expect(() => desiredEntries(facts({ startsAt }), SINCE, TODAY), startsAt).toThrow("startsAt is not an instant");
    }
  });

  it("throws on a duration that is not a number, rather than putting NaN minutes in an entry", () => {
    for (const durationMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => desiredEntries(facts({ durationMs }), SINCE, TODAY), String(durationMs)).toThrow("durationMs is not a number");
    }
  });

  it("the extreme instants the wire accepts neither throw nor record: no such day is on or after a release day", () => {
    for (const startsAt of ["0000-01-01T00:00:00Z", "0001-01-01T00:00:00+23:59", "9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59-23:59"]) {
      expect(entries(facts({ startsAt })), startsAt).toEqual([]);
    }
  });

  it("an instant with more than millisecond precision reads as the instant it names", () => {
    expect(entries(facts({ startsAt: "2026-11-25T09:00:00.123456789Z" }))[0]).toEqual(["user-creator", { day: "2026-11-25", minutes: 60 }]);
  });
});

describe("it is pure", () => {
  it("does not change the facts it is given", () => {
    const given = Object.freeze({ ...facts(), participantIds: Object.freeze(["user-b", "user-a"]) as unknown as string[] });
    expect(() => desiredEntries(given, SINCE, TODAY)).not.toThrow();
    expect(given.participantIds).toEqual(["user-b", "user-a"]);
  });

  it("answers the same on any clock: today is an argument, never read", () => {
    const before = entries(facts());
    for (const clock of ["2001-01-01T00:00:00Z", "2040-06-30T12:00:00Z"]) {
      setSystemTime(new Date(clock));
      try {
        expect(entries(facts()), clock).toEqual(before);
      } finally {
        setSystemTime();
      }
    }
    expect(before.length).toBe(3);
  });
});

describe("a meeting that records nothing", () => {
  it("a meeting that no longer exists (facts null) has no entries (AC-3.4)", () => {
    expect(entries(null)).toEqual([]);
  });

  it("a duration that is not known has none (AC-1.3)", () => {
    expect(entries(facts({ durationMs: null }))).toEqual([]);
  });

  it("a duration of 0 is 'not known' too, not the 30-minute floor: a recording with no audio (D-P4, D59)", () => {
    expect(entries(facts({ durationMs: 0 }))).toEqual([]);
  });
});
