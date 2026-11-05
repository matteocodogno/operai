/**
 * Cloud Speech-to-Text v2, model Chirp 3, `BatchRecognize` (specs/021-meetings plan.md § Amendment 2026-11-05
 * G-2, G-3, G-8, ADR-0069, ADR-0070; AC-6.1, AC-6.2, AC-6.5, AC-6.7, AC-6.9, AC-13.2, AC-4.10, AC-4.12).
 *
 * WHY A BUCKET: Chirp 3 diarizes only in `Recognize` (<= 1 minute) and `BatchRecognize`, and BatchRecognize reads
 * audio only from a `gs://` URI. So one attempt stages its audio in the transient EU bucket (src/lib/google),
 * Speech writes its output beside it, and the attempt's own prefix is emptied in `finally`, older attempts'
 * leftovers at its start, and the whole meeting by the deletion routes. Nothing is kept here.
 *
 * ONE ATTEMPT:
 *   1. empty the prefixes of OLDER attempts of this meeting (`transcribe/<meetingId>/<n>/`, n < this attempt:
 *      leftovers, including late output). Never this attempt's or a newer one's: a job whose lease was lost can
 *      still be running while the runner has claimed attempt n+1 (ADR-0062), and a stale attempt must not
 *      delete what the live one staged;
 *   2. split the recording (src/media/split.ts) into parts of at most `PIECE_MAX_MS`;
 *   3. upload each part (`ifGenerationMatch=0`), submit ONE `batchRecognize` per part, all together:
 *      chirp_3, exactly one locale (AC-13.2, never "auto"), diarization, output to our bucket, never inline;
 *   4. poll each operation (10 s backing off to 30 s, 45 min deadline, a lost lease aborts);
 *   5. read each output (<= 8 MiB, URI checked to lie in THIS attempt's `out/`), then `operations.delete`;
 *   6. map to phrases with part offsets; ANY part failing fails the whole attempt (AC-6.9: no partial
 *      transcript at rest);
 *   7. `finally`: empty THIS attempt's prefix (only) and remove the temp directory.
 *
 * TIMES (G-3, as recorded by the spike T107): a batch output has NO result-level time. It is ONE result per part with
 * the whole transcript and every word with its speaker, and no `resultEndOffset`. Times exist only as per-word
 * `startOffset`/`endOffset`, which `WORD_OFFSETS` asks for. They are a model's and are not all to be believed (a
 * garbled first sentence, a sentence-final word ending minutes early, a word stamped hours late), so a word is trusted
 * only when it is plausible and inside its part (`spanOf`); a run takes the times of its first and last trusted words,
 * and a run with none starts where the phrase before it ended: never later than the speech (AC-6.5).
 *
 * PARTS (G-3, T107): Google refuses a Chirp 3 batch file over 20 minutes, and parts of 18-19 minutes came back with
 * multi-minute stretches of speech missing, so `PIECE_MAX_MS` (src/media/split.ts) is 10 minutes. The adapter cannot
 * tell a transcript with a hole from a quiet stretch: see the T107 note in plan.md § G-3.
 *
 * SPEAKERS (G-3, ADR-0070): diarization labels are per word and per file. A result whose words change speaker is
 * split into one phrase per run, and every label is namespaced by its part (`p2:1`), so part 2's voices never
 * reuse part 1's keys: a system that cannot tell whether two voices are the same person must not say they are.
 * Merging is renaming.
 *
 * FAILURES map into the closed codes by HTTP status and gRPC code only (G-8); provider text is never parsed,
 * logged or stored. Any thrown error is a `TranscriptionError` except a lost lease, which is the abort itself.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleApiError, defaultFetch, googleFetch, type GoogleAuth } from "../lib/google/auth";
import { TransientObjectTooLargeError, transientKeys, type TransientStorage } from "../lib/google/transientStorage";
import { PIECE_MAX_MS, SplitError, splitAudio, type SplitPart } from "../media/split";
import { mapPhrases, type Phrase } from "./segments";
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
/** Per part: how long to wait for Google before giving up (G-2 step 6). */
export const POLL_DEADLINE_MS = 45 * 60_000;
/** First poll delay, growing by 5 s to the ceiling. */
export const POLL_FIRST_MS = 10_000;
export const POLL_MAX_MS = 30_000;
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
  /** Where the temp directory is made; default the OS temp dir. */
  readonly tmpRoot?: string;
  /** Tests inject a clock and a sleep that advances it. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly split?: typeof splitAudio;
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

/** The words the model uses for "no speech" (its prompt says `[BACKGROUND]`; the recording showed a lone `[`). */
const NOISE_WORD = /^(?:\[|\]|\[?BACKGROUND\]?)$/i;
/** A phrase with no letter and no digit is punctuation or a marker, never speech. */
const HAS_SPEECH = /[\p{L}\p{N}]/u;

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
 * The phrases of one part's output file (`BatchRecognizeResults`), with the part's offset added. Pure. Returns
 * null when the document is not the shape this module understands.
 *
 * WHAT GOOGLE REALLY SENDS (recorded, test-fixtures/google-speech): one result for a whole part, with the full
 * `transcript` and every word with its `speakerLabel`; `startOffset`/`endOffset` per word only when asked for;
 * never a `resultEndOffset`. A result-level time is still honoured when present (older shapes, other models).
 */
