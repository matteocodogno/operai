import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, kit, mkMeeting, useKit } from "../test-support/captureKit";
import { PermanentJobError, type JobContext } from "../jobs/runner";
import { createPrepareAudio } from "../jobs/handlers/prepareAudio";
import { objectKeys } from "../lib/storage";
import { ffmpegBinary, ffprobeBinary, probeMedia, runTool } from "./probe";

// OWASP A08/A10 with the REAL ffprobe/ffmpeg: prepare_audio's default probe and a real decode
// over what it stored. Skipped where the binaries are not installed (run in a container).

useKit();
const hasFfmpeg = Bun.which(ffmpegBinary()) !== null && Bun.which(ffprobeBinary()) !== null;
const scratch = mkdtempSync(join(tmpdir(), "prepare-real-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ctxFor = (meetingId: string): JobContext => ({
  job: { id: "job-1", kind: "prepare_audio", meetingId, summaryId: null, noticeId: null, attemptId: null, attempts: 1, maxAttempts: 3 },
  attemptId: null,
  attempt: 1,
  signal: new AbortController().signal,
  commit: async (fn) => ({ committed: true, value: await db.$transaction(fn) }),
});

describe.skipIf(!hasFfmpeg)("prepare_audio with the real ffprobe and ffmpeg", () => {
  const ff = async (args: string[]) => {
    const r = await runTool(ffmpegBinary(), ["-v", "error", "-y", ...args], { timeoutMs: 120_000 });
    expect(r.code).toBe(0);
  };
  const KEY = "meetings/<id>/upload/dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  async function uploaded(bytes: Uint8Array) {
    const m = await mkMeeting({ source: "uploaded", status: "processing", stage: "preparing", durationMs: null, processingStartedAt: new Date() });
    const objectKey = KEY.replace("<id>", m.id);
    kit.storage.put(objectKey, bytes.length, "video/mp4", bytes);
    await db.meetingUpload.create({ data: { meetingId: m.id, objectKey, contentType: "video/mp4", sizeBytes: bytes.length } });
    return m;
  }
  const run = (tmpRoot: string, meetingId: string) => createPrepareAudio({ tmpRoot })(ctxFor(meetingId));

  it("an mp4 with a video track: probed locally, decoded with the demuxer pinned, audio.ogg stored", async () => {
    await ff(["-f", "lavfi", "-i", "testsrc=d=2:s=64x64:r=5", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-c:v", "libx264", "-c:a", "aac", join(scratch, "v.mp4")]);
    const m = await uploaded(new Uint8Array(readFileSync(join(scratch, "v.mp4"))));
    const tmpRoot = mkdtempSync(join(scratch, "root-"));
    await run(tmpRoot, m.id);
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.audioKey).toBe(objectKeys.audio(m.id));
    expect(Math.abs(row.durationMs! - 2000)).toBeLessThan(600);
    expect(kit.storage.keys()).toEqual([objectKeys.audio(m.id)]);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("a browser-saved WebM/Opus upload with NO duration header is accepted and normalised (ADR-0064: MediaRecorder writes none)", async () => {
    // -live 1: the Matroska muxer writes no Duration, like MediaRecorder's output.
    await ff(["-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libopus", "-b:a", "32k", "-f", "webm", "-live", "1", join(scratch, "nodur.webm")]);
    expect(await probeMedia(join(scratch, "nodur.webm"))).toMatchObject({ ok: true, durationMs: null });
    const m = await uploaded(new Uint8Array(readFileSync(join(scratch, "nodur.webm"))));
    const tmpRoot = mkdtempSync(join(scratch, "root-"));
    await run(tmpRoot, m.id);
    const row = await db.meeting.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.audioKey).toBe(objectKeys.audio(m.id));
    expect(Math.abs(row.durationMs! - 2000)).toBeLessThan(600);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("WebM/Opus chunks in two containers (recorder rebuilt after Resume): each run probed and pinned, both kept", async () => {
    await ff(["-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libopus", "-b:a", "32k", join(scratch, "r1.webm")]);
    await ff(["-f", "lavfi", "-i", "sine=f=880:d=2", "-c:a", "libopus", "-b:a", "32k", join(scratch, "r2.webm")]);
    const m = await mkMeeting({ status: "processing", stage: "preparing", durationMs: 4000, processingStartedAt: new Date() });
    const session = await db.recordingSession.create({ data: { meetingId: m.id, endedAt: new Date(), endReason: "stopped", capturedMs: 4000 } });
    const chunks = [readFileSync(join(scratch, "r1.webm")), readFileSync(join(scratch, "r2.webm"))];
    for (const [seq, bytes] of chunks.entries()) {
      const key = objectKeys.chunk(m.id, seq);
      kit.storage.put(key, bytes.length, "audio/webm", new Uint8Array(bytes));
      await db.recordingChunk.create({ data: { meetingId: m.id, seq, sessionId: session.id, objectKey: key, sizeBytes: bytes.length, durationMs: 2000, storedAt: new Date() } });
    }
    await run(mkdtempSync(join(scratch, "root-")), m.id);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).audioKey).toBe(objectKeys.audio(m.id));
  });

  it("Safari-style fragmented MP4 chunks (header in the first chunk only): the joined run is probed as mov and decoded pinned to it", async () => {
    await ff(["-f", "lavfi", "-i", "sine=f=440:d=3", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof", join(scratch, "s.mp4")]);
    const all = readFileSync(join(scratch, "s.mp4"));
    const step = Math.ceil(all.length / 3);
    const m = await mkMeeting({ status: "processing", stage: "preparing", durationMs: 3000, processingStartedAt: new Date() });
    const session = await db.recordingSession.create({ data: { meetingId: m.id, endedAt: new Date(), endReason: "stopped", capturedMs: 3000 } });
    for (let seq = 0; seq < 3; seq++) {
      const bytes = new Uint8Array(all.subarray(seq * step, (seq + 1) * step));
      const key = objectKeys.chunk(m.id, seq);
      kit.storage.put(key, bytes.length, "audio/mp4", bytes);
      await db.recordingChunk.create({ data: { meetingId: m.id, seq, sessionId: session.id, objectKey: key, sizeBytes: bytes.length, durationMs: 1000, storedAt: new Date() } });
    }
    await run(mkdtempSync(join(scratch, "root-")), m.id);
    expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).audioKey).toBe(objectKeys.audio(m.id));
  });

  it("an object replaced by an HLS playlist after confirm is refused, and nothing is ever fetched from the host it names", async () => {
    let hits = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (hits++, new Response("x")) });
    try {
      const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nhttp://127.0.0.1:${server.port}/seg.ts\n#EXT-X-ENDLIST\n`;
      const m = await uploaded(new TextEncoder().encode(playlist));
      const tmpRoot = mkdtempSync(join(scratch, "root-"));
      await expect(run(tmpRoot, m.id)).rejects.toBeInstanceOf(PermanentJobError);
      expect((await db.meeting.findUniqueOrThrow({ where: { id: m.id } })).failureCode).toBe("audio_unreadable");
      expect(hits).toBe(0);
      expect(readdirSync(tmpRoot)).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  it("a concat playlist naming a local file is refused too (no file-protocol escape)", async () => {
    const m = await uploaded(new TextEncoder().encode("ffconcat version 1.0\nfile '/etc/hosts'\n"));
    await expect(run(mkdtempSync(join(scratch, "root-")), m.id)).rejects.toBeInstanceOf(PermanentJobError);
    expect(kit.storage.keys()).not.toContain(objectKeys.audio(m.id));
  });
});
