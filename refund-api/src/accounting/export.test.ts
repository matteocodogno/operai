/**
 * Unit tests of the pure accounting workbook (T62, specs/20261119-accounting; 20261118: AC-6.1, AC-6.2, AC-6.3, AC-6.7, AC-6.8,
 * AC-6.12 to AC-6.17, SO-6 to SO-11; ADR 20261118-the-accounting-export-is-generated-on-request-...).
 *
 * `fixtures/accounting-export.golden.xlsx` is compared BYTE FOR BYTE. Its expected CELLS are listed, by hand, in
 * `fixtures/accounting-export.golden.cells.json` (readable in review; the serials were computed with Python's `datetime`, not by
 * the code under test), and the file is read back with `test-support/xlsxReader.ts`, which shares no code with the writer. A
 * dialect change (the Description pattern, a style, the order) is one deliberate diff of both fixtures plus a `FORMAT_VERSION` bump.
 * The data is synthetic: no real person, no real amount.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cellValues, readWorkbook, readZip, type ReadWorkbook } from "../test-support/xlsxReader";
import { chfCents } from "./amounts";
import vectors from "./amounts-vectors.json";
import { buildAccountingFile, compareExportLines, employeeCell, type AccountingExportLine } from "./export";
import { formatCents, HEADERS } from "./exportFormat";

const FIXTURES = join(import.meta.dir, "fixtures");
const golden = new Uint8Array(readFileSync(join(FIXTURES, "accounting-export.golden.xlsx")));
const goldenCells = JSON.parse(readFileSync(join(FIXTURES, "accounting-export.golden.cells.json"), "utf8")) as {
  sheetName: string;
  header: string[];
  dateFormat: string;
  rows: { date: string; cells: (string | { n: string } | null)[] }[];
};
const input = JSON.parse(readFileSync(join(FIXTURES, "accounting-export.input.json"), "utf8")) as { lines: AccountingExportLine[] };

const BASE: AccountingExportLine = {
  lineId: "line-1",
  ownerUserId: "u-1",
  ownerName: "Matteo Codogno",
  ownerEmail: "matteo.codogno@welld.ch",
  receiptNumber: "MC26/001",
  receiptYear: 2026,
  receiptSeq: 1,
  date: "2026-03-02",
  motivo: "Cancelleria",
  currency: "CHF",
  approvedCents: 2080,
  rateMicros: null,
  accountNumber: "6101",
};
const line = (patch: Partial<AccountingExportLine> = {}): AccountingExportLine => ({ ...BASE, ...patch });

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const read = (lines: readonly AccountingExportLine[]): ReadWorkbook => readWorkbook(buildAccountingFile(lines).bytes);
/** The data rows (header excluded) as the cells.json lists them. */
const dataRows = (book: ReadWorkbook) => book.rows.slice(1).map(cellValues);
const descriptions = (lines: readonly AccountingExportLine[]): string[] => dataRows(read(lines)).map((row) => row[1] as string);

