/**
 * `apply(notice)` — making a meeting's untouched automatic entries match the facts of the newest notice
 * (specs/20261112-meeting-hours T6; plan § "Applying a notice" steps 1-7; ADR
 * 20261124-meeting-hours-facts-pushed-by-their-owner-as-a-versioned-state-built-at-send-time-through-an-until-delivered-outbox-and-applied-by-hours-api-only-when-not-older and
 * 20261124-a-system-written-time-entry-follows-its-source-fact-only-until-its-person-changes-it-and-is-never-written-again-after-the-person-removed-it),
 * called directly against the real database (`hours_*_test`) and the fake hosts. The route that calls it is T7.
 *
 * Time is fixed at 2026-11-13 10:00Z (a Friday, 11:00 in Zurich) and the release day is 2026-01-01 unless a test moves it
 * (`world.ts` RELEASE_DAY). The default meeting started on 2026-11-12 at 10:00 in Zurich and lasted an hour.
 *
 * Import order: `../test-support/world` first (see its TRAP note).
 */
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PERSONAS, SEED, call, db, makeMeetingEntry, makeNoEntityEntry, resetWorld, setReleaseDay } from "../test-support/world";
import { startHosts } from "../test-support/hosts";
import { __setClockForTests } from "../entries/today";
import type { Prisma } from "../lib/generated/prisma/client";
import type { MeetingHoursFacts, MeetingHoursNotice } from "../lib/meetingHoursWire";
import { apply } from "./apply";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

const ALICE = PERSONAS.alice.sub;
const BOB = PERSONAS.bob.sub;
const CAROL = PERSONAS.carol.sub;
const M = "m1";
const HOUR = 3_600_000;

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
  for (const [key, persona] of Object.entries(PERSONAS)) hosts.auth.setIdentity(persona.sub, { name: `Name of ${key}` });
});

/** The facts of a meeting: Alice created it, Bob took part, it began 2026-11-12 10:00 Zurich and lasted an hour. */
const facts = (over: Partial<MeetingHoursFacts> = {}): MeetingHoursFacts => ({
  startsAt: "2026-11-12T09:00:00Z",
  durationMs: HOUR,
  creatorId: ALICE,
  participantIds: [BOB],
  ...over,
});
const notice = (seq: number, state: MeetingHoursFacts | null, meetingId = M): MeetingHoursNotice => ({
  noticeId: `notice-${meetingId}-${seq}`,
  meeting: { id: meetingId, seq, facts: state },
});

/** Every automatic entry of a meeting, whoever holds it and wherever it is now, as what the tests compare. */
const automatic = async (meetingId = M) => {
  const rows = await db.timeEntry.findMany({ where: { sourceMeetingId: meetingId }, orderBy: { userId: "asc" } });
  return rows.map((row) => ({ userId: row.userId, day: row.day.toISOString().slice(0, 10), minutes: row.minutes, followsMeeting: row.followsMeeting }));
};

const blocks = () => db.meetingHoursBlock.findMany({ orderBy: [{ meetingId: "asc" }, { userId: "asc" }] });
const storedSeq = async (meetingId = M) => (await db.meetingHoursMeeting.findUnique({ where: { meetingId } }))?.seq ?? null;

describe("a notice with facts gives the creator and each Operai participant an automatic entry (AC-1.1, AC-1.2)", () => {
  it("creates one entry per person: on the meeting, on its Zurich day, for its duration, following it, with an empty note and no work type, recorded by Operai", async () => {
    const result = await apply(notice(1, facts()));

    expect(result).toEqual({ applied: true });
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 60, followsMeeting: true },
      { userId: BOB, day: "2026-11-12", minutes: 60, followsMeeting: true },
    ]);
    const rows = await db.timeEntry.findMany({ where: { meetingId: M } });
    for (const row of rows) {
      expect(row).toMatchObject({ target: "meeting", meetingId: M, origin: "meeting", sourceMeetingId: M, note: null, workTypeId: null, activityId: null, projectId: null, dealId: null, categoryId: null });
    }
  });
});

