import { describe, expect, test } from "bun:test";
import vectors from "./schedule-vectors.json";
import {
  type Anchor,
  type AssetForFigures,
  type DepreciationRule,
  schedule,
  yearFigure,
} from "./schedule";

const CH: DepreciationRule = {
  usefulLifeYears: 3,
  firstYearShare: "full",
  lowValueThresholdCents: null,
  residualCents: 100,
};
const IT: DepreciationRule = {
  usefulLifeYears: 5,
  firstYearShare: "half",
  lowValueThresholdCents: 51646,
  residualCents: 0,
};

describe("schedule: shared vectors", () => {
  for (const v of vectors.schedule) {
    test(v.name, () => {
      const anchor = "anchor" in v ? (v.anchor as Anchor) : undefined;
      expect(
        schedule(v.priceCents, v.purchaseYear, v.rule as DepreciationRule, anchor),
      ).toEqual(v.expected);
    });
  }
});

describe("schedule: rules of the plan", () => {
  test("AC-5.2: purchase-year amount depends on the year only (no pro-rata)", () => {
    // The input carries a year, never a date: 1 Jan and 31 Dec purchases are the same call.
    const jan = schedule(99815, 2026, CH);
    const dec = schedule(99815, 2026, CH);
    expect(jan[0]?.depreciationCents).toBe(33238);
    expect(dec).toEqual(jan);
  });

  test("the last closing is exactly the residual (AC-5.1 / AC-5.4)", () => {
    expect(schedule(99815, 2026, CH).at(-1)?.closingCents).toBe(100);
    expect(schedule(100000, 2026, IT).at(-1)?.closingCents).toBe(0);
  });

  test("threshold boundary: 51646 collapses to one year, 51647 does not", () => {
    expect(schedule(51646, 2026, IT)).toHaveLength(1);
    expect(schedule(51647, 2026, IT).length).toBeGreaterThan(1);
  });

  test("threshold null never collapses", () => {
    expect(schedule(1000, 2026, { ...CH, residualCents: 0 })).toHaveLength(3);
  });

  test("does not mutate its inputs", () => {
    const rule = { ...CH };
    const anchor = { year: 2025, bookValueCents: 53255 };
    schedule(80000, 2025, rule, anchor);
    expect(rule).toEqual(CH);
    expect(anchor).toEqual({ year: 2025, bookValueCents: 53255 });
  });

  test("rejects invalid input explicitly", () => {
    expect(() => schedule(10.5, 2026, CH)).toThrow(RangeError);
    expect(() => schedule(-1, 2026, CH)).toThrow(RangeError);
    expect(() => schedule(1000, 2026.5, CH)).toThrow(RangeError);
    expect(() => schedule(1000, 2026, { ...CH, usefulLifeYears: 0 })).toThrow(RangeError);
    expect(() => schedule(1000, 2026, { ...CH, usefulLifeYears: 2.5 })).toThrow(RangeError);
    expect(() => schedule(1000, 2026, { ...CH, residualCents: -1 })).toThrow(RangeError);
    expect(() => schedule(1000, 2026, { ...CH, residualCents: 1.5 })).toThrow(RangeError);
    expect(() => schedule(1000, 2026, { ...CH, lowValueThresholdCents: -5 })).toThrow(RangeError);
    expect(() => schedule(1000, 2026, CH, { year: 2026, bookValueCents: 1.5 })).toThrow(RangeError);
    expect(() => schedule(1000, 2026, CH, { year: 2026, bookValueCents: -1 })).toThrow(RangeError);
    // an anchor before the purchase year is incoherent
    expect(() => schedule(1000, 2026, CH, { year: 2025, bookValueCents: 500 })).toThrow(RangeError);
  });
});

const ch = (extra: Partial<AssetForFigures> = {}): AssetForFigures => ({
  priceCents: 99815,
  purchaseYear: 2026,
  rule: CH,
  ...extra,
});

