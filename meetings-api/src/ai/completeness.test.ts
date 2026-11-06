import { describe, expect, it } from "bun:test";
import { GAP_BOUND_MS, assess, finalGaps, findRepetitions, isBetter, isIncomplete, mergeRanges, soundIn, type Assessment, type Gap } from "./completeness";
import { tokensOf, type PartWords, type SpeechWord } from "./words";

// AC-6.7, AC-6.11, AC-6.12, AC-6.13 (H-3 detector, D1 detection, ranking, final gaps). Rows of plan H-10.

const S = (seconds: number) => Math.round(seconds * 1000);
const word = (text: string, at: [number, number] | null = null, extra: Partial<SpeechWord> = {}): SpeechWord => ({
  text,
  label: "p1:1",
  noise: false,
  span: at ? { startMs: S(at[0]), endMs: S(at[1]) } : null,
  ...extra,
});
const marker = (): SpeechWord => ({ text: "[", label: "p1:0", noise: true, span: null });
const part = (words: SpeechWord[], from = 0, to = 100, number = 1): PartWords => ({ part: number, startMs: S(from), endMs: S(to), words });
const silence = (a: number, b: number) => ({ startMs: S(a), endMs: S(b) });
const NO_SILENCE: { startMs: number; endMs: number }[] = [];

describe("soundIn", () => {
  it("is the complement of the silences inside the span", () => {
    expect(soundIn([silence(2, 4), silence(8, 20)], S(0), S(10))).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 4000, endMs: 8000 },
    ]);
  });
  it("is the whole span with no silence and nothing for an empty span", () => {
    expect(soundIn([], 0, 5000)).toEqual([{ startMs: 0, endMs: 5000 }]);
    expect(soundIn([], 5000, 5000)).toEqual([]);
    expect(soundIn([silence(0, 10)], 0, 5000)).toEqual([]);
  });
  it("does not need sorted silences", () => {
    expect(soundIn([silence(8, 9), silence(2, 3)], 0, S(10))).toHaveLength(3);
  });
});

