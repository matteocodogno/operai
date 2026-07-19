import { describe, expect, it } from 'vitest'
import { formatBatchSubtotalsPreview } from './batchSubtotals'
import type { BatchSubtotal } from './batchesApi'

const eur: BatchSubtotal = { currency: 'EUR', approvedCents: 910 }
const chf: BatchSubtotal = { currency: 'CHF', approvedCents: 5000 }
const usd: BatchSubtotal = { currency: 'USD', approvedCents: 2000 }

describe('formatBatchSubtotalsPreview', () => {
  it('returns an empty string for no subtotals (empty candidate/batch set)', () => {
    expect(formatBatchSubtotalsPreview([])).toBe('')
  })

  it('renders a single currency as one segment', () => {
    expect(formatBatchSubtotalsPreview([eur])).toBe('9,10 €')
  })

  it('joins multiple currencies with a separator, never blending them into one figure', () => {
    expect(formatBatchSubtotalsPreview([eur, chf])).toBe('9,10 € · 50,00 CHF')
  })

  it('joins more than two currencies, e.g. EUR + CHF + USD', () => {
    expect(formatBatchSubtotalsPreview([eur, chf, usd])).toBe('9,10 € · 50,00 CHF · 20,00 $')
  })
})