describe("the golden workbook (AC-6.2)", () => {
  it("is byte-identical to the file kept in the repository", () => {
    const file = buildAccountingFile(input.lines);
    expect(file.rowCount).toBe(input.lines.length);
    expect(file.bytes.length).toBe(golden.length);
    expect(bytesEqual(file.bytes, golden)).toBe(true);
  });

  it("lists exactly the cells of golden.cells.json, in order (the golden file and the builder both)", () => {
    for (const bytes of [golden, buildAccountingFile(input.lines).bytes]) {
      const book = readWorkbook(bytes);
      expect(book.sheetNames).toEqual([goldenCells.sheetName]);
      expect(cellValues(book.rows[0]!)).toEqual(goldenCells.header);
      expect(dataRows(book)).toEqual(goldenCells.rows.map((r) => r.cells));
      expect(book.dimension).toBe(`A1:H${goldenCells.rows.length + 1}`);
    }
  });

  it("is a ZIP of STORED entries dated 1980-01-01 in a fixed order, with no docProps (no author, no timestamp)", () => {
    const entries = readZip(golden);
    expect(entries.map((e) => e.name)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/styles.xml",
      "xl/sharedStrings.xml",
    ]);
    for (const entry of entries) expect([entry.method, entry.dosTime, entry.dosDate, entry.flags]).toEqual([0, 0, 0x21, 0x800]);
    expect(entries.some((e) => e.name.startsWith("docProps"))).toBe(false);
    // Nothing in any part names a person, a program or a moment.
    for (const text of Object.values(readWorkbook(golden).parts)) {
      expect(text).not.toMatch(/creator|lastModifiedBy|dcterms|<Application|Microsoft|20\d\d-\d\d-\d\dT/i);
    }
  });

  it("has the shape of the accountant's template: sheet `Sheet 1`, the 8 headers, a real date, numbers, text, two empty columns", () => {
    const book = readWorkbook(golden);
    expect(book.sheetNames).toEqual(["Sheet 1"]);
    expect(cellValues(book.rows[0]!)).toEqual([...HEADERS]);
    expect([...HEADERS]).toEqual(["Date", "Description", "Debit", "Credit", "Amount", "Currency", "Tax", "Note"]);
    for (const row of book.rows.slice(1)) {
      expect(row).toHaveLength(8);
      const [date, description, debit, credit, amount, currency, tax, note] = row;
      expect(date!.type).toBe("number");
      expect(date!.style.formatCode).toBe("yyyy\\-mm\\-dd;@"); // shown as yyyy-mm-dd
      expect(description!.type).toBe("string");
      expect(description!.style.numFmtId).toBe(49);
      expect(["number", "string"]).toContain(debit!.type); // number for a plain account, text for 2620.10
      expect([credit!.type, credit!.style.numFmtId]).toEqual(["number", 0]);
      expect([amount!.type, amount!.style.formatCode]).toEqual(["number", "0.00"]);
      expect([currency!.type, currency!.style.numFmtId]).toEqual(["string", 49]);
      expect([tax!.type, note!.type]).toEqual(["empty", "empty"]);
    }
  });

  it("every text cell's style carries quotePrefix, a number's and a date's never does (AC-6.15)", () => {
    for (const row of readWorkbook(golden).rows) {
      for (const cell of row) {
        if (cell.type === "string") expect(cell.style.quotePrefix).toBe(true);
        if (cell.type === "number") expect(cell.style.quotePrefix).toBe(false);
      }
    }
  });

  it("no part holds a formula, an inline string or `<f` where cells and text live (AC-6.15)", () => {
    const parts = readWorkbook(golden).parts;
    for (const [name, text] of Object.entries(parts)) {
      expect(text).not.toMatch(/<f[\s>/]/);
      expect(text).not.toContain("inlineStr");
      if (/sheet1|sharedStrings/.test(name)) expect(text).not.toContain("<f");
    }
  });

  it("orders the golden lines by Date, the latest first, then employee, then receipt (AC-6.16)", () => {
    expect(dataRows(readWorkbook(golden)).map((row) => (row[1] as string).match(/\[([A-Z]{2}\d{2}\/\d{3})\]/)![1])).toEqual([
      "MC27/001",
      "BV26/001",
      "MC26/005",
      "MC26/004",
      "MC26/003",
      "AR26/003", // 2026-03-03: Anna Rossi's two lines, by receipt sequence ...
      "AR26/004",
      "MC26/002", // ... then Matteo Codogno
      "MC26/001",
      "AR26/002",
      "AR26/001",
    ]);
  });
});

