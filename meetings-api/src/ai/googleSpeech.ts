/**
 * Cloud Speech-to-Text v2, model Chirp 3, `BatchRecognize` (specs/021-meetings plan.md § Amendment 2026-11-05
 * G-2, G-3, G-8 and #2 H-1 to H-4, ADR-0069, ADR-0070; AC-6.1, AC-6.2, AC-6.5, AC-6.7, AC-6.9 to AC-6.15, AC-13.2,
 * AC-13.4, AC-4.10, AC-4.12).
 *
 * WHY A BUCKET: Chirp 3 diarizes only in `Recognize` (<= 1 minute) and `BatchRecognize`, and BatchRecognize reads
 * audio only from a `gs://` URI. So one attempt stages its audio in the transient EU bucket (src/lib/google),
 * Speech writes its output beside it, and everything is deleted as soon as it has been used (below). Nothing is kept.
 *
 * ONE ATTEMPT (one claim of the `transcribe` job, ADR-0062):
 *   1. empty the prefixes of OLDER attempts of this meeting (`transcribe/<meetingId>/<n>/`, n < this attempt:
 *      leftovers, including late output). Never this attempt's or a newer one's: a job whose lease was lost can
 *      still be running while the runner has claimed attempt n+1, and a stale attempt must not delete what the live
 *      one staged;
 *   2. split the recording (src/media/split.ts) into OVERLAPPING parts of at most `PIECE_MAX_MS`, with the silences
 *      of the whole recording;
 *   3. every part runs on its own (all together): upload `in/<k>.ogg` once, then up to `MAX_TRIES` TRIES (H-4; 1 since A8, the provider being deterministic). A try
 *      submits ONE `batchRecognize` (chirp_3, exactly one locale, never "auto", diarization, output to a prefix of
 *      its own `out/<k>-<t>/`), polls it, reads its output (<= 8 MiB, which must lie under THAT try's prefix),
 *      deletes that prefix at once and the operation, turns the words into the provider-neutral model and asks the
 *      detector (`completeness.ts`) whether the part is detectably incomplete: a gap (never a repetition, A8). A complete
 *      part is never submitted again; otherwise the best try is kept (fewest gaps, least gap time, the earlier). The part's input is deleted the moment the part has settled;
 *   4. the chosen words of every part go through `stitch.ts` (duplicates once, joins from text only) and the final
 *      gaps through `finalGaps`; an empty transcript is `noSpeech` only if no gap is left, else the permanent
 *      `speech_not_transcribed` (AC-6.7);
 *   5. `finally`: empty THIS attempt's prefix (only) and remove the temp directory.
 *
 * NO PARTIAL TRANSCRIPT AT REST: the best try of each part is held in process memory only (about 27 k words for 3 h);
 * nothing reaches Postgres until the job's one commit. A lost lease or a dead process drops everything held.
 *
 * ERRORS ON A TRY. On try 1, any provider error is the failure of the whole attempt (a transient one is retried by the
 * runner, ADR-0062; a permanent one fails the meeting). On try 2 or 3 it is an improvement that did not happen: the
 * part settles with its best try, which is then marked. A lost lease always aborts. Transcription never writes an
 * `ai_request` row, retries included (AC-13.4); the stage stays `transcribing` (AC-6.10).
 *
 * QUOTA. A process-wide semaphore (`SPEECH_MAX_INFLIGHT`, 24 operations) is shared by first tries and retries of every
 * job, and polling starts at 30 s and goes on every 15 s, so two 3 h jobs stay under the Speech request quotas.
 *
 * TIMES (G-3, T107): a batch output has NO result-level time. It is ONE result per part with every word and its
 * speaker, and no `resultEndOffset`. Times exist only as per-word `startOffset`/`endOffset`, which `WORD_OFFSETS` asks
 * for. They are a model's and are not all to be believed (a garbled first sentence, a sentence-final word ending
 * minutes early, a word stamped hours late), so a word is trusted only when it is plausible and inside its part
 * (`spanOf`); a word with no trusted time is simply untimed, and the detector and the stitcher know how to place it.
 *
 * SPEAKERS (H-2, ADR-0070): diarization labels are per word and per file, namespaced by part (`p2:1`). A label of a
 * later part is joined to an earlier part's only by `stitch.ts`, from the words of the overlap and nothing else; the
 * adapter never decides who is who and never sees a voice.
 *
 * FAILURES map into the closed codes by HTTP status and gRPC code only (G-8); provider text is never parsed, logged
 * or stored; logs carry counts only. Any thrown error is a `TranscriptionError` except a lost lease, which is the
 * abort itself.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleApiError, defaultFetch, googleFetch, type GoogleAuth } from "../lib/google/auth";
import { TransientObjectTooLargeError, transientKeys, type TransientStorage } from "../lib/google/transientStorage";
import { SplitError, splitAudio, type SplitPart } from "../media/split";
import { assess, finalGaps, isBetter, isIncomplete, type Assessment } from "./completeness";
import { mapPhrases } from "./segments";
import { stitch } from "./stitch";
import type { PartWords, SpeechWord } from "./words";
import {
  TranscriptionError,
  type TranscribeContext,
  type Transcriber,
  type TranscriptionFailureCode,
  type TranscriptionLocale,
  type TranscriptionOutcome,
} from "./transcriber";

/**
 * Word-level time offsets: ON (T107, recorded against the real service). Without them a batch output carries NO
 * time at all: one result for the whole file, no `resultEndOffset`, nothing a segment could be placed by (AC-6.5).
 * They cost little in latency (+10% on a 5-minute file) and the speaker labels come back either way.
 */
