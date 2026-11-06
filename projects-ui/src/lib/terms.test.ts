import { describe, expect, it } from 'vitest'
import { emptyTermsForm, parseManDays, parseWhole, termsFormOf, termsInputOf } from './terms'
import type { Terms, TermsMembers } from './types'

describe('parseManDays (one decimal, AC-2.3 / AC-2.7)', () => {
  it.each([
    ['0', 0],
    ['2', 2],
    ['2.5', 2.5],
    ['2,5', 2.5],
    ['99999.9', 99999.9],
  ])('accepts %s', (text, value) => expect(parseManDays(text)).toBe(value))

  it.each(['', ' ', 'abc', '2.55', '-1', '1e3', '100000'])('refuses "%s"', (text) =>
    expect(parseManDays(text)).toBeNull(),
  )
})

describe('parseWhole', () => {
  it('accepts whole numbers inside the bounds only', () => {
    expect(parseWhole('60', 0, 60)).toBe(60)
    expect(parseWhole('0', 0, 60)).toBe(0)
    expect(parseWhole('61', 0, 60)).toBeNull()
    expect(parseWhole('1.5', 0, 60)).toBeNull()
    expect(parseWhole('', 0, 60)).toBeNull()
    expect(parseWhole('1000001', 1, 1_000_000)).toBeNull()
  })
})

describe('termsInputOf (the request body and the field errors per type)', () => {
  it('fixed price: deadline and max effort required, estimated man-days optional (null)', () => {
    const form = { ...emptyTermsForm('fixed_price'), deadline: '2026-12-01', maxEffortManDays: '40' }
    expect(termsInputOf('fixed_price', form)).toEqual({
      input: { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 },
      errors: {},
    })
    expect(termsInputOf('fixed_price', emptyTermsForm('fixed_price')).errors).toEqual({
      'terms.deadline': 'This field is required.',
      'terms.maxEffortManDays': 'This field is required.',
    })
    expect(termsInputOf('fixed_price', { ...form, maxEffortManDays: '0' }).errors).toHaveProperty(
      'terms.maxEffortManDays',
    )
    expect(termsInputOf('fixed_price', { ...form, estimatedManDays: '12.34' }).errors).toHaveProperty(
      'terms.estimatedManDays',
    )
    expect(termsInputOf('fixed_price', { ...form, estimatedManDays: '12,5' }).input).toMatchObject({
      estimatedManDays: 12.5,
    })
  })

  it('maintenance: an SLA, an hour package, or both — never neither', () => {
    const none = emptyTermsForm('maintenance')
    expect(termsInputOf('maintenance', none).errors).toEqual({
      terms: 'Add an SLA, an hour package, or both.',
    })
    const withSla = { ...none, withSla: true }
    expect(termsInputOf('maintenance', withSla)).toEqual({
      input: { sla: { highDays: 1, normalDays: 3 }, hourPackage: null },
      errors: {},
    })
  })

  it('saas: both optional, so neither is a valid set; absent members are null (a PATCH clears them)', () => {
    expect(termsInputOf('saas', emptyTermsForm('saas'))).toEqual({
      input: { sla: null, hourPackage: null },
      errors: {},
    })
  })

  it('SLA days are whole, 0–60, and name their field', () => {
    const form = { ...emptyTermsForm('saas'), withSla: true, sla: { high: '61', normal: '1.5' } }
    expect(termsInputOf('saas', form).errors).toEqual({
      'terms.sla.highDays': 'Enter a whole number from 0 to 60.',
      'terms.sla.normalDays': 'Enter a whole number from 0 to 60.',
    })
  })

  it('hour package: whole hours from 1, a start date, expiry only for capacity and not before the start', () => {
    const base = { ...emptyTermsForm('maintenance'), withHours: true }
    expect(termsInputOf('maintenance', base).errors).toEqual({
      'terms.hourPackage.hours': 'This field is required.',
      'terms.hourPackage.startDate': 'This field is required.',
    })
    const capacity = {
      ...base,
      hourPackage: { hours: '100', kind: 'capacity' as const, startDate: '2026-03-01', expiryDate: '2026-02-01' },
    }
    expect(termsInputOf('maintenance', capacity).errors).toEqual({
      'terms.hourPackage.expiryDate': 'The expiry must not be before the start date.',
    })
    expect(
      termsInputOf('maintenance', {
        ...capacity,
        hourPackage: { ...capacity.hourPackage, expiryDate: '2027-03-01' },
      }).input,
    ).toEqual({
      sla: null,
      hourPackage: { hours: 100, kind: 'capacity', startDate: '2026-03-01', expiryDate: '2027-03-01' },
    })
    // A yearly package never sends an expiry, whatever the field still holds.
    expect(
      termsInputOf('maintenance', { ...capacity, hourPackage: { ...capacity.hourPackage, kind: 'yearly' } }).input,
    ).toEqual({ sla: null, hourPackage: { hours: 100, kind: 'yearly', startDate: '2026-03-01', expiryDate: null } })
    expect(
      termsInputOf('maintenance', { ...capacity, hourPackage: { ...capacity.hourPackage, hours: '1000001' } }).errors,
    ).toHaveProperty('terms.hourPackage.hours')
  })

  it('time and material: 1–50 positions, a profile (≤120) and planned man-days above zero', () => {
    const one = { ...emptyTermsForm('t_and_m'), positions: [{ profile: ' Senior developer ', plannedManDays: '20' }] }
    expect(termsInputOf('t_and_m', one)).toEqual({
      input: { positions: [{ profile: 'Senior developer', plannedManDays: 20 }] },
      errors: {},
    })
    expect(termsInputOf('t_and_m', { ...one, positions: [] }).errors).toEqual({
      'terms.positions': 'Add at least one position.',
    })
    expect(termsInputOf('t_and_m', { ...one, positions: [{ profile: '', plannedManDays: '0' }] }).errors).toEqual({
      'terms.positions.0.profile': 'This field is required.',
      'terms.positions.0.plannedManDays': 'Enter man-days above 0, with at most one decimal.',
    })
    const many = Array.from({ length: 51 }, () => ({ profile: 'Dev', plannedManDays: '1' }))
    expect(termsInputOf('t_and_m', { ...one, positions: many }).errors).toHaveProperty('terms.positions')
  })

  it('an internal project has no terms', () => {
    expect(termsInputOf('internal', emptyTermsForm('internal'))).toEqual({ input: {}, errors: {} })
  })
})

