/**
 * A SYNTHETIC register for the import tests (T23). Every name, serial and amount
 * here is invented; the real workbook is company data and is never copied into
 * the repository. The layout mirrors the real sheet's regions: a header, the
 * purchase rows, one column-total row, a blank, the cession rows, a blank, and
 * the year-end block - and it includes one of each case the ACs name.
 */

import ExcelJS from "exceljs";
import type { SheetRow } from "./types";

export type CellInput = string | number | Date | { formula: string; result: number } | null;
/** Sheet row number -> cells A..P. Absent row numbers are blank rows. */
export type FixtureRows = Map<number, CellInput[]>;

const COLUMNS = "ABCDEFGHIJKLMNOP".split("");

export const HEADER_LABELS = [
  "Data di acquisto",
  "Descrizione",
  "SN/IMEI",
  "Assigned",
  "Prezzo acq. CHF",
  "Valore al 31.12.2023",
  "Ammortamento 2024",
  "Valore al 31.12.2024",
  "Ammortamento 2025",
  "Valore al 31.12.2025",
  "Ammortamento 2026",
  "Valore al 31.12.2026",
  "Ammortamento 2027",
  "Valore al 31.12.2027",
  "Ammortamento 2028",
  "Valore al 31.12.2028",
];

/** Builds a row from column letters: `row({ A: "01.01.2024", E: 100 })`. */
export function row(cells: Partial<Record<string, CellInput>>): CellInput[] {
  return COLUMNS.map((c) => cells[c] ?? null);
}

export const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/** What the fixture sums to, so tests assert against constants rather than re-deriving them. */
export const FIXTURE = {
  /** Σ "Valore al 31.12.2025" over the imported rows, in cents. */
  closing2025Cents: 185_113,
  importedAssets: 19,
  multiUnitRow: 6,
  multiUnitPriceCents: 294_635,
  users: [
    { id: "u-ada", name: "Ada Synthétic" },
    { id: "u-twin-1", name: "Twin Name" },
    { id: "u-twin-2", name: "twin  NAME" },
  ],
} as const;

export function fixtureRows(): FixtureRows {
  const rows: FixtureRows = new Map();
  rows.set(1, HEADER_LABELS.slice());
  // r2: 2022 purchase, text date, matched assignee, last CHF 1 written off in 2025 (blank J, spec O4)
  rows.set(2, row({ A: "15.03.2022", B: "Synthetic MacBook Pro 14 A", C: "SYN-A", D: "Ada Synthetic", E: 1500, F: 400, G: 399, H: 1, I: 1 }));
  // r3: 2023 purchase, typed date, assignee that matches nobody
  rows.set(3, row({ A: utc("2023-06-01"), B: "Synthetic iPhone B", C: "SYN-B", D: "Nobody Known", E: 900, F: 600.33, G: 299.67, H: 300.66, I: 299.66, J: 1 }));
  // r4: 2024 purchase, no assignee, a formula cell
  rows.set(4, row({ A: "04.01.2024", B: "Synthetic Dell XPS C", C: "SYN-C", E: 1200, G: 399.67, H: 800.33, I: 399.67, J: { formula: "H4-I4", result: 400.66 }, K: 399.66, L: 1 }));
  // r5: 2026 order not yet received
  rows.set(5, row({ A: utc("2026-02-10"), B: "Synthetic Monitor ordered", C: "Ordinato - In attesa di ricezione", D: "Ada Synthetic", E: 500, K: 166.33, L: 333.67, M: 166.33, N: 167.34, O: 166.34, P: 1 }));
  // r6: 13 units in one row (residual CHF 13.00 at the end of the schedule)
  rows.set(6, row({ A: "20.05.2024", B: "Synthetic monitors 13 pieces", E: 2946.35, G: 981.78, H: 1964.57, I: 981.78, J: 982.79, K: 969.79, L: 13 }));
  // r7: spec O5 - a value at 31.12.2023 and nothing after
  rows.set(7, row({ A: "18.09.2023", B: "Synthetic orphan", E: 400, F: 250 }));
  // r8: 2025 purchase whose cells do not foot by one cent; assignee text matching two users
  rows.set(8, row({ A: utc("2025-02-03"), B: "Synthetic iPad D", C: "SYN-D", D: "Twin Name", E: 700, I: 233.33, J: 466.68, K: 232.84, L: 233.84, M: 232.84, N: 1 }));
  // r9: 2022 purchase that is ceded in 2026
  rows.set(9, row({ A: "02.02.2022", B: "Synthetic Laptop E ceded", C: "SYN-CEDE", E: 1000, F: 300, G: 299, H: 1, I: 1 }));
  // r10: a column total (sum of "Ammortamento 2025")
  rows.set(10, row({ I: 1916.44 }));
  // r12/r13: cessions (r13 matches no purchase - spec O5)
  rows.set(12, row({ A: utc("2026-03-15"), B: "Synthetic Person, cessione Laptop E", C: "SYN-CEDE", E: 1 }));
  rows.set(13, row({ A: utc("2026-04-01"), B: "Other Person, cessione Phone", C: "SYN-NOMATCH", E: 1 }));
  // r15/r16: the year-end block
  rows.set(15, row({ A: "Valore hardware a bilancio al 31.12.2025", E: 99_999.99 }));
  rows.set(16, row({ A: "Acquisti hardware nel 2026", E: 777 }));
  return rows;
}

/** The fixture as plain sheet rows, without going through a file. */
export function toSheetRows(rows: FixtureRows): SheetRow[] {
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, cells]) => {
      const out: Record<string, unknown> = {};
      cells.forEach((v, i) => {
        if (v === null) return;
        out[COLUMNS[i]!] = typeof v === "object" && !(v instanceof Date) ? v.result : v;
      });
      return { row: n, cells: out };
    });
}

export async function writeWorkbook(path: string, rows: FixtureRows): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("export_part_.csv");
  for (const [n, cells] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    const r = ws.getRow(n);
    cells.forEach((v, i) => {
      if (v === null) return;
      r.getCell(i + 1).value = v as ExcelJS.CellValue;
    });
    r.commit();
  }
  await wb.xlsx.writeFile(path);
}