export const WORD_OFFSETS = true;
/**
 * The longest word the offsets may describe, and how far a word may start before what was already heard. Chirp 3's
 * word times are a model's, and the recording showed a garbled first utterance (a word ending at 162 s inside a
 * 5-minute file, the next one ending before it began). A word outside these bounds is ignored, not believed.
 */
export const MAX_WORD_MS = 10_000;
export const WORD_BACKSTEP_MS = 1_000;
/**
 * A word may not end later than its part does, give or take this. Recorded: a sentence-initial word stamped
 * 9985.28 s inside an 18.6-minute part (valid-looking: start before end, 0.16 s long); trusted, it would have moved
 * every later run to "2 h 46 min".
 */
export const PART_END_SLACK_MS = 5_000;
/** One output file, at most (G-2 step 7). */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** A part's output with more words than this is refused (H-11): the detector and the stitcher do O(n) work per word. */
export const MAX_WORDS_PER_PART = 8_000;
/** Per try: how long to wait for Google before giving up (G-2 step 6). */
export const POLL_DEADLINE_MS = 45 * 60_000;
/** The first poll comes this long after the submit (Google-side median 72 s, p95 85 s), then every `POLL_EVERY_MS`. */
export const POLL_FIRST_MS = 30_000;
export const POLL_EVERY_MS = 15_000;
/**
 * Tries per part. 1 since amendment A8 (2026-11-05): the T124 spike showed the provider is deterministic (a retry returned
 * byte-identical output), so a part is transcribed once and a detected gap is marked. The retry machinery below (the
 * ranking, the best-of selection, the per-try prefixes) is kept behind this bound: re-enabling is a change of this
 * constant (originally 3 = 1 + the retry bound of 2, AC-6.11); tests exercise it through the `maxTries` option.
 */
export const MAX_TRIES = 1;
/** Operations in flight at once, process-wide (H-4): 24 submits a minute and at most 96 polls a minute stay under quota. */
export const SPEECH_MAX_INFLIGHT = 24;
/** A single failed poll is a blip; this many in a row is an outage. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const CALL_TIMEOUT_MS = 30_000;
const LOCALES: readonly string[] = ["it-IT", "en-US"] satisfies TranscriptionLocale[];

/** `google.rpc.Code` values that mean "try again" (G-8). */
const TRANSIENT_RPC_CODES: ReadonlySet<number> = new Set([4, 8, 10, 13, 14]);
const INVALID_ARGUMENT = 3;

