/**
 * The id rule on its own (specs/029 plan § Entries, "The id rule and a NUL-free note"). Every route
 * that takes an id imports it (T12 onward), so its edges are pinned here once: what is refused, and
 * — as important — what is NOT, since a wrongly refused id is a record nobody can reach.
 */
import { describe, expect, it } from "bun:test";
import { ID_MAX_LENGTH, IdSchema, isWellFormedId } from "./idRule";

describe("isWellFormedId", () => {
  it("accepts what every owner generates: cuids, UUIDs, better-auth ids, the seeded ids", () => {
    for (const id of [
      "cmhx0p3v10000abcd1234efgh",
      "0b6d2f6e-8d57-4c0f-9f3a-5d8a5a5b9c11",
      "k9Xo2LzQb1TnV8mYrW3eAcDfGhJiKlMn",
      "tc-training",
      "wt-project-development",
      "user-alice",
      "x",
    ]) {
      expect(isWellFormedId(id)).toBe(true);
    }
  });

  it("counts UTF-16 code units, the unit of every owner's bound: 64 is in, 65 is out", () => {
    expect(ID_MAX_LENGTH).toBe(64);
    expect(isWellFormedId("a".repeat(64))).toBe(true);
    expect(isWellFormedId("a".repeat(65))).toBe(false);
    // An emoji is two units: 32 of them are 64, 33 are 66.
    expect(isWellFormedId("😀".repeat(32))).toBe(true);
    expect(isWellFormedId("😀".repeat(33))).toBe(false);
  });

  it("refuses the empty id, a NUL anywhere and a comma anywhere", () => {
    for (const id of ["", "\u0000", "a\u0000", "\u0000a", "a\u0000b", ",", "a,b", "a,", ",a", "a,,b"]) {
      expect(isWellFormedId(id)).toBe(false);
    }
  });

  it("refuses whitespace at either end, whatever kind, and keeps an inner space", () => {
    for (const id of [" ", "  ", " a", "a ", "\ta", "a\n", "\r\n", " a", "a ", " a", "a　", "﻿a"]) {
      expect(isWellFormedId(id)).toBe(false);
    }
    expect(isWellFormedId("a b")).toBe(true);
    expect(isWellFormedId("a b")).toBe(true);
  });

  it("does not look at anything else: the characters a URL or a query would escape are ordinary", () => {
    for (const id of ["a&b", "a#b", "a+b", "a%b", "a?b", "a/b", "a\\b", "a=b", "a;b", "é", "ü-1", "名前"]) {
      expect(isWellFormedId(id)).toBe(true);
    }
  });

  it("does not judge surrogates: a lone one is no owner's id and gets the answer of any unknown id", () => {
    expect(isWellFormedId("\ud800")).toBe(true);
    expect(isWellFormedId("a\udc00b")).toBe(true);
  });
});

describe("IdSchema", () => {
  it("parses a well-formed id unchanged and refuses the rest without echoing it", () => {
    expect(IdSchema.parse("tc-training")).toBe("tc-training");
    const result = IdSchema.safeParse("secret-value,with-a-comma");
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join(" ");
      expect(message).not.toContain("secret-value");
    }
  });

  it("refuses what is not a string", () => {
    for (const value of [undefined, null, 7, {}, ["a"]]) expect(IdSchema.safeParse(value).success).toBe(false);
  });
});
