import { describe, expect, it } from 'vitest'
import { formatSubtotalsPreview } from './subtotals'
import type { Subtotal } from './subtotals'

const eur: Subtotal = { currency: 'EUR', requestedCents: 910, approvedCents: null }
const chf: Subtotal = { currency: 'CHF', requestedCents: 5000, approvedCents: 5000 }
const usd: Subtotal = { currency: 'USD', requestedCents: 2000, approvedCents: null }

describe('formatSubtotalsPreview', () => {
  it('returns an empty string for no subtotals (draft, zero lines)', () => {
    expect(formatSubtotalsPreview([])).toBe('')
  })

  it('renders a single currency as one segment', () => {
    expect(formatSubtotalsPreview([eur])).toBe('9,10 €')
  })

  it('joins multiple currencies with a separator, never blending them into one figure', () => {
    expect(formatSubtotalsPreview([eur, chf])).toBe('9,10 € · 50,00 CHF')
  })

  it('joins more than two currencies, e.g. EUR + CHF + USD', () => {
    expect(formatSubtotalsPreview([eur, chf, usd])).toBe('9,10 € · 50,00 CHF · 20,00 $')
  })

  it('uses requestedCents by default, even when approvedCents is present', () => {
    expect(formatSubtotalsPreview([chf])).toBe('50,00 CHF')
  })

  it('uses approvedCents when useApproved=true and it is present', () => {
    const approved: Subtotal = { currency: 'CHF', requestedCents: 5000, approvedCents: 4000 }
    expect(formatSubtotalsPreview([approved], true)).toBe('40,00 CHF')
  })

  it('falls back to requestedCents when useApproved=true but approvedCents is null (not yet decided)', () => {
    expect(formatSubtotalsPreview([eur], true)).toBe('9,10 €')
  })
})
