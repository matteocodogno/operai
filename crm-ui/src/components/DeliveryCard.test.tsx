/**
 * @vitest-environment jsdom
 *
 * DeliveryCard (specs/022 AC-3.4): the deal page shows the project that carries the deal and its
 * contract's Bexio order id, read-only. No project and a known answer → no card at all; projects-api
 * not answering → the card says the delivery side is unavailable instead of claiming "no project".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import DeliveryCard from './DeliveryCard'

afterEach(cleanup)

describe('DeliveryCard', () => {
  it('shows the project name and the Bexio order id, with no edit control', () => {
    render(
      <DeliveryCard
        delivery={{ project: { id: 'p1', name: 'Platform rebuild' }, bexioOrderId: 'AB-2026-0042' }}
        deliveryKnown
      />,
    )
    const card = screen.getByTestId('crm-delivery-card')
    expect(within(card).getByRole('heading', { name: 'Delivery' })).not.toBeNull()
    const facts = within(card).getByTestId('crm-delivery-facts')
    expect(facts.textContent).toContain('Platform rebuild')
    expect(facts.textContent).toContain('AB-2026-0042')
    expect(within(card).queryByRole('button')).toBeNull()
    expect(within(card).queryByRole('textbox')).toBeNull()
  })

  it('shows "—" when the contract has no Bexio order id yet', () => {
    render(
      <DeliveryCard delivery={{ project: { id: 'p1', name: 'Platform rebuild' }, bexioOrderId: null }} deliveryKnown />,
    )
    const facts = screen.getByTestId('crm-delivery-facts').textContent ?? ''
    expect(facts).toContain('Platform rebuild')
    expect(facts).toContain('—')
  })

  it('is absent when no project carries the deal and projects-api answered', () => {
    const { container } = render(<DeliveryCard delivery={null} deliveryKnown />)
    expect(container.textContent).toBe('')
    expect(screen.queryByTestId('crm-delivery-card')).toBeNull()
  })

  it('says the delivery side is unavailable when projects-api did not answer', () => {
    render(<DeliveryCard delivery={null} deliveryKnown={false} />)
    const card = screen.getByTestId('crm-delivery-card')
    expect(within(card).getByTestId('crm-delivery-unavailable').textContent).toMatch(/unavailable/i)
    expect(screen.queryByTestId('crm-delivery-facts')).toBeNull()
  })
})