describe("an untouched entry follows its meeting (AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-1.3)", () => {
  it("moves it to the meeting's new day when the date-time changes (AC-3.1), across midnight in Zurich too", async () => {
    await apply(notice(1, facts()));

    await apply(notice(2, facts({ startsAt: "2026-11-10T09:00:00Z" })));
    expect((await automatic()).map((row) => row.day)).toEqual(["2026-11-10", "2026-11-10"]);

    // 23:30Z on 11 November is 00:30 on 12 November in Zurich (A35).
    await apply(notice(3, facts({ startsAt: "2026-11-11T23:30:00Z" })));
    expect((await automatic()).map((row) => row.day)).toEqual(["2026-11-12", "2026-11-12"]);
  });

  it("resizes it to the new duration, rounded as on creation, when the duration changes (AC-3.2)", async () => {
    await apply(notice(1, facts()));

    await apply(notice(2, facts({ durationMs: 135 * 60_000 })));

    // 2 h 15 is 135 minutes: a half step rounds up, to 2 h 30.
    expect((await automatic()).map((row) => row.minutes)).toEqual([150, 150]);
  });

  it("moves and resizes in one notice, and leaves an entry that already says the same alone", async () => {
    await apply(notice(1, facts()));
    const before = await db.timeEntry.findMany({ orderBy: { userId: "asc" } });

    await apply(notice(2, facts()));
    const same = await db.timeEntry.findMany({ orderBy: { userId: "asc" } });
    await apply(notice(3, facts({ startsAt: "2026-11-09T09:00:00Z", durationMs: 30 * 60_000 })));

    expect(same).toEqual(before);
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-09", minutes: 30, followsMeeting: true },
      { userId: BOB, day: "2026-11-09", minutes: 30, followsMeeting: true },
    ]);
  });

  it("removes the entry of a participant the newer facts no longer list, with no block, and keeps the others (AC-3.3)", async () => {
    await apply(notice(1, facts({ participantIds: [BOB, CAROL] })));

    await apply(notice(2, facts({ participantIds: [CAROL] })));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE, CAROL]);
    expect(await db.meetingHoursBlock.count()).toBe(0);
  });

  it("keeps the creator's entry when the creator is not among the participants, as they never were (AC-3.3, AC-1.2)", async () => {
    await apply(notice(1, facts({ participantIds: [BOB] })));

    await apply(notice(2, facts({ participantIds: [] })));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE]);
  });

  it("removes every untouched entry when the meeting no longer exists: facts null (AC-3.4)", async () => {
    await apply(notice(1, facts({ participantIds: [BOB, CAROL] })));

    const gone = await apply(notice(2, null));

    expect(gone).toEqual({ applied: true });
    expect(await automatic()).toEqual([]);
    expect(await db.timeEntry.count()).toBe(0);
    expect(await db.meetingHoursBlock.count()).toBe(0);
  });

  it("removes the untouched entries when the duration stops being known, and records them again once it is (AC-1.3: the upload that was too long)", async () => {
    await apply(notice(1, facts()));

    await apply(notice(2, facts({ durationMs: null })));
    expect(await automatic()).toEqual([]);

    await apply(notice(3, facts({ durationMs: HOUR })));
    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE, BOB]);
  });

  it("only touches the meeting the notice is about", async () => {
    await apply(notice(1, facts(), "m2"));
    await apply(notice(1, facts()));

    await apply(notice(2, null));

    expect((await automatic("m2")).map((row) => row.userId)).toEqual([ALICE, BOB]);
    expect(await automatic()).toEqual([]);
  });
});

describe("an entry its person changed is theirs: no later notice moves, resizes, removes or doubles it (AC-3.5, AC-3.6)", () => {
  /** Alice's entry, changed by her (she wrote 90 minutes in), and Bob's, untouched. */
  async function aliceChangedBobUntouched() {
    await apply(notice(1, facts()));
    const mine = await db.timeEntry.findFirstOrThrow({ where: { userId: ALICE } });
    expect((await call("PATCH", `/time-entries/${mine.id}`, { body: { minutes: 90 } })).status).toBe(200);
    return mine.id;
  }

  it("keeps its day and duration when the meeting's date-time or duration changes, while an untouched entry beside it follows (AC-3.5)", async () => {
    await aliceChangedBobUntouched();

    await apply(notice(2, facts({ startsAt: "2026-11-10T09:00:00Z", durationMs: 30 * 60_000 })));

    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 90, followsMeeting: false },
      { userId: BOB, day: "2026-11-10", minutes: 30, followsMeeting: true },
    ]);
  });

  it("stays when its person is removed from the meeting, and when the meeting is deleted (AC-3.6)", async () => {
    await aliceChangedBobUntouched();

    // Both of the people leave the meeting (Alice is its creator, so the facts name another creator now).
    await apply(notice(2, facts({ creatorId: CAROL, participantIds: [] })));
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 90, followsMeeting: false },
      { userId: CAROL, day: "2026-11-12", minutes: 60, followsMeeting: true },
    ]);

    await apply(notice(3, null));
    expect(await automatic()).toEqual([{ userId: ALICE, day: "2026-11-12", minutes: 90, followsMeeting: false }]);
  });

  it("stays, with its person's values, when the duration stops being known and when the meeting moves to a later day than today", async () => {
    await aliceChangedBobUntouched();

    await apply(notice(2, facts({ durationMs: null })));
    await apply(notice(3, facts({ startsAt: "2026-11-20T09:00:00Z" })));

    expect(await automatic()).toEqual([{ userId: ALICE, day: "2026-11-12", minutes: 90, followsMeeting: false }]);
  });

  it("is never given a second automatic entry beside it, not even once its person moved it to a project", async () => {
    hosts.projects.setProject("p1", { label: "Apollo", assignees: [ALICE] });
    const id = await aliceChangedBobUntouched();
    expect((await call("PATCH", `/time-entries/${id}`, { body: { on: { type: "project", id: "p1" } } })).status).toBe(200);

    const result = await apply(notice(2, facts({ durationMs: 2 * HOUR })));

    expect(result).toEqual({ applied: true });
    expect(await db.timeEntry.count({ where: { userId: ALICE } })).toBe(1);
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id } })).toMatchObject({ target: "project", projectId: "p1", minutes: 90, sourceMeetingId: M, followsMeeting: false });
  });
});

