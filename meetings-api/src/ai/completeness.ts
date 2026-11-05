/**
 * The gap and repetition detector (specs/021-meetings plan.md § Amendment 2026-11-05 #2, H-3; AC-6.7, AC-6.11,
 * AC-6.12, AC-6.13).
 *
 * WHY: Chirp 3 sometimes returns a part with a stretch of speech simply left out (T107: 19-45 % of the words of
 * 18-19 minute parts, 16-28 % of 3 of 19 parts at 10 minutes), and nothing in the reply says so. The only evidence is
 * the timeline: a stretch in which our own energy measure hears sound for at least the gap bound while no timed word
 * of the part falls in it.
 *
 * PURE and deterministic: words come in through the provider-neutral model (`words.ts`), the sound as a list of
 * SILENCES (the detector never sees audio). Not a speech detector: music and loud noise are "sound" too, which is
 * why a part may be retried or marked for a stretch nobody spoke in (the safe direction); two rules keep that from
 * becoming a flood:
 *   - hum and rumble are filtered before the silence list is made (speech band, `split.ts`);
 *   - the provider's own noise marker between two words declares the stretch non-speech (T107: a lone `[` for
 *     silence and for a 20 s tone). Residual, measured by T125: a marker inside real untranscribed speech would
 *     hide a gap; it was never observed.
 *
 * Nothing here is logged with content: callers log counts and durations only.
 */

import { normalizeToken, tokensOf, type Interval, type PartWords, type Token } from "./words";

/** A gap is a stretch with at least this much credited sound and no timed word (spec: the gap bound). */
export const GAP_BOUND_MS = 20_000;
/** An untimed word is text that exists somewhere in a hole: credited the time a word takes at 100 words/min, never more. */
export const UNTIMED_WORD_CREDIT_MS = 600;
/** Repeat bound (AC-6.13): this many consecutive equal words ... */
export const REPEAT_WORDS = 8;
/** ... and the later one starting no more than this long after the earlier one ended. */
export const REPEAT_GAP_MS = 2_000;
/** Candidate earlier passages examined per position: bounds adversarial input (8 000 equal words) without changing a real result. */
const MAX_CANDIDATES = 16;

// ─── Sound ───────────────────────────────────────────────────────────────────

/** The sound inside `[from, to]`: the complement of the silences, clipped. `silences` need not be sorted. */
export function soundIn(silences: readonly Interval[], from: number, to: number): Interval[] {
  if (to <= from) return [];
  const sorted = silences.filter((s) => s.endMs > from && s.startMs < to).sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [];
  let cursor = from;
  for (const silence of sorted) {
    if (silence.startMs > cursor) out.push({ startMs: cursor, endMs: Math.min(silence.startMs, to) });
    cursor = Math.max(cursor, silence.endMs);
    if (cursor >= to) break;
  }
  if (cursor < to) out.push({ startMs: cursor, endMs: to });
  return out.filter((s) => s.endMs > s.startMs);
}

const total = (intervals: readonly Interval[]): number => intervals.reduce((sum, i) => sum + (i.endMs - i.startMs), 0);

// ─── Gaps ────────────────────────────────────────────────────────────────────

/** A detected gap, in meeting time. `soundMs` and `untimedCreditMs` let the final pass subtract what a neighbour covers. */
export interface Gap extends Interval {
  readonly soundMs: number;
  readonly untimedCreditMs: number;
}

interface Hole {
  from: number;
  to: number;
  /** Provider-order word indexes strictly between which the hole lies. */
  lo: number;
  hi: number;
}

const isSpeech = (word: { noise: boolean; text: string }): boolean => !word.noise && normalizeToken(word.text) !== "";

/** Prefix counts over a part's words: untimed speech words and noise markers, for O(1) "between a and b". */
function prefixes(part: PartWords) {
  const n = part.words.length;
  const untimed = new Int32Array(n + 1);
  const noise = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    const word = part.words[i]!;
    untimed[i + 1] = untimed[i]! + (isSpeech(word) && word.span === null ? 1 : 0);
    noise[i + 1] = noise[i]! + (word.noise ? 1 : 0);
  }
  return { untimed, noise };
}

