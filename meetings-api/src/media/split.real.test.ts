import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegBinary, ffprobeBinary, runTool } from "./probe";
import { SplitError, splitAudio } from "./split";

// The REAL ffmpeg (skipped where the binaries are not installed; run in the ffmpeg image).
// A 75 s fixture with a 3 s pause ending every 30 s, split with PIECE_MAX_MS overridden to 30 s.

const hasFfmpeg = Bun.which(ffmpegBinary()) !== null && Bun.which(ffprobeBinary()) !== null;
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "split-real-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg)("splitAudio with the real ffmpeg", () => {
  it("cuts inside the pauses, by stream copy, with offsets from parts.csv", async () => {
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
    const parts = await splitAudio({ input, workDir: work, pieceMaxMs: 30_000 });
    expect(parts.length).toBe(3);
    expect(parts[0]!.startMs).toBe(0);
    // Every cut falls inside a pause: 27-30 s or 57-60 s (a packet boundary of slack).
    const inPause = (ms: number) => (ms >= 26_900 && ms <= 30_100) || (ms >= 56_900 && ms <= 60_100);
    expect(inPause(parts[1]!.startMs)).toBe(true);
    expect(inPause(parts[2]!.startMs)).toBe(true);
    // The parts exist, are Ogg, and no part is longer than the maximum.
    for (const part of parts) {
      expect(Buffer.from(readFileSync(part.path).subarray(0, 4)).toString("latin1")).toBe("OggS");
    }
    expect(parts[1]!.startMs - parts[0]!.startMs).toBeLessThanOrEqual(30_100);
    expect(parts[2]!.startMs - parts[1]!.startMs).toBeLessThanOrEqual(30_100);
  });

  it("a recording within one part is not re-muxed", async () => {
    const input = join(scratch, "audio.ogg");
    mkdirSync(join(scratch, "work"), { recursive: true });
    const parts = await splitAudio({ input, workDir: join(scratch, "work"), pieceMaxMs: 120_000 });
    expect(parts).toEqual([{ path: input, startMs: 0 }]);
  });

  it("refuses a file that is not Ogg audio (a playlist names other URLs)", async () => {
    const playlist = join(import.meta.dir, "../../test-fixtures/media/playlist.m3u8");
    mkdirSync(join(scratch, "work"), { recursive: true });
    await expect(splitAudio({ input: playlist, workDir: join(scratch, "work") })).rejects.toBeInstanceOf(SplitError);
  });
});
