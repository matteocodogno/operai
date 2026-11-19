import { describe, expect, it } from 'vitest'
import { monthLabel } from './monthLabel'

describe('monthLabel', () => {
  it('names a month in words', () => {
    expect(monthLabel('2026-03')).toBe('March 2026')
  })

  it('falls back to the raw text instead of throwing on a value it cannot read', () => {
    expect(monthLabel('not-a-month')).toBe('not-a-month')
    expect(monthLabel('')).toBe('')
  })
})