/** The holes of a part: between consecutive trusted speech words, and from the part's edges to its first and last. */
function holesOf(part: PartWords): Hole[] {
  const timed = part.words
    .map((word, index) => ({ word, index }))
    .filter(({ word }) => isSpeech(word) && word.span !== null)
    .sort((a, b) => a.word.span!.startMs - b.word.span!.startMs || a.index - b.index);
  const n = part.words.length;
  if (timed.length === 0) return [{ from: part.startMs, to: part.endMs, lo: -1, hi: n }];

  const holes: Hole[] = [];
  const first = timed[0]!;
  holes.push({ from: part.startMs, to: first.word.span!.startMs, lo: -1, hi: first.index });
  let frontier = first.word.span!.endMs;
  for (let i = 1; i < timed.length; i += 1) {
    const previous = timed[i - 1]!;
    const current = timed[i]!;
    holes.push({
      from: frontier,
      to: current.word.span!.startMs,
      lo: Math.min(previous.index, current.index),
      hi: Math.max(previous.index, current.index),
    });
    frontier = Math.max(frontier, current.word.span!.endMs);
  }
  holes.push({ from: frontier, to: part.endMs, lo: timed[timed.length - 1]!.index, hi: n });
  return holes.filter((h) => h.to > h.from);
}

/**
 * The stretches of a part with no trusted word, at least the gap bound long (H-2 J0): the text-and-time superset of
 * "affected by a detected gap". It needs no sound, so what it says depends only on the words returned.
 */
export function longHoles(part: PartWords): Interval[] {
  return holesOf(part)
    .filter((h) => h.to - h.from >= GAP_BOUND_MS)
    .map((h) => ({ startMs: h.from, endMs: h.to }));
}

/** A repetition of D1 (H-2): the tokens `[fromToken, toToken)` repeat an earlier passage and are to be removed. */
export interface Removal {
  readonly fromToken: number;
  readonly toToken: number;
}

export interface Assessment {
  readonly gaps: readonly Gap[];
  /** Total length of the gaps' ranges. */
  readonly gapMs: number;
  /** Holes with enough sound that the provider's noise marker declared non-speech (sizes only are ever logged). */
  readonly excused: number;
  readonly repetitions: readonly Removal[];
}

/** What one try of one part contains: its gaps (H-3) and its repetitions (D1). */
export function assess(part: PartWords, silences: readonly Interval[]): Assessment {
  const { untimed, noise } = prefixes(part);
  const gaps: Gap[] = [];
  let excused = 0;
  for (const hole of holesOf(part)) {
    if (hole.to - hole.from < GAP_BOUND_MS) continue;
    const sound = soundIn(silences, hole.from, hole.to);
    if (sound.length === 0) continue;
    const untimedWords = untimed[Math.max(hole.hi, 0)]! - untimed[hole.lo + 1]!;
    const soundMs = total(sound);
    const credit = untimedWords * UNTIMED_WORD_CREDIT_MS;
    if (soundMs - credit < GAP_BOUND_MS) continue;
    if (noise[Math.max(hole.hi, 0)]! - noise[hole.lo + 1]! > 0) {
      excused += 1;
      continue;
    }
    gaps.push({ startMs: sound[0]!.startMs, endMs: sound[sound.length - 1]!.endMs, soundMs, untimedCreditMs: credit });
  }
  return { gaps, gapMs: gaps.reduce((sum, g) => sum + (g.endMs - g.startMs), 0), excused, repetitions: findRepetitions(tokensOf(part.words)) };
}

/** Detectably incomplete (AC-6.11): at least one gap, or at least one repetition. */
export const isIncomplete = (a: Assessment): boolean => a.gaps.length > 0 || a.repetitions.length > 0;

/**
 * Does `candidate` beat `incumbent` (AC-6.11)? Fewest gaps, then least total gap time, then no repetition over
 * repetition; on a complete tie the earlier try stays (the incumbent is always the earlier one).
 */
export function isBetter(candidate: Assessment, incumbent: Assessment): boolean {
  if (candidate.gaps.length !== incumbent.gaps.length) return candidate.gaps.length < incumbent.gaps.length;
  if (candidate.gapMs !== incumbent.gapMs) return candidate.gapMs < incumbent.gapMs;
  const a = candidate.repetitions.length > 0;
  const b = incumbent.repetitions.length > 0;
  return a !== b ? !a : false;
}

// ─── Repetitions (D1) ────────────────────────────────────────────────────────

/**
 * Speech returned twice inside one part (AC-6.13, H-2 D1). A repetition is a later run B of at least `REPEAT_WORDS`
 * equal tokens that repeats an earlier, non-overlapping run A, where A's last token and B's first token both have a
 * trusted time and B starts no later than `REPEAT_GAP_MS` after A ended (a B that starts before A ended overlaps it).
 * An untimed boundary is no evidence: the passage stays as returned, which is also what keeps a phrase really said
 * twice, more than 2 s apart, intact. Deterministic: positions in order, an 8-gram index, for each B the earliest
 * matching A, the match extended to its maximal length. The first copy is kept, B's tokens are the removal.
 */
