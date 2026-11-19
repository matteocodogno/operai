/**
 * The limits of the catalog as vectors (T8, specs/20261119-accounting, AC-1.2, plan D31): the same numbers and reason
 * words accounting-ui's `src/lib/limits.ts` mirrors. Pure, no database.
 */

import { describe, expect, it } from "bun:test";
import { checkLedgerName, checkLedgerNumber, checkText, describeRefusal, LIMITS } from "./limits";

describe("LIMITS", () => {
  it("pins the numbers accounting-ui mirrors", () => {
    expect(LIMITS).toEqual({ ledgerNumberMax: 20, ledgerNameMax: 120 });
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

describe("describeRefusal", () => {
  it("names the field and what is wrong, and nothing else", () => {
    expect(describeRefusal({ field: "number", reason: "empty" })).toBe("number is required");
    expect(describeRefusal({ field: "name", reason: "too_long" })).toBe("name is too long");
    expect(describeRefusal({ field: "number", reason: "format" })).toBe("number has an invalid format");
    expect(describeRefusal({ field: "ratePercent", reason: "range" })).toBe("ratePercent is outside the allowed range");
  });
});
