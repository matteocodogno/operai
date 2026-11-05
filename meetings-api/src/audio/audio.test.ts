import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createFakeTransientStorage, type FakeTransientStorage } from "../lib/google/fakeTransientStorage";
import { GoogleApiError } from "../lib/google/auth";
import { setTransientStorageForTests } from "../lib/google/transientStorage";
import { authDown, CREATOR, OTHER, call, db, json, kit, mkMeeting, useKit } from "../test-support/captureKit";

// AC-4.4 (29 days, derived on read, deleted lazily and idempotently), AC-4.5 (delete
// the recording), AC-6.5 (playback by presigned GET after the visibility check), A4.

// After the kit: a static import would evaluate audio.routes before the auth mocks are in place.
const { setAudioClockForTests } = await import("./audio.routes");

useKit();
let transient: FakeTransientStorage;
beforeEach(() => {
  transient = createFakeTransientStorage();
  setTransientStorageForTests(transient);
});
afterEach(() => {
  setAudioClockForTests(null);
  setTransientStorageForTests(null);
});

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T10:00:00.000Z");
const UNTIL = new Date(T0.getTime() + 29 * DAY);
const audioKey = (id: string) => `meetings/${id}/audio.ogg`;
const getAudio = (id: string, user = CREATOR) => call("GET", `/meetings/${id}/audio`, { user });
const delAudio = (id: string, user = CREATOR) => call("DELETE", `/meetings/${id}/audio`, { user });
const at = (d: Date) => setAudioClockForTests(() => d);

async function withAudio(over = {}) {
  const m = await mkMeeting({
    status: "ready", processingStartedAt: T0, audioKey: "set-below", audioBytes: 1234, audioCreatedAt: T0, durationMs: 60_000, ...over,
  });
  await db.meeting.update({ where: { id: m.id }, data: { audioKey: audioKey(m.id) } });
  kit.storage.put(audioKey(m.id), 1234, "audio/ogg");
  return m;
}

describe("GET /meetings/:id/audio", () => {
  it("one second before the 29 days are up: a 15 minute presigned URL for audio.ogg", async () => {
    const m = await withAudio();
    at(new Date(UNTIL.getTime() - 1000));
    const res = await getAudio(m.id);
    expect(res.status).toBe(200);
    const body = await json<{ url: string; expiresAt: string }>(res);
    expect(body.url).toContain(audioKey(m.id));
    expect(body.url).toContain("playback=1");
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000 + 1000);
  });

  it("at the instant it expires: 409 audio_unavailable, and the object is deleted exactly once, however often it is asked", async () => {
    const m = await withAudio();
    const del = spyOn(kit.storage, "deleteObject");
    at(UNTIL);
    for (let i = 0; i < 3; i++) {
      const res = await getAudio(m.id);
      expect(res.status).toBe(409);
      expect((await json<{ code: string }>(res)).code).toBe("audio_unavailable");
    }
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(audioKey(m.id));
    expect(kit.storage.keys()).toEqual([]);
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.audioDeletedAt).not.toBeNull();
    expect(row.audioKey).toBeNull();
  });

  it("a storage failure while deleting the expired object still answers 409, marks nothing, and tries again next time", async () => {
    const m = await withAudio();
    at(UNTIL);
    const del = spyOn(kit.storage, "deleteObject").mockRejectedValueOnce(new Error("down"));
    expect((await getAudio(m.id)).status).toBe(409);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).audioDeletedAt).toBeNull();
    expect((await getAudio(m.id)).status).toBe(409);
    expect(del).toHaveBeenCalledTimes(2);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).audioDeletedAt).not.toBeNull();
  });

  it("a frozen meeting behaves the same way", async () => {
    const m = await withAudio();
    kit.identities.set(CREATOR, "deleted");
    at(new Date(UNTIL.getTime() - 1000));
    expect((await getAudio(m.id)).status).toBe(200);
    at(UNTIL);
    expect((await getAudio(m.id)).status).toBe(409);
  });

  it("a meeting that never had audio, or whose audio was deleted, is 409 audio_unavailable and deletes nothing", async () => {
    const del = spyOn(kit.storage, "deleteObject");
    const none = await mkMeeting({ source: "text", status: "ready", consentUserId: null, consentAt: null, consentNoticeVersion: null });
    expect((await getAudio(none.id)).status).toBe(409);
    const gone = await withAudio({ audioDeletedAt: T0 });
    expect((await getAudio(gone.id)).status).toBe(409);
    expect(del).not.toHaveBeenCalled();
  });

  it("is open to a participant, hidden from a stranger (the identical 404), and works while auth is down", async () => {
    const m = await withAudio();
    at(new Date(UNTIL.getTime() - 1000));
    const stranger = await getAudio(m.id, OTHER);
    const missing = await getAudio("no-such-meeting", OTHER);
    expect(stranger.status).toBe(404);
    expect((await stranger.text()).replace(m.id, "ID")).toBe((await missing.text()).replace("no-such-meeting", "ID"));
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    expect((await getAudio(m.id, OTHER)).status).toBe(200);
    authDown();
    expect((await getAudio(m.id)).status).toBe(200);
  });

  it("a storage failure while minting is 503", async () => {
    const m = await withAudio();
    at(new Date(UNTIL.getTime() - 1000));
    kit.storage.failWith(new Error("down"));
    expect((await getAudio(m.id)).status).toBe(503);
  });
});

