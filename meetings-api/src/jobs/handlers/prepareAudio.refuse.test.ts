import { CREATOR, call, db, json, kit, mkMeeting, useKit } from "../../test-support/captureKit";
import { afterEach, describe, expect, it } from "bun:test";
import type { NotifyEvent } from "../../lib/notify";
import { NormalizeError } from "../../media/normalize";
import { setProberForTests } from "../../media/probe";
import { PermanentJobError, TransientJobError, type JobContext } from "../runner";
import { createPrepareAudio } from "./prepareAudio";

// AC-3.2: an UPLOADED file that states no duration is accepted at confirm and only turns out
// to be over 3 h when ffmpeg hits its output cap in `prepare_audio` (ADR-0064 round 3). It must
// then be REFUSED like any over-long file: the original deleted first, the meeting back in
// `draft` with the reason (`failure.code = too_long`), the creator told, and a new upload possible.
// A recording that is too long keeps today's behaviour (failed, sources kept, retryable).

useKit();
afterEach(() => setProberForTests(null));

let pushed: NotifyEvent[] = [];
const KEY = (id: string) => `meetings/${id}/upload/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;

async function processingUpload(over: Record<string, unknown> = {}) {
  pushed = [];
  const meeting = await mkMeeting({
    source: "uploaded",
    status: "processing",
    stage: "preparing",
    durationMs: null,
    processingRequestedBy: "requester",
    processingStartedAt: new Date("2026-11-05T09:30:00Z"),
    ...over,
  });
  await db.meetingUpload.create({ data: { meetingId: meeting.id, objectKey: KEY(meeting.id), contentType: "audio/webm", sizeBytes: 3 } });
  kit.storage.put(KEY(meeting.id), 3, "audio/webm", new Uint8Array([1, 2, 3]));
  return meeting;
}

function ctxFor(meetingId: string, over: { attempt?: number; stale?: boolean } = {}): JobContext {
  const attempt = over.attempt ?? 1;
  return {
    job: { id: "job-1", kind: "prepare_audio", meetingId, summaryId: null, noticeId: null, attemptId: null, attempts: attempt, maxAttempts: 3 },
    attemptId: null,
    attempt,
    signal: new AbortController().signal,
    commit: async (fn) => {
      if (over.stale) return { committed: false };
      return db.$transaction(async (tx) => ({ committed: true as const, value: await fn(tx) }));
    },
  };
}

const tooLong = () =>
  createPrepareAudio({
    storage: () => kit.storage,
    probe: async () => ({ ok: true, durationMs: 1000, format: "matroska" }),
    normalize: async () => {
      throw new NormalizeError("too_long");
    },
    announce: (event: NotifyEvent) => void pushed.push(event),
  });
const reread = (id: string) => db.meeting.findUniqueOrThrow({ where: { id } });

describe("prepare_audio refuses an uploaded file that decodes past 3 h", () => {
  it("returns the meeting to draft with the reason, deletes the original, and tells the requester", async () => {
    const m = await processingUpload();
    await expect(tooLong()(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);

    expect(await reread(m.id)).toMatchObject({ status: "draft", stage: null, failureCode: "too_long", processingStartedAt: null, processingRequestedBy: null, durationMs: null, processedAt: null });
    expect(kit.storage.keys()).toEqual([]);
    expect(await db.meetingUpload.findUnique({ where: { meetingId: m.id } })).toBeNull();
    expect(pushed).toEqual([{ kind: "upload_refused", meetingId: m.id, meetingTitle: "Weekly sync", actorId: "system:meetings-api", recipientIds: ["requester"] }]);
  });

  it("keeps the metadata, the consent, the participants and the host link", async () => {
    const m = await processingUpload({ hostApp: "crm", hostEntityType: "deal", hostEntityId: "d1" });
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: "p1", addedBy: CREATOR } });
    await expect(tooLong()(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect(await reread(m.id)).toMatchObject({ title: "Weekly sync", source: "uploaded", hostApp: "crm", hostEntityId: "d1", consentUserId: CREATOR, language: "en" });
    expect(await db.meetingParticipant.count({ where: { meetingId: m.id } })).toBe(1);
  });

  it("the view names the reason on the draft, and a fresh mint + confirm works on the same meeting", async () => {
    const m = await processingUpload();
    await expect(tooLong()(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);

    const view = await json<{ status: string; failure: { code: string } | null; can: { capture: boolean; changeLanguage: boolean } }>(await call("GET", `/meetings/${m.id}`));
    expect(view).toMatchObject({ status: "draft", failure: { code: "too_long" }, can: { capture: true, changeLanguage: true } });

    const minted = await call("POST", `/meetings/${m.id}/upload`, { body: { contentType: "audio/mpeg", sizeBytes: 1000 } });
    expect(minted.status).toBe(200);
    // starting a new attempt retires the old reason
    expect((await reread(m.id)).failureCode).toBeNull();
    const key = ((await minted.json()) as { fields: Record<string, string> }).fields["key"]!;
    kit.storage.put(key, 1000, "audio/mpeg");
    setProberForTests(async () => ({ ok: true, durationMs: 60_000, format: "mp3" }));
    const confirmed = await call("POST", `/meetings/${m.id}/upload/confirm`);
    expect(confirmed.status).toBe(202);
    expect(await reread(m.id)).toMatchObject({ status: "processing", failureCode: null });
    expect(await db.meetingJob.count({ where: { meetingId: m.id, kind: "prepare_audio" } })).toBe(1);
  });

  it("a delete that fails is not pretended: nothing changes and the job is retried, then the last attempt fails the meeting as before", async () => {
    const m = await processingUpload();
    const handler = createPrepareAudio({
      storage: () => ({ ...kit.storage, deleteObject: async () => { throw new Error("bucket down"); }, deleteUploadsExcept: async () => { throw new Error("bucket down"); } }) as typeof kit.storage,
      probe: async () => ({ ok: true, durationMs: 1000, format: "matroska" }),
      normalize: async () => { throw new NormalizeError("too_long"); },
      announce: (event: NotifyEvent) => void pushed.push(event),
    });
    await expect(handler(ctxFor(m.id, { attempt: 1 }))).rejects.toBeInstanceOf(TransientJobError);
    expect(await reread(m.id)).toMatchObject({ status: "processing", failureCode: null });
    expect(await db.meetingUpload.findUnique({ where: { meetingId: m.id } })).not.toBeNull();
    expect(pushed).toHaveLength(0);

    await expect(handler(ctxFor(m.id, { attempt: 3 }))).rejects.toBeInstanceOf(PermanentJobError);
    expect(await reread(m.id)).toMatchObject({ status: "failed", failureCode: "too_long" });
    expect(kit.storage.keys()).toEqual([KEY(m.id)]);
    expect(pushed.map((e) => e.kind)).toEqual(["transcription_failed"]);
  });

  it("a stale attempt deletes nothing and changes nothing", async () => {
    const m = await processingUpload();
    await expect(tooLong()(ctxFor(m.id, { stale: true }))).rejects.toBeInstanceOf(PermanentJobError);
    expect((await reread(m.id)).status).toBe("processing");
    expect(kit.storage.keys()).toEqual([KEY(m.id)]);
    expect(pushed).toHaveLength(0);
  });

  it("a second, late delivery after the refusal finds a draft and does nothing", async () => {
    const m = await processingUpload();
    await expect(tooLong()(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    pushed = [];
    await tooLong()(ctxFor(m.id));
    expect(await reread(m.id)).toMatchObject({ status: "draft", failureCode: "too_long" });
    expect(pushed).toHaveLength(0);
  });

  it("a RECORDED source that is too long keeps today's behaviour: failed, sources kept", async () => {
    pushed = [];
    const m = await mkMeeting({ source: "recorded", status: "processing", stage: "preparing", processingRequestedBy: "requester", processingStartedAt: new Date() });
    const key = `meetings/${m.id}/chunks/000000`;
    const session = await db.recordingSession.create({ data: { meetingId: m.id, endedAt: new Date() } });
    await db.recordingChunk.create({ data: { meetingId: m.id, seq: 0, sessionId: session.id, objectKey: key, sizeBytes: 3, durationMs: 1000, storedAt: new Date() } });
    kit.storage.put(key, 3, "audio/webm", new Uint8Array([1, 2, 3]));
    await expect(tooLong()(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect(await reread(m.id)).toMatchObject({ status: "failed", failureCode: "too_long" });
    expect(kit.storage.keys()).toEqual([key]);
    expect(pushed.map((e) => e.kind)).toEqual(["transcription_failed"]);
  });
});
