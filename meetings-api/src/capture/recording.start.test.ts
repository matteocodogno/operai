import { describe, expect, it } from "bun:test";
import { loadMeetingView } from "../meetings/view";
import { CREATOR, OTHER, call, db, json, kit, mkMeeting, useKit } from "../test-support/captureKit";

// AC-2.1 (no consent, no recording), AC-2.9 (G3 capturedMs, resume), AC-2.11 (one
// recorder, 3 h limit), AC-2.8 (liveness): start, chunk confirm, re-mint, heartbeat.

useKit();

const statusOf = async (id: string) =>
  (await loadMeetingView(id, { userId: CREATOR, authorization: "Bearer x", holdsAccess: true, holdsErase: false, capabilities: "resolved" }, new Date())).status;

const LIMIT_MS = 10_800_000 + 60_000;
const start = (id: string, user = CREATOR) => call("POST", `/meetings/${id}/recording/start`, { user });
const confirm = (id: string, seq: number, body: Record<string, unknown>, user = CREATOR) =>
  call("POST", `/meetings/${id}/recording/chunks/${seq}/confirm`, { user, body });
const beat = (id: string, body: Record<string, unknown>, user = CREATOR) =>
  call("POST", `/meetings/${id}/recording/heartbeat`, { user, body });

async function started() {
  const m = await mkMeeting();
  const res = await start(m.id);
  const body = await json<{ sessionId: string }>(res);
  return { m, sessionId: body.sessionId };
}
const chunkPut = (id: string, seq: number) =>
  kit.storage.put(`meetings/${id}/chunks/${String(seq).padStart(6, "0")}`, 1000, "audio/webm");

describe("POST /meetings/:id/recording/start", () => {
  it("starts a session, flips the meeting to recording and hands out the policy for seq 0", async () => {
    const m = await mkMeeting();
    const res = await start(m.id);
    expect(res.status).toBe(201);
    const body = await json<{ sessionId: string; chunkSeconds: number; maxChunkBytes: number; next: { fields: Record<string, string> } }>(res);
    expect(body.chunkSeconds).toBe(10);
    expect(body.maxChunkBytes).toBe(8 * 1024 * 1024);
    expect(body.next.fields["key"]).toBe(`meetings/${m.id}/chunks/000000`);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("recording");
    const session = await db.recordingSession.findUniqueOrThrow({ where: { id: body.sessionId } });
    expect(session.endedAt).toBeNull();
    expect(session.meetingId).toBe(m.id);
  });

  it("refuses without the consent attestation (AC-2.1): 409 consent_required, nothing started", async () => {
    const m = await mkMeeting({ consentUserId: null, consentAt: null, consentNoticeVersion: null });
    const res = await start(m.id);
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("consent_required");
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("draft");
    expect(await db.recordingSession.count()).toBe(0);
  });

  it("refuses a meeting whose source is not recorded: 409 wrong_source", async () => {
    const m = await mkMeeting({ source: "uploaded" });
    const res = await start(m.id);
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("wrong_source");
  });

  it("refuses a meeting that is not draft: 409 not_draft", async () => {
    const m = await mkMeeting({ status: "ready" });
    const res = await start(m.id);
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("not_draft");
  });

  it("a second start while a session is live is 409 recording_elsewhere (AC-2.11)", async () => {
    const { m } = await started();
    const res = await start(m.id);
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("recording_elsewhere");
    expect(await db.recordingSession.count()).toBe(1);
  });

  it("a start on an interrupted recording is 409 interrupted, not a new session", async () => {
    const { m, sessionId } = await started();
    await db.recordingSession.update({ where: { id: sessionId }, data: { lastBeatAt: new Date(Date.now() - 3 * 60_000) } });
    const res = await start(m.id);
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("interrupted");
  });

  it("only the creator, with the access capability, can start", async () => {
    const m = await mkMeeting();
    const outsider = await start(m.id, OTHER);
    expect(outsider.status).toBe(404);
    kit.grants.set(CREATOR, []);
    const noAccess = await start(m.id);
    expect(noAccess.status).toBe(403);
    expect((await json<{ code: string }>(noAccess)).code).toBe("meetings_access_required");
  });

  it("a frozen (deactivated) creator cannot start: 403 frozen", async () => {
    const m = await mkMeeting();
    kit.identities.set(CREATOR, "deleted");
    const res = await start(m.id);
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("frozen");
  });

  it("an auth outage is a 503 (fail closed)", async () => {
    const m = await mkMeeting();
    kit.authOutage = true;
    expect((await start(m.id)).status).toBe(503);
  });

  it("a storage failure is a 503 and leaves the meeting draft", async () => {
    const m = await mkMeeting();
    kit.storage.failWith(new Error("down"));
    const res = await start(m.id);
    expect(res.status).toBe(503);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("draft");
  });
});

