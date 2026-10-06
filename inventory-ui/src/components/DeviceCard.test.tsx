/**
 * @vitest-environment jsdom
 *
 * Component tests for DeviceCard (T31, specs/015-hardware-inventory; design.md
 * § D1 and § Accessibility "D1 my devices"; AC-2.3, AC-2.4, AC-4.1, AC-4.2).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import DeviceCard from './DeviceCard'
import type { MyDevice } from '../lib/types'

afterEach(cleanup)

const device: MyDevice = {
  assetId: 'a1',
  description: 'MacBook Pro 14',
  category: 'laptop',
  serialNumber: 'SN123',
  assignedAt: '2026-10-06T09:30:00Z',
}

const renderCard = (props: Partial<React.ComponentProps<typeof DeviceCard>> = {}) =>
  render(
    <ul>
      <DeviceCard device={device} kind="pending" onConfirm={vi.fn()} onDecline={vi.fn()} {...props} />
    </ul>,
  )

describe('content', () => {
  it('shows description, category, serial number and the offered date for a pending device', () => {
    renderCard()

    expect(screen.getByRole('heading', { level: 3, name: 'MacBook Pro 14' })).not.toBeNull()
    const card = screen.getByRole('listitem')
    expect(card.textContent).toContain('Laptop')
    expect(card.textContent).toContain('SN123')
    expect(card.textContent).toContain('offered 06.10.2026')
  })

  it('says "assigned" for a held device and leaves out a missing serial number', () => {
    renderCard({ kind: 'held', device: { ...device, serialNumber: null } })

    expect(screen.getByRole('listitem').textContent).toContain('assigned 06.10.2026')
    expect(screen.getByRole('listitem').textContent).not.toContain('null')
  })

  it('renders no price, book value, currency or entity, even when the data carries one (AC-4.2)', () => {
    const leaky = { ...device, purchasePriceCents: 99815, currency: 'CHF', entity: 'welld_ch' } as MyDevice
    renderCard({ device: leaky })

    expect(screen.getByRole('listitem').textContent).not.toMatch(/CHF|EUR|€|998|WellD/)
  })
})

describe('actions', () => {
  it('a pending card offers Confirm and Decline, each named with the device', () => {
    renderCard()

    expect(screen.getByRole('button', { name: 'I have received this device – MacBook Pro 14' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Decline – MacBook Pro 14' })).not.toBeNull()
  })

  it('a held card has no actions', () => {
    renderCard({ kind: 'held' })

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('Confirm and Decline report their click', () => {
    const onConfirm = vi.fn()
    const onDecline = vi.fn()
    renderCard({ onConfirm, onDecline })

    fireEvent.click(screen.getByRole('button', { name: /^I have received this device/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Decline/ }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onDecline).toHaveBeenCalledTimes(1)
  })

  it('while busy both buttons are aria-disabled (still focusable), aria-busy on the one in flight, and clicks are ignored', () => {
    const onConfirm = vi.fn()
    const onDecline = vi.fn()
    renderCard({ busy: true, onConfirm, onDecline })

    const confirm = screen.getByRole('button', { name: /^Confirming/ })
    const decline = screen.getByRole('button', { name: /^Decline/ })
    expect(confirm.getAttribute('aria-disabled')).toBe('true')
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect(decline.getAttribute('aria-disabled')).toBe('true')
    expect(confirm.hasAttribute('disabled')).toBe(false)

    fireEvent.click(confirm)
    fireEvent.click(decline)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onDecline).not.toHaveBeenCalled()
  })

  it('shows its error as an alert on the card', () => {
    renderCard({ errorMessage: 'Could not confirm.' })

    expect(screen.getByRole('alert').textContent).toBe('Could not confirm.')
  })

  it('exposes its heading as a programmatic focus target', () => {
    renderCard()

    const heading = screen.getByRole('heading', { level: 3 })
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(heading.getAttribute('data-device-heading')).toBe('a1')
  })
})
