/**
 * @vitest-environment jsdom
 *
 * Component tests for AccountScreen (specs/012-employee-address, T14, US-6,
 * AC-6.1/AC-6.2; design.md "`AccountScreen` — shell route `/account`").
 *
 * Per this task's done-when:
 *   - within the address region, `querySelectorAll('input, textarea,
 *     select, [contenteditable], button[type="submit"]').length === 0`, and
 *     no `role="listbox"`/`role="combobox"` element exists — asserted in
 *     EVERY state (loading, populated, empty, fetch-failure);
 *   - the `null` ("no address on file"), populated, and fetch-failure states
 *     each render distinctly — a fetch failure must NEVER collapse into "no
 *     address on file" (plan.md AC-6.1 test note, design.md F6 step 4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AccountScreen } from './AccountScreen'
import { getMyAddress } from '../lib/profileApi'
import type { AddressView } from '../lib/profileApi'

vi.mock('../lib/profileApi', () => ({
  getMyAddress: vi.fn(),
}))

const mockedGetMyAddress = vi.mocked(getMyAddress)

const FIXTURE_ADDRESS: AddressView = {
  countryCode: 'CH',
  city: 'Zürich',
  street: 'Bahnhofstrasse',
  houseNumber: '12b',
  postalCode: '8001',
  region: 'Zürich',
  latitude: 47.3702,
  longitude: 8.5397,
  formatted: 'Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland',
  updatedAt: '2026-08-03T09:12:44.123Z',
}

const NON_INTERACTIVE_SELECTOR = 'input, textarea, select, [contenteditable], button[type="submit"]'

/** AC-6.2's exact DOM assertion, scoped to the address region (module doc). */
function assertZeroInteractiveElements(container: HTMLElement) {
  const region = container.querySelector('[data-testid="account-address-region"]')
  expect(region).not.toBeNull()
  expect(region!.querySelectorAll(NON_INTERACTIVE_SELECTOR)).toHaveLength(0)
  expect(region!.querySelector('[role="listbox"]')).toBeNull()
  expect(region!.querySelector('[role="combobox"]')).toBeNull()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AccountScreen (US-6)', () => {
  it('renders a loading state with a polite aria-live announcement, zero interactive elements', async () => {
    let resolveAddress!: (value: AddressView | null) => void
    mockedGetMyAddress.mockReturnValue(
      new Promise<AddressView | null>((resolve) => {
        resolveAddress = resolve
      }),
    )

    const { container } = render(<AccountScreen />)

    expect(screen.getByTestId('account-loading')).not.toBeNull()
    const announcement = screen.getByText('Loading your address…')
    expect(announcement.getAttribute('aria-live')).toBe('polite')
    assertZeroInteractiveElements(container)

    // Let the in-flight fetch settle so no act() warning leaks into other tests.
    resolveAddress(null)
    await screen.findByTestId('account-address-empty')
  })

  it('renders the populated state as plain text, distinct from empty/error, zero interactive elements', async () => {
    mockedGetMyAddress.mockResolvedValue(FIXTURE_ADDRESS)

    const { container } = render(<AccountScreen />)

    expect(await screen.findByText(FIXTURE_ADDRESS.formatted)).not.toBeNull()
    expect(screen.queryByTestId('account-address-empty')).toBeNull()
    expect(screen.queryByTestId('account-error')).toBeNull()
    assertZeroInteractiveElements(container)
  })

  it('renders the "no address on file" empty state, distinct from populated/error, zero interactive elements', async () => {
    mockedGetMyAddress.mockResolvedValue(null)

    const { container } = render(<AccountScreen />)

    expect(await screen.findByTestId('account-address-empty')).not.toBeNull()
    expect(screen.getByText('No address on file')).not.toBeNull()
    expect(screen.queryByTestId('account-address-formatted')).toBeNull()
    expect(screen.queryByTestId('account-error')).toBeNull()
    assertZeroInteractiveElements(container)
  })

  it('renders a distinct error+retry state on fetch failure — NEVER collapsed into "no address on file"', async () => {
    mockedGetMyAddress.mockRejectedValueOnce(new Error('network error'))

    const { container } = render(<AccountScreen />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/couldn't load your address/i)
    expect(screen.queryByTestId('account-address-empty')).toBeNull()
    expect(screen.queryByText('No address on file')).toBeNull()
    assertZeroInteractiveElements(container)

    // Retry actually re-invokes getMyAddress and can recover into the loaded state.
    mockedGetMyAddress.mockResolvedValueOnce(FIXTURE_ADDRESS)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    expect(await screen.findByText(FIXTURE_ADDRESS.formatted)).not.toBeNull()
    expect(mockedGetMyAddress).toHaveBeenCalledTimes(2)
  })
})
