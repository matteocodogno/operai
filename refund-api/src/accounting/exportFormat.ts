/**
 * EVERY FORMAT CHOICE of the accounting export, in one module (T17 as a CSV, specs/20261118-refund-accounting-export;
 * rewritten by T62, specs/20261119-accounting as an XLSX journal workbook: SO-6 to SO-12 of that plan's "Accounting sign-off
 * delta (2026-11-19)"; AC-6.1, AC-6.2, AC-6.8, AC-6.13 to AC-6.17; ADR 20261118-the-accounting-export-is-generated-on-request-
 * never-stored-and-logged-append-only-with-its-content-hash-and-format-version, amendment 2026-11-19, accounting sign-off).
 *
 * THIS IS THE ONE PLACE TO CHANGE the file's dialect: the sheet name, the header, the column order, the cell types and styles,
 * the Description pattern and its sanitiser, the row order. A change is an edit here, a bump of `FORMAT_VERSION` (which the
 * export log records per download) and one deliberate diff of `fixtures/accounting-export.golden.xlsx` and
 * `fixtures/accounting-export.golden.cells.json`. `xlsx.ts` is mechanism only (it writes whatever cells it is given);
 * `export.ts` maps lines to cells and knows no label, format or pattern of its own.
 *
 * The shape is the accountant's sample import file (the "Riclassificazione RS" workbook of the accounting system), which is
 * binding: one sheet `Sheet 1`; the header `Date | Description | Debit | Credit | Amount | Currency | Tax | Note`; Date a date
 * shown as `yyyy-mm-dd`; Debit, Credit and Amount numbers; Currency text; Tax and Note present and empty on every row; rows
 * latest Date first.
 */

import type { XlsxStyle } from "./xlsx";

/** Written to the export log with every download; bump it with every change of anything in this file. 1 was the CSV. */
export const FORMAT_VERSION = 2;

/** The media type of the response. */
export const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const SHEET_NAME = "Sheet 1";

/** The eight columns A to H of AC-6.2, in this order, with these exact names. No other column exists. */
export const HEADERS = ["Date", "Description", "Debit", "Credit", "Amount", "Currency", "Tax", "Note"] as const;

/** Column widths in characters (presentation only): Date, Description, Debit, Credit, Amount, Currency, Tax, Note. */
export const COLUMN_WIDTHS: readonly number[] = [12, 70, 10, 10, 12, 10, 10, 39];

/** The credit account of every row: "Rimborso spese effettive" (AC-6.2). */
export const CREDIT_ACCOUNT = "5832";

/** Every row is booked in CHF: a line in another currency carries its CHF amount (AC-6.2, AC-6.3). */
export const CURRENCY = "CHF";

export const DECIMAL_MARK = ".";

// ─── Cell styles ─────────────────────────────────────────────────────────────

/** The date format of the template: `yyyy\-mm\-dd;@`. */
export const NUM_FMTS: Readonly<Record<number, string>> = { 164: "yyyy\\-mm\\-dd;@" };

/**
 * `cellXfs`, as in the template: 164 for the date, built-in 2 (`0.00`) for the Amount, 49 (`@`, text) for text, General for
 * Debit and Credit. EVERY text style carries `quotePrefix` (AC-6.15): a spreadsheet keeps `=SUM(...)` as text in it.
 */
export const STYLES: readonly XlsxStyle[] = [
  { numFmtId: 0 },
  { numFmtId: 49, bold: true, quotePrefix: true },
  { numFmtId: 164, horizontal: "left" },
  { numFmtId: 49, quotePrefix: true },
  { numFmtId: 0 },
  { numFmtId: 2, horizontal: "right" },
];

/** Indexes into {@link STYLES}. */
export const STYLE = { default: 0, header: 1, date: 2, text: 3, number: 4, amount: 5 } as const;

// ─── Numbers and dates ───────────────────────────────────────────────────────

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
}

/** `962` -> `9.62`, `0` -> `0.00`, `1040` -> `10.40`: exact, from integer cents, two decimals, no thousands separator, never a float. */
export function formatCents(cents: number): string {
  assertNonNegativeInteger("cents", cents);
  return `${Math.floor(cents / 100)}${DECIMAL_MARK}${String(cents % 100).padStart(2, "0")}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Serial 61 is 1900-03-01: from there the 1900 date system and the real calendar agree (before it, Excel's leap-year bug). */
const FIRST_SERIAL = 61;
const LAST_SERIAL = 2_958_465; // 9999-12-31

/**
 * `2026-03-02` -> `46083`: the number of days since 1899-12-30 (the 1900 date system), by integer arithmetic on the three
 * parts of the string: no `Date`, no time zone, no clock. A date that does not exist (`2026-02-30`) or that the system cannot
 * represent is refused.
 */
export function dateSerial(isoDate: string): string {
  const match = DATE_RE.exec(isoDate);
  if (!match) throw new RangeError(`date must be YYYY-MM-DD, got ${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth) throw new RangeError(`not a calendar date: ${isoDate}`);
  // Days since 1970-01-01 (Howard Hinnant's days_from_civil), then the offset of the 1900 system.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const serial = era * 146_097 + dayOfEra - 719_468 + 25_569;
  if (serial < FIRST_SERIAL || serial > LAST_SERIAL) throw new RangeError(`date outside the range a workbook can hold: ${isoDate}`);
  return String(serial);
}

