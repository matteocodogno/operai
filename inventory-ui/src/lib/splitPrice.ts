/**
 * splitPrice — how a multi-unit registration's total becomes N unit prices
 * (T30, specs/015-hardware-inventory; AC-1.3; plan.md § API contracts).
 *
 * Mirrors the backend rule, which is the source of truth (inventory-api task
 * T8): each unit is `floor(total / n)` cents and the remaining cents go on the
 * LAST unit, so the N prices sum exactly to the total. It exists here only so
 * the register form can show the per-unit breakdown before saving, and it is
 * pinned to the backend by `split-vectors.json`, which both sides assert.
 *
 * Integer arithmetic only; a non-integer or out-of-range input is a programmer
 * error and throws (like `formatMoney`) instead of quoting a wrong price.
 */
export const splitPrice = (totalCents: number, quantity: number): number[] => {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new RangeError(`splitPrice: totalCents must be a non-negative integer, got ${totalCents}`)
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError(`splitPrice: quantity must be a positive integer, got ${quantity}`)
  }
  const each = Math.floor(totalCents / quantity)
  const remainder = totalCents - each * quantity
  return Array.from({ length: quantity }, (_, index) => (index === quantity - 1 ? each + remainder : each))
}
