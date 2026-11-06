import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stitch } from "./stitch";
import { mapPhrases } from "./segments";
import type { PartWords, SpeechWord } from "./words";

// AC-6.13 (D1, D2), AC-6.14 (joins and chains), AC-6.15 (separate), AC-6.1/6.5 (seams), AC-6.2 (numbering),
// AC-6.17 (text, labels and times only). Rows of plan H-10.

const S = (seconds: number) => Math.round(seconds * 1000);
const word = (text: string, label: string, at: [number, number] | null): SpeechWord => ({
  text,
  label,
  noise: false,
  span: at ? { startMs: S(at[0]), endMs: S(at[1]) } : null,
});
/** `count` distinct words `<prefix><n>` from `from` seconds, 0.4 s apart. */
const say = (label: string, prefix: string, first: number, count: number, from: number, timed = true): SpeechWord[] =>
  Array.from({ length: count }, (_, i) => word(`${prefix}${first + i}`, label, timed ? [from + i * 0.4, from + i * 0.4 + 0.3] : null));
const part = (number: number, startS: number, endS: number, words: SpeechWord[]): PartWords => ({ part: number, startMs: S(startS), endMs: S(endS), words });

/** One speaker in part 1 and part 2, saying `n` words in the overlap that both versions return. */
const overlapSpeech = (n: number, labelA: string, labelB: string, startS = 520) => [say(labelA, "w", 0, n, startS), say(labelB, "w", 0, n, startS)] as const;

const run = (parts: PartWords[], gaps: { startMs: number; endMs: number }[] = []) => {
  const result = stitch({ parts, gaps });
  return { ...result, segments: mapPhrases(result.phrases) };
};
const textOf = (segments: { text: string }[]) => segments.map((s) => s.text).join(" ");

/** Filler words every 5 s over `[from, to]` (unique text per part) so that no stretch of the part is a 20 s hole. */
const pad = (number: number, from: number, to: number, label: string, words: SpeechWord[], except: [number, number] | null = null): SpeechWord[] => {
  const filler: SpeechWord[] = [];
  for (let t = from + 2.5, i = 0; t < to; t += 5, i += 1) {
    if (except && t > except[0] && t < except[1]) continue;
    // never inside a stretch of real speech: filler must not break the runs the test is about
    if (words.some((w) => w.span && t >= w.span.startMs / 1000 - 0.5 && t <= w.span.endMs / 1000 + 0.5)) continue;
    filler.push(word(`fill${number}_${i}`, label, [t, t + 0.2]));
  }
  return [...words, ...filler].sort((x, y) => (x.span?.startMs ?? 0) - (y.span?.startMs ?? 0));
};

describe("D1: speech returned twice inside one part (AC-6.13)", () => {
  const phrase = (from: number) => "il budget del prossimo trimestre va rivisto subito".split(" ").map((t, i) => word(t, "p1:1", [from + i * 0.3, from + i * 0.3 + 0.25]));

  it("is kept once when the repeat starts within 2 s of the first", () => {
    const { segments, stats } = run([part(1, 0, 60, [...phrase(0), ...phrase(3.9)])]);
    expect(textOf(segments)).toBe("il budget del prossimo trimestre va rivisto subito");
    expect(stats.removedWithinPart).toBe(8);
  });

  it("is kept twice when really said twice, more than 2 s apart", () => {
    const { segments } = run([part(1, 0, 60, [...phrase(0), ...phrase(5)])]);
    expect(textOf(segments).split(" ").length).toBe(16);
  });
});

