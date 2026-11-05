import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { CREATOR, OTHER, authDown, call, db, json, kit, mkMeeting, useKit } from "../test-support/captureKit";

// AC-6.9 (retry while the audio is kept; no retry after it is deleted), AC-6.10 (the stage),
// AC-12.2 (the requester of the retry is the one told), A4 (creator control: creator_only, frozen,
// meetings_access_required). The route only queues work: no transcriber is involved here.

const { setRetryClockForTests } = await import("./retry.routes");

useKit();
afterEach(() => setRetryClockForTests(null));

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T10:00:00.000Z");
const at = (d: Date) => setRetryClockForTests(() => d);
const retry = (id: string, user: string | null = CREATOR) => call("POST", `/meetings/${id}/retry`, { user });
const jobs = (id: string) => db.meetingJob.findMany({ where: { meetingId: id } });
const code = async (res: Response) => (await json<{ code: string }>(res)).code;

/** A meeting whose transcription failed after `prepare_audio` stored audio.ogg. */
async function failedWithAudio(over = {}) {
  at(new Date(T0.getTime() + DAY));
  return mkMeeting({
    status: "failed", failureCode: "provider_unavailable", processingStartedAt: T0, processingRequestedBy: "someone-earlier",
    audioKey: "meetings/x/audio.ogg", audioBytes: 10, audioCreatedAt: T0, durationMs: 60_000, ...over,
  });
}

/** A meeting whose `prepare_audio` failed: the chunks are still there, audio.ogg never was. */
async function failedWithChunks(storedAt = T0) {
  at(new Date(T0.getTime() + DAY));
  const m = await mkMeeting({ status: "failed", failureCode: "audio_unreadable", processingStartedAt: T0 });
  const session = await db.recordingSession.create({ data: { meetingId: m.id, endedAt: T0, endReason: "stopped" } });
  await db.recordingChunk.create({
    data: { meetingId: m.id, seq: 0, sessionId: session.id, objectKey: `meetings/${m.id}/chunks/000000`, sizeBytes: 5, durationMs: 1000, storedAt },
  });
  return m;
}

describe("POST /meetings/:id/retry while the audio is kept", () => {
  it("queues transcribe, back to processing at the transcribing stage, failure cleared, the retrier recorded as the requester", async () => {
    const m = await failedWithAudio();
    const res = await retry(m.id);
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ status: "processing", stage: "transcribing", failure: null });
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row).toMatchObject({ status: "processing", stage: "transcribing", failureCode: null, processingRequestedBy: CREATOR });
    expect(row.processingStartedAt).toEqual(T0); // the language stays locked
    expect(row.processedAt).toBeNull();
    const queued = await jobs(m.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "transcribe", state: "queued" });
  });

  it("when only the sources were kept (prepare_audio failed) it queues prepare_audio again, at the preparing stage", async () => {
    const m = await failedWithChunks();
    const res = await retry(m.id);
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ status: "processing", stage: "preparing" });
    expect((await jobs(m.id)).map((j) => j.kind)).toEqual(["prepare_audio"]);
  });

  it("an uploaded original that was kept is retried the same way", async () => {
    at(new Date(T0.getTime() + DAY));
    const m = await mkMeeting({ source: "uploaded", status: "failed", failureCode: "audio_unreadable", processingStartedAt: T0 });
    await db.meetingUpload.create({ data: { meetingId: m.id, objectKey: `meetings/${m.id}/upload/cccccccc-cccc-4ccc-8ccc-cccccccccccc`, contentType: "audio/mpeg", sizeBytes: 5, mintedAt: T0 } });
    expect((await retry(m.id)).status).toBe(202);
    expect((await jobs(m.id)).map((j) => j.kind)).toEqual(["prepare_audio"]);
  });

  it("a second tap is 409 not_failed and queues nothing more", async () => {
    const m = await failedWithAudio();
    expect((await retry(m.id)).status).toBe(202);
    const again = await retry(m.id);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("not_failed");
    expect(await jobs(m.id)).toHaveLength(1);
  });

  it.each(["draft", "recording", "processing", "ready"] as const)("a %s meeting is 409 not_failed", async (status) => {
    const m = await mkMeeting({ status });
    const res = await retry(m.id);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("not_failed");
    expect(await jobs(m.id)).toHaveLength(0);
  });
});

