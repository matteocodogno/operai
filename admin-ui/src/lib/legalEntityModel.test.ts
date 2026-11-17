/** The shared shapes and normalisation of the registry client (T34, specs/20261117-legal-entities; AC-2.1, AC-1.4). */
import { describe, expect, it } from 'vitest'
import {
  LEGAL_ENTITY_FIELDS,
  FIELD_PAGE_ORDER,
  changedFieldsBetween,
  codePointLength,
  detailsOf,
  emptyDetails,
  getFieldValue,
  isLegalEntityId,
  normalizeDetails,
  normalizeIban,
  sameFieldValue,
  setFieldValue,
} from './legalEntityModel'
import type { LegalEntityDetails } from './legalEntityModel'

const DETAILS: LegalEntityDetails = {
  legalName: 'wellD SA',
  address: { it: ['Via Cantonale 1', '6900 Lugano'], en: ['Via Cantonale 1', '6900 Lugano'] },
  vatNumber: 'CHE-123.456.789 IVA',
  iban: 'CH9300762011623852957',
  contacts: { it: 'a', en: 'b' },
}

describe('legalEntityModel', () => {
  it('knows exactly the two entities', () => {
    expect(isLegalEntityId('welld_it')).toBe(true)
    expect(isLegalEntityId('welld_ch')).toBe(true)
    expect(isLegalEntityId('welld_de')).toBe(false)
    expect(isLegalEntityId(undefined)).toBe(false)
  })

  it('lists the same seven values in API order and in page order', () => {
    expect(LEGAL_ENTITY_FIELDS).toHaveLength(7)
    expect([...FIELD_PAGE_ORDER].sort()).toEqual([...LEGAL_ENTITY_FIELDS].sort())
  })

  it('normalises like a save: NFC, trim, blank address lines out, IBAN in electronic form', () => {
    expect(
      normalizeDetails({
        legalName: ' wellD SA ',
        address: { it: [' Via ', '', '   ', 'Lugano'], en: [] },
        vatNumber: ' CHE　',
        iban: ' ch93 0076 2011 6238 5295 7 ',
        contacts: { it: ' x ', en: '' },
      }),
    ).toEqual({
      legalName: 'wellD SA',
      address: { it: ['Via', 'Lugano'], en: [] },
      vatNumber: 'CHE',
      iban: 'CH9300762011623852957',
      contacts: { it: 'x', en: '' },
    })
  })

  it('upper-cases an IBAN in ASCII only (a "ß" must not become "SS" and pass for another text)', () => {
    expect(normalizeIban('ab12ß')).toBe('AB12ß')
    expect(normalizeIban('IT60\u0085X')).toBe('IT60X')
  })

  it('compares after normalisation, field by field', () => {
    expect(sameFieldValue('iban', 'ch93 0076 2011 6238 5295 7', 'CH9300762011623852957')).toBe(true)
    expect(sameFieldValue('address.it', ['a', '', 'b'], ['a', 'b'])).toBe(true)
    expect(sameFieldValue('address.it', ['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameFieldValue('legalName', 'a ', 'a')).toBe(true)
    expect(sameFieldValue('legalName', 'A', 'a')).toBe(false)
  })

  it('lists changed fields in API order; none when only blanks differ (a no-op save, AC-2.1)', () => {
    const other = detailsOf(DETAILS)
    other.address.en = ['Via Cantonale 1', '', '6900 Lugano']
    other.iban = ' ch93 0076 2011 6238 5295 7'
    expect(changedFieldsBetween(DETAILS, other)).toEqual([])
    other.vatNumber = 'x'
    other.legalName = 'y'
    other.contacts.en = 'z'
    expect(changedFieldsBetween(DETAILS, other)).toEqual(['legalName', 'vatNumber', 'contacts.en'])
  })

  it('reads and writes each of the seven values; a write returns a copy', () => {
    for (const field of LEGAL_ENTITY_FIELDS) {
      const value = getFieldValue(DETAILS, field)
      const probe = Array.isArray(value) ? ['probe'] : 'probe'
      const next = setFieldValue(DETAILS, field, probe)
      expect(getFieldValue(next, field)).toEqual(probe)
      expect(changedFieldsBetween(DETAILS, next)).toEqual([field])
    }
    const next = setFieldValue(DETAILS, 'address.it', ['x'])
    next.address.en.push('mutated')
    expect(DETAILS.address.en).toHaveLength(2)
  })

  it('refuses the wrong kind of value for a field', () => {
    expect(() => setFieldValue(DETAILS, 'address.it', 'text')).toThrow(TypeError)
    expect(() => setFieldValue(DETAILS, 'legalName', ['a'])).toThrow(TypeError)
  })

  it('detailsOf and emptyDetails give fresh objects', () => {
    const copy = detailsOf(DETAILS)
    copy.address.it.push('x')
    expect(DETAILS.address.it).toHaveLength(2)
    expect(emptyDetails()).not.toBe(emptyDetails())
    expect(normalizeDetails(emptyDetails())).toEqual(emptyDetails())
  })

  it('counts code points', () => {
    expect(codePointLength('😀😀')).toBe(2)
    expect(codePointLength('abc')).toBe(3)
    expect(codePointLength('')).toBe(0)
  })
})
