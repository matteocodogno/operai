/**
 * Unit tests for the receipt-number rules (T3, specs/20261118-refund-accounting-export;
 * AC-4.2, AC-4.8; plan "Receipt number rules").
 */

import { describe, expect, it } from "bun:test";
import { formatReceiptNumber, initials } from "./receiptNumber";

describe("initials from the name (AC-4.2)", () => {
  it("Matteo Codogno -> MC", () => {
    expect(initials("Matteo Codogno", "someone@welld.ch")).toBe("MC");
  });

  it("takes the first word and the LAST word: Anna Maria Rossi -> AR", () => {
    expect(initials("Anna Maria Rossi", "x@welld.ch")).toBe("AR");
  });

  it("strips diacritics: Élise Würth -> EW", () => {
    expect(initials("Élise Würth", "x@welld.ch")).toBe("EW");
    expect(initials("Zoë Brontë", "x@welld.ch")).toBe("ZB");
  });

  it("works on a decomposed (NFD) name as well as a composed (NFC) one", () => {
    expect(initials("Élise Würth", "x@welld.ch")).toBe("EW");
    expect(initials("Élise Würth", "x@welld.ch")).toBe("EW");
  });

  it("is upper-case whatever the case of the name", () => {
    expect(initials("matteo codogno", "x@welld.ch")).toBe("MC");
    expect(initials("MATTEO CODOGNO", "x@welld.ch")).toBe("MC");
  });

  it("copes with extra whitespace, tabs and a hyphenated or dotted name", () => {
    expect(initials("  Matteo \t  Codogno  ", "x@welld.ch")).toBe("MC");
    expect(initials("Jean-Luc Picard", "x@welld.ch")).toBe("JP");
    expect(initials("J. R. R. Tolkien", "x@welld.ch")).toBe("JT");
  });

  it("a surname-first name gives the 'wrong' initials, accepted (R15): Codogno Matteo -> CM", () => {
    expect(initials("Codogno Matteo", "x@welld.ch")).toBe("CM");
  });
});

describe("initials: the email fallback (AC-4.8)", () => {
  it("a one-word name gives no initials, so the email is used: Cher -> email", () => {
    expect(initials("Cher", "matteo.codogno@welld.ch")).toBe("MC");
    expect(initials("Cher", "zz@welld.ch")).toBe("ZZ");
  });

  it("a null, empty or blank name uses the email", () => {
    expect(initials(null, "matteo.codogno@welld.ch")).toBe("MC");
    expect(initials(undefined, "matteo.codogno@welld.ch")).toBe("MC");
    expect(initials("", "matteo.codogno@welld.ch")).toBe("MC");
    expect(initials("   ", "matteo.codogno@welld.ch")).toBe("MC");
  });

  it("matteo.codogno@... -> MC (first letter of the first two dot-separated parts)", () => {
    expect(initials(null, "matteo.codogno@welld.ch")).toBe("MC");
  });

  it("mcodogno@... -> MC (the first two letters)", () => {
    expect(initials(null, "mcodogno@welld.ch")).toBe("MC");
  });

  it("m.c@... -> MC", () => {
    expect(initials(null, "m.c@welld.ch")).toBe("MC");
  });

  it("uses only the first two parts of a longer local part", () => {
    expect(initials(null, "anna.maria.rossi@welld.ch")).toBe("AM");
  });

  it("a part without a letter does not count as a part: 1.matteo.codogno -> MC", () => {
    expect(initials(null, "1.matteo.codogno@welld.ch")).toBe("MC");
  });

  it("one letter-bearing part, other parts digits: take the first two letters of the local part", () => {
    expect(initials(null, "mcodogno.2@welld.ch")).toBe("MC");
  });

  it("x@... -> XX (padded with X)", () => {
    expect(initials(null, "x@welld.ch")).toBe("XX");
    expect(initials("Cher", "x@welld.ch")).toBe("XX");
  });

  it("a local part with no letter at all -> XX", () => {
    expect(initials(null, "123@welld.ch")).toBe("XX");
    expect(initials(null, "@welld.ch")).toBe("XX");
  });

  it("strips diacritics and upper-cases in the email as well: élise.würth@ -> EW", () => {
    expect(initials(null, "élise.würth@welld.ch")).toBe("EW");
  });

  it("a name with a letterless last word falls back to the email rather than guessing", () => {
    expect(initials("Matteo 123", "anna.rossi@welld.ch")).toBe("AR");
  });

  it("an address without an @ is read as a local part, and a +tag does not break it", () => {
    expect(initials(null, "matteo.codogno")).toBe("MC");
    expect(initials(null, "matteo.codogno+refunds@welld.ch")).toBe("MC");
  });

  it("always returns exactly two characters A-Z, whatever it is given", () => {
    const names: (string | null)[] = [null, "", "A", "Ab", "A B", "日本 語", "Øyvind Ås", "ß ß", "  "];
    const emails = ["", "@", "a@b", "ab@b", "a.b@b", "日本@b", "1.2@b", "...@b", "a..b@c"];
    for (const name of names) {
      for (const email of emails) {
        expect(initials(name, email)).toMatch(/^[A-Z]{2}$/);
      }
    }
  });
});

describe("formatReceiptNumber (AC-4.2)", () => {
  it("MC + 2026 + 14 -> MC26/014", () => {
    expect(formatReceiptNumber("MC", 2026, 14)).toBe("MC26/014");
  });

  it("pads the sequence to three digits", () => {
    expect(formatReceiptNumber("MC", 2026, 1)).toBe("MC26/001");
    expect(formatReceiptNumber("MC", 2026, 99)).toBe("MC26/099");
    expect(formatReceiptNumber("MC", 2026, 100)).toBe("MC26/100");
  });

  it("prints 1000 and above in full, unpadded and untruncated", () => {
    expect(formatReceiptNumber("MC", 2026, 1000)).toBe("MC26/1000");
    expect(formatReceiptNumber("MC", 2026, 12345)).toBe("MC26/12345");
  });

  it("takes the year of the expense date, two digits: 2025 -> 25, 2009 -> 09", () => {
    expect(formatReceiptNumber("XX", 2025, 1)).toBe("XX25/001");
    expect(formatReceiptNumber("XX", 2009, 1)).toBe("XX09/001");
  });

  it("composes with initials(): Matteo Codogno, 2026, 81 -> MC26/081", () => {
    expect(formatReceiptNumber(initials("Matteo Codogno", "m@welld.ch"), 2026, 81)).toBe("MC26/081");
  });

  it("refuses initials that are not two letters A-Z, a bad year and a bad sequence", () => {
    expect(() => formatReceiptNumber("M", 2026, 1)).toThrow(RangeError);
    expect(() => formatReceiptNumber("mc", 2026, 1)).toThrow(RangeError);
    expect(() => formatReceiptNumber("MCC", 2026, 1)).toThrow(RangeError);
    expect(() => formatReceiptNumber("M1", 2026, 1)).toThrow(RangeError);
    expect(() => formatReceiptNumber("MC", 26, 1)).toThrow(RangeError);
    expect(() => formatReceiptNumber("MC", 2026.5, 1)).toThrow(RangeError);
    expect(() => formatReceiptNumber("MC", 2026, 0)).toThrow(RangeError);
    expect(() => formatReceiptNumber("MC", 2026, -3)).toThrow(RangeError);
    expect(() => formatReceiptNumber("MC", 2026, 1.5)).toThrow(RangeError);
  });
});
