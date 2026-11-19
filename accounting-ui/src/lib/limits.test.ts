import { describe, expect, it } from 'vitest'
import {
  CATALOG_CAPS,
  LIMITS,
  checkFxRate,
  checkLedgerName,
  checkLedgerNumber,
  checkText,
  checkVatCode,
  checkVatLabel,
  checkVatRatePercent,
  reasonOf,
  upperCaseCode,
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

  describe('a blank is nothing to see, and a length is counted in characters (T53 D-6, the server vectors of limits.test.ts)', () => {
    // Keep in step with accounting-api/src/catalog/limits.test.ts `INVISIBLE`.
    const INVISIBLE = [
      ['a zero-width space', '\u200B'],
      ['a zero-width non-joiner and joiner', '\u200C\u200D'],
      ['a left-to-right and a right-to-left mark', '\u200E\u200F'],
      ['a bidi embedding and its pop', '\u202A\u202C'],
      ['a bidi isolate and its pop', '\u2066\u2069'],
      ['an Arabic letter mark', '\u061C'],
      ['a word joiner', '\u2060'],
      ['a byte order mark', '\uFEFF'],
      ['a soft hyphen', '\u00AD'],
      ['a no-break space and an ideographic space', '\u00A0\u3000'],
      ['a Hangul filler', '\u3164'],
      ['a Braille blank', '\u2800'],
    ] as const

    it.each(INVISIBLE)('a name or a label made only of %s is `empty`, however many of them', (_what, chars) => {
      for (const blank of [chars, chars.repeat(5), ` ${chars} `, `\t${chars}\n`]) {
        expect(checkLedgerName(blank)).toEqual(refused('empty'))
        expect(checkVatLabel(blank)).toEqual(refused('empty'))
        expect(checkText(blank, 5)).toEqual(refused('empty'))
      }
    })

    it('a visible character among the invisible ones makes it a name, kept as typed (only the ends are trimmed)', () => {
      expect(checkLedgerName('\u200Bspese\u200B')).toEqual(accepted('\u200Bspese\u200B'))
      expect(checkLedgerName('a\u200Bb')).toEqual(accepted('a\u200Bb'))
      // an emoji sequence joined by ZWJ is a name, not a blank
      expect(checkVatLabel('\u{1F468}\u200D\u{1F4BB}')).toEqual(accepted('\u{1F468}\u200D\u{1F4BB}'))
    })

    it('an invisible character with a NUL or another control is still `format`, a NUL alone too', () => {
      expect(checkLedgerName('\u200B\u0000')).toEqual(refused('format'))
      expect(checkLedgerName('\u0000')).toEqual(refused('format'))
      expect(checkVatLabel('a\u0007')).toEqual(refused('format'))
    })

    it('counts code points: 120 emoji are a name of 120 characters, 121 are `too_long`', () => {
      const emoji = '\u{1F600}'
      expect(checkLedgerName(emoji.repeat(120))).toEqual(accepted(emoji.repeat(120)))
      expect(checkLedgerName(emoji.repeat(121))).toEqual(refused('too_long'))
      expect(checkVatLabel(emoji.repeat(80))).toEqual(accepted(emoji.repeat(80)))
      expect(checkVatLabel(emoji.repeat(81))).toEqual(refused('too_long'))
      expect(checkLedgerName('a'.repeat(120))).toEqual(accepted('a'.repeat(120)))
      expect(checkLedgerName('a'.repeat(121))).toEqual(refused('too_long'))
    })

    it('a name the length of which in UTF-16 units is over the limit but in characters is not, is accepted', () => {
      expect('\u{1F600}'.repeat(100).length).toBe(200)
      expect(checkLedgerName('\u{1F600}'.repeat(100)).ok).toBe(true)
    })
  })

  describe('CATALOG_CAPS (T53: the server pins the same numbers)', () => {
    it('pins the caps used only as the fallback of a 409 `catalog_full` without a readable limit', () => {
      expect(CATALOG_CAPS).toEqual({ ledgerAccountsPerEntity: 200, vatCodesPerEntity: 50 })
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

  describe('upper-casing is ASCII only (T53 `upperCaseCode`)', () => {
    it('converts a to z and nothing else', () => {
      expect(upperCaseCode('abc-xyz_9')).toBe('ABC-XYZ_9')
      expect(upperCaseCode('\u00DF\u017F\u0131\uFF41')).toBe('\u00DF\u017F\u0131\uFF41')
    })

    it.each([
      ['sharp s', '\u00DF'],
      ['long s', '\u017F'],
      ['dotless i', '\u0131'],
      ['full-width a', '\uFF41'],
      ['full-width A', '\uFF21'],
      ['a letter with an accent', '\u00E0'],
    ])('keeps %s as typed and refuses it as `format` (never converts it into a letter of the alphabet)', (_what, char) => {
      expect(checkVatCode(char)).toEqual(refused('format'))
      expect(checkVatCode(`imp${char}`)).toEqual(refused('format'))
    })

    it('still converts lower case a to z around them for the codes that are fine', () => {
      expect(checkVatCode('imp-81')).toEqual(accepted('IMP-81'))
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
