/**
 * Turns the decoded sheet into the exact set of rows the import would write
 * (T23, specs/015-hardware-inventory; US-12, ADR-0046). Pure: no database, no
 * clock, no I/O, so the dry-run and the apply are the same computation and a
 * test can check every figure.
 *
 * What the sheet gives and how it is read (plan R-2):
 *   - past years' book values and depreciation are the sheet's own amounts,
 *     each rounded half-up to the cent ONCE (AC-12.2) - never recomputed;
 *   - before 2024 only a closing value exists (the "Valore al 31.12.2023"
 *     column), stored as that year's closing with no movements;
 *   - `opening` is not a sheet amount: it is the previous year's closing (0 in
 *     the purchase year), so opening(Y+1) = closing(Y) holds exactly. The sheet
 *     rounds its sub-cent fractions per cell, so a row can then fail to foot by
 *     a cent; that residual is counted in the report, never hidden by moving a
 *     sheet amount.
 *   - years 2024 and 2025 become closed fiscal years (AC-12.3), their lines the
 *     sums of the per-asset rows.
 *
 * Nothing is guessed. A row that cannot be interpreted is an `error` issue with
 * its sheet row number; the three cases spec O5 leaves undecided are `skipped`
 * issues (reported, not imported).
 */

import { splitPrice } from "../../src/depreciation/money";
import type { CessionRow, Issue, ParsedSheet, PurchaseRow } from "./types";

export const ENTITY = "welld_ch" as const;
export const FIRST_FIGURE_YEAR = 2023;
/** The last year the sheet states as a fact; later years are computed by the module. */
export const LAST_IMPORTED_YEAR = 2025;
export const CLOSED_YEARS = [2024, 2025] as const;
/** Disposals in the sheet are 2026 cessions: the first open year. */
export const DISPOSAL_YEAR = LAST_IMPORTED_YEAR + 1;
export const MAX_UNITS = 200;
export const IMPORT_ACTOR = "system:legacy-import";

export interface DirectoryUser {
  readonly id: string;
  readonly name: string;
}

export interface RuleInputs {
  readonly usefulLifeYears: number;
  readonly residualCents: number;
}

export interface PlanInput {
  readonly parsed: ParsedSheet;
  readonly users: readonly DirectoryUser[];
  /** The depreciation rule in force for a purchase date (`YYYY-MM-DD`), or null when none. */
  readonly ruleFor: (purchaseDate: string) => RuleInputs | null;
}

export interface PlannedFigure {
  readonly year: number;
  readonly openingCents: number;
  readonly purchaseCents: number;
  readonly depreciationCents: number;
  readonly disposalCents: number;
  readonly closingCents: number;
}

export type PlannedStatus = "ordered" | "in_stock" | "assigned" | "disposed";
export type PlannedCategory = "laptop" | "desktop" | "phone" | "tablet" | "monitor" | "peripheral" | "other";

export interface PlannedAsset {
  readonly sheetRow: number;
  /** 1-based unit within a multi-unit row. */
  readonly unit: number;
  readonly units: number;
  readonly purchaseDate: string;
  readonly description: string;
  readonly serialNumber: string | null;
  readonly category: PlannedCategory;
  readonly priceCents: number;
  readonly status: PlannedStatus;
  readonly holderUserId: string | null;
  readonly locationNote: string | null;
  readonly toVerify: boolean;
  readonly disposal: { readonly date: string; readonly salePriceCents: number } | null;
  readonly figures: readonly PlannedFigure[];
}

export interface PlannedFiscalYear {
  readonly year: number;
  readonly openingCents: number;
  readonly disposalsCents: number;
  readonly purchasesCents: number;
  readonly depreciationCents: number;
  readonly closingCents: number;
}

