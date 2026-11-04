/**
 * The transcription seam (specs/021-meetings plan.md § AI providers, ADR-0061;
 * AC-6.2, AC-6.7, AC-13.2). One real implementation (`azureSpeech.ts`) and a fake
 * (`fakeTranscriber.ts`); a fallback provider (Voxtral) would sit behind the same
 * interface, after its own residency decision.
 *
 * The LOCALE is the meeting's language, chosen by its creator, never detected
 * (AC-13.2): `it-IT` or `en-US` and nothing else.
 */

import type { DraftSegment } from "./segments";

export type TranscriptionLocale = "it-IT" | "en-US";

export const LOCALE_OF = { it: "it-IT", en: "en-US" } as const satisfies Record<"it" | "en", TranscriptionLocale>;

export const MIN_SPEAKERS = 2;
/** Azure fast transcription diarizes 2 to 35 speakers. */
export const MAX_SPEAKERS = 35;

/** `maxSpeakers` for a meeting: its participants plus one unlisted voice, within the provider's range. */
export const maxSpeakersFor = (participants: number): number =>
  Math.min(MAX_SPEAKERS, Math.max(MIN_SPEAKERS, Math.trunc(participants) + 1));

export type TranscriptionOutcome =
  | { readonly kind: "segments"; readonly segments: readonly DraftSegment[] }
  /** The provider heard no speech (AC-6.7): a `ready` meeting with nothing to summarise. */
  | { readonly kind: "noSpeech" };

/** Closed set, the values a `failureCode` may take (plan.md § Data model). */
export type TranscriptionFailureCode = "audio_unreadable" | "provider_unavailable" | "provider_rejected" | "too_long";

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

export interface Transcriber {
  /**
   * @param audio the normalised audio (`audio.ogg`)
   * @param maxSpeakers see `maxSpeakersFor`; clamped again by the implementation
   */
  transcribe(audio: Blob, locale: TranscriptionLocale, maxSpeakers: number, signal?: AbortSignal): Promise<TranscriptionOutcome>;
}

let current: Transcriber | null = null;

/**
 * The transcriber for this process: the fake under `MEETINGS_AI_PROVIDER=fake` (env.ts
 * refuses that in production), otherwise Azure. Imported lazily so a fake run never loads
 * the real adapter.
 */
export async function transcriber(): Promise<Transcriber> {
  if (current) return current;
  const { env } = await import("../lib/env");
  if (env.MEETINGS_AI_PROVIDER === "fake") {
    const { FakeTranscriber } = await import("./fakeTranscriber");
    current = new FakeTranscriber();
  } else {
    const { createAzureTranscriber } = await import("./azureSpeech");
    current = createAzureTranscriber({
      region: env.AZURE_SPEECH_REGION!,
      key: env.AZURE_SPEECH_KEY!,
      ...(env.AZURE_SPEECH_ENDPOINT ? { endpoint: env.AZURE_SPEECH_ENDPOINT } : {}),
    });
  }
  return current;
}

/** Tests only: install a transcriber (or `null` to rebuild from the environment). */
export function setTranscriberForTests(replacement: Transcriber | null): void {
  current = replacement;
}
