/**
 * Reads the register workbook into plain rows (T23, specs/015-hardware-
 * inventory). The file is untrusted input and is only ever READ: it is opened
 * from the path given, never copied, and nothing from it is written anywhere but
 * the report the operator asked for.
 */

import ExcelJS from "exceljs";
import { statSync } from "node:fs";
import type { SheetRow } from "./types";

/** An xlsx of a few hundred rows is tens of KiB; this only stops a hostile or wrong file from being unzipped into memory. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Columns A-P. */
const LAST_COLUMN = 16;

/** A cell's value with formulas resolved to their cached result and rich text flattened. */
export function plainValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;
  if ("result" in value) {
    const result = (value as { result?: unknown }).result;
    if (result && typeof result === "object" && !(result instanceof Date)) return "#ERROR";
    return result ?? null;
  }
  if ("error" in value) return "#ERROR";
  if ("richText" in value) return (value as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
  if ("text" in value) return String((value as { text: unknown }).text);
  return "#UNREADABLE";
}

export function rowsFromWorksheet(ws: ExcelJS.Worksheet): SheetRow[] {
  const rows: SheetRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: Record<string, unknown> = {};
    for (let c = 1; c <= LAST_COLUMN; c++) {
      const v = plainValue(row.getCell(c).value);
      if (v !== null) cells[String.fromCharCode(64 + c)] = v;
    }
    rows.push({ row: rowNumber, cells });
  });
  return rows;
}

export async function readSheetRows(path: string): Promise<SheetRow[]> {
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) throw new Error(`${path} is ${size} bytes; refusing to read a workbook over ${MAX_FILE_BYTES}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  if (workbook.worksheets.length !== 1) {
    throw new Error(`Expected exactly one worksheet, found ${workbook.worksheets.length}`);
  }
  return rowsFromWorksheet(workbook.worksheets[0]!);
}
