import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  answerLabelOf,
  answersNulRefused,
  invalidAnswersLine,
  legalDetailsInWords,
  legalEntitiesUnavailableOf,
  legalEntityIncompleteOf,
  letterheadUnusableOf,
  offerFailure,
} from './offerErrors'
import { parseTemplate } from './offerEngine/syntax'
import { strings } from '../strings'

// 409 `letterhead_unusable` (security M-4, plan DD-76, specs/20261115-crm-offer-wizard AC-11.4, design S10, D-41).
const unusable = (extras: Record<string, unknown>, init: { status?: number; code?: string } = {}) =>
  new ApiError({
    status: init.status ?? 409,
    title: 'Conflict',
    code: init.code ?? 'letterhead_unusable',
    detail: 'The stored letterhead can no longer be used.',
    extras,
  })

describe('offerFailure — letterhead_unusable', () => {
  it('names the entity by its badge label and says to upload the letterhead again in CRM Settings', () => {
    expect(offerFailure(unusable({ entity: 'welld_ch', reason: 'decoded_too_large' }))).toBe(
      `The letterhead of ${strings.badges.entity.welld_ch} can no longer be used. Upload it again in CRM Settings.`,
    )
    expect(offerFailure(unusable({ entity: 'welld_it' }))).toContain(strings.badges.entity.welld_it)
  })

  it('keeps the server line when the body names no entity we know (never fills the sentence with a guess)', () => {
    for (const extras of [{}, { entity: 'someone_else' }, { entity: 7 }])
      expect(offerFailure(unusable(extras))).toBe('The stored letterhead can no longer be used.')
  })

  it('never puts the reason or any other extension member in the line', () => {
    const line = offerFailure(unusable({ entity: 'welld_ch', reason: 'unbounded_stream', key: 'letterheads/x.pdf' }))
    expect(line).not.toContain('unbounded_stream')
    expect(line).not.toContain('letterheads/')
  })
})

describe('letterheadUnusableOf', () => {
  it('reads the entity of a 409 with the code', () => {
    expect(letterheadUnusableOf(unusable({ entity: 'welld_ch' }))).toEqual({ entity: 'welld_ch' })
    expect(letterheadUnusableOf(unusable({}))).toEqual({ entity: null })
  })

  it('is null for another status, another code or anything that is not an ApiError', () => {
    expect(letterheadUnusableOf(unusable({ entity: 'welld_ch' }, { status: 422 }))).toBeNull()
    expect(letterheadUnusableOf(unusable({ entity: 'welld_ch' }, { code: 'upload_missing' }))).toBeNull()
    expect(letterheadUnusableOf(Object.assign(new Error('x'), { status: 409, code: 'letterhead_unusable' }))).toBeNull()
    expect(letterheadUnusableOf(null)).toBeNull()
  })
})

// QE F2: a NUL in an answer is a 422 `answers_invalid` whose only mark is the wording of its detail.
describe('a refused character in a wizard answer', () => {
  const { ast } = parseTemplate(`@@salutation Dear

## SCOPE
@@step scope
We deliver [OGGETTO] and [NOTE]. {{list:REFS}}

@@field OGGETTO
label: Object

@@field NOTE

@@list REFS
label: References

@@table PRICES
label: Price list
columns: PRICES, QTY

@@field QTY
label: Quantity
`)
  const refusal = (
    path: string,
    detail = `The answers are not valid at "${path}" (Not text: contains a NUL character)`,
  ) =>
    new ApiError({
      status: 422,
      title: 'Unprocessable',
      code: 'answers_invalid',
      detail,
      extras: { path, reason: 'shape' },
    })

  it('is told from any other answers_invalid by the cause', () => {
    expect(answersNulRefused(refusal('fields.OGGETTO'))).toBe(true)
    expect(
      answersNulRefused(refusal('fields.OGGETTO', 'The answers are not valid at "fields.OGGETTO" (Too long)')),
    ).toBe(false)
  })

  it('names a field, a list, a table cell and the client block by the label a person sees', () => {
    expect(answerLabelOf(ast, 'fields.OGGETTO')).toBe('Object')
    expect(answerLabelOf(ast, 'prefilled.OGGETTO')).toBe('Object')
    expect(answerLabelOf(ast, 'fields.NOTE')).toBe('NOTE')
    expect(answerLabelOf(ast, 'lists.REFS[2]')).toBe('References')
    expect(answerLabelOf(ast, 'tables.PRICES[0].cells.QTY')).toBe('Price list, Quantity')
    expect(answerLabelOf(ast, 'tables.PRICES[1]')).toBe('Price list')
    expect(answerLabelOf(ast, 'client.lines[0]')).toBe(strings.offerWizard.client.lines)
    expect(answerLabelOf(ast, 'client.place')).toBe(strings.offerWizard.client.place)
  })

  it('never invents a name: an unknown or unmapped path has none', () => {
    for (const path of ['fields.GONE', 'costs.extra[0].description', 'handEdits["a"].body', 'nonsense', '', null])
      expect(answerLabelOf(ast, path)).toBeNull()
    expect(answerLabelOf(null, 'fields.OGGETTO')).toBeNull()
  })

  it('reads as one sentence, the label in it or an unnamed one, never the path', () => {
    const t = strings.offerWizard.save
    expect(invalidAnswersLine({ path: 'fields.OGGETTO', nul: true }, ast)).toBe(t.answerNul('Object'))
    expect(invalidAnswersLine({ path: 'fields.GONE', nul: true }, ast)).toBe(t.answerNulUnnamed)
    expect(invalidAnswersLine({ path: 'fields.OGGETTO', nul: false }, ast)).toBe(strings.offers.errors.answersInvalid)
  })
})

