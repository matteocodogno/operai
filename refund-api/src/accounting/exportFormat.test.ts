/**
 * Unit tests of the export's dialect module (T62, specs/20261119-accounting; SO-8, SO-9, SO-10, SO-11; AC-6.2, AC-6.13, AC-6.15,
 * AC-6.16, AC-6.17 of 20261118). The expected serials were computed with Python's `datetime` (days since 1899-12-30), not by
 * the code under test.
 */

import { describe, expect, it } from "bun:test";
import {
  COLUMN_WIDTHS,
  CONTENT_TYPE,
  CREDIT_ACCOUNT,
  CURRENCY,
  compareCodePoints,
  compareRows,
  dateSerial,
  describeLine,
  exportFilename,
  FORMAT_VERSION,
  formatCents,
  HEADERS,
  isCanonicalAccountNumber,
  NUM_FMTS,
  sanitizeText,
  SHEET_NAME,
  STYLE,
  STYLES,
  type RowOrderKey,
} from "./exportFormat";

describe("the constants (AC-6.2)", () => {
  it("states its version, media type, sheet, header, credit account and currency", () => {
    expect(FORMAT_VERSION).toBe(2);
    expect(CONTENT_TYPE).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(SHEET_NAME).toBe("Sheet 1");
    expect([...HEADERS]).toEqual(["Date", "Description", "Debit", "Credit", "Amount", "Currency", "Tax", "Note"]);
    expect(COLUMN_WIDTHS).toHaveLength(HEADERS.length);
    expect(CREDIT_ACCOUNT).toBe("5832");
    expect(CURRENCY).toBe("CHF");
  });

  it("styles: the template's formats, and every text style carries quotePrefix (AC-6.15)", () => {
    expect(NUM_FMTS).toEqual({ 164: "yyyy\\-mm\\-dd;@" });
    expect(STYLES[STYLE.default]).toEqual({ numFmtId: 0 });
    expect(STYLES[STYLE.date]!.numFmtId).toBe(164);
    expect(STYLES[STYLE.amount]!.numFmtId).toBe(2);
    expect(STYLES[STYLE.number]!.numFmtId).toBe(0);
    for (const index of [STYLE.header, STYLE.text]) {
      expect(STYLES[index]!.numFmtId).toBe(49);
      expect(STYLES[index]!.quotePrefix).toBe(true);
    }
    // A number or a date never says quotePrefix: it would turn it into text.
    for (const index of [STYLE.date, STYLE.number, STYLE.amount]) expect(STYLES[index]!.quotePrefix).toBeUndefined();
  });

  it("builds the filename from the cutoff and the batch id, with no personal data and a hostile id made safe", () => {
    expect(exportFilename(new Date("2026-07-19T23:30:00.000Z"), "batch-1")).toBe("refund-accounting-2026-07-19-batch-1.xlsx");
    expect(exportFilename(new Date("2026-07-19T00:00:00.000Z"), 'a"b/../c\r\nd')).toBe("refund-accounting-2026-07-19-a_b____c__d.xlsx");
  });
});

describe("Amount: exact from cents (AC-6.3, AC-6.12)", () => {
  it("two decimals, a dot, no thousands separator, never a float", () => {
    expect(formatCents(0)).toBe("0.00");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(962)).toBe("9.62");
    expect(formatCents(1040)).toBe("10.40");
    expect(formatCents(123_456_789)).toBe("1234567.89");
    expect(formatCents(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
  });

  it("refuses a negative, fractional, non-finite or unsafe number instead of printing it", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => formatCents(bad)).toThrow(RangeError);
    }
  });
});

