/**
 * Unit tests for formatMoney (T14, specs/007-refund-service/tasks.md —
 * "formatMoney unit tests pass per currency (EUR/CHF, 2 decimals)").
 * Answers plan.md's R7 risk directly: money as cents mis-formatting
 * (off-by-100), unit-tested per currency.
 */
import { describe, expect, it } from 'vitest'
import { formatMoney } from './money'

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