export interface PlanStats {
  readonly purchaseRows: number;
  readonly importedRows: number;
  readonly assets: number;
  /** Rows that expand to more than one asset: `{ row, units }`. */
  readonly multiUnitRows: readonly { readonly row: number; readonly units: number }[];
  readonly byStatus: Readonly<Record<PlannedStatus, number>>;
  readonly byCategory: Readonly<Record<PlannedCategory, number>>;
  readonly toVerify: number;
  readonly assigneeMatched: number;
  /** Rows whose assignee text matched no user, or more than one (kept as a note). */
  readonly assigneeUnmatchedRows: readonly number[];
  readonly disposals: number;
  /** Rows with a depreciation but a blank "Valore al 31.12.2025" that foots to exactly zero (spec O4). */
  readonly blankClosingAsZeroRows: number;
  /** Row-years whose three sheet amounts do not foot by a cent (sub-cent rounding in the sheet). */
  readonly footResiduals: { readonly rowYears: number; readonly netCents: number };
  /** Sum of every imported asset's closing value, by year. */
  readonly closingByYear: Readonly<Record<number, number>>;
  /** The same sums for the years the sheet only plans (2026 and later), for the reconciliation. */
  readonly sheetColumnSums: {
    readonly closing: Readonly<Record<number, number>>;
    readonly depreciation: Readonly<Record<number, number>>;
    readonly purchasesByYear: Readonly<Record<number, number>>;
  };
}

export interface Plan {
  readonly assets: readonly PlannedAsset[];
  readonly fiscalYears: readonly PlannedFiscalYear[];
  readonly issues: readonly Issue[];
  readonly stats: PlanStats;
}

// ─── Names ───────────────────────────────────────────────────────────────────

/** Case-, accent- and spacing-insensitive form of a person's name. */
export function normaliseName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// ─── Category ────────────────────────────────────────────────────────────────

const CATEGORY_RULES: readonly (readonly [PlannedCategory, RegExp])[] = [
  ["laptop", /\b(macbook|laptop|notebook|thinkpad|latitude|elitebook|probook|zenbook|vivobook|xps)\b/i],
  ["desktop", /\b(imac|mac\s?mini|mac\s?studio|desktop|workstation|optiplex)\b/i],
  ["phone", /\b(iphone|smartphone|phone|pixel|galaxy)\b/i],
  ["tablet", /\b(ipad|tablet)\b/i],
  ["monitor", /\b(monitor|display|schermo|ultrasharp)\b/i],
  ["peripheral", /\b(mouse|keyboard|tastiera|webcam|cuffie|headset|dock|docking|hub|stampante|printer|hdd|ssd|router)\b/i],
];

/** The sheet has no category column: a keyword match on the description, else `other`. Editable afterwards. */
export function categoryOf(description: string): PlannedCategory {
  for (const [category, pattern] of CATEGORY_RULES) if (pattern.test(description)) return category;
  return "other";
}

// ─── Figures of one row ──────────────────────────────────────────────────────

interface RowFigure {
  readonly year: number;
  readonly openingCents: number;
  readonly purchaseCents: number;
  readonly depreciationCents: number;
  readonly closingCents: number;
}

const yearOf = (isoDate: string): number => Number(isoDate.slice(0, 4));

