/**
 * The id rule (specs/029 plan § Entries, "The id rule"; amended 2026-11-13): 1..64 UTF-16 code units,
 * no NUL, no comma, no whitespace at either end. The labels layer applies it to the one id it did not
 * see pass at write time, a deal id read from meetings-api's system route (plan § Views, amendment 3).
 */
import { describe, expect, it } from "bun:test";
import { ID_MAX_LENGTH, satisfiesIdRule } from "./idRule";

describe("satisfiesIdRule", () => {
  it("accepts what every owner generates: a cuid, a UUID, an alphanumeric user id, a seeded `tc-` id", () => {
    for (const id of ["cmhw3q0a10000x2k9", "7d8e6f3a-5b1c-4d2e-9a0f-123456789abc", "AbC123xyz", "tc-training", "a"]) {
      expect(satisfiesIdRule(id)).toBe(true);
    }
  });

  it("counts UTF-16 code units, the unit of every owner's bound: 64 pass, 65 do not", () => {
    expect(ID_MAX_LENGTH).toBe(64);
    expect(satisfiesIdRule("x".repeat(64))).toBe(true);
    expect(satisfiesIdRule("x".repeat(65))).toBe(false);
    // An emoji is two units: 32 of them are 64, 33 are 66.
    expect(satisfiesIdRule("😀".repeat(32))).toBe(true);
    expect(satisfiesIdRule("😀".repeat(33))).toBe(false);
  });

  it("refuses an empty id, a NUL and a comma", () => {
    expect(satisfiesIdRule("")).toBe(false);
    expect(satisfiesIdRule("a\u0000b")).toBe(false);
    expect(satisfiesIdRule("\u0000")).toBe(false);
    expect(satisfiesIdRule("a,b")).toBe(false);
    expect(satisfiesIdRule(",")).toBe(false);
  });

  it("refuses whitespace at either end, an id of spaces included, and keeps an inner space", () => {
    for (const id of [" d1", "d1 ", " d1 ", " ", "   ", "\td1", "d1\n", " d1", "d1 "]) {
      expect(satisfiesIdRule(id)).toBe(false);
    }
    expect(satisfiesIdRule("a b")).toBe(true);
    // The characters a query value or a path may need escaping for are fine: the clients encode them.
    for (const id of ["a&b", "a#b", "a+b", "a%b", "a/b", "a?b"]) expect(satisfiesIdRule(id)).toBe(true);
  });
});
