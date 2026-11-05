/**
 * Stitching the parts of one transcript (specs/021-meetings plan.md § Amendment 2026-11-05 #2, H-2; AC-6.2,
 * AC-6.13, AC-6.14, AC-6.15, AC-6.17).
 *
 * A long recording is transcribed in OVERLAPPING parts, each with its own speaker numbering. This module turns the
 * chosen words of every part into one list of phrases:
 *
 *   D1  inside a part, speech returned twice is kept once (`findRepetitions`);
 *   D2  inside the overlap of parts k and k+1, speech returned by both is kept once (part k's version), by an
 *       order-preserving alignment of runs of at least `REPEAT_WORDS` equal words; everything found in only one of
 *       the two versions is KEPT, so no speech present in either version is dropped;
 *   J   a label of part k+1 is JOINED to a label of part k only on the evidence of the aligned words: at least
 *       `MATCH_WORDS` of them, all to the same earlier label, with no rival either way. Anything else stays
 *       separate. Nothing else - position, number, order, a default - ever joins.
 *
 * AC-6.17: the whole decision is a pure function of the words, labels and times the transcription returned. The
 * input type has no field for anything else and this file imports nothing that could supply it (a static test in
 * stitch.test.ts reads this source). No voice characteristic exists anywhere in the pipeline. Deterministic: no
 * randomness, no clock, no locale-dependent comparison, every sort has a total order.
 *
 * Nothing here is logged with content; `StitchStats` carries counts only.
 */

import { REPEAT_GAP_MS, REPEAT_WORDS, findRepetitions, longHoles } from "./completeness";
import type { Phrase } from "./segments";
import { effectiveSpans, tokensOf, type Interval, type PartWords, type Token } from "./words";

/** Match bound (AC-6.14): matched words a later label needs to be joined. */
export const MATCH_WORDS = 20;
/** Same-gram candidates examined per position (bounds repetitive input; a real overlap has a handful). */
const MAX_SEEDS_PER_GRAM = 16;

export interface StitchInput {
  /** Every part's chosen words, in order; `part` is 1-based and consecutive parts overlap. */
  readonly parts: readonly PartWords[];
  /** The final gaps of the meeting (AC-6.12): a segment never spans one. Meeting time, merged, ascending. */
  readonly gaps: readonly Interval[];
}

export interface StitchStats {
  readonly removedWithinPart: number;
  readonly removedInOverlap: number;
  readonly joined: number;
  /** Labels of later parts that stayed separate. */
  readonly separate: number;
}

export interface StitchResult {
  readonly phrases: Phrase[];
  readonly stats: StitchStats;
}

interface Item {
  readonly part: number;
  readonly text: string;
  readonly label: string;
  readonly norm: string;
  readonly span: Interval | null;
  readonly eff: Interval;
}

interface Anchor {
  readonly p: number;
  readonly q: number;
  readonly length: number;
}

const itemsOf = (part: PartWords): Item[] => {
  const tokens = tokensOf(part.words);
  const eff = effectiveSpans(tokens, part);
  const removed = new Set<number>();
  for (const r of findRepetitions(tokens)) for (let i = r.fromToken; i < r.toToken; i += 1) removed.add(i);
  const out: Item[] = [];
  tokens.forEach((token: Token, i) => {
    if (removed.has(i)) return;
    out.push({ part: part.part, text: part.words[token.wordIndex]!.text, label: token.label, norm: token.norm, span: token.span, eff: eff[i]! });
  });
  return out;
};

const removedWithin = (part: PartWords): number => {
  let n = 0;
  for (const r of findRepetitions(tokensOf(part.words))) n += r.toToken - r.fromToken;
  return n;
};

