import { describe, expect, it } from "bun:test";
import { IdSchema } from "./http";

describe("IdSchema", () => {
  it("accepts 1..64 characters", () => {
    expect(IdSchema.safeParse("a").success).toBe(true);
    expect(IdSchema.safeParse("x".repeat(64)).success).toBe(true);
  });
  it("refuses empty and over-long", () => {
    expect(IdSchema.safeParse("").success).toBe(false);
    expect(IdSchema.safeParse("x".repeat(65)).success).toBe(false);
  });
  it("refuses a NUL anywhere, and names the rule without the value", () => {
    for (const value of ["\u0000", "\u0000ab", "ab\u0000", "a\u0000b"]) {
      const result = IdSchema.safeParse(value);
      expect(result.success).toBe(false);
      if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain("ab");
    }
  });
});
