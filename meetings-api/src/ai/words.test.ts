import { describe, expect, it } from "bun:test";
import { effectiveSpans, normalizeToken, tokensOf, type SpeechWord } from "./words";

// AC-6.13 (normalisation shared by every rule), H-2 (effective time of an untimed word).

const word = (text: string, span: [number, number] | null = null, extra: Partial<SpeechWord> = {}): SpeechWord => ({
  text,
  label: "p1:1",
  noise: false,
  span: span ? { startMs: span[0], endMs: span[1] } : null,
  ...extra,
});

describe("normalizeToken", () => {
  it("ignores case, accents and punctuation", () => {
    expect(normalizeToken("Perché,")).toBe("perche");
    expect(normalizeToken("PERCHE")).toBe("perche");
    expect(normalizeToken("l'altro")).toBe("laltro");
    expect(normalizeToken("Straße")).toBe("straße");
    expect(normalizeToken("2026.")).toBe("2026");
  });

  it("is empty for punctuation and markers", () => {
    expect(normalizeToken("—")).toBe("");
    expect(normalizeToken("[")).toBe("");
    expect(normalizeToken("")).toBe("");
  });
});

describe("tokensOf", () => {
  it("drops noise markers and words that normalise to nothing, keeping the word index", () => {
    const tokens = tokensOf([word("[", null, { noise: true }), word("Ciao,"), word("—"), word("mondo")]);
    expect(tokens.map((t) => [t.wordIndex, t.norm])).toEqual([
      [1, "ciao"],
      [3, "mondo"],
    ]);
  });
});

describe("effectiveSpans", () => {
  const part = { startMs: 0, endMs: 60_000 };

  it("keeps a trusted span as it is", () => {
    const tokens = tokensOf([word("a", [1_000, 1_400])]);
    expect(effectiveSpans(tokens, part)).toEqual([{ startMs: 1_000, endMs: 1_400 }]);
  });

  it("places an untimed word between its timed neighbours", () => {
    const tokens = tokensOf([word("a", [1_000, 1_400]), word("b"), word("c"), word("d", [5_000, 5_300])]);
    expect(effectiveSpans(tokens, part).slice(1, 3)).toEqual([
      { startMs: 1_400, endMs: 5_000 },
      { startMs: 1_400, endMs: 5_000 },
    ]);
  });

  it("uses the part's edges where there is no timed neighbour", () => {
    const tokens = tokensOf([word("a"), word("b", [10_000, 10_400]), word("c")]);
    const spans = effectiveSpans(tokens, part);
    expect(spans[0]).toEqual({ startMs: 0, endMs: 10_000 });
    expect(spans[2]).toEqual({ startMs: 10_400, endMs: 60_000 });
  });

  it("is the whole part when nothing is timed", () => {
    expect(effectiveSpans(tokensOf([word("a")]), part)).toEqual([{ startMs: 0, endMs: 60_000 }]);
  });

  it("is never a point and never outside the part", () => {
    // neighbours that touch (or cross): still an interval, still inside the part
    const tokens = tokensOf([word("a", [1_000, 2_000]), word("b"), word("c", [2_000, 2_500])]);
    const span = effectiveSpans(tokens, part)[1]!;
    expect(span.endMs).toBeGreaterThan(span.startMs);
    expect(span.startMs).toBeGreaterThanOrEqual(0);
    expect(span.endMs).toBeLessThanOrEqual(60_000);
    const edge = effectiveSpans(tokensOf([word("a", [60_000, 60_000]), word("b")]), part)[1]!;
    expect(edge.endMs).toBeGreaterThan(edge.startMs);
    expect(edge.endMs).toBeLessThanOrEqual(60_000);
  });
});
