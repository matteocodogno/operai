/**
 * Decodes the legacy Excel register into typed rows (T23, specs/015-hardware-
 * inventory; US-12). Pure: takes rows of plain values, returns data plus the
 * issues it could not resolve. It knows the SHAPE of the sheet (a header, the
 * purchase rows, a blank, the cession rows, the year-end block) and nothing
 * about the database.
 *
 * Nothing is guessed. A cell it cannot read as what its column holds, a row that
 * fits no region, a header that is not the one this script was written for: each
 * is an `error` issue naming the sheet row, and the caller refuses to apply.
 * (The undecided cases of spec O5 are the planner's, not the parser's.)
 *
 * Personal data never leaves a row through here: the free text of a cession
 * row ("<name>, cessione <model>") is used to recognise the row and dropped.
 */

import { toCents } from "./money";
import {
  VALUE_YEARS,
  type CessionRow,
  type Issue,
  type ParsedSheet,
  type PurchaseRow,
  type SheetRow,
  type SheetTotal,
  type YearEndLine,
} from "./types";

/** Column letter of each dated column. */
const CLOSING_COLUMN: Record<number, string> = { 2023: "F", 2024: "H", 2025: "J", 2026: "L", 2027: "N", 2028: "P" };
const DEPRECIATION_COLUMN: Record<number, string> = { 2024: "G", 2025: "I", 2026: "K", 2027: "M", 2028: "O" };
const COLUMNS = "ABCDEFGHIJKLMNOP".split("");
const MONEY_COLUMNS = COLUMNS.slice(5);

const HEADER = [
  "data di acquisto",
  "descrizione",
  "sn/imei",
  "assigned",
  "prezzo acq. chf",
  "valore al 31.12.2023",
  "ammortamento 2024",
  "valore al 31.12.2024",
  "ammortamento 2025",
  "valore al 31.12.2025",
  "ammortamento 2026",
  "valore al 31.12.2026",
  "ammortamento 2027",
  "valore al 31.12.2027",
  "ammortamento 2028",
  "valore al 31.12.2028",
];

const MAX_DESCRIPTION = 500;
const MAX_SERIAL = 200;

const norm = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();
const isEmpty = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** A calendar date as `YYYY-MM-DD`, or null if the day does not exist. */
function isoDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A typed date cell, or text `dd.mm.yyyy`; anything else is null. */
export function parseDateCell(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Excel dates are whole days at UTC midnight; a time of day means it is not what we think it is.
    if (value.getTime() % 86_400_000 !== 0) return null;
    return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === "string") {
    const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(value);
    if (!m) return null;
    return isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  }
  return null;
}

export function parseSheet(rows: readonly SheetRow[]): ParsedSheet {
  const issues: Issue[] = [];
  const purchases: PurchaseRow[] = [];
  const cessions: CessionRow[] = [];
  const yearEnd: YearEndLine[] = [];
  const totals: SheetTotal[] = [];
  const error = (row: number, code: string, message: string) => issues.push({ kind: "error", row, code, message });

  const sorted = [...rows].sort((a, b) => a.row - b.row);
  const header = sorted.find((r) => r.row === 1);
  const headerOk =
    header !== undefined &&
    HEADER.every((expected, i) => {
      const cell = header.cells[COLUMNS[i]!];
      return typeof cell === "string" && norm(cell) === expected;
    });
  if (!headerOk) {
    error(1, "header_mismatch", "Row 1 is not the header this script was written for (A-P: Data di acquisto ... Valore al 31.12.2028)");
    return { purchases, cessions, yearEnd, totals, issues };
  }

  /** The decoded money cell, `undefined` when empty; null (and an error) when it is not a plain non-negative number. */
  const money = (r: SheetRow, column: string): number | undefined | null => {
    const v = r.cells[column];
    if (isEmpty(v)) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      error(r.row, "bad_amount", `Column ${column} is not a plain non-negative number`);
      return null;
    }
    return toCents(v);
  };

  let phase: "purchases" | "after" = "purchases";
  let previous = 1;

  for (const r of sorted) {
    if (r.row === 1) continue;
    // Rows with no cells at all are not in the input, so a gap in the numbering IS the blank row.
    if (r.row > previous + 1) phase = "after";
    previous = r.row;
    const present = COLUMNS.filter((c) => !isEmpty(r.cells[c]));
    if (present.length === 0) {
      phase = "after";
      continue;
    }
    const has = (c: string) => present.includes(c);

    if (phase === "purchases") {
      // A row of figures only, no date, text or price: a column total (e.g. the sum of "Ammortamento 2025").
      if (!has("A") && !has("B") && !has("C") && !has("D") && !has("E")) {
        for (const c of present) {
          const cents = money(r, c);
          if (typeof cents === "number") totals.push({ row: r.row, column: c, cents });
        }
        continue;
      }
      if (!has("B")) {
        error(r.row, "unclassified_row", "A row between the purchases has no description");
        continue;
      }
      const row = parsePurchase(r, money, error);
      if (row) purchases.push(row);
      continue;
    }

    // After the first blank row: cession rows and the year-end block.
    const b = r.cells["B"];
    if (has("B") && typeof b === "string" && /cession/i.test(b)) {
      const date = parseDateCell(r.cells["A"]);
      if (!date) {
        error(r.row, "bad_date", "Cession row: column A is not a date");
        continue;
      }
      const price = money(r, "E");
      if (typeof price !== "number") {
        if (price === undefined) error(r.row, "bad_amount", "Cession row: column E (price) is empty");
        continue;
      }
      const serial = r.cells["C"];
      if (!isEmpty(serial) && typeof serial !== "string") {
        error(r.row, "bad_serial", "Cession row: column C is not text");
        continue;
      }
      cessions.push({
        row: r.row,
        date,
        serial: typeof serial === "string" && serial.trim() !== "" ? serial.trim() : null,
        priceCents: price,
      });
      continue;
    }
    const a = r.cells["A"];
    if (!has("B") && typeof a === "string" && has("E") && present.every((c) => c === "A" || c === "E")) {
      const cents = money(r, "E");
      if (typeof cents === "number") yearEnd.push({ row: r.row, label: a.trim(), cents });
      continue;
    }
    error(r.row, "unclassified_row", "A row below the purchases is neither a cession nor a year-end line");
  }

  return { purchases, cessions, yearEnd, totals, issues };
}

