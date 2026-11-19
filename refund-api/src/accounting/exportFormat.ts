/**
 * EVERY CSV FORMAT CHOICE of the accounting export, in one module (T17,
 * specs/20261118-refund-accounting-export; AC-6.2, AC-6.8; plan § "CSV
 * contract" and D3; ADR 20261118-the-accounting-export-is-generated-on-request-
 * never-stored-and-logged-append-only-with-its-content-hash-and-format-version).
 *
 * THIS IS THE ONE PLACE TO CHANGE once accounting answers spec open question 3
 * (the separator, decimal mark and encoding its system expects). A change is a
 * constants edit here, a bump of `FORMAT_VERSION` (which the export log records
 * per download), and one deliberate diff of `fixtures/accounting-export.golden.csv`.
 * `export.ts` knows no literal separator, quote, mark or label of its own.
 *
 * The values below are a PROVISIONAL DEFAULT (plan D3): UTF-8 with a byte-order
 * mark, `;` as the separator and `.` as the decimal mark (the Swiss decimal
 * mark, which cannot clash with `;`) open correctly in Excel and Numbers under
 * the CH and IT locales; ISO dates; English headers and expense-type labels,
 * as the documents decision of 2026-09-08 (`requests/labels.ts`).
 */

/** Written to the export log with every download; bump it with every change of anything in this file. */
export const FORMAT_VERSION = 1;

/** The media type of the response. */
export const CONTENT_TYPE = "text/csv; charset=utf-8";

/** UTF-8 byte-order mark (EF BB BF once encoded), so a spreadsheet detects the encoding. */
export const BOM = "﻿";

export const SEPARATOR = ";";
export const DECIMAL_MARK = ".";
export const LINE_ENDING = "\r\n";
export const QUOTE = '"';

/**
 * A text cell that starts with one of these is read as a formula by a
 * spreadsheet (CSV injection): it is written with {@link FORMULA_GUARD_PREFIX}
 * in front. Applied to every text column by `export.ts`, never per field.
 */
export const FORMULA_TRIGGERS: readonly string[] = ["=", "+", "-", "@", "\t", "\r"];
export const FORMULA_GUARD_PREFIX = "'";

/** `text` cells are guarded and quoted by the rules; `number` cells are produced by this module's formatters and are never text. */
export type ColumnKind = "text" | "number";

export interface ColumnSpec {
  readonly key: string;
  readonly header: string;
  readonly kind: ColumnKind;
}

/** The 16 columns of AC-6.2, in this order. */
export const COLUMNS = [
  { key: "employee", header: "Employee", kind: "text" },
  { key: "receiptNumber", header: "Receipt number", kind: "text" },
  { key: "expenseDate", header: "Expense date", kind: "text" },
  { key: "expenseType", header: "Expense type", kind: "text" },
  { key: "reason", header: "Reason", kind: "text" },
  { key: "km", header: "Km", kind: "number" },
  { key: "currency", header: "Currency", kind: "text" },
  { key: "approvedTotal", header: "Approved total", kind: "number" },
  { key: "exchangeRate", header: "Exchange rate", kind: "number" },
  { key: "chfAmount", header: "CHF amount", kind: "number" },
  { key: "accountNumber", header: "Account number", kind: "text" },
  { key: "accountName", header: "Account name", kind: "text" },
  { key: "vatCode", header: "VAT code", kind: "text" },
  { key: "vatRate", header: "VAT rate (%)", kind: "number" },
  { key: "vatAmount", header: "VAT amount (CHF)", kind: "number" },
  { key: "batch", header: "Batch", kind: "text" },
] as const satisfies readonly ColumnSpec[];

export type ColumnKey = (typeof COLUMNS)[number]["key"];

/** `refund-accounting-<cutoff YYYY-MM-DD>-<batchId>.csv`: no personal data in it (the UI builds the same name, UX-12). */
export function exportFilename(cutoff: Date, batchId: string): string {
  const safeId = batchId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `refund-accounting-${cutoff.toISOString().slice(0, 10)}-${safeId}.csv`;
}
