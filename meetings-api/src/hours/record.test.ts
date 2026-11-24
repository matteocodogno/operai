import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { db } from "../lib/db";
import { setHoursChannelForTests } from "./client";
import { HOURS_NOTICE_MAX_ATTEMPTS } from "./delivery";
import { readHoursFacts, recordHoursNotice, type HoursChange } from "./record";

// `recordHoursNotice` (specs/20261112-meeting-hours T9; plan § "Where meetings-api records a notice"; AC-1.1, AC-1.3, AC-3.1 to
// AC-3.4, AC-3.7, A37): WHEN a write of the meeting leaves a notice in the outbox, and exactly what it leaves. The seven write
// paths that call it are proven through their routes in `triggers.test.ts`; here the function is called inside a transaction
// by hand, the way a write path calls it, against the real database (`meetings_test`).

const NOW = new Date("2026-11-24T10:00:00.000Z");
const staticTokens = { async getToken() { return "service-token"; }, invalidate() {} };

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "meeting_job", "meeting", "hours_notice" CASCADE');
  setHoursChannelForTests({ baseUrl: "http://127.0.0.1:1", tokens: staticTokens });
});
afterEach(() => setHoursChannelForTests(undefined));
afterAll(async () => {
  await db.$disconnect();
});

async function seed(over: Record<string, unknown> = {}, participants: string[] = []) {
  const meeting = await db.meeting.create({
    data: {
      title: "Budget review",
      format: "online",
      startsAt: new Date("2026-11-24T09:00:00.000Z"),
      language: "en",
      source: "recorded",
      creatorUserId: "creator-1",
      ...over,
    } as never,
  });
  for (const userId of participants) await db.meetingParticipant.create({ data: { meetingId: meeting.id, userId, addedBy: "creator-1" } });
  return meeting;
}

/** What a write path does: snapshot, write, record, all in one transaction. */
async function write(meetingId: string, change: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>, now = NOW) {
  return db.$transaction(async (tx) => {
    const before = await readHoursFacts(tx, meetingId);
    await change(tx);
    return recordHoursNotice(tx, meetingId, { before }, now);
  });
}
const erase = (meetingId: string, now = NOW) =>
  db.$transaction(async (tx) => {
    const recorded = await recordHoursNotice(tx, meetingId, { deleted: true } satisfies HoursChange, now);
    await tx.meeting.delete({ where: { id: meetingId } });
    return recorded;
  });

const notices = (meetingId: string) => db.hoursNotice.findMany({ where: { meetingId }, orderBy: { seq: "asc" } });
const jobs = () => db.meetingJob.findMany({ orderBy: { createdAt: "asc" } });
const seqOf = async (id: string) => (await db.meeting.findUniqueOrThrow({ where: { id } })).hoursSeq;

describe("a hours fact changed and a duration exists (AC-1.1, AC-3.1, AC-3.2, AC-3.3)", () => {
  it("leaves one `state` notice at the next version and one until-delivered job that carries the notice's id and no meeting id", async () => {
    const m = await seed({ durationMs: null });
    const recorded = await write(m.id, async (tx) => void (await tx.meeting.update({ where: { id: m.id }, data: { durationMs: 1_800_000 } })));

    expect(recorded).toBe(true);
    expect(await seqOf(m.id)).toBe(1);
    const [notice, ...rest] = await notices(m.id);
    expect(rest).toHaveLength(0);
    expect(notice).toMatchObject({ meetingId: m.id, seq: 1, kind: "state", state: "pending", attempts: 0, lastErrorCode: null });
    const queued = await jobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "deliver_hours_notice", noticeId: notice!.id, meetingId: null, state: "queued", maxAttempts: HOURS_NOTICE_MAX_ATTEMPTS });
    expect(queued[0]!.runAfter).toEqual(NOW);
  });

  it("takes the next version for each change: 1, then 2, and the meeting row says 2", async () => {
    const m = await seed({ durationMs: 1_800_000 });
    await write(m.id, async (tx) => void (await tx.meeting.update({ where: { id: m.id }, data: { durationMs: 3_600_000 } })));
    await write(m.id, async (tx) => void (await tx.meeting.update({ where: { id: m.id }, data: { startsAt: new Date("2026-11-23T09:00:00.000Z") } })));
    expect((await notices(m.id)).map((n) => n.seq)).toEqual([1, 2]);
    expect(await seqOf(m.id)).toBe(2);
    expect(await jobs()).toHaveLength(2);
  });

  it("a new `startsAt` is a hours fact", async () => {
    const m = await seed({ durationMs: 1_800_000 });
    expect(await write(m.id, async (tx) => void (await tx.meeting.update({ where: { id: m.id }, data: { startsAt: new Date("2026-11-20T09:00:00.000Z") } })))).toBe(true);
  });

  it("a different set of Operai participants is a hours fact, whoever is added or removed", async () => {
    const m = await seed({ durationMs: 1_800_000 }, ["pat"]);
    expect(await write(m.id, async (tx) => void (await tx.meetingParticipant.create({ data: { meetingId: m.id, userId: "quinn", addedBy: "creator-1" } })))).toBe(true);
    expect(await write(m.id, async (tx) => void (await tx.meetingParticipant.deleteMany({ where: { meetingId: m.id, userId: "pat" } })))).toBe(true);
    expect((await notices(m.id)).map((n) => n.seq)).toEqual([1, 2]);
  });

  it("a duration that is no longer known is still announced, so hours-api can take the entries back (AC-1.3, plan: before OR after)", async () => {
    const m = await seed({ durationMs: 10_000_000 });
    expect(await write(m.id, async (tx) => void (await tx.meeting.update({ where: { id: m.id }, data: { durationMs: null } })))).toBe(true);
    expect(await notices(m.id)).toHaveLength(1);
  });
});

