/**
 * Depreciation schedule and per-year figures (specs/015 plan § "Schedule function", ADR-0046).
 *
 * Pure: no I/O, no Prisma, no env, no clock. All amounts are integer cents; the only rounding is
 * `roundHalfUp` (money.ts), and the final year of every schedule takes the remainder so the book
 * value lands exactly on the residual (ADR-0025: round once, one canonical rule).
 *
 * Years are plain integers (the purchase *year*, never a date): there is no pro-rata, so a 1 Jan
 * and a 31 Dec purchase are the same input (AC-5.2).
 */
import { roundHalfUp } from "./money";

export type DepreciationRule = {
  usefulLifeYears: number;
  firstYearShare: "full" | "half";
  lowValueThresholdCents: number | null;
  residualCents: number;
};

/** Legacy-imported book value `bookValueCents` at the END of `year` (AC-12.5). */
export type Anchor = { year: number; bookValueCents: number };

export type ScheduleEntry = { year: number; depreciationCents: number; closingCents: number };

/** What `yearFigure` needs; later tasks build this plain object from the database. */
export type AssetForFigures = {
  priceCents: number;
  purchaseYear: number;
  rule: DepreciationRule;
  /** Only for `legacyImported` assets: the latest imported figure to continue from. */
  anchor?: Anchor | undefined;
  /** Fiscal year of the disposal, if the asset is disposed. */
  disposalYear?: number | undefined;
};

export type YearFigure = {
  openingCents: number;
  purchaseCents: number;
  depreciationCents: number;
  disposalCents: number;
  closingCents: number;
};

