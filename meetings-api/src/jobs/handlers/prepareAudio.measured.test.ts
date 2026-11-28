import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHoursChannelForTests } from "../../hours/client";
import { attemptHoursDelivery } from "../../hours/delivery";
import { NormalizeError, type NormalizeRequest } from "../../media/normalize";
import { startFakeHours, type FakeHours } from "../../test-support/fakeHours";
import { createKit, type Kit } from "../../test-support/routeKit";
import type { JobContext } from "../runner";
import { createPrepareAudio } from "./prepareAudio";

// The measured duration (specs/20261112-meeting-hours AC-3.8, AC-3.9, AC-3.10, AC-3.2; plan § The measured duration, D-P6, D-P10,
// R10; ADR 20261124-a-duration-a-client-reports-is-replaced-by-the-one-the-server-measures-when-they-differ-by-more-than-the-larger-of-30-seconds-and-10-percent):
// `prepare_audio`'s one commit takes the duration it measured from the audio when it differs from the held one by more than the
// larger of 30 s and 10 %, BEFORE the meeting leaves `processing`, and tells hours-api through the notice that every change of a
// hours fact already records. The rule itself is `media/measuredDuration.test.ts`; this file proves where and how it is applied.
//
// The real database (`meetings_test`), the real assembled app for what the meeting view answers, and a fake hours-api that parses
// every body with the shared wire schema. The ffmpeg step and the probe are injected; storage is the in-memory fake.

const kit: Kit = await createKit();

const CREATOR = "creator";
const MIN = 60_000;
const HOUR = 60 * MIN;
const staticTokens = { async getToken() { return "service-token"; }, invalidate() {} };
const CORRECTED = "[prepare_audio] duration_corrected";

let fake: FakeHours;
let tmpRoot: string;
let logSpy: ReturnType<typeof spyOn>;
let spies: ReturnType<typeof spyOn>[];

