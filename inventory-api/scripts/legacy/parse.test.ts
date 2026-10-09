import { describe, it, expect } from "bun:test";
import { parseDateCell, parseSheet } from "./parse";
import { fixtureRows, toSheetRows, row, utc, type FixtureRows } from "./testFixture";

const parse = (mutate?: (rows: FixtureRows) => void) => {
  const rows = fixtureRows();
  mutate?.(rows);
  return parseSheet(toSheetRows(rows));
};
const errors = (p: ReturnType<typeof parse>) => p.issues.filter((i) => i.kind === "error");

describe("dates", () => {
  it("reads typed dates and dd.mm.yyyy text, and nothing else", () => {
    expect(parseDateCell(utc("2024-01-31"))).toBe("2024-01-31");
    expect(parseDateCell("04.01.2024")).toBe("2024-01-04");
    expect(parseDateCell(" 4.1.2024 ")).toBe("2024-01-04");
    for (const bad of ["31.02.2024", "2024-01-04", "04/01/2024", "32.01.2024", "00.01.2024", "", "x", 45000, null, new Date("invalid"), new Date("2024-01-04T10:00:00Z"), "01.01.1999"]) {
      expect(parseDateCell(bad)).toBeNull();
    }
  });
});

describe("the regions of the sheet", () => {
  it("separates purchases, the column total, cessions and the year-end block", () => {
    const p = parse();
    expect(errors(p)).toEqual([]);
    expect(p.purchases.map((r) => r.row)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(p.totals).toEqual([{ row: 10, column: "I", cents: 191_644 }]);
    expect(p.cessions.map((c) => [c.row, c.serial, c.priceCents, c.date])).toEqual([
      [12, "SYN-CEDE", 100, "2026-03-15"],
      [13, "SYN-NOMATCH", 100, "2026-04-01"],
    ]);
    expect(p.yearEnd.map((l) => [l.row, l.cents])).toEqual([
      [15, 9_999_999],
      [16, 77_700],
    ]);
  });

  it("decodes a purchase row exactly: text date, serial, assignee, cents, formula result", () => {
    const p = parse();
    const r2 = p.purchases.find((r) => r.row === 2)!;
    expect(r2).toMatchObject({
      purchaseDate: "2022-03-15",
      description: "Synthetic MacBook Pro 14 A",
      serial: "SYN-A",
      ordered: false,
      assigneeText: "Ada Synthetic",
      priceCents: 150_000,
    });
    expect(r2.closing).toEqual({ 2023: 40_000, 2024: 100 });
    expect(r2.depreciation).toEqual({ 2024: 39_900, 2025: 100 });
    expect(p.purchases.find((r) => r.row === 4)!.closing[2025]).toBe(40_066); // a formula cell
  });

  it("marks the order not yet received and gives it no serial", () => {
    const r5 = parse().purchases.find((r) => r.row === 5)!;
    expect(r5).toMatchObject({ ordered: true, serial: null });
  });

  it("a blank row inside the purchases ends them: what follows is not silently a purchase", () => {
    const p = parse((rows) => {
      rows.delete(5);
    });
    expect(errors(p).map((i) => [i.row, i.code])).toContainEqual([6, "unclassified_row"]);
  });

  it("does not keep the free text of a cession row", () => {
    const p = parse();
    expect(JSON.stringify(p)).not.toContain("Synthetic Person");
    expect(JSON.stringify(p)).not.toContain("Other Person");
  });
});

describe("what it refuses, with the row number", () => {
  const cases: [string, (rows: FixtureRows) => void, number, string][] = [
    ["a header that is not this sheet's", (r) => void (r.get(1)![4] = "Prezzo"), 1, "header_mismatch"],
    ["an impossible date", (r) => void (r.get(3)![0] = "31.02.2024"), 3, "bad_date"],
    ["a date given as a number", (r) => void (r.get(3)![0] = 45000), 3, "bad_date"],
    ["a non-text description", (r) => void (r.get(3)![1] = 12), 3, "bad_description"],
    ["a serial stored as a number", (r) => void (r.get(3)![2] = 355_000_000_000_000), 3, "bad_serial"],
    ["a text price", (r) => void (r.get(3)![4] = "1.200,00"), 3, "bad_amount"],
    ["a missing price", (r) => void (r.get(3)![4] = null), 3, "bad_amount"],
    ["a zero price", (r) => void (r.get(3)![4] = 0), 3, "bad_amount"],
    ["a negative depreciation", (r) => void (r.get(3)![6] = -1), 3, "bad_amount"],
    ["text in a value column", (r) => void (r.get(3)![7] = "n/a"), 3, "bad_amount"],
    ["a cession without a date", (r) => void (r.get(12)![0] = "soon"), 12, "bad_date"],
    ["a stray row below the purchases", (r) => void r.set(18, row({ B: "something else" })), 18, "unclassified_row"],
  ];
  for (const [name, mutate, at, code] of cases) {
    it(name, () => {
      const p = parse(mutate);
      expect(errors(p).map((i) => [i.row, i.code])).toContainEqual([at, code]);
    });
  }

  it("a header mismatch stops everything else being read", () => {
    const p = parse((r) => void (r.get(1)![0] = "Date"));
    expect(p.purchases).toEqual([]);
    expect(errors(p)).toHaveLength(1);
  });

  it("error messages never echo cell content", () => {
    const p = parse((r) => {
      r.get(3)![4] = "SECRET-AMOUNT";
      r.get(4)![0] = "SECRET-DATE";
    });
    expect(JSON.stringify(p.issues)).not.toContain("SECRET");
  });
});
