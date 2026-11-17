/**
 * "Reapply my changes" after a version conflict (T34, specs/20261117-legal-entities; AC-2.6, design S2 "Conflict
 * behaviour", owner decision Q3=B): per value over the seven values, an address is one value.
 */
import { describe, expect, it } from 'vitest'
import { detailsOf } from './legalEntityModel'
import type { LegalEntityDetails } from './legalEntityModel'
import { mergeOnConflict, takeTheirs } from './legalEntityMerge'

const BASE: LegalEntityDetails = {
  legalName: 'wellD SA',
  address: {
    it: ['Via Cantonale 1', '6900 Lugano', 'Svizzera'],
    en: ['Via Cantonale 1', '6900 Lugano', 'Switzerland'],
  },
  vatNumber: 'CHE-123.456.789 IVA',
  iban: 'CH9300762011623852957',
  contacts: { it: 'Tel. +41 91 000 00 00', en: 'Phone +41 91 000 00 00' },
}

const change = (patch: Partial<LegalEntityDetails>): LegalEntityDetails => ({ ...detailsOf(BASE), ...patch })

describe('mergeOnConflict', () => {
  it('neither changed: every value is "same" and nothing is flagged', () => {
    const result = mergeOnConflict({ base: BASE, mine: detailsOf(BASE), theirs: detailsOf(BASE) })
    expect(Object.values(result.outcomes).every((o) => o === 'same')).toBe(true)
    expect(result.flagged).toEqual([])
    expect(result.details).toEqual(BASE)
  })

  it('only I changed a value: mine is kept', () => {
    const result = mergeOnConflict({ base: BASE, mine: change({ vatNumber: 'CHE-999' }), theirs: detailsOf(BASE) })
    expect(result.outcomes.vatNumber).toBe('mine')
    expect(result.details.vatNumber).toBe('CHE-999')
    expect(result.flagged).toEqual([])
  })

  it('only they changed a value: theirs is taken (and the form says it came from the newer version)', () => {
    const result = mergeOnConflict({
      base: BASE,
      mine: detailsOf(BASE),
      theirs: change({ legalName: 'wellD Group SA' }),
    })
    expect(result.outcomes.legalName).toBe('theirs')
    expect(result.details.legalName).toBe('wellD Group SA')
    expect(result.flagged).toEqual([])
  })

  it('both changed the same value to different things: mine is kept and theirs is offered', () => {
    const result = mergeOnConflict({
      base: BASE,
      mine: change({ iban: 'CH93 0076 2011 6238 5295 7 ' + 'x' }),
      theirs: change({ iban: 'CH5604835012345678009' }),
    })
    expect(result.outcomes.iban).toBe('flagged')
    expect(result.details.iban).toBe('CH93 0076 2011 6238 5295 7 x')
    expect(result.flagged).toEqual([{ field: 'iban', theirs: 'CH5604835012345678009' }])
  })

  it('both changed it to the same value: nothing to review', () => {
    const result = mergeOnConflict({
      base: BASE,
      mine: change({ vatNumber: 'CHE-555.555.555 IVA' }),
      theirs: change({ vatNumber: ' CHE-555.555.555 IVA ' }),
    })
    expect(result.outcomes.vatNumber).toBe('same')
    expect(result.flagged).toEqual([])
    expect(result.details.vatNumber).toBe(' CHE-555.555.555 IVA ')
  })

  it('values are merged independently: mine here, theirs there, flagged elsewhere', () => {
    const result = mergeOnConflict({
      base: BASE,
      mine: change({ legalName: 'Mine SA', vatNumber: 'MINE-VAT', contacts: { it: 'mio', en: BASE.contacts.en } }),
      theirs: change({
        iban: 'CH5604835012345678009',
        vatNumber: 'THEIR-VAT',
        contacts: { it: 'suo', en: 'their phone' },
      }),
    })
    expect(result.outcomes).toEqual({
      legalName: 'mine',
      'address.it': 'same',
      'address.en': 'same',
      vatNumber: 'flagged',
      iban: 'theirs',
      'contacts.it': 'flagged',
      'contacts.en': 'theirs',
    })
    expect(result.details).toEqual({
      legalName: 'Mine SA',
      address: BASE.address,
      vatNumber: 'MINE-VAT',
      iban: 'CH5604835012345678009',
      contacts: { it: 'mio', en: 'their phone' },
    })
  })

  it('flagged values come in page order (Company, Italian lines, English lines, Contacts), the first takes focus', () => {
    const result = mergeOnConflict({
      base: BASE,
      mine: change({
        legalName: 'm',
        iban: 'CH5604835012345678009',
        address: { it: ['m'], en: BASE.address.en },
        contacts: { it: 'm', en: BASE.contacts.en },
      }),
      theirs: change({
        legalName: 't',
        iban: 'CH9300762011623852957'.replace('CH93', 'CH94'),
        address: { it: ['t'], en: BASE.address.en },
        contacts: { it: 't', en: BASE.contacts.en },
      }),
    })
    expect(result.flagged.map((f) => f.field)).toEqual(['legalName', 'iban', 'address.it', 'contacts.it'])
  })

  describe('an address is one value of up to four lines, never merged line by line', () => {
    it('both changed different lines: the whole address is flagged, mine is kept whole, theirs is the whole', () => {
      const mine = change({ address: { it: ['Via Roma 9', '6900 Lugano', 'Svizzera'], en: BASE.address.en } })
      const theirs = change({
        address: { it: ['Via Cantonale 1', '6901 Lugano', 'Svizzera', 'Ticino'], en: BASE.address.en },
      })
      const result = mergeOnConflict({ base: BASE, mine, theirs })
      expect(result.outcomes['address.it']).toBe('flagged')
      expect(result.details.address.it).toEqual(['Via Roma 9', '6900 Lugano', 'Svizzera'])
      expect(result.flagged).toEqual([
        { field: 'address.it', theirs: ['Via Cantonale 1', '6901 Lugano', 'Svizzera', 'Ticino'] },
      ])
    })

    it('"Use theirs" replaces all of that language’s lines and nothing else', () => {
      const mine = change({ address: { it: ['Via Roma 9'], en: ['Mine EN'] } })
      const theirs = change({ address: { it: ['Via Cantonale 1', '6901 Lugano'], en: BASE.address.en } })
      const result = mergeOnConflict({ base: BASE, mine, theirs })
      const flagged = result.flagged[0]!
      const after = takeTheirs(result.details, flagged)
      expect(after.address.it).toEqual(['Via Cantonale 1', '6901 Lugano'])
      expect(after.address.en).toEqual(['Mine EN'])
      expect(after.legalName).toBe(result.details.legalName)
      expect(result.details.address.it).toEqual(['Via Roma 9']) // the merge result is not mutated
    })

    it('the two languages are two values', () => {
      const result = mergeOnConflict({
        base: BASE,
        mine: change({ address: { it: ['Mine IT'], en: BASE.address.en } }),
        theirs: change({ address: { it: BASE.address.it, en: ['Their EN'] } }),
      })
      expect(result.outcomes['address.it']).toBe('mine')
      expect(result.outcomes['address.en']).toBe('theirs')
      expect(result.details.address).toEqual({ it: ['Mine IT'], en: ['Their EN'] })
    })

    it('mine keeps the lines as typed, blank ones included (the form’s inputs stay where they are)', () => {
      const typed = ['Via Roma 9', '', 'Svizzera', '']
      const result = mergeOnConflict({
        base: BASE,
        mine: change({ address: { it: typed, en: BASE.address.en } }),
        theirs: detailsOf(BASE),
      })
      expect(result.outcomes['address.it']).toBe('mine')
      expect(result.details.address.it).toEqual(typed)
    })
  })

  describe('"changed" means changed after normalisation, as the server judges a no-op (AC-2.1)', () => {
    it('re-spacing, an IBAN typed in lower case with spaces, and a blank extra address line are not changes', () => {
      const mine = change({
        legalName: '  wellD SA ',
        iban: 'ch93 0076 2011 6238 5295 7',
        address: { it: ['Via Cantonale 1', '', '6900 Lugano', 'Svizzera', ''], en: BASE.address.en },
      })
      const theirs = change({ iban: 'CH5604835012345678009' })
      const result = mergeOnConflict({ base: BASE, mine, theirs })
      expect(result.outcomes.iban).toBe('theirs')
      expect(result.outcomes['address.it']).toBe('same')
      expect(result.outcomes.legalName).toBe('same')
      expect(result.details.iban).toBe('CH5604835012345678009')
      expect(result.flagged).toEqual([])
    })

    it('NFC and NFD forms of the same text are the same value', () => {
      const result = mergeOnConflict({
        base: change({ legalName: 'Zürich AG' }),
        mine: change({ legalName: 'Zürich AG' }),
        theirs: change({ legalName: 'Zürich AG' }),
      })
      expect(result.outcomes.legalName).toBe('same')
    })
  })

  it('empties are values too: I cleared the contacts line while they changed it: flagged, mine ("") is kept', () => {
    const result = mergeOnConflict({
      base: BASE,
      mine: change({ contacts: { it: '', en: BASE.contacts.en } }),
      theirs: change({ contacts: { it: 'new', en: BASE.contacts.en } }),
    })
    expect(result.outcomes['contacts.it']).toBe('flagged')
    expect(result.details.contacts.it).toBe('')
    expect(result.flagged).toEqual([{ field: 'contacts.it', theirs: 'new' }])
  })

  it('does not mutate its inputs and shares no array with them', () => {
    const base = detailsOf(BASE)
    const mine = change({ address: { it: ['Mine'], en: BASE.address.en } })
    const theirs = change({ address: { it: ['Theirs'], en: [...BASE.address.en] } })
    const snapshot = JSON.stringify({ base, mine, theirs })
    const result = mergeOnConflict({ base, mine, theirs })
    result.details.address.it.push('x')
    result.details.address.en.push('y')
    result.flagged[0]!.theirs = ['changed']
    expect(JSON.stringify({ base, mine, theirs })).toBe(snapshot)
  })
})
