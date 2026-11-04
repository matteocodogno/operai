import { describe, expect, it } from "bun:test";
import { CREATOR, OTHER, call, db, json, kit, mkMeeting, useKit } from "../test-support/captureKit";

// AC-2.6 (what was captured, paused time excluded), AC-2.7 (processing only after
// everything is saved), AC-2.8 (process what was captured / discard from interrupted).

useKit();

const key = (id: string, seq: number) => `meetings/${id}/chunks/${String(seq).padStart(6, "0")}`;

/** A recording meeting with `seqs` stored chunks of the given duration each. */
async function recording(seqs: number[], durationMs = 10_000, lastBeatAgoMs = 0) {
  const m = await mkMeeting({ status: "recording" });
  const session = await db.recordingSession.create({ data: { meetingId: m.id, lastBeatAt: new Date(Date.now() - lastBeatAgoMs), capturedMs: 90_000 } });
  for (const seq of seqs) {
    kit.storage.put(key(m.id, seq), 1000, "audio/webm");
    await db.recordingChunk.create({
      data: { meetingId: m.id, seq, sessionId: session.id, objectKey: key(m.id, seq), sizeBytes: 1000, durationMs, storedAt: new Date() },
    });
  }
  return { m, sessionId: session.id };
}
const stop = (id: string, body: Record<string, unknown>, user = CREATOR) => call("POST", `/meetings/${id}/recording/stop`, { user, body });
const act = (id: string, what: "process" | "discard", user = CREATOR) => call("POST", `/meetings/${id}/recording/${what}`, { user });
const jobs = (id: string) => db.meetingJob.findMany({ where: { meetingId: id } });

describe("POST /meetings/:id/recording/stop", () => {
  it("with every chunk 0..lastSeq stored: 202, processing, durationMs = Σ chunks, one prepare_audio job", async () => {
    const { m, sessionId } = await recording([0, 1, 2], 10_000);
    const res = await stop(m.id, { sessionId, lastSeq: 2 });
    expect(res.status).toBe(202);
    const view = await json<{ status: string; stage: string; durationMs: number }>(res);
    expect(view).toMatchObject({ status: "processing", stage: "preparing", durationMs: 30_000 });
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.processingRequestedBy).toBe(CREATOR);
    expect(row.processingStartedAt).not.toBeNull();
    const queued = await jobs(m.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "prepare_audio", state: "queued" });
    expect((await db.recordingSession.findUniqueOrThrow({ where: { id: sessionId } })).endedAt).not.toBeNull();
  });

  it("a gap is 409 chunks_missing naming the missing seqs; nothing changes (AC-2.7)", async () => {
    const { m, sessionId } = await recording([0, 2, 3]);
    const res = await stop(m.id, { sessionId, lastSeq: 4 });
    expect(res.status).toBe(409);
    const body = await json<{ code: string; missing: number[] }>(res);
    expect(body.code).toBe("chunks_missing");
    expect(body.missing).toEqual([1, 4]);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("recording");
    expect(await jobs(m.id)).toHaveLength(0);
    // the client uploads the rest, then stop goes through
    kit.storage.put(key(m.id, 1), 1000);
    await db.recordingChunk.createMany({
      data: [1, 4].map((seq) => ({ meetingId: m.id, seq, sessionId, objectKey: key(m.id, seq), sizeBytes: 1, durationMs: 10_000, storedAt: new Date() })),
    });
    expect((await stop(m.id, { sessionId, lastSeq: 4 })).status).toBe(202);
  });

  it("a chunk row that was never confirmed (storedAt null) counts as missing", async () => {
    const { m, sessionId } = await recording([0]);
    await db.recordingChunk.create({
      data: { meetingId: m.id, seq: 1, sessionId, objectKey: key(m.id, 1), sizeBytes: 1, durationMs: 10_000, storedAt: null },
    });
    const res = await stop(m.id, { sessionId, lastSeq: 1 });
    expect(res.status).toBe(409);
    expect((await json<{ missing: number[] }>(res)).missing).toEqual([1]);
  });

  it("repeating a stop that already succeeded answers the same 202 and enqueues nothing more", async () => {
    const { m, sessionId } = await recording([0, 1]);
    expect((await stop(m.id, { sessionId, lastSeq: 1 })).status).toBe(202);
    const again = await stop(m.id, { sessionId, lastSeq: 1 });
    expect(again.status).toBe(202);
    expect((await json<{ status: string }>(again)).status).toBe("processing");
    expect(await jobs(m.id)).toHaveLength(1);
  });

  it("a wrong session id is 409 session_inactive; a stranger is 404; a non-creator participant 403", async () => {
    const { m, sessionId } = await recording([0]);
    expect((await stop(m.id, { sessionId: "other", lastSeq: 0 })).status).toBe(409);
    expect((await stop(m.id, { sessionId, lastSeq: 0 }, OTHER)).status).toBe(404);
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    const res = await stop(m.id, { sessionId, lastSeq: 0 }, OTHER);
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("creator_only");
  });

  it("validates lastSeq (422) and a frozen creator is refused (403 frozen)", async () => {
    const { m, sessionId } = await recording([0]);
    expect((await stop(m.id, { sessionId, lastSeq: -1 })).status).toBe(422);
    kit.identities.set(CREATOR, "deleted");
    const res = await stop(m.id, { sessionId, lastSeq: 0 });
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("frozen");
  });
});

