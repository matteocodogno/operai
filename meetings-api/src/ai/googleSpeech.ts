/**
 * Cloud Speech-to-Text v2, model Chirp 3, `BatchRecognize` (specs/021-meetings plan.md § Amendment 2026-11-05
 * G-2, G-3, G-8, ADR-0069, ADR-0070; AC-6.1, AC-6.2, AC-6.5, AC-6.7, AC-6.9, AC-13.2, AC-4.10, AC-4.12).
 *
 * WHY A BUCKET: Chirp 3 diarizes only in `Recognize` (<= 1 minute) and `BatchRecognize`, and BatchRecognize reads
 * audio only from a `gs://` URI. So one attempt stages its audio in the transient EU bucket (src/lib/google),
 * Speech writes its output beside it, and the attempt's prefix is emptied at its start, in `finally`, and by the
 * deletion routes. Nothing is kept here.
 *
 * ONE ATTEMPT:
 *   1. empty `transcribe/<meetingId>/` (leftovers of an earlier attempt, including late output);
 *   2. split the recording (src/media/split.ts) into parts of at most `PIECE_MAX_MS`;
 *   3. upload each part (`ifGenerationMatch=0`), submit ONE `batchRecognize` per part, all together:
 *      chirp_3, exactly one locale (AC-13.2, never "auto"), diarization, output to our bucket, never inline;
 *   4. poll each operation (10 s backing off to 30 s, 45 min deadline, a lost lease aborts);
 *   5. read each output (<= 8 MiB, URI checked to lie in THIS attempt's `out/`), then `operations.delete`;
 *   6. map to phrases with part offsets; ANY part failing fails the whole attempt (AC-6.9: no partial
 *      transcript at rest);
 *   7. `finally`: empty the prefix again and remove the temp directory.
 *
 * TIMES (G-3): Chirp 3 gives utterance times only when streaming. A batch result carries `resultEndOffset`, so a
 * segment starts at the previous result's end and ends at its own: never LATER than the speech, so "play from
 * here" (AC-6.5) starts at or just before the words. With `WORD_OFFSETS` on (a spike outcome) the times are exact.
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
import { SplitError, splitAudio, type SplitPart } from "../media/split";
import { mapPhrases, type Phrase } from "./segments";
import {
  TranscriptionError,
  type TranscribeContext,
  type Transcriber,
  type TranscriptionFailureCode,
  type TranscriptionLocale,
  type TranscriptionOutcome,
} from "./transcriber";

/** Word-level time offsets: off by default (Chirp 3 batch is "up to 20 minutes with word-level timestamps"). The spike (T107) decides. */
export const WORD_OFFSETS = false;
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

/**
 * The phrases of one part's output file (`BatchRecognizeResults`), with the part's offset added. Pure. Returns
 * null when the document is not the shape this module understands.
 */
export function phrasesOfPart(doc: unknown, part: number, partStartMs: number, wordOffsets: boolean): Phrase[] | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const results = (doc as { results?: unknown }).results;
  if (results === undefined) return [];
  if (!Array.isArray(results)) return null;

  const phrases: Phrase[] = [];
  let previousEnd = 0;
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
    const phrase = (label: string, body: string, from: number, to: number): Phrase => ({
      speaker: speaker(label),
      startMs: partStartMs + from,
      durationMs: Math.max(0, to - from),
      text: body,
    });

    const spoken = ((words as RawWord[] | undefined) ?? []).filter((w) => typeof w === "object" && w !== null && typeof w.word === "string" && w.word !== "");
    if (spoken.length === 0) {
      if (text !== "") phrases.push(phrase("0", text, start, end));
      continue;
    }

    // Consecutive words of one speaker are one run; a change of speaker starts a new phrase.
    const runs: { label: string; words: RawWord[] }[] = [];
    for (const word of spoken) {
      const label = labelOf(word.speakerLabel);
      const last = runs[runs.length - 1];
      if (last && last.label === label) last.words.push(word);
      else runs.push({ label, words: [word] });
    }
    for (const run of runs) {
      // One voice in the whole result keeps the transcript as Google wrote it (punctuation and all).
      const body = runs.length === 1 && text !== "" ? text : run.words.map((w) => w.word as string).join(" ");
      let from = start;
      let to = end;
      if (wordOffsets) {
        const first = parseOffsetMs(run.words[0]!.startOffset);
        const last = parseOffsetMs(run.words[run.words.length - 1]!.endOffset);
        if (first !== null && last !== null && last >= first) {
          from = first;
          to = last;
        }
      }
      phrases.push(phrase(run.label, body, from, to));
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
      recognitionOutputConfig: { gcsOutputConfig: { uri: storage.uri(outputPrefix) } },
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
      const prefix = transientKeys.prefix(meetingId);
      const outputPrefix = transientKeys.outputPrefix(meetingId, attempt);

      const storage = await options.storage();
      const workDir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "meetings-speech-"));
      const lease = signal ?? new AbortController().signal;
      try {
        // 1. Leftovers of any earlier attempt, including output a dead process's operation wrote late.
        await storage.deletePrefix(prefix).catch((error: unknown) => {
          throw error instanceof GoogleApiError ? fromGoogle(error) : error;
        });

        // 2. Parts.
        const input = join(workDir, "audio.ogg");
        await writeFile(input, new Uint8Array(await audio.arrayBuffer()), { mode: 0o600 });
        let parts: SplitPart[];
        try {
          parts = await split({
            input,
            workDir,
            ...(options.pieceMaxMs !== undefined ? { pieceMaxMs: options.pieceMaxMs } : {}),
            signal: lease,
          });
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
              const phrases = phrasesOfPart(doc, number, part.startMs, wordOffsets);
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
        // 7. Whatever happened: nothing of this meeting stays in the transient bucket. A failure here must not
        //    mask the attempt's own outcome; the next attempt's step 1 and the bucket's 1-day rule are the backstop.
        await storage.deletePrefix(prefix).catch(() => console.error("[transcribe] transient cleanup failed"));
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
