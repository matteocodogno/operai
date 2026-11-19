/**
 * Unit tests of the pure accounting CSV (T17, specs/20261118-refund-accounting-
 * export; AC-6.2, AC-6.3, AC-6.4, AC-6.8, AC-6.12, ADR 20261118-the-accounting-
 * export-is-generated-on-request-...).
 *
 * The golden file `fixtures/accounting-export.golden.csv` was written by hand
 * from the figures of `fixtures/accounting-export.input.json` (not by the code
 * under test) and is compared BYTE FOR BYTE: BOM, CRLF, `;`, `.`, quoting, the
 * formula guard and the order. A dialect change (plan D3, spec open question 3)
 * is therefore one deliberate diff of that file plus a `FORMAT_VERSION` bump.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chfCents, vatCents } from "./amounts";
import vectors from "./amounts-vectors.json";
import {
  buildAccountingCsv,
  compareCodePoints,
  formatBasisPoints,
  formatCents,
  formatRateMicros,
  guardFormula,
  quoteField,
  type AccountingExportLine,
} from "./export";
import { COLUMNS, CONTENT_TYPE, exportFilename, FORMAT_VERSION } from "./exportFormat";

const FIXTURES = join(import.meta.dir, "fixtures");
const golden = new Uint8Array(readFileSync(join(FIXTURES, "accounting-export.golden.csv")));
const input = JSON.parse(readFileSync(join(FIXTURES, "accounting-export.input.json"), "utf8")) as {
  lines: AccountingExportLine[];
};

const BASE: AccountingExportLine = {
  lineId: "line-1",
  ownerUserId: "u-1",
  ownerName: "Matteo Codogno",
  ownerEmail: "matteo.codogno@welld.ch",
  receiptNumber: "MC26/001",
  receiptYear: 2026,
  receiptSeq: 1,
  date: "2026-03-02",
  type: "office_material",
  motivo: "Cancelleria",
  km: null,
  currency: "CHF",
  approvedCents: 2080,
  rateMicros: null,
  accountNumber: "6101",
  accountName: "Spese materiale ufficio",
  vatCode: "IMP81",
  vatRateBasisPoints: 810,
  batchId: "batch-1",
};
const line = (patch: Partial<AccountingExportLine> = {}): AccountingExportLine => ({ ...BASE, ...patch });

/** A minimal RFC 4180 reader for `;`-separated text (BOM and trailing CRLF handled), independent of the code under test. */
function parseCsv(text: string): string[][] {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ";") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && body[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const col = (key: (typeof COLUMNS)[number]["key"]): number => COLUMNS.findIndex((c) => c.key === key);
const cell = (row: string[], key: (typeof COLUMNS)[number]["key"]): string => row[col(key)]!;
const rowOf = (rows: string[][], receipt: string): string[] => {
  const found = rows.find((r) => r[col("receiptNumber")] === receipt);
  if (!found) throw new Error(`no row for ${receipt}`);
  return found;
};
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

describe("the golden file (AC-6.2)", () => {
  it("is byte-identical to the file written by hand: BOM, CRLF, ';', '.', quoting, guard and order", () => {
    const csv = buildAccountingCsv(input.lines);
    if (!bytesEqual(csv.bytes, golden)) {
      // Show the difference as text rather than as two arrays of numbers.
      expect(csv.text).toBe(new TextDecoder("utf-8", { ignoreBOM: true }).decode(golden));
    }
    expect(bytesEqual(csv.bytes, golden)).toBe(true);
    expect(csv.rowCount).toBe(input.lines.length);
  });

  it("starts with the UTF-8 byte-order mark and ends every record, the last one included, with CRLF", () => {
    expect([...golden.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect([...buildAccountingCsv(input.lines).bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buildAccountingCsv(input.lines).text;
    expect(text.endsWith("\r\n")).toBe(true);
    // Outside a quoted cell every line break is CRLF: scan with the quote state (a doubled quote toggles twice).
    let quoted = false;
    let bare = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') quoted = !quoted;
      else if (!quoted && text[i] === "\n" && text[i - 1] !== "\r") bare++;
      else if (!quoted && text[i] === "\r" && text[i + 1] !== "\n") bare++;
    }
    expect(bare).toBe(0);
  });

  it("has the 16 columns of AC-6.2 in order, with English headers", () => {
    const [header] = parseCsv(buildAccountingCsv(input.lines).text);
    expect(header).toEqual([
      "Employee",
      "Receipt number",
      "Expense date",
      "Expense type",
      "Reason",
      "Km",
      "Currency",
      "Approved total",
      "Exchange rate",
      "CHF amount",
      "Account number",
      "Account name",
      "VAT code",
      "VAT rate (%)",
      "VAT amount (CHF)",
      "Batch",
    ]);
    for (const row of parseCsv(buildAccountingCsv(input.lines).text)) expect(row).toHaveLength(16);
  });

  it("sorts the golden lines: employee by code point, then receipt year and sequence", () => {
    const rows = parseCsv(buildAccountingCsv(input.lines).text).slice(1);
    expect(rows.map((r) => r[col("receiptNumber")])).toEqual([
      "AR26/001",
      "AR26/002",
      "MC26/001",
      "MC26/002",
      "MC26/003",
      "MC26/004",
      "MC26/005",
      "MC27/001",
      "BV26/001",
    ]);
  });
});

describe("the figures named by the spec (AC-6.3, AC-6.4, AC-6.12)", () => {
  const rows = parseCsv(buildAccountingCsv(input.lines).text);

  it("AC-6.3: 10.40 EUR dated 2026-03-02 at 0.9246 is 9.62 CHF", () => {
    const row = rowOf(rows, "MC26/001");
    expect(cell(row, "expenseDate")).toBe("2026-03-02");
    expect(cell(row, "currency")).toBe("EUR");
    expect([cell(row, "approvedTotal"), cell(row, "exchangeRate"), cell(row, "chfAmount")]).toEqual(["10.40", "0.9246", "9.62"]);
    // And in the raw bytes, as the plan writes it.
    expect(buildAccountingCsv(input.lines).text).toContain(";EUR;10.40;0.9246;9.62;");
  });

  it("AC-6.4: 20.80 CHF at 8.1 % carries a VAT of 1.56", () => {
    const row = rowOf(rows, "MC26/002");
    expect([cell(row, "approvedTotal"), cell(row, "exchangeRate"), cell(row, "chfAmount")]).toEqual(["20.80", "", "20.80"]);
    expect([cell(row, "vatRate"), cell(row, "vatAmount")]).toEqual(["8.10", "1.56"]);
    expect(buildAccountingCsv(input.lines).text).toContain(";IMP81;8.10;1.56;");
  });

  it("AC-6.12: a line approved at 0 is present, with 0.00 CHF and 0.00 VAT", () => {
    const row = rowOf(rows, "MC26/003");
    expect([cell(row, "approvedTotal"), cell(row, "chfAmount"), cell(row, "vatAmount")]).toEqual(["0.00", "0.00", "0.00"]);
  });

  it("the VAT is taken from the rounded CHF amount (ADR decision 2), as on the screen", () => {
    // 1004 EUR cents at 0.1 is 100.4 -> 100 CHF cents; the VAT of 100 at 8.1 % is 7, of the unrounded 100.4 it would be 8.
    const parsed = parseCsv(buildAccountingCsv([line({ currency: "EUR", approvedCents: 1004, rateMicros: 100_000 })]).text)[1]!;
    expect([cell(parsed, "chfAmount"), cell(parsed, "vatAmount")]).toEqual(["1.00", "0.07"]);
  });
});

describe("the amounts agree with the golden vectors of amounts.ts (screen and file cannot disagree)", () => {
  for (const v of vectors.chf) {
    if (v.expectedCents === null) continue;
    it(`CHF column: ${v.description}`, () => {
      const parsed = parseCsv(
        buildAccountingCsv([line({ currency: v.currency, approvedCents: v.amountCents, rateMicros: v.rateMicros, vatRateBasisPoints: 0 })]).text,
      )[1]!;
      expect(cell(parsed, "chfAmount")).toBe(formatCents(v.expectedCents));
      expect(chfCents(v.amountCents, v.currency, v.rateMicros)).toBe(v.expectedCents);
    });
  }
  for (const v of vectors.vat) {
    if (v.expectedCents === null || v.chfCents === null || v.rateBasisPoints === null) continue;
    it(`VAT column: ${v.description}`, () => {
      const parsed = parseCsv(buildAccountingCsv([line({ approvedCents: v.chfCents, vatRateBasisPoints: v.rateBasisPoints })]).text)[1]!;
      expect(cell(parsed, "vatAmount")).toBe(formatCents(v.expectedCents));
      expect(vatCents(v.chfCents, v.rateBasisPoints)).toBe(v.expectedCents);
    });
  }
});

describe("determinism (AC-6.8)", () => {
  it("the same lines in any input order give the same bytes", () => {
    const expected = buildAccountingCsv(input.lines).bytes;
    const reversed = [...input.lines].reverse();
    expect(bytesEqual(buildAccountingCsv(reversed).bytes, expected)).toBe(true);
    // A few fixed-seed shuffles (a small LCG keeps the test itself deterministic).
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let round = 0; round < 25; round++) {
      const shuffled = [...input.lines];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = next() % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(bytesEqual(buildAccountingCsv(shuffled).bytes, expected)).toBe(true);
    }
  });

  it("two builds of the same input are identical, and the input is not mutated or reordered", () => {
    const copy = structuredClone(input.lines);
    const a = buildAccountingCsv(input.lines);
    const b = buildAccountingCsv(input.lines);
    expect(bytesEqual(a.bytes, b.bytes)).toBe(true);
    expect(input.lines).toEqual(copy);
  });

  it("orders by employee in code point order, not by UTF-16 code unit and not by locale", () => {
    // U+FF5E (BMP) is before U+1F600 (astral) by code point; by UTF-16 unit the astral char (D83D...) sorts first.
    expect(compareCodePoints("～", "\u{1F600}")).toBeLessThan(0);
    expect("～" < "\u{1F600}").toBe(false);
    // Uppercase before lowercase (a locale collation would interleave them).
    expect(compareCodePoints("Zoe", "anna")).toBeLessThan(0);
    expect(compareCodePoints("a", "ab")).toBeLessThan(0);
    expect(compareCodePoints("ab", "a")).toBeGreaterThan(0);
    expect(compareCodePoints("same", "same")).toBe(0);

    const rows = parseCsv(
      buildAccountingCsv([
        line({ lineId: "a", ownerUserId: "u-a", ownerName: "\u{1F600} emoji", receiptNumber: "E26/001" }),
        line({ lineId: "b", ownerUserId: "u-b", ownerName: "～ tilde", receiptNumber: "T26/001" }),
        line({ lineId: "c", ownerUserId: "u-c", ownerName: "anna", receiptNumber: "AA26/001" }),
        line({ lineId: "d", ownerUserId: "u-d", ownerName: "Zoe", receiptNumber: "ZZ26/001" }),
      ]).text,
    ).slice(1);
    expect(rows.map((r) => cell(r, "receiptNumber"))).toEqual(["ZZ26/001", "AA26/001", "T26/001", "E26/001"]);
  });

  it("breaks a tie on the employee by ownerUserId, then year, then sequence, then line id", () => {
    const rows = parseCsv(
      buildAccountingCsv([
        line({ lineId: "z", ownerUserId: "u-2", receiptYear: 2026, receiptSeq: 1, receiptNumber: "MC26/001#u2" }),
        line({ lineId: "y", ownerUserId: "u-1", receiptYear: 2027, receiptSeq: 1, receiptNumber: "MC27/001" }),
        line({ lineId: "x", ownerUserId: "u-1", receiptYear: 2026, receiptSeq: 10, receiptNumber: "MC26/010" }),
        line({ lineId: "w", ownerUserId: "u-1", receiptYear: 2026, receiptSeq: 9, receiptNumber: "MC26/009" }),
        line({ lineId: "v", ownerUserId: "u-1", receiptYear: 2026, receiptSeq: 9, receiptNumber: "MC26/009-b" }),
      ]).text,
    ).slice(1);
    // 9 before 10 as numbers (not as strings); the same (year, seq) falls back to the line id.
    expect(rows.map((r) => cell(r, "receiptNumber"))).toEqual(["MC26/009-b", "MC26/009", "MC26/010", "MC27/001", "MC26/001#u2"]);
  });
});

describe("text cells: the formula guard and RFC 4180 quoting (ADR decision 6)", () => {
  it("a motivo with ';', '\"', a newline and a leading '=' is guarded, then quoted, and reads back as data", () => {
    const motivo = '=HYPERLINK("http://x";"y")\nsecond line';
    const { text } = buildAccountingCsv([line({ motivo })]);
    const raw = text.split("\r\n")[1]!;
    expect(raw).toContain(';"\'=HYPERLINK(""http://x"";""y"")\nsecond line";');
    const parsed = parseCsv(text);
    expect(parsed).toHaveLength(2);
    expect(cell(parsed[1]!, "reason")).toBe(`'${motivo}`);
    expect(parsed[1]).toHaveLength(16);
  });

  for (const [name, trigger] of [
    ["=", "="],
    ["+", "+"],
    ["-", "-"],
    ["@", "@"],
    ["TAB", "\t"],
    ["CR", "\r"],
  ] as const) {
    it(`a text cell that starts with ${name} is prefixed with an apostrophe in EVERY text column`, () => {
      const hostile = `${trigger}cmd|' /C calc'!A0`;
      const parsed = parseCsv(
        buildAccountingCsv([
          line({
            ownerName: hostile,
            receiptNumber: hostile,
            motivo: hostile,
            accountName: hostile,
            accountNumber: hostile,
            vatCode: hostile,
            batchId: hostile,
          }),
        ]).text,
      )[1]!;
      for (const key of ["employee", "receiptNumber", "reason", "accountName", "accountNumber", "vatCode", "batch"] as const) {
        expect(cell(parsed, key)).toBe(`'${hostile}`);
      }
      // The expense type is a label and the currency a code; neither is free text, and neither starts with a trigger.
      expect(cell(parsed, "expenseType")).toBe("Office material");
    });
  }

  it("guards the employee cell when it falls back to the email, and the type label when a type is unknown", () => {
    const parsed = parseCsv(buildAccountingCsv([line({ ownerName: null, ownerEmail: "+evil@welld.ch", type: "=new_type" })]).text)[1]!;
    expect(cell(parsed, "employee")).toBe("'+evil@welld.ch");
    expect(cell(parsed, "expenseType")).toBe("'=new_type");
  });

  it("does not touch a text cell that merely contains a trigger inside, and never guards the number columns", () => {
    expect(guardFormula("a=b")).toBe("a=b");
    expect(guardFormula("Spese 5-9")).toBe("Spese 5-9");
    expect(guardFormula("")).toBe("");
    const parsed = parseCsv(buildAccountingCsv([line({ currency: "EUR", approvedCents: 1040, rateMicros: 924_600, km: null })]).text)[1]!;
    for (const key of ["km", "approvedTotal", "exchangeRate", "chfAmount", "vatRate", "vatAmount"] as const) {
      expect(cell(parsed, key).startsWith("'")).toBe(false);
    }
  });

  it("quotes a cell with the separator, a quote, CR or LF, or a leading or trailing space, and only those", () => {
    expect(quoteField("plain")).toBe("plain");
    expect(quoteField("a,b")).toBe("a,b");
    expect(quoteField("a;b")).toBe('"a;b"');
    expect(quoteField('say "hi"')).toBe('"say ""hi"""');
    expect(quoteField("a\nb")).toBe('"a\nb"');
    expect(quoteField("a\rb")).toBe('"a\rb"');
    expect(quoteField(" lead")).toBe('" lead"');
    expect(quoteField("trail ")).toBe('"trail "');
    expect(quoteField("inner space")).toBe("inner space");
  });

  it("round-trips awkward text (quotes, separators, CRLF, accents, emoji) through a reader", () => {
    const motivo = 'a;"b"\r\nc,d é ü \u{1F600} ';
    const parsed = parseCsv(buildAccountingCsv([line({ motivo })]).text);
    expect(parsed).toHaveLength(2);
    expect(cell(parsed[1]!, "reason")).toBe(motivo);
  });
});

describe("the cells", () => {
  it("falls back to the email when the account has no name, or a blank one", () => {
    expect(cell(parseCsv(buildAccountingCsv([line({ ownerName: null })]).text)[1]!, "employee")).toBe("matteo.codogno@welld.ch");
    expect(cell(parseCsv(buildAccountingCsv([line({ ownerName: "   " })]).text)[1]!, "employee")).toBe("matteo.codogno@welld.ch");
  });

  it("shows the document label of the expense type, never the enum", () => {
    expect(cell(parseCsv(buildAccountingCsv([line({ type: "travel_train" })]).text)[1]!, "expenseType")).toBe("Travel — train");
  });

  it("km is filled only for a travel_km line", () => {
    const kmLine = parseCsv(buildAccountingCsv([line({ type: "travel_km", km: 120 })]).text)[1]!;
    expect(cell(kmLine, "km")).toBe("120");
    // A stale km on another type, and a travel_km line with none, are both empty.
    expect(cell(parseCsv(buildAccountingCsv([line({ type: "postal", km: 120 })]).text)[1]!, "km")).toBe("");
    expect(cell(parseCsv(buildAccountingCsv([line({ type: "travel_km", km: null })]).text)[1]!, "km")).toBe("");
  });

  it("the exchange rate is empty for CHF, even when a rate is passed, and a plain decimal otherwise", () => {
    expect(cell(parseCsv(buildAccountingCsv([line({ rateMicros: 2_000_000 })]).text)[1]!, "exchangeRate")).toBe("");
    const chf = parseCsv(buildAccountingCsv([line({ rateMicros: 2_000_000 })]).text)[1]!;
    expect(cell(chf, "chfAmount")).toBe("20.80");
    expect(cell(parseCsv(buildAccountingCsv([line({ currency: "EUR", rateMicros: 924_600 })]).text)[1]!, "exchangeRate")).toBe("0.9246");
  });

  it("formats numbers with a dot, two decimals and no thousands separator", () => {
    expect(formatCents(0)).toBe("0.00");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(962)).toBe("9.62");
    expect(formatCents(1040)).toBe("10.40");
    expect(formatCents(123_456_789)).toBe("1234567.89");
    expect(formatBasisPoints(810)).toBe("8.10");
    expect(formatBasisPoints(770)).toBe("7.70");
    expect(formatBasisPoints(5)).toBe("0.05");
    expect(formatBasisPoints(0)).toBe("0.00");
    expect(formatBasisPoints(10_000)).toBe("100.00");
  });

  it("formats a rate with up to six decimals, trailing zeros trimmed to at least four", () => {
    expect(formatRateMicros(924_600)).toBe("0.9246");
    expect(formatRateMicros(1_063_500)).toBe("1.0635");
    expect(formatRateMicros(1_000_000)).toBe("1.0000");
    expect(formatRateMicros(924_610)).toBe("0.92461");
    expect(formatRateMicros(924_601)).toBe("0.924601");
    expect(formatRateMicros(12_340_000)).toBe("12.3400");
  });

  it("refuses a negative, fractional or unsafe number instead of printing it", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => formatCents(bad)).toThrow(RangeError);
      expect(() => formatRateMicros(bad)).toThrow(RangeError);
      expect(() => formatBasisPoints(bad)).toThrow(RangeError);
    }
  });
});