describe("yearFigure", () => {
  test("years before the purchase year are all zeros", () => {
    expect(yearFigure(ch(), 2025)).toEqual({
      openingCents: 0,
      purchaseCents: 0,
      depreciationCents: 0,
      disposalCents: 0,
      closingCents: 0,
    });
  });

  test("purchase year and following years follow the schedule", () => {
    expect(yearFigure(ch(), 2026)).toEqual({
      openingCents: 0,
      purchaseCents: 99815,
      depreciationCents: 33238,
      disposalCents: 0,
      closingCents: 66577,
    });
    expect(yearFigure(ch(), 2028)).toEqual({
      openingCents: 33339,
      purchaseCents: 0,
      depreciationCents: 33239,
      disposalCents: 0,
      closingCents: 100,
    });
  });

  test("AC-5.3: book value stays at the residual after the schedule ends", () => {
    for (const y of [2029, 2030, 2040]) {
      expect(yearFigure(ch(), y)).toEqual({
        openingCents: 100,
        purchaseCents: 0,
        depreciationCents: 0,
        disposalCents: 0,
        closingCents: 100,
      });
    }
  });

  test("price at or below residual: no depreciation, book value stays at the price", () => {
    const a = ch({ priceCents: 50 });
    expect(yearFigure(a, 2026)).toEqual({
      openingCents: 0,
      purchaseCents: 50,
      depreciationCents: 0,
      disposalCents: 0,
      closingCents: 50,
    });
    expect(yearFigure(a, 2027).closingCents).toBe(50);
  });

  test("AC-7.2: disposal in the purchase year puts the price on the disposal figure", () => {
    const a = ch({ disposalYear: 2026 });
    expect(yearFigure(a, 2026)).toEqual({
      openingCents: 0,
      purchaseCents: 99815,
      depreciationCents: 0,
      disposalCents: 99815,
      closingCents: 0,
    });
  });

  test("AC-7.2 / 7.7 / 7.8: disposal in a later year uses the opening book value", () => {
    const a = ch({ disposalYear: 2027 });
    expect(yearFigure(a, 2026).closingCents).toBe(66577);
    expect(yearFigure(a, 2027)).toEqual({
      openingCents: 66577,
      purchaseCents: 0,
      depreciationCents: 0,
      disposalCents: 66577,
      closingCents: 0,
    });
    for (const y of [2028, 2029, 2035]) {
      expect(yearFigure(a, y)).toEqual({
        openingCents: 0,
        purchaseCents: 0,
        depreciationCents: 0,
        disposalCents: 0,
        closingCents: 0,
      });
    }
  });

  test("disposal after the schedule ended disposes the residual", () => {
    const f = yearFigure(ch({ disposalYear: 2031 }), 2031);
    expect(f.disposalCents).toBe(100);
    expect(f.openingCents).toBe(100);
    expect(f.closingCents).toBe(0);
  });

  test("anchored asset: year A carries V, later years follow the anchor schedule", () => {
    const a = ch({ priceCents: 80000, purchaseYear: 2025, anchor: { year: 2025, bookValueCents: 53255 } });
    expect(yearFigure(a, 2025)).toEqual({
      openingCents: 53255,
      purchaseCents: 0,
      depreciationCents: 0,
      disposalCents: 0,
      closingCents: 53255,
    });
    expect(yearFigure(a, 2026)).toEqual({
      openingCents: 53255,
      purchaseCents: 0,
      depreciationCents: 26578,
      disposalCents: 0,
      closingCents: 26677,
    });
    expect(yearFigure(a, 2027).closingCents).toBe(100);
    expect(yearFigure(a, 2030).closingCents).toBe(100);
  });

  test("anchored asset with empty schedule keeps V (not raised to the residual)", () => {
    const a = ch({ priceCents: 80000, purchaseYear: 2025, anchor: { year: 2025, bookValueCents: 40 } });
    expect(yearFigure(a, 2027).closingCents).toBe(40);
  });

  test("anchored asset disposed after the anchor year", () => {
    const a = ch({
      priceCents: 80000,
      purchaseYear: 2025,
      anchor: { year: 2025, bookValueCents: 53255 },
      disposalYear: 2027,
    });
    expect(yearFigure(a, 2027)).toEqual({
      openingCents: 26677,
      purchaseCents: 0,
      depreciationCents: 0,
      disposalCents: 26677,
      closingCents: 0,
    });
  });

  test("figures before an anchor year are stored rows, not computable: RangeError", () => {
    const a = ch({ priceCents: 80000, purchaseYear: 2024, anchor: { year: 2025, bookValueCents: 53255 } });
    expect(() => yearFigure(a, 2024)).toThrow(RangeError);
    expect(yearFigure(a, 2023).closingCents).toBe(0); // still before the purchase
    expect(() => yearFigure({ ...a, disposalYear: 2025 }, 2026)).toThrow(RangeError);
  });

  test("rejects a disposal year before the purchase year and non-integer years", () => {
    expect(() => yearFigure(ch({ disposalYear: 2025 }), 2026)).toThrow(RangeError);
    expect(() => yearFigure(ch(), 2026.5)).toThrow(RangeError);
  });
});

