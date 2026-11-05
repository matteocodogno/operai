/**
 * Splitting one recording into OVERLAPPING parts for Chirp 3 (specs/021-meetings plan.md § Amendment 2026-11-05
 * G-3 and #2 H-1, ADR-0069, ADR-0070; AC-6.1, AC-6.2, AC-6.5, AC-6.10, AC-6.11, AC-6.14).
 *
 * Google accepts at most 20 minutes of audio per `BatchRecognize` file and, measured (T107), silently drops speech
 * from parts much longer than 10 minutes, so a recording is transcribed in parts of at most `PIECE_MAX_MS`. Each part
 * overlaps the next by 60-120 s, so that the speech of the overlap is transcribed twice: that is what lets the stitcher
 * (src/ai/stitch.ts) remove duplicates and decide, from text alone, which speaker labels are the same person.
 *
 *   1. a decode pass with `silencedetect` on a SPEECH-BAND signal finds the pauses and, from the same pass, the sound
 *      intervals the gap detector uses. It runs on EVERY recording, also one of a single part (about 1-2 s for 10 min);
 *   2. `chooseParts` puts both edges of every part in a pause where one exists (the garbled first sentence of a part
 *      then lies inside the overlap, where the previous part's version covers it);
 *   3. each part is one STREAM COPY with output seeking (`-ss <s> -t <len> -c copy -f ogg`): no re-encode, exact to one
 *      20 ms Opus packet, about a second for 3 h. The segment muxer cannot write overlapping pieces, so it is retired.
 *
 * The constants are code, never environment (plan H-1); T125 (O14) confirms them on real recordings.
 *
 * HARDENING (ADR-0064, unchanged): the input is our own derived `audio.ogg`, never a user-chosen file, and still
 * every ffmpeg runs with `-protocol_whitelist file`, the input format pinned (`-f ogg`) and `-format_whitelist`,
 * a minimal child environment (`PATH`, `TMPDIR`: none of the service's secrets, the Google key above all), a
 * timeout, an output size cap and the job's work directory. The whole stretch runs inside the process's one
 * ffmpeg slot (`withFfmpegSlot`).
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { withFfmpegSlot } from "./ffmpegSlot";
import { MAX_NORMALIZED_MS } from "./normalize";
import { FORMAT_WHITELIST, ToolMissingError, ffmpegBinary, ffprobeBinary, judgeProbe, buildProbeArgs, runTool } from "./probe";

export { ToolMissingError };

/**
 * The longest part, the overlap INCLUDED: 10 minutes (T107, recorded against the real service). Two limits, and the
 * second is the one that binds:
 *  - Google's docs say a Chirp 3 batch file is "good for long audio 1 minute to 1 hour", but a 1 h file is refused
 *    with INVALID_ARGUMENT "Only audio files up to 20 minutes long are supported for BatchRecognize" (billed 0 s);
 *  - at 18-19 minutes the service ACCEPTED the parts and then silently left out multi-minute stretches of speech
 *    (45 % and 19 % of the words missing in 2 of 4 parts of a 1 h recording, whose words are otherwise timed to
 *    the second), while 7 parts of 10 minutes of the same recording came back complete (98-103 %).
 */
export const PIECE_MAX_MS = 10 * 60_000;
/**
 * How far consecutive parts overlap (H-1): the next part starts in a pause 60-120 s before the end of this one, else
 * 90 s before it. A speaker reaches the 20-word match bound with about 8-10 s of speech inside 90 s.
 */
export const OVERLAP_TARGET_MS = 90_000;
export const OVERLAP_MIN_MS = 60_000;
export const OVERLAP_MAX_MS = 120_000;
/** A part's end is looked for in this long a stretch before the mark. */
export const CUT_WINDOW_MS = 90_000;
/** A pause shorter than this is not a place to cut. */
export const MIN_SILENCE_MS = 500;
/** `silencedetect` threshold (plan G-3), measured on the speech band so hum and rumble are not "sound". */
export const SILENCE_NOISE_DB = -35;
export const SPEECH_BAND_FILTER = "highpass=f=150,lowpass=f=4000";
/** A sanity ceiling on the number of parts: 3 h + 60 s needs 22, the worst case (every cut at the window edge) 28. */
export const MAX_PARTS = 32;

const SILENCE_PASS_TIMEOUT_MS = 5 * 60_000;
const PART_PASS_TIMEOUT_MS = 2 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
/** silencedetect logs two lines per pause: a 3 h recording can produce a few MB. */
const SILENCE_OUTPUT_BYTES = 16 * 1024 * 1024;

/** The input cannot be split: ffmpeg refused it or gave an answer that is not the expected shape. Permanent. */
export class SplitError extends Error {
  constructor() {
    super("audio_unreadable");
    this.name = "SplitError";
  }
}

