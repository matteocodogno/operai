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
 *   --record <dir>        write the SCRUBBED operation and output documents there (fixtures); never committed raw:
 *                         `try-<part>-<try>.json` per try, `silences.json`, `parts.json` (spans), operation docs
 *   --reference <file>    (T124) a reference of SYNTHETIC audio: `{ utterances: [{ speaker, startMs, endMs, text }] }`.
 *                         Adds the content-free regression report (below) with coverage, missing and extra runs, and which
 *                         transcript key carried which reference speaker
 *   --report              the content-free regression report WITHOUT a reference (parts, overlaps, tries, holes, joins)
 *   --overlap-target-min <n>  override OVERLAP_TARGET_MS (minutes)
 *
 * The regression report (T124; plan H-1 to H-4, H-10) re-derives, from the output documents the adapter read, what each
 * try of each part contained and prints NUMBERS ONLY: the parts and their spans, the overlap lengths, the tries per
 * part with their words, gaps (start-end, sound), repetitions and excused holes, the try the adapter keeps, the final
 * gaps, per-boundary joins and separate labels, dedup counts, latency and billed seconds, and (with --reference) the
 * share of the reference's words each try and the final transcript contain, the missing and extra runs and the
 * speaker purity. It also checks that its own re-derivation equals the adapter's outcome (parts, gaps, segments).
 *
 * Needs real Google credentials (MEETINGS_AI_PROVIDER=real and the six MEETINGS_GCP_* / *_LOCATION / *_MODEL_ID
 * values), ffmpeg/ffprobe on PATH (or FFMPEG_PATH / FFPROBE_PATH), and spends real money: Chirp 3 is billed per
 * audio minute. Nothing is written to the repository unless --record names a directory.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assess, finalGaps, isBetter, isIncomplete, longHoles, type Assessment } from "../src/ai/completeness";