export function findRepetitions(tokens: readonly Token[]): Removal[] {
  const n = tokens.length;
  if (n < 2 * REPEAT_WORDS) return [];
  const gram = (at: number): string => {
    let key = tokens[at]!.norm;
    for (let k = 1; k < REPEAT_WORDS; k += 1) key += `\u0000${tokens[at + k]!.norm}`;
    return key;
  };
  const index = new Map<string, number[]>();
  const removals: Removal[] = [];
  let j = 0;
  let indexed = 0; // positions below this are in the index
  while (j + REPEAT_WORDS <= n) {
    // Only earlier positions whose whole gram precedes j can be an A for this B.
    while (indexed + REPEAT_WORDS <= j) {
      const key = gram(indexed);
      const list = index.get(key);
      if (list) list.push(indexed);
      else index.set(key, [indexed]);
      indexed += 1;
    }
    const first = tokens[j]!.span;
    let advanced = false;
    const candidates = first ? index.get(gram(j)) : undefined;
    if (first && candidates) {
      for (const i of candidates.slice(0, MAX_CANDIDATES)) {
        let length = 0;
        const cap = j - i; // the two runs must not overlap
        while (length < cap && j + length < n && tokens[i + length]!.norm === tokens[j + length]!.norm) length += 1;
        if (length < REPEAT_WORDS) continue;
        const last = tokens[i + length - 1]!.span;
        if (!last || first.startMs - last.endMs > REPEAT_GAP_MS) continue;
        removals.push({ fromToken: j, toToken: j + length });
        j += length;
        advanced = true;
        break;
      }
    }
    if (!advanced) j += 1;
  }
  return removals;
}

// ─── The gaps of the whole meeting (AC-6.12) ─────────────────────────────────

export interface ChosenPart {
  readonly words: PartWords;
  /** The gaps of the part's chosen try. */
  readonly gaps: readonly Gap[];
}

/** Ranges that touch or overlap are one range, whichever part they came from. Ascending. */
export function mergeRanges(ranges: readonly Interval[]): Interval[] {
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: { startMs: number; endMs: number }[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else out.push({ startMs: range.startMs, endMs: range.endMs });
  }
  return out;
}

/**
 * The gaps the stitched transcript still has (AC-6.12, H-3). Start from each part's chosen-try gaps; inside each,
 * subtract what the NEIGHBOUR part's version transcribed (its trusted words, counted only within the overlap of the
 * two parts), so a gap of part k that part k+1 covered is not reported; keep a remaining stretch only if its
 * credited sound still reaches the gap bound, ranged from its first sound to its last; then merge across parts.
 * The untimed credit of the original gap is spread over its stretches in proportion to their sound (where those
 * words sit is unknown). `silences` is the whole recording's list.
 */
export function finalGaps(parts: readonly ChosenPart[], silences: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (let k = 0; k < parts.length; k += 1) {
    const own = parts[k]!;
    const windows: { part: PartWords; window: Interval }[] = [];
    const before = parts[k - 1];
    if (before) windows.push({ part: before.words, window: { startMs: own.words.startMs, endMs: before.words.endMs } });
    const after = parts[k + 1];
    if (after) windows.push({ part: after.words, window: { startMs: after.words.startMs, endMs: own.words.endMs } });

    for (const gap of own.gaps) {
      const covered: Interval[] = [];
      for (const { part, window } of windows) {
        for (const word of part.words) {
          if (word.noise || word.span === null || normalizeToken(word.text) === "") continue;
          const from = Math.max(word.span.startMs, window.startMs, gap.startMs);
          const to = Math.min(word.span.endMs, window.endMs, gap.endMs);
          if (to > from) covered.push({ startMs: from, endMs: to });
        }
      }
      for (const stretch of uncovered(gap, mergeRanges(covered))) {
        const sound = soundIn(silences, stretch.startMs, stretch.endMs);
        if (sound.length === 0) continue;
        const soundMs = total(sound);
        const credit = gap.soundMs > 0 ? Math.round((gap.untimedCreditMs * soundMs) / gap.soundMs) : 0;
        if (soundMs - credit < GAP_BOUND_MS) continue;
        out.push({ startMs: sound[0]!.startMs, endMs: sound[sound.length - 1]!.endMs });
      }
    }
  }
  return mergeRanges(out);
}

/** `gap` minus the (merged, ascending) covered intervals. */
function uncovered(gap: Interval, covered: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let cursor = gap.startMs;
  for (const c of covered) {
    if (c.startMs > cursor) out.push({ startMs: cursor, endMs: c.startMs });
    cursor = Math.max(cursor, c.endMs);
  }
  if (cursor < gap.endMs) out.push({ startMs: cursor, endMs: gap.endMs });
  return out;
}