// ---- property-style tests (deterministic, fixed seed; no dependency) ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("properties (seeded)", () => {
  const rnd = mulberry32(0x5eed015);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const randomRule = (): DepreciationRule => ({
    usefulLifeYears: int(1, 10),
    firstYearShare: rnd() < 0.5 ? "full" : "half",
    lowValueThresholdCents: rnd() < 0.5 ? null : int(0, 100_000),
    residualCents: rnd() < 0.3 ? 0 : int(0, 5_000),
  });
  const randomPrice = (): number => {
    const r = rnd();
    if (r < 0.2) return int(0, 300); // tiny / around the residual
    if (r < 0.6) return int(1, 200_000);
    return int(1, 50_000_000);
  };

  test("no-anchor: amounts >= 0, sum to price - residual, end on the residual, chain", () => {
    for (let i = 0; i < 3000; i++) {
      const rule = randomRule();
      const price = randomPrice();
      const year = int(2000, 2040);
      const s = schedule(price, year, rule);
      const d = price - rule.residualCents;
      if (d <= 0) {
        expect(s).toEqual([]);
        continue;
      }
      let sum = 0;
      let prevClosing = price;
      s.forEach((e, idx) => {
        expect(e.year).toBe(year + idx);
        expect(Number.isInteger(e.depreciationCents)).toBe(true);
        expect(e.depreciationCents).toBeGreaterThanOrEqual(0);
        expect(e.closingCents).toBe(prevClosing - e.depreciationCents);
        expect(e.closingCents).toBeGreaterThanOrEqual(rule.residualCents);
        sum += e.depreciationCents;
        prevClosing = e.closingCents;
      });
      expect(sum).toBe(d);
      expect(s.at(-1)?.closingCents).toBe(rule.residualCents);
      expect(s.length).toBeLessThanOrEqual(rule.usefulLifeYears + 1);
    }
  });

  test("anchor: amounts >= 0, sum to V - residual, end on the residual", () => {
    for (let i = 0; i < 3000; i++) {
      const rule = randomRule();
      const py = int(2000, 2030);
      const anchor: Anchor = { year: py + int(0, 4), bookValueCents: int(0, 200_000) };
      const s = schedule(500_000, py, rule, anchor);
      const n = rule.usefulLifeYears + (rule.firstYearShare === "half" ? 1 : 0);
      const k = n - (anchor.year - py + 1);
      if (k <= 0 || anchor.bookValueCents <= rule.residualCents) {
        expect(s).toEqual([]);
        continue;
      }
      expect(s).toHaveLength(k);
      let prev = anchor.bookValueCents;
      for (const [idx, e] of s.entries()) {
        expect(e.year).toBe(anchor.year + 1 + idx);
        expect(e.depreciationCents).toBeGreaterThanOrEqual(0);
        expect(e.closingCents).toBe(prev - e.depreciationCents);
        prev = e.closingCents;
      }
      expect(prev).toBe(rule.residualCents);
    }
  });

  test("yearFigure: identity, chaining, residual floor, disposal rules", () => {
    for (let i = 0; i < 1500; i++) {
      const rule = randomRule();
      const price = randomPrice();
      const purchaseYear = int(2000, 2030);
      const disposalYear = rnd() < 0.5 ? undefined : purchaseYear + int(0, 12);
      const asset: AssetForFigures = { priceCents: price, purchaseYear, rule, disposalYear };
      let prevClosing = 0;
      for (let y = purchaseYear - 2; y <= purchaseYear + 14; y++) {
        const f = yearFigure(asset, y);
        expect(f.closingCents).toBe(
          f.openingCents + f.purchaseCents - f.depreciationCents - f.disposalCents,
        );
        for (const v of Object.values(f)) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
        expect(f.openingCents).toBe(prevClosing);
        if (y < purchaseYear) expect(f.closingCents).toBe(0);
        if (disposalYear !== undefined && y >= disposalYear) {
          expect(f.depreciationCents).toBe(0);
          expect(f.closingCents).toBe(0);
        } else if (y >= purchaseYear + 12) {
          expect(f.closingCents).toBe(Math.min(price, rule.residualCents));
        }
        if (y === purchaseYear) expect(f.purchaseCents).toBe(price);
        else expect(f.purchaseCents).toBe(0);
        if (y === disposalYear) {
          expect(f.disposalCents).toBe(y === purchaseYear ? price : f.openingCents);
        }
        prevClosing = f.closingCents;
      }
    }
  });
});
