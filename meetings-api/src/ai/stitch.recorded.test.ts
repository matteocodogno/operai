import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assess, finalGaps, findRepetitions, longHoles, type Assessment } from "./completeness";
import { wordsOfPart } from "./googleSpeech";
import { stitch } from "./stitch";
import { tokensOf, type Interval, type PartWords } from "./words";

// T124 (specs/021-meetings plan H-10): the stitcher and the detector on RECORDED Chirp 3 outputs (the real service, 2026-11-05,
// synthetic macOS `say` audio, scrubbed; test-fixtures/google-speech/README.md), not on hand-built ones.
//   AC-6.17 replay: the recorded overlap outputs run with three different silence lists and two different audio files must
//   give identical joins and the same speaker for every word. AC-6.14/6.15 on what the service really did: a clean join, a
//   refusal caused by the provider's own diarization jitter, a refusal caused by a hole in the overlap (J0), a 3-voice file.

const FIXTURES = join(import.meta.dir, "..", "..", "test-fixtures", "google-speech");
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

interface SetMeta {
  readonly locale: string;
  readonly parts: Interval[];
  readonly silences: Interval[];
}
const META = read("overlap-recorded-meta.json") as Record<string, SetMeta>;

const partsOf = (name: string): PartWords[] =>
  META[name]!.parts.map((span, i) => wordsOfPart(read(`${name}-part-${i + 1}.json`), i + 1, span.startMs, span.endMs, true)!);

/** The adapter's own chain after the tries: the detector, the final gaps, the stitch. */
function pipeline(parts: PartWords[], silences: readonly Interval[]) {
  const assessed: Assessment[] = parts.map((p) => assess(p, silences));
  const gaps = finalGaps(parts.map((p, i) => ({ words: p, gaps: assessed[i]!.gaps })), silences);
  const result = stitch({ parts, gaps });
  return { assessed, gaps, ...result };
}

/** Who said each word, by the root label: independent of where a gap splits a phrase. */
const speakerPerWord = (phrases: { speaker: unknown; text: string }[]): string[] =>
  phrases.flatMap((p) => p.text.split(" ").map((w) => `${w}|${String(p.speaker)}`));

const SETS = ["overlap-it", "overlap-en-jitter", "overlap-it-hole", "overlap-en3"] as const;
const everything = (name: string): Interval[] => [{ startMs: 0, endMs: META[name]!.parts[META[name]!.parts.length - 1]!.endMs + 1_000_000 }];

describe("AC-6.17 replay: the joins do not depend on the audio", () => {
  for (const name of SETS) {
    it(`${name}: recorded silence list, none, all-silence, and another recording's list give identical joins and speakers`, () => {
      const parts = partsOf(name);
      const other = SETS.find((s) => s !== name)!;
      const lists: Record<string, Interval[]> = {
        recorded: META[name]!.silences,
        "none (all sound)": [],
        "all silence": everything(name),
        "another audio file's list": META[other]!.silences,
      };
      const runs = Object.entries(lists).map(([label, silences]) => ({ label, ...pipeline(parts, silences) }));
      const base = runs[0]!;
      for (const run of runs.slice(1)) {
        expect([run.label, run.stats]).toEqual([run.label, base.stats]);
        expect([run.label, speakerPerWord(run.phrases)]).toEqual([run.label, speakerPerWord(base.phrases)]);
      }
    });
  }

  it("the same words with the labels renamed give the same joins (only the labels' agreement counts)", () => {
    const parts = partsOf("overlap-it");
    const renamed = parts.map((p) => ({ ...p, words: p.words.map((w) => ({ ...w, label: w.label.replace(/:(\d)$/, (_m, d: string) => `:${1 - Number(d)}`) })) }));
    const a = stitch({ parts, gaps: [] });
    const b = stitch({ parts: renamed, gaps: [] });
    expect(b.stats).toEqual(a.stats);
  });
});