describe('offerFailure — the PDF check could not run (503)', () => {
  it.each([
    ['pdf_check_busy', strings.common.pdfCheck.pdf_check_busy],
    ['pdf_check_unavailable', strings.common.pdfCheck.pdf_check_unavailable],
  ])('%s reads as our own sentence, for generate, edit and revise alike', (code, copy) => {
    const error = new ApiError({ status: 503, title: 'Unavailable', code, detail: 'The file could not be checked.' })
    expect(offerFailure(error)).toBe(copy)
  })
})

// 409 `legal_entity_incomplete` and 503 `legal_entities_unavailable` (specs/20261117-legal-entities E4; AC-5.5, AC-6.3, design S10).
describe('offerFailure — the issuer’s legal details (AC-5.5, AC-6.3)', () => {
  const refused = (extras: Record<string, unknown>, status = 409) =>
    new ApiError({ status, title: 'Conflict', code: 'legal_entity_incomplete', detail: 'SERVER DETAIL', extras })
  const unavailable = (status = 503) =>
    new ApiError({ status, title: 'Unavailable', code: 'legal_entities_unavailable', detail: 'SERVER DETAIL', retryAfterSeconds: 5 })

  it('names the entity by its badge and the missing details in words', () => {
    const line = offerFailure(refused({ entity: 'welld_ch', missing: ['vatNumber', 'address.it', 'swift'] }))
    expect(line).toBe(strings.offers.errors.legalEntityIncomplete('wellD CH', 'VAT number, Address (Italian), swift'))
    expect(line).toContain('no offer was created')
  })

  it('has no honest sentence for a body that names no entity we know: the server’s own line stands', () => {
    expect(offerFailure(refused({ missing: ['legalName'] }))).toBe('SERVER DETAIL')
    expect(offerFailure(refused({ entity: 'welld_xx', missing: ['legalName'] }))).toBe('SERVER DETAIL')
  })

  it('needs the status to agree with the code, as every other refusal does', () => {
    expect(legalEntityIncompleteOf(refused({ entity: 'welld_it', missing: [] }, 422))).toBeNull()
    expect(offerFailure(refused({ entity: 'welld_it', missing: [] }, 422))).toBe('SERVER DETAIL')
    expect(legalEntitiesUnavailableOf(unavailable(500))).toBe(false)
    expect(legalEntitiesUnavailableOf(unavailable())).toBe(true)
    expect(legalEntitiesUnavailableOf(new Error('x'))).toBe(false)
  })

  it('reads `entity` and `missing` as the contract has them, and ignores what is not a text', () => {
    expect(legalEntityIncompleteOf(refused({ entity: 'welld_it', missing: ['legalName', 7, null] }))).toEqual({
      entity: 'welld_it',
      missing: ['legalName'],
    })
    expect(legalEntityIncompleteOf(refused({ entity: 'welld_it', missing: 'legalName' }))).toEqual({
      entity: 'welld_it',
      missing: [],
    })
  })

  it('says the registry could not be read, in our own words', () => {
    expect(offerFailure(unavailable())).toBe(strings.offers.errors.legalEntitiesUnavailable)
  })

  it('words a missing value that is a property of Object as received, not as a prototype member', () => {
    expect(legalDetailsInWords(['constructor', 'toString'])).toBe('constructor, toString')
  })

  it('no longer words entity_profile_missing: it is the letterhead upload’s alone (E4)', () => {
    const error = new ApiError({ status: 409, title: 'Conflict', code: 'entity_profile_missing', detail: 'SERVER DETAIL' })
    expect(offerFailure(error)).toBe('SERVER DETAIL')
  })
})