export interface Silence {
  readonly startMs: number;
  readonly endMs: number;
}

export interface PartSpan {
  readonly startMs: number;
  readonly endMs: number;
}

export interface SplitPart extends PartSpan {
  /** An absolute path under the work directory (or the input itself when there is one part). */
  readonly path: string;
}

export interface SplitResult {
  /** In order; consecutive parts overlap. Part 1 always starts at 0 and the last ends at `durationMs`. */
  readonly parts: SplitPart[];
  /** The pauses of the whole recording (speech band, at least `MIN_SILENCE_MS`): the complement is "sound" (H-3). */
  readonly silences: Silence[];
  readonly durationMs: number;
}

// ─── Pure pieces ─────────────────────────────────────────────────────────────

const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;

/** The pauses `silencedetect` reported (it logs `silence_start` then `silence_end` for each). A trailing open one is dropped. */
export function parseSilences(log: string): Silence[] {
  const out: Silence[] = [];
  let open: number | null = null;
  for (const line of log.split("\n")) {
    const start = new RegExp(`silence_start:\\s*${NUMBER}`).exec(line);
    if (start) {
      open = Math.round(Number(start[1]) * 1000);
      continue;
    }
    const end = new RegExp(`silence_end:\\s*${NUMBER}`).exec(line);
    if (end && open !== null) {
      const endMs = Math.round(Number(end[1]) * 1000);
      if (Number.isFinite(open) && Number.isFinite(endMs) && endMs > open) out.push({ startMs: Math.max(0, open), endMs });
      open = null;
    }
  }
  return out;
}

/** The last `time=HH:MM:SS.xx` of an ffmpeg progress line: how long the decode ran, i.e. the duration. */
export function parseElapsedMs(log: string): number | null {
  const all = [...log.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const last = all[all.length - 1];
  if (!last) return null;
  return Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000);
}

export interface ChooseOptions {
  readonly pieceMaxMs?: number;
  /** The target overlap; the bounds scale with it (2/3 and 4/3: 60/90/120 s by default). */
  readonly overlapTargetMs?: number;
  readonly cutWindowMs?: number;
}

/** The middle of the longest pause (at least `MIN_SILENCE_MS`) within `[lo, hi]`, clipped to it; on a tie the later. */
function longestPauseMiddle(silences: readonly Silence[], lo: number, hi: number): number | null {
  let best: { from: number; to: number } | null = null;
  for (const silence of silences) {
    const from = Math.max(silence.startMs, lo);
    const to = Math.min(silence.endMs, hi);
    if (to - from < MIN_SILENCE_MS) continue;
    if (best === null || to - from > best.to - best.from || (to - from === best.to - best.from && from > best.from)) best = { from, to };
  }
  return best === null ? null : Math.round((best.from + best.to) / 2);
}

/**
 * The parts of `durationMs` of audio (plan H-1). Part k ends in the middle of the longest pause in the stretch
 * before its mark (`s_k + pieceMaxMs`), else at the mark; part k+1 starts in the middle of the longest pause
 * `OVERLAP_MIN..OVERLAP_MAX` before that end, else `OVERLAP_TARGET` before it. A recording no longer than a part is
 * one part. Pure. Throws `SplitError` when more than `MAX_PARTS` would be needed.
 */
export function chooseParts(durationMs: number, silences: readonly Silence[], options: ChooseOptions = {}): PartSpan[] {
  const piece = options.pieceMaxMs ?? PIECE_MAX_MS;
  if (!(piece > 0)) throw new Error("pieceMaxMs must be positive");
  const target = options.overlapTargetMs ?? OVERLAP_TARGET_MS;
  const overlapMin = Math.round((target * OVERLAP_MIN_MS) / OVERLAP_TARGET_MS);
  const overlapMax = Math.round((target * OVERLAP_MAX_MS) / OVERLAP_TARGET_MS);
  const window = options.cutWindowMs ?? CUT_WINDOW_MS;

  const parts: PartSpan[] = [];
  let start = 0;
  for (;;) {
    if (durationMs - start <= piece) {
      parts.push({ startMs: start, endMs: durationMs });
      return parts;
    }
    if (parts.length + 1 >= MAX_PARTS) throw new SplitError();
    const mark = start + piece;
    // Never reach back past half a part plus the largest overlap, so the next part always starts at least half a part
    // after this one (at production values that is 420 s, inside the 510 s the window already enforces).
    const end = longestPauseMiddle(silences, Math.max(start + Math.ceil(piece / 2) + overlapMax, mark - window), mark) ?? mark;
    parts.push({ startMs: start, endMs: end });
    const next = longestPauseMiddle(silences, end - overlapMax, end - overlapMin) ?? end - target;
    if (next <= start) throw new SplitError(); // cannot happen with a sane overlap; never loop
    start = next;
  }
}

