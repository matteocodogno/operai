import { describe, expect, it } from 'vitest'
import { appendPage, blockingFields, latestVersion, newestFirst, refusedFields, restoreChanges, sharedWords } from './LegalEntityHistoryModel'
import { emptyDetails, setFieldValue } from '../lib/legalEntityModel'
import type { VersionListItem } from '../lib/legalEntityModel'
import { strings } from '../strings'
import { it as italian } from '../strings/legalEntities'

const item = (version: number): VersionListItem => ({
  version,
  action: 'save',
  restoredFrom: null,
  createdBy: null,
  createdAt: '2026-11-14T10:12:00.000Z',
  changedFields: [],
  restorable: true,
})

describe('the versions', () => {
  it('are newest first whatever the order, without touching the list', () => {
    const list = [item(1), item(3), item(2)]
    expect(newestFirst(list).map((v) => v.version)).toEqual([3, 2, 1])
    expect(list.map((v) => v.version)).toEqual([1, 3, 2])
  })

  it('have the highest as the one in effect, and none for an empty list', () => {
    expect(latestVersion([item(1), item(4), item(2)])).toBe(4)
    expect(latestVersion([])).toBeUndefined()
  })
})

describe('appending a page', () => {
  it('keeps what is shown, adds the new versions once each, and reports them in the order they came', () => {
    const shown = [item(5), item(4)]
    const next = appendPage(shown, [item(4), item(3), item(3), item(2)])
    expect(next.items.map((v) => v.version)).toEqual([5, 4, 3, 2])
    expect(next.added.map((v) => v.version)).toEqual([3, 2])
    expect(shown.map((v) => v.version)).toEqual([5, 4])
  })

  it('adds nothing for a page of versions already shown', () => {
    expect(appendPage([item(2), item(1)], [item(1)]).added).toEqual([])
  })
})

describe('what blocks a restore', () => {
  it('is what is missing and what is invalid, once each, in page order', () => {
    expect(
      blockingFields({
        complete: false,
        missing: ['address.en', 'legalName'],
        invalid: [
          { field: 'iban', reason: 'iban_check_digits' },
          { field: 'iban', reason: 'iban_format' },
        ],
      }),
    ).toEqual(['legalName', 'iban', 'address.en'])
  })

  it('is only what is invalid for a complete version, and nothing for a clean one', () => {
    expect(
      blockingFields({ complete: true, missing: [], invalid: [{ field: 'address.it', reason: 'too_many_lines' }] }),
    ).toEqual(['address.it'])
    expect(blockingFields({ complete: true, missing: [], invalid: [] })).toEqual([])
  })

  it('names the fields of a refusal in page order', () => {
    expect(
      refusedFields([
        { field: 'contacts.en', reason: 'too_long' },
        { field: 'vatNumber', reason: 'required' },
        { field: 'vatNumber', reason: 'too_long' },
      ]),
    ).toEqual(['vatNumber', 'contacts.en'])
  })
})

describe('what a restore changes', () => {
  it('is the values that differ once normalised, in page order', () => {
    const current = setFieldValue(setFieldValue(emptyDetails(), 'iban', 'CH93 0076 2011 6238 5295 7'), 'legalName', 'A')
    const target = setFieldValue(
      setFieldValue(setFieldValue(emptyDetails(), 'iban', 'ch9300762011623852957'), 'legalName', 'B'),
      'contacts.it',
      'Tel',
    )
    // The IBAN is the same value in another spelling: not a change.
    expect(restoreChanges(target, current)).toEqual(['legalName', 'contacts.it'])
    expect(restoreChanges(current, current)).toEqual([])
  })
})

describe('the words of a row button', () => {
  it('are what its name has in common across rows, and always inside the name', () => {
    const t = strings.legalEntities.history
    expect(sharedWords(t.open)).toBe('Open version')
    expect(sharedWords(t.restore)).toBe('Restore version')
    for (const name of [t.open, t.restore]) expect(name(12)).toContain(sharedWords(name))
    expect(sharedWords(italian.history.open)).toBe('Apri la versione')
    expect(sharedWords(italian.history.restore)).toBe('Ripristina la versione')
  })
})

describe('the paging copy', () => {
  const pagingStrings = (lang: typeof italian) => [
    lang.history.more,
    lang.history.loadingMore,
    lang.history.moreFailed,
    lang.history.moreLoaded(1),
    lang.history.moreLoaded(50),
    lang.history.showing(50),
    lang.history.showingAll(130),
  ]

  it('says the designed sentences in English', () => {
    expect(pagingStrings(strings.legalEntities)).toEqual([
      'Show older versions',
      'Loading older versions…',
      'Older versions could not be loaded. The versions above are still shown.',
      '1 older version loaded.',
      '50 older versions loaded.',
      'Showing the 50 newest versions.',
      'Showing all 130 versions.',
    ])
  })

  it('says them in Italian, singular and plural', () => {
    expect(pagingStrings(italian)).toEqual([
      'Mostra le versioni meno recenti',
      'Caricamento delle versioni meno recenti…',
      'Non è stato possibile caricare le versioni meno recenti. Quelle qui sopra restano visibili.',
      '1 versione meno recente caricata.',
      '50 versioni meno recenti caricate.',
      'Sono mostrate le 50 versioni più recenti.',
      'Sono mostrate tutte le 130 versioni.',
    ])
  })
})