function assertInt(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be a safe integer >= ${min}, got ${value}`);
  }
}

function assertRule(rule: DepreciationRule): void {
  assertInt(rule.usefulLifeYears, "usefulLifeYears", 1);
  assertInt(rule.residualCents, "residualCents", 0);
  if (rule.lowValueThresholdCents !== null) {
    assertInt(rule.lowValueThresholdCents, "lowValueThresholdCents", 0);
  }
  if (rule.firstYearShare !== "full" && rule.firstYearShare !== "half") {
    throw new RangeError(`firstYearShare must be "full" or "half"`);
  }
  assertInt(2 * rule.usefulLifeYears, "2 * usefulLifeYears", 1);
}

function assertAnchor(anchor: Anchor, purchaseYear: number): void {
  assertInt(anchor.year, "anchor.year", Number.MIN_SAFE_INTEGER);
  assertInt(anchor.bookValueCents, "anchor.bookValueCents", 0);
  if (anchor.year < purchaseYear) {
    throw new RangeError(`anchor.year ${anchor.year} is before the purchase year ${purchaseYear}`);
  }
}

/**
 * Spread `total` over `years` consecutive years starting at `firstYear`. `amountFor(i)` is the
 * nominal amount of the i-th year; each is capped at what remains (so none is negative and the sum
 * can never overshoot) and the last year takes whatever remains.
 */
function spread(
  startClosing: number,
  total: number,
  firstYear: number,
  years: number,
  amountFor: (i: number) => number,
): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  let spent = 0;
  for (let i = 0; i < years; i++) {
    const remaining = total - spent;
    const amount = i === years - 1 ? remaining : Math.min(remaining, amountFor(i));
    spent += amount;
    entries.push({
      year: firstYear + i,
      depreciationCents: amount,
      closingCents: startClosing - spent,
    });
  }
  return entries;
}

/**
 * schedule(priceCents, purchaseYear, rule, anchor?) -> [{year, depreciationCents, closingCents}]
 *
 * - D = price - residual; D <= 0 gives an empty schedule (nothing to depreciate).
 * - No anchor: a price at or below the low-value threshold is written off whole in the purchase
 *   year; otherwise n = life (+1 when the first year is a half year), full = round(D / life),
 *   year 1 = round(D / 2*life) for a half first year, years 2..n-1 = full, year n = remainder.
 * - Anchor (V at the end of year A): k = n - (A - purchaseYear + 1) years remain; k <= 0 or
 *   V <= residual gives an empty schedule; each of the k years from A+1 is round((V - residual)/k)
 *   and the last takes the remainder. The threshold does not apply to an anchored asset.
 *
 * Disposal is not an input here; it is applied by `yearFigure`.
 */
export function schedule(
  priceCents: number,
  purchaseYear: number,
  rule: DepreciationRule,
  anchor?: Anchor | undefined,
): ScheduleEntry[] {
  assertInt(priceCents, "priceCents", 0);
  assertInt(purchaseYear, "purchaseYear", Number.MIN_SAFE_INTEGER);
  assertRule(rule);
  if (anchor) assertAnchor(anchor, purchaseYear);

  const life = rule.usefulLifeYears;
  const half = rule.firstYearShare === "half";
  const n = life + (half ? 1 : 0);

  if (anchor) {
    const k = n - (anchor.year - purchaseYear + 1);
    const span = anchor.bookValueCents - rule.residualCents;
    if (k <= 0 || span <= 0) return [];
    const each = roundHalfUp(span, k);
    return spread(anchor.bookValueCents, span, anchor.year + 1, k, () => each);
  }

  const depreciable = priceCents - rule.residualCents;
  if (depreciable <= 0) return [];
  if (rule.lowValueThresholdCents !== null && priceCents <= rule.lowValueThresholdCents) {
    return [{ year: purchaseYear, depreciationCents: depreciable, closingCents: rule.residualCents }];
  }
  const full = roundHalfUp(depreciable, life);
  const first = half ? roundHalfUp(depreciable, 2 * life) : full;
  return spread(priceCents, depreciable, purchaseYear, n, (i) => (i === 0 ? first : full));
}

const ZERO: YearFigure = {
  openingCents: 0,
  purchaseCents: 0,
  depreciationCents: 0,
  disposalCents: 0,
  closingCents: 0,
};

/**
 * The five roll-forward figures of one asset in one fiscal year; for every asset and year
 * `closing = opening + purchase - depreciation - disposal`.
 *
 * - Before the purchase year: all zeros.
 * - After the schedule ends the book value stays at the residual (AC-5.3). When the price is at or
 *   below the residual there is no schedule and the book value stays at the price.
 * - Disposal in year Y (AC-7.2/7.7/7.8): disposal = book value at the start of Y, or the purchase
 *   price if bought in Y; depreciation 0 in Y and later; closing 0 from Y on, so every year after Y
 *   is all zeros.
 * - Anchored (legacy) assets: figures up to and before the anchor year are stored rows, never
 *   recomputed (AC-12.2). Year A itself carries the anchor value (opening = closing = V, no
 *   movements); a year in [purchaseYear, A) throws RangeError, as does a disposal year <= A.
 */
export function yearFigure(asset: AssetForFigures, year: number): YearFigure {
  const { priceCents, purchaseYear, rule, anchor, disposalYear } = asset;
  assertInt(year, "year", Number.MIN_SAFE_INTEGER);
  const entries = schedule(priceCents, purchaseYear, rule, anchor);
  if (disposalYear !== undefined) {
    assertInt(disposalYear, "disposalYear", purchaseYear);
    if (anchor && disposalYear <= anchor.year) {
      throw new RangeError(
        `disposalYear ${disposalYear} is not after the anchor year ${anchor.year}: figures up to the anchor are stored, not computed`,
      );
    }
  }
  if (year < purchaseYear) return { ...ZERO };
  if (anchor && year < anchor.year) {
    throw new RangeError(`year ${year} precedes the anchor year ${anchor.year}: use the stored figure`);
  }
  if (anchor && year === anchor.year) {
    return {
      ...ZERO,
      openingCents: anchor.bookValueCents,
      closingCents: anchor.bookValueCents,
    };
  }

  // Book value at the end of `y` ignoring any disposal (y >= purchaseYear, or >= anchor.year).
  const base = anchor ? anchor.bookValueCents : priceCents;
  const bookEnd = (y: number): number => {
    let spent = 0;
    for (const e of entries) if (e.year <= y) spent += e.depreciationCents;
    return base - spent;
  };

  if (disposalYear !== undefined && year > disposalYear) return { ...ZERO };

  const purchased = !anchor && year === purchaseYear;
  const openingCents = purchased ? 0 : bookEnd(year - 1);
  const purchaseCents = purchased ? priceCents : 0;

  if (year === disposalYear) {
    return {
      openingCents,
      purchaseCents,
      depreciationCents: 0,
      disposalCents: purchased ? priceCents : openingCents,
      closingCents: 0,
    };
  }
  const depreciationCents = entries.find((e) => e.year === year)?.depreciationCents ?? 0;
  return {
    openingCents,
    purchaseCents,
    depreciationCents,
    disposalCents: 0,
    closingCents: openingCents + purchaseCents - depreciationCents,
  };
}