export function phrasesOfPart(doc: unknown, part: number, partStartMs: number, wordOffsets: boolean, partDurationMs: number = PIECE_MAX_MS): Phrase[] | null {
  const limit = partDurationMs + PART_END_SLACK_MS;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const results = (doc as { results?: unknown }).results;
  if (results === undefined) return [];
  if (!Array.isArray(results)) return null;

  const phrases: Phrase[] = [];
  let previousEnd = 0; // end of the previous RESULT (result-level times)
  let frontier = 0; // the furthest end a trusted word has reached
  let lastFrom = 0;
  let lastTo = 0;
  let firstWord = true;
  for (const result of results as unknown[]) {
    if (typeof result !== "object" || result === null) return null;
    const { alternatives, resultEndOffset } = result as { alternatives?: unknown; resultEndOffset?: unknown };
    if (alternatives !== undefined && !Array.isArray(alternatives)) return null;
    const end = Math.max(previousEnd, parseOffsetMs(resultEndOffset) ?? previousEnd);
    const start = previousEnd;
    previousEnd = end;

    const best = (alternatives as unknown[] | undefined)?.[0];
    if (best === undefined) continue; // a result with no hypothesis: silence
    if (typeof best !== "object" || best === null) return null;
    const { transcript, words } = best as { transcript?: unknown; words?: unknown };
    if (transcript !== undefined && typeof transcript !== "string") return null;
    if (words !== undefined && !Array.isArray(words)) return null;
    const text = (transcript ?? "").trim();
    const speaker = (label: string) => `p${part}:${label}`;
    const push = (label: string, body: string, from: number, to: number) => {
      if (!HAS_SPEECH.test(body)) return; // "[" and friends: nothing was said
      // Never backwards: a phrase does not start before the one before it, nor end before it starts.
      const a = Math.max(from, lastFrom);
      const b = Math.max(to, a);
      lastFrom = a;
      lastTo = b;
      phrases.push({ speaker: speaker(label), startMs: partStartMs + a, durationMs: b - a, text: body });
    };

    const allWords = (words as RawWord[] | undefined) ?? [];
    const spoken = allWords.filter((w) => typeof w === "object" && w !== null && typeof w.word === "string" && w.word !== "" && !NOISE_WORD.test(w.word));
    if (spoken.length === 0) {
      push("0", text.split(/\s+/).filter((t) => !NOISE_WORD.test(t)).join(" "), Math.max(start, lastTo), end);
      continue;
    }

    // Consecutive words of one speaker are one run; a change of speaker starts a new phrase.
    const runs: { label: string; words: RawWord[]; spans: (WordSpan | null)[] }[] = [];
    for (const word of spoken) {
      const label = labelOf(word.speakerLabel);
      const span = wordOffsets ? spanOf(word, firstWord, frontier, limit) : null;
      firstWord = false;
      if (span) frontier = Math.max(frontier, span.endMs);
      const last = runs[runs.length - 1];
      if (last && last.label === label) {
        last.words.push(word);
        last.spans.push(span);
      } else runs.push({ label, words: [word], spans: [span] });
    }
    for (const run of runs) {
      // One voice in the whole result, nothing dropped: keep the transcript as Google wrote it (punctuation and all).
      const intact = runs.length === 1 && text !== "" && spoken.length === allWords.length;
      const body = intact ? text : run.words.map((w) => w.word as string).join(" ");
      const trusted = run.spans.filter((x): x is WordSpan => x !== null);
      // Exact times from the run's first and last trusted words. Else the result's own start when the result has times
      // (never late: every run of it starts there), else where the previous phrase ended.
      const from = trusted.length > 0 ? trusted[0]!.startMs : end > start ? start : lastTo;
      const to = trusted.length > 0 ? trusted[trusted.length - 1]!.endMs : Math.max(end, from);
      push(run.label, body, from, to);
    }
  }
  return phrases;
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

/** The delay before poll number `n` (0-based): 10 s, then 5 s longer each time, to 30 s. */
export const pollDelayMs = (n: number): number => Math.min(POLL_MAX_MS, POLL_FIRST_MS + 5_000 * n);

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
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw unavailable();
    }
    // "The client is no longer interested in the operation result." Best effort: the output is already ours.
    await call(`${host}/${name}`, { method: "DELETE", allow: [404] }, signal)
      .then((r) => r.body?.cancel().catch(() => {}))
      .catch(() => {});
    return doc;
  }

  return {
    async transcribe(audio, locale, _maxSpeakers, signal, context?: TranscribeContext): Promise<TranscriptionOutcome> {
      // Programming errors, not provider ones: nothing is sent.
      if (!LOCALES.includes(locale)) throw new TranscriptionError("provider_rejected", false);
      if (!context) throw new TranscriptionError("provider_rejected", false);
      const { meetingId, attempt } = context;
      const ownPrefix = transientKeys.attemptPrefix(meetingId, attempt);
      const outputPrefix = transientKeys.outputPrefix(meetingId, attempt);

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

        // 2. Parts.
        const input = join(workDir, "audio.ogg");
        await writeFile(input, new Uint8Array(await audio.arrayBuffer()), { mode: 0o600 });
        let parts: SplitPart[];
        try {
          ({ parts } = await split({
            input,
            workDir,
            ...(options.pieceMaxMs !== undefined ? { pieceMaxMs: options.pieceMaxMs } : {}),
            signal: lease,
          }));
        } catch (error) {
          if (error instanceof SplitError) throw new TranscriptionError("audio_unreadable", false);
          throw error;
        }

        // 3-5. One task per part; the first failure aborts the others.
        const failed = new AbortController();
        const stop = AbortSignal.any([lease, failed.signal]);
        let first: { error: unknown } | null = null;
        const settled = await Promise.allSettled(
          parts.map(async (part, index) => {
            try {
              const number = index + 1;
              const inputKey = transientKeys.input(meetingId, attempt, number);
              try {
                await storage.put(inputKey, Bun.file(part.path), stop);
              } catch (error) {
                throw error instanceof GoogleApiError ? fromGoogle(error) : error;
              }
              const name = await submit(storage, locale, inputKey, outputPrefix, stop);
              const operation = await waitFor(name, stop);
              const doc = await collect(storage, name, operation, storage.uri(inputKey), outputPrefix, stop);
              const phrases = phrasesOfPart(doc, number, part.startMs, wordOffsets, part.endMs - part.startMs);
              if (phrases === null) throw unavailable();
              return phrases;
            } catch (error) {
              first ??= { error };
              failed.abort();
              throw error;
            }
          }),
        );
        if (first !== null) {
          // A lost lease is the abort itself, not a provider failure.
          throw lease.aborted ? lease.reason ?? (first as { error: unknown }).error : (first as { error: unknown }).error;
        }

        // 6. Map.
        const phrases = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
        const segments = mapPhrases(phrases);
        return segments.length === 0 ? { kind: "noSpeech" } : { kind: "segments", segments, partStartsMs: parts.map((p) => p.startMs) };
      } finally {
        // 7. Whatever happened: nothing of THIS attempt stays in the transient bucket - and nothing of another
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