describe("DELETE /meetings/:id/audio", () => {
  it("removes everything under the meeting's prefix, marks the audio deleted, and blocks playback", async () => {
    const m = await withAudio();
    kit.storage.put(`meetings/${m.id}/chunks/000000`, 5); // a leftover under the same prefix goes too
    kit.storage.put("meetings/another-meeting/audio.ogg", 5);
    at(new Date(T0.getTime() + DAY));
    const res = await delAudio(m.id);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ audio: { state: "deleted" } });
    expect(kit.storage.keys()).toEqual(["meetings/another-meeting/audio.ogg"]);
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row).toMatchObject({ audioKey: null, audioBytes: null });
    expect(row.audioDeletedAt).not.toBeNull();
    const playback = await getAudio(m.id);
    expect(playback.status).toBe(409);
    expect((await json<{ code: string }>(playback)).code).toBe("audio_unavailable");
  });

  it("also empties the transient transcription prefix of THAT meeting, before the database says the audio is gone (AC-4.12)", async () => {
    const m = await withAudio();
    const other = await withAudio();
    transient.seed(`transcribe/${m.id}/1/in/1.ogg`, "audio");
    transient.seed(`transcribe/${m.id}/1/out/1_transcript_ab.json`, "{}");
    transient.seed(`transcribe/${other.id}/1/in/1.ogg`, "audio");
    let rowAtCall: { audioDeletedAt: Date | null } | null = null;
    const original = transient.deletePrefix.bind(transient);
    transient.deletePrefix = async (prefix) => {
      rowAtCall = await db.meeting.findUniqueOrThrow({ where: { id: m.id }, select: { audioDeletedAt: true } });
      return original(prefix);
    };
    at(new Date(T0.getTime() + DAY));
    expect((await delAudio(m.id)).status).toBe(200);
    expect(rowAtCall).toEqual({ audioDeletedAt: null }); // recorded before the change
    expect(transient.keys()).toEqual([`transcribe/${other.id}/1/in/1.ogg`]);
    expect(transient.events.map((e) => e.key)).toEqual([`transcribe/${m.id}/`]);
  });

  it("a transient-storage failure is 503 storage_unavailable, the audio is still listed and the main bucket untouched", async () => {
    const m = await withAudio();
    transient.seed(`transcribe/${m.id}/1/in/1.ogg`, "audio");
    transient.failWith(new GoogleApiError(true, 503));
    at(new Date(T0.getTime() + DAY));
    const res = await delAudio(m.id);
    expect(res.status).toBe(503);
    expect((await json<{ code: string }>(res)).code).toBe("storage_unavailable");
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.audioDeletedAt).toBeNull();
    expect(row.audioKey).toBe(audioKey(m.id));
    expect(kit.storage.keys()).toContain(audioKey(m.id));
    transient.failWith(null);
    expect((await delAudio(m.id)).status).toBe(200);
  });

  it("blocks a retry of processing: the transcript stays, the audio is gone (audioState deleted)", async () => {
    const m = await withAudio({ status: "failed", failureCode: "provider_unavailable" });
    at(new Date(T0.getTime() + DAY));
    expect(await json(await delAudio(m.id))).toMatchObject({ audio: { state: "deleted" }, can: { retryProcessing: false } });
  });

  it("a failed meeting whose sources were kept (no audio.ogg yet) can have them removed too", async () => {
    const m = await mkMeeting({ status: "failed", failureCode: "audio_unreadable", processingStartedAt: T0 });
    const session = await db.recordingSession.create({ data: { meetingId: m.id, endedAt: T0, endReason: "stopped" } });
    await db.recordingChunk.create({ data: { meetingId: m.id, seq: 0, sessionId: session.id, objectKey: `meetings/${m.id}/chunks/000000`, sizeBytes: 5, durationMs: 1000, storedAt: T0 } });
    kit.storage.put(`meetings/${m.id}/chunks/000000`, 5);
    const res = await delAudio(m.id);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ audio: { state: "deleted" } });
    expect(kit.storage.keys()).toEqual([]);
  });

  it("a storage failure is 503 storage_unavailable with nothing changed", async () => {
    const m = await withAudio();
    at(new Date(T0.getTime() + DAY));
    kit.storage.failWith(new Error("down"));
    const res = await delAudio(m.id);
    expect(res.status).toBe(503);
    expect((await json<{ code: string }>(res)).code).toBe("storage_unavailable");
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.audioDeletedAt).toBeNull();
    expect(row.audioKey).toBe(audioKey(m.id));
  });

  it("deleting twice is fine; deleting where there never was audio is 409 audio_unavailable", async () => {
    const m = await withAudio();
    at(new Date(T0.getTime() + DAY));
    expect((await delAudio(m.id)).status).toBe(200);
    expect((await delAudio(m.id)).status).toBe(200);
    const none = await mkMeeting({ source: "text", status: "ready", consentUserId: null, consentAt: null, consentNoticeVersion: null });
    const res = await delAudio(none.id);
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("audio_unavailable");
  });

  it("never races a live recording or a job that reads the audio: 409 in_progress", async () => {
    for (const status of ["recording", "processing"] as const) {
      const m = await withAudio({ status });
      at(new Date(T0.getTime() + DAY));
      const res = await delAudio(m.id);
      expect(res.status).toBe(409);
      expect((await json<{ code: string }>(res)).code).toBe("in_progress");
      expect(kit.storage.keys()).toContain(audioKey(m.id));
    }
  });

  it("is the creator's alone: participant 403, stranger 404, frozen creator 403; but needs no meetings:access (A4)", async () => {
    const m = await withAudio();
    at(new Date(T0.getTime() + DAY));
    expect((await delAudio(m.id, OTHER)).status).toBe(404);
    await db.meetingParticipant.create({ data: { meetingId: m.id, userId: OTHER, addedBy: CREATOR } });
    const participant = await delAudio(m.id, OTHER);
    expect(participant.status).toBe(403);
    expect((await json<{ code: string }>(participant)).code).toBe("creator_only");
    kit.identities.set(CREATOR, "deleted");
    expect((await json<{ code: string }>(await delAudio(m.id))).code).toBe("frozen");
    kit.identities.clear();
    kit.grants.set(CREATOR, []); // lost the tool grant: may still remove their own data
    expect((await delAudio(m.id)).status).toBe(200);
  });

  it("an identities outage is 503 and removes nothing", async () => {
    const m = await withAudio();
    kit.identities.set(CREATOR, "outage");
    expect((await delAudio(m.id)).status).toBe(503);
    expect(kit.storage.keys()).toContain(audioKey(m.id));
  });
});
