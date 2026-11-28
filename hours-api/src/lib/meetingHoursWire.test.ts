/**
 * The wire of `POST /system/meeting-hours/v1/notices` (specs/20261112-meeting-hours T2; plan § API contracts,
 * "hours-api — `POST /system/meeting-hours/v1/notices`"; ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older).
 *
 * The body is strict: an unknown key anywhere is a refusal (AC-4.1: no title, no content, nothing the
 * contract does not list), and every bound of the plan is a refusal on its own, so the sender (meetings-api,
 * which builds the body with this same file) and the receiver cannot read the wire two ways (plan R2, R7).
 */

import { describe, expect, it } from "bun:test";
import {
  MEETING_HOURS_ID_MAX,
  MEETING_HOURS_PARTICIPANTS_MAX,
  meetingHoursNoticeWire,
  type MeetingHoursNotice,
} from "./meetingHoursWire";

const FACTS = {
  startsAt: "2026-11-24T09:30:00.000Z",
  durationMs: 3_600_000,
  creatorId: "user-creator",
  participantIds: ["user-a", "user-b"],
};

/** The plan's example body: a meeting that exists, with the facts as they are now. */
const state = (facts: Record<string, unknown> = {}, meeting: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  noticeId: "notice-1",
  meeting: { id: "meeting-1", seq: 3, facts: { ...FACTS, ...facts }, ...meeting },
  ...top,
});

const parse = (body: unknown) => meetingHoursNoticeWire.safeParse(body);
const refusedAt = (body: unknown): string | undefined => {
  const result = parse(body);
  return result.success ? undefined : result.error.issues[0]?.path.join(".");
};

describe("the bodies the plan shows are accepted", () => {
  it("a meeting that exists, with its facts", () => {
    const result = parse(state());
    expect(result.success).toBe(true);
    // The inferred type is the exported one.
    const body: MeetingHoursNotice | undefined = result.data;
    expect(body?.meeting.facts?.participantIds).toEqual(["user-a", "user-b"]);
  });

  it("a duration not known yet (null), and no Operai participant but the creator", () => {
    expect(parse(state({ durationMs: null, participantIds: [] })).success).toBe(true);
  });

  it("a meeting that no longer exists: facts null", () => {
    expect(parse({ noticeId: "notice-2", meeting: { id: "meeting-1", seq: 4, facts: null } }).success).toBe(true);
  });

  it("an offset other than Z, the creator listed among the participants, a duration of 0", () => {
    const result = parse(state({ startsAt: "2026-07-01T23:30:00+02:00", durationMs: 0, participantIds: ["user-creator"] }));
    expect(result.success).toBe(true);
  });
});

describe("an unknown key is refused at every level (AC-4.1)", () => {
  it.each([
    ["the notice", (extra: Record<string, unknown>) => state({}, {}, extra), ""],
    ["the meeting", (extra: Record<string, unknown>) => state({}, extra), "meeting"],
    ["the facts", (extra: Record<string, unknown>) => state(extra), "meeting.facts"],
  ])("%s", (_level, build, path) => {
    for (const key of ["title", "participants", "hostApp", "transcript", "anything"]) {
      const result = parse(build({ [key]: "x" }));
      expect(result.success, key).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path.join("."), key).toBe(path);
    }
  });

  it("a meeting that no longer exists carries no facts, and no extra key either", () => {
    expect(parse({ noticeId: "n", meeting: { id: "m", seq: 1, facts: null, title: "Offer review" } }).success).toBe(false);
  });
});

describe("the version", () => {
  it.each([
    ["0", 0],
    ["a negative", -1],
    ["one past the largest int4", 2_147_483_648],
    ["a fraction", 1.5],
    ["a string", "3"],
    ["null", null],
  ])("seq %s is refused", (_label, seq) => {
    expect(refusedAt(state({}, { seq }))).toBe("meeting.seq");
  });

  it("seq 1 and the largest int4 are accepted", () => {
    expect(parse(state({}, { seq: 1 })).success).toBe(true);
    expect(parse(state({}, { seq: 2_147_483_647 })).success).toBe(true);
  });

  it("seq is required", () => {
    expect(refusedAt({ noticeId: "n", meeting: { id: "m", facts: null } })).toBe("meeting.seq");
  });
});

