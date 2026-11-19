/**
 * The register baseline helper (T64, specs/20261119-accounting; 20261118 AC-4.11; plan SO-14, R19).
 *
 * Pure and database-free. EVERY fixture here is synthetic: invented initials, invented names and `example.invalid` addresses. No real
 * employee and no line of the real register appears in this file, and the tests assert that nothing but initials and numbers is
 * printed.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveBaseline,
  formatBaseline,
  parseCsvRows,
  RegisterError,
  shapeOf,
  yearOfDate,
} from "./receipt-baseline-from-register";

const SCRIPT = join(import.meta.dir, "receipt-baseline-from-register.ts");
const tmp = mkdtempSync(join(tmpdir(), "receipt-baseline-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const lines = (...rows: string[]) => rows.join("\n");
const maxima = (csv: string) => Object.fromEntries(deriveBaseline(csv).maxima.map((m) => [m.initials, m.lastSeq]));

describe("maximum per initials", () => {
  it("takes the highest sequence of each of two employees, numerically (99 < 100) and whatever the row order", () => {
    const csv = lines(
      "receiptNumber,expenseDate,employee,email",
      "AB26/001,2026-01-05,Testa Uno,uno@example.invalid",
      "CD26/010,2026-01-06,Testa Due,due@example.invalid",
      "AB26/100,2026-02-01,Testa Uno,uno@example.invalid",
      "AB26/099,2026-01-20,Testa Uno,uno@example.invalid",
      "CD26/009,2026-01-07,Testa Due,due@example.invalid",
    );
    expect(maxima(csv)).toEqual({ AB: 100, CD: 10 });
    expect(deriveBaseline(csv).maxima.map((m) => m.initials)).toEqual(["AB", "CD"]);
  });

  it("a header-only register has no maximum and is not an error", () => {
    const result = deriveBaseline("receiptNumber,expenseDate\n");
    expect(result.maxima).toEqual([]);
    expect(formatBaseline(result)).toContain("(none)");
  });

  it("matches header names without case, drops a BOM and reads semicolon or tab delimiters, quotes and CRLF", () => {
    expect(maxima('﻿ReceiptNumber;ExpenseDate;Note\r\n"AB26/004";"2026-03-01";"a; b"\r\n')).toEqual({ AB: 4 });
    expect(maxima("receiptNumber\texpenseDate\nAB26/007\t2026-03-01\n")).toEqual({ AB: 7 });
    expect(maxima('x,receiptNumber\n"a ""quoted"" note\nover two lines",CD26/012\n')).toEqual({ CD: 12 });
  });

  it("counts a lower-case or space-padded number and a padded sequence as the same canonical number", () => {
    const result = deriveBaseline(lines("receiptNumber", " ab26/5 ", "AB26/005", "AB26/00006"));
    expect(result.maxima).toEqual([{ initials: "AB", lastSeq: 6 }]);
    expect(result.duplicates).toEqual([{ number: "AB26/005", count: 2 }]);
  });

  it("ignores rows without a number and says so", () => {
    const result = deriveBaseline(lines("receiptNumber,expenseDate", "AB26/003,2026-01-01", ",2026-01-02", "", ",,"));
    expect(result.withoutNumber).toBe(2);
    expect(result.numbered).toBe(1);
    expect(result.malformed).toEqual([]);
  });
});

describe("duplicates", () => {
  it("lists FR26/002 twice as a duplicate and the maximum stays 2 (harmless)", () => {
    const csv = lines("receiptNumber", "FR26/001", "FR26/002", "FR26/002");
    const result = deriveBaseline(csv);
    expect(result.duplicates).toEqual([{ number: "FR26/002", count: 2 }]);
    expect(maxima(csv)).toEqual({ FR: 2 });
    expect(formatBaseline(result)).toContain("FR26/002  x2");
  });

  it("reports no duplicate for distinct numbers or the same sequence of different initials", () => {
    expect(deriveBaseline(lines("receiptNumber", "AB26/001", "CD26/001")).duplicates).toEqual([]);
  });
});

describe("wrong-year numbers", () => {
  it("counts a 25 number whose expense date is in 2026, and lists it", () => {
    const csv = lines("receiptNumber,expenseDate", "GH26/003,2026-02-10", "GH25/014,2026-03-02");
    const result = deriveBaseline(csv);
    expect(maxima(csv)).toEqual({ GH: 14 });
    expect(result.wrongYear).toEqual([
      { number: "GH25/014", expenseYear: 2026, counted: true, reason: "expense date in 2026" },
    ]);
    expect(formatBaseline(result)).toContain("GH25/014  COUNTED  (expense date in 2026: 2026)");
  });

  it("counts a wrong-year number when the export has no date column, and lists it", () => {
    const csv = lines("receiptNumber", "GH26/003", "GH25/014");
    const result = deriveBaseline(csv);
    expect(result.hasDateColumn).toBe(false);
    expect(maxima(csv)).toEqual({ GH: 14 });
    expect(result.wrongYear).toEqual([{ number: "GH25/014", expenseYear: null, counted: true, reason: "no date column" }]);
    expect(formatBaseline(result)).toContain("no expenseDate column");
  });

  it("does not count a wrong-year number dated outside 2026 (listed, with the reason)", () => {
    const csv = lines("receiptNumber,expenseDate", "GH26/003,2026-02-10", "GH25/014,14.11.2025");
    const result = deriveBaseline(csv);
    expect(maxima(csv)).toEqual({ GH: 3 });
    expect(result.wrongYear[0]).toMatchObject({ number: "GH25/014", counted: false, reason: "expense date outside 2026", expenseYear: 2025 });
    expect(formatBaseline(result)).toContain("GH25/014  not counted");
  });

  it("counts a wrong-year number whose date cell is empty or unreadable (a gap is harmless, a repeat is not)", () => {
    const csv = lines("receiptNumber,expenseDate", "GH25/020,", "IJ27/008,sometime in march");
    const result = deriveBaseline(csv);
    expect(maxima(csv)).toEqual({ GH: 20, IJ: 8 });
    expect(result.wrongYear.map((w) => [w.number, w.counted, w.reason])).toEqual([
      ["GH25/020", true, "expense date missing or unreadable"],
      ["IJ27/008", true, "expense date missing or unreadable"],
    ]);
  });

  it("lists a wrong-year number once even when it repeats, and counts it if any occurrence counts", () => {
    const csv = lines("receiptNumber,expenseDate", "GH25/014,2025-12-01", "GH25/014,2026-01-09");
    const result = deriveBaseline(csv);
    expect(result.wrongYear).toHaveLength(1);
    expect(result.wrongYear[0]!.counted).toBe(true);
    expect(result.duplicates).toEqual([{ number: "GH25/014", count: 2 }]);
  });

  it("reads Swiss and slash dates and ignores a time", () => {
    expect(yearOfDate("2026-03-14T10:00:00Z")).toBe(2026);
    expect(yearOfDate("14.03.2026")).toBe(2026);
    expect(yearOfDate("1/3/2026 09:30")).toBe(2026);
    expect(yearOfDate("14.03.26")).toBeNull();
    expect(yearOfDate("")).toBeNull();
  });
});

describe("malformed numbers", () => {
  const csv = lines(
    "receiptNumber,expenseDate,employee,email",
    "AB26/002,2026-01-01,Testa Uno,uno@example.invalid",
    "AB26-003,2026-01-02,Testa Uno,uno@example.invalid",
    "Testa Uno uno@example.invalid,2026-01-03,Testa Uno,uno@example.invalid",
    "AB26/000,2026-01-04,Testa Uno,uno@example.invalid",
    "AB26/100000,2026-01-05,Testa Uno,uno@example.invalid",
    "A26/004,2026-01-06,Testa Uno,uno@example.invalid",
  );

  it("lists them by data row, does not count them, and keeps the maximum from the valid ones", () => {
    const result = deriveBaseline(csv);
    expect(result.malformed.map((m) => m.row)).toEqual([2, 3, 4, 5, 6]);
    expect(maxima(csv)).toEqual({ AB: 2 });
  });

  it("prints only the shape of a malformed cell, never its text (it may be a name or an email)", () => {
    const text = formatBaseline(deriveBaseline(csv));
    expect(text).toContain("data row 2  AA99-999");
    expect(text).toContain("data row 3  AAAAA AAA AAA?AAAAAAA.AA…");
    expect(text).not.toMatch(/Testa|uno@|example\.invalid|AB26-003/);
    expect(shapeOf("x@y.z")).toBe("A?A.A");
  });
});

describe("what the report may contain", () => {
  it("holds initials and numbers only: no name, no email, no other column", () => {
    const csv = lines(
      "receiptNumber,expenseDate,employee,email,amount",
      "AB26/001,2026-01-05,Testa Uno,uno@example.invalid,12.50",
      "AB26/001,2026-01-06,Testa Uno,uno@example.invalid,13.50",
      "AB25/009,2026-01-07,Testa Uno,uno@example.invalid,14.50",
      "bogus entry,2026-01-08,Testa Due,due@example.invalid,15.50",
    );
    const text = formatBaseline(deriveBaseline(csv));
    expect(text).not.toMatch(/Testa|Uno|Due|example|@|12\.50|13\.50|bogus/i);
    expect(text).toContain("AB  9");
  });
});

describe("refused input", () => {
  it("refuses an empty file, a missing receiptNumber column and an unbalanced quote, without quoting a cell", () => {
    expect(() => deriveBaseline("")).toThrow(RegisterError);
    expect(() => deriveBaseline("number,date\nAB26/001,2026-01-01")).toThrow("no receiptNumber column");
    expect(() => parseCsvRows('receiptNumber\n"AB26/001')).toThrow("quoted field");
  });
});

describe("as the operator runs it (child process, no database, no environment)", () => {
  const run = (...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, "run", SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() };
  };

  it("prints the report on stdout and exits 0", () => {
    const file = join(tmp, "register.csv");
    writeFileSync(
      file,
      lines(
        "receiptNumber,expenseDate,employee,email",
        "AB26/001,2026-01-05,Testa Uno,uno@example.invalid",
        "CD26/010,2026-01-06,Testa Due,due@example.invalid",
        "CD26/010,2026-01-07,Testa Due,due@example.invalid",
        "CD25/011,2026-01-08,Testa Due,due@example.invalid",
        "not a number,2026-01-09,Testa Due,due@example.invalid",
      ),
    );
    const { code, out, err } = run("--register", file);
    expect(code).toBe(0);
    expect(out).toContain("AB  1");
    expect(out).toContain("CD  11");
    expect(out).toContain("CD26/010  x2");
    expect(out).toContain("CD25/011  COUNTED");
    expect(out).toContain("data row 5  AAA A AAAAAA");
    expect(out + err).not.toMatch(/Testa|@|example\.invalid|not a number/);
  });

  it("exits 1 with a message on stderr and nothing on stdout for a usage or file failure", () => {
    for (const args of [[], ["--register"], ["--register", join(tmp, "missing.csv")], ["--register", join(tmp, "x.csv"), "--show-emails"]]) {
      const { code, out, err } = run(...args);
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toContain("receipt-baseline:from-register failed");
    }
  });

  it("exits 1 for a register without the receiptNumber column and names no cell", () => {
    const file = join(tmp, "nocolumn.csv");
    writeFileSync(file, "employee,email\nTesta Uno,uno@example.invalid\n");
    const { code, out, err } = run("--register", file);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("no receiptNumber column");
    expect(err).not.toMatch(/Testa|@/);
  });
});
