/**
 * Pure, DB-free CSV of the accounting export (T17, specs/20261118-refund-
 * accounting-export; AC-6.2, AC-6.3, AC-6.4, AC-6.8, AC-6.12; ADR 20261118-the-
 * accounting-export-is-generated-on-request-never-stored-and-logged-append-only-
 * with-its-content-hash-and-format-version, ADR 20261118-chf-and-vat-amounts-are-
 * derived-on-read-...).
 *
 * `buildAccountingCsv(lines)` turns the exportable lines of a batch into the
 * bytes of the file. It is deterministic: the same lines, in ANY input order,
 * give the same bytes (AC-6.8). There is no timestamp, no random value and no
 * locale-dependent comparison anywhere in it.
 *
 * - Format choices (separator, decimal mark, BOM, line ending, headers) all
 *   come from `exportFormat.ts`; this file has none of its own.
 * - The CHF and VAT amounts are computed HERE, by the same `chfCents` and
 *   `vatCents` the accounting view uses, from the line's approved amount, the
 *   rate in effect and the frozen VAT code's basis points. A caller cannot hand
 *   in a figure that disagrees with the screen (AC-6.3: 1040 EUR cents at
 *   924600 micros is 9.62; AC-6.4: 20.80 at 8.1 % is a VAT of 1.56; AC-6.12:
 *   0 gives 0.00 and 0.00).
 * - Rows are sorted by the employee column in CODE POINT order (not locale, and
 *   not UTF-16 code unit order), then `ownerUserId`, `receiptYear`,
 *   `receiptSeq` and the line id.
 * - Every `text` column goes through ONE formula guard (a cell that starts with
 *   `= + - @ TAB CR` gets a leading `'`) and then RFC 4180 quoting (a cell with
 *   the separator, `"`, CR or LF, or with a leading or trailing space, is
 *   quoted with `"` doubled). `number` columns are produced by this module's
 *   own formatters from non-negative integers, so they can never need either.
 *
 * Missing inputs are programming errors here, not data: a foreign-currency line
 * with no rate, or any line with no VAT code, makes `buildAccountingCsv` throw a
 * `RangeError`. The caller (T18) turns those cases into blockers BEFORE it asks
 * for a file, so a partial file can never be produced (ADR decision 4).
 */

import { expenseTypeLabel } from "../requests/labels";
import { chfCents, vatCents } from "./amounts";
import {
  BOM,
  COLUMNS,
  DECIMAL_MARK,
  FORMULA_GUARD_PREFIX,
  FORMULA_TRIGGERS,
  LINE_ENDING,
  QUOTE,
  SEPARATOR,
  type ColumnKey,
} from "./exportFormat";

/** One exportable line: an approved, not rejected, numbered and classified WellD CH line of a batch. */
export interface AccountingExportLine {
  readonly lineId: string;
  readonly ownerUserId: string;
  /** The employee's display name, `null` when the account has none: the email is then the Employee cell. */
  readonly ownerName: string | null;
  readonly ownerEmail: string;
  readonly receiptNumber: string;
  readonly receiptYear: number;
  readonly receiptSeq: number;
  /** `YYYY-MM-DD` */
  readonly date: string;
  /** The `ExpenseType` enum value; the cell carries its document label. */
  readonly type: string;
  /** The line's reason (`motivo`), free text typed by the employee. */
  readonly motivo: string;
  readonly km: number | null;
  readonly currency: string;
  /** `approvedTotalCents` in the line's own currency. */
  readonly approvedCents: number;
  /** CHF per 1 unit of `currency`, times 1e6; `null` for CHF (and ignored for it). Required for any other currency. */
  readonly rateMicros: number | null;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly vatCode: string;
  readonly vatRateBasisPoints: number;
  readonly batchId: string;
}

export interface AccountingCsv {
  /** The whole file as text, starting with the byte-order mark character. */
  readonly text: string;
  /** The UTF-8 bytes of `text`: what is sent, hashed and logged. */
  readonly bytes: Uint8Array;
  /** Data rows, without the header. */
  readonly rowCount: number;
}

// ─── Number formats ──────────────────────────────────────────────────────────

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
}

/** `962` -> `9.62`, `0` -> `0.00`, `1040` -> `10.40`: two decimals, no thousands separator. */
export function formatCents(cents: number): string {
  assertNonNegativeInteger("cents", cents);
  return `${Math.floor(cents / 100)}${DECIMAL_MARK}${String(cents % 100).padStart(2, "0")}`;
}

