import { describe, expect, it } from 'vitest'
import { emptyTermsForm } from './terms'
import type { TermsForm } from './terms'
import { termsErrorKeysChanged, withoutErrors } from './fieldErrors'

describe('withoutErrors', () => {
  const errors = {
    name: 'a',
    startDate: 'b',
    terms: 'c',
    'terms.deadline': 'd',
    'terms.positions': 'e',
    'terms.positions.0.profile': 'f',
  }

  it('drops the named fields and keeps the rest', () => {
    expect(withoutErrors(errors, 'name', 'startDate')).toEqual({
      terms: 'c',
      'terms.deadline': 'd',
      'terms.positions': 'e',
      'terms.positions.0.profile': 'f',
    })
  })

  it('drops everything under a `.*` prefix, but not the key that is the prefix itself', () => {
    expect(withoutErrors(errors, 'terms.positions.*')).toEqual({
      name: 'a',
      startDate: 'b',
      terms: 'c',
      'terms.deadline': 'd',
      'terms.positions': 'e',
    })
    expect(Object.keys(withoutErrors(errors, 'terms.*'))).toEqual(['name', 'startDate', 'terms'])
  })

  it('returns the same object when nothing it names is set, so a state update is a no-op', () => {
    expect(withoutErrors(errors, 'entity', 'terms.sla.*')).toBe(errors)
  })

  it('ignores a message that is empty (a field that passed its check)', () => {
    const quiet = { name: '' }
    expect(withoutErrors(quiet, 'name')).toBe(quiet)
  })
})

describe('termsErrorKeysChanged', () => {
  const base = (): TermsForm => emptyTermsForm('maintenance')
  const keys = (before: TermsForm, patch: Partial<TermsForm>) => termsErrorKeysChanged(before, { ...before, ...patch })

  it('names nothing when nothing changed', () => {
    expect(keys(base(), {})).toEqual([])
  })

  it('maps each fixed-price member to its server field', () => {
    const before = emptyTermsForm('fixed_price')
    expect(keys(before, { deadline: '2026-12-01' })).toEqual(['terms.deadline'])
    expect(keys(before, { estimatedManDays: '3' })).toEqual(['terms.estimatedManDays'])
    expect(keys(before, { maxEffortManDays: '3' })).toEqual(['terms.maxEffortManDays'])
  })

  it('maps the SLA times to `highDays` / `normalDays`', () => {
    const before = base()
    expect(keys(before, { sla: { ...before.sla, high: '2' } })).toEqual(['terms.sla.highDays'])
    expect(keys(before, { sla: { ...before.sla, normal: '9' } })).toEqual(['terms.sla.normalDays'])
  })

  it('maps each hour-package member, and an expiry that goes away with the kind', () => {
    const before = base()
    const pkg = (patch: Partial<TermsForm['hourPackage']>) => ({ hourPackage: { ...before.hourPackage, ...patch } })
    expect(keys(before, pkg({ hours: '5' }))).toEqual(['terms.hourPackage.hours'])
    expect(keys(before, pkg({ startDate: '2026-01-01' }))).toEqual(['terms.hourPackage.startDate'])
    expect(keys(before, pkg({ expiryDate: '2026-02-01' }))).toEqual(['terms.hourPackage.expiryDate'])
    expect(keys(before, pkg({ kind: 'yearly' }))).toEqual(['terms.hourPackage.kind', 'terms.hourPackage.expiryDate'])
  })

  it('turning the SLA or the hour package on or off ends the messages of its members', () => {
    expect(keys(base(), { withSla: true })).toEqual(['terms.sla.*'])
    expect(keys(base(), { withHours: true })).toEqual(['terms.hourPackage.*'])
  })

  it('maps one position’s member by its index, and leaves the others', () => {
    const before = {
      ...emptyTermsForm('t_and_m'),
      positions: [
        { profile: '', plannedManDays: '' },
        { profile: 'a', plannedManDays: '1' },
      ],
    }
    expect(keys(before, { positions: [before.positions[0]!, { profile: 'b', plannedManDays: '1' }] })).toEqual([
      'terms.positions.1.profile',
    ])
    expect(keys(before, { positions: [{ profile: '', plannedManDays: '2' }, before.positions[1]!] })).toEqual([
      'terms.positions.0.plannedManDays',
    ])
  })

  it('adding or removing a position moves the indexes, so every positions message goes', () => {
    const before = emptyTermsForm('t_and_m')
    const added = [...before.positions, { profile: '', plannedManDays: '' }]
    expect(keys(before, { positions: added })).toEqual(['terms.positions', 'terms.positions.*'])
    expect(keys({ ...before, positions: added }, { positions: before.positions })).toEqual([
      'terms.positions',
      'terms.positions.*',
    ])
  })
})