// The measured duration (AC-3.8, AC-3.9): meetings-api replaces a held duration the audio contradicts beyond the margin and tells
// hours-api through the same versioned notice as any other change of a fact. Nothing here is new for the receiver: it is the
// AC-3.2 and AC-3.5 behaviour driven with the figures of a correction (3 h reported, 10 min measured).
describe("a correction of the duration is an ordinary newer notice (AC-3.9)", () => {
  it("an untouched entry takes the measured duration, rounded as on creation; the entry its person changed keeps its values", async () => {
    // Version 1 announced the 3 h the browser reported; Alice then wrote her own figure in, Bob did not.
    await apply(notice(1, facts({ durationMs: 3 * HOUR })));
    expect((await automatic()).map((row) => row.minutes)).toEqual([180, 180]);
    const mine = await db.timeEntry.findFirstOrThrow({ where: { userId: ALICE } });
    expect((await call("PATCH", `/time-entries/${mine.id}`, { body: { minutes: 90 } })).status).toBe(200);

    // Version 2: the audio measured 10 minutes, which rounds to the 30-minute floor (A36).
    const result = await apply(notice(2, facts({ durationMs: 10 * 60_000 })));

    expect(result).toEqual({ applied: true });
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 90, followsMeeting: false },
      { userId: BOB, day: "2026-11-12", minutes: 30, followsMeeting: true },
    ]);
  });

  it("a correction that rounds to the step the entry already holds changes nothing", async () => {
    await apply(notice(1, facts({ durationMs: 20 * 60_000 })));
    const before = await db.timeEntry.findMany({ orderBy: { userId: "asc" } });

    await apply(notice(2, facts({ durationMs: 10 * 60_000 })));

    // 20 and 10 minutes both round to 30: the rows are byte for byte what they were.
    expect(await db.timeEntry.findMany({ orderBy: { userId: "asc" } })).toEqual(before);
    expect((await automatic()).map((row) => row.minutes)).toEqual([30, 30]);
  });

  it("an older version of the held duration arriving after the correction does not undo it", async () => {
    await apply(notice(1, facts({ durationMs: 3 * HOUR })));
    await apply(notice(2, facts({ durationMs: 10 * 60_000 })));

    const late = await apply(notice(1, facts({ durationMs: 3 * HOUR })));

    expect(late).toEqual({ applied: false });
    expect((await automatic()).map((row) => row.minutes)).toEqual([30, 30]);
  });
});