// ─── Debit: a number when a number holds it exactly (AC-6.17) ────────────────

/**
 * An account number that is its own canonical decimal: no sign, no leading zero, no trailing zero in the fraction, no
 * exponent (`5905`, `2620.1`), and at most 15 significant digits, so the double a spreadsheet stores is the same number.
 * (SO-8 gives the pattern `^[1-9][0-9]{0,14}(\.[0-9]*[1-9])?$`; the digit bound closes the one hole it has, a long fraction.)
 * `2620.10`, `1.2.3`, `0123`, `5905 ` are not: they are written as text, unchanged, never rounded or reformatted.
 */
export function isCanonicalAccountNumber(value: string): boolean {
  return /^[1-9][0-9]{0,14}(\.[0-9]*[1-9])?$/.test(value) && value.replace(".", "").length <= 15;
}

// ─── Text: the sanitiser and the Description (AC-6.13, AC-6.15) ──────────────

/**
 * One line of safe text: each control character (C0 and C1, which includes CR, LF, TAB and DEL) and U+2028 and U+2029 becomes
 * a space; a character XML 1.0 cannot carry (a lone surrogate, U+FFFE, U+FFFF) becomes U+FFFD; runs of spaces collapse to one;
 * the ends are trimmed of spaces. Nothing else is touched: the text is otherwise exactly as written (AC-6.15).
 */
export function sanitizeText(value: string): string {
  let out = "";
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) out += " ";
    else if ((cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) out += "�";
    else out += char;
  }
  return out.replace(/ {2,}/g, " ").replace(/^ | $/g, "");
}

export interface DescriptionParts {
  /** The line's reason (`motivo`), free text. */
  readonly reason: string;
  readonly receiptNumber: string;
  /** The line's own currency and its approved total in it, as `10.40`. Only read for a currency other than CHF. */
  readonly currency: string;
  readonly approvedAmount: string;
  /** The CHF equivalent, as `9.62`. */
  readonly chfAmount: string;
  /** The employee's name, or the email when the account has none. */
  readonly employee: string;
}

/**
 * The Description cell (AC-6.13), PROVISIONAL until the accountant answers (SO-9; a change is a `FORMAT_VERSION` bump and a
 * golden diff):
 *
 *   `<reason> [<receipt number>] <employee>`                                   for a CHF line
 *   `<reason> [<receipt number>] [<CUR> <approved total> = CHF <CHF>] <employee>`   for any other currency
 *
 * for example `Cancelleria [MC26/001] [EUR 10.40 = CHF 9.62] Matteo Codogno`. The whole string goes through
 * {@link sanitizeText}, so it is always one line, whatever the reason or the name holds.
 */
export function describeLine(parts: DescriptionParts): string {
  const foreign = parts.currency === CURRENCY ? "" : ` [${parts.currency} ${parts.approvedAmount} = ${CURRENCY} ${parts.chfAmount}]`;
  return sanitizeText(`${parts.reason} [${parts.receiptNumber}]${foreign} ${parts.employee}`);
}

// ─── Order (AC-6.16, AC-6.8) ─────────────────────────────────────────────────

/** Compares by Unicode code point (the order of UTF-8 bytes), which `<` on a JS string is not for characters above U+FFFF. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

export interface RowOrderKey {
  /** `YYYY-MM-DD` */
  readonly date: string;
  /** The employee cell: the name, or the email when the account has none. */
  readonly employee: string;
  readonly ownerUserId: string;
  readonly receiptYear: number;
  readonly receiptSeq: number;
  readonly lineId: string;
}

/**
 * Date, the latest first (as the template); then, ascending, the employee in code point order (not locale, not UTF-16 code
 * unit order), `ownerUserId`, receipt year, receipt sequence and line id. The same lines give the same order whatever order
 * they arrive in (AC-6.8).
 */
export function compareRows(a: RowOrderKey, b: RowOrderKey): number {
  return (
    compareCodePoints(b.date, a.date) ||
    compareCodePoints(a.employee, b.employee) ||
    compareCodePoints(a.ownerUserId, b.ownerUserId) ||
    a.receiptYear - b.receiptYear ||
    a.receiptSeq - b.receiptSeq ||
    compareCodePoints(a.lineId, b.lineId)
  );
}

// ─── The download ────────────────────────────────────────────────────────────

/** `refund-accounting-<cutoff YYYY-MM-DD>-<batchId>.xlsx`: no personal data in it (the UI builds the same name, UX-12). */
export function exportFilename(cutoff: Date, batchId: string): string {
  const safeId = batchId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `refund-accounting-${cutoff.toISOString().slice(0, 10)}-${safeId}.xlsx`;
}
