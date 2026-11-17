/**
 * The pure mappings from the registry's answers to badge, word, sentence and input (T34, specs/20261117-legal-entities;
 * AC-1.2, AC-1.3, AC-7.3). Both catalogs are exercised: a sentence that exists only in English is a defect (AC-8.2).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, it as itCatalog } from '../strings'
import { LEGAL_ENTITY_FIELDS } from './legalEntityModel'
import type { LegalEntity, LegalEntityDetails, LegalEntityProblem } from './legalEntityModel'
import {
  addressProblemTarget,
  legalEntityStatus,
  notFilledSentence,
  problemSentence,
  problemSummary,
  problemsInPageOrder,
  valueName,
  valueNameList,
} from './legalEntityMappings'

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../specs/20261117-legal-entities/fixtures/legal-entities.json', import.meta.url)),
    'utf8',
  ),
) as { items: LegalEntity[] }
const [FIXTURE_IT, FIXTURE_CH] = fixture.items as [LegalEntity, LegalEntity]

const EN = en.legalEntities
const IT = itCatalog.legalEntities

const details = (patch: Partial<LegalEntityDetails> = {}): LegalEntityDetails => ({
  legalName: 'wellD SA',
  address: { it: ['Via Cantonale 1'], en: ['Via Cantonale 1'] },
  vatNumber: 'CHE-123.456.789 IVA',
  iban: '',
  contacts: { it: '', en: '' },
  ...patch,
})

const problem = (p: LegalEntityProblem): LegalEntityProblem => p

describe('legalEntityStatus (design S1, plan E13)', () => {
  it('Complete: moved, complete, nothing to correct (fixture welld_ch)', () => {
    expect(legalEntityStatus(FIXTURE_CH, EN)).toEqual({
      kind: 'complete',
      label: 'Complete',
      tone: 'success',
      icon: 'check-circle',
    })
  })

  it('Needs correction: complete but a value today’s rules refuse (fixture welld_it: 5 lines, 121 characters, IBAN)', () => {
    expect(FIXTURE_IT.complete).toBe(true)
    expect(FIXTURE_IT.invalid.length).toBeGreaterThan(0)
    expect(legalEntityStatus(FIXTURE_IT, EN)).toEqual({
      kind: 'needsCorrection',
      label: 'Needs correction',
      tone: 'warning',
      icon: 'alert',
    })
  })

  it('Incomplete: a required value is missing', () => {
    expect(legalEntityStatus({ version: 1, complete: false, invalid: [] }, EN)).toEqual({
      kind: 'incomplete',
      label: 'Incomplete',
      tone: 'warning',
      icon: 'alert',
    })
  })

  it('Incomplete wins over Needs correction when the entity is both (offers are refused, AC-6.3)', () => {
    const both = { version: 1, complete: false, invalid: [problem({ field: 'iban', reason: 'iban_format' })] }
    expect(legalEntityStatus(both, EN).kind).toBe('incomplete')
  })

  it('Not moved yet: version 0, never "Incomplete" although its empty values are not complete', () => {
    expect(legalEntityStatus({ version: 0, complete: false, invalid: [] }, EN)).toEqual({
      kind: 'notMoved',
      label: 'Not moved yet',
      tone: 'muted',
      icon: 'clock',
    })
  })

  it('trusts the answer’s own `complete` (plan decision 10): no recomputation from `missing`', () => {
    expect(legalEntityStatus({ version: 2, complete: true, invalid: [] }, EN).kind).toBe('complete')
  })

  it('labels come from the catalog, in Italian too', () => {
    expect(legalEntityStatus(FIXTURE_CH, IT).label).toBe('Completa')
    expect(legalEntityStatus(FIXTURE_IT, IT).label).toBe('Da correggere')
    expect(legalEntityStatus({ version: 1, complete: false, invalid: [] }, IT).label).toBe('Incompleta')
    expect(legalEntityStatus({ version: 0, complete: false, invalid: [] }, IT).label).toBe('Non ancora portata')
  })
})

describe('valueName', () => {
  it('has a word for each of the seven values, in both languages', () => {
    expect(LEGAL_ENTITY_FIELDS.map((f) => valueName(f, EN))).toEqual([
      'Legal name',
      'Address (Italian)',
      'Address (English)',
      'VAT number',
      'IBAN',
      'Contacts line (Italian)',
      'Contacts line (English)',
    ])
    expect(LEGAL_ENTITY_FIELDS.map((f) => valueName(f, IT))).toEqual([
      'Ragione sociale',
      'Indirizzo (italiano)',
      'Indirizzo (inglese)',
      'Partita IVA',
      'IBAN',
      'Riga contatti (italiano)',
      'Riga contatti (inglese)',
    ])
  })

  it('shows a value this build does not know as received', () => {
    expect(valueName('swift' as never, EN)).toBe('swift')
  })

  it('lists names in the order given', () => {
    expect(valueNameList(['vatNumber', 'address.it'], EN)).toBe('VAT number, Address (Italian)')
    expect(valueNameList([], EN)).toBe('')
  })
})

describe('addressProblemTarget (design S2 table; plan E5)', () => {
  it.each([
    ['too_long', 3, 3],
    ['line_break', 0, 0],
    ['control_character', 2, 2],
  ] as const)('%s on line %s lands on the input at that position (0-based)', (reason, line, expected) => {
    expect(addressProblemTarget({ field: 'address.it', line, reason })).toEqual({ language: 'it', line: expected })
    expect(addressProblemTarget({ field: 'address.en', line, reason })).toEqual({ language: 'en', line: expected })
  })

  it('`required` (no line) lands on Line 1 of that language', () => {
    expect(addressProblemTarget({ field: 'address.it', reason: 'required' })).toEqual({ language: 'it', line: 0 })
    expect(addressProblemTarget({ field: 'address.en', reason: 'required' })).toEqual({ language: 'en', line: 0 })
  })

  it('`too_many_lines` (no line) lands on Line 5, the first input beyond the fourth', () => {
    expect(addressProblemTarget({ field: 'address.it', reason: 'too_many_lines', limit: 4 })).toEqual({
      language: 'it',
      line: 4,
    })
    expect(addressProblemTarget({ field: 'address.en', reason: 'too_many_lines', limit: 4 })).toEqual({
      language: 'en',
      line: 4,
    })
  })

  it('any other address reason without a line lands on Line 1', () => {
    expect(addressProblemTarget({ field: 'address.en', reason: 'control_character' })).toEqual({
      language: 'en',
      line: 0,
    })
    expect(addressProblemTarget({ field: 'address.it', reason: 'too_long', limit: 120 })).toEqual({
      language: 'it',
      line: 0,
    })
  })

  it('never lands on a line that is not a position (negative, fractional, not a number)', () => {
    for (const line of [-1, 1.5, Number.NaN, '2' as unknown as number]) {
      expect(addressProblemTarget({ field: 'address.it', reason: 'line_break', line })).toEqual({
        language: 'it',
        line: 0,
      })
    }
  })

  it('a `line` on `required` or `too_many_lines` does not move them (those are not per-line reasons)', () => {
    expect(addressProblemTarget({ field: 'address.it', reason: 'required', line: 3 })?.line).toBe(0)
    expect(addressProblemTarget({ field: 'address.it', reason: 'too_many_lines', line: 1 })?.line).toBe(4)
  })

  it('is null for a value that is not an address', () => {
    expect(addressProblemTarget({ field: 'legalName', reason: 'required' })).toBeNull()
    expect(addressProblemTarget({ field: 'iban', reason: 'iban_check_digits' })).toBeNull()
    expect(addressProblemTarget({ field: 'contacts.it', reason: 'too_long', limit: 200 })).toBeNull()
  })

  it('maps every problem of the shared fixture to an input of its own language (E6: stored line = shown line)', () => {
    const targets = FIXTURE_IT.invalid.map((p) => addressProblemTarget(p))
    expect(targets).toEqual([{ language: 'it', line: 2 }, { language: 'it', line: 4 }, null])
  })
})

describe('problemSentence (design S2: by reason, never by the server’s wording)', () => {
  const ctx = (values: LegalEntityDetails, moved = false) => ({ values, moved })

  it('required: names the value; an address by its group, lower-cased unless an acronym', () => {
    const v = details()
    expect(problemSentence({ field: 'legalName', reason: 'required' }, ctx(v), EN)).toBe('Enter the legal name.')
    expect(problemSentence({ field: 'vatNumber', reason: 'required' }, ctx(v), EN)).toBe('Enter the VAT number.')
    expect(problemSentence({ field: 'address.en', reason: 'required' }, ctx(v), EN)).toBe('Enter the address.')
    expect(problemSentence({ field: 'legalName', reason: 'required' }, ctx(v), IT)).toBe('Inserisci ragione sociale.')
    expect(problemSentence({ field: 'vatNumber', reason: 'required' }, ctx(v), IT)).toBe('Inserisci partita IVA.')
    expect(problemSentence({ field: 'address.it', reason: 'required' }, ctx(v), IT)).toBe('Inserisci indirizzo.')
  })

  it('too_long: the limit from the answer, the count from the value', () => {
    const v = details({ legalName: 'x'.repeat(201) })
    expect(problemSentence({ field: 'legalName', reason: 'too_long', limit: 200 }, ctx(v), EN)).toBe(
      'Too long: at most 200 characters, you have 201.',
    )
    expect(problemSentence({ field: 'legalName', reason: 'too_long', limit: 200 }, ctx(v), IT)).toBe(
      'Troppo lungo: al massimo 200 caratteri, ne hai 201.',
    )
  })

  it('too_long: counts code points after NFC and trim, like the server (an emoji is 1; "e" + accent is 1)', () => {
    const emoji = details({ vatNumber: `  ${'😀'.repeat(41)}  ` })
    expect(problemSentence({ field: 'vatNumber', reason: 'too_long', limit: 40 }, ctx(emoji), EN)).toBe(
      'Too long: at most 40 characters, you have 41.',
    )
    const decomposed = details({ contacts: { it: 'é'.repeat(201), en: '' } })
    expect(problemSentence({ field: 'contacts.it', reason: 'too_long', limit: 200 }, ctx(decomposed), EN)).toBe(
      'Too long: at most 200 characters, you have 201.',
    )
  })

  it('too_long on an address line counts that line only (E5: the position in the submitted array)', () => {
    const v = details({ address: { it: ['short', '', 'y'.repeat(130)], en: ['z'.repeat(500)] } })
    expect(problemSentence({ field: 'address.it', line: 2, reason: 'too_long', limit: 120 }, ctx(v), EN)).toBe(
      'Too long: at most 120 characters, you have 130.',
    )
    expect(problemSentence({ field: 'address.en', line: 0, reason: 'too_long', limit: 120 }, ctx(v), EN)).toBe(
      'Too long: at most 120 characters, you have 500.',
    )
  })

  it('too_long on an IBAN counts it without spaces', () => {
    const v = details({ iban: `IT60 ${'X'.repeat(30)} 1234` })
    expect(problemSentence({ field: 'iban', reason: 'too_long', limit: 34 }, ctx(v), EN)).toBe(
      'Too long: at most 34 characters, you have 38.',
    )
  })

  it('too_long without a limit in the answer falls back to the documented limit of that value', () => {
    expect(
      problemSentence({ field: 'vatNumber', reason: 'too_long' }, ctx(details({ vatNumber: 'v'.repeat(41) })), EN),
    ).toBe('Too long: at most 40 characters, you have 41.')
    expect(
      problemSentence(
        { field: 'address.it', line: 0, reason: 'too_long' },
        ctx(details({ address: { it: ['a'.repeat(121)], en: [] } })),
        EN,
      ),
    ).toBe('Too long: at most 120 characters, you have 121.')
  })

  it('too_many_lines: counts the non-blank lines of that language; a moved address gets the "kept as moved" wording', () => {
    const v = details({ address: { it: ['1', '2', '', '3', '4', '5'], en: ['1'] } })
    const p = { field: 'address.it', reason: 'too_many_lines', limit: 4 } as const
    expect(problemSentence(p, ctx(v), EN)).toBe('Too many lines: at most 4, you have 5.')
    expect(problemSentence(p, ctx(v), IT)).toBe('Troppe righe: al massimo 4, ne hai 5.')
    expect(problemSentence(p, ctx(v, true), EN)).toBe(EN.problem.moved(EN.problem.tooManyLinesMoved))
    expect(problemSentence(p, ctx(v, true), IT)).toBe(IT.problem.moved(IT.problem.tooManyLinesMoved))
    expect(problemSentence(p, ctx(v, true), EN)).toBe(
      'Too many lines: at most 4. Join it to a line above or remove it. (Kept as moved from the CRM.)',
    )
    expect(problemSentence(p, ctx(v, true), IT)).toBe(
      'Troppe righe: al massimo 4. Uniscila a una riga sopra o eliminala. (Valore mantenuto com’era nel CRM.)',
    )
  })

  it('a value kept as moved ends "(Kept as moved from the CRM.)" for every reason, a refused save never does (FU-7)', () => {
    const v = details()
    const reasons = [
      { field: 'legalName', reason: 'too_long', limit: 200 },
      { field: 'legalName', reason: 'line_break' },
      { field: 'address.it', line: 1, reason: 'control_character' },
      { field: 'iban', reason: 'iban_format' },
      { field: 'iban', reason: 'iban_check_digits' },
    ] as const
    for (const p of reasons) {
      for (const catalog of [EN, IT]) {
        const plain = problemSentence(p, ctx(v), catalog)
        expect(problemSentence(p, ctx(v, true), catalog)).toBe(catalog.problem.moved(plain))
        expect(plain).not.toContain(catalog === EN ? 'Kept as moved' : 'mantenuto')
      }
    }
    expect(problemSentence({ field: 'iban', reason: 'iban_check_digits' }, ctx(v, true), EN)).toBe(
      'The check digits do not match. Check it for a typing mistake. (Kept as moved from the CRM.)',
    )
  })

  it('notFilledSentence: "Not filled in. Enter the {value}." in both languages, an address by its group', () => {
    expect(notFilledSentence('vatNumber', EN)).toBe('Not filled in. Enter the VAT number.')
    expect(notFilledSentence('legalName', EN)).toBe('Not filled in. Enter the legal name.')
    expect(notFilledSentence('address.it', EN)).toBe('Not filled in. Enter the address.')
    expect(notFilledSentence('vatNumber', IT)).toBe('Non compilato. Inserisci partita IVA.')
  })

  it('line_break, control_character, iban_format, iban_check_digits: the fixed sentences, both languages', () => {
    const v = details()
    const cases = [
      [{ field: 'legalName', reason: 'line_break' }, EN.problem.lineBreak, IT.problem.lineBreak],
      [{ field: 'address.it', line: 1, reason: 'control_character' }, EN.problem.controlChar, IT.problem.controlChar],
      [{ field: 'iban', reason: 'iban_format' }, EN.problem.ibanFormat, IT.problem.ibanFormat],
      [{ field: 'iban', reason: 'iban_check_digits' }, EN.problem.ibanCheck, IT.problem.ibanCheck],
    ] as const
    for (const [p, english, italian] of cases) {
      expect(problemSentence(p, ctx(v), EN)).toBe(english)
      expect(problemSentence(p, ctx(v), IT)).toBe(italian)
      expect(english).not.toBe(italian)
    }
    expect(EN.problem.ibanCheck).toBe('The check digits do not match. Check it for a typing mistake.')
  })

  it('never repeats the server’s prose: only `reason` (and the limit) decide the sentence', () => {
    const v = details()
    const withProse = { field: 'iban', reason: 'iban_format', detail: 'IBAN "XX" is bad' } as LegalEntityProblem
    expect(problemSentence(withProse, ctx(v), EN)).toBe(EN.problem.ibanFormat)
  })

  it('a reason this build does not know is shown as received (the parser refuses such an answer first)', () => {
    expect(problemSentence({ field: 'iban', reason: 'brand_new' as never }, ctx(details()), EN)).toBe('brand_new')
  })

  it('reads the shared fixture: moved too_long on Line 3 shows its real count; the moved 5-line address its own wording', () => {
    const [tooLong, tooMany, ibanCheck] = FIXTURE_IT.invalid as [
      LegalEntityProblem,
      LegalEntityProblem,
      LegalEntityProblem,
    ]
    const realLength = Array.from(FIXTURE_IT.address.it[2] as string).length
    expect(realLength).toBeGreaterThan(120)
    expect(problemSentence(tooLong, ctx(FIXTURE_IT, true), EN)).toBe(
      EN.problem.moved(`Too long: at most 120 characters, you have ${realLength}.`),
    )
    expect(problemSentence(tooMany, ctx(FIXTURE_IT, true), EN)).toBe(EN.problem.moved(EN.problem.tooManyLinesMoved))
    expect(problemSentence(ibanCheck, ctx(FIXTURE_IT, true), EN)).toBe(EN.problem.moved(EN.problem.ibanCheck))
  })
})

describe('problemSummary (the error summary button, design S2)', () => {
  const ctx = (values: LegalEntityDetails) => ({ values })

  it('an address problem names the line and the language, then the sentence', () => {
    const v = details({ address: { it: ['ok', 'ok', 'a\u0009b'], en: [] } })
    expect(problemSummary({ field: 'address.it', line: 2, reason: 'control_character' }, ctx(v), EN)).toBe(
      `Line 3 of the Italian address: ${EN.problem.controlChar}`,
    )
    expect(problemSummary({ field: 'address.it', line: 2, reason: 'control_character' }, ctx(v), IT)).toBe(
      `Riga 3 dell’indirizzo italiano: ${IT.problem.controlChar}`,
    )
  })

  it('a missing address is "Line 1 of the … address: Enter the address."', () => {
    expect(problemSummary({ field: 'address.en', reason: 'required' }, ctx(details()), EN)).toBe(
      'Line 1 of the English address: Enter the address.',
    )
  })

  it('too many lines is "Line 5 of the … address" with the count', () => {
    const v = details({ address: { it: ['1', '2', '3', '4', '5'], en: [] } })
    expect(problemSummary({ field: 'address.it', reason: 'too_many_lines', limit: 4 }, ctx(v), EN)).toBe(
      'Line 5 of the Italian address: Too many lines: at most 4, you have 5.',
    )
  })

  it('any other value is "{Value}: {sentence}"', () => {
    expect(problemSummary({ field: 'vatNumber', reason: 'required' }, ctx(details()), EN)).toBe(
      'VAT number: Enter the VAT number.',
    )
    expect(problemSummary({ field: 'iban', reason: 'iban_check_digits' }, ctx(details()), IT)).toBe(
      `IBAN: ${IT.problem.ibanCheck}`,
    )
  })
})

describe('problemsInPageOrder (focus goes to the first refused control in page order)', () => {
  it('orders Company, then Italian lines, then English lines, then Contacts; stable inside one position', () => {
    const shuffled: LegalEntityProblem[] = [
      { field: 'contacts.en', reason: 'line_break' },
      { field: 'address.en', line: 0, reason: 'too_long', limit: 120 },
      { field: 'address.it', line: 2, reason: 'too_long', limit: 120 },
      { field: 'iban', reason: 'iban_format' },
      { field: 'address.it', line: 2, reason: 'line_break' },
      { field: 'address.it', line: 0, reason: 'control_character' },
      { field: 'vatNumber', reason: 'required' },
      { field: 'legalName', reason: 'required' },
      { field: 'contacts.it', reason: 'too_long', limit: 200 },
      { field: 'address.it', reason: 'too_many_lines', limit: 4 },
    ]
    const ordered = problemsInPageOrder(shuffled)
    expect(ordered.map((p) => `${p.field}${p.line === undefined ? '' : `:${p.line}`}:${p.reason}`)).toEqual([
      'legalName:required',
      'vatNumber:required',
      'iban:iban_format',
      'address.it:0:control_character',
      'address.it:2:too_long',
      'address.it:2:line_break',
      'address.it:too_many_lines',
      'address.en:0:too_long',
      'contacts.it:too_long',
      'contacts.en:line_break',
    ])
  })

  it('does not mutate its argument', () => {
    const input: LegalEntityProblem[] = [
      { field: 'contacts.it', reason: 'line_break' },
      { field: 'legalName', reason: 'required' },
    ]
    problemsInPageOrder(input)
    expect(input.map((p) => p.field)).toEqual(['contacts.it', 'legalName'])
  })
})