describe("POST /meetings/:id/recording/chunks/:seq/confirm", () => {
  it("HEAD-checks the object and returns the policy for seq + 1 only", async () => {
    const { m, sessionId } = await started();
    chunkPut(m.id, 0);
    const res = await confirm(m.id, 0, { sessionId, durationMs: 10_000 });
    expect(res.status).toBe(200);
    const body = await json<{ storedChunks: number; durationMs: number; next: { fields: Record<string, string> } }>(res);
    expect(body.storedChunks).toBe(1);
    expect(body.durationMs).toBe(10_000);
    expect(body.next.fields["key"]).toBe(`meetings/${m.id}/chunks/000001`);
    const row = await db.recordingChunk.findUniqueOrThrow({ where: { meetingId_seq: { meetingId: m.id, seq: 0 } } });
    expect(row.storedAt).not.toBeNull();
    expect(row.sizeBytes).toBe(1000);
    expect((await db.recordingSession.findUniqueOrThrow({ where: { id: sessionId } })).lastChunkAt).not.toBeNull();
  });

  it("a missing object is 422 chunk_missing and stores nothing", async () => {
    const { m, sessionId } = await started();
    const res = await confirm(m.id, 0, { sessionId, durationMs: 10_000 });
    expect(res.status).toBe(422);
    expect((await json<{ code: string }>(res)).code).toBe("chunk_missing");
    expect(await db.recordingChunk.count()).toBe(0);
  });

  it("is idempotent: confirming the same seq twice stores one chunk", async () => {
    const { m, sessionId } = await started();
    chunkPut(m.id, 0);
    await confirm(m.id, 0, { sessionId, durationMs: 10_000 });
    const again = await confirm(m.id, 0, { sessionId, durationMs: 10_000 });
    expect(again.status).toBe(200);
    expect((await json<{ storedChunks: number; durationMs: number }>(again))).toMatchObject({ storedChunks: 1, durationMs: 10_000 });
  });

  it("a chunk that would pass 3 h + 60 s is 409 duration_limit and is not stored", async () => {
    const { m, sessionId } = await started();
    // 720 chunks of 15 s = exactly 3 h; one more 15 s passes 3 h but not 3 h + 60 s
    await db.recordingChunk.createMany({
      data: Array.from({ length: 720 }, (_, seq) => ({
        meetingId: m.id, seq, sessionId, objectKey: `meetings/${m.id}/chunks/${String(seq).padStart(6, "0")}`,
        sizeBytes: 10, durationMs: 15_000, storedAt: new Date(),
      })),
    });
    chunkPut(m.id, 720);
    const ok = await confirm(m.id, 720, { sessionId, durationMs: 15_000 });
    expect(ok.status).toBe(200); // 3 h + 15 s is still inside the 60 s grace
    for (let seq = 721; seq < 724; seq++) chunkPut(m.id, seq);
    expect((await confirm(m.id, 721, { sessionId, durationMs: 15_000 })).status).toBe(200); // 3 h + 30 s
    expect((await confirm(m.id, 722, { sessionId, durationMs: 15_000 })).status).toBe(200); // 3 h + 45 s
    expect((await confirm(m.id, 723, { sessionId, durationMs: 15_000 })).status).toBe(200); // 3 h + 60 s: at the limit
    chunkPut(m.id, 724);
    const over = await confirm(m.id, 724, { sessionId, durationMs: 1 });
    expect(over.status).toBe(409);
    expect((await json<{ code: string }>(over)).code).toBe("duration_limit");
    expect(await db.recordingChunk.findUnique({ where: { meetingId_seq: { meetingId: m.id, seq: 724 } } })).toBeNull();
    expect(LIMIT_MS).toBe(10_860_000);
  });

  it("an unknown or ended session is 409 session_inactive", async () => {
    const { m, sessionId } = await started();
    chunkPut(m.id, 0);
    expect((await confirm(m.id, 0, { sessionId: "nope", durationMs: 1000 })).status).toBe(409);
    await db.recordingSession.update({ where: { id: sessionId }, data: { endedAt: new Date(), endReason: "stopped" } });
    const res = await confirm(m.id, 0, { sessionId, durationMs: 1000 });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("session_inactive");
  });

  it("keeps saving after a gap: an interrupted-reading session accepts a chunk and reads recording again (AC-2.9)", async () => {
    const { m, sessionId } = await started();
    await db.recordingSession.update({ where: { id: sessionId }, data: { lastBeatAt: new Date(Date.now() - 5 * 60_000) } });
    chunkPut(m.id, 0);
    expect((await confirm(m.id, 0, { sessionId, durationMs: 10_000 })).status).toBe(200);
    expect(await statusOf(m.id)).toBe("recording");
  });

  it("rejects a durationMs above 15 s and a negative or huge capturedMs with 422", async () => {
    const { m, sessionId } = await started();
    chunkPut(m.id, 0);
    expect((await confirm(m.id, 0, { sessionId, durationMs: 15_001 })).status).toBe(422);
    expect((await confirm(m.id, 0, { sessionId, durationMs: 1000, capturedMs: -1 })).status).toBe(422);
    expect((await confirm(m.id, 0, { sessionId, durationMs: 1000, capturedMs: LIMIT_MS + 1 })).status).toBe(422);
  });

  it("records capturedMs as a maximum (G3)", async () => {
    const { m, sessionId } = await started();
    chunkPut(m.id, 0);
    chunkPut(m.id, 1);
    await confirm(m.id, 0, { sessionId, durationMs: 10_000, capturedMs: 50_000 });
    await confirm(m.id, 1, { sessionId, durationMs: 10_000, capturedMs: 30_000 });
    expect((await db.recordingSession.findUniqueOrThrow({ where: { id: sessionId } })).capturedMs).toBe(50_000);
  });

  it("only the creator can confirm", async () => {
    const { m, sessionId } = await started();
    chunkPut(m.id, 0);
    expect((await confirm(m.id, 0, { sessionId, durationMs: 1000 }, OTHER)).status).toBe(404);
  });
});