describe("what the builder refuses (the caller blocks these first, so a partial file cannot exist)", () => {
  it("a foreign-currency line with no rate", () => {
    expect(() => buildAccountingCsv([line({ currency: "EUR", rateMicros: null })])).toThrow(RangeError);
  });
  it("a negative approved amount", () => {
    expect(() => buildAccountingCsv([line({ approvedCents: -1 })])).toThrow(RangeError);
  });
  it("a date that is not YYYY-MM-DD", () => {
    expect(() => buildAccountingCsv([line({ date: "02.03.2026" })])).toThrow(RangeError);
  });
  it("a VAT rate above 100 %", () => {
    expect(() => buildAccountingCsv([line({ vatRateBasisPoints: 10_001 })])).toThrow(RangeError);
  });
});

describe("an empty batch (AC-6.7)", () => {
  it("is the header row only, with the BOM and CRLF", () => {
    const csv = buildAccountingCsv([]);
    expect(csv.rowCount).toBe(0);
    expect(csv.text).toBe(`﻿${COLUMNS.map((c) => c.header).join(";")}\r\n`);
    expect(csv.bytes.length).toBe(3 + new TextEncoder().encode(csv.text.slice(1)).length);
  });
});

describe("the dialect module", () => {
  it("states its version, media type and filename", () => {
    expect(FORMAT_VERSION).toBe(1);
    expect(CONTENT_TYPE).toBe("text/csv; charset=utf-8");
    expect(exportFilename(new Date("2026-07-19T23:30:00.000Z"), "batch-1")).toBe("refund-accounting-2026-07-19-batch-1.csv");
  });

  it("keeps a hostile batch id out of the filename", () => {
    expect(exportFilename(new Date("2026-07-19T00:00:00.000Z"), 'a"b/../c\r\nd')).toBe("refund-accounting-2026-07-19-a_b____c__d.csv");
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
      vatCodeIsDefault: true,
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
    expect(result.lines.map((l) => [l.rateMicros, l.accountNumber, l.vatCode, l.vatRateBasisPoints])).toEqual([
      [null, "6101", "IMP81", 810],
      [924_600, "6101", "IMP81", 810],
    ]);
    // An answer for the same pair is never looked at when the line holds its own copy.
    const other = evaluateExport(sourceOf(copiedEur(924_600)), answers(true, inEffect("EUR", "2026-03", 930_000, true)));
    expect(other.lines[0]!.rateMicros).toBe(924_600);
    expect(other.summary.fetchAttempted).toBe(true);
  });

  it("a stored half is bookable whatever it is called now; a missing half is missing, with no default to fill it", () => {
    const result = evaluateExport(sourceOf(sourceRow({ accountNumber: null, accountName: null }), sourceRow({ vatCodeCopy: null, vatRateBasisPoints: null })), { kind: "none" });
    expect(result.summary.exportable).toBe(false);
    expect(result.summary.blockers.unclassifiedLines.map((l) => l.missing)).toEqual([["account"], ["vatCode"]]);
    expect(result.lines).toEqual([]);
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