describe("D2: the overlap of two parts (AC-6.13)", () => {
  const [aP1, aP2] = overlapSpeech(30, "p1:1", "p2:2");

  it("speech returned by both parts appears once, part 1's version", () => {
    const { segments, stats } = run([
      part(1, 0, 600, pad(1, 0, 600, "p1:1", [...say("p1:1", "pre", 0, 5, 10), ...aP1])),
      part(2, 510, 1110, pad(2, 510, 1110, "p2:2", [...aP2, ...say("p2:2", "post", 0, 5, 700)])),
    ]);
    const text = textOf(segments);
    for (let i = 0; i < 30; i += 1) expect(text.split(" ").filter((w) => w === `w${i}`)).toHaveLength(1);
    expect(stats.removedInOverlap).toBe(30);
    expect(segments.find((s) => s.text.includes("w0"))!.part).toBe(1);
    expect(segments[segments.length - 1]!.part).toBe(2);
  });

  it("words found in only one version are kept, from both sides", () => {
    // part 2 heard 10 more words at the end of the overlap that part 1 did not return, part 1 heard 5 that part 2 lacks
    const onlyOne = say("p2:2", "extra", 0, 10, 560);
    const onlyTwo = say("p1:1", "lost", 0, 5, 535);
    const { segments } = run([part(1, 0, 600, pad(1, 0, 600, "p1:1", [...aP1, ...onlyTwo])), part(2, 510, 1110, pad(2, 510, 1110, "p2:2", [...aP2, ...onlyOne]))]);
    const words = textOf(segments).split(" ");
    for (let i = 0; i < 10; i += 1) expect(words).toContain(`extra${i}`);
    for (let i = 0; i < 5; i += 1) expect(words).toContain(`lost${i}`);
    expect(words.filter((w) => w === "w3")).toHaveLength(1);
  });

  it("a phrase said twice inside the overlap keeps both copies (an alignment cannot collapse two copies in one version)", () => {
    const phrase = (label: string, from: number) => "il budget del prossimo trimestre va rivisto subito".split(" ").map((t, i) => word(t, label, [from + i * 0.3, from + i * 0.3 + 0.25]));
    // said at 520 s and again at 540 s (more than 2 s apart: D1 keeps both); both versions return both copies
    // (and 25 more words in both, so that the overlap joins the two labels, AC-6.14)
    const one = [...phrase("p1:1", 520), ...phrase("p1:1", 540), ...say("p1:1", "j", 0, 25, 560)];
    const two = [...phrase("p2:2", 520), ...phrase("p2:2", 540), ...say("p2:2", "j", 0, 25, 560)];
    const { segments } = run([part(1, 0, 600, pad(1, 0, 600, "p1:1", one)), part(2, 510, 1110, pad(2, 510, 1110, "p2:2", two))]);
    expect(textOf(segments).split(" ").filter((w) => w === "budget")).toHaveLength(2);
  });

  it("with no run of 8 equal words the two versions both stay, near the seam, in time order", () => {
    const one = say("p1:1", "a", 0, 7, 520).flatMap((w, i) => [w, word(`x${i}`, "p1:1", [520.2 + i * 0.4, 520.3 + i * 0.4])]);
    const two = say("p2:2", "b", 0, 7, 520);
    const { segments } = run([part(1, 0, 600, one.slice(0, 7)), part(2, 510, 1110, two)]);
    expect(textOf(segments)).toContain("a0");
    expect(textOf(segments)).toContain("b0");
  });
});

describe("D2 and the speaker condition (AC-6.13 with AC-6.14, amendment A8)", () => {
  const seam = (n: number, labelA: string, labelB: string, unlabelled: "none" | "first" | "second" = "none") => {
    const [a, b] = overlapSpeech(n, labelA, labelB);
    const mark = (words: SpeechWord[]) => words.map((w) => ({ ...w, unlabelled: true }));
    return [
      part(1, 0, 600, pad(1, 0, 600, labelA, [...(unlabelled === "first" ? mark(a) : a)])),
      part(2, 510, 1110, pad(2, 510, 1110, labelB, [...(unlabelled === "second" ? mark(b) : b), ...say(labelB, "post", 0, 5, 700)])),
    ];
  };
  const count = (segments: { text: string }[], w: string) => textOf(segments).split(" ").filter((x) => x === w).length;

  it("a label JOINED by the overlap counts as the same label: the duplicates are removed", () => {
    const { segments, stats } = run(seam(30, "p1:1", "p2:2"));
    expect(stats.joined).toBe(1);
    expect(stats.removedInOverlap).toBe(30);
    expect(count(segments, "w3")).toBe(1);
  });

  it("aligned words whose labels the overlap did not join are still the same speech: no join is no evidence of another speaker", () => {
    // 19 aligned words are below the match bound (AC-6.14): no join, but both versions heard the same audio
    const { segments, stats } = run(seam(19, "p1:1", "p2:2"));
    expect(stats.joined).toBe(0);
    expect(stats.removedInOverlap).toBe(19);
    expect(count(segments, "w3")).toBe(1);
  });

  it("a word without a label on either side is the same speech", () => {
    for (const side of ["first", "second"] as const) {
      const { segments, stats } = run(seam(19, "p1:1", "p2:2", side));
      expect(stats.removedInOverlap).toBe(19);
      expect(count(segments, "w3")).toBe(1);
    }
  });

  it("a hole at the seam (J0) refuses the join but not the removal of the aligned words", () => {
    const [a, b] = overlapSpeech(30, "p1:1", "p2:2");
    const p1 = part(1, 0, 600, [...a, word("tailword", "p1:1", [599, 599.5])]);
    const p2 = part(2, 510, 1110, [...b, word("after", "p2:2", [700, 701])]);
    const { stats } = run([p1, p2]);
    expect(stats.joined).toBe(0);
    expect(stats.removedInOverlap).toBe(30);
  });

  // "Joined to different roots" cannot be built through `stitch`: a later label is joined only when every one of its
  // aligned words matched ONE earlier label (J rule b), so every aligned pair of a joined label shares its root. The
  // condition in `same()` is therefore a safeguard, not a branch any input reaches today.
});

