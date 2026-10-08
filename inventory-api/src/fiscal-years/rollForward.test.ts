/**
 * The roll-forward builder (T19, specs/015; AC-8.1, AC-8.2, AC-8.3, AC-7.2, AC-7.3, ADR-0046).
 * Pure: assets, rule and stored rows in, a statement out. Property-style: a seeded
 * generator builds mixed asset sets (native + anchored, disposed mid-life, threshold
 * expensed, bought in the year) and every set must satisfy the statement's invariants.
 */

import { describe, it, expect } from "bun:test";
import type { DepreciationRule } from "../depreciation/schedule";
import {
  buildStatement,
  type AssetFigureRow,
  type RollAsset,
  type StoredFigureRow,
} from "./rollForward";

const CH: DepreciationRule = { usefulLifeYears: 3, firstYearShare: "full", lowValueThresholdCents: null, residualCents: 100 };
const IT: DepreciationRule = { usefulLifeYears: 5, firstYearShare: "half", lowValueThresholdCents: 51646, residualCents: 0 };

const date = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Small deterministic PRNG so a failing set can be replayed from its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

interface Generated {
  assets: RollAsset[];
  rules: Map<string, DepreciationRule>;
  stored: StoredFigureRow[];
}

function generate(seed: number, rule: DepreciationRule): Generated {
  const r = rng(seed);
  const assets: RollAsset[] = [];
  const rules = new Map<string, DepreciationRule>();
  const n = int(r, 1, 25);
  for (let i = 0; i < n; i++) {
    const purchaseYear = int(r, 2022, 2028);
    const price = pick(r, [500, 51646, 51647, 99815, 100000, 123457, 250000, 777777]) + int(r, 0, 99);
    const disposed = r() < 0.3;
    const disposalYear = disposed ? purchaseYear + int(r, 0, 5) : null;
    assets.push({
      id: `a${seed}-${i}`,
      purchaseDate: date(`${purchaseYear}-${String(int(r, 1, 12)).padStart(2, "0")}-15`),
      purchasePriceCents: price,
      disposedOn: disposalYear === null ? null : date(`${disposalYear}-06-30`),
      legacyImported: false,
    });
  }
  for (const a of assets) rules.set(a.id, rule);
  return { assets, rules, stored: [] };
}

const statementOf = (g: Generated, year: number, lastClosedYear: number | null = null, stored = g.stored) =>
  buildStatement({
    assets: g.assets,
    rule: (a) => g.rules.get(a.id)!,
    stored,
    lastClosedYear,
    year,
  });

const sum = (rows: AssetFigureRow[], k: keyof Omit<AssetFigureRow, "assetId">) =>
  rows.reduce((t, r) => t + r[k], 0);