describe("what is not a hours fact, or has no duration, leaves nothing (AC-1.3)", () => {
  it("a write that changes none of them (a title) leaves no notice and no version", async () => {
    const m = await seed({ durationMs: 1_800_000 }, ["pat"]);
    expect(await write(m.id, async (tx) => void (await tx.meeting.update({ where: { id: m.id }, data: { title: "Renamed" } })))).toBe(false);
    expect(await notices(m.id)).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
    expect(await seqOf(m.id)).toBe(0);
  });

  it("the same people in another order, or an external participant added, is no change", async () => {
    const m = await seed({ durationMs: 1_800_000 }, ["pat", "quinn"]);
    const recorded = await write(m.id, async (tx) => {
      await tx.meetingParticipant.deleteMany({ where: { meetingId: m.id } });
      await tx.meetingParticipant.create({ data: { meetingId: m.id, userId: "quinn", addedBy: "creator-1" } });
      await tx.meetingParticipant.create({ data: { meetingId: m.id, userId: "pat", addedBy: "creator-1" } });
      await tx.meetingParticipant.create({ data: { meetingId: m.id, externalName: "Dana", addedBy: "creator-1" } });
    });
    expect(recorded).toBe(false);
    expect(await seqOf(m.id)).toBe(0);
  });

  it("a change on a meeting that has no duration before and none after (a text meeting, an unprocessed one) leaves nothing", async () => {
    const m = await seed({ source: "text", durationMs: null });
    const recorded = await write(m.id, async (tx) => {
      await tx.meeting.update({ where: { id: m.id }, data: { startsAt: new Date("2026-11-20T09:00:00.000Z") } });
      await tx.meetingParticipant.create({ data: { meetingId: m.id, userId: "pat", addedBy: "creator-1" } });
    });
    expect(recorded).toBe(false);
    expect(await notices(m.id)).toHaveLength(0);
    expect(await seqOf(m.id)).toBe(0);
  });

  it("a duration of zero is a duration that exists: hours-api reads it as not known, meetings-api does not decide that", async () => {
    const m = await seed({ durationMs: null });
    expect(await write(m.id, async (tx) => void (await tx.meeting.update({ where: { id: m.id }, data: { durationMs: 0 } })))).toBe(true);
  });
});

describe("a deletion (AC-3.4)", () => {
  it("leaves a `deleted` notice at the next version when something was announced before, and the notice and its job outlive the meeting", async () => {
    const m = await seed({ durationMs: 1_800_000, hoursSeq: 3 });
    expect(await erase(m.id)).toBe(true);

    expect(await db.meeting.count({ where: { id: m.id } })).toBe(0);
    const [notice, ...rest] = await notices(m.id);
    expect(rest).toHaveLength(0);
    expect(notice).toMatchObject({ meetingId: m.id, seq: 4, kind: "deleted", state: "pending" });
    const queued = await jobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "deliver_hours_notice", noticeId: notice!.id, meetingId: null, state: "queued", maxAttempts: HOURS_NOTICE_MAX_ATTEMPTS });
  });

  it("leaves nothing for a meeting that was never announced (version 0): hours-api knows nothing of it", async () => {
    const m = await seed({ durationMs: null });
    expect(await erase(m.id)).toBe(false);
    expect(await notices(m.id)).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
  });

  it("an unknown meeting leaves nothing and does not throw", async () => {
    expect(await db.$transaction((tx) => recordHoursNotice(tx, "no-such-meeting", { deleted: true }, NOW))).toBe(false);
    expect(await db.hoursNotice.count()).toBe(0);
  });
});