describe("what the real service did at the seam (AC-6.13, AC-6.14, AC-6.15)", () => {
  it("overlap-it (2 voices, 60-minute file, boundary 1|2): the overlap once, both voices joined, no gap", () => {
    const parts = partsOf("overlap-it");
    const out = pipeline(parts, META["overlap-it"]!.silences);
    expect(out.gaps).toEqual([]);
    expect(out.stats).toEqual({ removedWithinPart: 0, removedInOverlap: 272, joined: 2, separate: 0 });
    const words = out.phrases.flatMap((p) => p.text.split(" "));
    expect(words).toHaveLength(parts[0]!.words.length + parts[1]!.words.length - 272);
    expect(new Set(out.phrases.map((p) => p.speaker)).size).toBe(2);
  });

  it("overlap-en-jitter: 274 aligned words and still no join, because the provider itself mislabelled words of part 1 (R25)", () => {
    const out = pipeline(partsOf("overlap-en-jitter"), META["overlap-en-jitter"]!.silences);
    expect(out.stats).toEqual({ removedWithinPart: 0, removedInOverlap: 274, joined: 0, separate: 2 });
    // nobody is joined, so every label of part 2 is a speaker of its own: the safe direction (a rename repairs it)
    expect(new Set(out.phrases.map((p) => p.speaker)).size).toBe(4);
  });

  it("overlap-it-hole: the detector finds the recorded hole, and J0 refuses every join at the seam it touches", () => {
    const parts = partsOf("overlap-it-hole");
    expect(longHoles(parts[0]!)).toHaveLength(1);
    expect(parts[0]!.words.filter((w) => w.span === null).length).toBeGreaterThan(300); // the provider's untimed tail
    const out = pipeline(parts, META["overlap-it-hole"]!.silences);
    expect(out.assessed[0]!.gaps).toHaveLength(1);
    // the gap lies inside the real hole (35:52-38:36 of the 60-minute file) and the final range stops where part 2 begins covering it
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]!.startMs).toBeGreaterThanOrEqual(2_140_000);
    expect(out.gaps[0]!.endMs).toBeLessThanOrEqual(META["overlap-it-hole"]!.parts[1]!.startMs);
    expect(out.stats.joined).toBe(0);
    expect(out.stats.separate).toBe(2);
    // a segment never spans the gap
    for (const phrase of out.phrases) expect(phrase.startMs < out.gaps[0]!.startMs && phrase.startMs + phrase.durationMs > out.gaps[0]!.endMs).toBe(false);
  });

  it("overlap-en3 (3 voices, 19-minute part): nothing is joined; a recorded hole sits in the overlap", () => {
    const parts = partsOf("overlap-en3");
    expect(longHoles(parts[0]!).length).toBeGreaterThan(0);
    const out = pipeline(parts, META["overlap-en3"]!.silences);
    expect(out.stats.joined).toBe(0);
    expect(out.stats.separate).toBe(3);
    // KNOWN LIMIT, recorded by T124 and reported as drift on plan H-3 (R24): the 19-minute part has a 20 s hole, 1046 of
    // its 3019 words came back with no trusted time, and the credit for them (600 ms each) hides the hole, so it is not a gap.
    expect(out.assessed[0]!.gaps).toEqual([]);
  });
});

describe("what the real service returns inside one part (D1)", () => {
  it("a part whose last 345 words repeat its last 2.5 minutes with no usable time: the repetition is found and removed", () => {
    const meta = META["output-recorded-repeat-tail"] as unknown as SetMeta;
    const part = wordsOfPart(read("output-recorded-repeat-tail.json"), 1, meta.parts[0]!.startMs, meta.parts[0]!.endMs, true)!;
    const untimed = part.words.filter((w) => w.span === null).length;
    expect(untimed).toBeGreaterThan(300);
    const reps = findRepetitions(tokensOf(part.words));
    expect(reps).toHaveLength(1);
    expect(reps[0]!.toToken - reps[0]!.fromToken).toBeGreaterThan(300);
    const a = assess(part, meta.silences);
    expect(a.repetitions).toHaveLength(1);
    const out = stitch({ parts: [part], gaps: [] });
    expect(out.stats.removedWithinPart).toBe(reps[0]!.toToken - reps[0]!.fromToken);
  });
});
