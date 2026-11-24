import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeTransientStorage } from "../lib/google/fakeTransientStorage";
import { setTransientStorageForTests } from "../lib/google/transientStorage";
import { createPrepareAudio } from "../jobs/handlers/prepareAudio";
import type { JobContext } from "../jobs/runner";
import { NormalizeError, type NormalizeRequest } from "../media/normalize";
import { setProberForTests } from "../media/probe";
import { startFakeHours, type FakeHours } from "../test-support/fakeHours";
import { createKit, type Kit } from "../test-support/routeKit";
import { setHoursChannelForTests } from "./client";
import { attemptHoursDelivery } from "./delivery";

// The seven write paths that announce a meeting's hours to hours-api (specs/20261112-meeting-hours T9; plan § "Where meetings-api
// records a notice"; AC-1.1, AC-1.3, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-3.7): each is driven through its public interface, the
// REAL assembled app (or, for `prepare_audio`, its job handler) over the real database, and what it leaves in `hours_notice` and
// `meeting_job` is read back. WHEN the function records is proven on its own in `record.test.ts`; here it is proven that each path
// calls it, once, in its own transaction, and that the paths which change no hours fact do not.
//
// "Delivered" means: the outbox's own delivery (`attemptHoursDelivery`, T8) run against a fake hours-api that parses every body
// with the shared wire schema, so the body is one hours-api accepts.

const kit: Kit = await createKit();

const CREATOR = "creator";
const staticTokens = { async getToken() { return "service-token"; }, invalidate() {} };

let fake: FakeHours;
let spies: ReturnType<typeof spyOn>[];
let tmpRoot: string;

