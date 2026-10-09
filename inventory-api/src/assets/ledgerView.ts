/**
 * The `Ledger` projection (T12, specs/015-hardware-inventory; AC-5.3, AC-5.7,
 * AC-5.8, AC-7.8, AC-8.6, ADR-0046). Pure: rows in, plain objects out.
 *
 * Where a year's figure comes from:
 *   - a CLOSED year with a stored `asset_year_figure` row -> that row, always
 *     (a later rule or bug fix must never rewrite a reported year, AC-8.6);
 *   - any other year -> `yearFigure()`, derived from price, purchase date and
 *     the rule in force at the purchase date.
 *
 * "Book value today" is the CLOSING figure of the current calendar year: the
 * schedule has no pro-rata (AC-5.2), so a year's charge applies to the whole
 * year. An asset purchased in a later year is not on the books yet: 0 (the same
 * zero `yearFigure` gives it in the roll-forward).
 */

import { schedule, yearFigure, type Anchor, type DepreciationRule } from "../depreciation/schedule";
import { formatDate } from "../depreciation/rules.schemas";

export interface LedgerRuleRow extends DepreciationRule {
  readonly id: string;
  readonly effectiveFrom: Date;
}

export interface StoredFigure {
  readonly year: number;
  readonly depreciationCents: number;
  readonly closingCents: number;
  readonly source: "closed" | "imported";
}

export interface LedgerAsset {
  readonly entity: string;
  readonly priceCents: number;
  readonly purchaseDate: Date;
  readonly disposedOn: Date | null;
  readonly legacyImported: boolean;
}

export interface LedgerInput {
  readonly asset: LedgerAsset;
  readonly rule: LedgerRuleRow;
  /** Every stored figure of this asset (any year). */
  readonly stored: readonly StoredFigure[];
  /** `max(fiscal_year.year)` of the asset's entity, null while none is closed. */
  readonly lastClosedYear: number | null;
  readonly today: Date;
}

export interface Ledger {
  bookValueCents: number;
  rule: {
    id: string;
    effectiveFrom: string;
    usefulLifeYears: number;
    firstYearShare: "full" | "half";
    lowValueThresholdCents: number | null;
    residualCents: number;
  };
  schedule: { year: number; depreciationCents: number; closingCents: number; closed: boolean }[];
}

interface Resolved {
  readonly purchaseYear: number;
  readonly anchor: Anchor | undefined;
  readonly byYear: ReadonlyMap<number, StoredFigure>;
}

function resolve(input: LedgerInput): Resolved {
  const purchaseYear = input.asset.purchaseDate.getUTCFullYear();
  const byYear = new Map(input.stored.map((s) => [s.year, s]));
  let anchor: Anchor | undefined;
  if (input.asset.legacyImported) {
    for (const s of input.stored) {
      if (s.source === "imported" && (!anchor || s.year > anchor.year)) {
        anchor = { year: s.year, bookValueCents: s.closingCents };
      }
    }
  }
  return { purchaseYear, anchor, byYear };
}

/** The year's `{depreciation, closing}`, or null when there is nothing to say for it. */
function figureFor(
  input: LedgerInput,
  r: Resolved,
  year: number,
  disposalYear: number | undefined,
): { depreciationCents: number; closingCents: number } | null {
  const closed = input.lastClosedYear !== null && year <= input.lastClosedYear;
  const stored = r.byYear.get(year);
  if (closed && stored) {
    return { depreciationCents: stored.depreciationCents, closingCents: stored.closingCents };
  }
  // Before the anchor only stored figures exist (R-2): never recomputed.
  if (r.anchor && year < r.anchor.year) return null;
  try {
    const f = yearFigure(
      {
        priceCents: input.asset.priceCents,
        purchaseYear: r.purchaseYear,
        rule: input.rule,
        anchor: r.anchor,
        disposalYear,
      },
      year,
    );
    return { depreciationCents: f.depreciationCents, closingCents: f.closingCents };
  } catch {
    // e.g. a disposal year not after the anchor: the stored rows are the truth.
    return stored
      ? { depreciationCents: stored.depreciationCents, closingCents: stored.closingCents }
      : null;
  }
}

const disposalYearOf = (asset: LedgerAsset): number | undefined =>
  asset.disposedOn ? asset.disposedOn.getUTCFullYear() : undefined;

/** Book value as of `today`: 0 once disposed, otherwise the current year's closing figure. */
export function bookValueAt(input: LedgerInput): number {
  const { asset, today } = input;
  if (asset.disposedOn && asset.disposedOn.getTime() <= today.getTime()) return 0;
  const r = resolve(input);
  // A disposal still ahead of today has not happened yet.
  const f = figureFor(input, r, today.getUTCFullYear(), undefined);
  return f?.closingCents ?? 0;
}

export function buildLedger(input: LedgerInput): Ledger {
  const r = resolve(input);
  const disposalYear = disposalYearOf(input.asset);

  let last = r.purchaseYear;
  if (disposalYear !== undefined) last = Math.max(last, disposalYear);
  if (disposalYear === undefined) {
    for (const e of schedule(input.asset.priceCents, r.purchaseYear, input.rule, r.anchor)) {
      last = Math.max(last, e.year);
    }
    for (const s of input.stored) last = Math.max(last, s.year);
  }
  // A disposed asset's schedule ends in its disposal year: nothing is booked after it (AC-7.7).

  const rows: Ledger["schedule"] = [];
  for (let year = r.purchaseYear; year <= last; year++) {
    const f = figureFor(input, r, year, disposalYear);
    if (!f) continue;
    rows.push({
      year,
      depreciationCents: f.depreciationCents,
      closingCents: f.closingCents,
      closed: input.lastClosedYear !== null && year <= input.lastClosedYear,
    });
  }

  return {
    bookValueCents: bookValueAt(input),
    rule: {
      id: input.rule.id,
      effectiveFrom: formatDate(input.rule.effectiveFrom),
      usefulLifeYears: input.rule.usefulLifeYears,
      firstYearShare: input.rule.firstYearShare,
      lowValueThresholdCents: input.rule.lowValueThresholdCents,
      residualCents: input.rule.residualCents,
    },
    schedule: rows,
  };
}