beforeEach(async () => {
  await kit.reset();
  kit.grant(CREATOR, "access");
  fake = startFakeHours();
  setHoursChannelForTests({ baseUrl: fake.url, tokens: staticTokens });
  tmpRoot = mkdtempSync(join(tmpdir(), "prepare-measured-"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  spies = [logSpy, spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
});
afterEach(async () => {
  spies.forEach((s) => s.mockRestore());
  setHoursChannelForTests(undefined);
  await fake.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});
afterAll(async () => {
  await kit.db.$disconnect();
});

const json = async (res: Response) => (await res.json()) as Record<string, any>;
const reread = (id: string) => kit.db.meeting.findUniqueOrThrow({ where: { id } });
const noticeRows = (meetingId: string) => kit.db.hoursNotice.findMany({ where: { meetingId }, orderBy: { seq: "asc" } });
const correctionLines = () => (logSpy.mock.calls as unknown[][]).filter((line) => line[0] === CORRECTED);

const ctxFor = (meetingId: string): JobContext => ({
  job: { id: "job-1", kind: "prepare_audio", meetingId, summaryId: null, noticeId: null, attemptId: null, attempts: 1, maxAttempts: 3 },
  attemptId: null,
  attempt: 1,
  signal: new AbortController().signal,
  commit: async (fn) => ({ committed: true, value: await kit.db.$transaction(fn) }),
});

/** `prepare_audio` whose ffmpeg step "decodes" these milliseconds of audio. */
const measuring = (measuredMs: number, before?: () => Promise<void>) =>
  createPrepareAudio({
    storage: () => kit.storage,
    tmpRoot,
    announce: () => {},
    probe: async () => ({ ok: true, durationMs: null, format: "wav" }),
    normalize: async (req: NormalizeRequest) => {
      await before?.();
      writeFileSync(req.output, "OggS");
      return { durationMs: measuredMs };
    },
  });
/** `prepare_audio` whose ffmpeg step throws `error`. */
const failing = (error: Error) =>
  createPrepareAudio({
    storage: () => kit.storage,
    tmpRoot,
    announce: () => {},
    probe: async () => ({ ok: true, durationMs: null, format: "wav" }),
    normalize: async () => {
      throw error;
    },
  });

const chunkKey = (id: string, seq: number) => `meetings/${id}/chunks/${String(seq).padStart(6, "0")}`;

/**
 * A recording in `processing` holding `heldMs` (what stop summed from its stored pieces), already announced to hours-api once
 * (`hoursSeq` 1) unless told otherwise: the shape a real stop leaves, so the correction's notice is the second version.
 */
async function processingRecording(heldMs: number | null, over: Record<string, unknown> = {}) {
  const m = await kit.db.meeting.create({
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
      status: "processing",
      stage: "preparing",
      durationMs: heldMs,
      hoursSeq: heldMs === null ? 0 : 1,
      processingStartedAt: new Date(),
      processingRequestedBy: CREATOR,
      ...over,
    } as never,
  });
  const session = await kit.db.recordingSession.create({ data: { meetingId: m.id, lastBeatAt: new Date(), capturedMs: heldMs ?? 0, endedAt: new Date(), endReason: "stopped" } });
  kit.storage.put(chunkKey(m.id, 0), 3, "audio/webm", Uint8Array.from([1, 2, 3]));
  await kit.db.recordingChunk.create({
    data: { meetingId: m.id, seq: 0, sessionId: session.id, objectKey: chunkKey(m.id, 0), sizeBytes: 3, durationMs: heldMs ?? 0, storedAt: new Date() },
  });
  return m;
}

/** An uploaded file in `processing` whose container said `heldMs` at confirm (null: it said nothing). */
async function processingUpload(heldMs: number | null, over: Record<string, unknown> = {}) {
  const m = await kit.db.meeting.create({
    data: {
      title: "Weekly sync",
      format: "online",
      startsAt: new Date("2026-11-05T09:00:00.000Z"),
      language: "en",
      source: "uploaded",
      creatorUserId: CREATOR,
      consentUserId: CREATOR,
      consentAt: new Date("2026-11-05T09:00:00.000Z"),
      consentNoticeVersion: "v1",
      status: "processing",
      stage: "preparing",
      durationMs: heldMs,
      hoursSeq: heldMs === null ? 0 : 1,
      processingStartedAt: new Date(),
      processingRequestedBy: CREATOR,
      ...over,
    } as never,
  });
  const objectKey = `meetings/${m.id}/upload/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  kit.storage.put(objectKey, 3, "audio/mpeg", Uint8Array.from([1, 2, 3]));
  await kit.db.meetingUpload.create({ data: { meetingId: m.id, objectKey, contentType: "audio/mpeg", sizeBytes: 3 } });
  return m;
}

/** What the step-3 commit leaves behind when it ran: the audio is kept and `transcribe` is the next job. */
async function expectHandedOver(meetingId: string) {
  expect((await reread(meetingId)).audioKey).toBe(`meetings/${meetingId}/audio.ogg`);
  expect(await kit.db.meetingJob.count({ where: { meetingId, kind: "transcribe" } })).toBe(1);
}

// ─── AC-3.8: the measured duration replaces a held one that is materially wrong ───

describe("a duration the audio contradicts beyond the margin is replaced, before the meeting leaves processing (AC-3.8)", () => {
  it("a recording holding 3 h that measures 10 min: 10 min, `status` still processing, transcribe queued, one notice, and the view answers 10 min (G7, S5, R10)", async () => {
    const m = await processingRecording(3 * HOUR);

    await measuring(10 * MIN)(ctxFor(m.id));

    expect(await reread(m.id)).toMatchObject({ durationMs: 10 * MIN, status: "processing", stage: "preparing" });
    await expectHandedOver(m.id);
    expect((await noticeRows(m.id)).map((n) => ({ seq: n.seq, kind: n.kind, state: n.state }))).toEqual([{ seq: 2, kind: "state", state: "pending" }]);

    // What an open Meetings page reads on its next poll: the corrected duration while the meeting is still `processing`.
    const view = await json(await kit.call(CREATOR, "GET", `/meetings/${m.id}`));
    expect(view["status"]).toBe("processing");
    expect(view["durationMs"]).toBe(10 * MIN);
  });

  it("an upload holding its container's 2 h that measures 1 h: corrected the same way", async () => {
    const m = await processingUpload(2 * HOUR);

    await measuring(HOUR)(ctxFor(m.id));

    expect(await reread(m.id)).toMatchObject({ durationMs: HOUR, status: "processing" });
    await expectHandedOver(m.id);
    expect((await noticeRows(m.id)).map((n) => n.seq)).toEqual([2]);
  });

  it("a claim too SHORT is corrected too: held 10 min that measures 40 min", async () => {
    const m = await processingRecording(10 * MIN);

    await measuring(40 * MIN)(ctxFor(m.id));

    expect((await reread(m.id)).durationMs).toBe(40 * MIN);
    expect((await noticeRows(m.id)).map((n) => n.seq)).toEqual([2]);
  });

  it("a held 0 (the stored pieces reported no audio) that measures 20 min is replaced, and the notice is recorded: 0 counts as known for the compare", async () => {
    const m = await processingRecording(0);

    await measuring(20 * MIN)(ctxFor(m.id));

    expect((await reread(m.id)).durationMs).toBe(20 * MIN);
    expect((await noticeRows(m.id)).map((n) => n.seq)).toEqual([2]);
    expect(correctionLines()).toEqual([[CORRECTED, { meetingId: m.id, heldMs: 0, measuredMs: 20 * MIN }]]);
  });

  it("logs ONE line for the operators after the commit, with the meeting id and the two figures and nothing else (D-P10)", async () => {
    const m = await processingRecording(3 * HOUR);

    await measuring(10 * MIN)(ctxFor(m.id));

    expect(correctionLines()).toEqual([[CORRECTED, { meetingId: m.id, heldMs: 3 * HOUR, measuredMs: 10 * MIN }]]);
    // No user id and no title reach any line.
    const everything = JSON.stringify(logSpy.mock.calls);
    expect(everything).not.toContain(CREATOR);
    expect(everything).not.toContain("Weekly sync");
  });

  it("the correction is a Meetings fact: with the hours channel OFF it is written, and no notice is recorded", async () => {
    setHoursChannelForTests(null);
    const m = await processingRecording(3 * HOUR);

    await measuring(10 * MIN)(ctxFor(m.id));

    expect(await reread(m.id)).toMatchObject({ durationMs: 10 * MIN, status: "processing", hoursSeq: 1 });
    expect(await noticeRows(m.id)).toHaveLength(0);
    expect(await kit.db.meetingJob.count({ where: { kind: "deliver_hours_notice" } })).toBe(0);
    await expectHandedOver(m.id);
  });

  it("decides from the duration the meeting holds when it COMMITS, read under the row lock, not from the copy read before ffmpeg ran", async () => {
    const m = await processingRecording(3 * HOUR);

    // While ffmpeg runs, something else writes the duration (nothing does today; the decision must not depend on that staying true).
    await measuring(10 * MIN, async () => {
      await kit.db.meeting.update({ where: { id: m.id }, data: { durationMs: 10 * MIN + 10_000 } });
    })(ctxFor(m.id));

    // Against the stale 3 h the measured 10 min would replace it; against the held 10:10 it is within the margin.
    expect((await reread(m.id)).durationMs).toBe(10 * MIN + 10_000);
    expect(correctionLines()).toHaveLength(0);
  });
});

// ─── AC-3.9: the correction reaches hours-api like any change of a fact ───

describe("the notice the correction recorded is delivered with the measured duration and the next version (AC-3.9)", () => {
  it("a recording stopped at 3 h (version 1, delivered) then measured at 10 min: version 2 carries 10 min", async () => {
    const m = await processingRecording(3 * HOUR, { hoursSeq: 0 });
    // The stop announced the held duration: its notice is seeded here (the stop itself is proved in hours/triggers.test.ts) and delivered first.
    await kit.db.hoursNotice.create({ data: { meetingId: m.id, seq: 1, kind: "state" } });
    await kit.db.meeting.update({ where: { id: m.id }, data: { hoursSeq: 1 } });
    const [first] = await noticeRows(m.id);
    expect(await attemptHoursDelivery(first!.id)).toMatchObject({ state: "delivered" });
    expect(fake.accepted[0]!.meeting).toMatchObject({ seq: 1, facts: { durationMs: 3 * HOUR } });

    await measuring(10 * MIN)(ctxFor(m.id));

    const [second] = await noticeRows(m.id);
    expect(second).toMatchObject({ seq: 2, kind: "state" });
    expect(await attemptHoursDelivery(second!.id)).toMatchObject({ state: "delivered" });
    expect(fake.accepted[1]!.meeting).toEqual({
      id: m.id,
      seq: 2,
      facts: { startsAt: "2026-11-05T09:00:00.000Z", durationMs: 10 * MIN, creatorId: CREATOR, participantIds: [] },
    });
  });
});

// ─── AC-3.10: within the margin, or when the audio cannot be measured, the held duration stands ───

describe("within the margin the held duration and its entries stand (AC-3.10)", () => {
  it("held 10:00 that measures 10:20: unchanged, no notice, no correction line; the meeting is still handed over", async () => {
    const m = await processingRecording(10 * MIN);

    await measuring(10 * MIN + 20_000)(ctxFor(m.id));

    expect(await reread(m.id)).toMatchObject({ durationMs: 10 * MIN, status: "processing", hoursSeq: 1 });
    expect(await noticeRows(m.id)).toHaveLength(0);
    expect(await kit.db.meetingJob.count({ where: { kind: "deliver_hours_notice" } })).toBe(0);
    expect(correctionLines()).toHaveLength(0);
    await expectHandedOver(m.id);
  });

  it("held 44:00 that measures 46:00 (the two would round to 30 and 60 min): unchanged, no notice", async () => {
    const m = await processingUpload(44 * MIN);

    await measuring(46 * MIN)(ctxFor(m.id));

    expect((await reread(m.id)).durationMs).toBe(44 * MIN);
    expect(await noticeRows(m.id)).toHaveLength(0);
    expect(correctionLines()).toHaveLength(0);
  });

  it("audio that cannot be read, on a recording holding 3 h: the meeting fails, the held duration stays, nothing is announced (D69)", async () => {
    const m = await processingRecording(3 * HOUR);

    await expect(failing(new NormalizeError("audio_unreadable"))(ctxFor(m.id))).rejects.toThrow();

    expect(await reread(m.id)).toMatchObject({ status: "failed", failureCode: "audio_unreadable", durationMs: 3 * HOUR, hoursSeq: 1 });
    expect(await noticeRows(m.id)).toHaveLength(0);
    expect(correctionLines()).toHaveLength(0);
  });

  it("a recording that decodes past 3 h 1 min (`too_long`): failed, the held duration kept, nothing announced", async () => {
    const m = await processingRecording(2 * HOUR);

    await expect(failing(new NormalizeError("too_long"))(ctxFor(m.id))).rejects.toThrow();

    expect(await reread(m.id)).toMatchObject({ status: "failed", failureCode: "too_long", durationMs: 2 * HOUR, hoursSeq: 1 });
    expect(await noticeRows(m.id)).toHaveLength(0);
  });

  it("an UPLOAD that decodes past 3 h is refused: back to draft, no duration, and one notice that takes the entries back (AC-1.3)", async () => {
    const m = await processingUpload(2 * HOUR);

    await expect(failing(new NormalizeError("too_long"))(ctxFor(m.id))).rejects.toThrow();

    expect(await reread(m.id)).toMatchObject({ status: "draft", durationMs: null, failureCode: "too_long" });
    const [notice] = await noticeRows(m.id);
    expect(notice).toMatchObject({ seq: 2, kind: "state" });
    expect(await attemptHoursDelivery(notice!.id)).toMatchObject({ state: "delivered" });
    expect(fake.accepted[0]!.meeting.facts).toMatchObject({ durationMs: null });
  });
});

// ─── AC-3.2: filling a missing duration is not a correction ───

describe("a duration that was missing is filled, as before (AC-3.2)", () => {
  it("an upload whose container gave none takes the measured one: one notice, and no correction line (nothing was replaced)", async () => {
    const m = await processingUpload(null);

    await measuring(37 * MIN)(ctxFor(m.id));

    expect(await reread(m.id)).toMatchObject({ durationMs: 37 * MIN, status: "processing", hoursSeq: 1 });
    expect((await noticeRows(m.id)).map((n) => n.seq)).toEqual([1]);
    expect(correctionLines()).toHaveLength(0);
    await expectHandedOver(m.id);
  });
});
