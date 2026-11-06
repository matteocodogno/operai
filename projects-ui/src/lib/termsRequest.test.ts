import { describe, expect, it } from 'vitest'
import { emptyTermsForm } from './terms'
import type { TermsForm } from './terms'
import { termsFieldKey, termsRequestOf } from './termsRequest'

const fixedPriceForm = (over: Partial<TermsForm> = {}): TermsForm => ({
  ...emptyTermsForm('fixed_price'),
  deadline: '2026-12-01',
  maxEffortManDays: '40',
  ...over,
})

describe('termsRequestOf', () => {
  it('terms of a saas project may carry neither an SLA nor an hour package: the dates and an empty member set', () => {
    const { input, errors } = termsRequestOf(
      'saas',
      { startDate: '2026-11-01', endDate: '2027-10-31', terms: emptyTermsForm('saas') },
      { estimateBacked: false },
    )
    expect(errors).toEqual({})
    expect(input).toEqual({
      startDate: '2026-11-01',
      endDate: '2027-10-31',
      terms: { sla: null, hourPackage: null },
    })
  })

  it('builds the terms of a take or a hand-made project: the dates, and the members of the project type nested under `terms` (T23)', () => {
    const { input, errors } = termsRequestOf(
      'fixed_price',
      { startDate: '2026-11-01', endDate: '', terms: fixedPriceForm({ estimatedManDays: '12.5' }) },
      { estimateBacked: false },
    )
    expect(errors).toEqual({})
    expect(input).toEqual({
      startDate: '2026-11-01',
      terms: { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 40 },
    })
  })

  it('sends the end date only when there is one', () => {
    const { input } = termsRequestOf(
      'fixed_price',
      { startDate: '2026-11-01', endDate: '2027-01-31', terms: fixedPriceForm() },
      { estimateBacked: false },
    )
    expect(input.endDate).toBe('2027-01-31')
    const open = termsRequestOf(
      'fixed_price',
      { startDate: '2026-11-01', endDate: '', terms: fixedPriceForm() },
      { estimateBacked: false },
    )
    expect('endDate' in open.input).toBe(false)
  })

  it('leaves estimatedManDays out entirely for fixed-price terms the estimate backs: the server refuses it sent (AC-3.1)', () => {
    const { input, errors } = termsRequestOf(
      'fixed_price',
      { startDate: '2026-11-01', endDate: '', terms: fixedPriceForm({ estimatedManDays: '99' }) },
      { estimateBacked: true },
    )
    expect(errors).toEqual({})
    expect(input).toEqual({ startDate: '2026-11-01', terms: { deadline: '2026-12-01', maxEffortManDays: 40 } })
    expect('estimatedManDays' in input.terms!).toBe(false)
  })

  it('keeps the other types’ terms as they are even when an estimate backs the deal', () => {
    const { input } = termsRequestOf(
      't_and_m',
      {
        startDate: '2026-11-01',
        endDate: '',
        terms: { ...emptyTermsForm('t_and_m'), positions: [{ profile: 'Developer', plannedManDays: '20' }] },
      },
      { estimateBacked: true },
    )
    expect(input).toEqual({
      startDate: '2026-11-01',
      terms: { positions: [{ profile: 'Developer', plannedManDays: 20 }] },
    })
  })

  it('asks for a start date, an end date not before it, and the terms of the type', () => {
    const missing = termsRequestOf(
      'fixed_price',
      { startDate: '', endDate: '', terms: emptyTermsForm('fixed_price') },
      { estimateBacked: false },
    )
    expect(Object.keys(missing.errors).sort()).toEqual(['startDate', 'terms.deadline', 'terms.maxEffortManDays'])

    const reversed = termsRequestOf(
      'fixed_price',
      { startDate: '2026-11-01', endDate: '2026-10-01', terms: fixedPriceForm() },
      { estimateBacked: false },
    )
    expect(reversed.errors).toEqual({ endDate: 'The end date must not be before the start date.' })
  })
})

describe('termsFieldKey (where a refusal of the server lands in the form)', () => {
  it.each([
    ['startDate', 'startDate'],
    ['endDate', 'endDate'],
    ['terms.deadline', 'terms.deadline'],
    ['terms.sla.highDays', 'terms.sla.highDays'],
    ['terms.positions.0.profile', 'terms.positions.0.profile'],
    ['terms', 'terms'],
    ['version', null],
  ])('on the terms routes, %s → %s', (field, key) => {
    expect(termsFieldKey(field, 'terms-route')).toBe(key)
  })

  it.each([
    ['terms.startDate', 'startDate'],
    ['terms.endDate', 'endDate'],
    ['terms.terms.deadline', 'terms.deadline'],
    ['terms.terms.positions.0.profile', 'terms.positions.0.profile'],
    ['terms.terms.estimatedManDays', 'terms.estimatedManDays'],
    ['terms.terms', 'terms'],
    ['name', null],
    ['opsManagerId', null],
    ['terms', null],
  ])('in a take or a hand-made create, %s → %s', (field, key) => {
    expect(termsFieldKey(field, 'nested')).toBe(key)
  })
})
