import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegBinary, ffprobeBinary, runTool } from "./probe";
import { SplitError, splitAudio } from "./split";

// The REAL ffmpeg (skipped where the binaries are not installed; run in the ffmpeg image).
// A 75 s fixture with a 3 s pause ending every 30 s, split with PIECE_MAX_MS overridden to 30 s and an overlap of 10 s.

const hasFfmpeg = Bun.which(ffmpegBinary()) !== null && Bun.which(ffprobeBinary()) !== null;
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "split-real-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg)("splitAudio with the real ffmpeg", () => {
  const probeDurationMs = async (path: string): Promise<number> => {
    const out = await runTool(ffprobeBinary(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path], { timeoutMs: 30_000 });
    expect(out.code).toBe(0);
    return Math.round(Number(out.stdout.trim()) * 1000);
  };

  it("cuts overlapping parts inside the pauses by stream copy, and the files last what the spans say (± 40 ms)", async () => {
    const input = join(scratch, "audio.ogg");
    const made = await runTool(
      ffmpegBinary(),
      [
        "-v", "error", "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:sample_rate=16000:duration=75",
        "-af", "volume='if(lt(mod(t,30),27),0.5,0)':eval=frame",
        "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", input,
      ],
      { timeoutMs: 60_000 },
    );
    expect(made.code).toBe(0);

    const work = join(scratch, "work");
    mkdirSync(work, { recursive: true });
    const { parts, silences, durationMs } = await splitAudio({ input, workDir: work, pieceMaxMs: 30_000, overlapTargetMs: 10_000 });
    expect(durationMs).toBeGreaterThanOrEqual(74_900);
    expect(durationMs).toBeLessThanOrEqual(75_100);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[0]!.startMs).toBe(0);
    expect(parts[parts.length - 1]!.endMs).toBe(durationMs);
    // The pauses of the whole recording: 27-30 s and 57-60 s (the 440 Hz tone is inside the speech band).
    expect(silences.length).toBe(2);
    for (const part of parts) {
      expect(Buffer.from(readFileSync(part.path).subarray(0, 4)).toString("latin1")).toBe("OggS");
      expect(part.endMs - part.startMs).toBeLessThanOrEqual(30_000);
      expect(Math.abs((await probeDurationMs(part.path)) - (part.endMs - part.startMs))).toBeLessThanOrEqual(40);
    }
    for (let i = 1; i < parts.length; i += 1) {
      const overlap = parts[i - 1]!.endMs - parts[i]!.startMs;
      expect(overlap).toBeGreaterThanOrEqual(6_600);
      expect(overlap).toBeLessThanOrEqual(13_400);
    }
  });

  it("a recording within one part is not re-muxed, and its silence list still comes back", async () => {
    const input = join(scratch, "audio.ogg");
    mkdirSync(join(scratch, "work"), { recursive: true });
    const { parts, silences } = await splitAudio({ input, workDir: join(scratch, "work"), pieceMaxMs: 120_000 });
    expect(parts.length).toBe(1);
    expect(parts[0]!.path).toBe(input);
    expect(parts[0]!.startMs).toBe(0);
    expect(silences.length).toBe(2);
  });

  it("refuses a file that is not Ogg audio (a playlist names other URLs)", async () => {
    const playlist = join(import.meta.dir, "../../test-fixtures/media/playlist.m3u8");
    mkdirSync(join(scratch, "work"), { recursive: true });
    await expect(splitAudio({ input: playlist, workDir: join(scratch, "work") })).rejects.toBeInstanceOf(SplitError);
  });
});
