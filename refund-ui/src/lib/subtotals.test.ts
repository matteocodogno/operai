import { describe, expect, it } from 'vitest'
import { formatSubtotalsPreview } from './subtotals'
import type { Subtotal } from './subtotals'

const it_: Subtotal = { entity: 'welld_it', currency: 'EUR', requestedCents: 910, approvedCents: null }
const ch_: Subtotal = { entity: 'welld_ch', currency: 'CHF', requestedCents: 5000, approvedCents: 5000 }

describe('formatSubtotalsPreview', () => {
  it('returns an empty string for no subtotals (draft, zero lines)', () => {
    expect(formatSubtotalsPreview([])).toBe('')
  })

  it('renders a single entity as one segment', () => {
    expect(formatSubtotalsPreview([it_])).toBe('9,10 €')
  })

  it('joins multiple entities with a separator, never blending them into one figure', () => {
    expect(formatSubtotalsPreview([it_, ch_])).toBe('9,10 € · 50,00 CHF')
  })

  it('uses requestedCents by default, even when approvedCents is present', () => {
    expect(formatSubtotalsPreview([ch_])).toBe('50,00 CHF')
  })

  it('uses approvedCents when useApproved=true and it is present', () => {
    const approved: Subtotal = { entity: 'welld_ch', currency: 'CHF', requestedCents: 5000, approvedCents: 4000 }
    expect(formatSubtotalsPreview([approved], true)).toBe('40,00 CHF')
  })

  it('falls back to requestedCents when useApproved=true but approvedCents is null (not yet decided)', () => {
    expect(formatSubtotalsPreview([it_], true)).toBe('9,10 €')
  })
})
