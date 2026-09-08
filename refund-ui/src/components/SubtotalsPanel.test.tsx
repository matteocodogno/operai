/**
 * @vitest-environment jsdom
 *
 * Post-close change (specs/007): subtotals are now grouped by currency, not
 * entity (see `../lib/subtotals.ts`'s doc comment) — cards key on `currency`
 * and render `CurrencyBadge`, and a request can carry more than two cards.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SubtotalsPanel from './SubtotalsPanel'
import type { Subtotal } from '../lib/subtotals'

afterEach(() => {
  cleanup()
})

const eur: Subtotal = { currency: 'EUR', requestedCents: 910, approvedCents: 800 }
const chf: Subtotal = { currency: 'CHF', requestedCents: 5000, approvedCents: 5000 }
const usd: Subtotal = { currency: 'USD', requestedCents: 2000, approvedCents: null }
const gbp: Subtotal = { currency: 'GBP', requestedCents: 1500, approvedCents: null }

describe('SubtotalsPanel', () => {
  it('renders nothing for an empty subtotals array', () => {
    const { container } = render(<SubtotalsPanel subtotals={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one card per currency present, never a synthesized card for an absent currency', () => {
    render(<SubtotalsPanel subtotals={[eur]} />)
    expect(screen.getByTestId('subtotals-panel-card-EUR')).not.toBeNull()
    expect(screen.queryByTestId('subtotals-panel-card-CHF')).toBeNull()
  })

  it('renders both currencies as independent cards, never blended into one figure', () => {
    render(<SubtotalsPanel subtotals={[eur, chf]} />)
    expect(screen.getByTestId('subtotals-panel-card-EUR')).not.toBeNull()
    expect(screen.getByTestId('subtotals-panel-card-CHF')).not.toBeNull()
  })

  it('handles more than two currencies present at once (EUR + CHF + USD + GBP)', () => {
    render(<SubtotalsPanel subtotals={[eur, chf, usd, gbp]} />)
    expect(screen.getByTestId('subtotals-panel-card-EUR')).not.toBeNull()
    expect(screen.getByTestId('subtotals-panel-card-CHF')).not.toBeNull()
    expect(screen.getByTestId('subtotals-panel-card-USD')).not.toBeNull()
    expect(screen.getByTestId('subtotals-panel-card-GBP')).not.toBeNull()
  })

  it('shows only the requested figure by default, even when approvedCents is present', () => {
    render(<SubtotalsPanel subtotals={[eur]} />)
    const card = screen.getByTestId('subtotals-panel-card-EUR')
    expect(card.textContent).toContain('9,10 €')
    expect(card.textContent).not.toContain('8,00 €')
  })

  // AC-3.2 (amended 2026-09-08) applies to the totals card as well as the
  // lines — the two must never disagree about whether an amount changed, which
  // is why both read the same lib/money.ts helper.
  it('surfaces the delta on the totals when accounting adjusted the amount', () => {
    render(<SubtotalsPanel subtotals={[eur]} showApproved />)
    const amount = screen.getByTestId('subtotals-approved-EUR')
    expect(amount.getAttribute('data-changed')).toBe('true')
    expect(amount.textContent).toBe('8,00 € (requested 9,10, −1,10)')
  })

  it('shows a single figure on the totals when nothing was adjusted', () => {
    render(<SubtotalsPanel subtotals={[{ ...eur, approvedCents: eur.requestedCents }]} showApproved />)
    const amount = screen.getByTestId('subtotals-approved-EUR')
    expect(amount.getAttribute('data-changed')).toBe('false')
    expect(amount.textContent).toBe('9,10 €')

    const card = screen.getByTestId('subtotals-panel-card-EUR')
    expect(card.textContent).not.toContain('Requested')
    expect(card.textContent).not.toContain('requested')
  })
})
