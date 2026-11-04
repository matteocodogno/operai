/**
 * Azure AI Speech FAST TRANSCRIPTION (specs/021-meetings plan.md § AI providers,
 * ADR-0061; AC-6.2, AC-6.7, AC-13.2): one synchronous REST call per audio file.
 * Microsoft documents that fast transcription does not retain or store the data;
 * the region is checked against the EU/CH allowlist at startup (residency.ts).
 *
 *   POST {endpoint}/speechtotext/transcriptions:transcribe?api-version=2024-11-15
 *   multipart/form-data: audio (the file) + definition (JSON)
 *
 * The definition names ONE locale (`it-IT` or `en-US`, never several, never
 * auto-detect) and switches diarization on with `maxSpeakers` clamped to 2..35.
 *
 * Failure mapping, so the job runner can decide retry or give up without parsing
 * provider text (which is never logged, kept or put in an error):
 *   - 4xx (except 408, 429)  permanent. 413 -> `too_long`, 400/415/422 ->
 *                            `audio_unreadable`, the rest -> `provider_rejected`
 *   - 408, 429, 5xx, timeout, network, a 200 that is not the expected JSON
 *                            transient `provider_unavailable`
 */

import { mapPhrases, type Phrase } from "./segments";
import {
  MAX_SPEAKERS,
  MIN_SPEAKERS,
  TranscriptionError,
  type Transcriber,
  type TranscriptionFailureCode,
  type TranscriptionLocale,
  type TranscriptionOutcome,
} from "./transcriber";

const API_VERSION = "2024-11-15";
/** A 3 h file takes minutes; the job's lease is heartbeated meanwhile. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const LOCALES: readonly string[] = ["it-IT", "en-US"] satisfies TranscriptionLocale[];

export interface AzureSpeechOptions {
  /** `AZURE_SPEECH_REGION`, already checked against the allowlist. */
  readonly region: string;
  /** `AZURE_SPEECH_KEY`: sent as a header, never logged. */
  readonly key: string;
  /** `AZURE_SPEECH_ENDPOINT` when set (already checked to name the same region). */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  /** Looked up per call; tests pass a stub. */
  readonly fetchImpl?: typeof fetch;
}

const clampSpeakers = (asked: number): number =>
  Number.isFinite(asked) ? Math.min(MAX_SPEAKERS, Math.max(MIN_SPEAKERS, Math.trunc(asked))) : MIN_SPEAKERS;

function codeForStatus(status: number): TranscriptionFailureCode {
  if (status === 413) return "too_long";
  if (status === 400 || status === 415 || status === 422) return "audio_unreadable";
  return "provider_rejected";
}

const unavailable = (status?: number) => new TranscriptionError("provider_unavailable", true, status);

/** The phrases of a 200 answer, or null when the body is not the shape this module understands. */
function phrasesOf(body: unknown): Phrase[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = (body as { phrases?: unknown }).phrases;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const phrases: Phrase[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { speaker, offsetMilliseconds, durationMilliseconds, text } = entry as Record<string, unknown>;
    if (typeof text !== "string") return null;
    phrases.push({
      speaker: typeof speaker === "number" || typeof speaker === "string" ? speaker : null,
      startMs: typeof offsetMilliseconds === "number" ? offsetMilliseconds : 0,
      durationMs: typeof durationMilliseconds === "number" ? durationMilliseconds : 0,
      text,
    });
  }
  return phrases;
}

export function createAzureTranscriber(options: AzureSpeechOptions): Transcriber {
  const base = (options.endpoint ?? `https://${options.region}.api.cognitive.microsoft.com`).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async transcribe(audio, locale, maxSpeakers, signal): Promise<TranscriptionOutcome> {
      // A programming error, not a provider one: nothing is sent.
      if (!LOCALES.includes(locale)) throw new TranscriptionError("provider_rejected", false);

      const form = new FormData();
      form.set("audio", audio, "audio.ogg");
      form.set(
        "definition",
        JSON.stringify({ locales: [locale], diarization: { enabled: true, maxSpeakers: clampSpeakers(maxSpeakers) } }),
      );

      const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await doFetch(`${base}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`, {
          method: "POST",
          headers: { "Ocp-Apim-Subscription-Key": options.key, Accept: "application/json" },
          body: form,
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
          redirect: "error",
        });
      } catch {
        // Timeout, abort, DNS, TLS, reset: all the same to the caller. The error text is dropped.
        throw unavailable();
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = response.status;
        if (status === 408 || status === 429 || status >= 500) throw unavailable(status);
        throw new TranscriptionError(codeForStatus(status), false, status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw unavailable(response.status);
      }
      const phrases = phrasesOf(body);
      if (phrases === null) throw unavailable(response.status);

      const segments = mapPhrases(phrases);
      return segments.length === 0 ? { kind: "noSpeech" } : { kind: "segments", segments };
    },
  };
}