describe("joins (AC-6.14, AC-6.15, AC-6.2)", () => {
  const keyOfWord = (segments: ReturnType<typeof run>["segments"], w: string) => segments.find((s) => s.text.split(" ").includes(w))!.speakerKey;
  const build = (aWords: number, bWords: number, labels2: [string, string] = ["p2:2", "p2:1"]) => {
    const p1 = [...say("p1:1", "a", 0, aWords, 515), ...say("p1:2", "b", 0, bWords, 540)];
    const p2 = [...say(labels2[0], "a", 0, aWords, 515), ...say(labels2[1], "b", 0, bWords, 540), ...say(labels2[0], "tail", 0, 5, 700)];
    return [part(1, 0, 600, pad(1, 0, 600, "p1:1", p1)), part(2, 510, 1110, pad(2, 510, 1110, labels2[0], p2))];
  };

  it("20 matched words, all to one earlier label, with no rival: joined, one key", () => {
    const { segments, stats } = run(build(25, 25));
    // part 2's "p2:2" matches p1:1 and "p2:1" matches p1:2: numbers differ between parts, evidence does not
    expect(keyOfWord(segments, "tail0")).toBe(keyOfWord(segments, "a0"));
    expect(stats.joined).toBe(2);
    expect(stats.separate).toBe(0);
    expect(new Set(segments.map((s) => s.speakerKey)).size).toBe(2);
  });

  it("19 matched words: separate, with the next unused number (AC-6.2)", () => {
    const { segments, stats } = run(build(19, 25));
    expect(keyOfWord(segments, "tail0")).not.toBe(keyOfWord(segments, "a0"));
    // the other label (25 words) still joins
    expect(stats.joined).toBe(1);
    expect(stats.separate).toBe(1);
    const keys = [...new Set(segments.map((s) => s.speakerKey))];
    expect(keys).toEqual(["s1", "s2", "s3"]); // numbered by first appearance of the ROOT label
  });

  it("one matched word attributed to another earlier label: separate", () => {
    // inside the matched run, word a12 is attributed to a different earlier label
    const p1 = [...say("p1:1", "a", 0, 25, 515).map((w, i) => (i === 12 ? { ...w, label: "p1:2" } : w)), ...say("p1:2", "b", 0, 25, 540)];
    const p2 = [...say("p2:2", "a", 0, 25, 515), ...say("p2:1", "b", 0, 25, 540), ...say("p2:2", "tail", 0, 3, 700)];
    const { segments, stats } = run([part(1, 0, 600, pad(1, 0, 600, "p1:1", p1)), part(2, 510, 1110, pad(2, 510, 1110, "p2:2", p2))]);
    expect(stats.joined).toBe(0); // p2:2 -> {p1:1: 24, p1:2: 1}; p2:1 -> p1:2 but p2:2 also touches p1:2 (rival)
    expect(keyOfWord(segments, "tail0")).not.toBe(keyOfWord(segments, "a0"));
  });

  it("two later labels matching the same earlier one: both separate", () => {
    const p1 = say("p1:1", "a", 0, 40, 515);
    const p2 = [...say("p2:1", "a", 0, 25, 515), ...say("p2:2", "a", 25, 15, 525), ...say("p2:1", "t", 0, 2, 700), ...say("p2:2", "u", 0, 2, 705)];
    const { segments } = run([part(1, 0, 600, pad(1, 0, 600, "p1:1", p1)), part(2, 510, 1110, pad(2, 510, 1110, "p2:1", p2))]);
    expect(keyOfWord(segments, "t0")).not.toBe(keyOfWord(segments, "a0"));
    expect(keyOfWord(segments, "u0")).not.toBe(keyOfWord(segments, "a0"));
  });

  it("no speech in the overlap: separate", () => {
    const one = pad(1, 0, 600, "p1:1", say("p1:1", "a", 0, 20, 100));
    const two = pad(2, 510, 1110, "p2:1", say("p2:1", "b", 0, 20, 700));
    const { segments, stats } = run([part(1, 0, 600, one), part(2, 510, 1110, two)]);
    expect(stats.joined).toBe(0);
    expect(keyOfWord(segments, "b0")).not.toBe(keyOfWord(segments, "a0"));
  });

  it("a 20 s stretch with no trusted word in the overlap blocks every join (J0), however clear the rest", () => {
    // control: dense words all along the overlap, 40 matched words -> joined
    const speech1 = say("p1:1", "a", 0, 40, 515);
    const speech2 = [...say("p2:1", "a", 0, 40, 515), ...say("p2:1", "t", 0, 2, 700)];
    const control = run([part(1, 0, 600, pad(1, 0, 600, "p1:1", speech1)), part(2, 510, 1110, pad(2, 510, 1110, "p2:1", speech2))]);
    expect(control.stats.joined).toBe(1);
    // part 2 returns nothing between 531 s and 700 s: a hole of about 170 s that intersects the overlap window
    const holed = run([part(1, 0, 600, pad(1, 0, 600, "p1:1", speech1)), part(2, 510, 1110, pad(2, 510, 1110, "p2:1", speech2, [531, 699]))]);
    expect(holed.stats.joined).toBe(0);
    // the same hole in part 1 blocks it too
    const holed1 = run([part(1, 0, 600, pad(1, 0, 600, "p1:1", speech1, [531, 599])), part(2, 510, 1110, pad(2, 510, 1110, "p2:1", speech2))]);
    expect(holed1.stats.joined).toBe(0);
  });

  it("chains only through consecutive overlaps: a part-3 label joins part 2's label, and so part 1's", () => {
    const p1 = say("p1:1", "a", 0, 30, 515);
    const p2 = [...say("p2:1", "a", 0, 30, 515), ...say("p2:1", "m", 0, 30, 1020)];
    const p3 = [...say("p3:7", "m", 0, 30, 1020), ...say("p3:7", "end", 0, 3, 1300)];
    const { segments } = run([
      part(1, 0, 600, pad(1, 0, 600, "p1:1", p1)),
      part(2, 510, 1110, pad(2, 510, 1110, "p2:1", p2)),
      part(3, 1020, 1620, pad(3, 1020, 1620, "p3:7", p3)),
    ]);
    expect(keyOfWord(segments, "end0")).toBe(keyOfWord(segments, "a0"));
  });

  it("a part-3 label never joins part 1 directly: when part 2's label is separate, part 3's chain stops there", () => {
    const p1 = say("p1:1", "a", 0, 30, 515);
    // part 2's speaker is separate from part 1's (only 10 matched words), and part 3 matches part 2 fully
    const p2 = [...say("p2:1", "a", 0, 10, 515), ...say("p2:1", "m", 0, 30, 1020)];
    const p3 = [...say("p3:1", "m", 0, 30, 1020), ...say("p3:1", "end", 0, 3, 1300)];
    const { segments } = run([
      part(1, 0, 600, pad(1, 0, 600, "p1:1", p1)),
      part(2, 510, 1110, pad(2, 510, 1110, "p2:1", p2)),
      part(3, 1020, 1620, pad(3, 1020, 1620, "p3:1", p3)),
    ]);
    expect(keyOfWord(segments, "end0")).toBe(keyOfWord(segments, "m0"));
    expect(keyOfWord(segments, "end0")).not.toBe(keyOfWord(segments, "a0"));
  });

  it("is never joined by position, number or order: identical labels in two parts with no evidence stay separate", () => {
    const { segments } = run([
      part(1, 0, 600, pad(1, 0, 600, "p1:1", say("p1:1", "a", 0, 30, 100))),
      part(2, 510, 1110, pad(2, 510, 1110, "p2:1", say("p2:1", "b", 0, 30, 800))),
    ]);
    expect(new Set(segments.map((s) => s.speakerKey)).size).toBe(2);
  });
});

