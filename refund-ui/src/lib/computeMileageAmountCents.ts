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
 * DRIFT NOTE (flagged in this task's implementation report — refund-api's
 * T3/T4 rate module is UNIMPLEMENTED as of this task; this worktree has no
 * `refund-api/src/rates/` at all yet). `specs/009-mileage-rate/plan.md`'s own
 * "## API contracts" worked JSON example (`mileage.computedAmountCents:
 * 168000` for `km: 240` / `appliedRate.ratePerKmMicros: 700000`, plan.md line
 * 382) is INCONSISTENT with this same plan's Decision 3 / ADR-0025 formula by
 * a factor of 10: `240 × 700000 / 10_000 = 16800`, not `168000` — and 16800
 * is also the only value consistent with the plan's own stated rate ("CHF
 * 0.70/km × 240 km = CHF 168.00" ⇒ 16800 rappen; 168000 rappen would be CHF
 * 1'680.00, ~10× too much for that rate/distance). This module implements
 * the FORMULA (mathematically self-consistent, verified against its own
 * derivation and against ADR-0025's worked reasoning), NOT the JSON example's
 * literal figure — flagged for architect/backend-dev confirmation before
 * T3/T5 land, so refund-api's real implementation and this module don't
 * diverge 10× at integration (exactly the R1 failure mode the shared-vector
 * mitigation exists to prevent). See this module's test file for the
 * corrected canonical vectors.
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