describe("a person who already had an entry on the meeting, or deleted theirs, never gets an automatic one (AC-1.4, AC-2.5, AC-3.7)", () => {
  it("gives a person with an entry of their own on the meeting a block `had_entry` and no automatic entry, while the others get theirs (AC-1.4)", async () => {
    const own = await makeMeetingEntry(M, { userId: BOB, day: "2026-11-12", minutes: 30 });

    await apply(notice(1, facts({ participantIds: [BOB, CAROL] })));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE, CAROL]);
    expect(await blocks()).toMatchObject([{ meetingId: M, userId: BOB, reason: "had_entry" }]);
    expect(await db.timeEntry.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ origin: "person", minutes: 30 });
  });

  it("keeps the block after they delete their own entry: a newer notice still creates none (AC-1.4)", async () => {
    const own = await makeMeetingEntry(M, { userId: BOB, day: "2026-11-12", minutes: 30 });
    await apply(notice(1, facts()));
    expect((await call("DELETE", `/time-entries/${own.id}`, { as: "bob" })).status).toBe(204);

    await apply(notice(2, facts({ durationMs: 2 * HOUR })));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE]);
    expect(await db.timeEntry.count({ where: { userId: BOB } })).toBe(0);
    expect(await blocks()).toMatchObject([{ meetingId: M, userId: BOB, reason: "had_entry" }]);
  });

  it("counts an entry only on this meeting: one on another meeting, a project or no entity is no reason to withhold it", async () => {
    await makeMeetingEntry("m-other", { userId: BOB, day: "2026-11-12" });
    await makeNoEntityEntry(SEED.categories.training, { userId: BOB, day: "2026-11-12" });

    await apply(notice(1, facts()));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE, BOB]);
    expect(await blocks()).toEqual([]);
  });

  it("counts an automatic entry of ANOTHER meeting that its person moved onto this one as an entry of their own on it", async () => {
    hosts.meetings.add({ id: M, creator: ALICE, participants: [BOB] });
    await apply(notice(1, facts(), "m-other"));
    const moved = await db.timeEntry.findFirstOrThrow({ where: { userId: BOB, sourceMeetingId: "m-other" } });
    expect((await call("PATCH", `/time-entries/${moved.id}`, { as: "bob", body: { on: { type: "meeting", id: M } } })).status).toBe(200);

    await apply(notice(1, facts()));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE]);
    expect(await blocks()).toMatchObject([{ meetingId: M, userId: BOB, reason: "had_entry" }]);
  });

  it("decides it when the duration becomes known, not before: an entry written while it was not known still counts (AC-1.3, AC-1.4)", async () => {
    await apply(notice(1, facts({ durationMs: null })));
    expect(await blocks()).toEqual([]);
    await makeMeetingEntry(M, { userId: BOB, day: "2026-11-12", minutes: 30 });

    await apply(notice(2, facts()));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE]);
    expect(await blocks()).toMatchObject([{ meetingId: M, userId: BOB, reason: "had_entry" }]);
  });

  it("does not take away an automatic entry that is already there when its person records one of their own beside it", async () => {
    await apply(notice(1, facts()));
    await makeMeetingEntry(M, { userId: BOB, day: "2026-11-12", minutes: 30 });

    await apply(notice(2, facts({ durationMs: 2 * HOUR })));

    expect((await automatic()).map((row) => [row.userId, row.minutes])).toEqual([
      [ALICE, 120],
      [BOB, 120],
    ]);
    expect(await blocks()).toEqual([]);
  });

  it.each(["untouched", "touched"] as const)("never records again an %s entry its person deleted, whatever later happens to the meeting (AC-2.5)", async (kind) => {
    await apply(notice(1, facts({ participantIds: [BOB, CAROL] })));
    const mine = await db.timeEntry.findFirstOrThrow({ where: { userId: BOB } });
    if (kind === "touched") expect((await call("PATCH", `/time-entries/${mine.id}`, { as: "bob", body: { minutes: 90 } })).status).toBe(200);
    expect((await call("DELETE", `/time-entries/${mine.id}`, { as: "bob" })).status).toBe(204);
    const bobsEntries = () => db.timeEntry.count({ where: { userId: BOB } });

    // The same facts again, a new duration and a new day, then the person removed and added back, the meeting emptied and back.
    await apply(notice(2, facts({ participantIds: [BOB, CAROL] })));
    expect(await bobsEntries()).toBe(0);
    await apply(notice(3, facts({ participantIds: [BOB, CAROL], durationMs: 3 * HOUR, startsAt: "2026-11-11T09:00:00Z" })));
    expect(await bobsEntries()).toBe(0);
    await apply(notice(4, facts({ participantIds: [CAROL] })));
    await apply(notice(5, facts({ participantIds: [BOB, CAROL] })));
    expect(await bobsEntries()).toBe(0);
    await apply(notice(6, facts({ participantIds: [BOB, CAROL], durationMs: null })));
    await apply(notice(7, facts({ participantIds: [BOB, CAROL] })));

    expect(await bobsEntries()).toBe(0);
    expect(await blocks()).toMatchObject([{ meetingId: M, userId: BOB, reason: "deleted" }]);
    // The others carry on following the meeting.
    expect((await automatic()).map((row) => [row.userId, row.minutes])).toEqual([
      [ALICE, 60],
      [CAROL, 60],
    ]);
  });

  it("blocks only that person on that meeting: they get one on another meeting, and another person on this one", async () => {
    await apply(notice(1, facts({ participantIds: [BOB, CAROL] })));
    const mine = await db.timeEntry.findFirstOrThrow({ where: { userId: BOB } });
    expect((await call("DELETE", `/time-entries/${mine.id}`, { as: "bob" })).status).toBe(204);

    await apply(notice(1, facts({ participantIds: [BOB, CAROL] }), "m2"));

    expect((await automatic("m2")).map((row) => row.userId)).toEqual([ALICE, BOB, CAROL]);
    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE, CAROL]);
  });

  it("records an entry for a person added to the participants after the duration is known (AC-3.7), unless they are blocked", async () => {
    await apply(notice(1, facts({ participantIds: [] })));
    await makeMeetingEntry(M, { userId: BOB, day: "2026-11-12" });
    await db.meetingHoursBlock.create({ data: { meetingId: M, userId: CAROL, reason: "deleted" } });

    await apply(notice(2, facts({ participantIds: [BOB, CAROL, PERSONAS.manager.sub] })));

    // Bob had an entry of his own by then (AC-1.4), Carol deleted hers earlier (AC-2.5), the manager is simply new.
    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE, PERSONAS.manager.sub]);
    expect(await blocks()).toMatchObject([
      { meetingId: M, userId: BOB, reason: "had_entry" },
      { meetingId: M, userId: CAROL, reason: "deleted" },
    ]);
  });

  it("gives a person added after the duration was known an entry on the meeting's day, for its duration (AC-3.7)", async () => {
    await apply(notice(1, facts({ participantIds: [] })));

    await apply(notice(2, facts({ participantIds: [CAROL] })));

    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 60, followsMeeting: true },
      { userId: CAROL, day: "2026-11-12", minutes: 60, followsMeeting: true },
    ]);
  });
});

describe("the newest version wins; a repeated or an older notice changes nothing (AC-4.2)", () => {
  it("applies the same notice twice: one entry per person, never two, and both answers say it was applied", async () => {
    const first = await apply(notice(1, facts()));
    const again = await apply(notice(1, facts()));

    expect([first, again]).toEqual([{ applied: true }, { applied: true }]);
    expect(await automatic()).toHaveLength(2);
    expect(await db.timeEntry.count()).toBe(2);
  });

  it("answers `applied: false` to an older version than the one applied, writes nothing for it and keeps the newer version's entries", async () => {
    await apply(notice(2, facts({ durationMs: 2 * HOUR })));

    // An older notice that, if it were applied, would resize the entries, add a person and move the day.
    const stale = await apply(notice(1, facts({ durationMs: HOUR / 2, participantIds: [BOB, PERSONAS.carol.sub], startsAt: "2026-11-10T09:00:00Z" })));

    expect(stale).toEqual({ applied: false });
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 120, followsMeeting: true },
      { userId: BOB, day: "2026-11-12", minutes: 120, followsMeeting: true },
    ]);
    expect((await db.meetingHoursMeeting.findUniqueOrThrow({ where: { meetingId: M } })).seq).toBe(2);
  });

  it("remembers the version it applied, per meeting, and applies a newer one after an older one was refused", async () => {
    await apply(notice(3, facts()));
    await apply(notice(1, facts({ participantIds: [] })));
    const other = await apply(notice(1, facts(), "m2"));
    const newer = await apply(notice(4, facts({ durationMs: 90 * 60_000 })));

    expect(other).toEqual({ applied: true });
    expect(newer).toEqual({ applied: true });
    expect((await db.meetingHoursMeeting.findMany({ orderBy: { meetingId: "asc" } })).map((row) => [row.meetingId, row.seq])).toEqual([
      ["m1", 4],
      ["m2", 1],
    ]);
    expect((await automatic()).map((row) => row.minutes)).toEqual([90, 90]);
  });
});

