/**
 * LegalEntityFormModel (T37): the inputs of an address, what a save sends, the control each refused or moved value
 * lands on, and what a change of a control takes away. Pure.
 */
import { describe, expect, it } from 'vitest'
import {
  addressInputCount,
  controlDomId,
  formBase,
  groupIban,
  inputCountsOf,
  lineKey,
  movedMarks,
  padLines,
  problemControl,
  problemsAfterEdit,
  refusalErrors,
  refusalItems,
  saveBlockedReason,
  submissionOf,
} from './LegalEntityFormModel'
import { entityFixture } from '../pages/LegalEntitiesPage.fixtures'
import { detailsOf } from '../lib/legalEntityModel'
import type { LegalEntityProblem } from '../lib/legalEntityModel'

const counts = { it: 4, en: 4 }

describe('the address inputs (Q2=B)', () => {
  it('shows four inputs, or one per stored line for a moved address of more than four (D3)', () => {
    expect(addressInputCount([])).toBe(4)
    expect(addressInputCount(['a', 'b', 'c', 'd'])).toBe(4)
    expect(addressInputCount(['a', 'b', 'c', 'd', 'e'])).toBe(5)
    expect(addressInputCount(Array.from({ length: 9 }, () => 'x'))).toBe(9)
  })

  it('pads the lines to the inputs and never cuts a line', () => {
    expect(padLines(['a'], 4)).toEqual(['a', '', '', ''])
    expect(padLines(['a', 'b', 'c'], 2)).toEqual(['a', 'b', 'c'])
  })

  it('sends every input in order, blanks included, and does not touch what it was given', () => {
    const details = { ...detailsOf(entityFixture('welld_it')), address: { it: ['a', '', 'c'], en: ['x'] } }
    const sent = submissionOf(details)
    expect(sent.address).toEqual({ it: ['a', '', 'c', ''], en: ['x', '', '', ''] })
    expect(details.address.it).toEqual(['a', '', 'c'])
  })

  it('sends a moved address of five lines as five', () => {
    const lines = ['a', 'b', 'c', 'd', 'e']
    expect(
      submissionOf({ ...detailsOf(entityFixture('welld_it')), address: { it: lines, en: [] } }).address.it,
    ).toEqual(lines)
  })
})

describe('the IBAN (AC-1.4)', () => {
  it('opens in groups of four, as the read printed it, and groups what was typed, in upper case', () => {
    expect(formBase(entityFixture('welld_it')).iban).toBe('IT60 X054 2811 1010 0000 0123 456')
    expect(formBase(entityFixture('welld_it', { iban: '', ibanPrint: '' })).iban).toBe('')
    expect(groupIban(' ch93 0076 2011 6238 5295 7 ')).toBe('CH93 0076 2011 6238 5295 7')
    expect(groupIban('CH9300762011623852957')).toBe('CH93 0076 2011 6238 5295 7')
    expect(groupIban('')).toBe('')
  })
})

describe('where a refused value lands (design S2)', () => {
  it('lands a per-line problem on its input, `required` on Line 1 and `too_many_lines` on Line 5', () => {
    expect(problemControl({ field: 'address.it', line: 2, reason: 'too_long', limit: 120 }, counts)).toBe(
      'address.it.2',
    )
    expect(problemControl({ field: 'address.en', reason: 'required' }, counts)).toBe('address.en.0')
    expect(problemControl({ field: 'address.it', reason: 'too_many_lines', limit: 4 }, { it: 6, en: 4 })).toBe(
      'address.it.4',
    )
    expect(problemControl({ field: 'vatNumber', reason: 'required' }, counts)).toBe('vatNumber')
  })

  it('never lands on an input that does not exist', () => {
    expect(problemControl({ field: 'address.it', line: 9, reason: 'line_break' }, counts)).toBe('address.it.3')
  })

  it('gives each control its sentences, once, counted from what was submitted', () => {
    const submitted = submissionOf({
      ...detailsOf(entityFixture('welld_ch')),
      address: { it: ['Via 1', 'x'.repeat(143)], en: [] },
    })
    const problems: LegalEntityProblem[] = [
      { field: 'address.it', line: 1, reason: 'too_long', limit: 120 },
      { field: 'address.en', reason: 'required' },
      { field: 'address.it', line: 1, reason: 'too_long', limit: 120 },
    ]
    const errors = refusalErrors(problems, submitted)
    expect(errors.get('address.it.1')).toEqual(['Too long: at most 120 characters, you have 143.'])
    expect(errors.get('address.en.0')).toEqual(['Enter the address.'])
  })

  it('keeps two different problems of one line, both', () => {
    const submitted = submissionOf({ ...detailsOf(entityFixture('welld_ch')), address: { it: ['a\tb'], en: ['x'] } })
    const errors = refusalErrors(
      [
        { field: 'address.it', line: 0, reason: 'control_character' },
        { field: 'address.it', line: 0, reason: 'line_break' },
      ],
      submitted,
    )
    expect(errors.get('address.it.0')).toHaveLength(2)
  })

  it('lists the summary in page order with the control ids and the line named', () => {
    const submitted = submissionOf({
      ...detailsOf(entityFixture('welld_ch')),
      vatNumber: '',
      address: { it: ['Via 1', 'x'.repeat(143)], en: [] },
    })
    const items = refusalItems(
      'welld_ch',
      [
        { field: 'iban', reason: 'iban_check_digits' },
        { field: 'address.en', reason: 'required' },
        { field: 'vatNumber', reason: 'required' },
        { field: 'address.it', line: 1, reason: 'too_long', limit: 120 },
      ],
      submitted,
    )
    expect(items.map((item) => item.id)).toEqual([
      'admin-legal-welld_ch-vatNumber',
      'admin-legal-welld_ch-iban',
      'admin-legal-welld_ch-address-it-1',
      'admin-legal-welld_ch-address-en-0',
    ])
    expect(items[0]?.text).toBe('VAT number: Enter the VAT number.')
    expect(items[2]?.text).toBe('Line 2 of the Italian address: Too long: at most 120 characters, you have 143.')
    expect(items[3]?.text).toBe('Line 1 of the English address: Enter the address.')
  })

  it('names a control with an id the DOM can use', () => {
    expect(controlDomId('welld_it', lineKey('en', 2))).toBe('admin-legal-welld_it-address-en-2')
    expect(controlDomId('welld_it', 'contacts.it')).toBe('admin-legal-welld_it-contacts-it')
  })
})