describe("the figures named by the spec (AC-6.3, AC-6.12, AC-6.13, AC-6.17)", () => {
  const rows = dataRows(readWorkbook(golden));
  const byReceipt = (receipt: string) => rows.find((row) => (row[1] as string).includes(`[${receipt}]`))!;

  it("AC-6.3: 10.40 EUR dated 2026-03-02 at 0.9246 is an Amount of 9.62, in CHF, with the original in the Description", () => {
    expect(byReceipt("MC26/001")).toEqual([{ n: "46083" }, "Cancelleria [MC26/001] [EUR 10.40 = CHF 9.62] Matteo Codogno", { n: "6101" }, { n: "5832" }, { n: "9.62" }, "CHF", null, null]);
  });

  it("AC-6.12: a line approved at 0 is present, with an Amount of 0.00 (not 0, not empty)", () => {
    expect(byReceipt("MC26/003")![4]).toEqual({ n: "0.00" });
  });

  it("AC-6.13: a CHF line has no currency and no second amount; the email stands in for a missing name", () => {
    expect(byReceipt("AR26/001")![1]).toBe("Treno Lugano-Zurigo [AR26/001] Anna Rossi");
    expect(byReceipt("BV26/001")![1]).toBe("-Rimborso parcheggio [BV26/001] bruno.verdi@welld.ch");
    expect(descriptions([line({ ownerName: "" }), line({ ownerName: "   ", lineId: "b" })])).toEqual([
      "Cancelleria [MC26/001] matteo.codogno@welld.ch",
      "Cancelleria [MC26/001] matteo.codogno@welld.ch",
    ]);
    expect(employeeCell(line({ ownerName: null }))).toBe("matteo.codogno@welld.ch");
  });

  it("AC-6.2: Credit is 5832 and Currency is CHF on every row, including a foreign-currency line; Tax and Note are empty", () => {
    for (const row of rows) expect([row[3], row[5], row[6], row[7]]).toEqual([{ n: "5832" }, "CHF", null, null]);
    expect(dataRows(read([line({ currency: "USD", approvedCents: 5000, rateMicros: 780_800 })]))[0]!.slice(3)).toEqual([{ n: "5832" }, { n: "39.04" }, "CHF", null, null]);
  });

  it("AC-6.17: 5905 and 2620.1 are numbers; 2620.10 and 1.2.3 are text, unchanged", () => {
    const debit = (accountNumber: string) => dataRows(read([line({ accountNumber })]))[0]![2];
    expect(debit("5905")).toEqual({ n: "5905" });
    expect(debit("2620.1")).toEqual({ n: "2620.1" });
    expect(debit("2620.10")).toBe("2620.10");
    expect(debit("1.2.3")).toBe("1.2.3");
    expect(debit("0123")).toBe("0123");
    // The text Debit is a shared string with the text style, so Accrio imports it as text.
    const cell = read([line({ accountNumber: "2620.10" })]).rows[1]![2]!;
    expect([cell.type, cell.style.numFmtId, cell.style.quotePrefix]).toEqual(["string", 49, true]);
    const number = read([line({ accountNumber: "2620.1" })]).rows[1]![2]!;
    expect([number.type, number.style.numFmtId]).toEqual(["number", 0]);
  });
});

describe("the Amount agrees with the golden vectors of amounts.ts (screen and file cannot disagree)", () => {
  for (const v of vectors.chf) {
    if (v.expectedCents === null) continue;
    it(`Amount: ${v.description}`, () => {
      const row = dataRows(read([line({ currency: v.currency, approvedCents: v.amountCents, rateMicros: v.rateMicros })]))[0]!;
      expect(row[4]).toEqual({ n: formatCents(v.expectedCents) });
      expect(chfCents(v.amountCents, v.currency, v.rateMicros)).toBe(v.expectedCents);
    });
  }
});