/** D2: the order-preserving alignment of P and Q (both in token order). */
function align(p: readonly Item[], q: readonly Item[]): Anchor[] {
  if (p.length < REPEAT_WORDS || q.length < REPEAT_WORDS) return [];
  const gramOf = (items: readonly Item[], at: number): string => {
    let key = items[at]!.norm;
    for (let k = 1; k < REPEAT_WORDS; k += 1) key += `\u0000${items[at + k]!.norm}`;
    return key;
  };
  const index = new Map<string, number[]>();
  for (let j = 0; j + REPEAT_WORDS <= q.length; j += 1) {
    const key = gramOf(q, j);
    const list = index.get(key);
    if (list) list.push(j);
    else index.set(key, [j]);
  }
  const near = (a: Interval, b: Interval): boolean => b.startMs - a.endMs <= REPEAT_GAP_MS && a.startMs - b.endMs <= REPEAT_GAP_MS;

  const candidates: (Anchor & { distance: number })[] = [];
  for (let i = 0; i + REPEAT_WORDS <= p.length; i += 1) {
    const seeds = index.get(gramOf(p, i));
    if (!seeds) continue;
    for (const j of seeds.slice(0, MAX_SEEDS_PER_GRAM)) {
      // Maximal runs only: a run that continues an earlier one on its diagonal is not a candidate of its own.
      if (i > 0 && j > 0 && p[i - 1]!.norm === q[j - 1]!.norm) continue;
      let length = REPEAT_WORDS;
      while (i + length < p.length && j + length < q.length && p[i + length]!.norm === q[j + length]!.norm) length += 1;
      const pRange = { startMs: p[i]!.eff.startMs, endMs: p[i + length - 1]!.eff.endMs };
      const qRange = { startMs: q[j]!.eff.startMs, endMs: q[j + length - 1]!.eff.endMs };
      if (!near(pRange, qRange)) continue;
      const distance = Math.abs((pRange.startMs + pRange.endMs) / 2 - (qRange.startMs + qRange.endMs) / 2);
      candidates.push({ p: i, q: j, length, distance });
    }
  }
  candidates.sort((a, b) => b.length - a.length || a.distance - b.distance || a.p - b.p || a.q - b.q);

  const accepted: Anchor[] = [];
  for (const c of candidates) {
    const fits = accepted.every((a) => (c.p + c.length <= a.p && c.q + c.length <= a.q) || (a.p + a.length <= c.p && a.q + a.length <= c.q));
    if (fits) accepted.push({ p: c.p, q: c.q, length: c.length });
  }
  return accepted.sort((a, b) => a.p - b.p);
}

/** Two sequences merged by effective start time, the first sequence's item first on a tie. Each stays in order. */
function mergeByStart(first: readonly Item[], second: readonly Item[]): Item[] {
  const out: Item[] = [];
  let a = 0;
  let b = 0;
  while (a < first.length || b < second.length) {
    if (b >= second.length || (a < first.length && first[a]!.eff.startMs <= second[b]!.eff.startMs)) out.push(first[a++]!);
    else out.push(second[b++]!);
  }
  return out;
}

const intersects = (a: Interval, b: Interval): boolean => a.startMs < b.endMs && a.endMs > b.startMs;

