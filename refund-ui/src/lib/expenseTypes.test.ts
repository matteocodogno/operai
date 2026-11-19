/**
 * Unit tests for EXPENSE_TYPES / requiresKm (T14,
 * specs/20260716-refund-service/tasks.md — "EXPENSE_TYPES constant … the 12
 * types with id + label"). Guards the two facts every later screen (T16's
 * ExpenseLineComposer/ExpenseLineRow) depends on: exactly twelve distinct,
 * wire-format ids, and `km` gated on exactly one of them (AC-1.2).
 */
import { describe, expect, it } from 'vitest'
import { EXPENSE_TYPES, KM_REQUIRED_TYPE, expenseTypeLabel, requiresKm } from './expenseTypes'

describe('EXPENSE_TYPES', () => {
  it('has exactly fourteen entries, in the order of refund-api’s ExpenseType enum (T58, T68)', () => {
    expect(EXPENSE_TYPES.map((o) => o.id)).toEqual([
      'travel_highway',
      'travel_km',
      'travel_parking',
      'travel_train',
      'travel_other_public_transport',
      'travel_flight',
      'travel_taxi',
      'company_manuals',
      'stationery',
      'representation_meals',
      'representation_gifts',
      'office_material',
      'postal',
      'telephone',
    ])
  })

  it('names the new and renamed types as signed off (AC-8.1, AC-8.2)', () => {
    expect(expenseTypeLabel('travel_flight', 'it')).toBe('Spese di viaggio (aereo)')
    expect(expenseTypeLabel('travel_flight', 'en')).toBe('Travel — flight')
    expect(expenseTypeLabel('travel_taxi', 'it')).toBe('Spese di viaggio (taxi)')
    expect(expenseTypeLabel('travel_taxi', 'en')).toBe('Travel — taxi')
    expect(expenseTypeLabel('representation_meals', 'it')).toBe('Pranzi/cene con clienti')
    expect(expenseTypeLabel('representation_meals', 'en')).toBe('Meals with clients')
  })

  it('has unique, wire-format (snake_case) ids', () => {
    const ids = EXPENSE_TYPES.map((option) => option.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[a-z]+(_[a-z]+)*$/)
    }
  })

  it('every entry has a non-empty English label and a non-empty Italian source-form label', () => {
    for (const option of EXPENSE_TYPES) {
      expect(option.labelEn.length).toBeGreaterThan(0)
      expect(option.labelIt.length).toBeGreaterThan(0)
    }
  })

  it('includes travel_km — the one type km is conditional on', () => {
    expect(EXPENSE_TYPES.some((option) => option.id === 'travel_km')).toBe(true)
    expect(KM_REQUIRED_TYPE).toBe('travel_km')
  })
})

describe('requiresKm', () => {
  it('is true only for travel_km', () => {
    expect(requiresKm('travel_km')).toBe(true)
  })

  it('is false for every other expense type', () => {
    for (const option of EXPENSE_TYPES) {
      if (option.id === 'travel_km') continue
      expect(requiresKm(option.id)).toBe(false)
    }
  })
})
