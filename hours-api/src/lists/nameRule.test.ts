/**
 * The name rule on its own (specs/029 plan § Lists, § Entries "Counting a note and a name" and "A lone
 * surrogate in a note or a name"; AC-3.1, AC-3.8). Routes prove it end to end (lists.test.ts); this
 * pins the edges of the function the way a later consumer would call it.
 */
import { describe, expect, it } from "bun:test";
import { NAME_MAX_CODE_POINTS, NameSchema } from "./nameRule";

const parse = (value: unknown) => NameSchema.safeParse(value);

describe("NameSchema", () => {
  it("returns the name trimmed at the ends and exactly as typed inside", () => {
    expect(parse("Training")).toEqual({ success: true, data: "Training" });
    expect(parse("  Talk   Preparation \n")).toEqual({ success: true, data: "Talk   Preparation" });
    expect(parse(" Formazione　")).toEqual({ success: true, data: "Formazione" });
    expect(parse("AI Pair-Programming")).toEqual({ success: true, data: "AI Pair-Programming" });
  });

  it("counts code points after trimming: 80 pass, 81 do not, emoji included", () => {
    expect(NAME_MAX_CODE_POINTS).toBe(80);
    expect(parse("a".repeat(80)).success).toBe(true);
    expect(parse("a".repeat(81)).success).toBe(false);
    expect(parse("😀".repeat(80)).success).toBe(true);
    expect(parse("😀".repeat(81)).success).toBe(false);
    expect(parse(`   ${"a".repeat(80)}   `).success).toBe(true);
    expect(parse(`   ${"a".repeat(81)}   `).success).toBe(false);
  });

  it("refuses an empty name, and one that is only whitespace", () => {
    for (const value of ["", " ", "   ", "\n\t\r", " 　"]) expect(parse(value).success).toBe(false);
  });

  it("refuses a NUL, wherever it is", () => {
    for (const value of ["\u0000", "a\u0000", "\u0000a", " \u0000 ", "Sem\u0000inars"]) expect(parse(value).success).toBe(false);
  });

  it("refuses half of a surrogate pair, and accepts a whole pair", () => {
    for (const value of ["\ud800", "\udc00", "a\ud800", "\ud800b", "a\udc00b", "\udc00\ud800"]) expect(parse(value).success).toBe(false);
    expect(parse("😀").success).toBe(true);
    expect(parse("a😀b").success).toBe(true);
  });

  it("refuses what is not a string", () => {
    for (const value of [undefined, null, 7, true, {}, ["a"]]) expect(parse(value).success).toBe(false);
  });

  it("never echoes the name in a message", () => {
    for (const value of ["x\u0000secret", "secret\ud800", "secret".repeat(40)]) {
      const result = parse(value);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((issue) => issue.message).join(" ")).not.toContain("secret");
    }
  });
});
