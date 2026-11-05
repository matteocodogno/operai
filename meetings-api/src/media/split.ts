/**
 * Splitting one recording into parts for Chirp 3 (specs/021-meetings plan.md § Amendment 2026-11-05 G-3,
 * ADR-0069, ADR-0070; AC-6.1, AC-6.2, AC-6.5, AC-6.10).
 *
 * Google accepts at most 20 minutes of audio per `BatchRecognize` file (measured, T107), and our meetings run
 * to 3 h + 60 s, so a long recording is transcribed in parts of at most `PIECE_MAX_MS`:
 *
 *   1. a decode pass with `silencedetect` finds the pauses (about 10-30 s for 3 h of 16 kHz mono Opus);
 *   2. each cut is the longest pause of at least 0.5 s within the `CUT_WINDOW_MS` before each mark, else a
 *      hard cut at the mark: a sentence is rarely cut in half;
 *   3. a STREAM COPY (`-c copy -f segment`) writes the parts, cut at Opus packet boundaries (20 ms), with no
 *      re-encode; `parts.csv` gives the authoritative start of each one.
 *
 * `PIECE_MAX_MS` is a constant in code, not environment, set by the Google spike (T107). The code handles N >= 1
 * parts identically; a recording no longer than the constant is NOT re-muxed at all: its one part is the input file.
 *
 * HARDENING (ADR-0064, unchanged): the input is our own derived `audio.ogg`, never a user-chosen file, and still
 * every ffmpeg runs with `-protocol_whitelist file`, the input format pinned (`-f ogg`) and `-format_whitelist`,
 * a minimal child environment (`PATH`, `TMPDIR`: none of the service's secrets, the Google key above all), a
 * timeout, an output size cap and the job's work directory. The whole stretch runs inside the process's one
 * ffmpeg slot (`withFfmpegSlot`).
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { withFfmpegSlot } from "./ffmpegSlot";
import { MAX_NORMALIZED_MS } from "./normalize";
import { FORMAT_WHITELIST, ToolMissingError, ffmpegBinary, ffprobeBinary, judgeProbe, buildProbeArgs, runTool } from "./probe";

export { ToolMissingError };

/**
 * The longest part: 10 minutes (T107, recorded against the real service). Two limits, and the second is the one
 * that binds:
 *  - Google's docs say a Chirp 3 batch file is "good for long audio 1 minute to 1 hour", but a 1 h file is refused
 *    with INVALID_ARGUMENT "Only audio files up to 20 minutes long are supported for BatchRecognize" (billed 0 s);
 *  - at 18-19 minutes the service ACCEPTED the parts and then silently left out multi-minute stretches of speech
 *    (45 % and 19 % of the words missing in 2 of 4 parts of a 1 h recording, whose words are otherwise timed to
 *    the second), while 7 parts of 10 minutes of the same recording came back complete (98-103 %).
 * A transcript with a hole in it that nothing flags is worse than one with more speaker labels to merge.
 */
export const PIECE_MAX_MS = 10 * 60_000;
/** A cut is looked for in this long a stretch before each mark. */
export const CUT_WINDOW_MS = 90_000;
/** A pause shorter than this is not a place to cut. */
export const MIN_SILENCE_MS = 500;
/** `silencedetect` threshold (plan G-3). */
export const SILENCE_NOISE_DB = -35;
/** A sanity ceiling on the number of parts, independent of the constants above. */
export const MAX_PARTS = 32;

const SILENCE_PASS_TIMEOUT_MS = 5 * 60_000;
const SEGMENT_PASS_TIMEOUT_MS = 5 * 60_000;
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

