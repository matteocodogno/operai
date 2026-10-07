/**
 * Integer-cent money helpers for the depreciation maths (specs/015, ADR-0025/0046).
 * Pure: no I/O, no env. No float ever enters a result.
 */

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${value}`);
  }
}

/**
 * round(n / d) half-up, in pure integer arithmetic. `n >= 0`, `d >= 1`, both safe integers.
 *
 * `n % d` is exact for safe integers and `n - r` is an exact multiple of `d`, so the quotient is
 * exact. The half test is `r >= d - r` (rather than `2r >= d`) so no intermediate can exceed
 * `Number.MAX_SAFE_INTEGER`.
 */
export function roundHalfUp(n: number, d: number): number {
  assertNonNegativeSafeInteger(n, "numerator");
  assertNonNegativeSafeInteger(d, "denominator");
  if (d === 0) throw new RangeError("denominator must be at least 1");
  const r = n % d;
  const q = (n - r) / d;
  return r >= d - r ? q + 1 : q;
}

/**
 * Split a total over `n` units (AC-1.3): each unit is floor(total / n), the remaining cents go on
 * the LAST unit, so the parts sum exactly to the total. Mirrors inventory-ui's `splitPrice` via
 * the shared vectors in `schedule-vectors.json`.
 */
export function splitPrice(totalCents: number, n: number): number[] {
  assertNonNegativeSafeInteger(totalCents, "totalCents");
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`n must be a safe integer >= 1, got ${n}`);
  }
  const remainder = totalCents % n;
  const each = (totalCents - remainder) / n;
  const parts = new Array<number>(n).fill(each);
  parts[n - 1] = each + remainder;
  return parts;
}
