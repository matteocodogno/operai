import { describe, expect, it } from "bun:test";
import { alignTokens, coverage, referenceTokens, runsOf, speakerReport } from "./spike-report";

const ref = {
  utterances: [
    { speaker: 0, startMs: 0, endMs: 5000, text: "uno due tre quattro cinque sei sette otto nove dieci" },
    { speaker: 1, startMs: 7000, endMs: 12000, text: "alfa beta gamma delta epsilon zeta eta theta iota kappa" },
  ],
};
const tokens = referenceTokens(ref);
const words = tokens.map((t) => t.norm);

describe("the spike's reference comparison (T124)", () => {
  it("aligns an identical transcript fully", () => {
    const c = coverage(tokens, words);
    expect(c.recall).toBe(1);
    expect(c.extraWords).toBe(0);
    expect(c.missingRuns).toEqual([]);
  });

  it("reports a hole as a missing run with its reference time, and extra words as extra", () => {
    const hyp = [...words.slice(0, 2), ...words.slice(12), "inventata", "parola"];
    const c = coverage(tokens, hyp);
    expect(c.matched).toBe(10);
    expect(c.missingRuns).toEqual([{ words: 10, startMs: tokens[2]!.startMs, endMs: tokens[11]!.startMs }]);
    expect(c.extraWords).toBe(2);
  });

  it("keeps a repeated stretch visible as extra words", () => {
    const hyp = [...words.slice(0, 10), ...words.slice(0, 10), ...words.slice(10)];
    const c = coverage(tokens, hyp);
    expect(c.recall).toBe(1);
    expect(c.extraWords).toBe(10);
    expect(c.extraRuns).toBe(1);
  });

  it("tells which key carried which speaker, and flags an impure or split key", () => {
    const keys = words.map((_, i) => (i < 10 ? "s1" : "s1")); // one key for both speakers: impure
    const c = coverage(tokens, words);
    const impure = speakerReport(tokens, c.matchedRef, keys);
    expect(impure.impureKeys).toBe(1);
    const split = speakerReport(tokens, c.matchedRef, words.map((_, i) => (i < 5 ? "s1" : i < 10 ? "s2" : "s3")));
    expect(split.splitSpeakers).toBe(1);
    expect(split.impureKeys).toBe(0);
    const clean = speakerReport(tokens, c.matchedRef, words.map((_, i) => (i < 10 ? "s1" : "s2")));
    expect(clean).toMatchObject({ keys: 2, impureKeys: 0, splitSpeakers: 0, purity: 1 });
  });

  it("alignTokens and runsOf edge cases", () => {
    expect(Array.from(alignTokens([], ["a"]))).toEqual([]);
    expect(Array.from(alignTokens(["a"], []))).toEqual([-1]);
    expect(runsOf([true, true, false, true], 2)).toEqual([{ from: 0, to: 2 }]);
  });

  it("handles a ten thousand word transcript inside its band", () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `w${i % 977}x${i}`);
    const hyp = [...big.slice(0, 4000), ...big.slice(4300)];
    const c = alignTokens(big, hyp);
    expect(Array.from(c).filter((j) => j < 0)).toHaveLength(300);
  });
});