describe("whether a meeting records hours at all: its duration, the release day and today (AC-1.2, AC-1.3, AC-1.5, A37)", () => {
  it("gives a creator who is also listed among the participants one entry, not two (AC-1.2)", async () => {
    await apply(notice(1, facts({ participantIds: [ALICE, BOB] })));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE, BOB]);
    expect(await db.timeEntry.count()).toBe(2);
  });

  it("records nothing while the duration is not known: null (typed, not processed) and 0 (no audio), then records it when it is known (AC-1.3)", async () => {
    for (const durationMs of [null, 0]) {
      expect(await apply(notice(durationMs === null ? 1 : 2, facts({ durationMs })))).toEqual({ applied: true });
      expect(await db.timeEntry.count()).toBe(0);
    }
    expect(await storedSeq()).toBe(2);

    await apply(notice(3, facts({ durationMs: 20 * 60_000 })));

    // A quarter of an hour is not below the floor: 20 minutes record 30.
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 30, followsMeeting: true },
      { userId: BOB, day: "2026-11-12", minutes: 30, followsMeeting: true },
    ]);
  });

  it("records nothing for a meeting that began before the release day, and does for one on it (AC-1.5)", async () => {
    await setReleaseDay("2026-11-12");

    // 23:30 in Zurich on 11 November (22:30Z), the day before the release day, then 00:30 on the 12th (23:30Z on the 11th).
    await apply(notice(1, facts({ startsAt: "2026-11-11T22:30:00Z" })));
    expect(await db.timeEntry.count()).toBe(0);
    await apply(notice(2, facts({ startsAt: "2026-11-11T23:30:00Z" })));

    expect((await automatic()).map((row) => row.day)).toEqual(["2026-11-12", "2026-11-12"]);
  });

  it("removes an untouched entry when the meeting is moved to a day before the release day, as it would never have been recorded there", async () => {
    await setReleaseDay("2026-11-12");
    await apply(notice(1, facts()));
    expect(await automatic()).toHaveLength(2);

    await apply(notice(2, facts({ startsAt: "2026-11-05T09:00:00Z" })));

    expect(await automatic()).toEqual([]);
  });

  it("waits for the day of a meeting that is yet to come: nothing is recorded, an untouched entry is removed, and it is recorded on that day by the delivery sent then (A37)", async () => {
    await apply(notice(1, facts()));
    expect(await automatic()).toHaveLength(2);

    // The meeting moves to Monday 16 November; today is Friday 13th.
    const future = facts({ startsAt: "2026-11-16T09:00:00Z" });
    await apply(notice(2, future));
    expect(await automatic()).toEqual([]);
    expect(await blocks()).toEqual([]);

    // Saturday 14th and the night before the 16th: still not that day in Zurich.
    __setClockForTests(() => new Date("2026-11-15T22:59:00Z"));
    expect(await apply(notice(2, future))).toEqual({ applied: true });
    expect(await automatic()).toEqual([]);

    // 00:01 in Zurich on the 16th: the equal version is delivered again, and applying an equal version applies it.
    __setClockForTests(() => new Date("2026-11-15T23:01:00Z"));
    expect(await apply(notice(2, future))).toEqual({ applied: true });
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-16", minutes: 60, followsMeeting: true },
      { userId: BOB, day: "2026-11-16", minutes: 60, followsMeeting: true },
    ]);
  });

  it("decides who is withheld on the day the meeting is recorded, not before: a person with an entry of their own gets the block then, and no entry (A37, AC-1.4)", async () => {
    const future = facts({ startsAt: "2026-11-16T09:00:00Z" });
    await makeMeetingEntry(M, { userId: BOB, day: "2026-11-16" });
    await apply(notice(1, future));
    expect(await blocks()).toEqual([]);

    __setClockForTests(() => new Date("2026-11-15T23:01:00Z"));
    await apply(notice(1, future));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE]);
    expect(await blocks()).toMatchObject([{ meetingId: M, userId: BOB, reason: "had_entry" }]);
  });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves once a statement of this database waits for a lock: what is under test is queued behind a transaction the test holds. */
async function untilSomeoneWaitsForALock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (rows[0]!.n > 0) return;
    if (Date.now() > deadline) throw new Error("nothing is waiting for a lock: the statement under test did not queue behind the held transaction");
    await sleep(20);
  }
}

/**
 * Runs `work` in a transaction of its own on ANOTHER connection and keeps that transaction open — its row locks held — until
 * `release()`. `hasRun` settles once `work` ran (or failed). `done` settles when the transaction has ended: a connection must
 * not outlive its test, so a test releases and awaits it in a `finally`.
 */
