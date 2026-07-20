/**
 * Unit tests for `computeMileageAmountCents` (T3, specs/009-mileage-rate,
 * Decision 3) — exercised against the SHARED vector fixture
 * (`mileage-vectors.json`) so refund-ui's mirrored implementation (T12) can
 * assert byte-for-byte identical results (R1).
 */

import { describe, expect, it } from "bun:test";
import { computeMileageAmountCents } from "./computeMileageAmountCents";
import vectors from "./mileage-vectors.json";

describe("computeMileageAmountCents", () => {
  for (const vector of vectors) {
    it(`${vector.description} (km=${vector.km}, ratePerKmMicros=${vector.ratePerKmMicros} -> ${vector.expectedCents})`, () => {
      expect(computeMileageAmountCents(vector.km, vector.ratePerKmMicros)).toBe(
        vector.expectedCents,
      );
    });
  }

  it("is integer-only and single-rounding — no drift from chained float operations", () => {
    // 700000 micros/km * 3km = 2,100,000 micros total; /10_000 = 210 cents exactly.
    expect(computeMileageAmountCents(3, 700000)).toBe(210);
  });
});
