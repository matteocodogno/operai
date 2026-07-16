/**
 * Unit tests for EXPENSE_TYPES / requiresKm (T14,
 * specs/007-refund-service/tasks.md — "EXPENSE_TYPES constant … the 12
 * types with id + label"). Guards the two facts every later screen (T16's
 * ExpenseLineComposer/ExpenseLineRow) depends on: exactly twelve distinct,
 * wire-format ids, and `km` gated on exactly one of them (AC-1.2).
 */
import { describe, expect, it } from 'vitest'
import { EXPENSE_TYPES, KM_REQUIRED_TYPE, requiresKm } from './expenseTypes'

describe('EXPENSE_TYPES', () => {
  it('has exactly twelve entries, per spec.md’s domain-language table', () => {
    expect(EXPENSE_TYPES).toHaveLength(12)
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