describe("determinism (AC-6.8)", () => {
  it("the same lines in any input order give the same bytes, and the same SHA-256", () => {
    const expected = buildAccountingFile(input.lines).bytes;
    expect(bytesEqual(buildAccountingFile([...input.lines].reverse()).bytes, expected)).toBe(true);
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let round = 0; round < 25; round++) {
      const shuffled = [...input.lines];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = next() % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const again = buildAccountingFile(shuffled).bytes;
      expect(bytesEqual(again, expected)).toBe(true);
      expect(sha256(again)).toBe(sha256(expected));
    }
  });

  it("two builds of the same input are identical, and the input is not mutated or reordered", () => {
    const copy = structuredClone(input.lines);
    const a = buildAccountingFile(input.lines);
    const b = buildAccountingFile(input.lines);
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
    expect(input.lines).toEqual(copy);
  });

  it("does not depend on the clock or on the time zone", () => {
    const original = process.env.TZ;
    try {
      const hashes = new Set<string>();
      for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        hashes.add(sha256(buildAccountingFile(input.lines).bytes));
      }
      expect(hashes.size).toBe(1);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("a change in any line changes the bytes (and so the logged hash)", () => {
    const base = sha256(buildAccountingFile(input.lines).bytes);
    const first = input.lines[0]!;
    const rest = input.lines.slice(1);
    const changed = [{ ...first, approvedCents: first.approvedCents + 1 }, ...rest];
    expect(sha256(buildAccountingFile(changed).bytes)).not.toBe(base);
    const reworded = [{ ...first, motivo: `${first.motivo}!` }, ...rest];
    expect(sha256(buildAccountingFile(reworded).bytes)).not.toBe(base);
  });
});

describe("the order of the rows (AC-6.16, SO-11)", () => {
  it("Date descending, then the employee in code point order (not UTF-16, not locale), ownerUserId, year, sequence, line id", () => {
    const lines = [
      line({ lineId: "a", ownerUserId: "u-a", ownerName: "\u{1F600} emoji", receiptNumber: "E26/001" }),
      line({ lineId: "b", ownerUserId: "u-b", ownerName: "～ tilde", receiptNumber: "T26/001" }),
      line({ lineId: "c", ownerUserId: "u-c", ownerName: "anna", receiptNumber: "AA26/001" }),
      line({ lineId: "d", ownerUserId: "u-d", ownerName: "Zoe", receiptNumber: "ZZ26/001" }),
      line({ lineId: "e", ownerUserId: "u-e", ownerName: "Zoe", receiptNumber: "NEW/001", date: "2026-03-03" }),
    ];
    // The latest date first; on the same date: uppercase before lowercase, the BMP character before the astral one.
    expect(descriptions(lines).map((d) => d.match(/\[(.*?)\]/)![1])).toEqual(["NEW/001", "ZZ26/001", "AA26/001", "T26/001", "E26/001"]);
  });

  it("breaks a tie on the employee by ownerUserId, then year, then sequence (9 before 10), then line id", () => {
    const lines = [
      line({ lineId: "z", ownerUserId: "u-2", receiptYear: 2026, receiptSeq: 1, receiptNumber: "MC26/001#u2" }),
      line({ lineId: "y", ownerUserId: "u-1", receiptYear: 2027, receiptSeq: 1, receiptNumber: "MC27/001" }),
      line({ lineId: "x", ownerUserId: "u-1", receiptYear: 2026, receiptSeq: 10, receiptNumber: "MC26/010" }),
      line({ lineId: "w", ownerUserId: "u-1", receiptYear: 2026, receiptSeq: 9, receiptNumber: "MC26/009" }),
      line({ lineId: "v", ownerUserId: "u-1", receiptYear: 2026, receiptSeq: 9, receiptNumber: "MC26/009-b" }),
    ];
    expect(descriptions(lines).map((d) => d.match(/\[(.*?)\]/)![1])).toEqual(["MC26/009-b", "MC26/009", "MC26/010", "MC27/001", "MC26/001#u2"]);
    expect([...lines].sort(compareExportLines).map((l) => l.lineId)).toEqual(["v", "w", "x", "y", "z"]);
  });

  it("the employee for the order is the one in the Description: the email when there is no name", () => {
    const lines = [
      line({ lineId: "n", ownerUserId: "u-1", ownerName: "Matteo Codogno", receiptNumber: "N26/001" }),
      line({ lineId: "m", ownerUserId: "u-2", ownerName: null, ownerEmail: "alpha@welld.ch", receiptNumber: "M26/001" }),
    ];
    // "Matteo Codogno" sorts before "alpha@welld.ch" (uppercase before lowercase).
    expect(descriptions(lines).map((d) => d.match(/\[(.*?)\]/)![1])).toEqual(["N26/001", "M26/001"]);
  });
});

describe("text from a person: exactly as written, in one cell, never a formula (AC-6.13, AC-6.15)", () => {
  const description = (patch: Partial<AccountingExportLine>) => dataRows(read([line(patch)]))[0]![1] as string;

  it("a reason or a name that starts with = + - or @ is in its cell as text, exactly as written, with no leading apostrophe", () => {
    for (const motivo of ["=SUM(A1)", "+41 79 000 00 00", "-Rimborso", "@SUM(1)", '=HYPERLINK("http://example.test")', "=1+1"]) {
      expect(description({ motivo })).toBe(`${motivo} [MC26/001] Matteo Codogno`);
    }
    expect(description({ ownerName: "=cmd|' /C calc'!A0" })).toBe("Cancelleria [MC26/001] =cmd|' /C calc'!A0");
    expect(description({ ownerName: null, ownerEmail: "-x@welld.ch" })).toBe("Cancelleria [MC26/001] -x@welld.ch");
    const cell = read([line({ motivo: "=SUM(A1)" })]).rows[1]![1]!;
    expect([cell.type, cell.style.numFmtId, cell.style.quotePrefix]).toEqual(["string", 49, true]);
  });

  it("markup characters and quotes are in the cell as typed, and the XML stays well formed", () => {
    const motivo = `a & b < c > d "e" 'f' </t></si>]]><f>1</f> &amp; &#60;`;
    expect(description({ motivo })).toBe(`${motivo} [MC26/001] Matteo Codogno`);
    const book = read([line({ motivo }), line({ lineId: "n", ownerName: `<b>"Anna" & 'co'</b>` })]); // parses strictly
    expect(book.rows).toHaveLength(3);
    expect(book.rows.every((row) => row.length === 8)).toBe(true);
  });

  it("a line break or any control character is one space: a Description is one line (AC-6.13)", () => {
    expect(description({ motivo: "uno\ndue\r\ntre\rquattro" })).toBe("uno due tre quattro [MC26/001] Matteo Codogno");
    expect(description({ motivo: "a\tb\u0000c\u001bd\u007fe\u0085f\u009fg h i" })).toBe("a b c d e f g h i [MC26/001] Matteo Codogno");
    expect(description({ ownerName: "Anna\nRossi" })).toBe("Cancelleria [MC26/001] Anna Rossi");
    expect(description({ motivo: "\n\n  a  \n  b  \n\n" })).toBe("a b [MC26/001] Matteo Codogno");
  });

  it("what XML 1.0 cannot carry becomes U+FFFD, and a valid astral character is kept", () => {
    expect(description({ motivo: "a\ud800b" })).toBe("a�b [MC26/001] Matteo Codogno");
    expect(description({ motivo: "a￾￿b" })).toBe("a��b [MC26/001] Matteo Codogno");
    expect(description({ motivo: "Caffè \u{1F600} 中文" })).toBe("Caffè \u{1F600} 中文 [MC26/001] Matteo Codogno");
  });

  it("a hostile text adds, merges or splits no row or column: 8 cells in each row, one row per line", () => {
    const hostile = ["=1\n=2", "a\nb\nc\nd", "\r\n\r\n", "<row r=\"99\"><c/></row>", "</c><c r=\"I2\"><v>1</v></c>", `"; DROP`, "x y"];
    const book = read(hostile.map((motivo, i) => line({ lineId: `l${i}`, ownerUserId: `u${i}`, motivo })));
    expect(book.rows).toHaveLength(hostile.length + 1);
    expect(book.rows.every((row) => row.length === 8)).toBe(true);
    expect(book.dimension).toBe(`A1:H${hostile.length + 1}`);
    for (const text of Object.values(book.parts)) expect(text).not.toMatch(/<f[\s>/]/);
  });

  it("a reason of 2000 characters is whole in its cell (the longest the API accepts)", () => {
    const motivo = "x".repeat(2000);
    expect(description({ motivo })).toBe(`${motivo} [MC26/001] Matteo Codogno`);
  });

  it("the Debit text cell is sanitised like any text and cannot carry markup either", () => {
    expect(dataRows(read([line({ accountNumber: "6101\n<x>" })]))[0]![2]).toBe("6101 <x>");
  });
});

describe("what the builder refuses (the caller blocks these first, so a partial file cannot exist)", () => {
  it("a foreign-currency line with no rate", () => {
    expect(() => buildAccountingFile([line({ currency: "EUR", rateMicros: null })])).toThrow(RangeError);
  });
  it("a negative, fractional or unsafe approved amount", () => {
    for (const approvedCents of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildAccountingFile([line({ approvedCents })])).toThrow(RangeError);
    }
  });
  it("a date that is not YYYY-MM-DD, or does not exist", () => {
    for (const date of ["02.03.2026", "2026-02-30", "2026-13-01", ""]) expect(() => buildAccountingFile([line({ date })])).toThrow(RangeError);
  });
  it("a negative receipt year or sequence", () => {
    expect(() => buildAccountingFile([line({ receiptYear: -1 })])).toThrow(RangeError);
    expect(() => buildAccountingFile([line({ receiptSeq: 1.5 })])).toThrow(RangeError);
  });
  it("a rate of 0 is not a rate", () => {
    expect(() => buildAccountingFile([line({ currency: "EUR", rateMicros: 0 })])).toThrow(RangeError);
  });
});

