import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { db } from "../../lib/db";
import { createFakeStorage, type FakeStorage } from "../../test-support/fakeStorage";
import type { NotifyEvent } from "../../lib/notify";
import { NormalizeError } from "../../media/normalize";
import { PermanentJobError, TransientJobError, type JobContext } from "../runner";
import { createPrepareAudio } from "./prepareAudio";

// AC-12.2 (T32 closes the media lane's gap): when `prepare_audio` FAILS the meeting, the
// requester is told, exactly as for a failed transcription: title and outcome only.
// The ffmpeg step is injected; storage is the in-memory fake. Needs `meetings_test`.

let storage: FakeStorage;
let pushed: NotifyEvent[];

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "meeting_job", "meeting" CASCADE');
  storage = createFakeStorage();
  pushed = [];
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});
afterAll(async () => {
  await db.$disconnect();
});

async function uploaded(over: Record<string, unknown> = {}) {
  const meeting = await db.meeting.create({
    data: {
      title: "Quarterly planning",
      format: "online",
      startsAt: new Date("2026-11-04T09:00:00Z"),
      language: "en",
      source: "uploaded",
      status: "processing",
      stage: "preparing",
      creatorUserId: "creator",
      processingRequestedBy: "requester",
      processingStartedAt: new Date("2026-11-05T09:00:00Z"),
      ...over,
    },
  });
  const objectKey = `meetings/${meeting.id}/upload/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
  await db.meetingUpload.create({ data: { meetingId: meeting.id, objectKey, contentType: "audio/mpeg", sizeBytes: 3 } });
  storage.put(objectKey, 3, "audio/mpeg", new Uint8Array([1, 2, 3]));
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

const handlerFailing = (error: Error) =>
  createPrepareAudio({
    storage: () => storage,
    probe: async () => ({ ok: true, durationMs: 1000, format: "wav" }),
    normalize: async () => {
      throw error;
    },
    announce: (event: NotifyEvent) => void pushed.push(event),
  });
const reread = (id: string) => db.meeting.findUniqueOrThrow({ where: { id } });

describe("prepare_audio tells the requester when it fails the meeting", () => {
  it("unreadable audio: failed, and one transcription_failed push to the requester with the title only", async () => {
    const m = await uploaded();
    await expect(handlerFailing(new NormalizeError("audio_unreadable"))(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect(await reread(m.id)).toMatchObject({ status: "failed", failureCode: "audio_unreadable" });
    expect(pushed).toEqual([{ kind: "transcription_failed", meetingId: m.id, meetingTitle: "Quarterly planning", actorId: "system:meetings-api", recipientIds: ["requester"] }]);
  });

  it("a source that is missing is the same failure, and is announced", async () => {
    const m = await uploaded();
    await db.meetingUpload.deleteMany({ where: { meetingId: m.id } });
    await expect(handlerFailing(new Error("unused"))(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect((await reread(m.id)).failureCode).toBe("audio_unreadable");
    expect(pushed.map((e) => e.kind)).toEqual(["transcription_failed"]);
  });

  it("a transient fault is silent until the last attempt, which fails the meeting and announces it", async () => {
    const m = await uploaded();
    await expect(handlerFailing(new Error("disk"))(ctxFor(m.id, { attempt: 1 }))).rejects.toBeInstanceOf(TransientJobError);
    expect((await reread(m.id)).status).toBe("processing");
    expect(pushed).toHaveLength(0);
    await expect(handlerFailing(new Error("disk"))(ctxFor(m.id, { attempt: 3 }))).rejects.toBeInstanceOf(TransientJobError);
    expect(await reread(m.id)).toMatchObject({ status: "failed", failureCode: "provider_unavailable" });
    expect(pushed.map((e) => e.kind)).toEqual(["transcription_failed"]);
  });

  it("a stale claim fails nothing and tells nobody", async () => {
    const m = await uploaded();
    await expect(handlerFailing(new NormalizeError("too_long"))(ctxFor(m.id, { stale: true }))).rejects.toBeInstanceOf(PermanentJobError);
    expect((await reread(m.id)).status).toBe("processing");
    expect(pushed).toHaveLength(0);
  });

  it("falls back to the creator when no requester was recorded", async () => {
    const m = await uploaded({ processingRequestedBy: null });
    await expect(handlerFailing(new NormalizeError("too_long"))(ctxFor(m.id))).rejects.toBeInstanceOf(PermanentJobError);
    expect(pushed[0]!.recipientIds).toEqual(["creator"]);
  });
});
