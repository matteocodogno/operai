/**
 * Unit tests for `computeSubtotals` (T7, specs/009-mileage-rate, AC-6.2) —
 * pure, DB-free (Vitest-equivalent bun:test, no Prisma/HTTP).
 *
 * AC-6.2: a `travel_km` line's (computed, or once snapshotted, fixed)
 * amount contributes to the SAME per-currency subtotal as any other line
 * sharing that currency — there is no separate mileage grouping or subtotal.
 * `computeSubtotals` reads straight off each `LineRow.requestedAmountCents`/
 * `currency` regardless of `type` — this test proves NO mileage
 * special-case exists in that function.
 */

import { describe, expect, it } from "bun:test";
import { computeSubtotals, type LineRow } from "./requests.service";

function line(overrides: Partial<LineRow> & Pick<LineRow, "currency" | "requestedAmountCents">): LineRow {
  return {
    id: "l1",
    date: new Date("2026-06-01T00:00:00.000Z"),
    type: "office_material",
    motivo: "test",
    entity: "welld_ch",
    km: null,
    approvedTotalCents: null,
    ...overrides,
  };
}

describe("computeSubtotals — travel_km lines fold into the same per-currency group (AC-6.2)", () => {
  it("a travel_km line's amount sums into the SAME CHF group as an ordinary CHF line", () => {
    const lines: LineRow[] = [
      line({ id: "a", currency: "CHF", requestedAmountCents: 5000, type: "office_material" }),
      line({
        id: "b",
        currency: "CHF",
        requestedAmountCents: 16800,
        type: "travel_km",
        km: 240,
      }),
    ];
    const subtotals = computeSubtotals(lines);
    expect(subtotals).toHaveLength(1); // ONE group, not a separate mileage group
    expect(subtotals[0]?.currency).toBe("CHF");
    expect(subtotals[0]?.requestedCents).toBe(5000 + 16800);
  });

  it("mixed currencies still never blend — mileage in CHF, ordinary in EUR", () => {
    const lines: LineRow[] = [
      line({ id: "a", currency: "EUR", requestedAmountCents: 1000, type: "postal" }),
      line({ id: "b", currency: "CHF", requestedAmountCents: 7000, type: "travel_km", km: 100 }),
    ];
    const subtotals = computeSubtotals(lines);
    expect(subtotals).toHaveLength(2);
    const chf = subtotals.find((s) => s.currency === "CHF");
    const eur = subtotals.find((s) => s.currency === "EUR");
    expect(chf?.requestedCents).toBe(7000);
    expect(eur?.requestedCents).toBe(1000);
  });

  it("approvedCents aggregation includes a travel_km line's approved total exactly like any other line", () => {
    const lines: LineRow[] = [
      line({
        id: "a",
        currency: "CHF",
        requestedAmountCents: 16800,
        approvedTotalCents: 15000,
        type: "travel_km",
        km: 240,
      }),
      line({
        id: "b",
        currency: "CHF",
        requestedAmountCents: 5000,
        approvedTotalCents: 5000,
        type: "office_material",
      }),
    ];
    const subtotals = computeSubtotals(lines);
    expect(subtotals[0]?.approvedCents).toBe(15000 + 5000);
  });
});