export function stitch(input: StitchInput): StitchResult {
  const parts = input.parts;
  const items = parts.map(itemsOf);

  // The overlap zones: a suffix of part k and a prefix of part k+1, contiguous in token order.
  const suffixStart = parts.map((_, k) => {
    const next = parts[k + 1];
    if (!next) return items[k]!.length;
    const at = items[k]!.findIndex((it) => it.eff.endMs >= next.startMs - REPEAT_GAP_MS);
    return at === -1 ? items[k]!.length : at;
  });
  const prefixEnd = parts.map((_, k) => {
    const before = parts[k - 1];
    if (!before) return 0;
    let last = -1;
    items[k]!.forEach((it, i) => {
      if (it.eff.startMs <= before.endMs + REPEAT_GAP_MS) last = i;
    });
    return last + 1;
  });
  // A short part must not give the same token to both of its zones.
  for (let k = 0; k < parts.length; k += 1) suffixStart[k] = Math.max(suffixStart[k]!, prefixEnd[k]!);

  const join = new Map<string, string>();
  const rootOf = (label: string): string => {
    let at = label;
    for (let guard = 0; join.has(at) && guard < parts.length + 1; guard += 1) at = join.get(at)!;
    return at;
  };

  const sequence: Item[] = [];
  let removedInOverlap = 0;
  let joined = 0;
  let separate = 0;
  for (let k = 0; k < parts.length; k += 1) {
    sequence.push(...items[k]!.slice(prefixEnd[k]!, suffixStart[k]!));
    const nextPart = parts[k + 1];
    if (!nextPart) continue;

    const p = items[k]!.slice(suffixStart[k]!);
    const q = items[k + 1]!.slice(0, prefixEnd[k + 1]!);
    const anchors = align(p, q);

    // The merged overlap: anchored words once (part k's version), the rest of both versions in time order.
    let pi = 0;
    let qi = 0;
    for (const anchor of anchors) {
      sequence.push(...mergeByStart(p.slice(pi, anchor.p), q.slice(qi, anchor.q)));
      sequence.push(...p.slice(anchor.p, anchor.p + anchor.length));
      removedInOverlap += anchor.length;
      pi = anchor.p + anchor.length;
      qi = anchor.q + anchor.length;
    }
    sequence.push(...mergeByStart(p.slice(pi), q.slice(qi)));

    // J: who is who, from the aligned words only.
    const window = { startMs: nextPart.startMs, endMs: parts[k]!.endMs };
    const blocked = [longHoles(parts[k]!), longHoles(nextPart)].some((holes) => holes.some((h) => intersects(h, window)));
    const matched = new Map<string, Map<string, number>>(); // L2 -> L1 -> words
    for (const anchor of anchors) {
      for (let t = 0; t < anchor.length; t += 1) {
        const l1 = p[anchor.p + t]!.label;
        const l2 = q[anchor.q + t]!.label;
        const row = matched.get(l2) ?? new Map<string, number>();
        row.set(l1, (row.get(l1) ?? 0) + 1);
        matched.set(l2, row);
      }
    }
    const labels = new Set(items[k + 1]!.map((it) => it.label));
    for (const l2 of [...labels].sort()) {
      const row = matched.get(l2);
      const verdict = (() => {
        if (blocked || !row) return null;
        const words = [...row.values()].reduce((a, b) => a + b, 0);
        if (words < MATCH_WORDS || row.size !== 1) return null; // (a), (b)
        const l1 = [...row.keys()][0]!;
        for (const [other, rivals] of matched) if (other !== l2 && rivals.has(l1)) return null; // (c)
        return l1;
      })();
      if (verdict === null) separate += 1;
      else {
        join.set(l2, verdict);
        joined += 1;
      }
    }
  }

  // Segments: consecutive words of one root in one part, never across a gap.
  const separated = (a: Item, b: Item): boolean => input.gaps.some((g) => a.eff.startMs < g.startMs && g.startMs <= b.eff.startMs);
  const phrases: Phrase[] = [];
  let run: Item[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const startMs = Math.min(...run.map((it) => it.eff.startMs));
    const ends = run.filter((it) => it.span !== null).map((it) => it.span!.endMs);
    const endMs = ends.length > 0 ? Math.max(startMs, ...ends) : startMs;
    phrases.push({ speaker: rootOf(run[0]!.label), startMs, durationMs: endMs - startMs, text: run.map((it) => it.text).join(" "), part: run[0]!.part });
    run = [];
  };
  for (const item of sequence) {
    const last = run[run.length - 1];
    if (last && (rootOf(last.label) !== rootOf(item.label) || last.part !== item.part || separated(last, item))) flush();
    run.push(item);
  }
  flush();

  return {
    phrases,
    stats: { removedWithinPart: parts.reduce((sum, part) => sum + removedWithin(part), 0), removedInOverlap, joined, separate },
  };
}
