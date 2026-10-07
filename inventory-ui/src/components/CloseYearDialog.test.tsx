/**
 * @vitest-environment jsdom
 *
 * Component tests for CloseYearDialog (T38, specs/015-hardware-inventory; design.md
 * § Irreversible actions "Close year", § Error and conflict catalogue; refs AC-8.4,
 * AC-8.5, AC-8.7). `fiscalYearsApi` is the seam; the dialog shell is the real one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { FiscalYearView } from '../lib/types'

const { closeFiscalYear } = vi.hoisted(() => ({ closeFiscalYear: vi.fn() }))
vi.mock('../lib/fiscalYearsApi', () => ({ closeFiscalYear }))

import CloseYearDialog from './CloseYearDialog'

const ROLL = {
  openingCents: 2168900,
  disposalsCents: 53000,
  purchasesCents: 1829589,
  depreciationCents: 2245831,
  closingCents: 1699658,
}

const CLOSED: FiscalYearView = {
  entity: 'welld_ch',
  year: 2026,
  currency: 'CHF',
  status: 'closed',
  closedAt: '2026-12-31T10:00:00Z',
  rollForward: ROLL,
  assets: [],
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const problem = (status: number, code: string) => new ApiError({ status, title: code, code, detail: code })

const setup = (over: Partial<{ onClosed: () => void; onStale: () => void; onCancel: () => void }> = {}) => {
  const handlers = { onClosed: vi.fn(), onStale: vi.fn(), onCancel: vi.fn(), ...over }
  render(<CloseYearDialog entity="welld_ch" year={2026} currency="CHF" rollForward={ROLL} {...handlers} />)
  return handlers
}

const confirm = () => screen.getByRole('button', { name: 'Close 2026' })
const acknowledge = () => fireEvent.click(screen.getByRole('checkbox', { name: /cannot be reopened/i }))

describe('CloseYearDialog — content', () => {
  it('is an alertdialog showing the five roll-forward lines with currency', () => {
    setup()
    const dialog = screen.getByRole('alertdialog', { name: 'Close fiscal year 2026?' })
    expect(within(dialog).getAllByRole('rowheader')).toHaveLength(5)
    expect(within(dialog).getByText('16996,58 CHF')).not.toBeNull()
  })

  it('states that the year can never be reopened and nothing dated in it can change', () => {
    setup()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.getAttribute('aria-describedby')).not.toBeNull()
    expect(dialog.textContent).toMatch(/can never be reopened/i)
    expect(dialog.textContent).toMatch(/nothing dated in 2026 or earlier can be changed/i)
    expect(dialog.textContent).toContain('WellD CH')
  })

  it('keeps Close disabled until the acknowledgement is ticked and sends nothing before', () => {
    setup()
    expect((confirm() as HTMLButtonElement).disabled).toBe(true)
    acknowledge()
    expect((confirm() as HTMLButtonElement).disabled).toBe(false)
    expect(closeFiscalYear).not.toHaveBeenCalled()
  })

  it('cancels from Cancel without calling the API', () => {
    const { onCancel } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(closeFiscalYear).not.toHaveBeenCalled()
  })
})

describe('CloseYearDialog — closing', () => {
  it('posts the close and hands the closed view to the page', async () => {
    closeFiscalYear.mockResolvedValue(CLOSED)
    const { onClosed } = setup()
    acknowledge()
    fireEvent.click(confirm())
    await waitFor(() => expect(onClosed).toHaveBeenCalledWith(CLOSED))
    expect(closeFiscalYear).toHaveBeenCalledWith('welld_ch', 2026)
  })

  it('locks the dialog while in flight and cannot be submitted twice', async () => {
    closeFiscalYear.mockReturnValue(new Promise(() => undefined))
    const { onCancel } = setup()
    acknowledge()
    fireEvent.click(confirm())
    const busy = await screen.findByRole('button', { name: /Closing/ })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(closeFiscalYear).toHaveBeenCalledTimes(1)
  })

  it('previous_year_open: names the year to close first, inline, dialog stays open', async () => {
    closeFiscalYear.mockRejectedValue(problem(409, 'previous_year_open'))
    const { onClosed } = setup()
    acknowledge()
    fireEvent.click(confirm())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Close 2025 first.')
    expect(screen.getByRole('alertdialog')).not.toBeNull()
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('nothing_to_close: says the year has no assets, inline', async () => {
    closeFiscalYear.mockRejectedValue(problem(409, 'nothing_to_close'))
    setup()
    acknowledge()
    fireEvent.click(confirm())
    expect((await screen.findByRole('alert')).textContent).toBe('2026 has no assets to close.')
    expect(screen.getByRole('alertdialog')).not.toBeNull()
  })

  it('already_closed: shows a conflict acknowledgement, then asks the page to refresh', async () => {
    closeFiscalYear.mockRejectedValue(problem(409, 'already_closed'))
    const { onStale, onClosed } = setup()
    acknowledge()
    fireEvent.click(confirm())
    const guardrail = await screen.findByRole('alertdialog', { name: 'Already closed' })
    expect(guardrail.textContent).toContain('2026 is already closed.')
    expect(onStale).not.toHaveBeenCalled()
    fireEvent.click(within(guardrail).getByRole('button', { name: 'OK' }))
    expect(onStale).toHaveBeenCalledTimes(1)
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('503: says the authorization service is unavailable and nothing was changed, keeps the dialog', async () => {
    closeFiscalYear.mockRejectedValue(new ApiError({ status: 503, title: 'down', detail: 'down' }))
    setup()
    acknowledge()
    fireEvent.click(confirm())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Authorization service unavailable')
    expect((confirm() as HTMLButtonElement).disabled).toBe(false)
  })

  it('network failure: shows the network message and allows another attempt', async () => {
    closeFiscalYear.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(CLOSED)
    const { onClosed } = setup()
    acknowledge()
    fireEvent.click(confirm())
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i)
    fireEvent.click(confirm())
    await waitFor(() => expect(onClosed).toHaveBeenCalledWith(CLOSED))
  })
})
