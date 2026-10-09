/**
 * Unit tests for the money helpers (T25, specs/015-hardware-inventory),
 * carried over from refund-ui/src/lib/money.test.ts (EUR and CHF only — the
 * only two currencies inventory-api carries) plus `amountToCents`, the
 * money-input parser ported from refund-ui's `lineDraft.ts` and tightened:
 * exact decimal-string arithmetic, no float step, no silent rounding of a
 * third decimal.
 */
import { describe, expect, it } from 'vitest'
import { amountToCents, formatMoney, formatMoneyAmount } from './money'

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

  it('signs a negative amount', () => {
    expect(formatMoney(-2600, 'EUR')).toBe('-26,00 €')
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

describe('formatMoneyAmount', () => {
  it('formats minor units without a currency label', () => {
    expect(formatMoneyAmount(15400)).toBe('154,00')
    expect(formatMoneyAmount(-5)).toBe('-0,05')
  })

  it('throws on a non-integer value', () => {
    expect(() => formatMoneyAmount(1.5)).toThrow(RangeError)
  })
})

describe('amountToCents', () => {
  it('parses a major-unit string into integer cents', () => {
    expect(amountToCents('45.50')).toBe(4550)
    expect(amountToCents('0')).toBe(0)
    expect(amountToCents('1299')).toBe(129900)
  })

  it('accepts a comma decimal separator, the suite display convention', () => {
    expect(amountToCents('45,5')).toBe(4550)
    expect(amountToCents('0,05')).toBe(5)
  })

  it('trims surrounding whitespace', () => {
    expect(amountToCents('  12.30 ')).toBe(1230)
  })

  it('is exact where float multiplication is not (1.15 * 100 is 114.99999999999999)', () => {
    expect(amountToCents('1.15')).toBe(115)
    expect(amountToCents('8.2')).toBe(820)
  })

  it('returns null for empty input, never 0', () => {
    expect(amountToCents('')).toBeNull()
    expect(amountToCents('   ')).toBeNull()
  })

  it('returns null for negative, non-numeric or exponent input', () => {
    expect(amountToCents('-5')).toBeNull()
    expect(amountToCents('abc')).toBeNull()
    expect(amountToCents('1e3')).toBeNull()
    expect(amountToCents('1.2.3')).toBeNull()
    expect(amountToCents('12 CHF')).toBeNull()
  })

  it('returns null for a third decimal instead of rounding a price silently', () => {
    expect(amountToCents('1.005')).toBeNull()
  })

  it('returns null for an amount beyond the safe integer range', () => {
    expect(amountToCents('99999999999999999')).toBeNull()
  })
})