describe("gaps (AC-6.11, AC-6.12, H-3)", () => {
  it("a stretch of at least the gap bound with sound and no timed word is a gap, ranged by its sound", () => {
    const words = [word("ciao", [0, 1]), word("dopo", [60, 61])];
    const result = assess(part(words, 0, 61), [silence(1, 5), silence(50, 60)]);
    // sound in the hole 1-60 s: 5-50 s = 45 s
    expect(result.gaps).toEqual([{ startMs: S(5), endMs: S(50), soundMs: S(45), untimedCreditMs: 0 }]);
    expect(result.gapMs).toBe(S(45));
  });

  it("the bound is the credited sound: 19.9 s of sound is not a gap, 20 s is", () => {
    const words = [word("a", [0, 1]), word("b", [60, 61])];
    expect(assess(part(words, 0, 61), [silence(1, 40.1), silence(60, 70)]).gaps).toHaveLength(0);
    expect(assess(part(words, 0, 61), [silence(1, 40), silence(60, 70)]).gaps).toHaveLength(1);
    expect(GAP_BOUND_MS).toBe(20_000);
  });

  it("a stretch of silence is not a gap however long (no sound)", () => {
    const words = [word("a", [0, 1]), word("b", [90, 91])];
    expect(assess(part(words, 0, 91), [silence(1, 90)]).gaps).toHaveLength(0);
  });

  it("credits 600 ms of sound to every untimed word between the bounding words", () => {
    // 21 s of sound in the hole: three untimed words take 1.8 s and leave 19.2 s; one leaves 20.4 s
    const withThree = [word("a", [0, 1]), word("x"), word("y"), word("z"), word("b", [22, 23])];
    const withOne = [word("a", [0, 1]), word("x"), word("b", [22, 23])];
    expect(assess(part(withThree, 0, 23), NO_SILENCE).gaps).toHaveLength(0);
    const one = assess(part(withOne, 0, 23), NO_SILENCE).gaps;
    expect(one).toHaveLength(1);
    expect(one[0]!.untimedCreditMs).toBe(600);
  });

  it("an untimed word elsewhere in the part credits nothing", () => {
    const words = [word("a", [0, 1]), word("b", [22, 23]), word("x"), word("y"), word("z")];
    expect(assess(part(words, 0, 23), NO_SILENCE).gaps).toHaveLength(1);
  });

  it("a lone '[' between the bounding words declares the stretch non-speech (T107)", () => {
    const words = [word("a", [0, 1]), marker(), word("b", [60, 61])];
    const result = assess(part(words, 0, 61), NO_SILENCE);
    expect(result.gaps).toHaveLength(0);
    expect(result.excused).toBe(1);
    // the same stretch without the marker is a gap
    expect(assess(part([word("a", [0, 1]), word("b", [60, 61])], 0, 61), NO_SILENCE).gaps.length).toBeGreaterThan(0);
  });

  it("a marker in another hole excuses only its own", () => {
    const words = [word("a", [0, 1]), marker(), word("b", [30, 31]), word("c", [70, 71])];
    const result = assess(part(words, 0, 71), NO_SILENCE);
    expect(result.excused).toBe(1);
    expect(result.gaps.map((g) => [g.startMs, g.endMs])).toEqual([[S(31), S(70)]]);
  });

  it("the part's edges are holes too: before the first word and after the last", () => {
    const words = [word("a", [40, 41])];
    const result = assess(part(words, 0, 100), NO_SILENCE);
    expect(result.gaps.map((g) => [g.startMs, g.endMs])).toEqual([
      [0, S(40)],
      [S(41), S(100)],
    ]);
  });

  it("a part with no timed word is one hole; markers only is non-speech, nothing at all with sound is a gap", () => {
    expect(assess(part([marker(), marker()], 0, 60), NO_SILENCE).gaps).toHaveLength(0);
    expect(assess(part([marker()], 0, 60), NO_SILENCE).excused).toBe(1);
    expect(assess(part([], 0, 60), NO_SILENCE).gaps.map((g) => [g.startMs, g.endMs])).toEqual([[0, S(60)]]);
    expect(assess(part([], 0, 60), [silence(0, 60)]).gaps).toHaveLength(0);
    // untimed words only: their credit is 600 ms each
    const untimed = Array.from({ length: 10 }, () => word("parola"));
    expect(assess(part(untimed, 0, 24), NO_SILENCE).gaps).toHaveLength(0); // 24 - 6 = 18 s
    expect(assess(part(untimed, 0, 27), NO_SILENCE).gaps).toHaveLength(1); // 27 - 6 = 21 s
  });

  it("words overlapping in time leave no hole between them", () => {
    const words = [word("a", [0, 50]), word("b", [10, 20]), word("c", [49, 60])];
    expect(assess(part(words, 0, 60), NO_SILENCE).gaps).toHaveLength(0);
  });

  it("detectably incomplete means a gap, and only a gap (A8: a repetition is removed by the stitcher, never a reason to retry)", () => {
    const clean = assess(part([word("a", [0, 1])], 0, 5), NO_SILENCE);
    expect(isIncomplete(clean)).toBe(false);
    expect(isIncomplete(assess(part([word("a", [0, 1])], 0, 60), NO_SILENCE))).toBe(true);
  });
});

