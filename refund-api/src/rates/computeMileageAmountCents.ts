/**
 * Pure, DB-free mileage-amount computation (T3, specs/009-mileage-rate,
 * Decision 3).
 *
 * `amountCents = roundHalfUp(km * ratePerKmMicros / 10_000)`
 *
 * Both CHF and EUR use a 2-decimal minor unit (rappen / centesimi):
 * `ratePerKmMicros / 1e6` = major units per km; `* 100` = cents per km,
 * i.e. `/ 1e4`. `km` and `ratePerKmMicros` are both integers, so
 * `km * ratePerKmMicros` is an EXACT integer (no floating-point drift) —
 * the single division-and-round below is the ONLY rounding in the whole
 * chain (plan.md is explicit: no intermediate rounding).
 *
 * Rounding rule: round HALF UP (`Math.floor(x + 0.5)`), never banker's/
 * half-even — chosen as the conventional, easily-explained accounting rule.
 * Amounts are always >= 0 here (a real call site only ever invokes this with
 * `km > 0` and `ratePerKmMicros > 0`), so `Math.floor(x + 0.5)` is a safe,
 * simple round-half-up with no negative-number edge case to handle.
 *
 * refund-api is authoritative for every stored/snapshotted amount;
 * refund-ui (`refund-ui/src/lib/computeMileageAmountCents.ts`, T12) mirrors
 * this EXACT function purely for live preview — R1's mitigation is that
 * BOTH implementations are unit-tested against the SAME shared vector
 * fixture (`mileage-vectors.json`, sibling to this file) so they can never
 * silently diverge; the server value always wins on save/read regardless.
 */

export function computeMileageAmountCents(
  km: number,
  ratePerKmMicros: number,
): number {
  const productMicros = km * ratePerKmMicros;
  return Math.floor(productMicros / 10_000 + 0.5);
}