export interface SplitPart {
  /** An absolute path under the work directory (or the input itself when there is one part). */
  readonly path: string;
  /** Where this part starts in the whole recording. Part 1 is always 0. */
  readonly startMs: number;
  /** How long it is, when known (the header of the input, or `parts.csv`): bounds the word times a transcript may claim. */
  readonly durationMs?: number;
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

/**
 * Where to cut `durationMs` of audio into parts of at most `pieceMaxMs`. Each cut is the middle of the longest
 * pause (at least `MIN_SILENCE_MS`) lying within `windowMs` before the mark, else the mark itself. Pure.
 */
export function chooseCuts(durationMs: number, silences: readonly Silence[], pieceMaxMs: number = PIECE_MAX_MS, windowMs: number = CUT_WINDOW_MS): number[] {
  if (!(pieceMaxMs > 0)) throw new Error("pieceMaxMs must be positive");
  const cuts: number[] = [];
  let start = 0;
  while (durationMs - start > pieceMaxMs) {
    const mark = start + pieceMaxMs;
    // Never reach back past half a part: the pause the previous cut used must not be cut in again.
    const lo = Math.max(start + Math.ceil(pieceMaxMs / 2), mark - windowMs);
    let best: { from: number; to: number } | null = null;
    for (const silence of silences) {
      const from = Math.max(silence.startMs, lo);
      const to = Math.min(silence.endMs, mark);
      if (to - from < MIN_SILENCE_MS) continue;
      // The longest wins; on a tie the later one (fewer words carried into the next part).
      if (best === null || to - from >= best.to - best.from) best = { from, to };
    }
    const cut = best === null ? mark : Math.round((best.from + best.to) / 2);
    cuts.push(cut);
    start = cut;
  }
  return cuts;
}

const SEGMENT_NAME = /^part-\d{3}\.ogg$/;

/** `parts.csv` of the segment muxer: `name,start,end` in seconds. Anything that is not that shape is refused. */
export function parseSegmentList(csv: string): { name: string; startMs: number; endMs: number }[] {
  const rows: { name: string; startMs: number; endMs: number }[] = [];
  for (const line of csv.split("\n")) {
    if (line.trim() === "") continue;
    const cells = line.trim().split(",");
    const [name, start, end] = cells;
    if (cells.length !== 3 || name === undefined || start === undefined || end === undefined || !SEGMENT_NAME.test(name)) throw new SplitError();
    const startMs = Math.round(Number(start) * 1000);
    const endMs = Math.round(Number(end) * 1000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) throw new SplitError();
    rows.push({ name, startMs, endMs });
  }
  return rows;
}

const INPUT = (file: string): string[] => ["-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST, "-f", "ogg", "-i", file];

export const buildSilenceArgs = (input: string): string[] => [
  "-nostdin", "-v", "info", "-hide_banner",
  ...INPUT(input),
  "-vn", "-sn", "-dn",
  "-af", `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${MIN_SILENCE_MS / 1000}`,
  "-f", "null", "-",
];

export const buildSegmentArgs = (input: string, cutsMs: readonly number[], listFile: string, outputPattern: string): string[] => [
  "-nostdin", "-v", "error", "-hide_banner", "-y",
  ...INPUT(input),
  "-vn", "-sn", "-dn", "-c", "copy",
  "-f", "segment",
  "-segment_times", cutsMs.map((ms) => (ms / 1000).toFixed(3)).join(","),
  "-segment_format", "ogg",
  "-segment_list", listFile,
  "-segment_list_type", "csv",
  "-reset_timestamps", "1",
  outputPattern,
];

// ─── The split ───────────────────────────────────────────────────────────────

export interface SplitOptions {
  /** The normalised `audio.ogg`, an absolute path. */
  readonly input: string;
  /** The job's own work directory: the parts and `parts.csv` are written here. */
  readonly workDir: string;
  readonly pieceMaxMs?: number;
  /** A lost lease aborts the wait for the slot and kills the running ffmpeg. */
  readonly signal?: AbortSignal;
  readonly ffmpegBin?: string;
  readonly ffprobeBin?: string;
}

/**
 * Parts of `input`, in order, with their start offsets. One part (the input itself) when it is no longer than
 * `pieceMaxMs`. Throws `SplitError` for audio ffmpeg cannot read, `ToolMissingError` for a broken install.
 */
export async function splitAudio(options: SplitOptions): Promise<SplitPart[]> {
  const pieceMaxMs = options.pieceMaxMs ?? PIECE_MAX_MS;
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
    let durationMs: number | null = verdict.durationMs;

    if (durationMs !== null && durationMs <= pieceMaxMs) return [{ path: options.input, startMs: 0, durationMs }];

    const pass = await runTool(ffmpeg, buildSilenceArgs(options.input), { ...tool, timeoutMs: SILENCE_PASS_TIMEOUT_MS, maxOutputBytes: SILENCE_OUTPUT_BYTES });
    if (pass.timedOut || pass.code !== 0) throw new SplitError();
    durationMs ??= parseElapsedMs(pass.stderr);
    if (durationMs === null) throw new SplitError();
    if (durationMs <= pieceMaxMs) return [{ path: options.input, startMs: 0, durationMs }];

    const cuts = chooseCuts(durationMs, parseSilences(pass.stderr), pieceMaxMs);
    if (cuts.length + 1 > MAX_PARTS) throw new SplitError();

    const listFile = join(options.workDir, "parts.csv");
    const segmented = await runTool(ffmpeg, buildSegmentArgs(options.input, cuts, listFile, join(options.workDir, "part-%03d.ogg")), {
      ...tool,
      timeoutMs: SEGMENT_PASS_TIMEOUT_MS,
    });
    if (segmented.timedOut || segmented.code !== 0) throw new SplitError();

    const rows = parseSegmentList(await readFile(listFile, "utf8").catch(() => {
      throw new SplitError();
    }));
    // Every cut must have produced a part, the first must start at 0 and they must run forward.
    if (rows.length !== cuts.length + 1 || rows[0]!.startMs !== 0) throw new SplitError();
    for (let i = 1; i < rows.length; i += 1) if (rows[i]!.startMs < rows[i - 1]!.startMs) throw new SplitError();
    return rows.map((row) => ({ path: join(options.workDir, row.name), startMs: row.startMs, durationMs: row.endMs - row.startMs }));
  }, options.signal);
}