describe("repetitions (AC-6.13, D1)", () => {
  const phrase = "il budget del prossimo trimestre va rivisto subito";
  // 8 words, 300 ms each, starting at `from`
  const say = (text: string, from: number): SpeechWord[] => text.split(" ").map((t, i) => word(t, [from + i * 0.3, from + i * 0.3 + 0.25]));
  const found = (words: SpeechWord[]) => findRepetitions(tokensOf(words));

  it("8 equal words returned again 1.5 s after the first ended: removed, the first kept", () => {
    // first copy 0-2.4 s; second starts at 3.9 s
    const words = [...say(phrase, 0), ...say(phrase, 3.9)];
    expect(found(words)).toEqual([{ fromToken: 8, toToken: 16 }]);
  });

  it("the same 2.5 s apart is a phrase really said twice: kept", () => {
    expect(found([...say(phrase, 0), ...say(phrase, 4.9)])).toEqual([]);
  });

  it("exactly 2 s apart is within the repeat bound", () => {
    // first ends at 0.3*7+0.25 = 2.35 s; the second starts at 4.35 s
    expect(found([...say(phrase, 0), ...say(phrase, 4.35)])).toHaveLength(1);
  });

  it("only 7 equal words: kept", () => {
    const seven = "il budget del prossimo trimestre va rivisto";
    expect(found([...say(seven, 0), ...say(seven, 3)])).toEqual([]);
  });

  it("matches ignoring case, accents and punctuation", () => {
    const first = say(phrase, 0);
    const second = say("Il Budget, del prossimo trimestre va rivisto: subito!", 3.9);
    expect(found([...first, ...second])).toHaveLength(1);
  });

  it("the runs' times overlap (the repeat starts before the first ended): removed", () => {
    expect(found([...say(phrase, 0), ...say(phrase, 1)])).toHaveLength(1);
  });

  it("an untimed boundary token is no evidence: left as returned", () => {
    const first = say(phrase, 0);
    const second = say(phrase, 3.9);
    const untimedStart = [...first, { ...second[0]!, span: null }, ...second.slice(1)];
    expect(found(untimedStart)).toEqual([]);
    const untimedEnd = [...first.slice(0, 7), { ...first[7]!, span: null }, ...second];
    expect(found(untimedEnd)).toEqual([]);
  });

  it("extends to the maximal length", () => {
    const longer = `${phrase} e poi ne parliamo ancora`;
    const result = found([...say(longer, 0), ...say(longer, 5)]);
    expect(result).toEqual([{ fromToken: 13, toToken: 26 }]);
  });

  it("each later copy of a stutter is a repetition of the first; the runs never overlap in the word sequence", () => {
    const result = found([...say(phrase, 0), ...say(phrase, 3), ...say(phrase, 6)]);
    expect(result).toEqual([
      { fromToken: 8, toToken: 16 },
      { fromToken: 16, toToken: 24 },
    ]);
  });

  it("is quick on adversarial input: 8 000 equal words", () => {
    const words = Array.from({ length: 8_000 }, (_, i) => word("sì", [i * 0.1, i * 0.1 + 0.05]));
    const started = performance.now();
    findRepetitions(tokensOf(words));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("a repetition is reported but does NOT make the try detectably incomplete (A8)", () => {
    const repeated = assess(part([...say(phrase, 0), ...say(phrase, 3.9)], 0, 10), NO_SILENCE);
    expect(repeated.repetitions).toHaveLength(1);
    expect(repeated.gaps).toHaveLength(0);
    expect(isIncomplete(repeated)).toBe(false);
  });

  // A8 rule 2: the same speaker label, or at least one passage without a label.
  const said = (text: string, from: number, label: string, unlabelled = false) =>
    say(text, from).map((w) => ({ ...w, label, ...(unlabelled ? { unlabelled: true } : {}) }));

  it("equal words in time but under two different speaker labels are two speakers saying the same thing: kept", () => {
    expect(found([...said(phrase, 0, "p1:1"), ...said(phrase, 3.9, "p1:2")])).toEqual([]);
    expect(found([...said(phrase, 0, "p1:1"), ...said(phrase, 1, "p1:2")])).toEqual([]);
  });

  it("the same label, or no label on either side, is the same speaker's repetition: removed", () => {
    expect(found([...said(phrase, 0, "p1:1"), ...said(phrase, 3.9, "p1:1")])).toHaveLength(1);
    expect(found([...said(phrase, 0, "p1:1"), ...said(phrase, 3.9, "p1:0", true)])).toHaveLength(1);
    expect(found([...said(phrase, 0, "p1:0", true), ...said(phrase, 3.9, "p1:2")])).toHaveLength(1);
  });

  it("a label that changes in the middle of the second copy ends the match there: under 8 words stay", () => {
    const second = said(phrase, 3.9, "p1:1").map((w, i) => (i >= 6 ? { ...w, label: "p1:2" } : w));
    expect(found([...said(phrase, 0, "p1:1"), ...second])).toEqual([]);
  });
});

describe("a repeated tail of untimed words (A8 rule 2)", () => {
  const sentence = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);
  /** `texts` timed one per second from `from`. */
  const timed = (texts: string[], from: number, label = "p1:1") => texts.map((t, i) => word(t, [from + i, from + i + 0.5], { label }));
  const untimed = (texts: string[], label = "p1:1", extra: Partial<SpeechWord> = {}) => texts.map((t) => word(t, null, { label, ...extra }));
  const found = (words: SpeechWord[]) => findRepetitions(tokensOf(words));

  it("an untimed run at the end that repeats earlier text is dropped by content, however far apart", () => {
    const earlier = sentence(20);
    const words = [...timed(earlier, 0), ...timed(["zz1", "zz2"], 500), ...untimed(earlier.slice(4, 16))];
    expect(found(words)).toEqual([{ fromToken: 22, toToken: 34 }]);
  });

  it("speech present in only one version is kept: new words around the match stay", () => {
    const earlier = sentence(20);
    const words = [...timed(earlier, 0), ...untimed(["novel1", "novel2", ...earlier.slice(4, 14), "novel3"])];
    // tokens: 20 timed, then novel1 novel2 [10 matched] novel3
    expect(found(words)).toEqual([{ fromToken: 22, toToken: 32 }]);
  });

  it("fewer than 8 consecutive equal words stay", () => {
    const earlier = sentence(20);
    expect(found([...timed(earlier, 0), ...untimed(earlier.slice(4, 11))])).toEqual([]);
  });

  it("only a run at the very END of the part: untimed words followed by a timed word are not a tail", () => {
    const earlier = sentence(20);
    expect(found([...timed(earlier, 0), ...untimed(earlier.slice(4, 16)), ...timed(["last"], 600)])).toEqual([]);
  });

  it("the same speaker label, or no label on either side; a different label keeps the words", () => {
    const earlier = sentence(20);
    const copy = earlier.slice(4, 16);
    expect(found([...timed(earlier, 0), ...untimed(copy, "p1:2")])).toEqual([]);
    expect(found([...timed(earlier, 0), ...untimed(copy, "p1:0", { unlabelled: true })])).toHaveLength(1);
    expect(found([...timed(earlier, 0).map((w) => ({ ...w, label: "p1:0", unlabelled: true })), ...untimed(copy, "p1:2")])).toHaveLength(1);
  });

  it("a tail that repeats nothing is kept", () => {
    const earlier = sentence(20);
    expect(found([...timed(earlier, 0), ...untimed(sentence(12).map((t) => `x${t}`))])).toEqual([]);
  });

  it("does not remove the same tokens twice when the timed rule already took them", () => {
    const earlier = sentence(20);
    const words = [...timed(earlier, 0), ...timed(earlier.slice(0, 10), 20.5), ...untimed(earlier.slice(10, 20))];
    const removed = found(words).reduce((n, r) => n + (r.toToken - r.fromToken), 0);
    expect(removed).toBeLessThanOrEqual(20);
    const covered = new Set<number>();
    for (const r of found(words)) for (let i = r.fromToken; i < r.toToken; i += 1) expect(covered.has(i)).toBe(false), covered.add(i);
  });
});

describe("ranking tries (AC-6.11)", () => {
  const gap = (a: number, b: number): Gap => ({ startMs: S(a), endMs: S(b), soundMs: S(b - a), untimedCreditMs: 0 });
  const attempt = (gaps: Gap[], repeated = false): Assessment => ({
    gaps,
    gapMs: gaps.reduce((sum, g) => sum + (g.endMs - g.startMs), 0),
    excused: 0,
    repetitions: repeated ? [{ fromToken: 0, toToken: 8 }] : [],
  });

  it("fewest gaps wins, even with more gap time", () => {
    expect(isBetter(attempt([gap(0, 100)]), attempt([gap(0, 25), gap(50, 75)]))).toBe(true);
    expect(isBetter(attempt([gap(0, 25), gap(50, 75)]), attempt([gap(0, 100)]))).toBe(false);
  });
  it("then the least total gap time", () => {
    expect(isBetter(attempt([gap(0, 30)]), attempt([gap(0, 40)]))).toBe(true);
    expect(isBetter(attempt([gap(0, 40)]), attempt([gap(0, 30)]))).toBe(false);
  });
  it("a repetition never ranks a try (A8): the same gaps are a tie, whichever has it", () => {
    expect(isBetter(attempt([gap(0, 30)]), attempt([gap(0, 30)], true))).toBe(false);
    expect(isBetter(attempt([gap(0, 30)], true), attempt([gap(0, 30)]))).toBe(false);
  });
  it("a complete tie keeps the earlier try (the candidate is never better)", () => {
    expect(isBetter(attempt([gap(0, 30)], true), attempt([gap(0, 30)], true))).toBe(false);
    expect(isBetter(attempt([]), attempt([]))).toBe(false);
  });
  it("a gap-free repeating try beats a gapped clean one", () => {
    expect(isBetter(attempt([], true), attempt([gap(0, 30)]))).toBe(true);
  });
});

describe("the gaps of the whole meeting (AC-6.12, H-3)", () => {
  const gapOf = (a: number, b: number, credit = 0): Gap => ({ startMs: S(a), endMs: S(b), soundMs: S(b - a), untimedCreditMs: credit });

  // part 1 = [0, 600], part 2 = [510, 1110]; overlap [510, 600]
  const p1 = (words: SpeechWord[]) => part(words, 0, 600, 1);
  const p2 = (words: SpeechWord[]) => part(words, 510, 1110, 2);

  it("a gap of part 1 that part 2 transcribed is not reported", () => {
    const first = p1([word("a", [0, 1]), word("b", [560, 561]), word("fine", [599, 600])]);
    const second = p2([word("x", [510, 530]), word("y", [530, 560]), word("z", [560, 600]), word("w", [601, 602])]);
    // the gap 1-560 of part 1; part 2's words cover 510-600 only inside the overlap, leaving 1-510 = 509 s
    const result = finalGaps([{ words: first, gaps: [gapOf(1, 560)] }, { words: second, gaps: [] }], NO_SILENCE);
    expect(result).toEqual([{ startMs: S(1), endMs: S(510) }]);
  });

  it("a gap entirely inside the neighbour's coverage is dropped", () => {
    const first = p1([word("a", [0, 1]), word("b", [590, 591])]);
    const second = p2([word("x", [515, 595])]);
    expect(finalGaps([{ words: first, gaps: [gapOf(520, 590)] }, { words: second, gaps: [] }], NO_SILENCE)).toEqual([]);
  });

  it("the neighbour's words count only inside the overlap", () => {
    // part 2 returns a word at 400 s (garbled: before its own start): it covers nothing
    const first = p1([word("a", [0, 1]), word("b", [590, 591])]);
    const second = p2([word("stray", [400, 480]), word("x", [515, 516])]);
    const result = finalGaps([{ words: first, gaps: [gapOf(1, 590)] }, { words: second, gaps: [] }], NO_SILENCE);
    expect(result).toEqual([
      { startMs: S(1), endMs: S(515) },
      { startMs: S(516), endMs: S(590) },
    ]);
  });

  it("a stretch left uncovered shorter than the gap bound is dropped", () => {
    const first = p1([word("a", [0, 1]), word("b", [595, 596])]);
    const second = p2([word("x", [515, 590])]);
    // 1-515 stays; 590-595 is only 5 s left after the neighbour: dropped
    const result = finalGaps([{ words: first, gaps: [gapOf(1, 595)] }, { words: second, gaps: [] }], NO_SILENCE);
    expect(result).toEqual([{ startMs: S(1), endMs: S(515) }]);
  });

  it("the sound inside the uncovered stretch decides, and its range is first sound to last sound", () => {
    const first = p1([word("a", [0, 1]), word("b", [590, 591])]);
    const second = p2([word("x", [515, 590])]);
    const result = finalGaps([{ words: first, gaps: [gapOf(1, 590)] }, { words: second, gaps: [] }], [silence(1, 100), silence(480, 515)]);
    expect(result).toEqual([{ startMs: S(100), endMs: S(480) }]);
  });

  it("merges ranges that overlap across a part boundary into one", () => {
    // part 1 ends in a gap 401-600; part 2 begins with a gap 510-700: neither neighbour has a word in the overlap
    const first = p1([word("a", [0, 1]), word("b", [400, 401])]);
    const second = p2([word("d", [700, 701])]);
    const result = finalGaps([{ words: first, gaps: [gapOf(401, 600)] }, { words: second, gaps: [gapOf(510, 700)] }], NO_SILENCE);
    expect(result).toEqual([{ startMs: S(401), endMs: S(700) }]);
  });

  it("spreads the untimed credit over what is left in proportion to its sound", () => {
    // gap 1-61 (60 s) with 40 untimed words = 24 s credit; the neighbour covers 31-61, so 1-31 keeps 30 s - 12 s = 18 s
    const first = p1([word("a", [0, 1]), word("b", [61, 62])]);
    const second = p2([word("x", [31, 61])]);
    const nowhere = finalGaps([{ words: first, gaps: [gapOf(1, 61, S(24))] }], NO_SILENCE);
    expect(nowhere).toEqual([{ startMs: S(1), endMs: S(61) }]); // 60 - 24 = 36 s: still a gap, nothing covers it
    const wide = { ...first, startMs: S(0), endMs: S(600) };
    const overlap = { ...second, startMs: S(31), endMs: S(631) };
    const partial = finalGaps([{ words: wide, gaps: [gapOf(1, 61, S(24))] }, { words: overlap, gaps: [] }], NO_SILENCE);
    expect(partial).toEqual([]); // 30 s of sound - 12 s credit = 18 s < 20 s
  });

  it("merges ranges", () => {
    expect(mergeRanges([{ startMs: 5, endMs: 9 }, { startMs: 0, endMs: 5 }, { startMs: 20, endMs: 30 }])).toEqual([
      { startMs: 0, endMs: 9 },
      { startMs: 20, endMs: 30 },
    ]);
  });
});