function holding(work: (tx: Prisma.TransactionClient) => Promise<unknown>, beforeCommit?: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let ran!: () => void;
  const hasRun = new Promise<void>((resolve) => (ran = resolve));
  const done = db.$transaction(
    async (tx) => {
      try {
        await work(tx);
      } finally {
        ran();
      }
      await released;
      await beforeCommit?.(tx);
    },
    { timeout: 15_000 },
  );
  return { hasRun, release, done };
}

describe("a person's save and an apply on one entry: the person's values stand, and Operai never undoes a choice it cannot see (AC-3.5, AC-2.5)", () => {
  // The person's PATCH commits AFTER apply read their entry as untouched and BEFORE apply's own statement reaches it:
  // that is the compare-and-set `AND "followsMeeting"`, driven here by holding the PATCH's transaction open on a second connection.
  it("does not move or resize an entry whose person saved a change after apply read it (AC-3.5)", async () => {
    await apply(notice(1, facts()));
    const mine = await db.timeEntry.findFirstOrThrow({ where: { userId: ALICE } });
    const saving = holding((tx) => tx.timeEntry.update({ where: { id: mine.id }, data: { day: new Date("2026-11-11T00:00:00Z"), minutes: 90, followsMeeting: false } }));
    let applying: Promise<unknown> | undefined;
    try {
      await saving.hasRun;
      applying = apply(notice(2, facts({ durationMs: 2 * HOUR, startsAt: "2026-11-10T09:00:00Z" })));
      await untilSomeoneWaitsForALock();
    } finally {
      saving.release();
      await saving.done;
    }

    expect(await applying).toEqual({ applied: true });
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-11", minutes: 90, followsMeeting: false },
      // Bob's entry, untouched, follows.
      { userId: BOB, day: "2026-11-10", minutes: 120, followsMeeting: true },
    ]);
  });

  it("does not remove an entry whose person saved a change after apply read it, though the meeting no longer lists them (AC-3.5, AC-3.6)", async () => {
    await apply(notice(1, facts()));
    const bobs = await db.timeEntry.findFirstOrThrow({ where: { userId: BOB } });
    const saving = holding((tx) => tx.timeEntry.update({ where: { id: bobs.id }, data: { minutes: 90, followsMeeting: false } }));
    let applying: Promise<unknown> | undefined;
    try {
      await saving.hasRun;
      applying = apply(notice(2, facts({ participantIds: [] })));
      await untilSomeoneWaitsForALock();
    } finally {
      saving.release();
      await saving.done;
    }

    expect(await applying).toEqual({ applied: true });
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 60, followsMeeting: true },
      { userId: BOB, day: "2026-11-12", minutes: 90, followsMeeting: false },
    ]);
  });

  it("leaves the PATCH's day and duration standing whichever of the PATCH and an apply reaches the entry first, through the route (AC-3.5)", async () => {
    for (let round = 0; round < 15; round++) {
      const meeting = `m-race-patch-${round}`;
      await apply(notice(1, facts(), meeting));
      const mine = await db.timeEntry.findFirstOrThrow({ where: { userId: ALICE, sourceMeetingId: meeting } });

      const [patched, applied] = await Promise.all([
        call("PATCH", `/time-entries/${mine.id}`, { body: { day: "2026-11-11", minutes: 90 } }),
        sleep(round % 3).then(() => apply(notice(2, facts({ durationMs: 2 * HOUR, startsAt: "2026-11-10T09:00:00Z" }), meeting))),
      ]);

      expect({ round, patched: patched.status, applied }).toEqual({ round, patched: 200, applied: { applied: true } });
      expect(await db.timeEntry.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ day: new Date("2026-11-11T00:00:00Z"), minutes: 90, followsMeeting: false });
    }
  });

  it("never records again an entry that is being deleted while an apply runs, whichever commits first (AC-2.5)", async () => {
    for (let round = 0; round < 20; round++) {
      const meeting = `m-race-delete-${round}`;
      await apply(notice(1, facts(), meeting));
      const bobs = await db.timeEntry.findFirstOrThrow({ where: { userId: BOB, sourceMeetingId: meeting } });

      const [deleted] = await Promise.all([
        // From before the apply starts to after it ends: the DELETE lands in every phase of it, between its reads included.
        sleep(round * 2).then(() => call("DELETE", `/time-entries/${bobs.id}`, { as: "bob" })),
        // Bob is still wanted by these facts, and the entry is resized: apply holds its row while the DELETE comes.
        apply(notice(2, facts({ durationMs: 2 * HOUR }), meeting)),
      ]);

      expect({ round, deleted: deleted.status }).toEqual({ round, deleted: 204 });
      expect({ round, entries: await db.timeEntry.count({ where: { userId: BOB, sourceMeetingId: meeting } }) }).toEqual({ round, entries: 0 });
      expect(await db.meetingHoursBlock.findMany({ where: { meetingId: meeting } })).toMatchObject([{ userId: BOB, reason: "deleted" }]);
    }
  });
});

