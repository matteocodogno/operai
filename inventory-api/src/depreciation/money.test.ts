import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { roundHalfUp, splitPrice } from "./money";
import vectors from "./schedule-vectors.json";

const ref = (n: bigint, d: bigint): bigint => (2n * n + d) / (2n * d);

describe("roundHalfUp", () => {
  test("rounds below, at and above the half", () => {
    expect(roundHalfUp(1, 3)).toBe(0);
    expect(roundHalfUp(2, 3)).toBe(1);
    expect(roundHalfUp(1, 2)).toBe(1); // exact .5 goes up
    expect(roundHalfUp(3, 2)).toBe(2); // 1.5
    expect(roundHalfUp(5, 2)).toBe(3); // 2.5 (not banker's)
    expect(roundHalfUp(53155, 2)).toBe(26578); // 26577.5
    expect(roundHalfUp(99715, 3)).toBe(33238); // 33238.33
    expect(roundHalfUp(7, 10)).toBe(1);
    expect(roundHalfUp(5, 10)).toBe(1);
    expect(roundHalfUp(4, 10)).toBe(0);
  });

  test("exact divisions and zero numerator", () => {
    expect(roundHalfUp(0, 7)).toBe(0);
    expect(roundHalfUp(10, 5)).toBe(2);
    expect(roundHalfUp(9, 1)).toBe(9);
  });

  test("is exact near Number.MAX_SAFE_INTEGER / 2 (no float drift)", () => {
    const big = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    for (const n of [big, big - 1, big + 1, Number.MAX_SAFE_INTEGER]) {
      for (const d of [1, 2, 3, 7, 10, 1000, 2 * 5, 999_983, big, Number.MAX_SAFE_INTEGER]) {
        expect(roundHalfUp(n, d)).toBe(Number(ref(BigInt(n), BigInt(d))));
      }
    }
    // exact .5 at a large value
    expect(roundHalfUp(big * 2 - (big * 2 - 1), 2)).toBe(1);
    const evenBig = big - (big % 2);
    expect(roundHalfUp(evenBig + 1, 2)).toBe(evenBig / 2 + 1);
  });

  test("rejects non-integer, negative, unsafe and zero-denominator input", () => {
    expect(() => roundHalfUp(1.5, 2)).toThrow(RangeError);
    expect(() => roundHalfUp(1, 2.5)).toThrow(RangeError);
    expect(() => roundHalfUp(-1, 2)).toThrow(RangeError);
    expect(() => roundHalfUp(1, -2)).toThrow(RangeError);
    expect(() => roundHalfUp(1, 0)).toThrow(RangeError);
    expect(() => roundHalfUp(Number.NaN, 2)).toThrow(RangeError);
    expect(() => roundHalfUp(Infinity, 2)).toThrow(RangeError);
    expect(() => roundHalfUp(Number.MAX_SAFE_INTEGER + 1, 2)).toThrow(RangeError);
  });
});

describe("splitPrice", () => {
  test("294635 / 13: twelve of 22664 and the remainder on the last unit", () => {
    const parts = splitPrice(294635, 13);
    expect(parts).toHaveLength(13);
    expect(parts.slice(0, 12).every((p) => p === 22664)).toBe(true);
    expect(parts[12]).toBe(22667);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(294635);
  });

  test("satisfies every shared split vector", () => {
    for (const v of vectors.splitPrice) {
      const parts = splitPrice(v.totalCents, v.quantity);
      expect(parts).toHaveLength(v.quantity);
      expect(parts.slice(0, -1).every((p) => p === v.eachCents)).toBe(true);
      expect(parts[parts.length - 1]).toBe(v.lastCents);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(v.totalCents);
    }
  });

  test("schedule-vectors.json splitPrice is identical to the UI's split-vectors.json", () => {
    const uiPath = join(import.meta.dir, "../../../inventory-ui/src/lib/split-vectors.json");
    const ui = JSON.parse(readFileSync(uiPath, "utf8")) as { vectors: unknown };
    expect(vectors.splitPrice).toEqual(ui.vectors as typeof vectors.splitPrice);
  });

  test("n = 1 returns the whole total; total smaller than n leaves leading zeros", () => {
    expect(splitPrice(500, 1)).toEqual([500]);
    expect(splitPrice(2, 3)).toEqual([0, 0, 2]);
  });

  test("rejects invalid input", () => {
    expect(() => splitPrice(100, 0)).toThrow(RangeError);
    expect(() => splitPrice(100, 1.5)).toThrow(RangeError);
    expect(() => splitPrice(-1, 2)).toThrow(RangeError);
    expect(() => splitPrice(10.5, 2)).toThrow(RangeError);
  });
});