describe("an empty batch (AC-6.7)", () => {
  it("is the header row only, a valid workbook", () => {
    const file = buildAccountingFile([]);
    expect(file.rowCount).toBe(0);
    const book = readWorkbook(file.bytes);
    expect(book.sheetNames).toEqual(["Sheet 1"]);
    expect(book.rows).toHaveLength(1);
    expect(cellValues(book.rows[0]!)).toEqual([...HEADERS]);
    expect(book.dimension).toBe("A1:H1");
  });
});

// ─── The evaluation behind both routes (T21, specs/20261119-accounting) ───────────────────────────────────────────────
// Pure: `evaluateExport` and `pendingPairs` take what was read and decide; no database and no Accounting is touched here
// (the module imports the shared client object, which connects only when a query is made).

const { evaluateExport, pendingPairs } = await import("./export.repo");
type ExportSource = Parameters<typeof evaluateExport>[0];
type ExportRates = Parameters<typeof evaluateExport>[1];

let rowSeq = 0;
function sourceRow(patch: Record<string, unknown> = {}): ExportSource["rows"][number] {
  const n = ++rowSeq;
  return {
    requestId: `r-${n}`,
    ownerUserId: "u-1",
    ownerName: "Matteo Codogno",
    ownerEmail: "matteo.codogno@welld.ch",
    line: {
      id: `l-${n}`,
      date: new Date("2026-03-02T00:00:00.000Z"),
      type: "office_material",
      entity: "welld_ch",
      currency: "CHF",
      motivo: "Cancelleria",
      km: null,
      requestedAmountCents: 1040,
      approvedTotalCents: 1040,
      rejectionReason: null,
      receiptNumber: `MC26/${String(n).padStart(3, "0")}`,
      receiptYear: 2026,
      receiptSeq: n,
      createdAt: new Date("2026-03-05T10:00:00.000Z"),
      accountNumber: "6101",
      accountName: "Spese materiale ufficio",
      ledgerAccountIsDefault: true,
      vatCodeCopy: "IMP81",
      vatRateBasisPoints: 810,
      vatCodeIsDefault: false,
      fxRateMicros: null,
      fxRateMonth: null,
      ...patch,
    },
  } as unknown as ExportSource["rows"][number];
}
const sourceOf = (...rows: ExportSource["rows"][number][]): ExportSource => ({
  batch: { id: "b-1", status: "compiled", cutoff: new Date("2026-03-31T21:59:59.000Z") },
  rows,
  excludedLineCount: 0,
});
const pendingEur = (patch: Record<string, unknown> = {}) => sourceRow({ currency: "EUR", ...patch });
const copiedEur = (rate = 924_600) => sourceRow({ currency: "EUR", fxRateMicros: rate, fxRateMonth: new Date("2026-03-01T00:00:00.000Z") });
const inEffect = (currency: "EUR" | "USD" | "GBP", month: string, rateMicros: number, attempted = false) =>
  ({ currency, month, status: "in_effect", rateMicros, origin: "fetched", attempted }) as const;