describe("POST /meetings/:id/recording/chunks/:seq/upload-url", () => {
  it("re-mints the policy for that seq on a live session, 409 on an ended one", async () => {
    const { m, sessionId } = await started();
    const res = await call("POST", `/meetings/${m.id}/recording/chunks/3/upload-url`, { body: { sessionId } });
    expect(res.status).toBe(200);
    expect((await json<{ fields: Record<string, string> }>(res)).fields["key"]).toBe(`meetings/${m.id}/chunks/000003`);
    await db.recordingSession.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    expect((await call("POST", `/meetings/${m.id}/recording/chunks/3/upload-url`, { body: { sessionId } })).status).toBe(409);
  });
});

describe("POST /meetings/:id/recording/heartbeat", () => {
  it("updates lastBeatAt, paused and the capturedMs maximum; answers 204", async () => {
    const { m, sessionId } = await started();
    const old = new Date(Date.now() - 60_000);
    await db.recordingSession.update({ where: { id: sessionId }, data: { lastBeatAt: old } });
    expect((await beat(m.id, { sessionId, paused: true, capturedMs: 40_000 })).status).toBe(204);
    expect((await beat(m.id, { sessionId, paused: false, capturedMs: 25_000 })).status).toBe(204);
    const s = await db.recordingSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.lastBeatAt.getTime()).toBeGreaterThan(old.getTime() + 30_000);
    expect(s.paused).toBe(false);
    expect(s.capturedMs).toBe(40_000);
  });

  it("a beat revives a silent session (reads recording again)", async () => {
    const { m, sessionId } = await started();
    await db.recordingSession.update({ where: { id: sessionId }, data: { lastBeatAt: new Date(Date.now() - 5 * 60_000) } });
    expect(await statusOf(m.id)).toBe("interrupted");
    await beat(m.id, { sessionId, paused: false, capturedMs: 0 });
    expect(await statusOf(m.id)).toBe("recording");
  });

  it("an ended session is 409 session_inactive; capturedMs above the limit is 422; a stranger gets 404", async () => {
    const { m, sessionId } = await started();
    expect((await beat(m.id, { sessionId, paused: false, capturedMs: LIMIT_MS + 1 })).status).toBe(422);
    expect((await beat(m.id, { sessionId, paused: false, capturedMs: 1 }, OTHER)).status).toBe(404);
    await db.recordingSession.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    const res = await beat(m.id, { sessionId, paused: false, capturedMs: 1 });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("session_inactive");
  });

  it("does not call the identities service (rate-limited by auth at 120 / 10 min)", async () => {
    const { m, sessionId } = await started();
    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await beat(m.id, { sessionId, paused: false, capturedMs: 1 });
    chunkPut(m.id, 0);
    await confirm(m.id, 0, { sessionId, durationMs: 1000 });
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
  });
});
