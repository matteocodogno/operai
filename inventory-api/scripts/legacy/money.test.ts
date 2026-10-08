import { describe, it, expect } from "bun:test";
import { toCents } from "./money";

describe("toCents (AC-12.2: round half-up to the cent, once)", () => {
  it("rounds half-up where a float multiplication would round down", () => {
    expect(Math.round(1.005 * 100)).toBe(100); // the trap
    expect(toCents(1.005)).toBe(101);
    expect(toCents(2.675)).toBe(268);
    expect(toCents(0.125)).toBe(13);
    expect(toCents(1.115)).toBe(112);
  });

  it("rounds the long fractions of a formula result", () => {
    expect(toCents(28.333333333333)).toBe(2833);
    expect(toCents(66.666666666667)).toBe(6667);
    expect(toCents(0.004)).toBe(0);
    expect(toCents(0.005)).toBe(1);
    expect(toCents(0.00499999)).toBe(0);
  });

  it("is exact for amounts that are already whole cents", () => {
    for (const cents of [0, 1, 99, 100, 101, 29_756_49, 1_000_000_00]) {
      expect(toCents(cents / 100)).toBe(cents);
    }
    expect(toCents(21688.9967)).toBe(2168900);
  });

  it("refuses what is not a finite amount", () => {
    expect(() => toCents(Number.NaN)).toThrow();
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow();
  });
});
