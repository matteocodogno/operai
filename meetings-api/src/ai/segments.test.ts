import { describe, expect, it } from "bun:test";
import { mapPhrases, speakerIndexOf, speakerKeyOf, type Phrase } from "./segments";
import { maxSpeakersFor } from "./transcriber";

// AC-6.2 (labels by first appearance, one voice -> one label), AC-6.1 (time order), AC-6.7.

const phrase = (speaker: Phrase["speaker"], startMs: number, text: string, durationMs = 1_000): Phrase => ({
  speaker,
  startMs,
  durationMs,
  text,
});

describe("speaker labels", () => {
  it("numbers speakers by first appearance, whatever the provider's own numbers are", () => {
    const segments = mapPhrases([phrase(7, 0, "a"), phrase(3, 2_000, "b"), phrase(7, 4_000, "c"), phrase(9, 6_000, "d")]);
    expect(segments.map((s) => s.speakerKey)).toEqual(["s1", "s2", "s1", "s3"]);
  });

  it("orders by time before labelling, so the first speaker heard is Speaker 1", () => {
    const segments = mapPhrases([phrase(1, 5_000, "later"), phrase(2, 0, "first")]);
    expect(segments.map((s) => [s.text, s.speakerKey])).toEqual([
      ["first", "s1"],
      ["later", "s2"],
    ]);
  });

  it("gives one voice one label", () => {
    const segments = mapPhrases([phrase(1, 0, "a"), phrase(1, 2_000, "b"), phrase(1, 4_000, "c")]);
    expect(new Set(segments.map((s) => s.speakerKey))).toEqual(new Set(["s1"]));
  });

  it("gives a provider that did not diarize one label", () => {
    const segments = mapPhrases([phrase(null, 0, "a"), phrase(null, 2_000, "b")]);
    expect(segments.map((s) => s.speakerKey)).toEqual(["s1", "s1"]);
  });

  it("lets a phrase with no speaker join the speaker before it", () => {
    const segments = mapPhrases([phrase(1, 0, "a"), phrase(2, 2_000, "b"), phrase(null, 4_000, "c")]);
    expect(segments.map((s) => s.speakerKey)).toEqual(["s1", "s2", "s2"]);
  });

  it("treats a numeric 1 and a string '1' as the same speaker", () => {
    const segments = mapPhrases([phrase(1, 0, "a"), phrase("1", 2_000, "b")]);
    expect(segments.map((s) => s.speakerKey)).toEqual(["s1", "s1"]);
  });

  it("round-trips a key through its index", () => {
    expect(speakerKeyOf(12)).toBe("s12");
    expect(speakerIndexOf("s12")).toBe(12);
    expect(speakerIndexOf("s0")).toBeNull();
    expect(speakerIndexOf("speaker 1")).toBeNull();
    expect(speakerIndexOf("s1; drop table")).toBeNull();
  });
});

describe("segments", () => {
  it("are numbered from 0 in time order with start and end", () => {
    const segments = mapPhrases([phrase(1, 4_000, "second", 1_500), phrase(1, 0, "first", 2_000)]);
    expect(segments).toEqual([
      { ordinal: 0, startMs: 0, endMs: 2_000, speakerKey: "s1", text: "first" },
      { ordinal: 1, startMs: 4_000, endMs: 5_500, speakerKey: "s1", text: "second" },
    ]);
  });

  it("keeps the provider's order for equal start times", () => {
    const segments = mapPhrases([phrase(1, 0, "x"), phrase(2, 0, "y"), phrase(1, 0, "z")]);
    expect(segments.map((s) => s.text)).toEqual(["x", "y", "z"]);
  });

  it("trims text and drops phrases with nothing in them", () => {
    const segments = mapPhrases([phrase(1, 0, "  hello \n"), phrase(2, 1_000, "   "), phrase(1, 2_000, "")]);
    expect(segments.map((s) => s.text)).toEqual(["hello"]);
    // a dropped phrase does not claim a speaker number
    expect(mapPhrases([phrase(2, 0, " "), phrase(5, 1_000, "a")])[0]!.speakerKey).toBe("s1");
  });

  it("yields whole, non-negative milliseconds even from odd provider numbers", () => {
    const [segment] = mapPhrases([phrase(1, -5.4, "a", Number.NaN)]);
    expect(segment).toMatchObject({ startMs: 0, endMs: 0 });
    const [rounded] = mapPhrases([phrase(1, 10.6, "a", 4.2)]);
    expect(rounded).toMatchObject({ startMs: 11, endMs: 15 });
  });

  it("is empty for no phrases, which is how 'no speech' is decided (AC-6.7)", () => {
    expect(mapPhrases([])).toEqual([]);
    expect(mapPhrases([phrase(1, 0, " ")])).toEqual([]);
  });
});

describe("maxSpeakers (AC-6.2)", () => {
  it("is participants + 1, clamped to the provider's 2 to 35", () => {
    expect(maxSpeakersFor(0)).toBe(2);
    expect(maxSpeakersFor(1)).toBe(2);
    expect(maxSpeakersFor(3)).toBe(4);
    expect(maxSpeakersFor(34)).toBe(35);
    expect(maxSpeakersFor(35)).toBe(35);
    expect(maxSpeakersFor(500)).toBe(35);
    expect(maxSpeakersFor(-4)).toBe(2);
  });
});
