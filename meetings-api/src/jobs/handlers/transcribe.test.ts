import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { db } from "../../lib/db";
import { FakeTranscriber, segmentsOf as scripted } from "../../ai/fakeTranscriber";
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

describe("transcript parts (ADR-0070, AC-6.1, AC-6.2)", () => {
  const seg = (ordinal: number, speakerKey: string, startMs: number) => ({ ordinal, startMs, endMs: startMs + 1000, speakerKey, text: `line ${ordinal}` });

  it("hands the transcriber the meeting and the attempt (the transient prefix is per attempt)", async () => {
    const m = await setup();
    await run(m.id, { attempt: 2 });
    expect(fake.calls[0]!.context).toEqual({ meetingId: m.id, attempt: 2 });
  });

  it("one part is stored as [0]", async () => {
    const m = await setup();
    await run(m.id);
    expect((await reread(m.id)).transcriptPartStartsMs).toEqual([0]);
  });

  it("three parts store their starts in the same commit as the segments, with speakers s1..s5 across parts", async () => {
    const m = await setup();
    fake.respondWith({
      kind: "segments",
      partStartsMs: [0, 3_600_000, 7_200_000],
      segments: [seg(0, "s1", 0), seg(1, "s2", 2000), seg(2, "s3", 3_600_000), seg(3, "s4", 3_602_000), seg(4, "s5", 7_200_000)],
    });
    await run(m.id);
    const after = await reread(m.id);
    expect(after.transcriptPartStartsMs).toEqual([0, 3_600_000, 7_200_000]);
    expect(after.status).toBe("ready");
    expect([...new Set((await segmentsOf(m.id)).map((s) => s.speakerKey))]).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("a retry replaces the parts, never merges them", async () => {
    const m = await setup();
    await db.meeting.update({ where: { id: m.id }, data: { transcriptPartStartsMs: [0, 111, 222] } });
    fake.respondWith({ kind: "segments", segments: [seg(0, "s1", 0)], partStartsMs: [0, 500] });
    await run(m.id);
    expect((await reread(m.id)).transcriptPartStartsMs).toEqual([0, 500]);
  });

  it("a stale claim writes no parts", async () => {
    const m = await setup();
    await run(m.id, { stale: true });
    expect((await reread(m.id)).transcriptPartStartsMs).toEqual([]);
  });

  it("a failed attempt leaves the parts as they were (empty), with no segments", async () => {
    const m = await setup();
    fake.failWith(new TranscriptionError("provider_rejected", false, 403));
    await run(m.id).catch(() => {});
    expect((await reread(m.id)).transcriptPartStartsMs).toEqual([]);
    expect(await segmentsOf(m.id)).toHaveLength(0);
  });
});

describe("transcript quality (AC-6.2, AC-6.7, AC-6.12, AC-6.15, AC-6.16; H-5)", () => {
  const PARTS = [{ startMs: 0, endMs: 600_000 }, { startMs: 510_000, endMs: 1_110_000 }];
  const GAPS = [{ startMs: 60_000, endMs: 95_000 }, { startMs: 700_000, endMs: 740_000 }];
  const gapsOf = (id: string) => db.transcriptGap.findMany({ where: { meetingId: id }, orderBy: { startMs: "asc" }, select: { startMs: true, endMs: true } });

  it("writes the part ends beside the starts, each segment's part and the gaps in the same commit", async () => {
    const m = await setup();
    fake.respondWith({ kind: "segments", segments: scripted([[1, "s1", 0, "a"], [2, "s1", 540_000, "b"], [2, "s2", 560_000, "c"]]), parts: PARTS, gaps: GAPS });
    await run(m.id);
    const after = await reread(m.id);
    expect(after).toMatchObject({ status: "ready", transcriptPartStartsMs: [0, 510_000], transcriptPartEndsMs: [600_000, 1_110_000] });
    expect((await segmentsOf(m.id)).map((x) => [x.speakerKey, x.part])).toEqual([["s1", 1], ["s1", 2], ["s2", 2]]);
    expect(await gapsOf(m.id)).toEqual(GAPS);
  });

  it("one part, no gap: [0] and its end, no gap rows", async () => {
    const m = await setup();
    await run(m.id);
    const after = await reread(m.id);
    expect(after.transcriptPartStartsMs).toEqual([0]);
    expect(after.transcriptPartEndsMs).toHaveLength(1);
    expect((await segmentsOf(m.id)).map((x) => x.part)).toEqual([1, 1]);
    expect(await gapsOf(m.id)).toEqual([]);
  });

  it("a retry replaces the gaps, never appends to them", async () => {
    const m = await setup();
    fake.respondWith({ kind: "segments", segments: scripted([[1, "s1", 0, "a"]]), gaps: GAPS });
    await run(m.id);
    expect(await gapsOf(m.id)).toEqual(GAPS);
    // the creator retries a failed transcription: here simulated by putting the meeting back to processing
    await db.meeting.update({ where: { id: m.id }, data: { status: "processing", stage: "preparing" } });
    fake.respondWith({ kind: "segments", segments: scripted([[1, "s1", 0, "a"]]), gaps: [{ startMs: 5_000, endMs: 30_000 }] });
    await run(m.id);
    expect(await gapsOf(m.id)).toEqual([{ startMs: 5_000, endMs: 30_000 }]);
    await db.meeting.update({ where: { id: m.id }, data: { status: "processing", stage: "preparing" } });
    await run(m.id); // the default transcript has no gap
    expect(await gapsOf(m.id)).toEqual([]);
  });

  it("the gaps go with the meeting (AC-4.6)", async () => {
    const m = await setup();
    fake.respondWith({ kind: "segments", segments: scripted([[1, "s1", 0, "a"]]), gaps: GAPS });
    await run(m.id);
    await db.meeting.delete({ where: { id: m.id } });
    expect(await db.transcriptGap.count({ where: { meetingId: m.id } })).toBe(0);
  });

  it("a stale claim writes no gaps and no part ends", async () => {
    const m = await setup();
    fake.respondWith({ kind: "segments", segments: scripted([[1, "s1", 0, "a"]]), gaps: GAPS });
    await run(m.id, { stale: true });
    expect(await gapsOf(m.id)).toEqual([]);
    expect((await reread(m.id)).transcriptPartEndsMs).toEqual([]);
  });

  it("no speech stores no part, no end and no gap", async () => {
    const m = await setup();
    fake.respondWith({ kind: "noSpeech" });
    await run(m.id);
    expect(await reread(m.id)).toMatchObject({ noSpeech: true, transcriptPartStartsMs: [], transcriptPartEndsMs: [] });
    expect(await gapsOf(m.id)).toEqual([]);
  });

  it("speech_not_transcribed fails the meeting at once with its code, permanently, with nothing stored (AC-6.7)", async () => {
    const m = await setup();
    fake.failWith(new TranscriptionError("speech_not_transcribed", false));
    const error = await run(m.id, { attempt: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as PermanentJobError).code).toBe("speech_not_transcribed");
    expect(await reread(m.id)).toMatchObject({ status: "failed", failureCode: "speech_not_transcribed", noSpeech: false });
    expect(await segmentsOf(m.id)).toHaveLength(0);
    expect(await gapsOf(m.id)).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expect(pushed.map((e) => e.kind)).toEqual(["transcription_failed"]);
  });

  it("a ready meeting is never transcribed again: its segments, parts and gaps stay, so a separation cannot be undone (AC-6.16)", async () => {
    const m = await setup();
    fake.respondWith({ kind: "segments", segments: scripted([[1, "s1", 0, "a"], [2, "s2", 540_000, "b"]]), parts: PARTS, gaps: GAPS });
    await run(m.id);
    const before = await segmentsOf(m.id);
    fake.respondWith({ kind: "segments", segments: scripted([[1, "s1", 0, "again"]]) });
    await run(m.id);
    expect(fake.calls).toHaveLength(1);
    expect(await segmentsOf(m.id)).toEqual(before);
    expect(await gapsOf(m.id)).toEqual(GAPS);
  });
});

describe("no speech (AC-6.7)", () => {
  it("is a ready meeting with noSpeech and no segments", async () => {
    const m = await setup();
    fake.respondWith({ kind: "noSpeech" });
    await run(m.id);
    expect(await reread(m.id)).toMatchObject({ status: "ready", stage: null, noSpeech: true });
    expect(await segmentsOf(m.id)).toHaveLength(0);
    expect((await reread(m.id)).transcriptPartStartsMs).toEqual([]);
    expect(pushed.map((e) => e.kind)).toEqual(["transcription_done"]);
  });

  it("segments that are all empty text count as no speech", async () => {
    const m = await setup();
    fake.respondWith({ kind: "segments", segments: [], partStartsMs: [0, 100] });
    await run(m.id);
    expect(await reread(m.id)).toMatchObject({ status: "ready", noSpeech: true, transcriptPartStartsMs: [] });
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
