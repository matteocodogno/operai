import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { db } from "../../lib/db";
import { FakeTranscriber } from "../../ai/fakeTranscriber";
import { TranscriptionError } from "../../ai/transcriber";
import { createFakeStorage, type FakeStorage } from "../../test-support/fakeStorage";
import type { NotifyEvent } from "../../lib/notify";
import { PermanentJobError, TransientJobError, type JobContext } from "../runner";
import { createTranscribeHandler } from "./transcribe";

// AC-6.7 (no speech -> ready), AC-6.9 (failed + code, no partial transcript), AC-6.10 (stage),
// AC-12.2 (the requester is told: title and outcome only), AC-13.2 (the meeting's locale only);
// ADR-0062 (the claim is re-checked at commit). The transcriber is the fake; needs `meetings_test`.

const NOW = new Date("2026-11-05T10:00:00Z");
let fake: FakeTranscriber;
let storage: FakeStorage;
let pushed: NotifyEvent[];

const handler = () =>
  createTranscribeHandler({ db, transcriber: async () => fake, storage: () => storage, announce: (e: NotifyEvent) => void pushed.push(e), now: () => NOW });

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "meeting_job", "meeting" CASCADE');
  fake = new FakeTranscriber();
  storage = createFakeStorage();
  pushed = [];
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});
afterAll(async () => {
  await db.$disconnect();
});

async function setup(over: Record<string, unknown> = {}, participants = 0) {
  const meeting = await db.meeting.create({
    data: {
      title: "Quarterly planning",
      format: "online",
      startsAt: new Date("2026-11-04T09:00:00Z"),
      language: "en",
      source: "recorded",
      status: "processing",
      stage: "preparing",
      creatorUserId: "creator",
      processingRequestedBy: "requester",
      processingStartedAt: new Date("2026-11-05T09:00:00Z"),
      audioKey: "pending",
      audioBytes: 10,
      audioCreatedAt: new Date("2026-11-05T09:30:00Z"),
      ...over,
    },
  });
  if (meeting.audioKey !== null) {
    const audioKey = `meetings/${meeting.id}/audio.ogg`;
    await db.meeting.update({ where: { id: meeting.id }, data: { audioKey } });
    storage.put(audioKey, 10, "audio/ogg", new Uint8Array([1, 2, 3]));
  }
  for (let i = 0; i < participants; i++) {
    await db.meetingParticipant.create({ data: { meetingId: meeting.id, userId: `p${i}`, addedBy: "creator" } });
  }
  return meeting;
}

function ctxFor(meetingId: string | null, over: { attempt?: number; maxAttempts?: number; stale?: boolean; signal?: AbortSignal } = {}): JobContext {
  const attempt = over.attempt ?? 1;
  return {
    job: { id: "job-1", kind: "transcribe", meetingId, summaryId: null, noticeId: null, attemptId: null, attempts: attempt, maxAttempts: over.maxAttempts ?? 3 },
    attemptId: null,
    attempt,
    signal: over.signal ?? new AbortController().signal,
    commit: async (fn) => {
      if (over.stale) return { committed: false };
      return db.$transaction(async (tx) => ({ committed: true as const, value: await fn(tx) }));
    },
  };
}
const run = (id: string, over: Parameters<typeof ctxFor>[1] = {}) => handler()(ctxFor(id, over));
const reread = (id: string) => db.meeting.findUniqueOrThrow({ where: { id } });
const segmentsOf = (id: string) => db.transcriptSegment.findMany({ where: { meetingId: id }, orderBy: { ordinal: "asc" } });