describe("segments across the seam (AC-6.1, AC-6.5)", () => {
  const [one, two] = overlapSpeech(30, "p1:1", "p2:2");
  const parts = () => [
    part(1, 0, 600, pad(1, 0, 600, "p1:1", [...say("p1:1", "pre", 0, 5, 10), ...one])),
    part(2, 510, 1110, pad(2, 510, 1110, "p2:2", [...two, ...say("p2:2", "post", 0, 5, 700)])),
  ];

  it("starts are non-decreasing across the seam and never later than the first trusted word", () => {
    const { segments } = run(parts());
    for (let i = 1; i < segments.length; i += 1) expect(segments[i]!.startMs).toBeGreaterThanOrEqual(segments[i - 1]!.startMs);
    expect(segments.find((s) => s.text.split(" ").includes("post0"))!.startMs).toBeLessThanOrEqual(S(700));
  });

  it("a segment never spans a gap, and a segment carries one part", () => {
    // a gap at 530-560 inside one speaker's run
    const dense = [part(1, 0, 600, say("p1:1", "a", 0, 200, 100)), part(2, 510, 1110, say("p2:1", "z", 0, 20, 800))];
    const gap = { startMs: S(150), endMs: S(190) };
    const { segments } = run(dense, [gap]);
    for (const s of segments) expect(s.startMs < gap.startMs && s.endMs > gap.startMs && s.startMs < gap.startMs).toBe(false);
    expect(segments.filter((s) => s.text.startsWith("a")).length).toBeGreaterThanOrEqual(2);
    const noGap = run(dense).segments.filter((s) => s.text.startsWith("a"));
    expect(noGap).toHaveLength(1);
  });

  it("a segment takes the time of its first trusted word, not of the untimed words before it", () => {
    const words = [word("untimed", "p1:1", null), word("first", "p1:1", [40, 40.4]), word("second", "p1:1", [41, 41.4])];
    const [segment] = run([part(1, 0, 600, words)]).segments;
    expect([segment!.startMs, segment!.endMs]).toEqual([S(40), S(41.4)]);
    // all untimed: it starts where its words are placed and has no length
    const [lone] = run([part(1, 0, 600, [word("a", "p1:1", null)])]).segments;
    expect([lone!.startMs, lone!.endMs]).toEqual([0, 0]);
  });

  it("carries the part of each segment (1-based)", () => {
    const { segments } = run(parts());
    expect(new Set(segments.map((s) => s.part))).toEqual(new Set([1, 2]));
    expect(run([part(1, 0, 60, say("p1:1", "a", 0, 5, 1))]).segments[0]!.part).toBe(1);
  });
});

describe("AC-6.17: the decision is a function of the returned text, labels and times", () => {
  it("is deterministic: the same input gives byte-identical output", () => {
    const [a, b] = overlapSpeech(30, "p1:1", "p2:2");
    const build = () => [part(1, 0, 600, a), part(2, 510, 1110, b)];
    expect(JSON.stringify(run(build()))).toBe(JSON.stringify(run(build())));
  });

  it("the static check: stitch.ts imports nothing from src/media and has no audio or silence input", () => {
    const source = readFileSync(join(import.meta.dir, "stitch.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(imports.sort()).toEqual(["./completeness", "./segments", "./words"]);
    expect(code).not.toMatch(/media|audio|silence|sound|voice|embedding|acoustic/i);
  });

  it("no module of the join path reaches the audio either: words.ts and completeness.ts import only each other", () => {
    for (const file of ["words.ts", "completeness.ts"]) {
      const code = readFileSync(join(import.meta.dir, file), "utf8");
      const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(imports.every((i) => i === "./words"), file).toBe(true);
    }
  });
});