const missing = (currency: "EUR" | "USD" | "GBP", month: string, reason: "not_published" | "fetch_failed" | "no_source", attempted = false) =>
  ({ currency, month, status: "missing", attempted, reason }) as const;
const answers = (attempted: boolean, ...list: ReturnType<typeof inEffect | typeof missing>[]): ExportRates => ({
  kind: "answers",
  byPair: new Map(list.map((a) => [`${a.currency}:${a.month}`, a])),
  attempted,
});

describe("evaluateExport: the rows come from the copies (AC-5.3, AC-5.4, AC-5.5)", () => {
  it("every line holds its copies: exportable with no rate to copy, and the file's rate is the copy, not an answer", () => {
    const result = evaluateExport(sourceOf(sourceRow(), copiedEur(924_600)), { kind: "none" });
    expect(result.summary).toMatchObject({ exportable: true, rowCount: 2, ratePendingLineCount: 0, fetchAttempted: false });
    expect(result.copies).toEqual([]);
    expect(result.lines.map((l) => [l.rateMicros, l.accountNumber])).toEqual([
      [null, "6101"],
      [924_600, "6101"],
    ]);
    // An answer for the same pair is never looked at when the line holds its own copy.
    const other = evaluateExport(sourceOf(copiedEur(924_600)), answers(true, inEffect("EUR", "2026-03", 930_000, true)));
    expect(other.lines[0]!.rateMicros).toBe(924_600);
    expect(other.summary.fetchAttempted).toBe(true);
  });

  it("a stored account is bookable whatever it is called now; a missing account blocks, with no default to fill it", () => {
    const result = evaluateExport(sourceOf(sourceRow({ accountNumber: null, accountName: null })), { kind: "none" });
    expect(result.summary.exportable).toBe(false);
    expect(result.summary.blockers.unclassifiedLines.map((l) => l.missing)).toEqual([["account"]]);
    expect(result.lines).toEqual([]);
  });

  it("(20261118 AC-3.11) a line with no VAT code is exported like any other: no blocker, and the file carries no VAT at all", () => {
    const result = evaluateExport(sourceOf(sourceRow({ vatCodeCopy: null, vatRateBasisPoints: null })), { kind: "none" });
    expect(result.summary).toMatchObject({ exportable: true, rowCount: 1 });
    expect(result.summary.blockers.unclassifiedLines).toEqual([]);
    expect(result.lines.map((l) => l.accountNumber)).toEqual(["6101"]);
    // The row is the same with or without a VAT code: the journal file has no VAT column (AC-6.2).
    const withVat = evaluateExport(sourceOf(sourceRow({ id: "same" })), { kind: "none" }).lines;
    const withoutVat = evaluateExport(sourceOf(sourceRow({ id: "same", vatCodeCopy: null, vatRateBasisPoints: null })), { kind: "none" }).lines;
    const cellsOf = (lines: typeof withVat) => cellValues(readWorkbook(buildAccountingFile(lines.map((l) => ({ ...l, receiptNumber: "X26/001" }))).bytes).rows[1]!);
    expect(cellsOf(withoutVat)).toEqual(cellsOf(withVat));
    expect(cellsOf(withoutVat)).toEqual([{ n: "46083" }, "Cancelleria [X26/001] Matteo Codogno", { n: "6101" }, { n: "5832" }, { n: "10.40" }, "CHF", null, null]);
  });

  it("a line with no receipt number is an unnumbered blocker", () => {
    const result = evaluateExport(sourceOf(sourceRow({ receiptNumber: null, receiptYear: null, receiptSeq: null })), { kind: "none" });
    expect(result.summary.blockers.unnumberedLines).toHaveLength(1);
    expect(result.summary.exportable).toBe(false);
  });
});

