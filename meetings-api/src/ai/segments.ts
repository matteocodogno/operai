/**
 * Provider phrases to transcript segments (specs/021-meetings AC-6.1, AC-6.2,
 * AC-6.7). Pure: no provider type leaks past `Phrase`, so a second transcriber
 * (the Voxtral fallback, ADR-0061) maps into the same shape.
 *
 * Speaker keys are `s1`, `s2`, ... by FIRST APPEARANCE in time order, so the
 * "Speaker n" a reader sees does not depend on the provider's own numbering
 * (a provider numbers its speakers in whatever order it likes; the Google adapter namespaces them per part, ADR-0070). One voice, or a
 * provider that did not diarize, gives one key.
 */

/** One recognised utterance as a provider reports it. `speaker` is the provider's own id, or null. */
export interface Phrase {
  readonly speaker: number | string | null;
  readonly startMs: number;
  readonly durationMs: number;
  readonly text: string;
  /** The transcript part the phrase comes from (1-based): carried to the segment (AC-6.16). Absent for a text meeting. */
  readonly part?: number | null;
}

/** A segment ready to be stored (`transcript_segment`), before ids and versions. */
export interface DraftSegment {
  readonly ordinal: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerKey: string;
  readonly text: string;
  /** 1-based transcript part (H-5); null/absent for a `text` meeting. */
  readonly part?: number | null;
}

export const speakerKeyOf = (index: number): string => `s${index}`;

/** `s3` -> 3; null for anything that is not a key this module produced. */
export function speakerIndexOf(key: string): number | null {
  const match = /^s([1-9]\d{0,2})$/.exec(key);
  return match ? Number(match[1]) : null;
}

const whole = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

/**
 * Time-ordered segments: empty phrases dropped, a stable sort by start (ties keep
 * the provider's order), ordinals from 0, speakers labelled by first appearance.
 * A phrase with no speaker joins the speaker before it (or the first voice).
 */
export function mapPhrases(phrases: readonly Phrase[]): DraftSegment[] {
  const usable = phrases
    .map((phrase, position) => ({ phrase, position, text: phrase.text.trim() }))
    .filter((entry) => entry.text !== "")
    .sort((a, b) => whole(a.phrase.startMs) - whole(b.phrase.startMs) || a.position - b.position);

  const keys = new Map<string, string>();
  let previous: string | null = null;
  return usable.map(({ phrase, text }, ordinal) => {
    const speakerKey = phrase.speaker === null ? (previous ?? keyFor(keys, "none")) : keyFor(keys, String(phrase.speaker));
    previous = speakerKey;
    const startMs = whole(phrase.startMs);
    return {
      ordinal,
      startMs,
      endMs: Math.max(startMs, startMs + whole(phrase.durationMs)),
      speakerKey,
      text,
      ...(phrase.part !== undefined && phrase.part !== null ? { part: phrase.part } : {}),
    };
  });
}

function keyFor(keys: Map<string, string>, id: string): string {
  let key = keys.get(id);
  if (key === undefined) {
    key = speakerKeyOf(keys.size + 1);
    keys.set(id, key);
  }
  return key;
}
