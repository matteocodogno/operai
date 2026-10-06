/**
 * @vitest-environment jsdom
 *
 * Page tests for MyDevicesPage (T31, specs/015-hardware-inventory; design.md
 * § D1, F14, Q3 as resolved, § Accessibility "D1 my devices"; refs AC-2.3,
 * AC-2.4, AC-4.1, AC-4.2, AC-4.4).
 *
 * The page is the ungated `/devices` entry: it must work for a user with zero
 * grants, so `usePermissions` and `GET /scope` are mocked as spies and asserted
 * NEVER to be called. Only `meApi` is mocked as the data seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { MyDevice, MyDevicesResponse, MyPending } from '../lib/types'

const { usePermissions, getScope, getMyDevices, confirmAssignment, declineAssignment } = vi.hoisted(() => ({
  usePermissions: vi.fn(),
  getScope: vi.fn(),
  getMyDevices: vi.fn(),
  confirmAssignment: vi.fn(),
  declineAssignment: vi.fn(),
}))
vi.mock('shell/session', () => ({ usePermissions }))
vi.mock('../lib/scopeApi', () => ({ getScope }))
vi.mock('../lib/meApi', () => ({ getMyDevices, confirmAssignment, declineAssignment }))

import MyDevicesPage from './MyDevicesPage'

const held = (over: Partial<MyDevice> = {}): MyDevice => ({
  assetId: 'h1',
  description: 'Dell U2723QE',
  category: 'monitor',
  serialNumber: 'SN456',
  assignedAt: '2026-03-12T08:00:00Z',
  ...over,
})

const pending = (over: Partial<MyPending> = {}): MyPending => ({
  assetId: 'p1',
  assignmentId: 'as1',
  description: 'MacBook Pro 14',
  category: 'laptop',
  serialNumber: 'SN123',
  assignedAt: '2026-10-06T09:00:00Z',
  ...over,
})

const respond = (devices: MyDevice[], waiting: MyPending[]): MyDevicesResponse => ({ devices, pending: waiting })

beforeEach(() => {
  getMyDevices.mockResolvedValue(respond([held()], [pending()]))
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderPage = async () => {
  render(<MyDevicesPage />)
  await screen.findByRole('heading', { level: 1, name: 'My devices' })
}

describe('loading, empty and error', () => {
  it('shows a skeleton and a polite loading line while the list loads', async () => {
    getMyDevices.mockReturnValue(new Promise(() => undefined))
    await renderPage()

    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.getByTestId('devices-loading').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('devices-loading').textContent).toBe('Loading your devices')
  })

  it('shows the explicit empty state, as plain text and not an alert, when there is nothing at all (AC-4.4)', async () => {
    getMyDevices.mockResolvedValue(respond([], []))
    await renderPage()

    const empty = await screen.findByTestId('devices-empty')
    expect(empty.textContent).toBe('You have no devices assigned to you, and nothing is waiting for your confirmation.')
    expect(empty.closest('[role="alert"]')).toBeNull()
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
  })

  it('a failed fetch shows an alert with Retry, which loads the list', async () => {
    getMyDevices.mockRejectedValueOnce(new ApiError({ status: 500, title: 'Boom', detail: 'The server is down.' }))
    await renderPage()

    const banner = await screen.findByTestId('error-banner')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toContain('The server is down.')

    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await screen.findByRole('heading', { level: 2, name: 'Devices I hold (1)' })
    expect(screen.queryByTestId('error-banner')).toBeNull()
  })

  it('a network failure shows the connection message', async () => {
    getMyDevices.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await renderPage()

    expect((await screen.findByTestId('error-banner')).textContent).toContain('Could not reach the server')
  })
})

describe('the two sections (AC-4.1)', () => {
  it('lists the pending and the held devices under counted headings, as lists of cards', async () => {
    getMyDevices.mockResolvedValue(
      respond(
        [held(), held({ assetId: 'h2', description: 'Keyboard', category: 'peripheral', serialNumber: null })],
        [pending()],
      ),
    )
    await renderPage()

    const waiting = await screen.findByRole('heading', { level: 2, name: 'Waiting for your confirmation (1)' })
    const holding = screen.getByRole('heading', { level: 2, name: 'Devices I hold (2)' })
    const waitingList = waiting.closest('section')!.querySelector('ul')!
    const holdingList = holding.closest('section')!.querySelector('ul')!

    expect(within(waitingList).getAllByRole('listitem')).toHaveLength(1)
    expect(within(waitingList).getByText('MacBook Pro 14')).not.toBeNull()
    expect(within(waitingList).getByText(/offered 06\.10\.2026/)).not.toBeNull()
    expect(within(holdingList).getAllByRole('listitem')).toHaveLength(2)
    expect(within(holdingList).getAllByText(/assigned 12\.03\.2026/)).toHaveLength(2)
    expect(within(holdingList).getByText(/Monitor · SN456/)).not.toBeNull()
  })

  it('omits the waiting section when nothing is waiting', async () => {
    getMyDevices.mockResolvedValue(respond([held()], []))
    await renderPage()

    await screen.findByRole('heading', { level: 2, name: 'Devices I hold (1)' })
    expect(screen.queryByText(/Waiting for your confirmation/)).toBeNull()
  })

  it('with only a pending device, "Devices I hold" says you hold none yet', async () => {
    getMyDevices.mockResolvedValue(respond([], [pending()]))
    await renderPage()

    await screen.findByRole('heading', { level: 2, name: 'Devices I hold (0)' })
    expect(screen.getByText('You do not hold any devices yet.')).not.toBeNull()
    expect(screen.queryByTestId('devices-empty')).toBeNull()
  })
})

describe('no money, no scope, no capability (AC-4.2, ADR-0045)', () => {
  it('the rendered DOM contains no currency text, even if the payload carried a price', async () => {
    const leaky = {
      ...held(),
      purchasePriceCents: 99815,
      currency: 'CHF',
      bookValueCents: 5000,
      entity: 'welld_ch',
    } as MyDevice
    getMyDevices.mockResolvedValue(
      respond([leaky], [{ ...pending(), currency: 'EUR', purchasePriceCents: 1 } as MyPending]),
    )
    await renderPage()
    await screen.findByRole('heading', { level: 2, name: 'Devices I hold (1)' })

    expect(document.body.textContent).not.toMatch(/CHF|EUR|€|\$|998|WellD/)
  })

  it('never asks for permissions or the scope, so it works for a user with zero grants', async () => {
    await renderPage()
    await screen.findByRole('heading', { level: 2, name: 'Devices I hold (1)' })

    expect(usePermissions).not.toHaveBeenCalled()
    expect(getScope).not.toHaveBeenCalled()
  })
})

describe('Confirm (AC-2.3): one click, no dialog', () => {
  it('moves the card to "Devices I hold", announces it and focuses the moved card heading', async () => {
    confirmAssignment.mockResolvedValue({
      device: held({ assetId: 'p1', description: 'MacBook Pro 14', assignedAt: '2026-10-07T07:00:00Z' }),
    })
    await renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^I have received this device/ }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(confirmAssignment).toHaveBeenCalledWith('as1'))
    await screen.findByRole('heading', { level: 2, name: 'Devices I hold (2)' })
    expect(screen.queryByText(/Waiting for your confirmation/)).toBeNull()

    const holding = screen.getByRole('heading', { level: 2, name: 'Devices I hold (2)' }).closest('section')!
    const moved = within(holding).getByRole('heading', { level: 3, name: 'MacBook Pro 14' })
    expect(document.activeElement).toBe(moved)
    expect(screen.getByTestId('devices-status').textContent).toBe('Confirmed: MacBook Pro 14')
    expect(screen.getByTestId('devices-status').getAttribute('role')).toBe('status')
  })

  it('sends one request however many times the button is clicked while it is in flight', async () => {
    let resolve: (value: { device: MyDevice }) => void = () => undefined
    confirmAssignment.mockReturnValue(new Promise((r) => (resolve = r)))
    await renderPage()

    const button = await screen.findByRole('button', { name: /^I have received this device/ })
    fireEvent.click(button)
    const busy = await screen.findByRole('button', { name: /^Confirming/ })
    fireEvent.click(busy)
    fireEvent.click(busy)

    expect(confirmAssignment).toHaveBeenCalledTimes(1)
    resolve({ device: held({ assetId: 'p1' }) })
    await screen.findByRole('heading', { level: 2, name: 'Devices I hold (2)' })
  })

  it('a failed confirm keeps the card, shows the error on the card and leaves focus on its button', async () => {
    confirmAssignment.mockRejectedValue(new ApiError({ status: 500, title: 'Boom' }))
    await renderPage()

    const button = await screen.findByRole('button', { name: /^I have received this device/ })
    button.focus()
    fireEvent.click(button)

    const card = (await screen.findByRole('alert')).closest('li')!
    expect(card.textContent).toContain('We could not record your confirmation. Try again.')
    expect(within(card).getByRole('button', { name: /^I have received this device/ })).not.toBeNull()
    expect(document.activeElement).toBe(within(card).getByRole('button', { name: /^I have received this device/ }))
    expect(screen.getByRole('heading', { level: 2, name: 'Waiting for your confirmation (1)' })).not.toBeNull()
  })

  it.each([
    ['404', new ApiError({ status: 404, title: 'Not found' })],
    ['409 assignment_not_pending', new ApiError({ status: 409, title: 'Conflict', code: 'assignment_not_pending' })],
  ])('a stale card (%s) shows the "no longer open" message and refreshes the list', async (_name, error) => {
    confirmAssignment.mockRejectedValue(error)
    await renderPage()
    getMyDevices.mockResolvedValue(respond([held()], []))

    fireEvent.click(await screen.findByRole('button', { name: /^I have received this device/ }))

    const alert = await screen.findByTestId('devices-notice')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toBe('This assignment is no longer open. The list has been refreshed.')
    await waitFor(() => expect(getMyDevices).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(/Waiting for your confirmation/)).toBeNull())
    expect(screen.getByRole('heading', { level: 2, name: 'Devices I hold (1)' })).not.toBeNull()
  })
})

describe('Decline (AC-2.4): confirm dialog first', () => {
  it('opens a confirm dialog with Cancel focused and does not call the API yet', async () => {
    await renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^Decline/ }))

    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Decline MacBook Pro 14?')).not.toBeNull()
    expect(document.activeElement).toBe(within(dialog).getByTestId('decline-assignment-cancel'))
    expect(declineAssignment).not.toHaveBeenCalled()
  })

  it('Cancel closes the dialog, keeps the card and returns focus to the Decline button', async () => {
    await renderPage()
    const trigger = await screen.findByRole('button', { name: /^Decline/ })
    trigger.focus()
    fireEvent.click(trigger)

    fireEvent.click(within(await screen.findByRole('alertdialog')).getByTestId('decline-assignment-cancel'))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(declineAssignment).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Decline/ }))
  })

  it('confirming declines, removes the card, announces it and focuses the NEXT pending card heading', async () => {
    getMyDevices.mockResolvedValue(
      respond(
        [],
        [
          pending(),
          pending({ assetId: 'p2', assignmentId: 'as2', description: 'Second laptop' }),
          pending({ assetId: 'p3', assignmentId: 'as3', description: 'Third laptop' }),
        ],
      ),
    )
    declineAssignment.mockResolvedValue(undefined)
    await renderPage()

    fireEvent.click((await screen.findAllByRole('button', { name: /^Decline/ }))[0])
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Decline device' }))

    await waitFor(() => expect(declineAssignment).toHaveBeenCalledWith('as1'))
    await screen.findByRole('heading', { level: 2, name: 'Waiting for your confirmation (2)' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByRole('heading', { level: 3, name: 'MacBook Pro 14' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Second laptop' }))
    expect(screen.getByTestId('devices-status').textContent).toBe('Declined: MacBook Pro 14')
  })

  it('declining the last pending card moves focus to the page heading', async () => {
    declineAssignment.mockResolvedValue(undefined)
    await renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^Decline/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Decline device' }))

    await waitFor(() => expect(screen.queryByText(/Waiting for your confirmation/)).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 })))
  })

  it('declining the only device leaves the empty state', async () => {
    getMyDevices.mockResolvedValue(respond([], [pending()]))
    declineAssignment.mockResolvedValue(undefined)
    await renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^Decline/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Decline device' }))

    expect(await screen.findByTestId('devices-empty')).not.toBeNull()
  })

  it('a failed decline keeps the dialog open with the error and the card in place', async () => {
    declineAssignment.mockRejectedValue(new ApiError({ status: 500, title: 'Boom' }))
    await renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^Decline/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Decline device' }))

    const dialog = await screen.findByRole('alertdialog')
    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe('We could not decline this device. Try again.'),
    )
    expect(screen.getByRole('heading', { level: 3, name: 'MacBook Pro 14' })).not.toBeNull()
  })

  it('a stale decline (404) closes the dialog, says "no longer open" and refreshes the list', async () => {
    declineAssignment.mockRejectedValue(new ApiError({ status: 404, title: 'Not found' }))
    await renderPage()
    getMyDevices.mockResolvedValue(respond([held()], []))

    fireEvent.click(await screen.findByRole('button', { name: /^Decline/ }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Decline device' }))

    expect((await screen.findByTestId('devices-notice')).textContent).toContain('no longer open')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(getMyDevices).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(/Waiting for your confirmation/)).toBeNull())
  })
})
