/**
 * The provider-neutral word model of one transcript part, and the rules every transcript-quality step shares
 * (specs/021-meetings plan.md § Amendment 2026-11-05 #2, H-2 and H-3; AC-6.11 to AC-6.15, AC-6.17).
 *
 * Pure: no provider type, no audio, no import from `src/media`. A word carries only what the transcription returned
 * (text, a speaker label, a noise-marker flag and a TRUSTED time or none). That is the whole input of the
 * completeness detector (`completeness.ts`) and of the stitcher (`stitch.ts`); there is no field in which a
 * voice characteristic could travel (AC-6.17).
 */

/** A stretch of the recording in meeting time, in whole milliseconds. */
export interface Interval {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * One word as the provider returned it. `span` is the trusted `[start, end]` in MEETING time (the part's offset is
 * already added), or null when the provider's offsets for this word are not to be believed (G-3, `spanOf`).
 */
export interface SpeechWord {
  readonly text: string;
  /** The provider's label, namespaced by its part: `p2:1`. */
  readonly label: string;
  /** The provider's "no speech here" marker (a lone `[`, `[BACKGROUND]`): never a token. */
  readonly noise: boolean;
  readonly span: Interval | null;
}

/** One part's words in provider order, with the part's own span in meeting time. */
export interface PartWords {
  /** 1-based. */
  readonly part: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly words: readonly SpeechWord[];
}

/**
 * The comparison form of a word (AC-6.13): Unicode NFD, combining marks removed, lower case, every character that is
 * not a letter or a digit removed. Empty when nothing is left (a token that becomes empty is dropped).
 */
export function normalizeToken(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** A word that takes part in matching: not a noise marker and something is left after normalisation. */
export interface Token {
  /** Index of the word in `PartWords.words`. */
  readonly wordIndex: number;
  readonly norm: string;
  readonly label: string;
  readonly span: Interval | null;
}

export function tokensOf(words: readonly SpeechWord[]): Token[] {
  const tokens: Token[] = [];
  words.forEach((word, wordIndex) => {
    if (word.noise) return;
    const norm = normalizeToken(word.text);
    if (norm === "") return;
    tokens.push({ wordIndex, norm, label: word.label, span: word.span });
  });
  return tokens;
}

/**
 * Where a token is in time, for the rules that need a position for an untimed word (H-2): its own span when trusted,
 * else the interval from the end of the nearest earlier timed token to the start of the nearest later timed token of
 * the same part (the part's edges where there is none). Never a point and never outside the part.
 */
export function effectiveSpans(tokens: readonly Token[], part: Interval): Interval[] {
  const n = tokens.length;
  const before: (number | null)[] = new Array(n).fill(null);
  const after: (number | null)[] = new Array(n).fill(null);
  let last: number | null = null;
  for (let i = 0; i < n; i += 1) {
    before[i] = last;
    if (tokens[i]!.span) last = tokens[i]!.span!.endMs;
  }
  let next: number | null = null;
  for (let i = n - 1; i >= 0; i -= 1) {
    after[i] = next;
    if (tokens[i]!.span) next = tokens[i]!.span!.startMs;
  }
  return tokens.map((token, i) => {
    if (token.span) return token.span;
    const a = before[i] ?? part.startMs;
    const b = after[i] ?? part.endMs;
    let from = Math.max(part.startMs, Math.min(a, b));
    let to = Math.min(part.endMs, Math.max(a, b));
    if (to <= from) {
      to = Math.min(part.endMs, from + 1);
      if (to <= from) from = Math.max(part.startMs, to - 1);
    }
    return { startMs: from, endMs: to };
  });
}
