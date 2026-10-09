/**
 * @vitest-environment jsdom
 *
 * Component tests for DisposeDialog (T34, specs/015-hardware-inventory; design.md
 * F10, § Irreversible actions, § Error and conflict catalogue; refs AC-7.1,
 * AC-7.3, AC-7.4, AC-7.5). `ledgerApi` is the only seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { AssetView } from '../lib/types'

const { disposeAsset } = vi.hoisted(() => ({ disposeAsset: vi.fn() }))
vi.mock('../lib/ledgerApi', () => ({ disposeAsset }))

import DisposeDialog from './DisposeDialog'

const asset = (over: Partial<AssetView> = {}): AssetView => ({
  id: 'a1',
  entity: 'welld_ch',
  currency: 'CHF',
  category: 'laptop',
  description: 'MacBook Pro 14',
  serialNumber: 'SN123',
  purchaseDate: '2026-09-25',
  purchasePriceCents: 99815,
  status: 'assigned',
  holder: { id: 'u1', name: 'Anna Rossi', status: 'active' },
  pendingAssignment: null,
  locationNote: null,
  supplier: null,
  invoiceRef: null,
  invoiceFile: null,
  toVerify: false,
  disposal: null,
  ...over,
})

const onDisposed = vi.fn()
const onCancel = vi.fn()
const onConflict = vi.fn()

const renderDialog = async (over: Partial<AssetView> = {}) => {
  render(<DisposeDialog asset={asset(over)} onDisposed={onDisposed} onCancel={onCancel} onConflict={onConflict} />)
  return await screen.findByRole('alertdialog')
}

const dateField = () => screen.getByLabelText('Disposal date') as HTMLInputElement
const reasonRadio = (label: string) => screen.getByRole('radio', { name: label }) as HTMLInputElement
const salePrice = () => screen.queryByLabelText('Sale price, CHF', { exact: false }) as HTMLInputElement | null
const acknowledge = () => fireEvent.click(screen.getByRole('checkbox'))
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Dispose asset' }))
const fill = (reason: string, date = '2026-10-05') => {
  fireEvent.change(dateField(), { target: { value: date } })
  fireEvent.click(reasonRadio(reason))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
  disposeAsset.mockResolvedValue(asset({ status: 'disposed' }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the form (F10)', () => {
  it('is an irreversible-action dialog for this asset, with the date defaulting to today and bounded by the purchase date', async () => {
    const dialog = await renderDialog()

    expect(within(dialog).getByRole('heading', { name: 'Dispose of MacBook Pro 14?' })).not.toBeNull()
    expect(dateField().value).toBe('2026-10-07')
    expect(dateField().min).toBe('2026-09-25')
    expect(document.activeElement).toBe(dateField())
  })

  it('offers the five reasons as one radio group, the last labelled "Written off as lost"', async () => {
    await renderDialog()

    const group = screen.getByRole('radiogroup', { name: 'Reason' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => (radio as HTMLInputElement).labels?.[0]?.textContent),
    ).toEqual(['Sold', 'Ceded to an employee', 'Scrapped', 'Returned to the vendor', 'Written off as lost'])
    expect(
      within(group)
        .getAllByRole('radio')
        .every((radio) => !(radio as HTMLInputElement).checked),
    ).toBe(true)
  })

  it('shows the sale price field only for "sold" and "ceded to an employee" (AC-7.3)', async () => {
    await renderDialog()
    expect(salePrice()).toBeNull()

    fireEvent.click(reasonRadio('Sold'))
    expect(salePrice()).not.toBeNull()

    fireEvent.click(reasonRadio('Scrapped'))
    expect(salePrice()).toBeNull()

    fireEvent.click(reasonRadio('Ceded to an employee'))
    expect(salePrice()).not.toBeNull()

    fireEvent.click(reasonRadio('Written off as lost'))
    expect(salePrice()).toBeNull()
  })

  it('states the consequence: the entity, the date, the zero book value and the holder it is removed from', async () => {
    const dialog = await renderDialog()
    fireEvent.change(dateField(), { target: { value: '2026-10-05' } })

    const consequence = document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent!
    expect(consequence).toContain("MacBook Pro 14 comes off WellD CH's books on 05.10.2026.")
    expect(consequence).toContain('Its book value becomes 0,00 CHF')
    expect(consequence).toContain('it is removed from Anna Rossi')
    expect(consequence).toContain('This cannot be undone.')
  })

  it('leaves the holder out of the consequence for an asset nobody holds', async () => {
    const dialog = await renderDialog({ status: 'in_stock', holder: null })
    const consequence = document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent!
    expect(consequence).not.toContain('removed from')
  })

  it('requires the acknowledgement, whose label is the whole sentence, before Confirm is enabled', async () => {
    await renderDialog()
    const button = screen.getByRole('button', { name: 'Dispose asset' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByLabelText('I understand this cannot be undone.')).not.toBeNull()

    acknowledge()

    expect(button.disabled).toBe(false)
  })

  it('Cancel calls onCancel without a request', async () => {
    await renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(disposeAsset).not.toHaveBeenCalled()
  })
})

describe('validation before any request', () => {
  it('asks for a reason', async () => {
    await renderDialog()
    acknowledge()
    confirm()

    const group = screen.getByRole('radiogroup', { name: 'Reason' })
    expect(document.getElementById(group.getAttribute('aria-describedby')!)!.textContent).toBe('Choose a reason.')
    expect(disposeAsset).not.toHaveBeenCalled()
  })

  it('asks for a date', async () => {
    await renderDialog()
    fill('Scrapped', '')
    acknowledge()
    confirm()

    expect(dateField().getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(dateField().getAttribute('aria-describedby')!)!.textContent).toBe(
      'Enter the disposal date.',
    )
    expect(disposeAsset).not.toHaveBeenCalled()
  })

  it('refuses a sale price with three decimals', async () => {
    await renderDialog()
    fill('Sold')
    fireEvent.change(salePrice()!, { target: { value: '12,345' } })
    acknowledge()
    confirm()

    expect(salePrice()!.getAttribute('aria-invalid')).toBe('true')
    expect(disposeAsset).not.toHaveBeenCalled()
  })
})

describe('disposing (AC-7.1, AC-7.3)', () => {
  it('sends the date and reason, and no sale price for a reason that takes none', async () => {
    const disposed = asset({ status: 'disposed' })
    disposeAsset.mockResolvedValue(disposed)
    await renderDialog()
    fill('Scrapped')
    acknowledge()
    confirm()

    await waitFor(() => expect(onDisposed).toHaveBeenCalledWith(disposed))
    expect(disposeAsset).toHaveBeenCalledWith('a1', { disposedOn: '2026-10-05', reason: 'scrapped' })
  })

  it('sends the sale price in cents for a sale', async () => {
    await renderDialog()
    fill('Sold')
    fireEvent.change(salePrice()!, { target: { value: '120,50' } })
    acknowledge()
    confirm()

    await waitFor(() => expect(disposeAsset).toHaveBeenCalled())
    expect(disposeAsset).toHaveBeenCalledWith('a1', { disposedOn: '2026-10-05', reason: 'sold', salePriceCents: 12050 })
  })

  it('the sale price is optional', async () => {
    await renderDialog()
    fill('Ceded to an employee')
    acknowledge()
    confirm()

    await waitFor(() => expect(disposeAsset).toHaveBeenCalled())
    expect(disposeAsset).toHaveBeenCalledWith('a1', { disposedOn: '2026-10-05', reason: 'ceded_to_employee' })
  })

  it('never sends a price typed before the reason was changed to one that takes none', async () => {
    await renderDialog()
    fill('Sold')
    fireEvent.change(salePrice()!, { target: { value: '99' } })
    fireEvent.click(reasonRadio('Scrapped'))
    acknowledge()
    confirm()

    await waitFor(() => expect(disposeAsset).toHaveBeenCalled())
    expect(disposeAsset).toHaveBeenCalledWith('a1', { disposedOn: '2026-10-05', reason: 'scrapped' })
  })

  it('shows the in-flight state: Confirm busy, the form locked', async () => {
    disposeAsset.mockReturnValue(new Promise(() => undefined))
    await renderDialog()
    fill('Scrapped')
    acknowledge()
    confirm()

    const busy = await screen.findByRole('button', { name: /Disposing/ })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    expect(dateField().matches(':disabled')).toBe(true)
  })
})

describe('server conflicts (error catalogue)', () => {
  const submitWith = async (error: unknown, reason = 'Scrapped') => {
    disposeAsset.mockRejectedValue(error)
    await renderDialog()
    fill(reason)
    acknowledge()
    confirm()
  }

  it('fiscal_year_closed names the year on the date field and keeps what was typed', async () => {
    await submitWith(
      new ApiError({ status: 409, title: 'Conflict', code: 'fiscal_year_closed', extras: { year: 2025 } }),
    )

    await waitFor(() => expect(dateField().getAttribute('aria-invalid')).toBe('true'))
    expect(document.getElementById(dateField().getAttribute('aria-describedby')!)!.textContent).toBe(
      '2025 is closed for WellD CH. Choose a date in an open year.',
    )
    expect(dateField().value).toBe('2026-10-05')
    expect(reasonRadio('Scrapped').checked).toBe(true)
    expect(onDisposed).not.toHaveBeenCalled()
  })

  it('fiscal_year_closed without a year still points at the date', async () => {
    await submitWith(new ApiError({ status: 409, title: 'Conflict', code: 'fiscal_year_closed' }))

    await waitFor(() => expect(dateField().getAttribute('aria-invalid')).toBe('true'))
    expect(document.getElementById(dateField().getAttribute('aria-describedby')!)!.textContent).toBe(
      'The disposal date falls in a closed year. Choose a date in an open year.',
    )
  })

  it('disposed_before_purchase shows on the date field with the purchase date (AC-7.4)', async () => {
    await submitWith(new ApiError({ status: 422, title: 'Unprocessable', code: 'disposed_before_purchase' }))

    await waitFor(() => expect(dateField().getAttribute('aria-invalid')).toBe('true'))
    expect(document.getElementById(dateField().getAttribute('aria-describedby')!)!.textContent).toBe(
      'The disposal date cannot be before the purchase date (25.09.2026).',
    )
  })

  it('sale_price_not_allowed is a form alert', async () => {
    await submitWith(new ApiError({ status: 422, title: 'Unprocessable', code: 'sale_price_not_allowed' }))

    expect((await screen.findByTestId('dispose-asset-error')).textContent).toContain(
      'A sale price can only be recorded',
    )
  })

  it('assignment_pending (AC-7.5) is shown inline and the page is told to refresh', async () => {
    await submitWith(new ApiError({ status: 409, title: 'Conflict', code: 'assignment_pending' }))

    expect((await screen.findByTestId('dispose-asset-error')).textContent).toBe(
      'This asset has a pending assignment to the selected person. Cancel it first.',
    )
    expect(onConflict).toHaveBeenCalledWith('assignment_pending')
    expect(screen.getByRole('alertdialog')).not.toBeNull()
  })

  it('asset_disposed is handed to the page', async () => {
    await submitWith(new ApiError({ status: 409, title: 'Conflict', code: 'asset_disposed' }))
    await waitFor(() => expect(onConflict).toHaveBeenCalledWith('asset_disposed'))
  })

  it('a 404 is handed to the page', async () => {
    await submitWith(new ApiError({ status: 404, title: 'Not Found' }))
    await waitFor(() => expect(onConflict).toHaveBeenCalledWith('not_found'))
  })

  it('a 422 without a code shows the general validation message', async () => {
    await submitWith(new ApiError({ status: 422, title: 'Unprocessable' }))
    expect((await screen.findByTestId('dispose-asset-error')).textContent).toBe(
      'Check the highlighted fields and try again.',
    )
  })

  it('a 503 says authorization is unavailable, and nothing was changed', async () => {
    await submitWith(new ApiError({ status: 503, title: 'Unavailable' }))
    expect((await screen.findByTestId('dispose-asset-error')).textContent).toContain(
      'Authorization service unavailable',
    )
  })

  it('a network failure keeps the dialog, the form and the acknowledgement for a retry', async () => {
    await submitWith(new TypeError('Failed to fetch'))

    expect((await screen.findByTestId('dispose-asset-error')).textContent).toContain('Could not reach the server')
    expect(dateField().value).toBe('2026-10-05')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('button', { name: 'Dispose asset' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('changing the date clears the date error', async () => {
    await submitWith(
      new ApiError({ status: 409, title: 'Conflict', code: 'fiscal_year_closed', extras: { year: 2025 } }),
    )
    await waitFor(() => expect(dateField().getAttribute('aria-invalid')).toBe('true'))

    fireEvent.change(dateField(), { target: { value: '2026-10-06' } })

    expect(dateField().getAttribute('aria-invalid')).toBeNull()
  })
})