describe("after the audio is gone (AC-6.9)", () => {
  it("one second before the 29 days are up the retry still works; at the instant it expires it is 409 audio_deleted", async () => {
    const m = await failedWithAudio();
    at(new Date(T0.getTime() + 29 * DAY - 1000));
    expect((await retry(m.id)).status).toBe(202);

    const late = await failedWithAudio();
    at(new Date(T0.getTime() + 29 * DAY));
    const res = await retry(late.id);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("audio_deleted");
    expect(await jobs(late.id)).toHaveLength(0);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: late.id } })).status).toBe("failed");
  });

  it("audio the creator deleted is 409 audio_deleted", async () => {
    const m = await failedWithAudio({ audioKey: null, audioBytes: null, audioDeletedAt: T0 });
    const res = await retry(m.id);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("audio_deleted");
  });

  it("kept sources older than 29 days are 409 audio_deleted too", async () => {
    const m = await failedWithChunks(new Date(T0.getTime() - 30 * DAY));
    const res = await retry(m.id);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("audio_deleted");
  });

  it("nothing to process again (no audio, no sources) is 409 audio_deleted", async () => {
    at(new Date(T0.getTime() + DAY));
    const m = await mkMeeting({ status: "failed", failureCode: "audio_unreadable", processingStartedAt: T0 });
    const res = await retry(m.id);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("audio_deleted");
  });
});

describe("who may retry (creator control)", () => {
  it("a participant is 403 creator_only, a stranger gets the identical 404 of a missing meeting, nobody is queued", async () => {
    const m = await failedWithAudio();
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    const participant = await retry(m.id, OTHER);
    expect(participant.status).toBe(403);
    expect(await code(participant)).toBe("creator_only");
    const stranger = await retry(m.id, "stranger-1");
    const missing = await retry("no-such-meeting", "stranger-1");
    expect(stranger.status).toBe(404);
    expect((await stranger.text()).replace(m.id, "ID")).toBe((await missing.text()).replace("no-such-meeting", "ID"));
    expect(await jobs(m.id)).toHaveLength(0);
  });

  it("a frozen meeting (creator deactivated) is 403 frozen", async () => {
    const m = await failedWithAudio();
    kit.identities.set(CREATOR, "deleted");
    const res = await retry(m.id);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("frozen");
    expect(await jobs(m.id)).toHaveLength(0);
  });

  it("a creator who lost meetings:access is 403 meetings_access_required", async () => {
    const m = await failedWithAudio();
    kit.grants.set(CREATOR, []);
    const res = await retry(m.id);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("meetings_access_required");
  });

  it("an unauthenticated call is 401, and an auth outage is 503 (fails closed)", async () => {
    const m = await failedWithAudio();
    expect((await retry(m.id, null)).status).toBe(401);
    authDown();
    expect((await retry(m.id)).status).toBe(503);
    expect(await jobs(m.id)).toHaveLength(0);
  });
});

// The `can.retryProcessing` hint and the route's own rule are ONE predicate (AC-6.9): whatever the
// view promises, the route does, in every state a failed meeting can be in.
describe("the view's retryProcessing flag agrees with the route", () => {
  afterEach(() => setSystemTime());

  const uploaded = async () => {
    const m = await mkMeeting({ source: "uploaded", status: "failed", failureCode: "audio_unreadable", processingStartedAt: T0 });
    await db.meetingUpload.create({ data: { meetingId: m.id, objectKey: `meetings/${m.id}/upload/cccccccc-cccc-4ccc-8ccc-cccccccccccc`, contentType: "audio/mpeg", sizeBytes: 5, mintedAt: T0 } });
    return m;
  };
  const nothing = () => mkMeeting({ status: "failed", failureCode: "audio_unreadable", processingStartedAt: T0 });

  const scenarios: [string, () => Promise<{ id: string }>, number][] = [
    ["audio kept", () => failedWithAudio(), 202],
    ["sources only, fresh", () => failedWithChunks(), 202],
    ["sources only, expired", () => failedWithChunks(new Date(T0.getTime() - 30 * DAY)), 409],
    ["uploaded original, fresh", uploaded, 202],
    ["nothing", nothing, 409],
  ];

  it.each(scenarios)("%s", async (_name, make, expected) => {
    const m = await make();
    // The GET reads the wall clock and the route the injected one: pin both to the same instant.
    const now = new Date(T0.getTime() + DAY);
    at(now);
    setSystemTime(now);
    const flag = (await json<{ can: { retryProcessing: boolean } }>(await call("GET", `/meetings/${m.id}`))).can.retryProcessing;
    const status = (await retry(m.id)).status;
    expect(status).toBe(expected);
    expect(flag).toBe(status === 202);
  });
});