describe("the hours channel is off (plan § Delivering a notice: disabled channel records nothing)", () => {
  it("writes no notice, no job and no version, for a state change and for a deletion", async () => {
    setHoursChannelForTests(null);
    const m = await seed({ durationMs: null, hoursSeq: 2 });
    expect(await write(m.id, async (tx) => void (await tx.meeting.update({ where: { id: m.id }, data: { durationMs: 1_800_000 } })))).toBe(false);
    expect(await erase(m.id)).toBe(false);
    expect(await db.hoursNotice.count()).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect((await db.meeting.count({ where: { id: m.id } }))).toBe(0);
  });

  it("keeps the version where it was", async () => {
    setHoursChannelForTests(null);
    const m = await seed({ durationMs: null, hoursSeq: 2 });
    await write(m.id, async (tx) => void (await tx.meeting.update({ where: { id: m.id }, data: { durationMs: 1_800_000 } })));
    expect(await seqOf(m.id)).toBe(2);
  });
});

describe("the notice is written in the change's own transaction", () => {
  it("a rollback after it leaves no notice, no job and no version (nothing announced for a change that did not happen)", async () => {
    const m = await seed({ durationMs: null });
    await expect(
      db.$transaction(async (tx) => {
        const before = await readHoursFacts(tx, m.id);
        await tx.meeting.update({ where: { id: m.id }, data: { durationMs: 1_800_000 } });
        expect(await recordHoursNotice(tx, m.id, { before }, NOW)).toBe(true);
        throw new Error("the write failed after the notice");
      }),
    ).rejects.toThrow("the write failed after the notice");

    expect(await db.hoursNotice.count()).toBe(0);
    expect(await jobs()).toHaveLength(0);
    expect(await seqOf(m.id)).toBe(0);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).durationMs).toBeNull();
  });
});

describe("a meeting whose day is still ahead (A37)", () => {
  const writeDuration = (id: string, startsAt: string) =>
    write(id, async (tx) => void (await tx.meeting.update({ where: { id }, data: { startsAt: new Date(startsAt), durationMs: 1_800_000 } })));

  it("leaves a second `state` row at the same version and a second job due at 00:01 Zurich of that day, besides the immediate one", async () => {
    const m = await seed({ durationMs: null });
    // Thursday 26 Nov in Zurich (CET, UTC+1): it starts to count at 00:01 CET, 23:01Z the evening before.
    await writeDuration(m.id, "2026-11-26T09:00:00.000Z");

    const rows = await notices(m.id);
    expect(rows.map((r) => [r.seq, r.kind])).toEqual([[1, "state"], [1, "state"]]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    const queued = await jobs();
    expect(queued).toHaveLength(2);
    const byNotice = new Map(queued.map((j) => [j.noticeId, j]));
    expect([...byNotice.keys()].sort()).toEqual(rows.map((r) => r.id).sort());
    const runs = queued.map((j) => j.runAfter.toISOString()).sort();
    expect(runs).toEqual([NOW.toISOString(), "2026-11-25T23:01:00.000Z"]);
    expect(queued.every((j) => j.kind === "deliver_hours_notice" && j.meetingId === null && j.maxAttempts === HOURS_NOTICE_MAX_ATTEMPTS)).toBe(true);
    // One version for the change, not one per row.
    expect(await seqOf(m.id)).toBe(1);
  });

  it("uses the Zurich day, not the UTC one: 23:30Z today is already tomorrow in Zurich", async () => {
    const m = await seed({ durationMs: null });
    await writeDuration(m.id, "2026-11-24T23:30:00.000Z");
    expect((await jobs()).map((j) => j.runAfter.toISOString()).sort()).toEqual([NOW.toISOString(), "2026-11-24T23:01:00.000Z"]);
  });

  it("uses the offset in force that day: 00:01 CEST in July is 22:01Z", async () => {
    const m = await seed({ durationMs: null });
    await writeDuration(m.id, "2027-07-15T09:00:00.000Z");
    expect((await jobs()).map((j) => j.runAfter.toISOString()).sort()).toEqual([NOW.toISOString(), "2027-07-14T22:01:00.000Z"]);
  });

  it("a meeting today in Zurich, or in the past, gets the one immediate notice only", async () => {
    const today = await seed({ durationMs: null });
    await writeDuration(today.id, "2026-11-24T22:30:00.000Z"); // 23:30 Zurich, still the 24th
    const past = await seed({ durationMs: null });
    await writeDuration(past.id, "2026-11-20T09:00:00.000Z");
    expect(await notices(today.id)).toHaveLength(1);
    expect(await notices(past.id)).toHaveLength(1);
    expect(await jobs()).toHaveLength(2);
  });

  it("a deletion never gets a second one", async () => {
    const m = await seed({ durationMs: 1_800_000, hoursSeq: 1, startsAt: new Date("2026-11-30T09:00:00.000Z") });
    await erase(m.id);
    expect(await notices(m.id)).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
  });
});