describe("the ids", () => {
  it("are 1 to 64 characters", () => {
    expect(MEETING_HOURS_ID_MAX).toBe(64);
    const at = (n: number) => "x".repeat(n);
    expect(parse(state({ creatorId: at(64), participantIds: [at(64)] }, { id: at(64) }, { noticeId: at(64) })).success).toBe(true);
    expect(refusedAt(state({}, {}, { noticeId: "" }))).toBe("noticeId");
    expect(refusedAt(state({}, {}, { noticeId: at(65) }))).toBe("noticeId");
    expect(refusedAt(state({}, { id: "" }))).toBe("meeting.id");
    expect(refusedAt(state({}, { id: at(65) }))).toBe("meeting.id");
    expect(refusedAt(state({ creatorId: "" }))).toBe("meeting.facts.creatorId");
    expect(refusedAt(state({ creatorId: at(65) }))).toBe("meeting.facts.creatorId");
    expect(refusedAt(state({ participantIds: ["user-a", ""] }))).toBe("meeting.facts.participantIds.1");
    expect(refusedAt(state({ participantIds: [at(65)] }))).toBe("meeting.facts.participantIds.0");
  });

  it("are strings", () => {
    expect(refusedAt(state({}, { id: 7 }))).toBe("meeting.id");
    expect(refusedAt(state({ creatorId: null }))).toBe("meeting.facts.creatorId");
    expect(refusedAt(state({ participantIds: [7] }))).toBe("meeting.facts.participantIds.0");
  });
});

describe("startsAt", () => {
  it.each([
    ["no offset", "2026-11-24T09:30:00"],
    ["a date only", "2026-11-24"],
    ["a space instead of the T", "2026-11-24 09:30:00Z"],
    ["a day that does not exist", "2026-02-30T09:30:00Z"],
    ["an hour that does not exist", "2026-11-24T25:00:00Z"],
    ["a number of milliseconds", 1_795_514_400_000],
    ["null", null],
    ["empty", ""],
  ])("%s is refused", (_label, startsAt) => {
    expect(refusedAt(state({ startsAt }))).toBe("meeting.facts.startsAt");
  });

  it("every accepted spelling is an instant", () => {
    for (const startsAt of ["2026-11-24T09:30:00Z", "2026-11-24T09:30:00.123Z", "2026-11-24T10:30:00+01:00", "2026-11-24T04:30:00-05:00"]) {
      expect(parse(state({ startsAt })).success, startsAt).toBe(true);
      expect(Number.isFinite(Date.parse(startsAt)), startsAt).toBe(true);
    }
  });
});

describe("durationMs", () => {
  it.each([
    ["a negative", -1],
    ["one past the largest int4", 2_147_483_648],
    ["a fraction", 1.5],
    ["a string", "3600000"],
    ["undefined (a missing key)", undefined],
  ])("%s is refused", (_label, durationMs) => {
    expect(refusedAt(state({ durationMs }))).toBe("meeting.facts.durationMs");
  });

  it("0, the largest int4 and null are accepted", () => {
    for (const durationMs of [0, 2_147_483_647, null]) expect(parse(state({ durationMs })).success, String(durationMs)).toBe(true);
  });
});

describe("participantIds", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `user-${i}`);

  it("takes 100 and refuses a 101st (R7)", () => {
    expect(MEETING_HOURS_PARTICIPANTS_MAX).toBe(100);
    expect(parse(state({ participantIds: ids(100) })).success).toBe(true);
    expect(refusedAt(state({ participantIds: ids(101) }))).toBe("meeting.facts.participantIds");
  });

  it("refuses a duplicate", () => {
    expect(refusedAt(state({ participantIds: ["user-a", "user-b", "user-a"] }))).toBe("meeting.facts.participantIds");
  });

  it("is required, and is a list", () => {
    expect(refusedAt(state({ participantIds: undefined }))).toBe("meeting.facts.participantIds");
    expect(refusedAt(state({ participantIds: "user-a" }))).toBe("meeting.facts.participantIds");
  });
});

describe("facts", () => {
  it("is required: a missing key is not the same as null (a sender that forgot it must not read as a deletion)", () => {
    expect(refusedAt({ noticeId: "n", meeting: { id: "m", seq: 1 } })).toBe("meeting.facts");
  });

  it("is an object or null, nothing else", () => {
    for (const facts of ["gone", 0, [], true]) expect(refusedAt(state({}, { facts })), String(facts)).toBe("meeting.facts");
  });
});
