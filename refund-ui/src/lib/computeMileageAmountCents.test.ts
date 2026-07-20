/**
 * Unit tests for computeMileageAmountCents (T12, specs/009-mileage-rate/
 * tasks.md; plan.md "Decision 3" / ADR-0025).
 *
 * DRIFT NOTE (see computeMileageAmountCents.ts's own doc comment for the
 * full analysis): this task's brief and plan.md's own worked JSON example
 * (`computedAmountCents: 168000` for `km: 240` / `ratePerKmMicros: 700000`)
 * both name a vector that is 10× the value the Decision-3/ADR-0025 FORMULA
 * actually produces (16800). This suite exercises the formula — mathematically
 * self-consistent and verified against ADR-0025's own worked reasoning ("CHF
 * 0.70/km × 240 km = CHF 168.00") — not the inconsistent literal figure.
 * `km=1, ratePerKmMicros=15000 → 2` (the half-up tie) is the one vector from
 * the brief that DOES match the formula, and is reproduced verbatim below.
 */
import { describe, expect, it } from 'vitest'
import { computeMileageAmountCents } from './computeMileageAmountCents'

describe('computeMileageAmountCents — canonical vectors', () => {
  it('240 km @ CHF 0.70/km (700000 micros) → 16800 cents (CHF 168.00)', () => {
    expect(computeMileageAmountCents(240, 700000)).toBe(16800)
  })

  it('100 km @ CHF 0.70/km (700000 micros) → 7000 cents (CHF 70.00)', () => {
    expect(computeMileageAmountCents(100, 700000)).toBe(7000)
  })

  it('1 km @ 0.015/km (15000 micros) → 2 cents — a round-half-up tie (1.5 → 2)', () => {
    expect(computeMileageAmountCents(1, 15000)).toBe(2)
  })
})

describe('computeMileageAmountCents — rounding rule', () => {
  it('rounds half up, not half-even (a banker\'s-rounding implementation would give 4 here, not 5)', () => {
    // 3 km @ 15000 micros/km = 45,000 micro-units / 10_000 = 4.5 → half-up = 5
    expect(computeMileageAmountCents(3, 15000)).toBe(5)
  })

  it('is exact for a non-tie fractional value — single rounding, no float drift', () => {
    // 45 km @ 725000 micros/km = 32,625,000 / 10_000 = 3262.5 → half-up = 3263
    expect(computeMileageAmountCents(45, 725000)).toBe(3263)
  })

  it('rounds down when the fraction is below the half-way point', () => {
    // 3 km @ 14000 micros/km = 42,000 / 10_000 = 4.2 → 4
    expect(computeMileageAmountCents(3, 14000)).toBe(4)
  })
})

describe('computeMileageAmountCents — edge cases', () => {
  it('returns 0 for km=0 (AC-1.4 blocks this at submission time — this function has no opinion on km>0)', () => {
    expect(computeMileageAmountCents(0, 700000)).toBe(0)
  })

  it('produces an exact integer for a large, realistic distance with no drift', () => {
    // 1000 km @ CHF 0.70/km = CHF 700.00 = 70000 cents
    expect(computeMileageAmountCents(1000, 700000)).toBe(70000)
  })
})