describe("two applies of one meeting never interleave: the newest version wins whatever the order they arrive in (AC-4.2)", () => {
  it("waits for an apply of the same meeting that is still running, and then reads the version it left (the row lock)", async () => {
    await apply(notice(1, facts()));
    // An apply of version 5 in flight: it holds the meeting's row, and says it applied version 5 just before it commits.
    const inFlight = holding(
      (tx) => tx.$queryRaw`SELECT "seq" FROM meeting_hours_meeting WHERE "meetingId" = ${M} FOR UPDATE`,
      (tx) => tx.meetingHoursMeeting.update({ where: { meetingId: M }, data: { seq: 5 } }),
    );
    let applying: Promise<unknown> | undefined;
    try {
      await inFlight.hasRun;
      applying = apply(notice(3, facts({ durationMs: 3 * HOUR })));
      await untilSomeoneWaitsForALock();
    } finally {
      inFlight.release();
      await inFlight.done;
    }

    // Version 3 was held back until version 5 was done, and is then the older one: nothing of it was written.
    expect(await applying).toEqual({ applied: false });
    expect(await storedSeq()).toBe(5);
    expect((await automatic()).map((row) => row.minutes)).toEqual([60, 60]);
  });

  it("applies six versions sent at once, in any order, to exactly one entry per person and the facts of the sixth", async () => {
    const versions = [1, 2, 3, 4, 5, 6].map((seq) => notice(seq, facts({ durationMs: seq * HOUR, participantIds: seq % 2 === 1 ? [BOB] : [BOB, CAROL] })));

    const results = await Promise.all([...versions].reverse().map((version) => apply(version)));

    expect(results.some((result) => result.applied)).toBe(true);
    expect(await storedSeq()).toBe(6);
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 360, followsMeeting: true },
      { userId: BOB, day: "2026-11-12", minutes: 360, followsMeeting: true },
      { userId: CAROL, day: "2026-11-12", minutes: 360, followsMeeting: true },
    ]);
    expect(await db.timeEntry.count()).toBe(3);
  });

  it("creates one entry per person when the very first notice of a meeting is delivered several times at once", async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => apply(notice(1, facts()))));

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ applied: true })));
    expect(await db.timeEntry.count()).toBe(2);
    expect(await storedSeq()).toBe(1);
  });
});

describe("an apply is all or nothing (AC-4.2)", () => {
  it("writes nothing when a step fails: the removals, the resizes and the version are undone, and the retry applies the notice whole", async () => {
    await apply(notice(1, facts({ participantIds: [BOB, CAROL] })));
    const before = await db.timeEntry.findMany({ orderBy: { userId: "asc" } });
    // A database that refuses to insert one person: the failure comes AFTER the removal of Carol's entry and the resizes.
    await db.$executeRawUnsafe(`CREATE FUNCTION t6_refuse_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER t6_refuse_boom BEFORE INSERT ON time_entry FOR EACH ROW WHEN (NEW."userId" = 'user-boom') EXECUTE FUNCTION t6_refuse_boom()`);
    const log = spyOn(console, "log").mockImplementation(() => {});
    let logged: unknown[][];
    try {
      await expect(apply(notice(2, facts({ durationMs: 2 * HOUR, participantIds: [BOB, "user-boom"] })))).rejects.toThrow();

      expect(await db.timeEntry.findMany({ orderBy: { userId: "asc" } })).toEqual(before);
      expect(await storedSeq()).toBe(1);
    } finally {
      logged = [...log.mock.calls];
      log.mockRestore();
      await db.$executeRawUnsafe(`DROP TRIGGER t6_refuse_boom ON time_entry`);
      await db.$executeRawUnsafe(`DROP FUNCTION t6_refuse_boom()`);
    }
    // A failed apply says nothing was applied: its failure is the route's to log.
    expect(logged.filter((args) => args[0] === "meeting_hours.applied")).toEqual([]);

    expect(await apply(notice(2, facts({ durationMs: 2 * HOUR, participantIds: [BOB, "user-boom"] })))).toEqual({ applied: true });
    expect(await automatic()).toEqual([
      { userId: ALICE, day: "2026-11-12", minutes: 120, followsMeeting: true },
      { userId: BOB, day: "2026-11-12", minutes: 120, followsMeeting: true },
      { userId: "user-boom", day: "2026-11-12", minutes: 120, followsMeeting: true },
    ]);
    expect(await storedSeq()).toBe(2);
  });
});

describe("what it logs: one line per apply, with counts and no person", () => {
  it("writes `meeting_hours.applied` with the delivery, meeting, version, whether it applied and how many entries were created, moved, removed and blocked — and nobody's id", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    let logged: unknown[][];
    try {
      await makeMeetingEntry(M, { userId: PERSONAS.manager.sub, day: "2026-11-12" });
      await apply(notice(1, facts({ participantIds: [BOB, CAROL] })));
      await apply(notice(2, facts({ durationMs: 2 * HOUR, participantIds: [BOB, PERSONAS.manager.sub] })));
      await apply(notice(1, facts()));
      await apply(notice(3, null));
    } finally {
      // Read before the spy is restored: restoring forgets what it recorded.
      logged = [...log.mock.calls];
      log.mockRestore();
    }

    const lines = logged.filter((args) => args[0] === "meeting_hours.applied");
    expect(lines.map((args) => args[1])).toEqual([
      { noticeId: "notice-m1-1", meetingId: M, seq: 1, applied: true, created: 3, moved: 0, removed: 0, blocked: 0 },
      // Alice and Bob resized, Carol gone, and the manager, newly listed, already has an entry of their own on the meeting.
      { noticeId: "notice-m1-2", meetingId: M, seq: 2, applied: true, created: 0, moved: 2, removed: 1, blocked: 1 },
      { noticeId: "notice-m1-1", meetingId: M, seq: 1, applied: false, created: 0, moved: 0, removed: 0, blocked: 0 },
      { noticeId: "notice-m1-3", meetingId: M, seq: 3, applied: true, created: 0, moved: 0, removed: 2, blocked: 0 },
    ]);
    // Nobody's id, in this line or any other line of the whole apply.
    expect(JSON.stringify(logged)).not.toMatch(/user-/);
  });
});

