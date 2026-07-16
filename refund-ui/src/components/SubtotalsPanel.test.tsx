/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SubtotalsPanel from './SubtotalsPanel'
import type { Subtotal } from '../lib/subtotals'

afterEach(() => {
  cleanup()
})

const it_: Subtotal = { entity: 'welld_it', currency: 'EUR', requestedCents: 910, approvedCents: 800 }
const ch_: Subtotal = { entity: 'welld_ch', currency: 'CHF', requestedCents: 5000, approvedCents: 5000 }

describe('SubtotalsPanel', () => {
  it('renders nothing for an empty subtotals array', () => {
    const { container } = render(<SubtotalsPanel subtotals={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one card per entity present, never a synthesized card for an absent entity', () => {
    render(<SubtotalsPanel subtotals={[it_]} />)
    expect(screen.getByTestId('subtotals-panel-card-welld_it')).not.toBeNull()
    expect(screen.queryByTestId('subtotals-panel-card-welld_ch')).toBeNull()
  })

  it('renders both entities as independent cards, never blended into one figure', () => {
    render(<SubtotalsPanel subtotals={[it_, ch_]} />)
    expect(screen.getByTestId('subtotals-panel-card-welld_it')).not.toBeNull()
    expect(screen.getByTestId('subtotals-panel-card-welld_ch')).not.toBeNull()
  })

  it('shows only the requested figure by default, even when approvedCents is present', () => {
    render(<SubtotalsPanel subtotals={[it_]} />)
    const card = screen.getByTestId('subtotals-panel-card-welld_it')
    expect(card.textContent).toContain('9,10 €')
    expect(card.textContent).not.toContain('8,00 €')
  })

  it('shows both requested and approved figures when showApproved is true', () => {
    render(<SubtotalsPanel subtotals={[it_]} showApproved />)
    const card = screen.getByTestId('subtotals-panel-card-welld_it')
    expect(card.textContent).toContain('9,10 €')
    expect(card.textContent).toContain('8,00 €')
  })
})