describe("a transcript comes back", () => {
  it("stores the segments in order, marks the meeting ready, and tells the requester (title and outcome only)", async () => {
    const m = await setup();
    await run(m.id);
    const after = await reread(m.id);
    expect(after).toMatchObject({ status: "ready", stage: null, failureCode: null, noSpeech: false });
    expect(after.processedAt).toEqual(NOW);
    const segs = await segmentsOf(m.id);
    expect(segs.map((s) => [s.ordinal, s.speakerKey, s.edited, s.version])).toEqual([[0, "s1", false, 1], [1, "s2", false, 1]]);
    expect(segs[0]!.text).toContain("plan for next quarter");
    expect(pushed).toEqual([{ kind: "transcription_done", meetingId: m.id, meetingTitle: "Quarterly planning", actorId: "system:meetings-api", recipientIds: ["requester"] }]);
  });

  it("sends the audio to the transcriber with the meeting's own locale and participants + 1 speakers (AC-13.2)", async () => {
    const m = await setup({ language: "it" }, 3);
    await run(m.id);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ locale: "it-IT", maxSpeakers: 4 });
    expect(new Uint8Array(await fake.calls[0]!.audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("the stage reads transcribing while the provider works (AC-6.10)", async () => {
    const m = await setup();
    let seen: string | null | undefined;
    fake.respondWith(async () => {
      seen = (await reread(m.id)).stage;
      return { kind: "noSpeech" };
    });
    expect((await reread(m.id)).stage).toBe("preparing");
    await run(m.id);
    expect(seen).toBe("transcribing");
  });

  it("replaces whatever segments a failed earlier attempt could have left", async () => {
    const m = await setup();
    await db.transcriptSegment.create({ data: { meetingId: m.id, ordinal: 7, text: "stale" } });
    await run(m.id);
    expect((await segmentsOf(m.id)).map((s) => s.ordinal)).toEqual([0, 1]);
  });
});

describe("no speech (AC-6.7)", () => {
  it("is a ready meeting with noSpeech and no segments", async () => {
    const m = await setup();
    fake.respondWith({ kind: "noSpeech" });
    await run(m.id);
    expect(await reread(m.id)).toMatchObject({ status: "ready", stage: null, noSpeech: true });
    expect(await segmentsOf(m.id)).toHaveLength(0);
    expect(pushed.map((e) => e.kind)).toEqual(["transcription_done"]);
  });

  it("segments that are all empty text count as no speech", async () => {
    const m = await setup();
    fake.respondWith({ kind: "segments", segments: [] });
    await run(m.id);
    expect(await reread(m.id)).toMatchObject({ status: "ready", noSpeech: true });
  });
});

describe("a failure (AC-6.9)", () => {
  it("a permanent provider error fails the meeting with its code, stores no segments, tells the requester, and fails the job", async () => {
    const m = await setup();
    fake.failWith(new TranscriptionError("provider_rejected", false, 400));
    const error = await run(m.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as PermanentJobError).code).toBe("provider_rejected");
    expect(await reread(m.id)).toMatchObject({ status: "failed", stage: null, failureCode: "provider_rejected" });
    expect((await reread(m.id)).processedAt).toEqual(NOW);
    expect(await segmentsOf(m.id)).toHaveLength(0);
    expect(pushed).toEqual([{ kind: "transcription_failed", meetingId: m.id, meetingTitle: "Quarterly planning", actorId: "system:meetings-api", recipientIds: ["requester"] }]);
  });

  it("a transient error is retried by the runner: the meeting stays processing and nobody is told yet", async () => {
    const m = await setup();
    fake.failWith(new TranscriptionError("provider_unavailable", true, 503));
    await expect(run(m.id, { attempt: 1 })).rejects.toBeInstanceOf(TransientJobError);
    expect(await reread(m.id)).toMatchObject({ status: "processing", stage: "transcribing", failureCode: null });
    expect(pushed).toHaveLength(0);
  });

  it("a transient error on the last attempt fails the meeting", async () => {
    const m = await setup();
    fake.failWith(new TranscriptionError("provider_unavailable", true, 503));
    await expect(run(m.id, { attempt: 3 })).rejects.toBeInstanceOf(PermanentJobError);
    expect(await reread(m.id)).toMatchObject({ status: "failed", failureCode: "provider_unavailable" });
    expect(pushed.map((e) => e.kind)).toEqual(["transcription_failed"]);
  });

  it("an unexpected error is retried, and on the last attempt fails the meeting as provider_unavailable", async () => {
    const m = await setup();
    storage.failWith(new Error("bucket down"));
    await expect(run(m.id, { attempt: 1 })).rejects.toBeInstanceOf(TransientJobError);
    expect((await reread(m.id)).status).toBe("processing");
    await expect(run(m.id, { attempt: 3 })).rejects.toBeInstanceOf(PermanentJobError);
    expect(await reread(m.id)).toMatchObject({ status: "failed", failureCode: "provider_unavailable" });
  });

  it("falls back to the creator when no requester was recorded", async () => {
    const m = await setup({ processingRequestedBy: null });
    await run(m.id);
    expect(pushed[0]!.recipientIds).toEqual(["creator"]);
  });
});

describe("guards", () => {
  it("a stale claim writes nothing and notifies nobody (ADR-0062)", async () => {
    const m = await setup();
    await run(m.id, { stale: true });
    expect(await reread(m.id)).toMatchObject({ status: "processing", stage: "preparing" });
    expect(await segmentsOf(m.id)).toHaveLength(0);
    expect(pushed).toHaveLength(0);
  });

  it("a lost lease is not the meeting's failure: the signal aborting rethrows and fails nothing", async () => {
    const m = await setup();
    const controller = new AbortController();
    fake.respondWith(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(run(m.id, { signal: controller.signal, attempt: 3 })).rejects.toThrow();
    expect((await reread(m.id)).status).toBe("processing");
    expect(pushed).toHaveLength(0);
  });

  it("a meeting that is gone, already finished, or has no audio is left alone", async () => {
    await run("no-such-meeting");
    const done = await setup({ status: "ready", stage: null });
    await run(done.id);
    const noAudio = await setup({ audioKey: null, audioCreatedAt: null });
    await run(noAudio.id);
    expect(fake.calls).toHaveLength(0);
    expect(pushed).toHaveLength(0);
  });

  it("a job without a meeting is refused", async () => {
    await expect(handler()(ctxFor(null))).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("a result for a meeting that was deleted meanwhile is dropped silently", async () => {
    const m = await setup();
    fake.respondWith(async () => {
      await db.meeting.delete({ where: { id: m.id } });
      return { kind: "noSpeech" };
    });
    await run(m.id);
    expect(pushed).toHaveLength(0);
  });
});