export interface GoogleTranscriberOptions {
  readonly auth: GoogleAuth;
  /** `MEETINGS_GCP_PROJECT_ID`. */
  readonly projectId: string;
  /** `MEETINGS_SPEECH_LOCATION` (already checked: `eu`). The host is derived from it, never configured. */
  readonly location: string;
  readonly storage: () => Promise<TransientStorage>;
  readonly fetchImpl?: typeof fetch;
  readonly wordOffsets?: boolean;
  readonly pieceMaxMs?: number;
  readonly overlapTargetMs?: number;
  /** Where the temp directory is made; default the OS temp dir. */
  readonly tmpRoot?: string;
  /** Tests inject a clock and a sleep that advances it. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly split?: typeof splitAudio;
  /** Tries per part; default `MAX_TRIES`. Tests raise it to exercise the retry machinery. */
  readonly maxTries?: number;
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

const unavailable = (status?: number) => new TranscriptionError("provider_unavailable", true, status);

/** A Google API failure as a closed code: network, timeout, 408, 429, 5xx are transient; the rest refusals. */
function fromGoogle(error: GoogleApiError): TranscriptionError {
  return error.transient ? unavailable(error.status) : new TranscriptionError("provider_rejected", false, error.status);
}

/** A `google.rpc.Status` code to a closed code (G-8); `onFile` = the error belongs to one input file. */
export function codeForRpc(code: unknown, onFile: boolean): { code: TranscriptionFailureCode; transient: boolean } {
  if (typeof code === "number" && TRANSIENT_RPC_CODES.has(code)) return { code: "provider_unavailable", transient: true };
  if (onFile && code === INVALID_ARGUMENT) return { code: "audio_unreadable", transient: false };
  return { code: "provider_rejected", transient: false };
}

/** `"12.340s"` -> 12340. Anything else is null. */
export function parseOffsetMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

interface RawWord {
  readonly word?: unknown;
  readonly startOffset?: unknown;
  readonly endOffset?: unknown;
  readonly speakerLabel?: unknown;
}

/** A speaker label, reduced to something safe to use as a key part. Unlabelled is "0". */
const labelOf = (value: unknown): string => {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  return /^[A-Za-z0-9_-]{1,16}$/.test(text) ? text : "0";
};

/** Did the provider give a usable speaker label at all? A missing or unsafe one is no label (AC-6.13); `"0"` is a label. */
const hasLabel = (value: unknown): boolean => {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  return /^[A-Za-z0-9_-]{1,16}$/.test(text);
};

/** The words the model uses for "no speech" (its prompt says `[BACKGROUND]`; the recording showed a lone `[`). */
const NOISE_WORD = /^(?:\[|\]|\[?BACKGROUND\]?)$/i;
interface WordSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * One word's time, or null when it is not to be trusted. Recorded facts (T107): proto3 omits a zero, so the very
 * first word of a file has no `startOffset`; anywhere else a missing offset is a defect, not a zero.
 */
function spanOf(word: RawWord, first: boolean, frontier: number, limit: number): WordSpan | null {
  const startMs = parseOffsetMs(word.startOffset) ?? (first ? 0 : null);
  const endMs = parseOffsetMs(word.endOffset);
  if (startMs === null || endMs === null) return null;
  if (endMs < startMs || endMs - startMs > MAX_WORD_MS || startMs < frontier - WORD_BACKSTEP_MS || endMs > limit) return null;
  return { startMs, endMs };
}

/**
 * The words of one part's output file (`BatchRecognizeResults`) in the provider-neutral model, with the part's offset
 * added to every trusted time, so every span is in MEETING time. Pure. Returns null when the document is not the shape
 * this module understands; throws `provider_rejected` for an output with more than `MAX_WORDS_PER_PART` words.
 *
 * WHAT GOOGLE REALLY SENDS (recorded, test-fixtures/google-speech): one result for a whole part, with the full
 * `transcript` and every word with its `speakerLabel`; `startOffset`/`endOffset` per word only when asked for; never a
 * `resultEndOffset`. A result-level time is still honoured when present (older shapes, other models): the words of
 * that result that have no trusted time of their own then share the result's span.
 *
 * A word is `noise` when it is the model's "no speech" marker. A result with a transcript and no word list becomes
 * untimed words of one voice (label `0`).
 */
export function wordsOfPart(doc: unknown, part: number, partStartMs: number, partEndMs: number, wordOffsets: boolean): PartWords | null {
  const limit = partEndMs - partStartMs + PART_END_SLACK_MS;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const results = (doc as { results?: unknown }).results;
  const out: SpeechWord[] = [];
  const done = (): PartWords => ({ part, startMs: partStartMs, endMs: partEndMs, words: out });
  if (results === undefined) return done();
  if (!Array.isArray(results)) return null;

  let previousEnd = 0; // end of the previous RESULT (result-level times)
  let frontier = 0; // the furthest end a trusted word has reached
  let firstWord = true;
  const label = (raw: string) => `p${part}:${raw}`;
  for (const result of results as unknown[]) {
    if (typeof result !== "object" || result === null) return null;
    const { alternatives, resultEndOffset } = result as { alternatives?: unknown; resultEndOffset?: unknown };
    if (alternatives !== undefined && !Array.isArray(alternatives)) return null;
    const end = Math.max(previousEnd, parseOffsetMs(resultEndOffset) ?? previousEnd);
    const start = previousEnd;
    previousEnd = end;
    const resultSpan: WordSpan | null = end > start ? { startMs: partStartMs + start, endMs: partStartMs + end } : null;

    const best = (alternatives as unknown[] | undefined)?.[0];
    if (best === undefined) continue; // a result with no hypothesis: silence
    if (typeof best !== "object" || best === null) return null;
    const { transcript, words } = best as { transcript?: unknown; words?: unknown };
    if (transcript !== undefined && typeof transcript !== "string") return null;
    if (words !== undefined && !Array.isArray(words)) return null;

    const listed = ((words as RawWord[] | undefined) ?? []).filter((w) => typeof w === "object" && w !== null && typeof w.word === "string" && w.word !== "");
    if (out.length + Math.max(listed.length, 0) > MAX_WORDS_PER_PART) throw new TranscriptionError("provider_rejected", false);
    if (listed.length === 0) {
      // No word list: the transcript's own words, one voice, untimed (or sharing the result's span).
      for (const text of (transcript ?? "").split(/\s+/).filter((t) => t !== "")) {
        if (out.length >= MAX_WORDS_PER_PART) throw new TranscriptionError("provider_rejected", false);
        out.push({ text, label: label("0"), unlabelled: true, noise: NOISE_WORD.test(text), span: NOISE_WORD.test(text) ? null : resultSpan });
      }
      continue;
    }
    for (const raw of listed) {
      const text = raw.word as string;
      const noise = NOISE_WORD.test(text);
      let span: WordSpan | null = null;
      if (!noise) {
        const own = wordOffsets ? spanOf(raw, firstWord, frontier, limit) : null;
        firstWord = false;
        if (own) {
          frontier = Math.max(frontier, own.endMs);
          span = { startMs: partStartMs + own.startMs, endMs: partStartMs + own.endMs };
        } else span = resultSpan;
      }
      out.push({ text, label: label(labelOf(raw.speakerLabel)), ...(hasLabel(raw.speakerLabel) ? {} : { unlabelled: true }), noise, span });
    }
  }
  return done();
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** The delay before poll number `n` (0-based): 30 s for the first, then every 15 s (H-4). */
export const pollDelayMs = (n: number): number => (n === 0 ? POLL_FIRST_MS : POLL_EVERY_MS);

/**
 * A counting semaphore whose waiters give up with the lease: a job that lost it must not hold a place in the queue.
 * One instance serves the whole process (`SPEECH_MAX_INFLIGHT`), so two concurrent transcribers share it.
 */
class Semaphore {
  private available: number;
  private readonly waiting: (() => void)[] = [];
  /** The most places ever held at once; tests read it. */
  peak = 0;
  constructor(private readonly size: number) {
    this.available = size;
  }
  get inFlight(): number {
    return this.size - this.available;
  }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.available > 0) this.available -= 1;
    else {
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const at = this.waiting.indexOf(grant);
          if (at >= 0) this.waiting.splice(at, 1);
          reject(signal.reason ?? new Error("aborted"));
        };
        this.waiting.push(grant);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.peak = Math.max(this.peak, this.inFlight);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next(); // the place passes to the next waiter
      else this.available += 1;
    };
  }
}

