/**
 * Unit tests for the CHF and VAT amounts (T3, specs/20261118-refund-accounting-export;
 * AC-3.8, AC-6.3, AC-6.4, AC-6.12).
 *
 * The golden vectors live in `amounts-vectors.json`; their expected values were
 * computed independently with exact rational arithmetic, so this file does not
 * check the implementation against itself. The same file feeds the golden CSV
 * test (T17), which is how the screen and the export are kept from disagreeing.
 */

import { describe, expect, it } from "bun:test";
import { chfCents, vatCents } from "./amounts";
import vectors from "./amounts-vectors.json";

describe("chfCents: golden vectors (AC-6.3, AC-6.12)", () => {
  for (const v of vectors.chf) {
    it(`${v.description} (${v.amountCents} ${v.currency} @ ${v.rateMicros} -> ${v.expectedCents})`, () => {
      expect(chfCents(v.amountCents, v.currency, v.rateMicros)).toBe(v.expectedCents);
    });
  }

  it("AC-6.3: 1040 EUR cents at 924600 micros is 962, not 961 and not 961.584", () => {
    expect(chfCents(1040, "EUR", 924_600)).toBe(962);
  });

  it("a CHF line never needs a rate, and never uses the one it is given", () => {
    expect(chfCents(5555, "CHF", null)).toBe(5555);
    expect(chfCents(5555, "CHF", 2_000_000)).toBe(5555);
  });

  it("a missing rate is null (unknown), never 0 and never a rate of 1", () => {
    expect(chfCents(1040, "EUR", null)).toBeNull();
    expect(chfCents(1040, "USD", null)).toBeNull();
    expect(chfCents(1040, "GBP", null)).toBeNull();
  });
});

describe("vatCents: golden vectors (AC-3.8, AC-6.4)", () => {
  for (const v of vectors.vat) {
    it(`${v.description} (${v.chfCents} @ ${v.rateBasisPoints} bp -> ${v.expectedCents})`, () => {
      expect(vatCents(v.chfCents, v.rateBasisPoints)).toBe(v.expectedCents);
    });
  }

  it("AC-6.4: 2080 CHF cents at 810 bp is 156 (155.86 rounded once)", () => {
    expect(vatCents(2080, 810)).toBe(156);
  });

  it("VAT is taken from the ROUNDED CHF amount, so the file is self-consistent (ADR decision 2)", () => {
    // 1004 EUR cents at 0.1 = 100.4 CHF cents -> 100. The VAT of the rounded 100
    // at 8.1 % is 7.49 -> 7; the VAT of the unrounded 100.4 would be 7.52 -> 8.
    // The file shows 100 in the CHF column, so its VAT column must be 7.
    const chf = chfCents(1004, "EUR", 100_000);
    expect(chf).toBe(100);
    expect(vatCents(chf, 810)).toBe(7);
  });

  it("a line approved at 0 yields 0.00 CHF and 0.00 VAT (AC-6.12)", () => {
    expect(chfCents(0, "EUR", 924_600)).toBe(0);
    expect(vatCents(0, 810)).toBe(0);
    expect(chfCents(0, "CHF", null)).toBe(0);
  });

  it("an unknown CHF amount or an absent VAT code gives an unknown VAT amount, never 0 (AC-3.8)", () => {
    expect(vatCents(null, 810)).toBeNull();
    expect(vatCents(1000, null)).toBeNull();
    expect(vatCents(null, null)).toBeNull();
  });

  it("0 % VAT contains nothing, 100 % VAT contains half (the two ends of the CHECK range)", () => {
    expect(vatCents(12345, 0)).toBe(0);
    expect(vatCents(12345, 10_000)).toBe(6173); // 6172.5 -> half up
  });
});

describe("rounding is half up, once, on exact integers", () => {
  /** An independent half-up: quotient and remainder, no 2n+d trick. */
  const halfUp = (n: bigint, d: bigint): number => {
    const q = n / d;
    const r = n % d;
    return Number(2n * r >= d ? q + 1n : q);
  };

  it("matches an independent quotient/remainder implementation over a deterministic sweep", () => {
    let state = 123_456_789;
    const next = (max: number): number => {
      // LCG, deterministic across runs.
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state % max;
    };
    for (let i = 0; i < 2_000; i++) {
      const amount = next(10_000_000);
      const rate = 1 + next(2_000_000);
      const bp = next(10_001);
      const chf = halfUp(BigInt(amount) * BigInt(rate), 1_000_000n);
      expect(chfCents(amount, "EUR", rate)).toBe(chf);
      expect(vatCents(chf, bp)).toBe(halfUp(BigInt(chf) * BigInt(bp), 10_000n + BigInt(bp)));
    }
  });

  it("every .5 tie rounds up and every value just below it rounds down", () => {
    // n x 0.5 for n = 1..9: 0.5, 1, 1.5, ... -> 1, 1, 2, 2, 3, 3, 4, 4, 5
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => chfCents(n, "EUR", 500_000))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => chfCents(n, "EUR", 499_999))).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("is exact above 2^53 where a float product would drift", () => {
    expect(99_999_999 * 999_999_999).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(chfCents(99_999_999, "USD", 999_999_999)).toBe(99_999_998_900);
  });
});

describe("invalid inputs are programming errors, not silently clamped money", () => {
  it("chfCents refuses a negative, fractional or non-finite amount", () => {
    expect(() => chfCents(-1, "EUR", 924_600)).toThrow(RangeError);
    expect(() => chfCents(10.5, "EUR", 924_600)).toThrow(RangeError);
    expect(() => chfCents(Number.NaN, "EUR", 924_600)).toThrow(RangeError);
    expect(() => chfCents(Number.POSITIVE_INFINITY, "CHF", null)).toThrow(RangeError);
  });

  it("chfCents refuses a rate of 0, a negative rate and a fractional rate", () => {
    expect(() => chfCents(100, "EUR", 0)).toThrow(RangeError);
    expect(() => chfCents(100, "EUR", -5)).toThrow(RangeError);
    expect(() => chfCents(100, "EUR", 0.92)).toThrow(RangeError);
  });

  it("vatCents refuses a negative amount and a rate outside 0..10000 basis points", () => {
    expect(() => vatCents(-1, 810)).toThrow(RangeError);
    expect(() => vatCents(100, -1)).toThrow(RangeError);
    expect(() => vatCents(100, 10_001)).toThrow(RangeError);
    expect(() => vatCents(100, 8.1)).toThrow(RangeError);
  });

  it("a result beyond the safe integer range is refused rather than rounded", () => {
    expect(() => chfCents(Number.MAX_SAFE_INTEGER, "EUR", 2_000_000)).toThrow(RangeError);
  });
});
