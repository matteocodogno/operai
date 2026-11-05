/**
 * The transcription seam (specs/021-meetings plan.md § AI providers, ADR-0061;
 * AC-6.2, AC-6.7, AC-13.2). One real implementation (`googleSpeech.ts`, Chirp 3 on
 * Google Cloud, ADR-0069) and a fake (`fakeTranscriber.ts`); a fallback provider would sit behind the same
 * interface, after its own residency decision.
 *
 * The LOCALE is the meeting's language, chosen by its creator, never detected
 * (AC-13.2): `it-IT` or `en-US` and nothing else.
 */

import type { DraftSegment } from "./segments";

export type TranscriptionLocale = "it-IT" | "en-US";

export const LOCALE_OF = { it: "it-IT", en: "en-US" } as const satisfies Record<"it" | "en", TranscriptionLocale>;

export const MIN_SPEAKERS = 2;
/** The range `maxSpeakersFor` clamps to. Chirp 3 does not use speaker counts (they are "not currently used"), so the Google adapter ignores it. */
export const MAX_SPEAKERS = 35;

/** `maxSpeakers` for a meeting: its participants plus one unlisted voice, within the provider's range. */
export const maxSpeakersFor = (participants: number): number =>
  Math.min(MAX_SPEAKERS, Math.max(MIN_SPEAKERS, Math.trunc(participants) + 1));

export type TranscriptionOutcome =
  | {
      readonly kind: "segments";
      readonly segments: readonly DraftSegment[];
      /**
       * Where each transcript PART starts in the recording (ADR-0070): `[0]` for one part, `[0, t2, ...]` for a
       * long recording transcribed in parts. Non-empty, first element 0, ascending.
       */
      readonly partStartsMs: readonly number[];
      /**
       * Every part's span in meeting time (H-6): overlapping, so a part's end is not the next part's start.
       * Same length and order as `partStartsMs`.
       */
      readonly parts: readonly TranscriptPart[];
      /**
       * The stretches that may be missing from the transcript (AC-6.12): meeting time, merged, ascending. Empty when the
       * transcript has no known gap (which is not a statement that nothing is missing).
       */
      readonly gaps: readonly TranscriptGap[];
    }
  /** The provider heard no speech (AC-6.7): a `ready` meeting with nothing to summarise. */
  | { readonly kind: "noSpeech" };

export interface TranscriptPart {
  readonly startMs: number;
  readonly endMs: number;
}

export interface TranscriptGap {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Closed set, the values a `failureCode` may take (plan.md § Data model). `speech_not_transcribed` (AC-6.7, H-3): the
 * recording has sound where speech is to be expected but the transcript came back empty after every retry; permanent.
 */
export type TranscriptionFailureCode = "audio_unreadable" | "provider_unavailable" | "provider_rejected" | "too_long" | "speech_not_transcribed";

/**
 * Thrown by a transcriber. `transient` = worth retrying (429, 5xx, timeout, network);
 * otherwise the same bytes will be refused again. The message never carries provider
 * text, a URL or a key: only the closed `code` and a status.
 */
export class TranscriptionError extends Error {
  constructor(
    readonly code: TranscriptionFailureCode,
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(`transcription failed: ${code}${status !== undefined ? ` (HTTP ${status})` : ""}`);
    this.name = "TranscriptionError";
  }
}

/**
 * Which attempt of which job is calling. The Google adapter stages its work in a per-attempt prefix of the
 * transient bucket (`transcribe/<meetingId>/<attempt>/`); the fake ignores it.
 */
export interface TranscribeContext {
  readonly meetingId: string;
  /** The job's claim number (1-based). */
  readonly attempt: number;
}

export interface Transcriber {
  /**
   * @param audio the normalised audio (`audio.ogg`)
   * @param maxSpeakers see `maxSpeakersFor`; ignored by Chirp 3
   * @param context the meeting and attempt; required by the Google adapter
   */
  transcribe(audio: Blob, locale: TranscriptionLocale, maxSpeakers: number, signal?: AbortSignal, context?: TranscribeContext): Promise<TranscriptionOutcome>;
}

let current: Transcriber | null = null;

/**
 * The transcriber for this process: the fake under `MEETINGS_AI_PROVIDER=fake` (env.ts
 * refuses that in production), otherwise Google. Imported lazily so a fake run never loads
 * the real adapter.
 */
export async function transcriber(): Promise<Transcriber> {
  if (current) return current;
  const { env } = await import("../lib/env");
  if (env.MEETINGS_AI_PROVIDER === "fake") {
    const { FakeTranscriber } = await import("./fakeTranscriber");
    current = new FakeTranscriber();
  } else {
    const { createGoogleTranscriberFromEnv } = await import("./googleSpeech");
    current = await createGoogleTranscriberFromEnv();
  }
  return current;
}

/** Tests only: install a transcriber (or `null` to rebuild from the environment). */
export function setTranscriberForTests(replacement: Transcriber | null): void {
  current = replacement;
}