beforeAll(async () => {
  // A leftover of an earlier killed run would make every `prepare_audio` insert fail.
  await kit.db.$executeRawUnsafe('DROP TRIGGER IF EXISTS t9_forced_failure ON "meeting_job"');
});
beforeEach(async () => {
  await kit.reset();
  for (const user of [CREATOR, "pat", "quinn", "stranger"]) kit.grant(user, "access");
  kit.grant("eraser", "erase");
  fake = startFakeHours();
  setHoursChannelForTests({ baseUrl: fake.url, tokens: staticTokens });
  setTransientStorageForTests(createFakeTransientStorage());
  tmpRoot = mkdtempSync(join(tmpdir(), "hours-triggers-"));
  spies = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(async () => {
  spies.forEach((s) => s.mockRestore());
  setHoursChannelForTests(undefined);
  setTransientStorageForTests(null);
  setProberForTests(null);
  await fake.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});
afterAll(async () => {
  await kit.db.$disconnect();
});

const json = async (res: Response) => (await res.json()) as Record<string, any>;

/** A meeting the creator owns, consented, recorded; `ready` with a 30 min duration unless told otherwise. */
async function seed(over: Record<string, unknown> = {}) {
  return kit.db.meeting.create({
    data: {
      title: "Weekly sync",
      format: "online",
      startsAt: new Date("2026-11-05T09:00:00.000Z"),
      language: "en",
      source: "recorded",
      creatorUserId: CREATOR,
      consentUserId: CREATOR,
      consentAt: new Date("2026-11-05T09:00:00.000Z"),
      consentNoticeVersion: "v1",
      status: "ready",
      durationMs: 1_800_000,
      ...over,
    } as never,
  });
}
/** A typed or pasted meeting: no consent (a constraint), and never a duration. */
const seedText = (over: Record<string, unknown> = {}) =>
  seed({ source: "text", durationMs: null, consentUserId: null, consentAt: null, consentNoticeVersion: null, ...over });
const withParticipants = async (meetingId: string, ...userIds: string[]) => {
  for (const userId of userIds) await kit.db.meetingParticipant.create({ data: { meetingId, userId, addedBy: CREATOR } });
};

const noticeRows = (meetingId: string) => kit.db.hoursNotice.findMany({ where: { meetingId }, orderBy: [{ seq: "asc" }, { createdAt: "asc" }] });
const hoursJobs = () => kit.db.meetingJob.findMany({ where: { kind: "deliver_hours_notice" } });
const hoursSeq = async (id: string) => (await kit.db.meeting.findUniqueOrThrow({ where: { id } })).hoursSeq;

/**
 * Exactly these notices exist for the meeting, all pending, and each has exactly one until-delivered job carrying its id and no
 * meeting id (so the cascade of a deleted meeting cannot take it away). Returns the notice rows.
 */
async function expectNotices(meetingId: string, expected: { seq: number; kind: "state" | "deleted" }[]) {
  const rows = await noticeRows(meetingId);
  expect(rows.map((r) => ({ seq: r.seq, kind: r.kind, state: r.state }))).toEqual(expected.map((e) => ({ ...e, state: "pending" })));
  const jobs = await hoursJobs();
  expect(jobs.map((j) => j.noticeId).sort()).toEqual(rows.map((r) => r.id).sort());
  expect(jobs.every((j) => j.meetingId === null && j.state === "queued" && j.maxAttempts === 1_000_000)).toBe(true);
  return rows;
}
async function expectNoNotice(meetingId: string) {
  expect(await noticeRows(meetingId)).toHaveLength(0);
  expect(await hoursJobs()).toHaveLength(0);
}

/** Delivers the notice through the outbox's own delivery and returns what the fake hours-api accepted. */
async function deliver(noticeId: string) {
  expect(await attemptHoursDelivery(noticeId)).toMatchObject({ state: "delivered" });
  return fake.accepted[fake.accepted.length - 1]!;
}

// ─── 1. Recording stop (and process) ─────────────────────────────────────────

const chunkKey = (id: string, seq: number) => `meetings/${id}/chunks/${String(seq).padStart(6, "0")}`;

/** A meeting being recorded with `count` stored chunks of 10 s each (a 30 s recording by default). */
async function recording(count = 3, lastBeatAgoMs = 0) {
  const m = await seed({ status: "recording", durationMs: null });
  const session = await kit.db.recordingSession.create({ data: { meetingId: m.id, lastBeatAt: new Date(Date.now() - lastBeatAgoMs), capturedMs: 90_000 } });
  for (let seq = 0; seq < count; seq++) {
    kit.storage.put(chunkKey(m.id, seq), 1000, "audio/webm");
    await kit.db.recordingChunk.create({
      data: { meetingId: m.id, seq, sessionId: session.id, objectKey: chunkKey(m.id, seq), sizeBytes: 1000, durationMs: 10_000, storedAt: new Date() },
    });
  }
  return { m, sessionId: session.id };
}
const stop = (id: string, body: Record<string, unknown>) => kit.call(CREATOR, "POST", `/meetings/${id}/recording/stop`, body);

describe("recording stop: the duration becomes known (AC-1.1)", () => {
  it("records exactly one notice for the stop, and delivers the facts of the recording with the creator and the Operai participants", async () => {
    const { m, sessionId } = await recording();
    await withParticipants(m.id, "pat");
    await kit.db.meetingParticipant.create({ data: { meetingId: m.id, externalName: "Dana Outsider", addedBy: CREATOR } });

    const res = await stop(m.id, { sessionId, lastSeq: 2 });
    expect(res.status).toBe(202);

    const [notice] = await expectNotices(m.id, [{ seq: 1, kind: "state" }]);
    expect(await hoursSeq(m.id)).toBe(1);
    const sent = await deliver(notice!.id);
    expect(sent.meeting).toEqual({
      id: m.id,
      seq: 1,
      facts: { startsAt: "2026-11-05T09:00:00.000Z", durationMs: 30_000, creatorId: CREATOR, participantIds: ["pat"] },
    });
  });

  it("a stop whose answer was lost and is repeated announces nothing a second time", async () => {
    const { m, sessionId } = await recording();
    expect((await stop(m.id, { sessionId, lastSeq: 2 })).status).toBe(202);
    expect((await stop(m.id, { sessionId, lastSeq: 2 })).status).toBe(202);
    await expectNotices(m.id, [{ seq: 1, kind: "state" }]);
  });

  it("a stop refused for missing chunks announces nothing", async () => {
    const { m, sessionId } = await recording(2);
    expect((await stop(m.id, { sessionId, lastSeq: 4 })).status).toBe(409);
    await expectNoNotice(m.id);
    expect(await hoursSeq(m.id)).toBe(0);
  });

  it("processing an interrupted recording is the same tail and announces once", async () => {
    const { m } = await recording(3, 5 * 60_000);
    const res = await kit.call(CREATOR, "POST", `/meetings/${m.id}/recording/process`);
    expect(res.status).toBe(202);
    const [notice] = await expectNotices(m.id, [{ seq: 1, kind: "state" }]);
    expect((await deliver(notice!.id)).meeting.facts?.durationMs).toBe(30_000);
  });
});

// ─── 2. Upload confirm ───────────────────────────────────────────────────────

const MiB = 1024 * 1024;
/** A draft upload whose object reached the bucket, confirmed with the prober saying `durationMs`. */
async function confirmUpload(durationMs: number | null) {
  const m = await seed({ source: "uploaded", status: "draft", durationMs: null });
  const minted = await kit.call(CREATOR, "POST", `/meetings/${m.id}/upload`, { contentType: "video/mp4", sizeBytes: 5 * MiB });
  expect(minted.status).toBe(200);
  kit.storage.put((await json(minted))["fields"]["key"], 5 * MiB, "video/mp4");
  setProberForTests(async () => ({ ok: true, durationMs, format: "mov,mp4,m4a,3gp,3g2,mj2" }));
  const res = await kit.call(CREATOR, "POST", `/meetings/${m.id}/upload/confirm`);
  return { m, res };
}

describe("upload confirm (AC-1.1)", () => {
  it("with a probed duration: exactly one notice, and the delivered duration is the probed one", async () => {
    const { m, res } = await confirmUpload(2_700_000);
    expect(res.status).toBe(202);
    const [notice] = await expectNotices(m.id, [{ seq: 1, kind: "state" }]);
    expect((await deliver(notice!.id)).meeting.facts).toMatchObject({ durationMs: 2_700_000, creatorId: CREATOR, participantIds: [] });
  });

  it("with no duration probed (a browser-saved WebM): nothing yet; `prepare_audio` will announce it once it has measured it (AC-1.3)", async () => {
    const { m, res } = await confirmUpload(null);
    expect(res.status).toBe(202);
    await expectNoNotice(m.id);
    expect(await hoursSeq(m.id)).toBe(0);
  });

  it("confirming again after it went through announces nothing more", async () => {
    const { m } = await confirmUpload(60_000);
    expect((await kit.call(CREATOR, "POST", `/meetings/${m.id}/upload/confirm`)).status).toBe(202);
    await expectNotices(m.id, [{ seq: 1, kind: "state" }]);
  });
});

// ─── 3 and 4. prepare_audio: the fill, and the too-long refusal ──────────────

const ctxFor = (meetingId: string): JobContext => ({
  job: { id: "job-1", kind: "prepare_audio", meetingId, summaryId: null, noticeId: null, attemptId: null, attempts: 1, maxAttempts: 3 },
  attemptId: null,
  attempt: 1,
  signal: new AbortController().signal,
  commit: async (fn) => ({ committed: true, value: await kit.db.$transaction(fn) }),
});

/** A processing upload (the original is in the bucket), with these meeting fields. */
async function processingUpload(over: Record<string, unknown> = {}) {
  const m = await seed({ source: "uploaded", status: "processing", stage: "preparing", durationMs: null, processingStartedAt: new Date(), ...over });
  const objectKey = `meetings/${m.id}/upload/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  kit.storage.put(objectKey, 3, "audio/mpeg", Uint8Array.from([1, 2, 3]));
  await kit.db.meetingUpload.create({ data: { meetingId: m.id, objectKey, contentType: "audio/mpeg", sizeBytes: 3 } });
  return m;
}
const measuring = (durationMs: number) =>
  createPrepareAudio({
    storage: () => kit.storage,
    tmpRoot,
    announce: () => {},
    probe: async () => ({ ok: true, durationMs: null, format: "wav" }),
    normalize: async (req: NormalizeRequest) => {
      writeFileSync(req.output, "OggS");
      return { durationMs };
    },
  });

describe("prepare_audio fills a null duration (AC-3.2)", () => {
  it("records exactly one notice when it wrote the duration, and delivers the measured one", async () => {
    const m = await processingUpload();
    await measuring(2_700_000)(ctxFor(m.id));

    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).durationMs).toBe(2_700_000);
    const [notice] = await expectNotices(m.id, [{ seq: 1, kind: "state" }]);
    expect((await deliver(notice!.id)).meeting.facts?.durationMs).toBe(2_700_000);
    // The job it queued for the next step is not the hours job.
    expect(await kit.db.meetingJob.count({ where: { meetingId: m.id, kind: "transcribe" } })).toBe(1);
  });

  // AC-3.10: a measurement within the margin (here 2 s of 60 s: under the 30 s floor) leaves the held duration alone, so the step wrote none.
  // A held duration the audio contradicts beyond the margin is replaced and announced instead (AC-3.8, AC-3.9): `prepareAudio.measured.test.ts`.
  it("records nothing when the duration was already known and it wrote none (a recording, or an upload probed at confirm)", async () => {
    const m = await processingUpload({ durationMs: 60_000, hoursSeq: 1 });
    await measuring(62_000)(ctxFor(m.id));
    expect((await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).durationMs).toBe(60_000);
    await expectNoNotice(m.id);
    expect(await hoursSeq(m.id)).toBe(1);
  });
});

describe("prepare_audio refuses an upload that decodes past 3 h (AC-1.3)", () => {
  const tooLong = () =>
    createPrepareAudio({
      storage: () => kit.storage,
      tmpRoot,
      announce: () => {},
      probe: async () => ({ ok: true, durationMs: 1000, format: "matroska" }),
      normalize: async () => {
        throw new NormalizeError("too_long");
      },
    });

  it("a duration announced at confirm and taken back: exactly one notice, delivered with `durationMs: null`", async () => {
    // The confirm-time probe stated 2 h 30 and announced it (version 1); the decode then said it is longer than 3 h.
    const m = await processingUpload({ durationMs: 9_000_000, hoursSeq: 1 });
    await expect(tooLong()(ctxFor(m.id))).rejects.toThrow();

    expect(await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "draft", durationMs: null, failureCode: "too_long" });
    const [notice] = await expectNotices(m.id, [{ seq: 2, kind: "state" }]);
    expect((await deliver(notice!.id)).meeting).toEqual({
      id: m.id,
      seq: 2,
      facts: { startsAt: "2026-11-05T09:00:00.000Z", durationMs: null, creatorId: CREATOR, participantIds: [] },
    });
  });

  it("an upload that never had a duration announces nothing when refused", async () => {
    const m = await processingUpload({ durationMs: null });
    await expect(tooLong()(ctxFor(m.id))).rejects.toThrow();
    await expectNoNotice(m.id);
  });
});

// ─── 5. PATCH of startsAt ────────────────────────────────────────────────────

const patch = (id: string, body: Record<string, unknown>) => kit.call(CREATOR, "PATCH", `/meetings/${id}`, body);

describe("PATCH /meetings/:id (AC-3.1)", () => {
  it("a new `startsAt` records exactly one notice, delivered with the new start", async () => {
    const m = await seed();
    expect((await patch(m.id, { startsAt: "2026-11-06T10:30:00.000Z" })).status).toBe(200);
    const [notice] = await expectNotices(m.id, [{ seq: 1, kind: "state" }]);
    expect((await deliver(notice!.id)).meeting.facts).toMatchObject({ startsAt: "2026-11-06T10:30:00.000Z", durationMs: 1_800_000 });
  });

  it("a start on a later Zurich day also queues the delivery for 00:01 of that day (A37), the clock being the request's", async () => {
    const m = await seed();
    // Far ahead of any clock: 15 Jan 2099 in Zurich (CET) begins to count at 14 Jan 23:01Z.
    expect((await patch(m.id, { startsAt: "2099-01-15T09:00:00.000Z" })).status).toBe(200);
    await expectNotices(m.id, [{ seq: 1, kind: "state" }, { seq: 1, kind: "state" }]);
    expect((await hoursJobs()).map((j) => j.runAfter.toISOString()).filter((at) => at.startsWith("2099")))
      .toEqual(["2099-01-14T23:01:00.000Z"]);
  });

  it("a title-only PATCH, a format change, and the same `startsAt` again record nothing", async () => {
    const m = await seed();
    expect((await patch(m.id, { title: "A better title" })).status).toBe(200);
    expect((await patch(m.id, { format: "in_person" })).status).toBe(200);
    expect((await patch(m.id, { startsAt: "2026-11-05T09:00:00.000Z" })).status).toBe(200);
    await expectNoNotice(m.id);
    expect(await hoursSeq(m.id)).toBe(0);
  });

  it("a new `startsAt` on a meeting that never had a duration (a typed one, an unprocessed one) records nothing", async () => {
    const m = await seedText();
    expect((await patch(m.id, { startsAt: "2026-11-06T10:30:00.000Z" })).status).toBe(200);
    await expectNoNotice(m.id);
    expect(await hoursSeq(m.id)).toBe(0);
  });

  it("a PATCH that is refused announces nothing", async () => {
    const m = await seed();
    expect((await patch(m.id, { startsAt: "not a date" })).status).toBe(422);
    expect((await kit.call("stranger", "PATCH", `/meetings/${m.id}`, { startsAt: "2026-11-06T10:30:00.000Z" })).status).toBe(404);
    await expectNoNotice(m.id);
  });
});

// ─── 6. Participants ─────────────────────────────────────────────────────────

const put = (id: string, participants: unknown[]) => kit.call(CREATOR, "PUT", `/meetings/${id}/participants`, { participants });

describe("PUT /meetings/:id/participants (AC-3.3, AC-3.7)", () => {
  it("a change of the Operai users records exactly one notice, delivered with the new list; one more change is the next version", async () => {
    const m = await seed();
    expect((await put(m.id, [{ userId: "pat" }])).status).toBe(200);
    const [first] = await expectNotices(m.id, [{ seq: 1, kind: "state" }]);
    expect((await deliver(first!.id)).meeting.facts?.participantIds).toEqual(["pat"]);

    expect((await put(m.id, [{ userId: "quinn" }])).status).toBe(200);
    const rows = await noticeRows(m.id);
    expect(rows.map((r) => r.seq)).toEqual([2]); // the first was delivered and settled
    expect((await deliver(rows[0]!.id)).meeting).toMatchObject({ seq: 2, facts: { participantIds: ["quinn"] } });
  });

  it("removing the last Operai participant is a change too (they lose the untouched entry)", async () => {
    const m = await seed();
    await withParticipants(m.id, "pat");
    expect((await put(m.id, [])).status).toBe(200);
    const [notice] = await expectNotices(m.id, [{ seq: 1, kind: "state" }]);
    expect((await deliver(notice!.id)).meeting.facts?.participantIds).toEqual([]);
  });

  it("a PUT that only changes the externals, or re-saves the same list, records nothing", async () => {
    const m = await seed();
    await withParticipants(m.id, "pat");
    expect((await put(m.id, [{ userId: "pat" }, { name: "Dana Outsider", organisation: "Acme" }])).status).toBe(200);
    expect((await put(m.id, [{ name: "Eli" }, { userId: "pat" }])).status).toBe(200);
    expect((await put(m.id, [{ userId: "pat" }])).status).toBe(200);
    await expectNoNotice(m.id);
    expect(await hoursSeq(m.id)).toBe(0);
  });

  it("a change on a meeting that never had a duration records nothing", async () => {
    const m = await seedText();
    expect((await put(m.id, [{ userId: "pat" }])).status).toBe(200);
    await expectNoNotice(m.id);
  });

  it("a refused PUT (an inactive user) announces nothing", async () => {
    const m = await seed();
    kit.deactivate("quinn");
    expect((await put(m.id, [{ userId: "quinn" }])).status).toBe(422);
    await expectNoNotice(m.id);
  });
});

// ─── 7. Delete ───────────────────────────────────────────────────────────────

describe("DELETE /meetings/:id (AC-3.4)", () => {
  it("by the creator: a `deleted` notice at the next version, written in the transaction and still there after the cascade, delivered with `facts: null`", async () => {
    const m = await seed({ hoursSeq: 2 });
    await withParticipants(m.id, "pat");
    expect((await kit.call(CREATOR, "DELETE", `/meetings/${m.id}`)).status).toBe(204);

    expect(await kit.db.meeting.count({ where: { id: m.id } })).toBe(0);
    const [notice] = await expectNotices(m.id, [{ seq: 3, kind: "deleted" }]);
    expect((await deliver(notice!.id)).meeting).toEqual({ id: m.id, seq: 3, facts: null });
  });

  it("through `meeting:erase`: the same", async () => {
    const m = await seed({ hoursSeq: 1 });
    expect((await kit.call("eraser", "DELETE", `/meetings/${m.id}`)).status).toBe(204);
    const [notice] = await expectNotices(m.id, [{ seq: 2, kind: "deleted" }]);
    expect((await deliver(notice!.id)).meeting).toEqual({ id: m.id, seq: 2, facts: null });
  });

  it("a meeting that was never announced (version 0) is deleted without a notice", async () => {
    const m = await seedText();
    expect((await kit.call(CREATOR, "DELETE", `/meetings/${m.id}`)).status).toBe(204);
    await expectNoNotice(m.id);
  });

  it("a delete the storage refuses (503, nothing deleted) announces nothing", async () => {
    const m = await seed({ hoursSeq: 1 });
    kit.storage.failWith(new Error("bucket down"));
    expect((await kit.call(CREATOR, "DELETE", `/meetings/${m.id}`)).status).toBe(503);
    expect(await kit.db.meeting.count({ where: { id: m.id } })).toBe(1);
    await expectNoNotice(m.id);
    expect(await hoursSeq(m.id)).toBe(1);
  });
});

// ─── Not a hours fact ────────────────────────────────────────────────────────

describe("a text meeting never records one (AC-1.3)", () => {
  it("typing or pasting the text announces nothing", async () => {
    const m = await seedText({ status: "draft" });
    const res = await kit.call(CREATOR, "PUT", `/meetings/${m.id}/text`, { text: "First paragraph.\n\nSecond paragraph." });
    expect(res.status).toBe(200);
    await expectNoNotice(m.id);
    expect(await hoursSeq(m.id)).toBe(0);
  });
});

// ─── The notice is part of the change ────────────────────────────────────────

describe("the notice is written in the change's own transaction", () => {
  afterEach(async () => {
    await kit.db.$executeRawUnsafe('DROP TRIGGER IF EXISTS t9_forced_failure ON "meeting_job"');
    await kit.db.$executeRawUnsafe("DROP FUNCTION IF EXISTS t9_forced_failure()");
  });

  it("a stop that fails after the notice was written (the next job cannot be queued) leaves no notice, no hours job, no version and the recording as it was", async () => {
    const { m, sessionId } = await recording();
    await kit.db.$executeRawUnsafe(
      "CREATE FUNCTION t9_forced_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure after the hours notice'; END $$",
    );
    await kit.db.$executeRawUnsafe(
      `CREATE TRIGGER t9_forced_failure BEFORE INSERT ON "meeting_job" FOR EACH ROW WHEN (NEW."kind" = 'prepare_audio') EXECUTE FUNCTION t9_forced_failure()`,
    );

    const res = await stop(m.id, { sessionId, lastSeq: 2 });
    expect(res.status).toBe(500);

    await expectNoNotice(m.id);
    expect(await hoursSeq(m.id)).toBe(0);
    expect(await kit.db.meeting.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "recording", durationMs: null });
  });
});
