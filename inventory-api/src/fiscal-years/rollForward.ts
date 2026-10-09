/**
 * The yearly roll-forward (T19, specs/015-hardware-inventory; AC-8.1, AC-8.2,
 * AC-8.3, AC-7.2, AC-7.7, ADR-0046). Pure: assets, a rule per asset and the
 * stored figures in, one entity-year statement out. No I/O, no clock.
 *
 * Where a year's per-asset figures come from:
 *
 *   CLOSED year (year <= lastClosedYear)  the stored `asset_year_figure` rows of
 *       that year, verbatim. NEVER recomputed: a later rule, bug fix or rounding
 *       change must not reach a reported year (AC-8.6).
 *   OPEN year                              derived with `yearFigure()` from price,
 *       purchase date, rule and disposal, but CHAINED from the stored closing of
 *       the last closed year: opening of the first open year is the stored
 *       closing of the year before it (AC-8.3), and each open year after it
 *       opens at the previous year's closing. Without drift this changes
 *       nothing (the property test proves it); with drift, the open year
 *       absorbs the difference visibly instead of the boundary silently
 *       failing to reconcile.
 *
 * Statement lines are SUMS of the per-asset rows, so "each line equals the sum
 * of the per-asset figures" (AC-8.2) holds by construction, and each row obeys
 * `closing = opening - disposal + purchase - depreciation`, which gives the
 * statement's equation (AC-8.1). Rows with nothing in them (an asset disposed
 * or fully written off in an earlier year) are left out: they carry no
 * information and would bury the year's movements.
 */

import { yearFigure, type Anchor, type DepreciationRule } from "../depreciation/schedule";

export interface Lines {
  openingCents: number;
  disposalsCents: number;
  purchasesCents: number;
  depreciationCents: number;
  closingCents: number;
}

export interface RollAsset {
  readonly id: string;
  readonly purchaseDate: Date;
  readonly purchasePriceCents: number;
  readonly disposedOn: Date | null;
  readonly legacyImported: boolean;
}

/** One stored `asset_year_figure` row. */
export interface StoredFigureRow {
  readonly assetId: string;
  readonly year: number;
  readonly openingCents: number;
  readonly purchaseCents: number;
  readonly depreciationCents: number;
  readonly disposalCents: number;
  readonly closingCents: number;
  readonly source: "closed" | "imported";
}

export interface AssetFigureRow {
  assetId: string;
  openingCents: number;
  purchaseCents: number;
  depreciationCents: number;
  disposalCents: number;
  closingCents: number;
}

export interface Statement {
  lines: Lines;
  rows: AssetFigureRow[];
}

export interface StatementInput {
  readonly assets: readonly RollAsset[];
  /** The rule in force for the asset; throws when there is none (never a silently short statement). */
  readonly rule: (asset: RollAsset) => DepreciationRule;
  /** Every stored figure of the entity's assets, any year. */
  readonly stored: readonly StoredFigureRow[];
  readonly lastClosedYear: number | null;
  readonly year: number;
}

export const EMPTY_LINES: Readonly<Lines> = Object.freeze({
  openingCents: 0,
  disposalsCents: 0,
  purchasesCents: 0,
  depreciationCents: 0,
  closingCents: 0,
});

const yearOf = (d: Date): number => d.getUTCFullYear();

const isEmpty = (r: AssetFigureRow): boolean =>
  r.openingCents === 0 &&
  r.purchaseCents === 0 &&
  r.depreciationCents === 0 &&
  r.disposalCents === 0 &&
  r.closingCents === 0;

export function sumLines(rows: readonly AssetFigureRow[]): Lines {
  const lines = { ...EMPTY_LINES };
  for (const r of rows) {
    lines.openingCents += r.openingCents;
    lines.disposalsCents += r.disposalCents;
    lines.purchasesCents += r.purchaseCents;
    lines.depreciationCents += r.depreciationCents;
    lines.closingCents += r.closingCents;
  }
  return lines;
}

const fromStored = (r: StoredFigureRow): AssetFigureRow => ({
  assetId: r.assetId,
  openingCents: r.openingCents,
  purchaseCents: r.purchaseCents,
  depreciationCents: r.depreciationCents,
  disposalCents: r.disposalCents,
  closingCents: r.closingCents,
});

const ZERO = (assetId: string): AssetFigureRow => ({
  assetId,
  openingCents: 0,
  purchaseCents: 0,
  depreciationCents: 0,
  disposalCents: 0,
  closingCents: 0,
});

