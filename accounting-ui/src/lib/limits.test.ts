import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  checkFxRate,
  checkLedgerName,
  checkLedgerNumber,
  checkVatCode,
  checkVatLabel,
  checkVatRatePercent,
  reasonOf,
} from './limits'

const refused = (reason: string) => ({ ok: false, reason })
const accepted = (value: string) => ({ ok: true, value })

describe('limits (the mirror of accounting-api, AC-1.2, AC-1.5, AC-2.5)', () => {
  it('pins each number the dialogs check', () => {
    expect(LIMITS).toEqual({
      ledgerNumberMax: 20,
      ledgerNameMax: 120,
      vatCodeMax: 16,
      vatLabelMax: 80,
      vatRateDecimals: 2,
      vatRateMaxPercent: 100,
      fxRateDecimals: 6,
      fxRateBelow: 1000,
    })
  })

  describe('ledger account number (the plan vectors of AC-1.2)', () => {
    it.each(['5905', '2620.1', '1.2.3', '0', '0005'])('accepts %s', (value) => {
      expect(checkLedgerNumber(value)).toEqual(accepted(value))
    })

    it.each(['5905.', '.5', '59..05', '59a', '5 905', '5905,1', '-5', '１２３'])(
      'refuses %j as a wrong format',
      (value) => {
        expect(checkLedgerNumber(value)).toEqual(refused('format'))
      },
    )

    it.each(['', '   ', '\t\n'])('refuses %j as empty', (value) => {
      expect(checkLedgerNumber(value)).toEqual(refused('empty'))
    })

    it('removes leading and trailing blanks before the check', () => {
      expect(checkLedgerNumber(' 5905 ')).toEqual(accepted('5905'))
    })

    it('allows 20 characters and refuses 21 as too long, counting the dots', () => {
      expect(checkLedgerNumber('1'.repeat(20))).toEqual(accepted('1'.repeat(20)))
      expect(checkLedgerNumber('1'.repeat(21))).toEqual(refused('too_long'))
      expect(checkLedgerNumber(`${'1'.repeat(10)}.${'2'.repeat(9)}`).ok).toBe(true)
      expect(checkLedgerNumber(`${'1'.repeat(10)}.${'2'.repeat(10)}`)).toEqual(refused('too_long'))
    })

    it('says "format" before "too long" for a long value that is not a number', () => {
      expect(checkLedgerNumber(`${'1'.repeat(25)}x`)).toEqual(refused('format'))
    })
  })

  describe('ledger account name', () => {
    it('allows 120 characters and refuses 121 and blanks', () => {
      expect(checkLedgerName('x'.repeat(120)).ok).toBe(true)
      expect(checkLedgerName('x'.repeat(121))).toEqual(refused('too_long'))
      expect(checkLedgerName('   ')).toEqual(refused('empty'))
      expect(checkLedgerName('')).toEqual(refused('empty'))
    })

    it('trims, and the length is the trimmed length', () => {
      expect(checkLedgerName('  Cassa  ')).toEqual(accepted('Cassa'))
      expect(checkLedgerName(` ${'x'.repeat(120)} `).ok).toBe(true)
    })
  })

  describe('VAT code', () => {
    it('converts lower case to capital letters and trims', () => {
      expect(checkVatCode(' uSt-8_1 ')).toEqual(accepted('UST-8_1'))
    })

    it('allows 16 characters and refuses 17', () => {
      expect(checkVatCode('A'.repeat(16)).ok).toBe(true)
      expect(checkVatCode('A'.repeat(17))).toEqual(refused('too_long'))
    })

    it.each(['A B', 'A.B', 'A/B', 'À'])('refuses %j as a wrong format', (value) => {
      expect(checkVatCode(value)).toEqual(refused('format'))
    })

    it('refuses nothing but blanks as empty', () => {
      expect(checkVatCode('  ')).toEqual(refused('empty'))
    })
  })

  describe('VAT label', () => {
    it('allows 80 characters and refuses 81 and blanks', () => {
      expect(checkVatLabel('x'.repeat(80)).ok).toBe(true)
      expect(checkVatLabel('x'.repeat(81))).toEqual(refused('too_long'))
      expect(checkVatLabel(' ')).toEqual(refused('empty'))
    })
  })

  describe('VAT rate (0 to 100 percent, two decimals)', () => {
    it.each(['0', '8.1', '8.10', '19', '100', '100.00', '0.01', '99.99'])('accepts %s', (value) => {
      expect(checkVatRatePercent(value)).toEqual(accepted(value))
    })

    it.each(['100.01', '101', '999'])('refuses %s as out of range', (value) => {
      expect(checkVatRatePercent(value)).toEqual(refused('range'))
    })

    it.each(['8.123', '8,1', '-1', '1000', '.5', '5.', 'abc', '1e2', '8 1'])(
      'refuses %j as a wrong format',
      (value) => {
        expect(checkVatRatePercent(value)).toEqual(refused('format'))
      },
    )

    it('refuses blank as empty', () => {
      expect(checkVatRatePercent('')).toEqual(refused('empty'))
    })
  })

  describe('exchange-rate correction (AC-2.5: above 0, below 1000, six decimals)', () => {
    it.each(['0.9246', '0.9300', '1', '999.999999', '0.000001', '10'])('accepts %s', (value) => {
      expect(checkFxRate(value)).toEqual(accepted(value))
    })

    it.each(['0', '0.0', '0.000000', '1000', '1000.000000', '1234', '9999'])('refuses %s as out of range', (value) => {
      expect(checkFxRate(value)).toEqual(refused('range'))
    })

    it.each(['0.1234567', '-1', '0,9', '1e-3', '.5', '5.', 'x', '0.9 3'])('refuses %j as a wrong format', (value) => {
      expect(checkFxRate(value)).toEqual(refused('format'))
    })

    it('refuses blank as empty and trims a value', () => {
      expect(checkFxRate('   ')).toEqual(refused('empty'))
      expect(checkFxRate(' 0.93 ')).toEqual(accepted('0.93'))
    })
  })

  describe('reasonOf (a server fields[] reason as one of ours)', () => {
    it('keeps the reasons it knows and reads any other as a wrong format', () => {
      expect(reasonOf('empty')).toBe('empty')
      expect(reasonOf('too_long')).toBe('too_long')
      expect(reasonOf('format')).toBe('format')
      expect(reasonOf('range')).toBe('range')
      expect(reasonOf('something_new')).toBe('format')
      expect(reasonOf(undefined)).toBe('format')
    })
  })
})
