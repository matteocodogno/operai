/**
 * @vitest-environment jsdom
 *
 * Component tests for BatchSubtotalsPanel (T10, specs/008-refund-monthly-
 * processing/tasks.md). Mirrors SubtotalsPanel.test.tsx's structure, adapted
 * to the single-figure `BatchSubtotal` shape (no requested/approved pair).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import BatchSubtotalsPanel from './BatchSubtotalsPanel'
import type { BatchSubtotal } from '../lib/batchesApi'

afterEach(() => {
  cleanup()
})

const eur: BatchSubtotal = { currency: 'EUR', approvedCents: 910 }
const chf: BatchSubtotal = { currency: 'CHF', approvedCents: 5000 }
const usd: BatchSubtotal = { currency: 'USD', approvedCents: 2000 }
const gbp: BatchSubtotal = { currency: 'GBP', approvedCents: 1500 }

describe('BatchSubtotalsPanel', () => {
  it('renders nothing for an empty subtotals array', () => {
    const { container } = render(<BatchSubtotalsPanel subtotals={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one card per currency present, never a synthesized card for an absent currency', () => {
    render(<BatchSubtotalsPanel subtotals={[eur]} />)
    expect(screen.getByTestId('batch-subtotals-panel-card-EUR')).not.toBeNull()
    expect(screen.queryByTestId('batch-subtotals-panel-card-CHF')).toBeNull()
  })

  it('renders more than one currency at once, never blended into one figure (EUR + CHF + USD + GBP)', () => {
    render(<BatchSubtotalsPanel subtotals={[eur, chf, usd, gbp]} />)
    expect(screen.getByTestId('batch-subtotals-panel-card-EUR')).not.toBeNull()
    expect(screen.getByTestId('batch-subtotals-panel-card-CHF')).not.toBeNull()
    expect(screen.getByTestId('batch-subtotals-panel-card-USD')).not.toBeNull()
    expect(screen.getByTestId('batch-subtotals-panel-card-GBP')).not.toBeNull()
  })

  it('renders the approved total via formatMoney, never a bare number', () => {
    render(<BatchSubtotalsPanel subtotals={[eur]} />)
    const card = screen.getByTestId('batch-subtotals-panel-card-EUR')
    expect(card.textContent).toContain('9,10 €')
  })

  it('renders the CurrencyBadge inside each card', () => {
    render(<BatchSubtotalsPanel subtotals={[chf]} />)
    const card = screen.getByTestId('batch-subtotals-panel-card-CHF')
    expect(card.querySelector('[data-testid="currency-badge"]')).not.toBeNull()
  })
})
