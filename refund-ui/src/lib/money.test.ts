/**
 * Unit tests for formatMoney (T14, specs/007-refund-service/tasks.md —
 * "formatMoney unit tests pass per currency (EUR/CHF, 2 decimals)").
 * Answers plan.md's R7 risk directly: money as cents mis-formatting
 * (off-by-100), unit-tested per currency.
 */
import { describe, expect, it } from 'vitest'
import { describeApprovedAmount, formatMoney, formatRatePerKm } from './money'

describe('formatMoney — EUR', () => {
  it('formats whole euros with two zero decimals', () => {
    expect(formatMoney(10000, 'EUR')).toBe('100,00 €')
  })

  it('formats a mixed cents amount', () => {
    expect(formatMoney(4550, 'EUR')).toBe('45,50 €')
  })

  it('pads single-digit cents to two decimal places (off-by-100 guard)', () => {
    expect(formatMoney(5, 'EUR')).toBe('0,05 €')
  })

  it('formats zero', () => {
    expect(formatMoney(0, 'EUR')).toBe('0,00 €')
  })

  it('formats a large amount without thousands separators or float drift', () => {
    expect(formatMoney(999999, 'EUR')).toBe('9999,99 €')
  })
})

describe('formatMoney — CHF', () => {
  it('formats whole Swiss francs with two zero decimals', () => {
    expect(formatMoney(10000, 'CHF')).toBe('100,00 CHF')
  })

  it('formats a mixed cents amount', () => {
    expect(formatMoney(4550, 'CHF')).toBe('45,50 CHF')
  })

  it('pads single-digit cents to two decimal places (off-by-100 guard)', () => {
    expect(formatMoney(5, 'CHF')).toBe('0,05 CHF')
  })

  it('formats zero', () => {
    expect(formatMoney(0, 'CHF')).toBe('0,00 CHF')
  })
})

describe('formatMoney — USD', () => {
  it('formats whole dollars with two zero decimals', () => {
    expect(formatMoney(10000, 'USD')).toBe('100,00 $')
  })

  it('formats a mixed cents amount', () => {
    expect(formatMoney(4550, 'USD')).toBe('45,50 $')
  })

  it('pads single-digit cents to two decimal places (off-by-100 guard)', () => {
    expect(formatMoney(5, 'USD')).toBe('0,05 $')
  })

  it('formats zero', () => {
    expect(formatMoney(0, 'USD')).toBe('0,00 $')
  })
})

describe('formatMoney — GBP', () => {
  it('formats whole pounds with two zero decimals', () => {
    expect(formatMoney(10000, 'GBP')).toBe('100,00 £')
  })

  it('formats a mixed cents amount', () => {
    expect(formatMoney(4550, 'GBP')).toBe('45,50 £')
  })

  it('pads single-digit cents to two decimal places (off-by-100 guard)', () => {
    expect(formatMoney(5, 'GBP')).toBe('0,05 £')
  })

  it('formats zero', () => {
    expect(formatMoney(0, 'GBP')).toBe('0,00 £')
  })
})

describe('formatMoney — integer-cents contract', () => {
  it('throws on a non-integer cents value rather than silently mis-rendering an amount', () => {
    expect(() => formatMoney(45.5, 'EUR')).toThrow(RangeError)
  })

  it('throws on a non-finite cents value', () => {
    expect(() => formatMoney(Number.NaN, 'EUR')).toThrow(RangeError)
    expect(() => formatMoney(Number.POSITIVE_INFINITY, 'CHF')).toThrow(RangeError)
  })

  it('never produces float-division drift for values that are awkward in IEEE 754 (e.g. 3 cents)', () => {
    expect(formatMoney(3, 'EUR')).toBe('0,03 €')
    expect(formatMoney(103, 'CHF')).toBe('1,03 CHF')
  })
})

describe('formatRatePerKm (specs/009-mileage-rate)', () => {
  it('re-punctuates the dot decimal to a comma and appends the unit-suffixed currency', () => {
    expect(formatRatePerKm('0.70', 'CHF')).toBe('0,70 CHF/km')
    expect(formatRatePerKm('0.70', 'EUR')).toBe('0,70 €/km')
  })

  it('passes through whatever precision refund-api already formatted, unmodified beyond punctuation', () => {
    expect(formatRatePerKm('0.725', 'CHF')).toBe('0,725 CHF/km')
  })
})

// ─── describeApprovedAmount (AC-3.2, amended 2026-09-08) ───────────────────
//
// The single source of truth both the per-line row and the totals card read,
// so they can never disagree about whether an amount was adjusted. Tested here
// rather than only through the two components, because that shared-ness is the
// property that matters.

describe('describeApprovedAmount', () => {
  it('reports an untouched amount as unchanged, with one figure', () => {
    const result = describeApprovedAmount(15400, 15400, 'CHF')
    expect(result).toEqual({ changed: false, approved: '154,00 CHF' })
  })

  it('treats a null approved total as unchanged — refund-api approves in full', () => {
    const result = describeApprovedAmount(15400, null, 'CHF')
    expect(result).toEqual({ changed: false, approved: '154,00 CHF' })
  })

  it('reports a cut with the original and a signed delta', () => {
    const result = describeApprovedAmount(18000, 15400, 'CHF')
    expect(result).toEqual({
      changed: true,
      approved: '154,00 CHF',
      requested: '180,00',
      delta: '\u221226,00',
    })
  })

  // A rise is just as notable as a cut, and an unsigned delta would read as a
  // cut by default.
  it('signs an increase with + rather than leaving it ambiguous', () => {
    const result = describeApprovedAmount(10000, 12500, 'EUR')
    expect(result).toEqual({
      changed: true,
      approved: '125,00 €',
      requested: '100,00',
      delta: '+25,00',
    })
  })

  // Only the approved figure carries the currency — repeating it three times
  // in one phrase is the noise this whole change is removing.
  it('omits the currency from the parenthetical values', () => {
    const result = describeApprovedAmount(18000, 15400, 'CHF')
    if (!result.changed) throw new Error('expected a changed amount')
    expect(result.approved).toContain('CHF')
    expect(result.requested).not.toContain('CHF')
    expect(result.delta).not.toContain('CHF')
  })

  it('uses a true minus sign, not a hyphen, beside tabular figures', () => {
    const result = describeApprovedAmount(18000, 15400, 'CHF')
    if (!result.changed) throw new Error('expected a changed amount')
    expect(result.delta.startsWith('\u2212')).toBe(true)
    expect(result.delta.startsWith('-')).toBe(false)
  })

  it('handles a cut to zero — a fully disallowed line is still a change', () => {
    const result = describeApprovedAmount(5000, 0, 'EUR')
    expect(result).toEqual({
      changed: true,
      approved: '0,00 €',
      requested: '50,00',
      delta: '\u221250,00',
    })
  })
})