describe("invariants over generated asset sets", () => {
  for (const [name, rule] of [["CH rule", CH], ["IT rule", IT]] as const) {
    it(`${name}: closing = opening - disposals + purchases - depreciation, lines = per-asset sums, opening(Y+1) = closing(Y)`, () => {
      for (let seed = 1; seed <= 150; seed++) {
        const g = generate(seed, rule);
        let previousClosing: number | null = null;
        for (let year = 2021; year <= 2036; year++) {
          const { lines, rows } = statementOf(g, year);
          expect(lines.closingCents).toBe(
            lines.openingCents - lines.disposalsCents + lines.purchasesCents - lines.depreciationCents,
          );
          expect(lines.openingCents).toBe(sum(rows, "openingCents"));
          expect(lines.disposalsCents).toBe(sum(rows, "disposalCents"));
          expect(lines.purchasesCents).toBe(sum(rows, "purchaseCents"));
          expect(lines.depreciationCents).toBe(sum(rows, "depreciationCents"));
          expect(lines.closingCents).toBe(sum(rows, "closingCents"));
          for (const row of rows) {
            expect(row.closingCents).toBe(
              row.openingCents - row.disposalCents + row.purchaseCents - row.depreciationCents,
            );
            expect(row.closingCents).toBeGreaterThanOrEqual(0);
          }
          if (previousClosing !== null) expect(lines.openingCents).toBe(previousClosing);
          previousClosing = lines.closingCents;
        }
      }
    });
  }

  it("a disposed asset: disposals carries its start-of-year book value (or price if bought that year), then zero forever (AC-7.2, 7.7)", () => {
    const asset: RollAsset = {
      id: "d",
      purchaseDate: date("2024-03-01"),
      purchasePriceCents: 99815,
      disposedOn: date("2026-02-01"),
      legacyImported: false,
    };
    const g = { assets: [asset], rules: new Map([["d", CH]]), stored: [] };
    const y2025 = statementOf(g, 2025);
    const y2026 = statementOf(g, 2026);
    expect(y2026.lines.openingCents).toBe(y2025.lines.closingCents);
    expect(y2026.lines.disposalsCents).toBe(y2025.lines.closingCents);
    expect(y2026.lines.depreciationCents).toBe(0);
    expect(y2026.lines.closingCents).toBe(0);
    const y2027 = statementOf(g, 2027);
    expect(y2027.rows).toEqual([]);
    expect(y2027.lines).toEqual({
      openingCents: 0,
      disposalsCents: 0,
      purchasesCents: 0,
      depreciationCents: 0,
      closingCents: 0,
    });

    const sameYear = { ...asset, id: "s", purchaseDate: date("2026-01-10"), disposedOn: date("2026-12-31") };
    const gs = { assets: [sameYear], rules: new Map([["s", CH]]), stored: [] };
    expect(statementOf(gs, 2026).lines).toEqual({
      openingCents: 0,
      disposalsCents: 99815,
      purchasesCents: 99815,
      depreciationCents: 0,
      closingCents: 0,
    });
  });

  it("a threshold-expensed IT asset appears as purchase and depreciation of the same year, and no row afterwards", () => {
    const asset: RollAsset = {
      id: "t",
      purchaseDate: date("2026-05-01"),
      purchasePriceCents: 30000,
      disposedOn: null,
      legacyImported: false,
    };
    const g = { assets: [asset], rules: new Map([["t", IT]]), stored: [] };
    expect(statementOf(g, 2026).lines).toEqual({
      openingCents: 0,
      disposalsCents: 0,
      purchasesCents: 30000,
      depreciationCents: 30000,
      closingCents: 0,
    });
    expect(statementOf(g, 2027).rows).toEqual([]);
  });

  it("the sale price changes no line (AC-7.3): the builder has no such input and equal assets give equal statements", () => {
    const base: RollAsset = {
      id: "p",
      purchaseDate: date("2025-02-01"),
      purchasePriceCents: 120000,
      disposedOn: date("2026-09-01"),
      legacyImported: false,
    };
    const g = { assets: [base], rules: new Map([["p", CH]]), stored: [] };
    // RollAsset carries no sale price at all; extra properties are inert.
    const withPrice = { ...base, salePriceCents: 90000 } as RollAsset;
    const g2 = { assets: [withPrice], rules: new Map([["p", CH]]), stored: [] };
    expect(statementOf(g2, 2026)).toEqual(statementOf(g, 2026));
  });
});

