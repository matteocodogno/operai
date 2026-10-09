/** Shapes shared by the legacy-import modules (T23, specs/015-hardware-inventory; US-12). */

/** One worksheet row as plain values; `col` is the spreadsheet column letter A-P. Formulas are already resolved to their cached result. */
export interface SheetRow {
  readonly row: number;
  readonly cells: Readonly<Record<string, unknown>>;
}

/** Years the sheet carries a "Valore al 31.12.<y>" (closing) and "Ammortamento <y>" column for. */
export const VALUE_YEARS = [2023, 2024, 2025, 2026, 2027, 2028] as const;

/** One purchase row of the sheet, decoded. Money is integer cents. */
export interface PurchaseRow {
  readonly row: number;
  /** ISO calendar date, `YYYY-MM-DD`. */
  readonly purchaseDate: string;
  readonly description: string;
  /** `null` when the serial column is empty or marks an order not yet received. */
  readonly serial: string | null;
  /** The serial column says "Ordinato - In attesa di ricezione" (AC-12.9). */
  readonly ordered: boolean;
  /** The "Assigned" column, trimmed; `null` when empty. */
  readonly assigneeText: string | null;
  readonly priceCents: number;
  /** "Valore al 31.12.<year>" by year; absent key = empty cell. */
  readonly closing: Readonly<Partial<Record<number, number>>>;
  /** "Ammortamento <year>" by year; absent key = empty cell. */
  readonly depreciation: Readonly<Partial<Record<number, number>>>;
}

/** A "<name>, cessione <model>" row below the purchases (AC-12.8). */
export interface CessionRow {
  readonly row: number;
  readonly date: string;
  readonly serial: string | null;
  readonly priceCents: number;
}

/** A labelled figure of the year-end block, as the sheet states it. */
export interface YearEndLine {
  readonly row: number;
  readonly label: string;
  readonly cents: number;
}

/** A sheet total outside the purchase rows (e.g. the sum of one column). */
export interface SheetTotal {
  readonly row: number;
  readonly column: string;
  readonly cents: number;
}

export type IssueKind =
  /** Cannot be interpreted: stops the apply. */
  | "error"
  /** Spec O5 leaves it undecided: reported and skipped, never guessed. */
  | "skipped";

export interface Issue {
  readonly kind: IssueKind;
  readonly row: number;
  readonly code: string;
  readonly message: string;
}

export interface ParsedSheet {
  readonly purchases: readonly PurchaseRow[];
  readonly cessions: readonly CessionRow[];
  readonly yearEnd: readonly YearEndLine[];
  readonly totals: readonly SheetTotal[];
  readonly issues: readonly Issue[];
}