const INPUT = (file: string): string[] => ["-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST, "-f", "ogg", "-i", file];

export const buildSilenceArgs = (input: string): string[] => [
  "-nostdin", "-v", "info", "-hide_banner",
  ...INPUT(input),
  "-vn", "-sn", "-dn",
  "-af", `${SPEECH_BAND_FILTER},silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${MIN_SILENCE_MS / 1000}`,
  "-f", "null", "-",
];

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

/** One part: the input demuxed from the start (no decode), packets from `startMs` for `endMs - startMs`, copied. */
export const buildPartArgs = (input: string, startMs: number, endMs: number, output: string): string[] => [
  "-nostdin", "-v", "error", "-hide_banner", "-y",
  ...INPUT(input),
  "-vn", "-sn", "-dn",
  "-ss", seconds(startMs), "-t", seconds(endMs - startMs),
  "-c", "copy", "-f", "ogg",
  output,
];

// ─── The split ───────────────────────────────────────────────────────────────

export interface SplitOptions {
  /** The normalised `audio.ogg`, an absolute path. */
  readonly input: string;
  /** The job's own work directory: the parts are written here. */
  readonly workDir: string;
  readonly pieceMaxMs?: number;
  readonly overlapTargetMs?: number;
  /** A lost lease aborts the wait for the slot and kills the running ffmpeg. */
  readonly signal?: AbortSignal;
  readonly ffmpegBin?: string;
  readonly ffprobeBin?: string;
}

/**
 * Parts of `input`, in order and overlapping, with the pauses of the whole recording. One part (the input itself)
 * when it is no longer than `pieceMaxMs`. Throws `SplitError` for audio ffmpeg cannot read, `ToolMissingError` for a
 * broken install.
 */
export async function splitAudio(options: SplitOptions): Promise<SplitResult> {
  const ffmpeg = options.ffmpegBin ?? ffmpegBinary();
  const ffprobe = options.ffprobeBin ?? ffprobeBinary();
  const tool = { tmpDir: options.workDir, cwd: options.workDir, ...(options.signal ? { signal: options.signal } : {}) };

  return withFfmpegSlot(async () => {
    // How long is it? The header says (our own file); a missing one is read off the decode pass below.
    const probed = await runTool(ffprobe, buildProbeArgs(options.input, "ogg"), { ...tool, timeoutMs: PROBE_TIMEOUT_MS });
    if (probed.timedOut || probed.code !== 0) throw new SplitError();
    let verdict: ReturnType<typeof judgeProbe>;
    try {
      verdict = judgeProbe(JSON.parse(probed.stdout), MAX_NORMALIZED_MS);
    } catch {
      throw new SplitError();
    }
    if (!verdict.ok) throw new SplitError();

    // Always: the gap detector needs the sound intervals of every recording (H-3), not only of the long ones.
    const pass = await runTool(ffmpeg, buildSilenceArgs(options.input), { ...tool, timeoutMs: SILENCE_PASS_TIMEOUT_MS, maxOutputBytes: SILENCE_OUTPUT_BYTES });
    if (pass.timedOut || pass.code !== 0) throw new SplitError();
    const durationMs = verdict.durationMs ?? parseElapsedMs(pass.stderr);
    if (durationMs === null || durationMs <= 0) throw new SplitError();
    const silences = parseSilences(pass.stderr);

    const spans = chooseParts(durationMs, silences, {
      ...(options.pieceMaxMs !== undefined ? { pieceMaxMs: options.pieceMaxMs } : {}),
      ...(options.overlapTargetMs !== undefined ? { overlapTargetMs: options.overlapTargetMs } : {}),
    });
    if (spans.length === 1) return { parts: [{ path: options.input, startMs: 0, endMs: durationMs }], silences, durationMs };

    const parts: SplitPart[] = [];
    for (const [index, span] of spans.entries()) {
      const path = join(options.workDir, `part-${String(index + 1).padStart(3, "0")}.ogg`);
      const written = await runTool(ffmpeg, buildPartArgs(options.input, span.startMs, span.endMs, path), { ...tool, timeoutMs: PART_PASS_TIMEOUT_MS });
      if (written.timedOut || written.code !== 0) throw new SplitError();
      // A part that was not written is a failed split, not an empty part.
      const info = await stat(path).catch(() => null);
      if (info === null || !info.isFile()) throw new SplitError();
      parts.push({ path, startMs: span.startMs, endMs: span.endMs });
    }
    return { parts, silences, durationMs };
  }, options.signal);
}