describe('what a change takes away', () => {
  const problems: LegalEntityProblem[] = [
    { field: 'vatNumber', reason: 'required' },
    { field: 'address.it', line: 1, reason: 'too_long', limit: 120 },
    { field: 'address.it', reason: 'required' },
    { field: 'address.en', reason: 'required' },
  ]

  it('drops the changed control’s own problems and keeps the others', () => {
    expect(problemsAfterEdit(problems, 'vatNumber', counts)).toHaveLength(3)
    // Line 2 of the Italian address: its own too_long goes, and so does the address's `required` (see below).
    expect(problemsAfterEdit(problems, 'address.it.1', counts).map((p) => p.field)).toEqual(['vatNumber', 'address.en'])
  })

  it('drops an address’s `required` when any of its lines changed (any non-blank line satisfies it)', () => {
    const left = problemsAfterEdit(problems, 'address.it.2', counts)
    expect(left.some((p) => p.field === 'address.it' && p.reason === 'required')).toBe(false)
    expect(left.some((p) => p.field === 'address.it' && p.reason === 'too_long')).toBe(true)
    expect(left.some((p) => p.field === 'address.en' && p.reason === 'required')).toBe(true)
  })
})

describe('values kept as moved (S3, F11)', () => {
  const moved = entityFixture('welld_it', {
    version: 1,
    vatNumber: '',
    complete: false,
    missing: ['vatNumber'],
    address: { it: ['Via 1', 'x'.repeat(121), 'c', 'd', 'Svizzera'], en: ['Via 1'] },
    iban: 'IT60X0542811101000000123457',
    ibanPrint: 'IT60 X054 2811 1010 0000 0123 457',
    invalid: [
      { field: 'address.it', reason: 'too_many_lines', limit: 4 },
      { field: 'address.it', line: 1, reason: 'too_long', limit: 120 },
      { field: 'iban', reason: 'iban_check_digits' },
    ],
  })

  it('marks what is missing, what is too long on its own line, the fifth line and the IBAN, each on its control', () => {
    const marks = movedMarks(moved, formBase(moved))
    expect(marks.get('vatNumber')).toEqual(['Not filled in. Enter the VAT number.'])
    expect(marks.get('address.it.1')).toEqual([
      'Too long: at most 120 characters, you have 121. (Kept as moved from the CRM.)',
    ])
    expect(marks.get('address.it.4')).toEqual([
      'Too many lines: at most 4. Join it to a line above or remove it. (Kept as moved from the CRM.)',
    ])
    expect(marks.get('iban')).toEqual([
      'The check digits do not match. Check it for a typing mistake. (Kept as moved from the CRM.)',
    ])
    expect(marks.has('address.it.0')).toBe(false)
    expect(marks.has('address.it.3')).toBe(false)
  })

  it('holds a mark only while the control holds what was moved', () => {
    const typed = {
      ...formBase(moved),
      vatNumber: 'IT 1',
      iban: 'IT60 X054 2811 1010 0000 0123 456',
      address: { it: ['Via 1', 'ok', 'c', 'd', ''], en: ['Via 1'] },
    }
    const marks = movedMarks(moved, typed)
    expect(marks.size).toBe(0)
  })

  it('keeps the IBAN mark when only spaces or case differ (the same value once normalised)', () => {
    const marks = movedMarks(moved, { ...formBase(moved), iban: 'it60x0542811101000000123457' })
    expect(marks.has('iban')).toBe(true)
  })

  it('marks a missing address on Line 1 until any line has text', () => {
    const none = entityFixture('welld_ch', {
      version: 1,
      address: { it: [], en: ['Via 1'] },
      complete: false,
      missing: ['address.it'],
    })
    expect(movedMarks(none, formBase(none)).get('address.it.0')).toEqual(['Not filled in. Enter the address.'])
    expect(movedMarks(none, { ...formBase(none), address: { it: ['', 'x'], en: ['Via 1'] } }).size).toBe(0)
  })

  it('counts five inputs for a five-line address', () => {
    expect(inputCountsOf(formBase(moved))).toEqual({ it: 5, en: 4 })
  })
})

describe('save', () => {
  it('says why it does nothing, newer version first', () => {
    expect(saveBlockedReason(true, false)).toBeNull()
    expect(saveBlockedReason(false, false)).toBe('There is nothing to save.')
    expect(saveBlockedReason(true, true)).toBe('A newer version exists. Choose how to continue.')
  })
})
