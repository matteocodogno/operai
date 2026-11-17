/**
 * ProtectedChangeModel (T60): the protected details a restore changes, compared the way the registry compares, and the
 * wait of a 429 in whole minutes rounded up.
 */
import { describe, expect, it } from 'vitest'
import { protectedChangesBetween, waitText } from './ProtectedChangeModel'
import type { ComparedVersion } from './ProtectedChangeModel'

const version = (over: Partial<ComparedVersion> = {}): ComparedVersion => ({
  legalName: 'wellD AG',
  address: { it: ['Via Esempio 12'], en: ['Via Esempio 12'] },
  vatNumber: 'CHE-123.456.788 MWST',
  iban: 'CH9300762011623852957',
  ibanPrint: 'CH93 0076 2011 6238 5295 7',
  contacts: { it: '', en: '' },
  ...over,
})

describe('protectedChangesBetween (AC-9.4)', () => {
  it('is empty when no protected detail differs, whatever else does', () => {
    expect(
      protectedChangesBetween(version(), version({ address: { it: ['Altro'], en: ['Other'] }, contacts: { it: 'x', en: 'y' } })),
    ).toEqual([])
  })

  it('lists legal name, VAT number and IBAN in that order, Old = current and New = the version restored', () => {
    const current = version()
    const target = version({
      legalName: 'wellD SA',
      vatNumber: '',
      iban: 'DE89370400440532013000',
      ibanPrint: 'DE89 3704 0044 0532 0130 00',
    })
    expect(protectedChangesBetween(current, target)).toEqual([
      { field: 'legalName', before: 'wellD AG', after: 'wellD SA' },
      { field: 'vatNumber', before: 'CHE-123.456.788 MWST', after: '' },
      { field: 'iban', before: 'CH93 0076 2011 6238 5295 7', after: 'DE89 3704 0044 0532 0130 00' },
    ])
  })

  it('shows the IBAN as the registry prints it, and an empty IBAN as ""', () => {
    expect(protectedChangesBetween(version(), version({ iban: '', ibanPrint: '' }))).toEqual([
      { field: 'iban', before: 'CH93 0076 2011 6238 5295 7', after: '' },
    ])
  })

  it('does not list an IBAN that differs only in case or spacing, nor a name that differs only in outer spaces', () => {
    expect(
      protectedChangesBetween(
        version(),
        version({ iban: 'ch93 0076 2011 6238 5295 7', ibanPrint: 'ch93 0076 2011 6238 5295 7', legalName: '  wellD AG ' }),
      ),
    ).toEqual([])
  })
})

describe('waitText (F3)', () => {
  it.each([
    [1, '1 minute'],
    [0, '1 minute'],
    [60, '1 minute'],
    [61, '2 minutes'],
    [150, '3 minutes'],
    [600, '10 minutes'],
  ])('%s seconds is "%s": whole minutes, rounded up, at least one', (seconds, text) => {
    expect(waitText(seconds)).toBe(text)
  })

  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])('%s is no wait at all', (seconds) => {
    expect(waitText(seconds)).toBeUndefined()
  })
})
