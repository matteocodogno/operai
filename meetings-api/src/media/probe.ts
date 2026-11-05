/**
 * `ffprobe` on a user-supplied file, hardened per ADR-0064 (specs/021-meetings
 * AC-3.1, AC-3.2; plan.md R15). A media demuxer that can follow playlists and URLs is
 * also a network client, so the file is never trusted before this says it is a plain
 * audio or video container:
 *
 *   - `-protocol_whitelist` restricts the SCHEMES an input may open, NOT the hosts or
 *     ports: `https,tls,tcp` lets a playlist name any https host or `tcp://host:port`.
 *     A scheme list therefore does not make a network source safe, and two rules follow:
 *       1. THE TRUST DECISION IS MADE ON A LOCAL FILE (`-protocol_whitelist file`), where
 *          there is no network protocol to abuse; `prepare_audio` probes the very file it
 *          then decodes, and pins the demuxer the probe named (`-f`) for the decode;
 *       2. a URL source (the cheap early reject at upload confirm) is only ever probed with
 *          the input format PINNED (`-f`, from the declared content type), so the demuxers
 *          that follow playlists (hls, dash, concat, sdp...) are never selected. A URL
 *          probe without a pinned format is refused outright;
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
 *
 * For a URL these are SCHEMES, not destinations: they say nothing about which host
 * or port a playlist may name (see the header). Only `file` is a safe answer.
 */
export function protocolsFor(source: string): string {
  if (source.startsWith("https://")) return "https,tls,tcp";
  if (source.startsWith("http://")) return "http,tcp";
  if (source.startsWith("/") && !source.includes("\0")) return "file";
  throw new Error("media source is not an absolute path or an http(s) URL");
}

/** The ffmpeg demuxer a declared upload content type must be, pinned so a playlist format can never be chosen. */
const DEMUXER_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "mov",
  "audio/x-m4a": "mov",
  "video/mp4": "mov",
  "video/quicktime": "mov",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "matroska",
  "video/webm": "matroska",
  "video/x-matroska": "matroska",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

export const demuxerForContentType = (contentType: string): string | undefined => DEMUXER_BY_CONTENT_TYPE[contentType];

/** Only a plain-container demuxer may be pinned with `-f`; a playlist-following one (hls, concat...) never. */
export const isPinnableDemuxer = (name: string): boolean => ALLOWED_DEMUXERS.has(name);

/** The one allowlisted demuxer a verdict's `format_name` (a comma list) names: what `-f` should pin for the decode. */
export function pinnedDemuxer(format: string): string | undefined {
  return format.split(",").find((part) => ALLOWED_DEMUXERS.has(part));
}

export function buildProbeArgs(source: string, inputFormat?: string): string[] {
  const protocols = protocolsFor(source);
  // A network source is only ever read as a pinned, plain container (header rule 2).
  if (protocols !== "file" && inputFormat === undefined) throw new Error("a URL source must be probed with a pinned input format");
  if (inputFormat !== undefined && !isPinnableDemuxer(inputFormat)) throw new Error("input format is not an allowlisted demuxer");
  return [
    "-v", "error",
    "-protocol_whitelist", protocols,
    ...(inputFormat !== undefined ? ["-f", inputFormat] : []),
    "-probesize", "10000000",
    "-analyzeduration", "10000000",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "-i", source,
  ];
}

/** Pure: ffprobe's JSON document in, the AC-3.2 verdict out. */
export function judgeProbe(raw: unknown, maxDurationMs: number = MAX_AUDIO_MS): ProbeVerdict {
  const doc = raw as { format?: { format_name?: unknown; duration?: unknown }; streams?: unknown } | null;
  const format = doc && typeof doc === "object" ? doc.format : undefined;
  const name = format && typeof format === "object" && typeof format.format_name === "string" ? format.format_name : "";
  if (!name.split(",").some((part) => ALLOWED_DEMUXERS.has(part))) return reject("unsupported_type");

  const streams = Array.isArray(doc?.streams) ? (doc.streams as { codec_type?: unknown }[]) : [];
  if (!streams.some((s) => s && s.codec_type === "audio")) return reject("no_audio");

  const seconds = typeof format?.duration === "string" || typeof format?.duration === "number" ? Number(format.duration) : NaN;
  const durationMs = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  if (durationMs !== null && durationMs > maxDurationMs) return reject("too_long");
  return { ok: true, durationMs, format: name };
}

export interface ProbeOptions {
  readonly bin?: string;
  readonly timeoutMs?: number;
  /** Defaults to 3 h; the normaliser allows the recording's 60 s of grace. */
  readonly maxDurationMs?: number;
  /** Pins the input demuxer (`-f`). Required for a URL source, optional for a local file. */
  readonly inputFormat?: string;
}

/**
 * Probes `source` (absolute path or http(s) URL). Throws `ToolMissingError` if ffprobe is not installed.
 * A URL source needs `options.inputFormat`; the trust decision belongs to a local-file probe.
 */
export async function probeMedia(source: string, options: ProbeOptions = {}): Promise<ProbeVerdict> {
  const result = await runTool(options.bin ?? ffprobeBinary(), buildProbeArgs(source, options.inputFormat), {
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
  });
  if (result.timedOut || result.code !== 0) return reject("unsupported_type");
  let doc: unknown;
  try {
    doc = JSON.parse(result.stdout);
  } catch {
    return reject("unsupported_type");
  }
  return judgeProbe(doc, options.maxDurationMs);
}

// ─── Test seam ───────────────────────────────────────────────────────────────

/** `inputFormat` pins the demuxer (required for a URL). */
export type Prober = (source: string, inputFormat?: string) => Promise<ProbeVerdict>;
const defaultProber: Prober = (source, inputFormat) => probeMedia(source, inputFormat !== undefined ? { inputFormat } : {});
let prober: Prober = defaultProber;

/** The early-reject probe the upload route runs over a presigned GET. */
export const probeUpload: Prober = (source, inputFormat) => prober(source, inputFormat);

/** Tests only: replace (or restore with `null`) the prober. */
export function setProberForTests(next: Prober | null): void {
  prober = next ?? defaultProber;
}
