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
 */

import { mapPhrases, type DraftSegment, type Phrase } from "./segments";
import type { TranscribeContext, Transcriber, TranscriptionLocale, TranscriptionOutcome } from "./transcriber";

export interface TranscribeCall {
  readonly context: TranscribeContext | undefined;
  readonly audio: Blob;
  readonly locale: TranscriptionLocale;
  readonly maxSpeakers: number;
}

/** A scripted segments outcome may leave `partStartsMs` out: it is one part, `[0]`. */
type ScriptedOutcome = TranscriptionOutcome | { readonly kind: "segments"; readonly segments: readonly DraftSegment[]; readonly partStartsMs?: readonly number[] };
type Script = ScriptedOutcome | Error | ((call: TranscribeCall) => ScriptedOutcome | Promise<ScriptedOutcome>);

const complete = (outcome: ScriptedOutcome): TranscriptionOutcome =>
  outcome.kind === "segments" ? { kind: "segments", segments: outcome.segments, partStartsMs: outcome.partStartsMs ?? [0] } : outcome;

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
    return { kind: "segments", segments: mapPhrases(DEFAULT_PHRASES[locale]), partStartsMs: [0] };
  }
}