import { createGoogleTranscriber, MAX_TRIES, WORD_OFFSETS, wordsOfPart } from "../src/ai/googleSpeech";
import { mapPhrases } from "../src/ai/segments";
import { stitch } from "../src/ai/stitch";
import { normalizeToken, tokensOf, type Interval, type PartWords } from "../src/ai/words";
import { buildAnswerRequest, validateAnswerOutput } from "../src/ai/prompts/answer";
import { buildSummaryRequest, validateSummaryOutput } from "../src/ai/prompts/summary";
import type { PromptSegment } from "../src/ai/prompts/transcript";
import { createVertexClient, createVertexLanguageModel } from "../src/ai/vertexClaude";
import type { LanguageModel } from "../src/ai/languageModel";
import type { TemplateSnapshot } from "../src/templates/builtin";
import { TranscriptionError, type TranscriptionLocale, type TranscriptionOutcome } from "../src/ai/transcriber";
import { env } from "../src/lib/env";
import { defaultFetch, googleAuth } from "../src/lib/google/auth";
import { requireTransientStorage } from "../src/lib/google/transientStorage";
import { checkTransientBucket, checkVertex } from "../src/lib/startupChecks";
import { OVERLAP_TARGET_MS, PIECE_MAX_MS, splitAudio, type SplitResult } from "../src/media/split";
import { coverage, isReference, referenceTokens, speakerReport, type Reference } from "./spike-report";

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
const referencePath = option("--reference");
const wantReport = flag("--report") || referencePath !== undefined;
const overlapTargetMs = option("--overlap-target-min") ? Math.round(Number(option("--overlap-target-min")) * 60_000) : OVERLAP_TARGET_MS;
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

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
function minutes(ms: number): string {
  return (ms / 60_000).toFixed(1);
}
/** USD per audio minute (plan G-10, to be confirmed at provisioning). */
const USD_PER_MINUTE = 0.016;

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
    if (copy) (copy.done ? operationDocs.done : operationDocs.running).push(copy);
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
  /** The raw output document of every try that was read, by `<part>-<try>` (T124 report). */
  const tryDocs = new Map<string, string>();
  const tapped = new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === "read") {
        return async (key: string, max: number, signal?: AbortSignal) => {
          const bytes = await target.read(key, max, signal);
          outputBytes += bytes.byteLength;
          const text = new TextDecoder().decode(bytes);
          if (recordDir) outputs.push(text);
          const named = /\/out\/(\d+)-(\d+)\//.exec(key);
          if (named) tryDocs.set(`${named[1]}-${named[2]}`, text);
          return bytes;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const captured: { split: SplitResult | null } = { split: null };
  const transcriber = createGoogleTranscriber({
    auth,
    projectId,
    location: env.MEETINGS_SPEECH_LOCATION!,
    storage: async () => tapped,
    fetchImpl: spy,
    pieceMaxMs,
    overlapTargetMs,
    wordOffsets,
    split: async (options) => {
      captured.split = await splitAudio(options);
      return captured.split;
    },
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

  if (wantReport && captured.split !== null) {
    const reference = referencePath ? await loadReference(referencePath) : null;
    report({ split: captured.split, tryDocs, outcome, reference, wall });
  }

  if (recordDir) {
    await mkdir(recordDir, { recursive: true });
    await writeFile(join(recordDir, "operation-running.json"), `${scrub(JSON.stringify(operationDocs.running[0] ?? {}, null, 2))}\n`);
    await writeFile(join(recordDir, "operation-done.json"), `${scrub(JSON.stringify(operationDocs.done[0] ?? {}, null, 2))}\n`);
    for (const [i, text] of outputs.entries()) await writeFile(join(recordDir, `output-${i + 1}.json`), `${scrub(text)}\n`);
    for (const [name, text] of tryDocs) await writeFile(join(recordDir, `try-${name}.json`), `${scrub(text)}\n`);
    if (captured.split !== null) {
      const split = captured.split;
      await writeFile(join(recordDir, "silences.json"), `${JSON.stringify(split.silences)}\n`);
      await writeFile(join(recordDir, "parts.json"), `${JSON.stringify({ durationMs: split.durationMs, parts: split.parts.map((p) => ({ startMs: p.startMs, endMs: p.endMs })) })}\n`);
    }
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


// ─── The regression report (T124): numbers only ──────────────────────────────

function clock(ms: number): string {
  return `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
}
function range(r: Interval): string {
  return `${clock(r.startMs)}-${clock(r.endMs)}`;
}
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
}

async function loadReference(path: string): Promise<Reference> {
  const value: unknown = JSON.parse(await Bun.file(path).text());
  if (!isReference(value)) throw new Error("--reference: expected { utterances: [{ speaker, startMs, endMs, text }] }");
  return value;
}

interface ReportInput {
  readonly split: SplitResult;
  readonly tryDocs: ReadonlyMap<string, string>;
  readonly outcome: TranscriptionOutcome;
  readonly reference: Reference | null;
  readonly wall: number;
}

interface TryView {
  readonly words: PartWords;
  readonly assessment: Assessment;
}

function report({ split, tryDocs, outcome, reference, wall }: ReportInput): void {
  const spans: Interval[] = split.parts.map((p) => ({ startMs: p.startMs, endMs: p.endMs }));
  const refTokens = reference ? referenceTokens(reference) : null;
  const silenceMs = split.silences.reduce((n, s) => n + (s.endMs - s.startMs), 0);
  console.log("== regression report (T124, content-free)");
  console.log(`audio ${clock(split.durationMs)} (${minutes(split.durationMs)} min), ${spans.length} part(s), ${split.silences.length} pause(s) totalling ${seconds(silenceMs)} s`);
  console.log(`part spans: ${spans.map((s, i) => `${i + 1}=${range(s)} (${minutes(s.endMs - s.startMs)} min)`).join(", ")}`);
  console.log(`overlaps: ${spans.slice(1).map((s, i) => `${i + 1}|${i + 2}=${seconds(spans[i]!.endMs - s.startMs)} s`).join(", ") || "none (one part)"}`);

  // Every try the adapter read, in the adapter's own order, and the try it keeps (the same rules as googleSpeech.ts).
  const chosen: TryView[] = [];
  const lossy = { flaggedLossy: 0, missedLossy: 0, flaggedComplete: 0, quietComplete: 0 };
  let tries = 0;
  spans.forEach((span, index) => {
    const number = index + 1;
    const views: (TryView & { tryNo: number })[] = [];
    for (let tryNo = 1; tryNo <= MAX_TRIES; tryNo += 1) {
      const doc = tryDocs.get(`${number}-${tryNo}`);
      if (doc === undefined) continue;
      const words = wordsOfPart(JSON.parse(doc), number, span.startMs, span.endMs, WORD_OFFSETS);
      if (words === null) continue;
      views.push({ tryNo, words, assessment: assess(words, split.silences) });
    }
    tries += views.length;
    let best: (typeof views)[number] | null = null;
    let kept = 0;
    for (const view of views) {
      if (best === null || isBetter(view.assessment, best.assessment)) {
        best = view;
        kept = view.tryNo;
      }
      if (!isIncomplete(best.assessment)) break;
    }
    chosen.push(best!);

    const inside = refTokens && reference ? referenceTokens({ utterances: reference.utterances.filter((u) => u.startMs >= span.startMs && u.endMs <= span.endMs) }) : null;
    const lines = views.map((view) => {
      const toks = tokensOf(view.words.words);
      const timed = toks.filter((t) => t.span !== null).length;
      const a = view.assessment;
      const holes = longHoles(view.words);
      let note = "";
      if (inside) {
        const c = coverage(inside, toks.map((t) => t.norm));
        const isLossy = c.recall < 0.95;
        note = ` recall=${pct(c.recall)}`;
        if (isLossy && isIncomplete(a)) lossy.flaggedLossy += 1;
        else if (isLossy) lossy.missedLossy += 1;
        else if (isIncomplete(a)) lossy.flaggedComplete += 1;
        else lossy.quietComplete += 1;
      }
      const gapText = a.gaps.map((g) => `${range(g)}/${seconds(g.soundMs)}s sound`).join(";") || "-";
      const reps = a.repetitions.reduce((n, r) => n + (r.toToken - r.fromToken), 0);
      return `    try ${view.tryNo}: words=${toks.length} timed=${timed} untimed=${toks.length - timed} gaps=${a.gaps.length} [${gapText}] repetitions=${a.repetitions.length} (${reps} words) excused=${a.excused} holes>=20s=${holes.length}${note}${view.tryNo === kept ? " <= kept" : ""}`;
    });
    console.log(`part ${number} ${range(span)}: ${views.length} read try(ies)\n${lines.join("\n")}`);
  });
  const submits = calls.filter((c) => c.kind === "speech.batchRecognize").length;
  console.log(`tries: ${tries} read of ${submits} submitted; per part [${chosen.map((_, i) => [1, 2, 3].filter((t) => tryDocs.has(`${i + 1}-${t}`)).length).join(", ")}]`);
  if (refTokens) console.log(`detector vs reference (per try, lossy = recall < 95% inside the part): flagged&lossy=${lossy.flaggedLossy} missed-lossy=${lossy.missedLossy} flagged&complete=${lossy.flaggedComplete} quiet&complete=${lossy.quietComplete}`);

  // The re-derivation of the adapter's outcome.
  const finals = finalGaps(chosen.map((c) => ({ words: c.words, gaps: c.assessment.gaps })), split.silences);
  const stitched = stitch({ parts: chosen.map((c) => c.words), gaps: finals });
  const segments = mapPhrases(stitched.phrases);
  console.log(`final gaps: ${finals.length}${finals.length > 0 ? ` [${finals.map((g) => `${range(g)} (${seconds(g.endMs - g.startMs)} s)`).join("; ")}]` : ""}`);
  console.log(`dedup: removed ${stitched.stats.removedWithinPart} within parts (D1), ${stitched.stats.removedInOverlap} in overlaps (D2); joins ${stitched.stats.joined}, separate ${stitched.stats.separate}`);
  for (let k = 0; k + 1 < chosen.length; k += 1) {
    const pair = stitch({ parts: [chosen[k]!.words, chosen[k + 1]!.words], gaps: [] });
    const window = { startMs: spans[k + 1]!.startMs, endMs: spans[k]!.endMs };
    const blocked = [chosen[k]!.words, chosen[k + 1]!.words].some((w) => longHoles(w).some((h) => h.startMs < window.endMs && h.endMs > window.startMs));
    console.log(`boundary ${k + 1}|${k + 2}: overlap ${seconds(window.endMs - window.startMs)} s, anchored words ${pair.stats.removedInOverlap}, joined ${pair.stats.joined}, separate ${pair.stats.separate}${blocked ? " (J0: a 20 s hole in the overlap)" : ""}`);
  }
  const partsOfKey = new Map<string, Set<number>>();
  for (const seg of segments) partsOfKey.set(seg.speakerKey, (partsOfKey.get(seg.speakerKey) ?? new Set()).add(seg.part ?? 1));
  const joinedKeys = [...partsOfKey.values()].filter((p) => p.size > 1).length;
  const separateKeys = [...partsOfKey.values()].filter((p) => Math.min(...p) > 1).length;
  console.log(`speaker keys ${partsOfKey.size}: joined across parts ${joinedKeys}, separate later labels ${separateKeys}; segments ${segments.length}`);

  // Does the report's own derivation equal what the adapter returned?
  if (outcome.kind === "segments") {
    const sameSegments = outcome.segments.length === segments.length && outcome.segments.every((s, i) => s.text === segments[i]!.text && s.speakerKey === segments[i]!.speakerKey && s.part === segments[i]!.part && s.startMs === segments[i]!.startMs);
    const sameGaps = JSON.stringify(outcome.gaps) === JSON.stringify(finals);
    const sameParts = JSON.stringify(outcome.parts) === JSON.stringify(spans);
    console.log(`re-derivation equals the adapter's outcome: segments ${sameSegments ? "yes" : "NO"}, gaps ${sameGaps ? "yes" : "NO"}, parts ${sameParts ? "yes" : "NO"}`);
  }

  if (refTokens && reference && outcome.kind === "segments") {
    const hyp: string[] = [];
    const keys: string[] = [];
    for (const seg of outcome.segments) {
      for (const raw of seg.text.split(/\s+/)) {
        const norm = normalizeToken(raw);
        if (norm !== "") {
          hyp.push(norm);
          keys.push(seg.speakerKey);
        }
      }
    }
    const c = coverage(refTokens, hyp);
    console.log(`reference: ${c.refWords} words; transcript ${c.hypWords} words; matched ${c.matched} (recall ${pct(c.recall)}); extra ${c.extraWords}; extra runs >= 8: ${c.extraRuns}`);
    console.log(`missing runs >= 8 words: ${c.missingRuns.length}${c.missingRuns.length > 0 ? ` [${c.missingRuns.slice(0, 12).map((r) => `${clock(r.startMs)}-${clock(r.endMs)} ${r.words}w`).join("; ")}]` : ""}`);
    const inOverlap = (ms: number): boolean => spans.slice(1).some((s, i) => ms >= s.startMs && ms <= spans[i]!.endMs);
    let overlapWords = 0;
    let overlapMatched = 0;
    refTokens.forEach((t, i) => {
      if (!inOverlap(t.startMs)) return;
      overlapWords += 1;
      if (c.matchedRef[i]! >= 0) overlapMatched += 1;
    });
    console.log(`recall inside the overlaps ${overlapWords === 0 ? "n/a" : pct(overlapMatched / overlapWords)} (${overlapWords} words); outside ${pct((c.matched - overlapMatched) / Math.max(1, c.refWords - overlapWords))}`);
    const sp = speakerReport(refTokens, c.matchedRef, keys);
    console.log(`speakers: ${reference.speakers ?? "?"} reference voices, ${sp.keys} transcript keys, purity ${pct(sp.purity)}, impure keys ${sp.impureKeys}, reference voices split over several keys ${sp.splitSpeakers}`);
    console.log(`key x voice table: ${JSON.stringify(sp.table)}`);
  }

  // Latency and billing.
  const billed = (operationDocs.done as { response?: { totalBilledDuration?: string } }[]).reduce((n, d) => n + (Number.parseFloat(d.response?.totalBilledDuration ?? "0") || 0), 0);
  const audioMin = split.durationMs / 60_000;
  console.log(`latency: wall ${seconds(wall)} s (target <= ${(180 + 0.2 * split.durationMs / 1000).toFixed(0)} s = 3 min + 0.2 x audio); google-side per operation median ${median(serverLatencies).toFixed(0)} s max ${Math.max(0, ...serverLatencies).toFixed(0)} s over ${serverLatencies.length} operation(s)`);
  console.log(`billed ${billed.toFixed(0)} s = ${(billed / 60).toFixed(1)} min (${((billed / 60 / audioMin) * 100).toFixed(0)}% of the audio) = about USD ${((billed / 60) * USD_PER_MINUTE).toFixed(2)}`);
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
