import { describe, it, expect } from "bun:test";
import { parseSheet } from "./parse";
import { buildPlan, categoryOf, normaliseName, type PlanInput, type PlannedAsset } from "./plan";
import { FIXTURE, fixtureRows, toSheetRows, row, type FixtureRows } from "./testFixture";
import { reconcile, formatCents } from "./report";

const RULE = { usefulLifeYears: 3, residualCents: 100 };
function plan(mutate?: (rows: FixtureRows) => void, over: Partial<PlanInput> = {}) {
  const rows = fixtureRows();
  mutate?.(rows);
  const parsed = parseSheet(toSheetRows(rows));
  return { parsed, plan: buildPlan({ parsed, users: [...FIXTURE.users], ruleFor: () => RULE, ...over }) };
}
const errorsOf = (p: ReturnType<typeof plan>) => p.plan.issues.filter((i) => i.kind === "error");
const assetsOfRow = (p: ReturnType<typeof plan>, r: number) => p.plan.assets.filter((a) => a.sheetRow === r);
const figure = (a: PlannedAsset, year: number) => a.figures.find((f) => f.year === year);

describe("the plan for the fixture", () => {
  const p = plan();

  it("is readable, and skips exactly the spec O5 cases", () => {
    expect(errorsOf(p)).toEqual([]);
    expect(p.plan.issues.map((i) => [i.kind, i.row, i.code])).toEqual([
      ["skipped", 7, "o5_undecided"],
      ["skipped", 13, "o5_cession_unmatched"],
    ]);
    expect(p.plan.stats.assets).toBe(FIXTURE.importedAssets);
    expect(p.plan.stats.importedRows).toBe(7);
  });

  it("AC-12.1 splits the 13-unit row with splitPrice: the sum is exact, the remainder is on the last unit", () => {
    const units = assetsOfRow(p, FIXTURE.multiUnitRow);
    expect(units).toHaveLength(13);
    expect(units.map((u) => u.unit)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    const prices = units.map((u) => u.priceCents);
    expect(prices.reduce((s, x) => s + x, 0)).toBe(FIXTURE.multiUnitPriceCents);
    expect(new Set(prices.slice(0, 12)).size).toBe(1);
    expect(prices[12]! - prices[0]!).toBe(FIXTURE.multiUnitPriceCents % 13);
    expect(p.plan.stats.multiUnitRows).toEqual([{ row: 6, units: 13 }]);
  });

  it("AC-12.2 every figure of the 13 units adds back to the sheet's amount, cell by cell", () => {
    const units = assetsOfRow(p, 6);
    const sum = (year: number, k: "openingCents" | "purchaseCents" | "depreciationCents" | "closingCents") =>
      units.reduce((s, u) => s + figure(u, year)![k], 0);
    expect(sum(2024, "purchaseCents")).toBe(294_635);
    expect(sum(2024, "depreciationCents")).toBe(98_178);
    expect(sum(2024, "closingCents")).toBe(196_457);
    expect(sum(2025, "openingCents")).toBe(196_457);
    expect(sum(2025, "depreciationCents")).toBe(98_178);
    expect(sum(2025, "closingCents")).toBe(98_279);
  });

  it("AC-12.2 imports the sheet's depreciation and book values as stated, not recomputed", () => {
    const r3 = assetsOfRow(p, 3)[0]!;
    expect(r3.figures).toEqual([
      { year: 2023, openingCents: 60_033, purchaseCents: 0, depreciationCents: 0, disposalCents: 0, closingCents: 60_033 },
      { year: 2024, openingCents: 60_033, purchaseCents: 0, depreciationCents: 29_967, disposalCents: 0, closingCents: 30_066 },
      { year: 2025, openingCents: 30_066, purchaseCents: 0, depreciationCents: 29_966, disposalCents: 0, closingCents: 100 },
    ]);
    // A rule would have given 33,272 / 33,272 / 33,271 on a 99,815 asset; the sheet's own amounts win.
    const r4 = assetsOfRow(p, 4)[0]!;
    expect(r4.figures.map((f) => f.year)).toEqual([2024, 2025]);
    expect(figure(r4, 2024)).toMatchObject({ openingCents: 0, purchaseCents: 120_000, depreciationCents: 39_967, closingCents: 80_033 });
  });

  it("a blank 2025 value that depreciates to zero is a closing value of 0 (spec O4), and is counted", () => {
    const r2 = assetsOfRow(p, 2)[0]!;
    expect(figure(r2, 2025)).toMatchObject({ openingCents: 100, depreciationCents: 100, closingCents: 0 });
    expect(p.plan.stats.blankClosingAsZeroRows).toBe(2); // rows 2 and 9
  });

  it("opening is the previous closing; a row that does not foot by a cent keeps every sheet amount and is counted", () => {
    const r8 = assetsOfRow(p, 8)[0]!;
    expect(figure(r8, 2025)).toEqual({ year: 2025, openingCents: 0, purchaseCents: 70_000, depreciationCents: 23_333, disposalCents: 0, closingCents: 46_668 });
    expect(p.plan.stats.footResiduals).toEqual({ rowYears: 1, netCents: -1 });
  });

  it("2023 carries only the closing value; fiscal years 2024 and 2025 are the sums of the rows", () => {
    const [fy24, fy25] = p.plan.fiscalYears;
    expect(p.plan.stats.closingByYear[2023]).toBe(40_000 + 60_033 + 30_000);
    expect(fy24).toEqual({
      year: 2024,
      openingCents: 40_000 + 60_033 + 30_000,
      disposalsCents: 0,
      purchasesCents: 120_000 + 294_635,
      depreciationCents: 39_900 + 29_967 + 39_967 + 98_178 + 29_900,
      closingCents: 100 + 30_066 + 80_033 + 196_457 + 100,
    });
    expect(fy25?.openingCents).toBe(fy24!.closingCents);
    expect(fy25?.purchasesCents).toBe(70_000);
    expect(fy25?.closingCents).toBe(FIXTURE.closing2025Cents);
    expect(p.plan.stats.closingByYear[2025]).toBe(FIXTURE.closing2025Cents);
  });

  it("assets bought in 2026 carry no imported figures", () => {
    expect(assetsOfRow(p, 5)[0]!.figures).toEqual([]);
  });

  it("AC-12.6 / AC-12.7 holders: one exact match assigns; no text, no match and two matches do not", () => {
    const r2 = assetsOfRow(p, 2)[0]!;
    expect(r2).toMatchObject({ status: "assigned", holderUserId: "u-ada", toVerify: false, locationNote: null });
    expect(assetsOfRow(p, 4)[0]).toMatchObject({ status: "in_stock", holderUserId: null, toVerify: true, locationNote: null });
    expect(assetsOfRow(p, 3)[0]).toMatchObject({ status: "in_stock", holderUserId: null, toVerify: true, locationNote: "Nobody Known" });
    expect(assetsOfRow(p, 8)[0]).toMatchObject({ status: "in_stock", holderUserId: null, toVerify: true, locationNote: "Twin Name" });
    expect(p.plan.stats.assigneeUnmatchedRows).toEqual([3, 8]);
    expect(p.plan.stats.assigneeMatched).toBe(2);
  });

  it("AC-12.9 the order not received is `ordered` with no serial, and its assignee text is only a note", () => {
    expect(assetsOfRow(p, 5)[0]).toMatchObject({
      status: "ordered",
      serialNumber: null,
      holderUserId: null,
      toVerify: false,
      locationNote: "Ada Synthetic",
    });
  });

  it("AC-12.8 a cession disposes of the asset its serial names in 2026 and creates no asset", () => {
    const r9 = assetsOfRow(p, 9)[0]!;
    expect(r9).toMatchObject({ status: "disposed", holderUserId: null, toVerify: false });
    expect(r9.disposal).toEqual({ date: "2026-03-15", salePriceCents: 100 });
    expect(p.plan.stats.disposals).toBe(1);
    expect(p.plan.assets.filter((a) => a.disposal)).toHaveLength(1);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(plan().plan)).toBe(JSON.stringify(p.plan));
  });
});