/** The figures of one purchase row for 2023..2025, or the reason it cannot be read. */
function rowFigures(
  row: PurchaseRow,
  report: { blankClosing: () => void; residual: (cents: number) => void },
): { figures: RowFigure[] } | { skipped: string } | { error: string } {
  const py = yearOf(row.purchaseDate);
  const closing = row.closing;
  const dep = row.depreciation;
  const price = row.priceCents;

  if (py > DISPOSAL_YEAR) return { error: `purchase year ${py} is after ${DISPOSAL_YEAR}` };
  if (py >= DISPOSAL_YEAR) {
    if (closing[2023] !== undefined || closing[2024] !== undefined || closing[2025] !== undefined || dep[2024] !== undefined || dep[2025] !== undefined) {
      return { error: `bought in ${py} but carries figures for earlier years` };
    }
    return { figures: [] };
  }

  // Spec O5: a value at 31.12.2023 and nothing after it.
  const laterCells = [2024, 2025, 2026, 2027, 2028].some((y) => dep[y] !== undefined || closing[y] !== undefined);
  if (py <= 2023 && closing[2023] !== undefined && !laterCells) {
    return { skipped: "has a value at 31.12.2023 and nothing after it (spec O5: undecided)" };
  }

  const figures: RowFigure[] = [];
  let carried = 0;

  if (py <= 2023) {
    const c = closing[2023];
    if (c === undefined) return { error: `bought in ${py} but "Valore al 31.12.2023" is empty` };
    if (c > price) return { error: `"Valore al 31.12.2023" exceeds the purchase price` };
    figures.push({ year: 2023, openingCents: c, purchaseCents: 0, depreciationCents: 0, closingCents: c });
    carried = c;
  } else if (closing[2023] !== undefined) {
    return { error: `bought in ${py} but "Valore al 31.12.2023" is filled` };
  }
  if (py === 2025 && (closing[2024] !== undefined || dep[2024] !== undefined)) {
    return { error: "bought in 2025 but carries 2024 figures" };
  }

  for (const year of [2024, 2025]) {
    if (year < py) continue;
    const d = dep[year];
    let c = closing[year];
    if (d === undefined) return { error: `"Ammortamento ${year}" is empty` };
    const opening = year === py ? 0 : carried;
    const purchase = year === py ? price : 0;
    if (c === undefined) {
      // Spec O4: the last CHF 1 is depreciated away and the value cell is left blank.
      if (year === 2025 && opening + purchase - d === 0) {
        c = 0;
        report.blankClosing();
      } else {
        return { error: `"Valore al 31.12.${year}" is empty and the row does not depreciate to zero` };
      }
    }
    if (c > price) return { error: `"Valore al 31.12.${year}" exceeds the purchase price` };
    if (d > opening + purchase + 1) return { error: `"Ammortamento ${year}" exceeds the value it depreciates` };
    const residual = opening + purchase - d - c;
    if (Math.abs(residual) > 1) {
      return { error: `${year}: value ${opening + purchase} less depreciation ${d} is not the stated value ${c} (off by ${residual} cents)` };
    }
    if (residual !== 0) report.residual(residual);
    figures.push({ year, openingCents: opening, purchaseCents: purchase, depreciationCents: d, closingCents: c });
    carried = c;
  }
  return { figures };
}

/** How many assets a row stands for: its terminal book value in units of the residual (see header of import-legacy.ts). */
function unitsOf(row: PurchaseRow, rule: RuleInputs): { units: number } | { error: string } {
  if (rule.residualCents <= 0) return { units: 1 };
  const terminalYear = yearOf(row.purchaseDate) + rule.usefulLifeYears - 1;
  const terminal = row.closing[terminalYear];
  if (terminal === undefined || terminal === 0) return { units: 1 };
  if (terminal < rule.residualCents || terminal % rule.residualCents !== 0) {
    return {
      error: `the book value at the end of its schedule (31.12.${terminalYear}) is not a whole number of residual units, so the number of units cannot be read`,
    };
  }
  const units = terminal / rule.residualCents;
  if (units > MAX_UNITS) return { error: `would be ${units} units (at most ${MAX_UNITS})` };
  return { units };
}

// ─── The plan ────────────────────────────────────────────────────────────────