describe("Date: a serial of the 1900 date system, by integer arithmetic (SO-8)", () => {
  it("matches the days since 1899-12-30 for known dates, leap days and century years included", () => {
    const vectors: [string, string][] = [
      ["1900-03-01", "61"],
      ["1999-12-31", "36525"],
      ["2000-01-01", "36526"],
      ["2000-02-29", "36585"],
      ["2024-02-29", "45351"],
      ["2026-01-01", "46023"],
      ["2026-03-02", "46083"],
      ["2026-12-31", "46387"],
      ["2027-01-01", "46388"],
      ["2100-03-01", "73110"],
      ["9999-12-31", "2958465"],
    ];
    for (const [date, serial] of vectors) expect(dateSerial(date)).toBe(serial);
  });

  it("consecutive days are consecutive serials across every month end of a leap and a common year", () => {
    let previous: number | undefined;
    for (const year of [2024, 2026]) {
      for (let month = 1; month <= 12; month++) {
        const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
        for (let day = 1; day <= days; day++) {
          const serial = Number(dateSerial(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`));
          if (year === 2024 || previous !== undefined) {
            if (previous !== undefined && !(year === 2026 && month === 1 && day === 1)) expect(serial).toBe(previous + 1);
          }
          previous = serial;
        }
      }
    }
  });

  it("does not depend on the process time zone", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        expect(dateSerial("2026-03-02")).toBe("46083");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("refuses what is not a date, a date that does not exist, and one the system cannot hold", () => {
    for (const bad of ["", "02.03.2026", "2026-3-2", "2026-03-02T00:00:00Z", "2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2100-02-29", "1900-02-28", "1899-12-31", "0000-01-01", " 2026-03-02"]) {
      expect(() => dateSerial(bad)).toThrow(RangeError);
    }
    expect(dateSerial("2000-02-29")).toBe("36585");
  });
});

describe("Debit: a number when a number holds it exactly, else text, unchanged (AC-6.17)", () => {
  it("is a number for a plain account number", () => {
    for (const ok of ["5905", "2620.1", "6101", "1", "9", "123456789012345", "1234567890.12345", "10", "100", "2620.25"]) {
      expect(isCanonicalAccountNumber(ok)).toBe(true);
    }
  });

  it("is text for anything a number would change", () => {
    for (const bad of [
      "2620.10", // trailing zero: a number says 2620.1
      "1.2.3",
      "0123", // leading zero
      "0",
      "0.5",
      "5905 ", // space
      " 5905",
      "",
      "-5905",
      "+5905",
      "5905.",
      ".5",
      "1e3",
      "1,5",
      "6101-A",
      "1234567890123456", // 16 digits: a double no longer holds it
      "1234567890.123456",
      "1.0",
      "\u0663",
    ]) {
      expect(isCanonicalAccountNumber(bad)).toBe(false);
    }
  });
});

describe("the sanitiser (AC-6.13, AC-6.15, SO-9)", () => {
  it("turns each control character into a space, and collapses and trims", () => {
    expect(sanitizeText("a\nb")).toBe("a b");
    expect(sanitizeText("a\r\nb")).toBe("a b");
    expect(sanitizeText("a\tb\u0000c\u001fd\u007fe\u0085f\u009fg")).toBe("a b c d e f g");
    expect(sanitizeText("a\u2028b\u2029c")).toBe("a b c");
    expect(sanitizeText("  \n lead and trail \t ")).toBe("lead and trail");
    expect(sanitizeText("a    b")).toBe("a b");
    expect(sanitizeText("\n\n\n")).toBe("");
    expect(sanitizeText("")).toBe("");
  });

  it("turns what XML 1.0 cannot carry into U+FFFD, and keeps a valid pair", () => {
    expect(sanitizeText("a\ud800b")).toBe("a\ufffdb");
    expect(sanitizeText("a\udfffb")).toBe("a\ufffdb");
    expect(sanitizeText("\ufffe\uffff")).toBe("\ufffd\ufffd");
    expect(sanitizeText("x\ud83d")).toBe("x\ufffd");
    expect(sanitizeText("\u{1F600}")).toBe("\u{1F600}");
  });

  it("changes nothing else: a leading trigger, markup, quotes, accents, a non-breaking space are exactly as written", () => {
    for (const same of ["=SUM(A1)", "+1", "-2", "@x", "<b>&amp;</b>", `say "hi" 'x'`, "Caffè Zürich 中文", "a\u00a0b", "a;b,c", "'quoted"]) {
      expect(sanitizeText(same)).toBe(same);
    }
  });

  it("is idempotent, and its output is always one line the writer accepts", () => {
    const wild = "\u0000a\r\n\t b\ud800\u2028  c\u0085\u{1F600}\ufffe ";
    const once = sanitizeText(wild);
    expect(sanitizeText(once)).toBe(once);
    expect(once).toBe("a b\ufffd c \u{1F600}\ufffd");
    expect(once).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  });
});

describe("the Description (AC-6.13, SO-9)", () => {
  const base = { reason: "Cancelleria", receiptNumber: "MC26/001", currency: "CHF", approvedAmount: "10.40", chfAmount: "10.40", employee: "Matteo Codogno" };

  it("CHF: `<reason> [<receipt number>] <employee>`, with no currency and no second amount", () => {
    expect(describeLine(base)).toBe("Cancelleria [MC26/001] Matteo Codogno");
    expect(describeLine({ ...base, reason: "Treno Lugano-Zurigo", receiptNumber: "AR26/001", employee: "Anna Rossi" })).toBe("Treno Lugano-Zurigo [AR26/001] Anna Rossi");
  });

  it("another currency adds `[<CUR> <approved> = CHF <CHF>]` before the name: AC-6.3's line", () => {
    expect(describeLine({ ...base, currency: "EUR", chfAmount: "9.62" })).toBe("Cancelleria [MC26/001] [EUR 10.40 = CHF 9.62] Matteo Codogno");
    expect(describeLine({ ...base, currency: "USD", approvedAmount: "0.00", chfAmount: "0.00" })).toBe("Cancelleria [MC26/001] [USD 0.00 = CHF 0.00] Matteo Codogno");
  });

  it("the email stands in for a missing name as given, and a line break anywhere is one space (AC-6.13)", () => {
    expect(describeLine({ ...base, employee: "bruno.verdi@welld.ch" })).toBe("Cancelleria [MC26/001] bruno.verdi@welld.ch");
    expect(describeLine({ ...base, reason: "uno\r\ndue\ntre", employee: "Anna\nRossi" })).toBe("uno due tre [MC26/001] Anna Rossi");
  });

  it("a reason or name that starts with a trigger keeps it (no leading apostrophe: the cell's quotePrefix guards it)", () => {
    expect(describeLine({ ...base, reason: "=SUM(A1)" })).toBe("=SUM(A1) [MC26/001] Matteo Codogno");
    expect(describeLine({ ...base, reason: "-Rimborso" })).toBe("-Rimborso [MC26/001] Matteo Codogno");
    expect(describeLine({ ...base, reason: "@x", employee: "+41 Name" })).toBe("@x [MC26/001] +41 Name");
  });

  it("an empty or whitespace reason leaves a clean Description", () => {
    expect(describeLine({ ...base, reason: "" })).toBe("[MC26/001] Matteo Codogno");
    expect(describeLine({ ...base, reason: " \n " })).toBe("[MC26/001] Matteo Codogno");
  });

  it("a reason of the longest size stays whole: nothing is cut", () => {
    const reason = "x".repeat(2000);
    expect(describeLine({ ...base, reason })).toBe(`${reason} [MC26/001] Matteo Codogno`);
  });
});

describe("the order (AC-6.16, SO-11)", () => {
  const key = (patch: Partial<RowOrderKey> = {}): RowOrderKey => ({
    date: "2026-03-02",
    employee: "Matteo Codogno",
    ownerUserId: "u-1",
    receiptYear: 2026,
    receiptSeq: 1,
    lineId: "l-1",
    ...patch,
  });
  const sorted = (keys: RowOrderKey[]) => [...keys].sort(compareRows).map((k) => k.lineId);

  it("Date, the latest first", () => {
    expect(sorted([key({ lineId: "a", date: "2026-02-10" }), key({ lineId: "b", date: "2027-01-05" }), key({ lineId: "c", date: "2026-03-09" })])).toEqual(["b", "c", "a"]);
  });

  it("then the employee in code point order, ascending", () => {
    expect(sorted([key({ lineId: "m", employee: "Matteo" }), key({ lineId: "a", employee: "Anna" }), key({ lineId: "z", employee: "anna" })])).toEqual(["a", "m", "z"]);
  });

  it("is not UTF-16 code unit order and not locale order", () => {
    expect(compareCodePoints("～", "\u{1F600}")).toBeLessThan(0);
    expect("～" < "\u{1F600}").toBe(false);
    expect(compareCodePoints("Zoe", "anna")).toBeLessThan(0);
    expect(compareCodePoints("a", "ab")).toBeLessThan(0);
    expect(compareCodePoints("ab", "a")).toBeGreaterThan(0);
    expect(compareCodePoints("same", "same")).toBe(0);
    expect(sorted([key({ lineId: "emoji", employee: "\u{1F600}" }), key({ lineId: "tilde", employee: "～" }), key({ lineId: "z", employee: "Zoe" }), key({ lineId: "a", employee: "anna" })])).toEqual(["z", "a", "tilde", "emoji"]);
  });

  it("then ownerUserId, year, sequence (as numbers: 9 before 10) and line id, all ascending", () => {
    const keys = [
      key({ lineId: "e", ownerUserId: "u-2" }),
      key({ lineId: "d", receiptYear: 2027 }),
      key({ lineId: "c", receiptSeq: 10 }),
      key({ lineId: "b", receiptSeq: 9 }),
      key({ lineId: "a", receiptSeq: 9 }),
    ];
    expect(sorted(keys)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("Date outranks everything below it: a later date with a 'later' employee still comes first", () => {
    expect(sorted([key({ lineId: "old", date: "2026-01-01", employee: "A" }), key({ lineId: "new", date: "2026-01-02", employee: "Z" })])).toEqual(["new", "old"]);
  });

  it("the same keys in any input order give the same order", () => {
    const keys = [
      key({ lineId: "1", date: "2026-03-03", employee: "Anna Rossi", receiptSeq: 3 }),
      key({ lineId: "2", date: "2026-03-03", employee: "Anna Rossi", receiptSeq: 4 }),
      key({ lineId: "3", date: "2026-03-03", employee: "Matteo Codogno" }),
      key({ lineId: "4", date: "2026-03-04" }),
      key({ lineId: "5", date: "2026-03-02" }),
    ];
    const expected = ["4", "1", "2", "3", "5"];
    let seed = 99;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let round = 0; round < 30; round++) {
      const shuffled = [...keys];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = next() % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(sorted(shuffled)).toEqual(expected);
    }
  });
});