describe("what makes it stop (errors, with the row number)", () => {
  const cases: [string, (rows: FixtureRows) => void, number, string][] = [
    ["a value larger than the price", (r) => void (r.get(3)![5] = 9000), 3, "unreadable_figures"],
    ["a row that does not foot by more than a cent", (r) => void (r.get(3)![7] = 400), 3, "unreadable_figures"],
    ["a missing depreciation", (r) => void (r.get(3)![8] = null), 3, "unreadable_figures"],
    ["an old row with no 2023 value but later figures", (r) => void (r.get(3)![5] = null), 3, "unreadable_figures"],
    ["a blank 2025 value that does not depreciate to zero", (r) => void (r.get(2)![8] = 0.5), 2, "unreadable_figures"],
    ["a 2025 purchase carrying 2024 figures", (r) => void (r.get(8)![6] = 5), 8, "unreadable_figures"],
    ["a 2026 purchase carrying 2025 figures", (r) => void (r.get(5)![9] = 5), 5, "unreadable_figures"],
    ["a purchase after 2026", (r) => void (r.get(5)![0] = "01.01.2027"), 5, "unreadable_figures"],
    ["a terminal value that is not whole residuals", (r) => void (r.get(6)![11] = 13.5), 6, "unreadable_units"],
    ["a serial on a multi-unit row", (r) => void (r.get(6)![2] = "SYN-X"), 6, "serial_on_multi_unit"],
    ["a repeated serial", (r) => void (r.get(4)![2] = "syn-a"), 4, "duplicate_serial"],
    ["a cession without a serial", (r) => void (r.get(12)![2] = null), 12, "cession_without_serial"],
    ["a cession outside 2026", (r) => void (r.get(12)![0] = "15.03.2025"), 12, "cession_year"],
    ["two cessions of one asset", (r) => void r.set(14, row({ A: new Date("2026-05-01T00:00:00Z"), B: "X, cessione", C: "SYN-CEDE", E: 1 })), 14, "cession_twice"],
  ];
  for (const [name, mutate, at, code] of cases) {
    it(name, () => {
      expect(errorsOf(plan(mutate)).map((i) => [i.row, i.code])).toContainEqual([at, code]);
    });
  }

  it("no rule in force for a purchase date", () => {
    const p = plan(undefined, { ruleFor: () => null });
    expect(errorsOf(p).map((i) => i.code)).toContain("no_rule");
  });

  it("a cession dated before the purchase", () => {
    const p = plan((r) => {
      r.get(5)![2] = "SYN-E"; // the 2026 purchase, bought 2026-02-10
      r.get(12)![2] = "SYN-E";
      r.get(12)![0] = new Date("2026-01-01T00:00:00Z");
    });
    expect(errorsOf(p).map((i) => i.code)).toContain("cession_before_purchase");
  });

  it("an error leaves the other rows planned (the report can show them all)", () => {
    const p = plan((r) => void (r.get(3)![0] = "31.02.2024"));
    expect(p.plan.assets.length).toBeGreaterThan(0);
  });
});

