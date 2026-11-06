/**
 * Pure helpers of the Google spike's CONTENT-FREE report (T124, specs/021-meetings plan.md H-1 to H-4, H-10).
 *
 * The spike (`spike-google-speech.ts`) drives the real service on SYNTHETIC audio whose words are known: a
 * `--reference` file lists every utterance (speaker, start, end, text). This module aligns the transcript's words
 * to the reference's (an order-preserving, banded longest-common-subsequence) and derives numbers only: coverage,
 * missing and extra runs with their times, and which transcript key carried which reference speaker. Nothing here
 * prints or returns a word.
 */

import { normalizeToken } from "../src/ai/words";

export interface ReferenceUtterance {
  readonly speaker: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface Reference {
  readonly lang?: string;
  readonly speakers?: number;
  readonly durationMs?: number;
  readonly utterances: readonly ReferenceUtterance[];
}

/** One word of the reference with the time and speaker it was synthesised with (time interpolated in its utterance). */
export interface RefToken {
  readonly norm: string;
  readonly speaker: number;
  readonly startMs: number;
  readonly utterance: number;
}

export function referenceTokens(reference: Reference): RefToken[] {
  const out: RefToken[] = [];
  reference.utterances.forEach((u, utterance) => {
    const norms = u.text.split(/\s+/).map(normalizeToken).filter((t) => t !== "");
    norms.forEach((norm, i) => out.push({ norm, speaker: u.speaker, startMs: Math.round(u.startMs + ((u.endMs - u.startMs) * i) / Math.max(norms.length, 1)), utterance }));
  });
  return out;
}

export function isReference(value: unknown): value is Reference {
  if (typeof value !== "object" || value === null) return false;
  const list = (value as { utterances?: unknown }).utterances;
  return (
    Array.isArray(list) &&
    list.every((u) => typeof u === "object" && u !== null && typeof (u as ReferenceUtterance).text === "string" && Number.isFinite((u as ReferenceUtterance).startMs) && Number.isFinite((u as ReferenceUtterance).endMs))
  );
}

/**
 * Order-preserving alignment of `ref` to `hyp` (a longest common subsequence restricted to a diagonal band around the
 * proportional line, so 10 000 words cost about 10 MB). Returns, for every ref index, the matched hyp index or -1.
 * A drift larger than the band (a missing or repeated stretch longer than `band` words) degrades the result and is
 * reported by the caller as unmatched runs, never hidden.
 */
export function alignTokens(ref: readonly string[], hyp: readonly string[], band = 600): Int32Array {
  const n = ref.length;
  const m = hyp.length;
  const matched = new Int32Array(n).fill(-1);
  if (n === 0 || m === 0) return matched;
  const width = 2 * band + 1;
  const centre = (i: number): number => Math.round((i * m) / n);
  const dp = new Uint16Array((n + 1) * width);
  const at = (i: number, j: number): number => {
    const t = j - centre(i) + band;
    return j < 0 || t < 0 || t >= width ? 0 : dp[i * width + t]!;
  };
  for (let i = 1; i <= n; i += 1) {
    const lo = Math.max(1, centre(i) - band);
    const hi = Math.min(m, centre(i) + band);
    for (let j = lo; j <= hi; j += 1) {
      const value = ref[i - 1] === hyp[j - 1] ? at(i - 1, j - 1) + 1 : Math.max(at(i - 1, j), at(i, j - 1));
      dp[i * width + (j - centre(i) + band)] = value;
    }
  }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (ref[i - 1] === hyp[j - 1] && at(i, j) === at(i - 1, j - 1) + 1) {
      matched[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (at(i - 1, j) >= at(i, j - 1)) i -= 1;
    else j -= 1;
  }
  return matched;
}

export interface Run {
  readonly from: number;
  readonly to: number;
}

/** Maximal runs of at least `min` consecutive flagged positions: `[from, to)`. */
export function runsOf(flags: readonly boolean[], min: number): Run[] {
  const out: Run[] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i += 1) {
    const on = i < flags.length && flags[i] === true;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (i - start >= min) out.push({ from: start, to: i });
      start = -1;
    }
  }
  return out;
}

