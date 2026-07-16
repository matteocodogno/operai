import { describe, expect, it } from 'vitest'
import { formatDate, todayIsoDate } from './dates'

describe('formatDate', () => {
  it('formats an ISO timestamp as day/month/year', () => {
    expect(formatDate('2026-07-16T10:00:00.000Z')).toContain('2026')
    expect(formatDate('2026-07-16T10:00:00.000Z')).toContain('16')
  })

  it('formats a bare ISO date (no time component)', () => {
    expect(formatDate('2026-01-05')).toContain('2026')
  })

  it('returns "—" for an unparseable input', () => {
    expect(formatDate('not-a-date')).toBe('—')
  })
})

describe('todayIsoDate', () => {
  it('returns a yyyy-mm-dd string matching the current date', () => {
    const result = todayIsoDate()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const now = new Date()
    expect(result).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    )
  })
})