/** The open-year figure of one asset, chained from the stored closing of the last closed year. */
function openYearFigure(
  asset: RollAsset,
  rule: DepreciationRule,
  byYear: ReadonlyMap<number, StoredFigureRow>,
  imported: readonly StoredFigureRow[],
  lastClosedYear: number | null,
  year: number,
): AssetFigureRow {
  const purchaseYear = yearOf(asset.purchaseDate);
  const disposalYear = asset.disposedOn ? yearOf(asset.disposedOn) : undefined;

  let anchor: Anchor | undefined;
  if (asset.legacyImported) {
    for (const s of imported) {
      if (!anchor || s.year > anchor.year) anchor = { year: s.year, bookValueCents: s.closingCents };
    }
  }

  const start = lastClosedYear === null ? purchaseYear : lastClosedYear + 1;
  // After the last closed year, the stored closing is the book value to carry on from.
  let carry: number | undefined =
    lastClosedYear === null ? undefined : byYear.get(lastClosedYear)?.closingCents;

  let figure = ZERO(asset.id);
  for (let y = start; y <= year; y++) {
    let f;
    try {
      f = yearFigure(
        { priceCents: asset.purchasePriceCents, purchaseYear, rule, anchor, disposalYear },
        y,
      );
    } catch (error) {
      // Only the "figures up to the anchor are stored" RangeErrors: the stored
      // row is the truth for that year, and without one there is nothing to say.
      if (!(error instanceof RangeError)) throw error;
      const stored = byYear.get(y);
      figure = stored ? fromStored(stored) : ZERO(asset.id);
      carry = figure.closingCents;
      continue;
    }

    const afterDisposal = disposalYear !== undefined && y > disposalYear;
    if (carry !== undefined && carry !== f.openingCents && !afterDisposal && y >= purchaseYear) {
      // Rebase on the stored closing; the year's own movements stay the formula's.
      const openingCents = carry;
      const purchaseCents = f.purchaseCents;
      const disposing = y === disposalYear;
      const disposalCents = disposing ? openingCents + purchaseCents : 0;
      const depreciationCents = disposing
        ? 0
        : Math.min(f.depreciationCents, Math.max(0, openingCents + purchaseCents));
      figure = {
        assetId: asset.id,
        openingCents,
        purchaseCents,
        depreciationCents,
        disposalCents,
        closingCents: openingCents + purchaseCents - depreciationCents - disposalCents,
      };
    } else {
      figure = {
        assetId: asset.id,
        openingCents: f.openingCents,
        purchaseCents: f.purchaseCents,
        depreciationCents: f.depreciationCents,
        disposalCents: f.disposalCents,
        closingCents: f.closingCents,
      };
    }
    carry = figure.closingCents;
  }
  return figure;
}

export function buildStatement(input: StatementInput): Statement {
  const { assets, stored, lastClosedYear, year } = input;

  if (lastClosedYear !== null && year <= lastClosedYear) {
    const rows = stored.filter((s) => s.year === year).map(fromStored);
    rows.sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
    return { lines: sumLines(rows), rows };
  }

  const byAsset = new Map<string, StoredFigureRow[]>();
  for (const s of stored) {
    const list = byAsset.get(s.assetId) ?? [];
    list.push(s);
    byAsset.set(s.assetId, list);
  }

  const rows: AssetFigureRow[] = [];
  for (const asset of assets) {
    if (yearOf(asset.purchaseDate) > year && !asset.legacyImported) continue;
    const own = byAsset.get(asset.id) ?? [];
    const byYear = new Map(own.map((s) => [s.year, s]));
    const row = openYearFigure(
      asset,
      input.rule(asset),
      byYear,
      own.filter((s) => s.source === "imported"),
      lastClosedYear,
      year,
    );
    if (!isEmpty(row)) rows.push(row);
  }
  return { lines: sumLines(rows), rows };
}

// ─── Which years exist, and which can be closed ─────────────────────────────

export interface YearsContext {
  readonly assets: readonly Pick<RollAsset, "id" | "purchaseDate" | "legacyImported">[];
  readonly stored: readonly Pick<StoredFigureRow, "assetId" | "year">[];
  readonly closedYears: readonly number[];
  readonly lastClosedYear: number | null;
}

/**
 * The first year the entity has anything to say about, or null while it has no
 * assets. A native asset starts in its purchase year. An imported asset starts
 * at the earliest figure the sheet gave for it (plan R-2: the sheet has no
 * per-year history before 2024, only a value at 31.12.2023, so 2022 is not a
 * year of this entity even though the laptop was bought then).
 */
export function firstYearOf(ctx: YearsContext): number | null {
  if (ctx.assets.length === 0) return null;
  const minStored = new Map<string, number>();
  for (const s of ctx.stored) {
    const cur = minStored.get(s.assetId);
    if (cur === undefined || s.year < cur) minStored.set(s.assetId, s.year);
  }
  let first = Number.POSITIVE_INFINITY;
  for (const a of ctx.assets) {
    const own = a.legacyImported ? minStored.get(a.id) : undefined;
    first = Math.min(first, own ?? yearOf(a.purchaseDate));
  }
  for (const y of ctx.closedYears) first = Math.min(first, y);
  return first;
}

/**
 * The last year a view or a list shows: the current year, or the year after the
 * last closed one when that is later (closing the current year opens the next).
 * Bounded so a request for year 2999 cannot ask for 970 chained years.
 */
export function horizonYear(lastClosedYear: number | null, currentYear: number): number {
  return Math.max(currentYear, (lastClosedYear ?? Number.NEGATIVE_INFINITY) + 1);
}

/**
 * AC-8.4/8.5: the previous year is closed, or this is the entity's first year -
 * and the year has begun: a year after the current UTC calendar year is never
 * closable (closing is irreversible and freezes every dated write). The current
 * year itself stays closable. ONE function for the list's `closable` and the
 * close route's check, so the two cannot disagree.
 */
export function isClosable(
  year: number,
  lastClosedYear: number | null,
  firstYear: number | null,
  currentYear: number,
): boolean {
  if (year > currentYear) return false;
  if (lastClosedYear !== null) return year === lastClosedYear + 1;
  return firstYear !== null && year === firstYear;
}