/** `924600` -> `0.9246`; up to six decimals, trailing zeros trimmed to at least four (`1000000` -> `1.0000`). */
export function formatRateMicros(rateMicros: number): string {
  assertNonNegativeInteger("rateMicros", rateMicros);
  let fraction = String(rateMicros % 1_000_000).padStart(6, "0");
  while (fraction.length > 4 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${Math.floor(rateMicros / 1_000_000)}${DECIMAL_MARK}${fraction}`;
}

/** `810` -> `8.10`, `0` -> `0.00`, `10000` -> `100.00`: a rate in basis points as a percentage with two decimals. */
export function formatBasisPoints(basisPoints: number): string {
  assertNonNegativeInteger("basisPoints", basisPoints);
  return `${Math.floor(basisPoints / 100)}${DECIMAL_MARK}${String(basisPoints % 100).padStart(2, "0")}`;
}

// ─── Text cells ──────────────────────────────────────────────────────────────

/** Text that a spreadsheet would read as a formula gets a leading `'`; everything else is untouched. */
export function guardFormula(value: string): string {
  return FORMULA_TRIGGERS.some((trigger) => value.startsWith(trigger)) ? `${FORMULA_GUARD_PREFIX}${value}` : value;
}

/** RFC 4180: a field with the separator, a quote, CR or LF, or a leading or trailing space, is quoted and `"` doubled. */
export function quoteField(value: string): string {
  const needsQuotes =
    value.includes(SEPARATOR) ||
    value.includes(QUOTE) ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.startsWith(" ") ||
    value.endsWith(" ");
  return needsQuotes ? `${QUOTE}${value.split(QUOTE).join(QUOTE + QUOTE)}${QUOTE}` : value;
}

// ─── Ordering ────────────────────────────────────────────────────────────────

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

/** The Employee cell: the name, or the email when the account has no (non-blank) name. */
export const employeeCell = (line: Pick<AccountingExportLine, "ownerName" | "ownerEmail">): string =>
  line.ownerName !== null && line.ownerName.trim() !== "" ? line.ownerName : line.ownerEmail;

export function compareExportLines(a: AccountingExportLine, b: AccountingExportLine): number {
  return (
    compareCodePoints(employeeCell(a), employeeCell(b)) ||
    compareCodePoints(a.ownerUserId, b.ownerUserId) ||
    a.receiptYear - b.receiptYear ||
    a.receiptSeq - b.receiptSeq ||
    compareCodePoints(a.lineId, b.lineId)
  );
}

// ─── Rows ────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cellsOf(line: AccountingExportLine): Record<ColumnKey, string> {
  if (!DATE_RE.test(line.date)) throw new RangeError(`date must be YYYY-MM-DD, got ${line.date}`);
  assertNonNegativeInteger("receiptYear", line.receiptYear);
  assertNonNegativeInteger("receiptSeq", line.receiptSeq);

  const isChf = line.currency === "CHF";
  if (!isChf && line.rateMicros === null) {
    throw new RangeError(`line ${line.lineId} in ${line.currency} has no exchange rate: the export must be blocked before this`);
  }
  const chf = chfCents(line.approvedCents, line.currency, isChf ? null : line.rateMicros);
  const vat = vatCents(chf, line.vatRateBasisPoints);
  if (chf === null || vat === null) {
    throw new RangeError(`line ${line.lineId} has no CHF or VAT amount: the export must be blocked before this`);
  }

  let km = "";
  if (line.type === "travel_km" && line.km !== null) {
    assertNonNegativeInteger("km", line.km);
    km = String(line.km);
  }

  return {
    employee: employeeCell(line),
    receiptNumber: line.receiptNumber,
    expenseDate: line.date,
    expenseType: expenseTypeLabel(line.type),
    reason: line.motivo,
    km,
    currency: line.currency,
    approvedTotal: formatCents(line.approvedCents),
    exchangeRate: isChf ? "" : formatRateMicros(line.rateMicros!),
    chfAmount: formatCents(chf),
    accountNumber: line.accountNumber,
    accountName: line.accountName,
    vatCode: line.vatCode,
    vatRate: formatBasisPoints(line.vatRateBasisPoints),
    vatAmount: formatCents(vat),
    batch: line.batchId,
  };
}

const encoder = new TextEncoder();

/** The accounting CSV of the given lines (AC-6.1, AC-6.2): a header, then one row per line, sorted; the header alone for none (AC-6.7). */
export function buildAccountingCsv(lines: readonly AccountingExportLine[]): AccountingCsv {
  const header = COLUMNS.map((column) => quoteField(column.header)).join(SEPARATOR);
  const rows = [...lines].sort(compareExportLines).map((line) => {
    const cells = cellsOf(line);
    return COLUMNS.map((column) => {
      const value = cells[column.key];
      return column.kind === "text" ? quoteField(guardFormula(value)) : value;
    }).join(SEPARATOR);
  });
  const text = BOM + [header, ...rows].map((row) => row + LINE_ENDING).join("");
  return { text, bytes: encoder.encode(text), rowCount: rows.length };
}
