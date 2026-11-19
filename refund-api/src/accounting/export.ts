/**
 * Pure, DB-free accounting export workbook (T17 as a CSV, specs/20261118-refund-accounting-export; rewritten by T62,
 * specs/20261119-accounting; AC-6.1, AC-6.2, AC-6.3, AC-6.7, AC-6.8, AC-6.12 to AC-6.17; SO-7 to SO-11 of that plan's "Accounting
 * sign-off delta"; ADR 20261118-the-accounting-export-is-generated-on-request-never-stored-and-logged-append-only-with-its-
 * content-hash-and-format-version, ADR 20261118-chf-and-vat-amounts-are-derived-on-read-...).
 *
 * `buildAccountingFile(lines)` turns the exportable lines of a batch into the bytes of an `.xlsx`. It is deterministic: the
 * same lines, in ANY input order, give the same bytes (AC-6.8). There is no timestamp, no random value and no locale-dependent
 * comparison anywhere in it, and the workbook writer (`xlsx.ts`) stamps nothing.
 *
 * - Every format choice (sheet name, header, styles, the Description pattern and its sanitiser, the order) comes from
 *   `exportFormat.ts`; this file only maps a line to the eight cells and hands them to the writer.
 * - The CHF amount is computed HERE, by the same `chfCents` the accounting view uses, from the line's approved amount and the
 *   rate in effect. A caller cannot hand in a figure that disagrees with the screen (AC-6.3: 1040 EUR cents at 924600 micros is
 *   9.62; AC-6.12: 0 gives 0.00). It is the row's Amount, the only amount in the file: no VAT, no other currency (AC-6.2).
 * - Text (the Description, and a Debit that is not a plain number) reaches the file only as a shared string, sanitised to one
 *   line and XML-escaped by the writer; no cell is ever a formula (AC-6.15).
 *
 * Missing inputs are programming errors here, not data: a foreign-currency line with no rate makes `buildAccountingFile` throw
 * a `RangeError`. The caller turns those cases into blockers BEFORE it asks for a file, so a partial file can never be produced
 * (ADR decision 4).
 */

import { chfCents } from "./amounts";
import {
  COLUMN_WIDTHS,
  compareRows,
  CREDIT_ACCOUNT,
  CURRENCY,
  dateSerial,
  describeLine,
  formatCents,
  HEADERS,
  isCanonicalAccountNumber,
  NUM_FMTS,
  sanitizeText,
  SHEET_NAME,
  STYLE,
  STYLES,
} from "./exportFormat";
import { writeXlsx, type XlsxCell } from "./xlsx";

/** One exportable line: an approved, not rejected, numbered and classified WellD CH line of a batch. */
export interface AccountingExportLine {
  readonly lineId: string;
  readonly ownerUserId: string;
  /** The employee's display name, `null` when the account has none: the email is then the name in the Description. */
  readonly ownerName: string | null;
  readonly ownerEmail: string;
  readonly receiptNumber: string;
  readonly receiptYear: number;
  readonly receiptSeq: number;
  /** `YYYY-MM-DD` */
  readonly date: string;
  /** The line's reason (`motivo`), free text typed by the employee. */
  readonly motivo: string;
  readonly currency: string;
  /** `approvedTotalCents` in the line's own currency. */
  readonly approvedCents: number;
  /** CHF per 1 unit of `currency`, times 1e6; `null` for CHF (and ignored for it). Required for any other currency. */
  readonly rateMicros: number | null;
  /** The ledger account, as stored: the Debit cell. */
  readonly accountNumber: string;
}

export interface AccountingFile {
  /** The `.xlsx`: what is sent, hashed and logged. */
  readonly bytes: Uint8Array;
  /** Data rows, without the header. */
  readonly rowCount: number;
}

/** The employee: the name, or the email when the account has no (non-blank) name. */
export const employeeCell = (line: Pick<AccountingExportLine, "ownerName" | "ownerEmail">): string =>
  line.ownerName !== null && line.ownerName.trim() !== "" ? line.ownerName : line.ownerEmail;

/** The order of the rows (AC-6.16): see `compareRows`. */
export const compareExportLines = (a: AccountingExportLine, b: AccountingExportLine): number =>
  compareRows({ ...a, employee: employeeCell(a) }, { ...b, employee: employeeCell(b) });

function rowOf(line: AccountingExportLine): XlsxCell[] {
  const date = dateSerial(line.date); // refuses a date that is not YYYY-MM-DD, or does not exist
  if (!Number.isSafeInteger(line.receiptYear) || line.receiptYear < 0) throw new RangeError("receiptYear must be a non-negative integer");
  if (!Number.isSafeInteger(line.receiptSeq) || line.receiptSeq < 0) throw new RangeError("receiptSeq must be a non-negative integer");

  const isChf = line.currency === CURRENCY;
  if (!isChf && line.rateMicros === null) {
    throw new RangeError(`line ${line.lineId} in ${line.currency} has no exchange rate: the export must be blocked before this`);
  }
  const chf = chfCents(line.approvedCents, line.currency, isChf ? null : line.rateMicros);
  if (chf === null) throw new RangeError(`line ${line.lineId} has no CHF amount: the export must be blocked before this`);

  const description = describeLine({
    reason: line.motivo,
    receiptNumber: line.receiptNumber,
    currency: line.currency,
    approvedAmount: formatCents(line.approvedCents),
    chfAmount: formatCents(chf),
    employee: employeeCell(line),
  });
  // A plain account number is a number (5905, 2620.1); any other is text, unchanged (AC-6.17), but one line like any text.
  const debit: XlsxCell = isCanonicalAccountNumber(line.accountNumber)
    ? { kind: "number", value: line.accountNumber, style: STYLE.number }
    : { kind: "text", value: sanitizeText(line.accountNumber), style: STYLE.text };

  return [
    { kind: "number", value: date, style: STYLE.date },
    { kind: "text", value: description, style: STYLE.text },
    debit,
    { kind: "number", value: CREDIT_ACCOUNT, style: STYLE.number },
    { kind: "number", value: formatCents(chf), style: STYLE.amount },
    { kind: "text", value: CURRENCY, style: STYLE.text },
    { kind: "empty", style: STYLE.text }, // Tax (AC-6.14)
    { kind: "empty", style: STYLE.text }, // Note (AC-6.14)
  ];
}

/** The accounting workbook of the given lines (AC-6.1, AC-6.2): a header, then one row per line, sorted; the header alone for none (AC-6.7). */
export function buildAccountingFile(lines: readonly AccountingExportLine[]): AccountingFile {
  const header: XlsxCell[] = HEADERS.map((value) => ({ kind: "text", value, style: STYLE.header }));
  const rows = [...lines].sort(compareExportLines).map(rowOf);
  const bytes = writeXlsx({
    sheetName: SHEET_NAME,
    numFmts: NUM_FMTS,
    styles: STYLES,
    columnWidths: COLUMN_WIDTHS,
    rows: [header, ...rows],
  });
  return { bytes, rowCount: rows.length };
}