/** Shared by every transcriber in the process: Google's quota is per project, not per job. */
export const speechInflight = new Semaphore(SPEECH_MAX_INFLIGHT);

// ─── The transcriber ─────────────────────────────────────────────────────────

export function createGoogleTranscriber(options: GoogleTranscriberOptions): Transcriber {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const wordOffsets = options.wordOffsets ?? WORD_OFFSETS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const split = options.split ?? splitAudio;
  const host = `https://${options.location}-speech.googleapis.com/v2`;
  const recognizer = `projects/${encodeURIComponent(options.projectId)}/locations/${options.location}/recognizers/_`;
  const operationName = new RegExp(`^projects/[A-Za-z0-9_-]{1,64}/locations/${options.location}/operations/[A-Za-z0-9_-]{1,200}$`);

  const call = async (url: string, init: { method?: string; body?: string; allow?: readonly number[] }, signal: AbortSignal): Promise<Response> => {
    try {
      return await googleFetch(options.auth, fetchImpl, url, {
        timeoutMs: CALL_TIMEOUT_MS,
        signal,
        ...(init.method ? { method: init.method } : {}),
        ...(init.body !== undefined ? { body: init.body, headers: { "Content-Type": "application/json" } } : {}),
        ...(init.allow ? { allow: init.allow } : {}),
      });
    } catch (error) {
      throw error instanceof GoogleApiError ? fromGoogle(error) : error;
    }
  };

  /** The JSON body of a response, or a transient failure ("a 200 that is not the expected JSON"). */
  const jsonOf = async (response: Response): Promise<unknown> => {
    try {
      return await response.json();
    } catch {
      throw unavailable(response.status);
    }
  };

  async function submit(storage: TransientStorage, locale: TranscriptionLocale, inputKey: string, outputPrefix: string, signal: AbortSignal): Promise<string> {
    const body = {
      config: {
        model: "chirp_3",
        languageCodes: [locale],
        autoDecodingConfig: {},
        features: { diarizationConfig: {}, ...(wordOffsets ? { enableWordTimeOffsets: true } : {}) },
      },
      files: [{ uri: storage.uri(inputKey) }],
      recognitionOutputConfig: { gcsOutputConfig: { uri: storage.prefixUri(outputPrefix) } },
    };
    const response = await call(`${host}/${recognizer}:batchRecognize`, { method: "POST", body: JSON.stringify(body) }, signal);
    const operation = (await jsonOf(response)) as { name?: unknown };
    if (typeof operation?.name !== "string" || !operationName.test(operation.name)) throw unavailable(response.status);
    return operation.name;
  }

  /** Polls until the operation is done; returns it. Aborts with the signal; gives up at the deadline. */
  async function waitFor(name: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const deadline = now() + POLL_DEADLINE_MS;
    let failures = 0;
    for (let n = 0; ; n += 1) {
      await sleep(pollDelayMs(n), signal);
      if (now() >= deadline) throw unavailable();
      try {
        const response = await call(`${host}/${name}`, {}, signal);
        failures = 0;
        const operation = (await jsonOf(response)) as Record<string, unknown> | null;
        if (typeof operation !== "object" || operation === null) throw unavailable(response.status);
        if (operation["done"] === true) return operation;
      } catch (error) {
        if (signal.aborted) throw error;
        // A permanent refusal ends the wait; a transient blip is tolerated a few times in a row.
        if (!(error instanceof TranscriptionError) || !error.transient) throw error;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
      }
    }
  }

  /** The output document of a finished operation, after `operations.delete`. */
  async function collect(
    storage: TransientStorage,
    name: string,
    operation: Record<string, unknown>,
    inputUri: string,
    outputPrefix: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const failure = (operation["error"] ?? null) as { code?: unknown } | null;
    if (failure !== null) {
      const mapped = codeForRpc(failure.code, false);
      throw new TranscriptionError(mapped.code, mapped.transient);
    }
    const response = operation["response"] as { results?: Record<string, unknown> } | undefined;
    const results = response?.results;
    if (typeof results !== "object" || results === null) throw unavailable();
    const entry = (results[inputUri] ?? (Object.keys(results).length === 1 ? Object.values(results)[0] : undefined)) as
      | { error?: { code?: unknown }; cloudStorageResult?: { uri?: unknown } }
      | undefined;
    if (typeof entry !== "object" || entry === null) throw unavailable();
    if (entry.error) {
      const mapped = codeForRpc(entry.error.code, true);
      throw new TranscriptionError(mapped.code, mapped.transient);
    }
    const uri = entry.cloudStorageResult?.uri;
    // Only a file under THIS attempt's out/ is ever read: anything else is refused, not followed.
    const key = typeof uri === "string" ? storage.keyOfUri(uri) : null;
    if (key === null || !key.startsWith(outputPrefix)) throw new TranscriptionError("provider_rejected", false);

    let bytes: Uint8Array;
    try {
      bytes = await storage.read(key, MAX_OUTPUT_BYTES, signal);
    } catch (error) {
      if (error instanceof TransientObjectTooLargeError) throw new TranscriptionError("provider_rejected", false);
      throw error instanceof GoogleApiError ? fromGoogle(error) : error;
    }
    // AC-4.12: this try's output copy lives only until it has been read. A failure here must not fail the try (the
    // attempt's own prefix, the next attempt and the bucket's 1-day rule are the backstop).
    await storage.deletePrefix(outputPrefix).catch(() => console.error("[transcribe] transient cleanup failed"));
    // "The client is no longer interested in the operation result." Best effort: the output is already ours.
    await call(`${host}/${name}`, { method: "DELETE", allow: [404] }, signal)
      .then((r) => r.body?.cancel().catch(() => {}))
      .catch(() => {});
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw unavailable();
    }
  }

  /** The one try of a part: submit, wait (holding one of the process's places), read, delete. */
  async function oneTry(storage: TransientStorage, locale: TranscriptionLocale, inputKey: string, outputPrefix: string, signal: AbortSignal): Promise<unknown> {
    const release = await speechInflight.acquire(signal);
    let name: string;
    let operation: Record<string, unknown>;
    try {
      name = await submit(storage, locale, inputKey, outputPrefix, signal);
      operation = await waitFor(name, signal);
    } finally {
      release();
    }
    return collect(storage, name, operation, storage.uri(inputKey), outputPrefix, signal);
  }

  interface Settled {
    readonly words: PartWords;
    readonly assessment: Assessment;
    readonly tries: number;
  }

  return {
    async transcribe(audio, locale, _maxSpeakers, signal, context?: TranscribeContext): Promise<TranscriptionOutcome> {
      // Programming errors, not provider ones: nothing is sent.
      if (!LOCALES.includes(locale)) throw new TranscriptionError("provider_rejected", false);
      if (!context) throw new TranscriptionError("provider_rejected", false);
      const { meetingId, attempt } = context;
      const maxTries = Math.max(1, Math.trunc(options.maxTries ?? MAX_TRIES));
      const ownPrefix = transientKeys.attemptPrefix(meetingId, attempt);

      const storage = await options.storage();
      const workDir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "meetings-speech-"));
      const lease = signal ?? new AbortController().signal;
      try {
        // 1. Leftovers of OLDER attempts, including output a dead process's operation wrote late. Nothing at or
        //    above this attempt's number: the job runner claims attempts in increasing order, so a number below
        //    ours belongs to an attempt that was superseded before ours began.
        await storage.deleteAttemptsBefore(meetingId, attempt).catch((error: unknown) => {
          throw error instanceof GoogleApiError ? fromGoogle(error) : error;
        });

        // 2. Parts, overlapping, and the silences of the whole recording.
        const input = join(workDir, "audio.ogg");
        await writeFile(input, new Uint8Array(await audio.arrayBuffer()), { mode: 0o600 });
        let parts: SplitPart[];
        let silences: { startMs: number; endMs: number }[];
        try {
          ({ parts, silences } = await split({
            input,
            workDir,
            ...(options.pieceMaxMs !== undefined ? { pieceMaxMs: options.pieceMaxMs } : {}),
            ...(options.overlapTargetMs !== undefined ? { overlapTargetMs: options.overlapTargetMs } : {}),
            signal: lease,
          }));
        } catch (error) {
          if (error instanceof SplitError) throw new TranscriptionError("audio_unreadable", false);
          throw error;
        }

        // 3. One task per part; the first failure of a FIRST try aborts the others.
        const failed = new AbortController();
        const stop = AbortSignal.any([lease, failed.signal]);
        let first: { error: unknown } | null = null;
        let totalTries = 0;
        const settled = await Promise.allSettled(
          parts.map(async (part, index): Promise<Settled> => {
            const number = index + 1;
            const inputKey = transientKeys.input(meetingId, attempt, number);
            try {
              try {
                await storage.put(inputKey, Bun.file(part.path), stop);
              } catch (error) {
                throw error instanceof GoogleApiError ? fromGoogle(error) : error;
              }
              let best: { words: PartWords; assessment: Assessment } | null = null;
              let tries = 0;
              for (let tryNo = 1; tryNo <= maxTries; tryNo += 1) {
                tries = tryNo;
                let words: PartWords;
                try {
                  const doc = await oneTry(storage, locale, inputKey, transientKeys.outputPrefix(meetingId, attempt, number, tryNo), stop);
                  const read = wordsOfPart(doc, number, part.startMs, part.endMs, wordOffsets);
                  if (read === null) throw unavailable();
                  words = read;
                } catch (error) {
                  // A lost lease, or the first try: the attempt fails. A later try that errs is an improvement that
                  // did not happen: the part settles with what it has (the code only, never provider text).
                  if (stop.aborted || tryNo === 1) throw error;
                  console.error(`[transcribe] retry ended: ${error instanceof TranscriptionError ? error.code : "error"}`);
                  tries -= 1;
                  break;
                }
                const assessment = assess(words, silences);
                if (best === null || isBetter(assessment, best.assessment)) best = { words, assessment };
                if (!isIncomplete(best.assessment)) break;
              }
              totalTries += tries;
              return { ...best!, tries };
            } catch (error) {
              first ??= { error };
              failed.abort();
              throw error;
            } finally {
              // AC-4.12: the input copy lives only until the part's last try has ended.
              await storage.delete(inputKey).catch(() => console.error("[transcribe] transient cleanup failed"));
            }
          }),
        );
        if (first !== null) {
          // A lost lease is the abort itself, not a provider failure.
          throw lease.aborted ? lease.reason ?? (first as { error: unknown }).error : (first as { error: unknown }).error;
        }
        const chosen = settled.map((r) => (r as PromiseFulfilledResult<Settled>).value);

        // 4. The gaps that remain, then one transcript.
        const gaps = finalGaps(chosen.map((c) => ({ words: c.words, gaps: c.assessment.gaps })), silences);
        const stitched = stitch({ parts: chosen.map((c) => c.words), gaps });
        const segments = mapPhrases(stitched.phrases);
        // Counts only: never a range, a text, an id.
        console.log(
          `[transcribe] parts=${parts.length} tries=${totalTries} gaps=${gaps.length} excused=${chosen.reduce((n, c) => n + c.assessment.excused, 0)} removed=${stitched.stats.removedWithinPart + stitched.stats.removedInOverlap} joined=${stitched.stats.joined} separate=${stitched.stats.separate}`,
        );
        if (segments.length === 0) {
          // AC-6.7: "no speech" only when no stretch of the recording holds speech that the transcript lacks.
          if (gaps.length > 0) throw new TranscriptionError("speech_not_transcribed", false);
          return { kind: "noSpeech" };
        }
        return {
          kind: "segments",
          segments,
          partStartsMs: parts.map((p) => p.startMs),
          parts: parts.map((p) => ({ startMs: p.startMs, endMs: p.endMs })),
          gaps,
        };
      } finally {
        // 5. Whatever happened: nothing of THIS attempt stays in the transient bucket - and nothing of another
        //    (a newer attempt may be running if our lease was lost). A failure here must not mask the attempt's
        //    own outcome; the next attempt's step 1 and the bucket's 1-day rule are the backstop.
        await storage.deletePrefix(ownPrefix).catch(() => console.error("[transcribe] transient cleanup failed"));
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}

/** From the environment (`MEETINGS_AI_PROVIDER=real`; env.ts requires every value). */
export async function createGoogleTranscriberFromEnv(): Promise<Transcriber> {
  const { env } = await import("../lib/env");
  const { googleAuth } = await import("../lib/google/auth");
  const { requireTransientStorage } = await import("../lib/google/transientStorage");
  return createGoogleTranscriber({
    auth: await googleAuth(),
    projectId: env.MEETINGS_GCP_PROJECT_ID!,
    location: env.MEETINGS_SPEECH_LOCATION!,
    storage: requireTransientStorage,
  });
}
