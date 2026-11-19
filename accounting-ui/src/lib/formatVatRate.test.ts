import { describe, expect, it } from 'vitest'
import { formatVatRate } from './formatVatRate'

describe('formatVatRate (design AS4)', () => {
  it('shows the server’s rate as a percentage through formatNumber', () => {
    expect(formatVatRate('8.1')).toMatch(/^8[.,]1\s?%$/)
    expect(formatVatRate('22')).toMatch(/^22\s?%$/)
    expect(formatVatRate('0')).toMatch(/^0\s?%$/)
    expect(formatVatRate('2.6')).toMatch(/^2[.,]6\s?%$/)
  })

  it('shows a rate that is not a number as sent', () => {
    expect(formatVatRate('n/a')).toBe('n/a%')
  })
})
