/**
 * `ffprobe` on a user-supplied file, hardened per ADR-0064 (specs/021-meetings
 * AC-3.1, AC-3.2; plan.md R15). A media demuxer that can follow playlists and URLs is
 * also a network client, so the file is never trusted before this says it is a plain
 * audio or video container:
 *
 *   - `-protocol_whitelist` names the ONLY protocols the input may open
 *     (`https,tls,tcp` for a presigned GET, `http,tcp` for a dev MinIO, `file` for a
 *     local path); a playlist cannot send ffprobe to another host;
 *   - the demuxer must be on the allowlist (mov/mp4/m4a, matroska/webm, ogg, wav, mp3,
 *     aac, flac) and there must be an audio stream and a duration of at most 3 h;
 *   - 30 s wall clock, output bounded, process killed on timeout.
 *
 * The verdict is DATA (`{ ok:false, reason }`), a missing binary is an ERROR
 * (`ToolMissingError`): a broken install must never read as "your file is bad".
 *
 * `FFPROBE_PATH` / `FFMPEG_PATH` (optional) override the binaries' names.
 */

/** AC-3.1: at most 3 hours of audio. */
export const MAX_AUDIO_MS = 3 * 60 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 30_000;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;

export const ffprobeBinary = (): string => process.env["FFPROBE_PATH"] ?? "ffprobe";
export const ffmpegBinary = (): string => process.env["FFMPEG_PATH"] ?? "ffmpeg";

/** ADR-0064 point 3. A demuxer name from ffprobe is a comma list (`mov,mp4,m4a,3gp,3g2,mj2`): one allowed part is enough. */
const ALLOWED_DEMUXERS: ReadonlySet<string> = new Set(["mov", "mp4", "m4a", "matroska", "webm", "ogg", "wav", "mp3", "aac", "flac"]);

export type RejectReason = "unsupported_type" | "no_audio" | "too_long";
export type ProbeVerdict =
  | { readonly ok: true; readonly durationMs: number | null; readonly format: string }
  | { readonly ok: false; readonly reason: RejectReason };

const reject = (reason: RejectReason): ProbeVerdict => ({ ok: false, reason });

// ─── Running a tool ──────────────────────────────────────────────────────────

/** The binary could not be started: a deployment fault, not a verdict on any file. */
export class ToolMissingError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} is not available`);
    this.name = "ToolMissingError";
  }
}

export interface ToolResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ToolOptions {
  readonly timeoutMs: number;
  /** Per stream; the rest is drained and dropped. */
  readonly maxOutputBytes?: number;
  readonly cwd?: string;
  /** Aborting kills the process (a job that lost its lease). */
  readonly signal?: AbortSignal;
}

async function drain(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (kept < max) {
      const piece = value.length + kept > max ? value.subarray(0, max - kept) : value;
      chunks.push(piece);
      kept += piece.length;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Runs `bin` with `args`, no shell, no stdin. Never rejects for a non-zero exit or a timeout. */
export async function runTool(bin: string, args: readonly string[], options: ToolOptions): Promise<ToolResult> {
  const max = options.maxOutputBytes ?? MAX_TOOL_OUTPUT_BYTES;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "EACCES") throw new ToolMissingError(bin.split("/").pop() ?? bin);
    throw error;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, options.timeoutMs);
  const onAbort = () => proc.kill(9);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  try {
    const out = drain(proc.stdout as ReadableStream<Uint8Array>, max);
    const err = drain(proc.stderr as ReadableStream<Uint8Array>, max);
    const code = await proc.exited;
    // A killed shell can leave a grandchild holding the pipes open: do not wait for it.
    const settle = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
      timedOut || options.signal?.aborted ? Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), 200))]) : p;
    const [stdout, stderr] = await Promise.all([settle(out, ""), settle(err, "")]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

// ─── ffprobe ─────────────────────────────────────────────────────────────────

/**
 * The protocols an input may open, by what it is. Anything that is not an absolute
 * path, an `http://` or an `https://` URL is refused before it reaches the tool, so
 * `concat:…`, `file:…`, `pipe:…` and friends cannot be smuggled in as a "source".
 */
export function protocolsFor(source: string): string {
  if (source.startsWith("https://")) return "https,tls,tcp";
  if (source.startsWith("http://")) return "http,tcp";
  if (source.startsWith("/") && !source.includes("\0")) return "file";
  throw new Error("media source is not an absolute path or an http(s) URL");
}

export function buildProbeArgs(source: string): string[] {
  return [
    "-v", "error",
    "-protocol_whitelist", protocolsFor(source),
    "-probesize", "10000000",
    "-analyzeduration", "10000000",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "-i", source,
  ];
}

/** Pure: ffprobe's JSON document in, the AC-3.2 verdict out. */
export function judgeProbe(raw: unknown): ProbeVerdict {
  const doc = raw as { format?: { format_name?: unknown; duration?: unknown }; streams?: unknown } | null;
  const format = doc && typeof doc === "object" ? doc.format : undefined;
  const name = format && typeof format === "object" && typeof format.format_name === "string" ? format.format_name : "";
  if (!name.split(",").some((part) => ALLOWED_DEMUXERS.has(part))) return reject("unsupported_type");

  const streams = Array.isArray(doc?.streams) ? (doc.streams as { codec_type?: unknown }[]) : [];
  if (!streams.some((s) => s && s.codec_type === "audio")) return reject("no_audio");

  const seconds = typeof format?.duration === "string" || typeof format?.duration === "number" ? Number(format.duration) : NaN;
  const durationMs = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  if (durationMs !== null && durationMs > MAX_AUDIO_MS) return reject("too_long");
  return { ok: true, durationMs, format: name };
}

export interface ProbeOptions {
  readonly bin?: string;
  readonly timeoutMs?: number;
}

/** Probes `source` (absolute path or http(s) URL). Throws `ToolMissingError` if ffprobe is not installed. */
export async function probeMedia(source: string, options: ProbeOptions = {}): Promise<ProbeVerdict> {
  const result = await runTool(options.bin ?? ffprobeBinary(), buildProbeArgs(source), { timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS });
  if (result.timedOut || result.code !== 0) return reject("unsupported_type");
  let doc: unknown;
  try {
    doc = JSON.parse(result.stdout);
  } catch {
    return reject("unsupported_type");
  }
  return judgeProbe(doc);
}

// ─── Test seam ───────────────────────────────────────────────────────────────

export type Prober = (source: string) => Promise<ProbeVerdict>;
let prober: Prober = (source) => probeMedia(source);

/** The probe the upload route runs. */
export const probeUpload: Prober = (source) => prober(source);

/** Tests only: replace (or restore with `null`) the prober. */
export function setProberForTests(next: Prober | null): void {
  prober = next ?? ((source) => probeMedia(source));
}