describe("closed years are read from stored rows, never recomputed", () => {
  const asset: RollAsset = {
    id: "c",
    purchaseDate: date("2024-03-01"),
    purchasePriceCents: 99815,
    disposedOn: null,
    legacyImported: false,
  };
  const g = { assets: [asset], rules: new Map([["c", CH]]), stored: [] as StoredFigureRow[] };

  const asStored = (year: number): StoredFigureRow[] =>
    statementOf(g, year).rows.map((r) => ({ ...r, year, source: "closed" as const }));

  it("a closed year returns exactly the stored rows even when the rule would now say otherwise", () => {
    const stored = asStored(2024);
    const changed = { ...g, rules: new Map([["c", { ...CH, usefulLifeYears: 10 }]]) };
    const closed = statementOf(changed, 2024, 2024, stored);
    expect(closed.rows).toEqual(statementOf(g, 2024).rows);
  });

  it("opening of the next year is the STORED closing, even if the formula would drift (AC-8.3)", () => {
    const stored = asStored(2024).map((r) => ({ ...r, closingCents: r.closingCents - 1234 }));
    const next = statementOf(g, 2025, 2024, stored);
    expect(next.lines.openingCents).toBe(stored[0]!.closingCents);
    expect(next.lines.closingCents).toBe(
      next.lines.openingCents - next.lines.disposalsCents + next.lines.purchasesCents - next.lines.depreciationCents,
    );
    // and the chain carries on from there, not from the formula
    const after = statementOf(g, 2026, 2024, stored);
    expect(after.lines.openingCents).toBe(next.lines.closingCents);
  });

  it("without drift, closing a year and computing the next from the stored rows gives the same figures as computing straight through", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const gen = generate(seed, seed % 2 ? CH : IT);
      for (let closedYear = 2022; closedYear <= 2030; closedYear++) {
        const stored: StoredFigureRow[] = [];
        for (let y = 2018; y <= closedYear; y++) {
          for (const r of statementOf(gen, y).rows) stored.push({ ...r, year: y, source: "closed" });
        }
        for (const year of [closedYear + 1, closedYear + 2]) {
          expect(statementOf(gen, year, closedYear, stored)).toEqual(statementOf(gen, year));
        }
      }
    }
  });

  it("a closed year with no stored row for an asset leaves it out", () => {
    expect(statementOf(g, 2024, 2025, []).rows).toEqual([]);
  });
});

describe("imported history (plan R-2, AC-12.2, AC-12.5)", () => {
  const legacy: RollAsset = {
    id: "l",
    purchaseDate: date("2023-04-01"),
    purchasePriceCents: 99815,
    disposedOn: null,
    legacyImported: true,
  };
  const row = (year: number, closingCents: number): StoredFigureRow => ({
    assetId: "l",
    year,
    openingCents: 0,
    purchaseCents: 0,
    depreciationCents: 0,
    disposalCents: 0,
    closingCents,
    source: "imported",
  });
  const g = { assets: [legacy], rules: new Map([["l", CH]]) };

  it("closing-only imported rows are shown as they are for closed years and invent no depreciation", () => {
    const stored = [row(2023, 53255), row(2024, 53255)];
    const y = statementOf({ ...g, stored }, 2024, 2025, stored);
    expect(y.rows).toEqual([
      { assetId: "l", openingCents: 0, purchaseCents: 0, depreciationCents: 0, disposalCents: 0, closingCents: 53255 },
    ]);
  });

  it("an open year after the anchor continues from the stored closing (the anchor vector: 26578 then 26577)", () => {
    const stored = [row(2023, 53255)];
    const y2025 = statementOf({ ...g, stored }, 2024, 2023, stored);
    expect(y2025.lines).toEqual({
      openingCents: 53255,
      disposalsCents: 0,
      purchasesCents: 0,
      depreciationCents: 26578,
      closingCents: 26677,
    });
    const y2026 = statementOf({ ...g, stored }, 2025, 2023, stored);
    expect(y2026.lines.depreciationCents).toBe(26577);
    expect(y2026.lines.closingCents).toBe(100);
  });

  it("does not throw when a legacy asset has no stored row at all", () => {
    expect(() => statementOf({ ...g, stored: [] }, 2026, null, [])).not.toThrow();
  });
});

describe("a missing rule is an error, not a silently short statement", () => {
  it("throws", () => {
    const a: RollAsset = { id: "x", purchaseDate: date("2026-01-01"), purchasePriceCents: 1000, disposedOn: null, legacyImported: false };
    expect(() =>
      buildStatement({ assets: [a], rule: () => { throw new Error("no rule"); }, stored: [], lastClosedYear: null, year: 2026 }),
    ).toThrow("no rule");
  });
});