describe("units", () => {
  it("a terminal value of one residual is one unit; a whole multiple is that many", () => {
    const p = plan();
    expect(assetsOfRow(p, 4)).toHaveLength(1);
    expect(assetsOfRow(p, 6)).toHaveLength(13);
  });

  it("uses the rule's own life and residual", () => {
    // Five years, CHF 2.00 residual: row 6 is 2024 + 5 - 1 = 2028 (no value there) -> one unit, not 13.
    const p = plan(undefined, { ruleFor: () => ({ usefulLifeYears: 5, residualCents: 200 }) });
    expect(assetsOfRow(p, 6)).toHaveLength(1);
  });

  it("more than 200 units is refused", () => {
    const p = plan((r) => void (r.get(6)![11] = 250));
    expect(errorsOf(p).map((i) => i.code)).toContain("unreadable_units");
  });
});

describe("names and categories", () => {
  it("compares names without case, accents or spacing", () => {
    expect(normaliseName("  Àda   SYNTHÉTIC ")).toBe("ada synthetic");
    expect(normaliseName("Ada Synthetic")).toBe(normaliseName("ada  synthétic"));
    expect(normaliseName("Ada Synthetic")).not.toBe(normaliseName("Synthetic Ada"));
  });

  it("a user with a blank name never matches a blank assignee", () => {
    const p = plan(undefined, { users: [{ id: "u", name: "   " }, ...FIXTURE.users] });
    expect(assetsOfRow(p, 4)[0]!.holderUserId).toBeNull();
  });

  it("guesses a category from the description, else other", () => {
    expect(categoryOf("Apple MacBook Pro 14")).toBe("laptop");
    expect(categoryOf("Dell UltraSharp monitor")).toBe("monitor");
    expect(categoryOf("iPhone 13")).toBe("phone");
    expect(categoryOf("iPad Air")).toBe("tablet");
    expect(categoryOf("Logitech keyboard")).toBe("peripheral");
    expect(categoryOf("Something unrecognised")).toBe("other");
  });
});

describe("reconciliation with the sheet's own totals (spec O3)", () => {
  it("reports a block that does not agree with the per-asset columns, and one that does", () => {
    const p = plan();
    const { lines, notCompared } = reconcile(p.parsed, p.plan);
    const byWhat = (needle: string) => lines.find((l) => l.what.includes(needle))!;
    expect(byWhat("31.12.2025").ok).toBe(false);
    expect(byWhat("31.12.2025").sheetCents).toBe(9_999_999);
    expect(byWhat("31.12.2025").computedCents).toBe(FIXTURE.closing2025Cents + 0); // the column sum
    expect(byWhat("Acquisti").ok).toBe(false);
    expect(byWhat("Acquisti").computedCents).toBe(50_000);
    expect(byWhat("column total").ok).toBe(true);
    expect(notCompared).toEqual([]);
  });

  it("formats cents", () => {
    expect(formatCents(2168899)).toBe("21,688.99");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(-123456)).toBe("-1,234.56");
  });
});