describe("POST /meetings/:id/recording/process (from interrupted)", () => {
  it("keeps durationMs = Σ stored chunk durations, paused time excluded, and enqueues one job", async () => {
    // 3 chunks of 10 s with a 5 min pause in between: the pause produced no chunks.
    const { m, sessionId } = await recording([0, 1, 2], 10_000, 5 * 60_000);
    const res = await act(m.id, "process");
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ status: "processing", durationMs: 30_000 });
    expect(await jobs(m.id)).toHaveLength(1);
    const session = await db.recordingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.endedAt).not.toBeNull();
    expect(session.endReason).toBe("processed");
  });

  it("processes what was captured even with a gap in the sequence", async () => {
    const { m } = await recording([0, 2], 10_000, 5 * 60_000);
    const res = await act(m.id, "process");
    expect(res.status).toBe(202);
    expect((await json<{ durationMs: number }>(res)).durationMs).toBe(20_000);
  });

  it("is refused while the recording is live: 409 not_interrupted", async () => {
    const { m } = await recording([0], 10_000, 0);
    const res = await act(m.id, "process");
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("not_interrupted");
    expect(await jobs(m.id)).toHaveLength(0);
  });

  it("nothing was saved: 409 no_audio; chunks older than the retention: 409 audio_deleted", async () => {
    const empty = await recording([], 10_000, 5 * 60_000);
    const none = await act(empty.m.id, "process");
    expect(none.status).toBe(409);
    expect((await json<{ code: string }>(none)).code).toBe("no_audio");

    const old = await recording([0], 10_000, 5 * 60_000);
    await db.recordingChunk.updateMany({ where: { meetingId: old.m.id }, data: { storedAt: new Date(Date.now() - 30 * 86_400_000) } });
    const gone = await act(old.m.id, "process");
    expect(gone.status).toBe(409);
    expect((await json<{ code: string }>(gone)).code).toBe("audio_deleted");
  });

  it("a creator-only action", async () => {
    const { m } = await recording([0], 10_000, 5 * 60_000);
    expect((await act(m.id, "process", OTHER)).status).toBe(404);
  });
});

describe("POST /meetings/:id/recording/discard", () => {
  it("deletes the objects and the rows and returns the meeting to draft", async () => {
    const { m } = await recording([0, 1, 2], 10_000, 5 * 60_000);
    kit.storage.put(key(m.id, 7), 5); // an unconfirmed upload under the same prefix goes too
    const res = await act(m.id, "discard");
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: "draft", durationMs: null, recording: null });
    expect(kit.storage.keys()).toEqual([]);
    expect(await db.recordingChunk.count({ where: { meetingId: m.id } })).toBe(0);
    expect(await db.recordingSession.count({ where: { meetingId: m.id } })).toBe(0);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("draft");
  });

  it("a live recording can be discarded too, and a new recording may then start", async () => {
    const { m } = await recording([0], 10_000, 0);
    expect((await act(m.id, "discard")).status).toBe(200);
    expect((await call("POST", `/meetings/${m.id}/recording/start`)).status).toBe(201);
  });

  it("a storage failure is 503 and changes nothing", async () => {
    const { m } = await recording([0, 1], 10_000, 5 * 60_000);
    kit.storage.failWith(new Error("down"));
    const res = await act(m.id, "discard");
    expect(res.status).toBe(503);
    expect((await json<{ code: string }>(res)).code).toBe("storage_unavailable");
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("recording");
    expect(await db.recordingChunk.count({ where: { meetingId: m.id } })).toBe(2);
  });

  it("is refused for a meeting that is not recording: 409 not_recording", async () => {
    const m = await mkMeeting({ status: "processing" });
    const res = await act(m.id, "discard");
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("not_recording");
  });
});
