/**
 * The operator's report for the legacy import (T23). Aggregates and sheet row
 * numbers only: no description, serial, price of a single row, or person's name
 * is ever printed - the report is meant to be pasted into a ticket.
 */

import type { ParsedSheet } from "./types";
import { CLOSED_YEARS, ENTITY, FIRST_FIGURE_YEAR, LAST_IMPORTED_YEAR, type Plan } from "./plan";

/** `1234567` -> `12,345.67` (a leading `-` for negatives). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export interface Reconciliation {
  readonly what: string;
  readonly sheetCents: number;
  readonly computedCents: number;
  readonly ok: boolean;
}

/** Compares the sheet's own year-end block and column total against the per-asset columns (spec O3). */
export function reconcile(parsed: ParsedSheet, plan: Plan): { lines: Reconciliation[]; notCompared: number[] } {
  const sums = plan.stats.sheetColumnSums;
  const lines: Reconciliation[] = [];
  const notCompared: number[] = [];
  for (const line of parsed.yearEnd) {
    const closing = /bilancio al 31\.12\.(\d{4})/i.exec(line.label);
    const purchases = /acquisti.*?(\d{4})/i.exec(line.label);
    const depreciation = /ammortamento\s+(\d{4})/i.exec(line.label);
    let computed: number | undefined;
    if (closing) computed = sums.closing[Number(closing[1])];
    else if (purchases) computed = sums.purchasesByYear[Number(purchases[1])];
    else if (depreciation) computed = sums.depreciation[Number(depreciation[1])];
    if (computed === undefined) {
      notCompared.push(line.row);
      continue;
    }
    lines.push({ what: `"${line.label}" (row ${line.row})`, sheetCents: line.cents, computedCents: computed, ok: line.cents === computed });
  }
  const columnYear: Record<string, number> = { G: 2024, I: 2025, K: 2026, M: 2027, O: 2028 };
  for (const t of parsed.totals) {
    const year = columnYear[t.column];
    if (year === undefined) {
      notCompared.push(t.row);
      continue;
    }
    lines.push({
      what: `column total "Ammortamento ${year}" (${t.column}${t.row})`,
      sheetCents: t.cents,
      computedCents: sums.depreciation[year] ?? 0,
      ok: t.cents === (sums.depreciation[year] ?? 0),
    });
  }
  return { lines, notCompared };
}

export interface ReportInput {
  readonly mode: "dry-run" | "apply";
  readonly parsed: ParsedSheet;
  readonly plan: Plan;
  readonly expectedCents: number | undefined;
}

export function renderReport({ mode, parsed, plan, expectedCents }: ReportInput): string[] {
  const s = plan.stats;
  const out: string[] = [];
  const errors = plan.issues.filter((i) => i.kind === "error");
  const skipped = plan.issues.filter((i) => i.kind === "skipped");

  out.push(`Legacy register import - ${ENTITY} - ${mode === "apply" ? "APPLY" : "DRY RUN (nothing is written)"}`);
  out.push(
    `Sheet: ${s.purchaseRows} purchase rows, ${parsed.cessions.length} cession rows, ${parsed.yearEnd.length} year-end lines, ${parsed.totals.length} column total(s)`,
  );
  out.push(`Rows: ${s.importedRows} imported, ${skipped.filter((i) => i.code === "o5_undecided").length} skipped (spec O5), ${errors.length} unreadable`);
  out.push(`Assets to create: ${s.assets}`);
  if (s.multiUnitRows.length > 0) {
    out.push(`  multi-unit rows: ${s.multiUnitRows.map((m) => `row ${m.row} -> ${m.units} units`).join(", ")}`);
  } else {
    out.push("  multi-unit rows: none");
  }
  out.push(`  status: ${Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  out.push(`  flagged "to verify": ${s.toVerify}`);
  out.push(`  assignee matched exactly one user (rows): ${s.assigneeMatched}; assignee text kept as a note (rows): ${s.assigneeUnmatchedRows.length}`);
  out.push(`  category (guessed from the description, editable): ${Object.entries(s.byCategory).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  out.push(`  disposals applied (${LAST_IMPORTED_YEAR + 1} cessions): ${s.disposals}`);

  out.push("Figures (the sheet's amounts, each rounded half-up to the cent):");
  out.push(`  ${FIRST_FIGURE_YEAR}  closing ${formatCents(s.closingByYear[FIRST_FIGURE_YEAR] ?? 0)}  (closing values only, plan R-2; not a fiscal-year row)`);
  for (const fy of plan.fiscalYears) {
    out.push(
      `  ${fy.year}  opening ${formatCents(fy.openingCents)}  purchases ${formatCents(fy.purchasesCents)}  depreciation ${formatCents(fy.depreciationCents)}  closing ${formatCents(fy.closingCents)}  -> closed fiscal year`,
    );
  }
  out.push(`  rows whose "Valore al 31.12.2025" is blank and depreciate to exactly zero (spec O4): ${s.blankClosingAsZeroRows}`);
  out.push(
    `  row-years that do not foot by a cent (sub-cent fractions in the sheet's cells): ${s.footResiduals.rowYears}, net ${s.footResiduals.netCents} cents; ` +
      `lines may therefore differ from opening + purchases - depreciation by a few cents`,
  );

  const { lines, notCompared } = reconcile(parsed, plan);
  out.push("Sheet's own totals against its per-asset columns (informational, spec O3; never blocks):");
  for (const l of lines) {
    out.push(
      `  ${l.ok ? "agrees " : "DIFFERS"} ${l.what}: sheet ${formatCents(l.sheetCents)}, per-asset sum ${formatCents(l.computedCents)}` +
        (l.ok ? "" : ` (difference ${formatCents(l.sheetCents - l.computedCents)})`),
    );
  }
  if (notCompared.length > 0) out.push(`  not compared (unlabelled): rows ${notCompared.join(", ")}`);

  if (skipped.length > 0) {
    out.push("Skipped, not imported (spec O5 leaves them undecided):");
    for (const i of skipped) out.push(`  row ${i.row}: ${i.message}`);
  }
  if (errors.length > 0) {
    out.push("CANNOT INTERPRET - the import stops here:");
    for (const i of errors) out.push(`  row ${i.row} [${i.code}]: ${i.message}`);
  }

  const total = s.closingByYear[LAST_IMPORTED_YEAR] ?? 0;
  out.push(`Opening balance 2026 (sum of closing values at 31.12.${LAST_IMPORTED_YEAR}): ${formatCents(total)} (${total} cents)`);
  if (expectedCents === undefined) out.push("  expected balance: not given, not checked");
  else if (expectedCents === total) out.push(`  matches the expected balance ${formatCents(expectedCents)}`);
  else out.push(`  DOES NOT MATCH the expected balance ${formatCents(expectedCents)} (${expectedCents} cents), difference ${formatCents(total - expectedCents)}`);
  out.push(`Fiscal years to close: ${CLOSED_YEARS.join(", ")}`);
  return out;
}
