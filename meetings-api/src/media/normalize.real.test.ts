import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_SECONDS, NormalizeError, normalizeAudio } from "./normalize";
import { ffmpegBinary, ffprobeBinary, probeMedia, runTool } from "./probe";

// OWASP A04/A05 (security fix round 2, N1) with the REAL ffmpeg and ffprobe: a small, highly
// compressible upload whose header says nothing (or something short) about how long it decodes
// must be stopped by the OUTPUT caps, not by the 20-minute timeout, and must not be written
// past them. Skipped where the binaries are not installed (run in a container).

const hasFfmpeg = Bun.which(ffmpegBinary()) !== null && Bun.which(ffprobeBinary()) !== null;
const scratch = mkdtempSync(join(tmpdir(), "normalize-real-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Seconds of silence the bomb decodes to: a few hundred KB as FLAC, far more audio than any cap used below. */
const BOMB_SECONDS = 6000;

/**
 * A FLAC bomb: digital silence compresses to almost nothing. STREAMINFO's total_samples (36 bits:
 * byte 21's low nibble and bytes 22-25) is rewritten: 0 means "unknown" (no duration at all), a
 * small number understates it; the decoder ignores the field and decodes every frame.
 */
async function bomb(name: string, declaredSamples: number): Promise<string> {
  const source = join(scratch, `${name}-src.flac`);
  const made = await runTool(ffmpegBinary(), ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", String(BOMB_SECONDS), "-c:a", "flac", source], { timeoutMs: 120_000 });
  expect(made.code).toBe(0);
  const bytes = new Uint8Array(readFileSync(source));
  bytes[21] = bytes[21]! & 0xf0; // the high 4 bits of total_samples: 0 for any value below 2^32
  bytes[22] = (declaredSamples >>> 24) & 0xff;
  bytes[23] = (declaredSamples >>> 16) & 0xff;
  bytes[24] = (declaredSamples >>> 8) & 0xff;
  bytes[25] = declaredSamples & 0xff;
  const path = join(scratch, `${name}.flac`);
  writeFileSync(path, bytes);
  return path;
}

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

describe.skipIf(!hasFfmpeg)("normalizeAudio output caps with the real ffmpeg", () => {
  it("the bomb is small and its header lies: no duration at all, or 5 s, for a file that decodes to 100 minutes", async () => {
    const noDuration = await bomb("nodur", 0);
    const understated = await bomb("short", 16_000 * 5);
    expect(sizeOf(noDuration)).toBeLessThan(5 * 1024 * 1024);
    expect(await probeMedia(noDuration)).toMatchObject({ ok: true, durationMs: null, format: "flac" });
    expect(await probeMedia(understated)).toMatchObject({ ok: true, durationMs: 5000, format: "flac" });
    // An upload must state its length; the understated one passes this check and is the cap's job.
    expect(await probeMedia(noDuration, { requireDuration: true })).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("an understated duration: decoding stops at the duration cap, the result is too_long, nothing is written past the cap", async () => {
    const input = await bomb("short2", 16_000 * 5);
    const output = join(scratch, "short2.ogg");
    const started = Date.now();
    const error = await normalizeAudio({ inputs: [input], inputFormats: ["flac"], output, limits: { maxSeconds: 30 } }).catch((e) => e);
    expect(error).toBeInstanceOf(NormalizeError);
    expect((error as NormalizeError).code).toBe("too_long");
    // 30 s of 32 kbit/s Opus is ~120 KB; the full 6000 s would be ~24 MB.
    expect(sizeOf(output)).toBeLessThan(400 * 1024);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("no duration in the header (a recording-style run): the same cap applies", async () => {
    const input = await bomb("nodur2", 0);
    const output = join(scratch, "nodur2.ogg");
    const error = await normalizeAudio({ inputs: [input], inputFormats: ["flac"], output, limits: { maxSeconds: 30 } }).catch((e) => e);
    expect((error as NormalizeError).code).toBe("too_long");
    expect(sizeOf(output)).toBeLessThan(400 * 1024);
  });

  it("the byte cap stops ffmpeg on its own: output stays within a few pages of the cap, and is too_long", async () => {
    const input = await bomb("bytes", 0);
    const output = join(scratch, "bytes.ogg");
    const cap = 60_000; // reached long before the (huge) duration cap
    const error = await normalizeAudio({ inputs: [input], inputFormats: ["flac"], output, limits: { maxBytes: cap } }).catch((e) => e);
    expect((error as NormalizeError).code).toBe("too_long");
    expect(sizeOf(output)).toBeGreaterThanOrEqual(cap);
    expect(sizeOf(output)).toBeLessThan(cap + 64 * 1024);
  });

  it("two runs joined by the concat filter are capped as one output", async () => {
    const a = await bomb("runa", 0);
    const b = await bomb("runb", 0);
    const output = join(scratch, "runs.ogg");
    const error = await normalizeAudio({ inputs: [a, b], inputFormats: ["flac", "flac"], output, limits: { maxSeconds: 30 } }).catch((e) => e);
    expect((error as NormalizeError).code).toBe("too_long");
    expect(sizeOf(output)).toBeLessThan(400 * 1024);
  });

  it("an honest file is untouched by the caps: 3 s in, ~3 s out, with the real default caps", async () => {
    const input = join(scratch, "honest.flac");
    const made = await runTool(ffmpegBinary(), ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:a", "flac", input], { timeoutMs: 60_000 });
    expect(made.code).toBe(0);
    const { durationMs } = await normalizeAudio({ inputs: [input], inputFormats: ["flac"], output: join(scratch, "honest.ogg") });
    expect(Math.abs(durationMs - 3000)).toBeLessThan(200);
    expect(MAX_OUTPUT_SECONDS * 1000).toBeGreaterThan(durationMs);
    expect(MAX_OUTPUT_BYTES).toBeGreaterThan(sizeOf(join(scratch, "honest.ogg")));
  });
});
