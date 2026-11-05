/**
 * T107, the Google spike (specs/021-meetings plan.md § Amendment 2026-11-05 G-2, G-3, G-5, G-8; a RELEASE
 * GATE, not a test): drives the REAL adapters against a sandbox Google Cloud project and prints measurements.
 *
 *   direnv exec meetings-api sh -c 'MEETINGS_AI_PROVIDER=real bun scripts/spike-google-speech.ts --audio <file> --locale it-IT'
 *
 * What it does, in order, and ONLY what it prints is non-sensitive (durations, counts, status codes, the
 * names of checks; never a project id, a bucket, an object name, an operation name, a token, a transcript
 * or a model reply):
 *   1. startup checks N2 (transient bucket), N3 + N4 (Vertex cache and logging) through `startupChecks.ts`;
 *   2. `createGoogleTranscriber` end to end on `--audio`: split, upload, BatchRecognize, poll, read the output,
 *      `operations.delete`, cleanup, with every HTTP call timed from a spy on `fetch`;
 *   3. that the attempt's prefix in the transient bucket is empty afterwards;
 *   4. a summary and one question about it through the real `vertexClaude` adapter (`--vertex`).
 *
 * Options:
 *   --audio <path>        the normalised audio.ogg (16 kHz mono Opus), required unless --vertex-only
 *   --locale it-IT|en-US  (default it-IT)
 *   --piece-max-min <n>   override PIECE_MAX_MS (minutes); default the constant in src/media/split.ts
 *   --word-offsets        send enableWordTimeOffsets (the WORD_OFFSETS constant is the default)
 *   --vertex              after the transcript, run one summary and one question on it
 *   --vertex-only         skip Speech; summarise a built-in two-speaker sample
 *   --vertex-auto-tool-choice  DIAGNOSTIC: send no `tool_choice` (see the T107 drift note about Sonnet 5.5)
 *   --record <dir>        write the SCRUBBED operation and output documents there (fixtures); never committed raw
 *
 * Needs real Google credentials (MEETINGS_AI_PROVIDER=real and the six MEETINGS_GCP_* / *_LOCATION / *_MODEL_ID
 * values), ffmpeg/ffprobe on PATH (or FFMPEG_PATH / FFPROBE_PATH), and spends real money: Chirp 3 is billed per
 * audio minute. Nothing is written to the repository unless --record names a directory.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGoogleTranscriber, WORD_OFFSETS } from "../src/ai/googleSpeech";
import { buildAnswerRequest, validateAnswerOutput } from "../src/ai/prompts/answer";
import { buildSummaryRequest, validateSummaryOutput } from "../src/ai/prompts/summary";
import type { PromptSegment } from "../src/ai/prompts/transcript";
import { createVertexClient, createVertexLanguageModel } from "../src/ai/vertexClaude";
import type { LanguageModel } from "../src/ai/languageModel";
import type { TemplateSnapshot } from "../src/templates/builtin";
import { TranscriptionError, type TranscriptionLocale } from "../src/ai/transcriber";
import { env } from "../src/lib/env";
import { defaultFetch, googleAuth } from "../src/lib/google/auth";
import { requireTransientStorage } from "../src/lib/google/transientStorage";
import { checkTransientBucket, checkVertex } from "../src/lib/startupChecks";
import { PIECE_MAX_MS } from "../src/media/split";

// ─── Arguments ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const audioPath = option("--audio");
const locale = (option("--locale") ?? "it-IT") as TranscriptionLocale;
const pieceMaxMs = option("--piece-max-min") ? Math.round(Number(option("--piece-max-min")) * 60_000) : PIECE_MAX_MS;
const wordOffsets = flag("--word-offsets") || WORD_OFFSETS;
const vertexOnly = flag("--vertex-only");
const recordDir = option("--record");
if (!vertexOnly && !audioPath) throw new Error("--audio <file> is required (or --vertex-only)");
if (locale !== "it-IT" && locale !== "en-US") throw new Error("--locale must be it-IT or en-US");
if (!Number.isFinite(pieceMaxMs) || pieceMaxMs <= 0) throw new Error("--piece-max-min must be a positive number");
if (env.MEETINGS_AI_PROVIDER !== "real") throw new Error("MEETINGS_AI_PROVIDER=real is required: the spike talks to Google");

const projectId = env.MEETINGS_GCP_PROJECT_ID!;
const bucket = env.MEETINGS_GCS_TRANSIENT_BUCKET!;

// ─── Output hygiene ──────────────────────────────────────────────────────────

/** Replaces everything identifying in a string; used on every document that may be recorded. */
function scrub(text: string): string {
  return text
    .split(bucket).join("operai-meetings-transient") // the bucket first: its name may contain the project id
    .split(projectId).join("operai-meetings-sandbox")
    .replace(/projects\/\d+/g, "projects/123456789012")
    .replace(/projects\/operai-meetings-sandbox\/locations\/(\w+)\/operations\/[A-Za-z0-9_-]+/g, "projects/123456789012/locations/$1/operations/op-1")
    .replace(/[\w.-]+@[\w.-]*\.iam\.gserviceaccount\.com/g, "service@example.iam.gserviceaccount.com")
    .replace(/transcribe\/[A-Za-z0-9_-]+\/\d+\//g, "transcribe/meeting_1/1/");
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

// ─── A timed spy on fetch ────────────────────────────────────────────────────

interface Call {
  readonly kind: string;
  readonly status: number;
  readonly startedAt: number;
  readonly ms: number;
}
const calls: Call[] = [];
const t0 = Date.now();

/** A label for a URL that carries no identifier: what the call IS, never what it addresses. */
function kindOf(method: string, url: URL): string {
  if (url.host.endsWith("-speech.googleapis.com")) {
    if (url.pathname.endsWith(":batchRecognize")) return "speech.batchRecognize";
    if (/\/operations\//.test(url.pathname)) return method === "DELETE" ? "speech.operations.delete" : "speech.operations.get";
    return "speech.other";
  }
  if (url.host.startsWith("storage.")) {
    if (url.pathname.startsWith("/upload/")) return "gcs.upload";
    if (url.pathname.startsWith("/download/")) return "gcs.download";
    return method === "DELETE" ? "gcs.delete" : method === "GET" && url.pathname.endsWith("/o") ? "gcs.list" : "gcs.other";
  }
  if (url.host.startsWith("aiplatform.")) return url.pathname.endsWith(":rawPredict") ? "vertex.rawPredict" : "vertex.control";
  return "other";
}

const operationDocs: { running: unknown[]; done: unknown[] } = { running: [], done: [] };
/** Google-side latency of each finished operation (updateTime - createTime), in seconds: no identifier. */
const serverLatencies: number[] = [];
const spy = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const startedAt = Date.now() - t0;
  const began = Date.now();
  const response = await defaultFetch(input as never, init);
  const kind = kindOf(method, url);
  calls.push({ kind, status: response.status, startedAt, ms: Date.now() - began });
  if (kind === "speech.operations.get" && response.ok) {
    const copy = (await response.clone().json().catch(() => null)) as { done?: boolean; metadata?: { createTime?: string; updateTime?: string } } | null;
    if (copy?.done && copy.metadata?.createTime && copy.metadata.updateTime) {
      serverLatencies.push((Date.parse(copy.metadata.updateTime) - Date.parse(copy.metadata.createTime)) / 1000);
    }
    if (recordDir && copy) (copy.done ? operationDocs.done : operationDocs.running).push(copy);
  }
  return response;
}) as typeof fetch;

// ─── 1. Startup checks ───────────────────────────────────────────────────────

const auth = await googleAuth();
console.log("== startup checks (AC-4.9)");
{
  const began = Date.now();
  const n2 = await checkTransientBucket({ bucket, auth });
  console.log(`N2 transient bucket: ${n2.length === 0 ? "PASS" : `REFUSED (${n2.length}): ${n2.join("; ")}`} (${Date.now() - began} ms)`);
  const began2 = Date.now();
  const vertex = await checkVertex({ projectId, location: env.MEETINGS_VERTEX_LOCATION!, modelId: env.MEETINGS_VERTEX_MODEL_ID!, auth });
  console.log(`N3+N4 Vertex cache and logging: ${vertex.length === 0 ? "PASS" : `REFUSED (${vertex.length}): ${vertex.join("; ")}`} (${Date.now() - began2} ms)`);
}

// ─── 2. Speech ───────────────────────────────────────────────────────────────

let promptSegments: PromptSegment[] = [];

if (!vertexOnly) {
  console.log("== speech");
  const storage = await requireTransientStorage();
  const audio = Bun.file(audioPath!);
  const meetingId = `spike${Math.floor(Math.random() * 1e9)}`;
  const attempt = 1;

  // Tap what the adapter reads, to record the output documents (scrubbed) and to size them.
  let outputBytes = 0;
  const outputs: string[] = [];
  const tapped = new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === "read") {
        return async (key: string, max: number, signal?: AbortSignal) => {
          const bytes = await target.read(key, max, signal);
          outputBytes += bytes.byteLength;
          if (recordDir) outputs.push(new TextDecoder().decode(bytes));
          return bytes;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const transcriber = createGoogleTranscriber({
    auth,
    projectId,
    location: env.MEETINGS_SPEECH_LOCATION!,
    storage: async () => tapped,
    fetchImpl: spy,
    pieceMaxMs,
    wordOffsets,
  });

  const began = Date.now();
  let outcome;
  try {
    outcome = await transcriber.transcribe(new Blob([await audio.arrayBuffer()]), locale, 3, undefined, { meetingId, attempt });
  } catch (error) {
    const e = error as Partial<TranscriptionError>;
    console.log(`transcribe FAILED: code=${e.code ?? "?"} transient=${String(e.transient)} status=${e.status ?? "-"} after ${seconds(Date.now() - began)} s`);
    console.log(`calls: ${summariseCalls()}`);
    process.exit(1);
  }
  const wall = Date.now() - began;

  const left = await listCount(`transcribe/${meetingId}/`);
  console.log(`locale=${locale} pieceMax=${minutes(pieceMaxMs)} min wordOffsets=${wordOffsets}`);
  console.log(`wall time ${seconds(wall)} s; calls: ${summariseCalls()}`);
  console.log(`output bytes read ${outputBytes}`);
  console.log(`objects left in the transient bucket under this meeting's prefix: ${left} ${left === 0 ? "(clean)" : "(NOT CLEAN)"}`);

  // Per-part Speech latency: batchRecognize submit start -> last operation GET that returned (all parts overlap).
  const submit = calls.filter((c) => c.kind === "speech.batchRecognize");
  const gets = calls.filter((c) => c.kind === "speech.operations.get");
  if (submit.length > 0 && gets.length > 0) {
    const first = Math.min(...submit.map((c) => c.startedAt));
    const last = Math.max(...gets.map((c) => c.startedAt + c.ms));
    console.log(`speech: ${submit.length} operation(s), first submit to last poll ${seconds(last - first)} s, ${gets.length} polls`);
    console.log(`google-side latency per operation (s): [${serverLatencies.map((x) => x.toFixed(0)).join(", ")}]`);
  }

  if (outcome.kind === "noSpeech") {
    console.log("outcome: noSpeech");
  } else {
    const { segments, partStartsMs } = outcome;
    const labels = new Set(segments.map((s) => s.speakerKey));
    const last = segments[segments.length - 1]!;
    const lastEnd = last.endMs;
    const chars = segments.reduce((n, s) => n + s.text.length, 0);
    console.log(`outcome: ${segments.length} segments, ${labels.size} speaker keys, ${partStartsMs.length} part(s) starting at [${partStartsMs.map((m) => minutes(m)).join(", ")}] min`);
    console.log(`last segment ends at ${minutes(lastEnd)} min, ${chars} characters, words/min ${(chars / 6 / (lastEnd / 60_000)).toFixed(0)}`);
    const withDuration = segments.filter((s) => s.endMs > s.startMs).length;
    console.log(`segments with a duration > 0: ${withDuration}/${segments.length}`);
    // A speaker-change check that needs no transcript: does the key alternate the way the synthetic two voices do?
    let changes = 0;
    for (let i = 1; i < segments.length; i += 1) if (segments[i]!.speakerKey !== segments[i - 1]!.speakerKey) changes += 1;
    console.log(`speaker changes between consecutive segments: ${changes}`);
    promptSegments = segments.map((s, i) => ({ id: `s${i}`, ordinal: i + 1, startMs: s.startMs ?? null, speakerLabel: `Speaker ${s.speakerKey.slice(1)}`, text: s.text }));
  }

  if (recordDir) {
    await mkdir(recordDir, { recursive: true });
    await writeFile(join(recordDir, "operation-running.json"), `${scrub(JSON.stringify(operationDocs.running[0] ?? {}, null, 2))}\n`);
    await writeFile(join(recordDir, "operation-done.json"), `${scrub(JSON.stringify(operationDocs.done[0] ?? {}, null, 2))}\n`);
    for (const [i, text] of outputs.entries()) await writeFile(join(recordDir, `output-${i + 1}.json`), `${scrub(text)}\n`);
    console.log(`recorded scrubbed documents in ${recordDir}`);
  }
}

// ─── 3. Vertex ───────────────────────────────────────────────────────────────

if (flag("--vertex") || vertexOnly) {
  console.log("== vertex");
  if (vertexOnly) {
    const sample = [
      "Il progetto richiede ancora la documentazione tecnica entro venerdì prossimo.",
      "Il cliente ha approvato il piano di rilascio come concordato con la direzione.",
      "Il budget deve rivedere le modifiche al contratto prima della riunione di lunedì.",
      "La migrazione propone di rinviare il collaudo finale senza ulteriori ritardi.",
    ];
    promptSegments = sample.map((text, i) => ({ id: `s${i}`, ordinal: i + 1, startMs: i * 8_000, speakerLabel: `Speaker ${(i % 2) + 1}`, text }));
  }
  // The whole transcript of a 1 h meeting is ~150 segments: send at most 150 so the call stays a handful of cents.
  const segments = promptSegments.slice(0, 150);

  let model: LanguageModel = createVertexLanguageModel({
    client: createVertexClient({ location: env.MEETINGS_VERTEX_LOCATION!, projectId, authClient: auth.client, fetchImpl: spy }),
    modelId: env.MEETINGS_VERTEX_MODEL_ID!,
  });
  if (flag("--vertex-auto-tool-choice")) {
    // DIAGNOSTIC ONLY (T107 drift): the same adapter, over a client that drops the forced `tool_choice`.
    const real = createVertexClient({
      location: env.MEETINGS_VERTEX_LOCATION!,
      projectId,
      authClient: auth.client,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        if (body) delete body["tool_choice"];
        return spy(input, { ...init, ...(body ? { body: JSON.stringify(body) } : {}) });
      }) as typeof fetch,
    });
    model = createVertexLanguageModel({ client: real, modelId: env.MEETINGS_VERTEX_MODEL_ID! });
    console.log("DIAGNOSTIC: tool_choice omitted from the request");
  }

  const timed = async (label: string, run: () => Promise<unknown>): Promise<unknown | null> => {
    const began = Date.now();
    try {
      const out = await run();
      console.log(`${label}: ok in ${seconds(Date.now() - began)} s`);
      return out;
    } catch (error) {
      const e = error as { code?: string; transient?: boolean; status?: number };
      console.log(`${label}: FAILED code=${e.code ?? "?"} transient=${String(e.transient)} status=${e.status ?? "-"} after ${seconds(Date.now() - began)} s`);
      return null;
    }
  };

  const template: TemplateSnapshot = {
    source: "builtin",
    templateId: "spike",
    name: "Spike",
    generalInstructions: null,
    sections: [
      { heading: "Decisions", instruction: "What was decided" },
      { heading: "Actions", instruction: "Who does what by when" },
    ],
  };
  const summary = buildSummaryRequest({ template, language: locale === "it-IT" ? "it" : "en", segments });
  const raw = await timed("summary", () => model.complete(summary.request, summary.schema));
  if (raw !== null) {
    const verdict = validateSummaryOutput(raw, { template, language: locale === "it-IT" ? "it" : "en", segments });
    console.log(`summary validation: ${verdict.ok ? `valid, ${verdict.value.length} section(s)` : "INVALID"}`);
  }

  const question = locale === "it-IT" ? "Chi ha approvato il piano di rilascio?" : "Who approved the release plan?";
  const ask = buildAnswerRequest({ question, history: [], segments });
  const answer = await timed("question", () => model.complete(ask.request, ask.schema));
  if (answer !== null) {
    const verdict = validateAnswerOutput(answer, { segments, language: locale === "it-IT" ? "it" : "en" });
    console.log(`answer validation: ${verdict.ok ? `valid, ${verdict.value.citations.length} citation(s), notInMeeting=${verdict.value.notInMeeting}` : "INVALID"}`);
  }
  console.log(`calls: ${summariseCalls()}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function summariseCalls(): string {
  const byKind = new Map<string, { n: number; statuses: Set<number>; ms: number }>();
  for (const call of calls) {
    const entry = byKind.get(call.kind) ?? { n: 0, statuses: new Set<number>(), ms: 0 };
    entry.n += 1;
    entry.statuses.add(call.status);
    entry.ms += call.ms;
    byKind.set(call.kind, entry);
  }
  return [...byKind].map(([kind, e]) => `${kind}×${e.n}[${[...e.statuses].join("/")}] ${Math.round(e.ms / e.n)}ms avg`).join(", ");
}

/** How many objects remain under a prefix, by the regional listing the adapter itself uses. */
async function listCount(prefix: string): Promise<number> {
  const storage = await requireTransientStorage();
  // `deletePrefix` returns how many it removed: after a clean attempt that is zero (and a leftover would now go).
  return storage.deletePrefix(prefix);
}