describe("the entries it writes are ordinary entries of their people (AC-1.8, AC-2.2, AC-2.6, AC-3.6)", () => {
  const NOVEMBER = "from=2026-11-01&to=2026-11-30";

  it("passes every rule of an entry on a meeting: no work type, whole half hours between 30 minutes and 24 hours, never a future day (AC-1.8)", async () => {
    await apply(notice(1, facts({ durationMs: 30 * HOUR })));

    const rows = await db.timeEntry.findMany();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.workTypeId).toBeNull();
      expect(row.minutes).toBe(1440);
      expect(row.day.toISOString().slice(0, 10) <= "2026-11-13").toBe(true);
    }
  });

  it("counts for the meeting's deal in the deal totals, for its people and for everyone's hours alike (AC-1.8, AC-2.2)", async () => {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: M, creator: ALICE, participants: [BOB] });
    hosts.meetings.relink(M, "d1");
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    await apply(notice(1, facts()));

    const mine = await call("GET", `/time-entries/totals?groupBy=deal&${NOVEMBER}`);
    const everyones = await call("GET", `/time-entries/totals?groupBy=deal&${NOVEMBER}&whose=all`, { as: "holder" });

    expect(mine.status).toBe(200);
    expect(mine.json.groups).toEqual([{ kind: "keyed", key: "d1", label: "Deal one", minutes: 60 }]);
    expect(everyones.status).toBe(200);
    expect(everyones.json.groups).toEqual([{ kind: "keyed", key: "d1", label: "Deal one", minutes: 120 }]);
  });

  it("is listed with everyone's hours, and by the deal filter, and says it is from the meeting (AC-2.2, AC-2.3)", async () => {
    hosts.crm.setDeal("d1", { label: "Deal one" });
    hosts.meetings.add({ id: M, creator: ALICE, participants: [BOB] });
    hosts.meetings.relink(M, "d1");
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    await apply(notice(1, facts()));
    const ids = (await db.timeEntry.findMany()).map((row) => row.id).sort();

    const all = await call("GET", `/time-entries?${NOVEMBER}&whose=all`, { as: "holder" });
    const byDeal = await call("GET", `/time-entries?${NOVEMBER}&whose=all&dealId=d1`, { as: "holder" });
    const mine = await call("GET", `/time-entries?${NOVEMBER}`);

    for (const res of [all, byDeal]) {
      expect(res.status).toBe(200);
      expect(res.json.items.map((item: { id: string }) => item.id).sort()).toEqual(ids);
      expect(res.json.items.map((item: { origin: string }) => item.origin)).toEqual(["meeting", "meeting"]);
    }
    expect(mine.json.items).toHaveLength(1);
    expect(mine.json.items[0]).toMatchObject({ minutes: 60, day: "2026-11-12", origin: "meeting", on: { type: "meeting", id: M, visibility: "visible" } });
  });

  it("is shown without the meeting's title once meetings-api no longer holds the meeting, for an entry its person changed (AC-3.6)", async () => {
    hosts.meetings.add({ id: M, creator: ALICE, participants: [BOB] });
    await apply(notice(1, facts()));
    const mine = await db.timeEntry.findFirstOrThrow({ where: { userId: ALICE } });
    expect((await call("PATCH", `/time-entries/${mine.id}`, { body: { minutes: 90 } })).status).toBe(200);
    expect((await call("GET", `/time-entries?${NOVEMBER}`)).json.items[0].on).toMatchObject({ type: "meeting", id: M, visibility: "visible", label: expect.any(String) });

    // The meeting is deleted: the notice removes Bob's untouched entry and leaves Alice's.
    hosts.meetings.remove(M);
    await apply(notice(2, null));

    expect((await automatic()).map((row) => row.userId)).toEqual([ALICE]);
    const after = await call("GET", `/time-entries?${NOVEMBER}`);
    expect(after.status).toBe(200);
    expect(after.json.items).toHaveLength(1);
    expect(after.json.items[0]).toMatchObject({ minutes: 90, origin: "meeting", on: { type: "meeting", id: M, label: null, visibility: "hidden" } });
  });

  it("asks no owner and sends nothing to anyone while it applies: no call leaves hours-api (AC-2.6)", async () => {
    hosts.meetings.add({ id: M, creator: ALICE, participants: [BOB] });
    await apply(notice(1, facts()));
    await apply(notice(2, facts({ durationMs: 2 * HOUR, participantIds: [CAROL] })));
    await apply(notice(3, facts({ startsAt: "2026-11-16T09:00:00Z" })));
    await apply(notice(4, null));

    expect(hosts.calls).toEqual([]);
  });
});
