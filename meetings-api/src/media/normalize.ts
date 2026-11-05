/**
 * Audio normalisation: whatever the browser recorded, or the user uploaded, becomes
 * ONE mono 16 kHz Opus file with no video (specs/021-meetings AC-3.1, AC-2.6, AC-4.4;
 * plan.md § Processing; ADR-0064 point 4).
 *
 * The command is the ADR's, with `-protocol_whitelist file,pipe` in front of EVERY
 * input (it is an input option) so a crafted file cannot make ffmpeg open a network
 * location, and `-vn -sn -dn` so only audio survives:
 *
 *   ffmpeg -protocol_whitelist file,pipe -i in -vn -sn -dn -ac 1 -ar 16000 -c:a libopus -b:a 32k audio.ogg
 *
 * RECORDINGS ARE NOT ONE CONTAINER. A MediaRecorder writes its container header in
 * the first chunk only, so plain concatenation of the chunks is a valid file. But the
 * capture controller rebuilds its recorder after a microphone loss + Resume, and then
 * a chunk part-way through starts a SECOND container (a WebM EBML header, or an fMP4
 * `ftyp`). Concatenated bytes then hold two files; a demuxer reads the first and
 * silently drops or garbles the rest. `groupIntoRuns` cuts the chunk list at every
 * chunk that starts a container, so each run is a valid file, and the runs are joined
 * by ffmpeg's `concat` FILTER (not the concat demuxer, which would need file access
 * beyond the whitelist): a filter graph over inputs we wrote ourselves, resampled to
 * the target format so the runs may differ in rate or channels.
 */

import { appendFile, open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_AUDIO_MS, buildProbeArgs, ffmpegBinary, ffprobeBinary, judgeProbe, runTool } from "./probe";

export { ToolMissingError } from "./probe";

/** ADR-0064 point 4. */
export const FFMPEG_TIMEOUT_MS = 20 * 60_000;
/** A recording may run 60 s past 3 h (AC-2.11); the result is held to the same bound. */
export const MAX_NORMALIZED_MS = MAX_AUDIO_MS + 60_000;
export const PROBE_OUTPUT_TIMEOUT_MS = 30_000;

/** A failure that retrying cannot fix. `code` is the meeting's closed failure code. */
export class NormalizeError extends Error {
  constructor(readonly code: "audio_unreadable" | "too_long") {
    super(code);
    this.name = "NormalizeError";
  }
}

// ─── Splitting a chunk list into containers ──────────────────────────────────

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const FTYP = [0x66, 0x74, 0x79, 0x70]; // "ftyp"

/** Does this chunk begin a container: a WebM (EBML) header, or an MP4 `ftyp` box at offset 4? */
export function startsContainer(head: Uint8Array): boolean {
  if (head.length >= 4 && EBML_MAGIC.every((b, i) => head[i] === b)) return true;
  return head.length >= 8 && FTYP.every((b, i) => head[4 + i] === b);
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Joins `chunkFiles` (in order) into one file per container, written under `dir`.
 * The first chunk always opens a run, whatever it holds: a recording whose first
 * bytes are not a known header is left for ffmpeg to refuse. Memory: one chunk (<= 8 MiB)
 * at a time.
 */
export async function groupIntoRuns(dir: string, chunkFiles: readonly string[]): Promise<string[]> {
  const runs: string[] = [];
  for (const [index, file] of chunkFiles.entries()) {
    if (index === 0 || startsContainer(await readHead(file))) {
      const run = join(dir, `run-${runs.length}`);
      await writeFile(run, new Uint8Array(0), { mode: 0o600 });
      runs.push(run);
    }
    await appendFile(runs[runs.length - 1]!, await Bun.file(file).bytes());
  }
  return runs;
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────

/** The hardened argument vector (ADR-0064 point 4); one input is exactly the documented command. */
export function buildFfmpegArgs(inputs: readonly string[], output: string): string[] {
  if (inputs.length === 0) throw new Error("nothing to normalise");
  const head = ["-nostdin", "-hide_banner", "-v", "error", "-y"];
  const perInput = inputs.flatMap((file) => ["-protocol_whitelist", "file,pipe", "-i", file]);
  const target = ["-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k"];
  if (inputs.length === 1) return [...head, ...perInput, ...target, output];

  const prepared = inputs.map((_, i) => `[${i}:a:0]aformat=sample_rates=16000:channel_layouts=mono[a${i}]`).join(";");
  const joined = inputs.map((_, i) => `[a${i}]`).join("");
  const graph = `${prepared};${joined}concat=n=${inputs.length}:v=0:a=1[out]`;
  return [...head, ...perInput, "-filter_complex", graph, "-map", "[out]", ...target, output];
}

export interface NormalizeRequest {
  /** Local files, each one valid container (see `groupIntoRuns`), in playing order. */
  readonly inputs: readonly string[];
  readonly output: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Test seams. */
  readonly ffmpegBin?: string;
  readonly ffprobeBin?: string;
}

/**
 * Runs ffmpeg, then measures the result with ffprobe: it must be one audio stream and
 * no longer than 3 h + 60 s. Returns the real duration of `output`.
 *
 * Throws `NormalizeError` for input ffmpeg cannot read or an output that is wrong, and
 * `ToolMissingError` when a binary is not installed (a deployment fault, retried).
 */
export async function normalizeAudio(request: NormalizeRequest): Promise<{ durationMs: number }> {
  const result = await runTool(request.ffmpegBin ?? ffmpegBinary(), buildFfmpegArgs(request.inputs, request.output), {
    timeoutMs: request.timeoutMs ?? FFMPEG_TIMEOUT_MS,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (result.timedOut || result.code !== 0) throw new NormalizeError("audio_unreadable");

  let size = 0;
  try {
    size = (await stat(request.output)).size;
  } catch {
    size = 0;
  }
  if (size === 0) throw new NormalizeError("audio_unreadable");

  const measured = await runTool(request.ffprobeBin ?? ffprobeBinary(), buildProbeArgs(request.output), { timeoutMs: PROBE_OUTPUT_TIMEOUT_MS });
  if (measured.timedOut || measured.code !== 0) throw new NormalizeError("audio_unreadable");
  let doc: { streams?: { codec_type?: string }[] };
  try {
    doc = JSON.parse(measured.stdout);
  } catch {
    throw new NormalizeError("audio_unreadable");
  }
  // Video never leaves this step (AC-3.1): the output is audio, nothing else.
  if ((doc.streams ?? []).some((stream) => stream.codec_type !== "audio")) throw new NormalizeError("audio_unreadable");
  const probe = judgeProbe(doc, MAX_NORMALIZED_MS);
  if (!probe.ok) throw new NormalizeError(probe.reason === "too_long" ? "too_long" : "audio_unreadable");
  if (probe.durationMs === null) throw new NormalizeError("audio_unreadable");
  return { durationMs: probe.durationMs };
}