describe('termsFormOf (stored terms back into the form)', () => {
  const base = { id: 't1', startDate: '2026-02-01', endDate: null, version: 2 }

  it('round-trips every type through the form (the type’s members nested under `terms`, as the server reads them)', () => {
    const cases: [Terms, TermsMembers][] = [
      [
        {
          ...base,
          type: 'fixed_price',
          terms: { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 40 },
        },
        { deadline: '2026-12-01', estimatedManDays: 12.5, maxEffortManDays: 40 },
      ],
      [
        {
          ...base,
          type: 'maintenance',
          terms: {
            sla: { highDays: 2, normalDays: 5 },
            hourPackage: { hours: 100, kind: 'capacity', startDate: '2026-03-01', expiryDate: '2027-03-01' },
          },
        },
        {
          sla: { highDays: 2, normalDays: 5 },
          hourPackage: { hours: 100, kind: 'capacity', startDate: '2026-03-01', expiryDate: '2027-03-01' },
        },
      ],
      [
        { ...base, type: 'saas', terms: { sla: null, hourPackage: null } },
        { sla: null, hourPackage: null },
      ],
      [
        { ...base, type: 't_and_m', terms: { positions: [{ profile: 'Senior developer', plannedManDays: 20.5 }] } },
        { positions: [{ profile: 'Senior developer', plannedManDays: 20.5 }] },
      ],
    ]
    for (const [terms, members] of cases) {
      const { input, errors } = termsInputOf(terms.type, termsFormOf(terms))
      expect(errors).toEqual({})
      expect(input).toEqual(members)
    }
  })

  it('reads a fixed price with no estimate as an empty field, and a yearly hour package with no expiry as an empty one', () => {
    const fixed = termsFormOf({
      ...base,
      type: 'fixed_price',
      terms: { deadline: '2026-12-01', estimatedManDays: null, maxEffortManDays: 40 },
    })
    expect(fixed.estimatedManDays).toBe('')
    const yearly = termsFormOf({
      ...base,
      type: 'maintenance',
      terms: {
        sla: null,
        hourPackage: { hours: 50, kind: 'yearly', startDate: '2026-03-01', expiryDate: null },
      },
    })
    expect(yearly.withSla).toBe(false)
    expect(yearly.withHours).toBe(true)
    expect(yearly.hourPackage.expiryDate).toBe('')
  })
})