describe("evaluateExport: a pending rate (AC-5.6, AC-6.6, AC-6.7)", () => {
  it("is taken from the answer in effect and listed to be copied, once per line, with its month", () => {
    const a = pendingEur();
    const b = pendingEur({ date: new Date("2026-03-20T00:00:00.000Z") });
    const result = evaluateExport(sourceOf(a, b, copiedEur()), answers(false, inEffect("EUR", "2026-03", 930_000)));
    expect(result.summary).toMatchObject({ exportable: true, ratePendingLineCount: 2, fetchAttempted: false });
    expect(result.copies).toEqual([
      { lineId: a.line.id, requestId: a.requestId, currency: "EUR", month: "2026-03", rateMicros: 930_000 },
      { lineId: b.line.id, requestId: b.requestId, currency: "EUR", month: "2026-03", rateMicros: 930_000 },
    ]);
    expect(result.lines.map((l) => l.rateMicros)).toEqual([930_000, 930_000, 924_600]);
  });

  it("a pair with no rate in effect is a missing rate with Accounting's reason, listed once, in month then currency order", () => {
    const result = evaluateExport(
      sourceOf(pendingEur(), pendingEur(), sourceRow({ currency: "USD" }), sourceRow({ currency: "GBP", date: new Date("2026-02-10T00:00:00.000Z") })),
      answers(true, missing("EUR", "2026-03", "not_published"), missing("USD", "2026-03", "fetch_failed", true), missing("GBP", "2026-02", "no_source")),
    );
    expect(result.summary.exportable).toBe(false);
    expect(result.summary.fetchAttempted).toBe(true);
    expect(result.summary.blockers.missingRates).toEqual([
      { currency: "GBP", month: "2026-02", reason: "no_source" },
      { currency: "EUR", month: "2026-03", reason: "not_published" },
      { currency: "USD", month: "2026-03", reason: "fetch_failed" },
    ]);
    expect(result.summary.blockers.accountingUnavailable).toBe(false);
  });

  it("when anything blocks, nothing is to be copied and no line is offered: a refused export copies nothing", () => {
    const result = evaluateExport(
      sourceOf(pendingEur(), sourceRow({ currency: "USD" })),
      answers(false, inEffect("EUR", "2026-03", 924_600), missing("USD", "2026-03", "not_published")),
    );
    expect(result.copies).toEqual([]);
    expect(result.lines).toEqual([]);
  });

  it("Accounting unreadable is its own blocker, never a missing rate", () => {
    const result = evaluateExport(sourceOf(pendingEur(), sourceRow()), { kind: "unavailable" });
    expect(result.summary).toMatchObject({ exportable: false, ratePendingLineCount: 1, fetchAttempted: false });
    expect(result.summary.blockers).toMatchObject({ accountingUnavailable: true, missingRates: [] });
  });

  it("Accounting unreadable does not hide what Refund knows without it", () => {
    const result = evaluateExport(sourceOf(pendingEur(), sourceRow({ accountNumber: null, accountName: null })), { kind: "unavailable" });
    expect(result.summary.blockers.accountingUnavailable).toBe(true);
    expect(result.summary.blockers.unclassifiedLines).toHaveLength(1);
  });

  it("inside the export transaction (copies only) a line still waiting for its rate is an error, never a rate taken from an answer", () => {
    expect(() => evaluateExport(sourceOf(pendingEur()), answers(false, inEffect("EUR", "2026-03", 924_600)), { copiesOnly: true })).toThrow();
    expect(evaluateExport(sourceOf(copiedEur()), { kind: "none" }, { copiesOnly: true }).summary.exportable).toBe(true);
  });

  it("an answer that does not answer a pair is 'could not read', reported as a failed fetch and never as a rate", () => {
    const result = evaluateExport(sourceOf(pendingEur()), answers(false));
    expect(result.summary.blockers.missingRates).toEqual([{ currency: "EUR", month: "2026-03", reason: "fetch_failed" }]);
  });
});

describe("pendingPairs", () => {
  it("lists the distinct pairs of the lines that wait for a rate: not CHF, not copied; sorted by month then currency", () => {
    const source = sourceOf(
      sourceRow(),
      copiedEur(),
      pendingEur(),
      pendingEur({ date: new Date("2026-03-30T00:00:00.000Z") }),
      sourceRow({ currency: "USD" }),
      sourceRow({ currency: "GBP", date: new Date("2026-01-31T00:00:00.000Z") }),
    );
    expect(pendingPairs(source)).toEqual([
      { currency: "GBP", month: "2026-01" },
      { currency: "EUR", month: "2026-03" },
      { currency: "USD", month: "2026-03" },
    ]);
  });
});
