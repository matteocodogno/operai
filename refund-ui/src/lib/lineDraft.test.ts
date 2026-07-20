import { describe, expect, it } from 'vitest'
import {
  amountToCents,
  centsToAmountInput,
  emptyLineDraft,
  isLineDraftComplete,
  lineDraftToPayload,
  lineToDraft,
} from './lineDraft'
import type { LineDraftValue } from './lineDraft'
import type { RefundLine } from './requestsApi'

const baseLine: RefundLine = {
  id: 'line-1',
  date: '2026-07-01',
  type: 'stationery',
  motivo: 'Pens',
  entity: 'welld_it',
  currency: 'EUR',
  requestedAmountCents: 1550,
  km: null,
  approvedTotalCents: null,
  attachments: [],
}

describe('amountToCents', () => {
  it('parses a major-unit string into integer cents', () => {
    expect(amountToCents('45.50')).toBe(4550)
    expect(amountToCents('0')).toBe(0)
  })

  it('returns null for empty input', () => {
    expect(amountToCents('')).toBeNull()
    expect(amountToCents('   ')).toBeNull()
  })

  it('returns null for negative or non-finite input', () => {
    expect(amountToCents('-5')).toBeNull()
    expect(amountToCents('abc')).toBeNull()
  })
})

describe('centsToAmountInput', () => {
  it('is the inverse of amountToCents for whole and fractional cents', () => {
    expect(centsToAmountInput(4550)).toBe('45.50')
    expect(centsToAmountInput(0)).toBe('0.00')
  })
})

describe('emptyLineDraft', () => {
  it('has no default type/entity/currency (AC-1.2: explicit, deliberate choice)', () => {
    const draft = emptyLineDraft()
    expect(draft.type).toBe('')
    expect(draft.entity).toBe('')
    expect(draft.currency).toBe('')
    expect(draft.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('lineToDraft / lineDraftToPayload round-trip', () => {
  it('round-trips a non-km line', () => {
    const draft = lineToDraft(baseLine)
    expect(draft.km).toBe('')
    expect(draft.currency).toBe('EUR')
    const payload = lineDraftToPayload(draft)
    expect(payload).toEqual({
      date: '2026-07-01',
      type: 'stationery',
      motivo: 'Pens',
      requestedAmountCents: 1550,
      entity: 'welld_it',
      currency: 'EUR',
    })
    expect(payload.km).toBeUndefined()
  })

  it('round-trips a line whose currency does not match its entity (independent fields, no cross-validation)', () => {
    const mismatched: RefundLine = { ...baseLine, entity: 'welld_it', currency: 'USD' }
    const draft = lineToDraft(mismatched)
    const payload = lineDraftToPayload(draft)
    expect(payload.entity).toBe('welld_it')
    expect(payload.currency).toBe('USD')
  })

  it('round-trips a travel_km line, carrying km', () => {
    const kmLine: RefundLine = { ...baseLine, type: 'travel_km', km: 120, requestedAmountCents: 4550 }
    const draft = lineToDraft(kmLine)
    expect(draft.km).toBe('120')
    const payload = lineDraftToPayload(draft)
    expect(payload.km).toBe(120)
  })

  it('omits requestedAmountCents/currency from a travel_km payload — server-derived (specs/009-mileage-rate AC-1.1/1.6)', () => {
    const kmLine: RefundLine = { ...baseLine, type: 'travel_km', km: 120, requestedAmountCents: 4550 }
    const payload = lineDraftToPayload(lineToDraft(kmLine))
    expect(payload).toEqual({
      date: '2026-07-01',
      type: 'travel_km',
      motivo: 'Pens',
      entity: 'welld_it',
      km: 120,
    })
    expect(payload.requestedAmountCents).toBeUndefined()
    expect(payload.currency).toBeUndefined()
  })

  it('still includes requestedAmountCents/currency for a non-travel_km payload (unchanged, AC-1.5)', () => {
    const payload = lineDraftToPayload(lineToDraft(baseLine))
    expect(payload.requestedAmountCents).toBe(1550)
    expect(payload.currency).toBe('EUR')
  })
})

describe('isLineDraftComplete', () => {
  const base: LineDraftValue = {
    date: '2026-07-01',
    type: 'stationery',
    motivo: 'Pens',
    amount: '10.00',
    entity: 'welld_it',
    currency: 'EUR',
    km: '',
  }

  it('is false for an empty draft', () => {
    expect(isLineDraftComplete(emptyLineDraft())).toBe(false)
  })

  it('is true once every required field is present for a non-km type', () => {
    expect(isLineDraftComplete(base)).toBe(true)
  })

  it('is false if motivo is blank/whitespace-only', () => {
    expect(isLineDraftComplete({ ...base, motivo: '   ' })).toBe(false)
  })

  it('is false if amount is not a valid non-negative number', () => {
    expect(isLineDraftComplete({ ...base, amount: '' })).toBe(false)
    expect(isLineDraftComplete({ ...base, amount: '-5' })).toBe(false)
  })

  it('is false if currency is not selected, independent of entity being selected', () => {
    expect(isLineDraftComplete({ ...base, currency: '' })).toBe(false)
  })

  it('is true for any entity/currency combination — never cross-validated', () => {
    expect(isLineDraftComplete({ ...base, entity: 'welld_it', currency: 'USD' })).toBe(true)
    expect(isLineDraftComplete({ ...base, entity: 'welld_ch', currency: 'GBP' })).toBe(true)
  })

  it('for travel_km: requires km > 0, and does NOT require it for any other type', () => {
    const kmDraft = { ...base, type: 'travel_km' as const }
    expect(isLineDraftComplete({ ...kmDraft, km: '' })).toBe(false)
    expect(isLineDraftComplete({ ...kmDraft, km: '0' })).toBe(false)
    expect(isLineDraftComplete({ ...kmDraft, km: '-3' })).toBe(false)
    expect(isLineDraftComplete({ ...kmDraft, km: '10' })).toBe(true)
    // A non-km type is complete with km left blank.
    expect(isLineDraftComplete({ ...base, type: 'postal', km: '' })).toBe(true)
  })

  it('for travel_km: amount/currency are dropped from the check entirely (specs/009-mileage-rate AC-1.1)', () => {
    const kmDraft = { ...base, type: 'travel_km' as const, km: '10', amount: '', currency: '' as const }
    expect(isLineDraftComplete(kmDraft)).toBe(true)
  })

  it('for a non-travel_km type: currency/amount are still required (unchanged, AC-1.5)', () => {
    expect(isLineDraftComplete({ ...base, currency: '' })).toBe(false)
    expect(isLineDraftComplete({ ...base, amount: '' })).toBe(false)
  })
})