function parsePurchase(
  r: SheetRow,
  money: (r: SheetRow, column: string) => number | undefined | null,
  error: (row: number, code: string, message: string) => void,
): PurchaseRow | null {
  let ok = true;
  const fail = (code: string, message: string) => {
    ok = false;
    error(r.row, code, message);
  };

  const purchaseDate = parseDateCell(r.cells["A"]);
  if (!purchaseDate) fail("bad_date", "Column A is not a date (typed date or text dd.mm.yyyy)");

  const b = r.cells["B"];
  const description = typeof b === "string" ? b.trim().replace(/\s+/g, " ") : "";
  if (description === "") fail("bad_description", "Column B is not text");
  if (description.length > MAX_DESCRIPTION) fail("bad_description", `Column B is longer than ${MAX_DESCRIPTION} characters`);

  const c = r.cells["C"];
  let serial: string | null = null;
  let ordered = false;
  if (!isEmpty(c)) {
    if (typeof c !== "string") {
      fail("bad_serial", "Column C is not text (a serial stored as a number loses digits)");
    } else if (/^\s*ordinato\b/i.test(c)) {
      ordered = true;
    } else {
      serial = c.trim();
      if (serial.length > MAX_SERIAL) fail("bad_serial", `Column C is longer than ${MAX_SERIAL} characters`);
    }
  }

  const d = r.cells["D"];
  let assigneeText: string | null = null;
  if (!isEmpty(d)) {
    if (typeof d !== "string") fail("bad_assignee", "Column D is not text");
    else assigneeText = d.trim().replace(/\s+/g, " ");
  }

  const price = money(r, "E");
  if (price === undefined) fail("bad_amount", "Column E (price) is empty");
  else if (price === null) ok = false;
  else if (price <= 0) fail("bad_amount", "Column E (price) must be greater than zero");

  const closing: Partial<Record<number, number>> = {};
  const depreciation: Partial<Record<number, number>> = {};
  for (const column of MONEY_COLUMNS) {
    const cents = money(r, column);
    if (cents === null) {
      ok = false;
      continue;
    }
    if (cents === undefined) continue;
    const closingYear = VALUE_YEARS.find((y) => CLOSING_COLUMN[y] === column);
    const depreciationYear = VALUE_YEARS.find((y) => DEPRECIATION_COLUMN[y] === column);
    if (closingYear !== undefined) closing[closingYear] = cents;
    else if (depreciationYear !== undefined) depreciation[depreciationYear] = cents;
  }

  if (!ok || !purchaseDate || typeof price !== "number") return null;
  return { row: r.row, purchaseDate, description, serial, ordered, assigneeText, priceCents: price, closing, depreciation };
}