export function buildPlan(input: PlanInput): Plan {
  const { parsed, users, ruleFor } = input;
  const issues: Issue[] = [...parsed.issues];
  const error = (row: number, code: string, message: string) => issues.push({ kind: "error", row, code, message });
  const skipped = (row: number, code: string, message: string) => issues.push({ kind: "skipped", row, code, message });

  // Names that match exactly one directory entry assign; ambiguity is a note, not a guess.
  const byName = new Map<string, string[]>();
  for (const u of users) {
    const key = normaliseName(u.name);
    if (key === "") continue;
    byName.set(key, [...(byName.get(key) ?? []), u.id]);
  }

  const assets: PlannedAsset[] = [];
  const multiUnitRows: { row: number; units: number }[] = [];
  const unmatchedRows: number[] = [];
  let blankClosing = 0;
  let residualRowYears = 0;
  let residualNet = 0;
  let importedRows = 0;
  let assigneeMatched = 0;

  for (const row of parsed.purchases) {
    const rule = ruleFor(row.purchaseDate);
    if (!rule) {
      error(row.row, "no_rule", `no depreciation rule is in force for ${row.purchaseDate}`);
      continue;
    }
    const result = rowFigures(row, {
      blankClosing: () => void blankClosing++,
      residual: (cents) => {
        residualRowYears++;
        residualNet += cents;
      },
    });
    if ("skipped" in result) {
      skipped(row.row, "o5_undecided", result.skipped);
      continue;
    }
    if ("error" in result) {
      error(row.row, "unreadable_figures", result.error);
      continue;
    }
    const u = unitsOf(row, rule);
    if ("error" in u) {
      error(row.row, "unreadable_units", u.error);
      continue;
    }
    const { units } = u;
    if (units > 1) {
      if (row.serial !== null) {
        error(row.row, "serial_on_multi_unit", `a serial number cannot belong to ${units} units`);
        continue;
      }
      if (row.ordered) {
        error(row.row, "ordered_multi_unit", "an ordered row cannot be split into units");
        continue;
      }
      multiUnitRows.push({ row: row.row, units });
    }
    importedRows++;

    // Holder (AC-12.7, AC-12.6)
    let holder: string | null = null;
    let note: string | null = null;
    if (row.assigneeText !== null) {
      const matches = byName.get(normaliseName(row.assigneeText)) ?? [];
      if (matches.length === 1) {
        holder = matches[0]!;
        assigneeMatched++;
      } else {
        unmatchedRows.push(row.row);
        note = row.assigneeText.slice(0, 500);
      }
    }
    const status: PlannedStatus = row.ordered ? "ordered" : holder !== null ? "assigned" : "in_stock";
    const toVerify = !row.ordered && holder === null;
    // A holder on an ordered row is not a holder: nothing has arrived to be held.
    const heldBy = row.ordered ? null : holder;
    const locationNote = row.ordered && holder !== null ? row.assigneeText : note;

    const figs = result.figures;
    const prices = splitPrice(row.priceCents, units);
    const split = (pick: (f: RowFigure) => number) => figs.map((f) => splitPrice(pick(f), units));
    const opening = split((f) => f.openingCents);
    const purchase = split((f) => f.purchaseCents);
    const depreciation = split((f) => f.depreciationCents);
    const closing = split((f) => f.closingCents);

    for (let i = 0; i < units; i++) {
      assets.push({
        sheetRow: row.row,
        unit: i + 1,
        units,
        purchaseDate: row.purchaseDate,
        description: row.description,
        serialNumber: row.serial,
        category: categoryOf(row.description),
        priceCents: prices[i]!,
        status,
        holderUserId: heldBy,
        locationNote,
        toVerify,
        disposal: null,
        figures: figs.map((f, k) => ({
          year: f.year,
          openingCents: opening[k]![i]!,
          purchaseCents: purchase[k]![i]!,
          depreciationCents: depreciation[k]![i]!,
          disposalCents: 0,
          closingCents: closing[k]![i]!,
        })),
      });
    }
  }

  // Serial numbers are unique among live assets (AC-1.5): a repeat is a data error, caught before the database does.
  const seen = new Map<string, number>();
  for (const a of assets) {
    if (a.serialNumber === null) continue;
    const key = a.serialNumber.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) error(a.sheetRow, "duplicate_serial", `serial number repeats the one on row ${first}`);
    else seen.set(key, a.sheetRow);
  }

  // Cessions (AC-12.8): a disposal of the asset the serial names, never a new asset.
  const withDisposal = new Map<PlannedAsset, CessionRow>();
  for (const c of parsed.cessions) {
    if (c.serial === null) {
      error(c.row, "cession_without_serial", "a cession row needs the serial number of the asset it refers to");
      continue;
    }
    if (yearOf(c.date) !== DISPOSAL_YEAR) {
      error(c.row, "cession_year", `a cession must be dated in ${DISPOSAL_YEAR}, not ${yearOf(c.date)}`);
      continue;
    }
    const target = assets.find((a) => a.serialNumber !== null && a.serialNumber.toLowerCase() === c.serial!.toLowerCase());
    if (!target) {
      skipped(c.row, "o5_cession_unmatched", "its serial number matches no imported purchase row (spec O5: undecided)");
      continue;
    }
    if (withDisposal.has(target)) {
      error(c.row, "cession_twice", `the asset on row ${target.sheetRow} is already ceded by another row`);
      continue;
    }
    if (c.date < target.purchaseDate) {
      error(c.row, "cession_before_purchase", `dated before the purchase of the asset on row ${target.sheetRow}`);
      continue;
    }
    withDisposal.set(target, c);
  }
  const finalAssets = assets.map((a) => {
    const c = withDisposal.get(a);
    if (!c) return a;
    return {
      ...a,
      status: "disposed" as const,
      holderUserId: null,
      toVerify: false,
      disposal: { date: c.date, salePriceCents: c.priceCents },
    };
  });

  // Fiscal years 2024 and 2025: the sums of the rows.
  const fiscalYears: PlannedFiscalYear[] = CLOSED_YEARS.map((year) => {
    let openingCents = 0, purchasesCents = 0, depreciationCents = 0, closingCents = 0;
    for (const a of finalAssets) {
      const f = a.figures.find((x) => x.year === year);
      if (!f) continue;
      openingCents += f.openingCents;
      purchasesCents += f.purchaseCents;
      depreciationCents += f.depreciationCents;
      closingCents += f.closingCents;
    }
    return { year, openingCents, disposalsCents: 0, purchasesCents, depreciationCents, closingCents };
  });

  const closingByYear: Record<number, number> = {};
  for (let y = FIRST_FIGURE_YEAR; y <= LAST_IMPORTED_YEAR; y++) {
    closingByYear[y] = finalAssets.reduce((s, a) => s + (a.figures.find((f) => f.year === y)?.closingCents ?? 0), 0);
  }

  const status0: Record<PlannedStatus, number> = { ordered: 0, in_stock: 0, assigned: 0, disposed: 0 };
  const category0: Record<PlannedCategory, number> = { laptop: 0, desktop: 0, phone: 0, tablet: 0, monitor: 0, peripheral: 0, other: 0 };
  for (const a of finalAssets) {
    status0[a.status]++;
    category0[a.category]++;
  }

  // The sheet's own columns, over EVERY purchase row it states (imported or not), for the reconciliation.
  const sumColumn = (pick: (r: PurchaseRow) => number | undefined) =>
    parsed.purchases.reduce((s, r) => s + (pick(r) ?? 0), 0);
  const closing: Record<number, number> = {};
  const depreciationSums: Record<number, number> = {};
  const purchasesByYear: Record<number, number> = {};
  for (const y of [2023, 2024, 2025, 2026, 2027, 2028]) closing[y] = sumColumn((r) => r.closing[y]);
  for (const y of [2024, 2025, 2026, 2027, 2028]) depreciationSums[y] = sumColumn((r) => r.depreciation[y]);
  for (const r of parsed.purchases) {
    const y = yearOf(r.purchaseDate);
    purchasesByYear[y] = (purchasesByYear[y] ?? 0) + r.priceCents;
  }


  return {
    assets: finalAssets,
    fiscalYears,
    issues,
    stats: {
      purchaseRows: parsed.purchases.length,
      importedRows,
      assets: finalAssets.length,
      multiUnitRows,
      byStatus: status0,
      byCategory: category0,
      toVerify: finalAssets.filter((a) => a.toVerify).length,
      assigneeMatched,
      assigneeUnmatchedRows: unmatchedRows,
      disposals: withDisposal.size,
      blankClosingAsZeroRows: blankClosing,
      footResiduals: { rowYears: residualRowYears, netCents: residualNet },
      closingByYear,
      sheetColumnSums: { closing, depreciation: depreciationSums, purchasesByYear },
    },
  };
}
