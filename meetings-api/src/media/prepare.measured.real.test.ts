import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrepareAudio } from "../jobs/handlers/prepareAudio";
import type { JobContext } from "../jobs/runner";
import { objectKeys } from "../lib/storage";
import { db, kit, mkMeeting, useKit } from "../test-support/captureKit";
import { ffmpegBinary, ffprobeBinary, probeMedia, runTool } from "./probe";

// QE (specs/20261112-meeting-hours AC-3.8, AC-3.10; plan § The measured duration) with the REAL ffprobe and ffmpeg.
//
// `prepareAudio.measured.test.ts` proves where and how the rule is applied with `normalize` and `probe` INJECTED, so it never sees
// what the real decoder reports. This file runs the real ones through `createPrepareAudio`: a recording whose stored pieces claim a
// duration its audio does not have, which is how the creator's browser could be wrong, exactly as the recording API lets a client
// confirm each piece with any `durationMs` up to 15 s. The measured duration is then what ffprobe reads from the re-encoded audio.ogg
// (`normalizeAudio`), and the meeting must hold that, still `processing`. Skipped where the binaries are not installed, as
// `prepare.real.test.ts`.

useKit();
const hasFfmpeg = Bun.which(ffmpegBinary()) !== null && Bun.which(ffprobeBinary()) !== null;
const scratch = mkdtempSync(join(tmpdir(), "prepare-measured-real-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const HOUR = 60 * 60_000;

const ctxFor = (meetingId: string): JobContext => ({
  job: { id: "job-1", kind: "prepare_audio", meetingId, summaryId: null, noticeId: null, attemptId: null, attempts: 1, maxAttempts: 3 },
  attemptId: null,
  attempt: 1,
  signal: new AbortController().signal,
  commit: async (fn) => ({ committed: true, value: await db.$transaction(fn) }),
});

describe.skipIf(!hasFfmpeg)("prepare_audio measures the real audio before keeping or replacing a held duration (AC-3.8, AC-3.10)", () => {
  const ff = async (args: string[]) => {
    const r = await runTool(ffmpegBinary(), ["-v", "error", "-y", ...args], { timeoutMs: 120_000 });
    expect(r.code).toBe(0);
  };

  /** A real Opus-in-WebM tone of `seconds`; returns its bytes and the length ffprobe reads from the file itself. */
  async function tone(name: string, seconds: number): Promise<{ bytes: Uint8Array; trueMs: number }> {
    const file = join(scratch, `${name}.webm`);
    await ff(["-f", "lavfi", "-i", `sine=f=440:d=${seconds}`, "-c:a", "libopus", "-b:a", "24k", "-f", "webm", file]);
    const probed = await probeMedia(file);
    if (!probed.ok || probed.durationMs === null) throw new Error("the generated tone has no probed duration");
    return { bytes: new Uint8Array(readFileSync(file)), trueMs: probed.durationMs };
  }

  /** A recording in `processing`: the file cut into `claims.length` consecutive pieces, piece i confirmed as `claims[i]` ms; the meeting holds their sum. */
  async function recording(bytes: Uint8Array, claims: number[]) {
    const held = claims.reduce((sum, ms) => sum + ms, 0);
    const m = await mkMeeting({ status: "processing", stage: "preparing", durationMs: held, processingStartedAt: new Date() });
    const session = await db.recordingSession.create({ data: { meetingId: m.id, endedAt: new Date(), endReason: "stopped", capturedMs: held } });
    const size = Math.ceil(bytes.length / claims.length);
    for (const [seq, claimed] of claims.entries()) {
      const piece = bytes.subarray(seq * size, Math.min((seq + 1) * size, bytes.length));
      expect(piece.length, `piece ${seq} holds at least one byte`).toBeGreaterThan(0);
      const key = objectKeys.chunk(m.id, seq);
      kit.storage.put(key, piece.length, "audio/webm", new Uint8Array(piece));
      await db.recordingChunk.create({ data: { meetingId: m.id, seq, sessionId: session.id, objectKey: key, sizeBytes: piece.length, durationMs: claimed, storedAt: new Date() } });
    }
    return { m, held };
  }

  const run = (meetingId: string) => createPrepareAudio({ tmpRoot: mkdtempSync(join(scratch, "root-")) })(ctxFor(meetingId));
  const reread = (id: string) => db.meeting.findUniqueOrThrow({ where: { id } });

  it("240 pieces that each claim 15 s (one hour held) over 12 s of real audio: the meeting holds what ffprobe reads, and is still processing", async () => {
    const { bytes, trueMs } = await tone("claim-hour", 12);
    const { m, held } = await recording(bytes, Array.from({ length: 240 }, () => 15_000));
    expect(held).toBe(HOUR);

    await run(m.id);

    const row = await reread(m.id);
    expect(row.status, "the correction lands before the meeting leaves processing (design G7, R10)").toBe("processing");
    expect(row.audioKey).toBe(objectKeys.audio(m.id));
    expect(row.durationMs).not.toBe(HOUR);
    expect(Math.abs(row.durationMs! - trueMs), `held ${HOUR} ms, the file's own length ${trueMs} ms, the meeting now holds ${row.durationMs} ms`).toBeLessThan(600);
    expect(await db.meetingJob.count({ where: { meetingId: m.id, kind: "transcribe" } }), "the next job is queued").toBe(1);
    // A43: the recorder's own figure is the sum of the stored pieces, and the correction never touches it.
    const stored = await db.recordingChunk.aggregate({ where: { meetingId: m.id }, _sum: { durationMs: true } });
    expect(stored._sum.durationMs).toBe(HOUR);
  });

  it("a recording that claims far LESS than its audio (5 s over 45 s: 40 s apart, past the 30 s floor) is corrected upwards too", async () => {
    const { bytes, trueMs } = await tone("claim-short", 45);
    const { m } = await recording(bytes, [5_000]);

    await run(m.id);

    const row = await reread(m.id);
    expect(row.status).toBe("processing");
    expect(Math.abs(row.durationMs! - trueMs), `the meeting holds ${row.durationMs} ms, the file is ${trueMs} ms`).toBeLessThan(600);
  });

  it("a claim within the margin stays as held: 12.5 s claimed over 12 s of audio, the held figure stands (AC-3.10)", async () => {
    const { bytes } = await tone("claim-near", 12);
    const { m } = await recording(bytes, [12_500]);

    await run(m.id);

    const row = await reread(m.id);
    expect(row.durationMs, "0.5 s apart is noise, not a correction").toBe(12_500);
    expect(row.audioKey).toBe(objectKeys.audio(m.id));
  });
});
