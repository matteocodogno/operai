import { describe, expect, it } from "bun:test";
import { FakeTranscriber, segmentsOf } from "./fakeTranscriber";

// T116: the fake keeps every existing path working and can be scripted with parts, gaps and joined keys.

const call = (fake: FakeTranscriber) => fake.transcribe(new Blob(["x"]), "en-US", 2, undefined, { meetingId: "m", attempt: 1 });

describe("FakeTranscriber", () => {
  it("by default hears two speakers in one part, with the part carried and no gap (as before)", async () => {
    const outcome = await call(new FakeTranscriber());
    if (outcome.kind !== "segments") throw new Error("expected segments");
    expect(outcome.partStartsMs).toEqual([0]);
    expect(outcome.parts).toEqual([{ startMs: 0, endMs: 4_500 }]);
    expect(outcome.gaps).toEqual([]);
    expect(outcome.segments.map((s) => [s.speakerKey, s.part])).toEqual([["s1", 1], ["s2", 1]]);
  });

  it("an old-style scripted outcome (segments and partStartsMs only) is completed", async () => {
    const fake = new FakeTranscriber().respondWith({ kind: "segments", segments: segmentsOf([[1, "s1", 0, "a"], [2, "s2", 3_600_000, "b"]]), partStartsMs: [0, 3_600_000] });
    const outcome = await call(fake);
    if (outcome.kind !== "segments") throw new Error("expected segments");
    expect(outcome.partStartsMs).toEqual([0, 3_600_000]);
    expect(outcome.parts).toEqual([{ startMs: 0, endMs: 3_600_000 }, { startMs: 3_600_000, endMs: 3_601_000 }]);
    expect(outcome.gaps).toEqual([]);
  });

  it("scripts overlapping parts, gaps and a label joined across parts", async () => {
    const parts = [{ startMs: 0, endMs: 600_000 }, { startMs: 510_000, endMs: 1_110_000 }];
    const gaps = [{ startMs: 60_000, endMs: 95_000 }];
    const fake = new FakeTranscriber().respondWith({ kind: "segments", segments: segmentsOf([[1, "s1", 0, "a"], [2, "s1", 540_000, "b"], [2, "s2", 560_000, "c"]]), parts, gaps });
    const outcome = await call(fake);
    if (outcome.kind !== "segments") throw new Error("expected segments");
    expect(outcome.parts).toEqual(parts);
    expect(outcome.partStartsMs).toEqual([0, 510_000]);
    expect(outcome.gaps).toEqual(gaps);
    // joined: one key on segments of two parts; separate: a key of its own
    expect(outcome.segments.filter((s) => s.speakerKey === "s1").map((s) => s.part)).toEqual([1, 2]);
    expect(outcome.segments[2]).toMatchObject({ speakerKey: "s2", part: 2 });
  });

  it("scripts noSpeech and errors as before", async () => {
    expect(await call(new FakeTranscriber().respondWith({ kind: "noSpeech" }))).toEqual({ kind: "noSpeech" });
    await expect(call(new FakeTranscriber().failWith(new Error("down")))).rejects.toThrow("down");
  });
});
