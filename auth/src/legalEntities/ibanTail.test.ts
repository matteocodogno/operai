/**
 * T54 of specs/20261117-legal-entities: the one rule for how much of an IBAN is shown (AC-9.11, AC-9.12; F5 item 3).
 * Pure: no database.
 */

import { describe, expect, test } from "bun:test";
import { IBAN_TAIL_PATTERN, ibanTail } from "./ibanTail";

describe("ibanTail", () => {
  test('"" is none', () => {
    expect(ibanTail("")).toEqual({ state: "none" });
  });

  test("blanks only is none (the registry's normalisation removes them)", () => {
    expect(ibanTail("  \u0085 ")).toEqual({ state: "none" });
  });

  test("1 to 8 characters is set, with no character shown", () => {
    for (const n of [1, 4, 5, 7, 8]) {
      expect(ibanTail("A1B2C3D4E5".slice(0, n))).toEqual({ state: "set" });
    }
  });

  test("9 characters shows the last 4", () => {
    expect(ibanTail("AB1234567")).toEqual({ state: "tail", last4: "4567" });
  });

  test("a 34-character IBAN shows the last 4", () => {
    const iban = "GB82WEST12345698765432" + "ABCDEFGHIJKL";
    expect(iban).toHaveLength(34);
    expect(ibanTail(iban)).toEqual({ state: "tail", last4: "IJKL" });
  });

  test("the printed IBAN of the fixtures", () => {
    expect(ibanTail("CH9300762011623852957")).toEqual({ state: "tail", last4: "2957" });
    expect(ibanTail("IT60X0542811101000000123456")).toEqual({ state: "tail", last4: "3456" });
  });

  test("spaces and case do not change the answer (typed form = stored form)", () => {
    expect(ibanTail("it60 x054 2811 1010 0000 0123 456")).toEqual({ state: "tail", last4: "3456" });
    // 8 characters once the spaces are gone
    expect(ibanTail("AB12 CD34")).toEqual({ state: "set" });
    // 9 characters once the spaces are gone
    expect(ibanTail("AB12 CD34 5")).toEqual({ state: "tail", last4: "D345" });
  });

  test("a tail that is not four of A-Z / 0-9 is never shown: it is set", () => {
    for (const bad of [
      "CH9300762011623852‮95", // bidi override inside the tail
      "CH93007620116238529éè", // non-ASCII letters
      "CH930076201162385295-7", // punctuation
      "CH9300762011623852\u001b[1m", // escape sequence
      "CH9300762011623852\ud83d", // a lone surrogate
      "CH9300762011623852\u{1F600}\u{1F600}", // astral characters (two code points)
    ]) {
      expect(ibanTail(bad)).toEqual({ state: "set" });
    }
  });

  test("counts characters, not UTF-16 units, for the 8-character limit", () => {
    // 4 astral code points = 8 UTF-16 units but 4 characters: set (not a tail either way)
    expect(ibanTail("\u{1F600}".repeat(4))).toEqual({ state: "set" });
  });

  test("whatever is shown matches the notice's pattern, over a range of inputs", () => {
    for (let n = 0; n <= 40; n++) {
      const value = "Z9".repeat(20).slice(0, n);
      const result = ibanTail(value);
      if (result.state === "tail") expect(result.last4).toMatch(IBAN_TAIL_PATTERN);
      expect(result.state).toBe(n === 0 ? "none" : n <= 8 ? "set" : "tail");
    }
  });
});
