/**
 * computeMileageAmountCents — the canonical `km × rate → cents` rounding
 * rule (T12, specs/009-mileage-rate/tasks.md; plan.md "Decision 3" / ADR-0025),
 * mirrored client-side in refund-ui for `MileageAmountField`'s LIVE PREVIEW
 * only (plan.md Risk R1: "one canonical rule … a single shared test-vector
 * set exercised by BOTH refund-api and refund-ui unit tests, and the server
 * value always overwrites on save/read — the preview is advisory only").
 *
 * Both `km` and `ratePerKmMicros` are integers (`km` — refund-api's `Int`
 * column; `ratePerKmMicros` — an integer count of `1e-6` major-currency-units
 * per km, ADR-0025), so `km × ratePerKmMicros` is an EXACT integer product —
 * the single division by `10_000` (⇔ `÷1e6` to major units, `×100` to cents)
 * is the only rounding step in the whole chain, per ADR-0025's explicit "no
 * intermediate rounding" requirement.
 *
 * Rounding rule: round HALF UP (not half-even/banker's) — `Math.floor(x +
 * 0.5)` is exact for every non-negative `x` here since amounts are always
 * ≥ 0 (a submittable line requires `km > 0` and `rate > 0`, AC-1.4/AC-4.5).
 *
 * Canonical rule: `amountCents = roundHalfUp(km × ratePerKmMicros / 10_000)`
 * (micros→major is /1e6, major→cents is ×100, net /1e4). refund-api implements
 * the IDENTICAL rule and both sides share the same test vectors (R1): e.g.
 * `240 × 700000 / 10_000 = 16800` rappen (CHF 0.70/km × 240 km = CHF 168.00),
 * `100 × 700000 → 7000`, `1 × 15000 → 2` (half-up tie). (A worked JSON example
 * in an early draft of plan.md showed `168000` here — a 10× error corrected in
 * commit `eeeea25`; the normative formula was always right.)
 */

/**
 * Integer-only, single-rounding `km × rate → cents` (Decision 3, ADR-0025).
 * `km` and `ratePerKmMicros` must both be non-negative integers — this
 * function has no opinion on `km > 0` (AC-1.4's own validation, enforced
 * elsewhere) or on whether a rate is even in effect (`rateInEffect`, resolved
 * by the caller before this is invoked).
 */
export const computeMileageAmountCents = (km: number, ratePerKmMicros: number): number =>
  Math.floor((km * ratePerKmMicros) / 10_000 + 0.5)