export interface Coverage {
  readonly refWords: number;
  readonly matched: number;
  readonly recall: number;
  /** Hypothesis words that matched nothing (mis-hearings, and words repeated or kept from a second version). */
  readonly extraWords: number;
  readonly hypWords: number;
  /** Runs of at least 8 unmatched reference words, in reference time. */
  readonly missingRuns: { readonly words: number; readonly startMs: number; readonly endMs: number }[];
  /** Runs of at least 8 unmatched hypothesis words (an unmatched run this long is leftover duplicated speech, or a long mis-hearing). */
  readonly extraRuns: number;
  /** For every reference token, the hyp index matched or -1. */
  readonly matchedRef: Int32Array;
}

export function coverage(ref: readonly RefToken[], hyp: readonly string[], band?: number): Coverage {
  const matchedRef = alignTokens(ref.map((t) => t.norm), hyp, band);
  const usedHyp = new Set<number>();
  for (const j of matchedRef) if (j >= 0) usedHyp.add(j);
  const matched = usedHyp.size;
  const missing = runsOf(Array.from(matchedRef, (j) => j < 0), 8).map((r) => ({
    words: r.to - r.from,
    startMs: ref[r.from]!.startMs,
    endMs: ref[r.to - 1]!.startMs,
  }));
  const extraFlags = hyp.map((_, j) => !usedHyp.has(j));
  return {
    refWords: ref.length,
    matched,
    recall: ref.length === 0 ? 1 : matched / ref.length,
    extraWords: hyp.length - matched,
    hypWords: hyp.length,
    missingRuns: missing,
    extraRuns: runsOf(extraFlags, 8).length,
    matchedRef,
  };
}

/**
 * Which transcript key carried which reference speaker, over the matched words: `table[key][speaker] = words`.
 * `impureKeys` counts keys with a second reference speaker above `minorShare` of the key's words (a join that put one
 * person's words under another's label looks like this); `splitSpeakers` counts reference speakers whose words are
 * spread over several keys each above `minorShare` (separate labels, or a part that was not joined).
 */
export interface SpeakerReport {
  readonly keys: number;
  readonly impureKeys: number;
  readonly splitSpeakers: number;
  readonly purity: number;
  readonly table: Record<string, Record<string, number>>;
}

export function speakerReport(ref: readonly RefToken[], matchedRef: Int32Array, hypKeys: readonly string[], minorShare = 0.05): SpeakerReport {
  const table: Record<string, Record<string, number>> = {};
  const perSpeaker: Record<string, Record<string, number>> = {};
  let total = 0;
  let agree = 0;
  ref.forEach((token, i) => {
    const j = matchedRef[i]!;
    if (j < 0) return;
    const key = hypKeys[j]!;
    const speaker = String(token.speaker);
    (table[key] ??= {})[speaker] = (table[key]?.[speaker] ?? 0) + 1;
    (perSpeaker[speaker] ??= {})[key] = (perSpeaker[speaker]?.[key] ?? 0) + 1;
    total += 1;
  });
  let impureKeys = 0;
  for (const row of Object.values(table)) {
    const sum = Object.values(row).reduce((a, b) => a + b, 0);
    const top = Math.max(...Object.values(row));
    agree += top;
    if (sum - top > minorShare * sum) impureKeys += 1;
  }
  let splitSpeakers = 0;
  for (const row of Object.values(perSpeaker)) {
    const sum = Object.values(row).reduce((a, b) => a + b, 0);
    if (Object.values(row).filter((v) => v > minorShare * sum).length > 1) splitSpeakers += 1;
  }
  return { keys: Object.keys(table).length, impureKeys, splitSpeakers, purity: total === 0 ? 1 : agree / total, table };
}
