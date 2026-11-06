/**
 * A scriptable `Transcriber` for tests and for `MEETINGS_AI_PROVIDER=fake`
 * (dev, test and e2e only; env.ts refuses it in production). Never touches the
 * network.
 *
 * By default it hears two speakers saying one line each, which is enough for an
 * end-to-end run to produce a transcript. A test scripts what it needs:
 *
 *   fake.respondWith({ kind: "noSpeech" })
 *   fake.failWith(new TranscriptionError("provider_unavailable", true, 503))
 *   fake.respondWith(async (call) => ...)
 *   fake.respondWith({ kind: "segments", segments, partStartsMs: [0, 3_600_000, 7_200_000] })   // a long recording
 *   fake.respondWith({ kind: "segments", segments, gaps: [{ startMs: 60_000, endMs: 95_000 }] }) // a possibly incomplete transcript (AC-6.12)
 *   fake.respondWith({ kind: "segments", segments: segmentsOf([[1, "s1", 0, "a"], [2, "s1", 540_000, "b"]]),
 *                      parts: [{ startMs: 0, endMs: 600_000 }, { startMs: 510_000, endMs: 1_110_000 }] })   // a label JOINED across parts
 *
 * A JOINED label is one speaker key on segments of more than one part; a separate one is a different key (the
 * stitcher's decision, here scripted). `segmentsOf` builds such segments from `[part, key, startMs, text]` rows.
 */

import { mapPhrases, type DraftSegment, type Phrase } from "./segments";
import type { TranscribeContext, Transcriber, TranscriptGap, TranscriptPart, TranscriptionLocale, TranscriptionOutcome } from "./transcriber";

export interface TranscribeCall {
  readonly context: TranscribeContext | undefined;
  readonly audio: Blob;
  readonly locale: TranscriptionLocale;
  readonly maxSpeakers: number;
}

/**
 * A scripted segments outcome may leave the rest out: with no `parts` and no `partStartsMs` it is one part starting at
 * 0 and ending with its last segment; with `parts` the starts follow from them; `gaps` default to none.
 */
type ScriptedOutcome =
  | Extract<TranscriptionOutcome, { kind: "noSpeech" }>
  | {
      readonly kind: "segments";
      readonly segments: readonly DraftSegment[];
      readonly partStartsMs?: readonly number[];
      readonly parts?: readonly TranscriptPart[];
      readonly gaps?: readonly TranscriptGap[];
    };
type Script = ScriptedOutcome | Error | ((call: TranscribeCall) => ScriptedOutcome | Promise<ScriptedOutcome>);

const complete = (outcome: ScriptedOutcome): TranscriptionOutcome => {
  if (outcome.kind !== "segments") return outcome;
  const lastEnd = outcome.segments.reduce((end, s) => Math.max(end, s.endMs), 0);
  const starts = outcome.parts?.map((p) => p.startMs) ?? outcome.partStartsMs ?? [0];
  const parts = outcome.parts ?? starts.map((startMs, i) => ({ startMs, endMs: Math.max(startMs, starts[i + 1] ?? lastEnd) }));
  return { kind: "segments", segments: outcome.segments, partStartsMs: starts, parts, gaps: outcome.gaps ?? [] };
};

/** Segments from `[part, speakerKey, startMs, text]` rows, one second long each, ordinals from 0. */
export const segmentsOf = (rows: readonly (readonly [part: number, speakerKey: string, startMs: number, text: string])[]): DraftSegment[] =>
  rows.map(([part, speakerKey, startMs, text], ordinal) => ({ ordinal, startMs, endMs: startMs + 1_000, speakerKey, text, part }));

const DEFAULT_PHRASES: Record<TranscriptionLocale, readonly Phrase[]> = {
  "en-US": [
    { speaker: 1, startMs: 0, durationMs: 2_000, text: "Let us start with the plan for next quarter." },
    { speaker: 2, startMs: 2_500, durationMs: 2_000, text: "Agreed. I will send the notes tomorrow." },
  ],
  "it-IT": [
    { speaker: 1, startMs: 0, durationMs: 2_000, text: "Cominciamo dal piano del prossimo trimestre." },
    { speaker: 2, startMs: 2_500, durationMs: 2_000, text: "D'accordo. Mando gli appunti domani." },
  ],
};

export class FakeTranscriber implements Transcriber {
  /** Every call, in order. */
  readonly calls: TranscribeCall[] = [];
  private readonly queue: Script[] = [];

  /** One entry per upcoming call; once the queue is empty the default transcript is returned. */
  respondWith(...scripts: Script[]): this {
    this.queue.push(...scripts);
    return this;
  }

  failWith(error: Error): this {
    return this.respondWith(error);
  }

  async transcribe(audio: Blob, locale: TranscriptionLocale, maxSpeakers: number, signal?: AbortSignal, context?: TranscribeContext): Promise<TranscriptionOutcome> {
    signal?.throwIfAborted();
    const call: TranscribeCall = { context, audio, locale, maxSpeakers };
    this.calls.push(call);
    const script = this.queue.shift();
    if (script instanceof Error) throw script;
    if (typeof script === "function") return complete(await script(call));
    if (script) return complete(script);
    return complete({ kind: "segments", segments: mapPhrases(DEFAULT_PHRASES[locale].map((p) => ({ ...p, part: 1 }))) });
  }
}
