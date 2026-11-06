/**
 * The estimate's man-days figure (specs/022 T2, AC-3.1): the Expected effort WITHOUT AI gain,
 * summed over activities unrounded and rounded half up once to one decimal.
 *
 * The vectors are the ones of `crm-api/src/offers/scope.test.ts` (themselves pinned to
 * estimai-ui's `pertCalc`): if EstimAI's arithmetic changes, those and these change together.
 * `manDaysOf` must equal crm-api's `totalManDays(estimate, false)` rounded to one decimal; the
 * shared-copy check (`scripts/check-shared-copies.ts`, group `manDays`) keeps the arithmetic
 * byte-identical.
 */

import { describe, expect, it } from "bun:test";
import { expectedOf, manDaysOf, pert, totalManDays } from "./manDays";

const options = { aiAssisted: false, globalAiGain: 0.3 };

describe("man-days arithmetic (shared vectors with crm-api scope.test.ts)", () => {
  it("PERT and Expected = PERT + risk", () => {
    expect(pert(2, 4, 9)).toBe(4.5);
    expect(expectedOf({ id: "a", o: 2, ml: 4, p: 9, risk: 0.5 }, options)).toBe(5);
    // Values typed as strings in the grid.
    expect(expectedOf({ id: "a", o: "2", ml: "4", p: "9", risk: "0.5" }, options)).toBe(5);
  });

  it("only ML given → O = ML × 0.75, P = ML × 1.60", () => {
    expect(expectedOf({ id: "a", ml: 10 }, options)).toBeCloseTo((7.5 + 40 + 16) / 6, 10);
  });

  it("the sum is unrounded and rounded once: 1 + 10.5833 + 5 + 1 = 17.5833 → 17.6", () => {
    const content = {
      params: { aiGain: "0.3" },
      releases: [
        { id: "r2", name: "Release 2" },
        { id: "r1", name: "MVP" },
      ],
      acts: [
        { id: "1", epic: "Auth", ml: 1, o: 1, p: 1, release: "r1" }, // 1.0
        { id: "2", epic: "Auth", ml: 10, release: "r1" }, // 10.583…
        { id: "3", epic: "Reports", o: 2, ml: 4, p: 9, risk: 0.5, release: "r2" }, // 5.0
        { id: "4", epic: "", ml: 1, o: 1, p: 1, release: "missing" }, // 1.0, unassigned
      ],
    };
    expect(totalManDays({ id: "e", name: "E", content }, false)).toBeCloseTo(17.5833, 4);
    expect(manDaysOf(content)).toBe(17.6);
  });
});

describe("manDaysOf — the figure a contract copies", () => {
  it("is the Expected figure without AI gain, whatever the activity or global gain says", () => {
    const base = { params: {}, releases: [], acts: [{ id: "a", o: 2, ml: 4, p: 9, risk: 0.5 }] };
    const withGain = {
      params: { aiGain: 0.9 },
      releases: [],
      acts: [{ id: "a", o: 2, ml: 4, p: 9, risk: 0.5, aiGain: 0.9 }],
    };
    expect(manDaysOf(base)).toBe(5);
    expect(manDaysOf(withGain)).toBe(5);
  });

  it("rounds half up to one decimal, once", () => {
    // 0.25 + 0.25 = 0.5 → 0.5; a single 0.25 → 0.3 (half up, not banker's, not truncation)
    expect(manDaysOf({ params: {}, releases: [], acts: [{ id: "a", o: 0.25, ml: 0.25, p: 0.25 }] })).toBe(0.3);
    // Two activities of 0.04 sum to 0.08 → 0.1; rounding each first would give 0.
    expect(
      manDaysOf({
        params: {},
        releases: [],
        acts: [
          { id: "a", o: 0.04, ml: 0.04, p: 0.04 },
          { id: "b", o: 0.04, ml: 0.04, p: 0.04 },
        ],
      }),
    ).toBe(0.1);
  });

  it("is 0 for an estimate without activities and for content that is not an estimate", () => {
    expect(manDaysOf({ params: {}, releases: [], acts: [] })).toBe(0);
    for (const odd of [null, undefined, 42, "text", [], {}, { acts: "nope" }, { acts: [null, 3, { id: "x" }] }]) {
      expect(manDaysOf(odd)).toBe(0);
    }
  });

  it("never goes below 0 and never returns NaN", () => {
    expect(manDaysOf({ params: {}, releases: [], acts: [{ id: "a", o: -5, ml: -5, p: -5 }] })).toBe(0);
    expect(manDaysOf({ params: {}, releases: [], acts: [{ id: "a", ml: "abc", risk: "x" }] })).toBe(0);
  });
});
