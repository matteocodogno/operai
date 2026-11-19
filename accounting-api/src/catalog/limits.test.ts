/**
 * The limits of the catalog as vectors (T8, specs/20261119-accounting, AC-1.2, plan D31): the same numbers and reason
 * words accounting-ui's `src/lib/limits.ts` mirrors. Pure, no database.
 */

import { describe, expect, it } from "bun:test";
import {
  checkLedgerName,
  checkLedgerNumber,
  checkText,
  checkVatCode,
  checkVatLabel,
  checkVatRatePercent,
  describeRefusal,
  LIMITS,
  upperCaseCode,
} from "./limits";

describe("LIMITS", () => {
  it("pins the numbers accounting-ui mirrors", () => {
    expect(LIMITS).toEqual({ ledgerNumberMax: 20, ledgerNameMax: 120, vatCodeMax: 16, vatLabelMax: 80, vatRateMaxPercent: 100 });
  });
});

describe("checkLedgerNumber (AC-1.2)", () => {
  it("accepts digits separated by single dots, and returns the trimmed value", () => {
    for (const ok of ["5905", "2620.1", "1.2.3", "0", "007", "1".repeat(20), "1.".repeat(9) + "1"]) {
      expect(checkLedgerNumber(ok)).toEqual({ ok: true, value: ok });
    }
    expect(checkLedgerNumber(" 5905 ")).toEqual({ ok: true, value: "5905" });
    expect(checkLedgerNumber("\t5905\n")).toEqual({ ok: true, value: "5905" });
  });

  it("refuses empty, blank, missing and null as `empty`", () => {
    for (const bad of ["", "  ", "\t\n", undefined, null]) expect(checkLedgerNumber(bad)).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses everything else that is not digits and single dots as `format`, before it looks at the length", () => {
    for (const bad of ["5905.", ".5", "59..05", "59a", "59 05", "-5", "+5", "5,5", "１２３", "1e3", "5905.1.", "a".repeat(40)]) {
      expect(checkLedgerNumber(bad)).toEqual({ ok: false, reason: "format" });
    }
    for (const notAString of [5905, true, ["5905"], { number: "5905" }]) {
      expect(checkLedgerNumber(notAString)).toEqual({ ok: false, reason: "format" });
    }
  });

  it("refuses a well-formed number over 20 characters as `too_long`", () => {
    expect(checkLedgerNumber("1".repeat(21))).toEqual({ ok: false, reason: "too_long" });
    expect(checkLedgerNumber("1.".repeat(11))).toEqual({ ok: false, reason: "format" }); // trailing dot
    expect(checkLedgerNumber("1.".repeat(10) + "1")).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("checkLedgerName and checkText (AC-1.2)", () => {
  it("accepts 1 to 120 characters and returns the trimmed value", () => {
    expect(checkLedgerName("x")).toEqual({ ok: true, value: "x" });
    expect(checkLedgerName("n".repeat(120))).toEqual({ ok: true, value: "n".repeat(120) });
    expect(checkLedgerName("  Spese  ")).toEqual({ ok: true, value: "Spese" });
    expect(checkLedgerName("più 日本")).toEqual({ ok: true, value: "più 日本" });
  });

  it("counts the length after trimming", () => {
    expect(checkLedgerName(` ${"n".repeat(120)} `)).toEqual({ ok: true, value: "n".repeat(120) });
    expect(checkLedgerName("n".repeat(121))).toEqual({ ok: false, reason: "too_long" });
  });

  it("refuses blank as `empty`, a non-string as `format`, and a control character as `format`", () => {
    for (const bad of ["", "   ", undefined, null]) expect(checkLedgerName(bad)).toEqual({ ok: false, reason: "empty" });
    expect(checkLedgerName(7)).toEqual({ ok: false, reason: "format" });
    for (const bad of ["a\u0000b", "a\tb", "a\nb", "a\u007fb"]) expect(checkLedgerName(bad)).toEqual({ ok: false, reason: "format" });
  });

  it("checkText takes the maximum as a parameter", () => {
    expect(checkText("abcd", 3)).toEqual({ ok: false, reason: "too_long" });
    expect(checkText("abc", 3)).toEqual({ ok: true, value: "abc" });
  });
});

describe("checkVatCode (AC-1.5)", () => {
  it("converts lower case to capital letters and trims", () => {
    expect(checkVatCode("imp81")).toEqual({ ok: true, value: "IMP81" });
    expect(checkVatCode("  Imp-81_x ")).toEqual({ ok: true, value: "IMP-81_X" });
    expect(checkVatCode("A".repeat(16))).toEqual({ ok: true, value: "A".repeat(16) });
    expect(checkVatCode("0")).toEqual({ ok: true, value: "0" });
  });

  it("refuses blank as `empty`, other characters as `format` and 17 characters as `too_long`", () => {
    for (const bad of ["", "  ", undefined, null]) expect(checkVatCode(bad)).toEqual({ ok: false, reason: "empty" });
    for (const bad of ["IMP 81", "IMP.81", "ü", "IMP81!", "a/b", 81, ["IMP"]]) {
      expect(checkVatCode(bad)).toEqual({ ok: false, reason: "format" });
    }
    expect(checkVatCode("A".repeat(17))).toEqual({ ok: false, reason: "too_long" });
    expect(checkVatCode("a".repeat(17))).toEqual({ ok: false, reason: "too_long" });
  });

  it("converts a to z only: ß and ſ do not turn into letters of the alphabet", () => {
    expect(upperCaseCode("abcxyz")).toBe("ABCXYZ");
    expect(upperCaseCode("ß")).toBe("ß");
    expect(checkVatCode("ß")).toEqual({ ok: false, reason: "format" });
    expect(checkVatCode("ſ")).toEqual({ ok: false, reason: "format" });
    expect(checkVatCode("ı")).toEqual({ ok: false, reason: "format" });
  });
});

describe("checkVatLabel (AC-1.5)", () => {
  it("accepts 1 to 80 characters and refuses 0 and 81", () => {
    expect(checkVatLabel("IVA 8.1%")).toEqual({ ok: true, value: "IVA 8.1%" });
    expect(checkVatLabel("l".repeat(80))).toEqual({ ok: true, value: "l".repeat(80) });
    expect(checkVatLabel("l".repeat(81))).toEqual({ ok: false, reason: "too_long" });
    expect(checkVatLabel("  ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("checkVatRatePercent (AC-1.5)", () => {
  it("accepts 0 to 100 with at most two decimals, and returns the string as typed after trimming", () => {
    for (const ok of ["0", "8", "8.1", "8.10", "7.70", "0.07", "100", "100.0", "100.00", "000", "99.99"]) {
      expect(checkVatRatePercent(ok)).toEqual({ ok: true, value: ok });
    }
    expect(checkVatRatePercent(" 8.1 ")).toEqual({ ok: true, value: "8.1" });
  });

  it("refuses what is not a plain decimal as `format`, and a well-formed value above 100 as `range`", () => {
    for (const bad of ["-1", "8.123", "abc", "1e2", ".5", "8.", "8,1", "1000", "+8", "8 .1", 8.1, ["8"]]) {
      expect(checkVatRatePercent(bad)).toEqual({ ok: false, reason: "format" });
    }
    for (const bad of ["100.01", "101", "999", "100.5"]) expect(checkVatRatePercent(bad)).toEqual({ ok: false, reason: "range" });
    for (const bad of ["", "  ", undefined, null]) expect(checkVatRatePercent(bad)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("describeRefusal", () => {
  it("names the field and what is wrong, and nothing else", () => {
    expect(describeRefusal({ field: "number", reason: "empty" })).toBe("number is required");
    expect(describeRefusal({ field: "name", reason: "too_long" })).toBe("name is too long");
    expect(describeRefusal({ field: "number", reason: "format" })).toBe("number has an invalid format");
    expect(describeRefusal({ field: "ratePercent", reason: "range" })).toBe("ratePercent is outside the allowed range");
  });
});
