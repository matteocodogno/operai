/**
 * @vitest-environment jsdom
 *
 * Component tests for EditAssetDialog (T32, specs/015-hardware-inventory;
 * design.md F6, § Dialogs, § Error and conflict catalogue; refs AC-1.9,
 * AC-3.6, AC-10.1). `assetsApi` is the only seam; the dialog renders inside a
 * memory router because the `serial_conflict` message links to the other asset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { ApiError } from '../lib/api'
import type { AssetView } from '../lib/types'

const { updateAsset } = vi.hoisted(() => ({ updateAsset: vi.fn() }))
vi.mock('../lib/assetsApi', () => ({ updateAsset }))

import EditAssetDialog from './EditAssetDialog'

const asset = (over: Partial<AssetView> = {}): AssetView => ({
  id: 'a1',
  entity: 'welld_ch',
  currency: 'CHF',
  category: 'laptop',
  description: 'MacBook Pro 14',
  serialNumber: 'SN123',
  purchaseDate: '2026-09-25',
  purchasePriceCents: 99815,
  status: 'in_stock',
  holder: null,
  pendingAssignment: null,
  locationNote: 'Shelf 3',
  supplier: 'Digitec',
  invoiceRef: 'INV-77',
  invoiceFile: null,
  toVerify: false,
  disposal: null,
  ...over,
})

const MANAGER = { canManageAssets: true, canManageLedger: false }
const ACCOUNTANT = { canManageAssets: false, canManageLedger: true }
const BOTH = { canManageAssets: true, canManageLedger: true }

const onSaved = vi.fn()
const onCancel = vi.fn()
const onConflict = vi.fn()

const renderDialog = async (
  over: Partial<AssetView> = {},
  capabilities: { canManageAssets: boolean; canManageLedger: boolean } = MANAGER,
) => {
  const rootRoute = createRootRoute({
    component: () => (
      <EditAssetDialog
        asset={asset(over)}
        capabilities={capabilities}
        onSaved={onSaved}
        onCancel={onCancel}
        onConflict={onConflict}
      />
    ),
  })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) })
  render(<RouterProvider router={router} />)
  return await screen.findByRole('dialog')
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } })
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

beforeEach(() => {
  updateAsset.mockResolvedValue(asset())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the field set depends on the capability (AC-10.1, F6)', () => {
  it('a manager gets the full set, prefilled', async () => {
    const dialog = await renderDialog()

    expect(within(dialog).getByRole('heading', { name: 'Edit asset' })).not.toBeNull()
    expect((within(dialog).getByLabelText('Category') as HTMLSelectElement).value).toBe('laptop')
    expect((within(dialog).getByLabelText('Description') as HTMLInputElement).value).toBe('MacBook Pro 14')
    expect((within(dialog).getByLabelText('Serial number') as HTMLInputElement).value).toBe('SN123')
    expect((within(dialog).getByLabelText('Purchase date') as HTMLInputElement).value).toBe('2026-09-25')
    expect((within(dialog).getByLabelText('Purchase price, CHF') as HTMLInputElement).value).toBe('998,15')
    expect((within(dialog).getByLabelText('Supplier') as HTMLInputElement).value).toBe('Digitec')
    expect((within(dialog).getByLabelText('Invoice reference') as HTMLInputElement).value).toBe('INV-77')
    expect((within(dialog).getByLabelText('Location / note') as HTMLInputElement).value).toBe('Shelf 3')
  })

  it('an accountant only gets supplier and invoice reference; the other fields are absent, not disabled', async () => {
    const dialog = await renderDialog({}, ACCOUNTANT)

    expect(within(dialog).getByRole('heading', { name: 'Edit invoice details' })).not.toBeNull()
    expect(within(dialog).getByLabelText('Supplier')).not.toBeNull()
    expect(within(dialog).getByLabelText('Invoice reference')).not.toBeNull()
    for (const label of ['Category', 'Description', 'Serial number', 'Purchase date', 'Purchase price', 'Location']) {
      expect(within(dialog).queryByLabelText(label, { exact: false })).toBeNull()
    }
  })

  it('both capabilities get the manager set', async () => {
    const dialog = await renderDialog({}, BOTH)
    expect(within(dialog).getByLabelText('Description')).not.toBeNull()
    expect(within(dialog).getByLabelText('Invoice reference')).not.toBeNull()
  })

  it('shows entity and currency as read-only text, never as inputs (AC-1.9)', async () => {
    const dialog = await renderDialog()

    expect(within(dialog).getByText('WellD CH')).not.toBeNull()
    expect(within(dialog).getByText('Entity and currency cannot be changed.')).not.toBeNull()
    expect(within(dialog).queryByLabelText('Entity')).toBeNull()
    expect(within(dialog).queryByLabelText('Currency')).toBeNull()
  })

  it('focuses the first field on open', async () => {
    const dialog = await renderDialog()
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Category'))
  })
})

describe('saving', () => {
  it('keeps Save disabled until something changed', async () => {
    await renderDialog()
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
    type('Location / note', 'Basel')
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('sends only the changed fields, and hands the saved asset to onSaved (AC-3.6)', async () => {
    const saved = asset({ locationNote: 'Basel office', description: 'MBP 14' })
    updateAsset.mockResolvedValue(saved)
    await renderDialog()

    type('Location / note', 'Basel office')
    type('Description', 'MBP 14')
    save()

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved))
    expect(updateAsset).toHaveBeenCalledWith('a1', { locationNote: 'Basel office', description: 'MBP 14' })
  })

  it('converts the price to cents and sends the date as typed', async () => {
    await renderDialog()
    type('Purchase price', '1000,5')
    type('Purchase date', '2026-09-20')
    save()

    await waitFor(() => expect(updateAsset).toHaveBeenCalled())
    expect(updateAsset).toHaveBeenCalledWith('a1', { purchasePriceCents: 100050, purchaseDate: '2026-09-20' })
  })

  it('sends null for an emptied optional field', async () => {
    await renderDialog()
    type('Serial number', '')
    type('Supplier', '  ')
    type('Location / note', '')
    save()

    await waitFor(() => expect(updateAsset).toHaveBeenCalled())
    expect(updateAsset).toHaveBeenCalledWith('a1', { serialNumber: null, supplier: null, locationNote: null })
  })

  it('an accountant sends only supplier and invoice reference (AC-10.1)', async () => {
    await renderDialog({}, ACCOUNTANT)
    type('Supplier', 'Brack')
    type('Invoice reference', 'INV-99')
    save()

    await waitFor(() => expect(updateAsset).toHaveBeenCalled())
    expect(updateAsset).toHaveBeenCalledWith('a1', { supplier: 'Brack', invoiceRef: 'INV-99' })
  })

  it('disables the form and marks Save busy while the request is in flight', async () => {
    updateAsset.mockReturnValue(new Promise(() => undefined))
    await renderDialog()
    type('Location / note', 'Basel')
    save()

    const submit = await screen.findByRole('button', { name: 'Saving…' })
    expect(submit.getAttribute('aria-busy')).toBe('true')
    // the form body is a disabled fieldset, so its inputs match :disabled
    expect(screen.getByLabelText('Location / note').matches(':disabled')).toBe(true)
  })

  it('Cancel calls onCancel without a request', async () => {
    await renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(updateAsset).not.toHaveBeenCalled()
  })
})

describe('client-side validation', () => {
  it('an empty description is refused on the field, with no request', async () => {
    await renderDialog()
    type('Description', '')
    save()

    const field = screen.getByLabelText('Description')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    const message = document.getElementById(field.getAttribute('aria-describedby')!)!
    expect(message.textContent).toBe('This field is required.')
    expect(updateAsset).not.toHaveBeenCalled()
  })

  it('a price with three decimals or zero is refused on the field', async () => {
    await renderDialog()
    type('Purchase price', '10,555')
    save()
    expect(
      document.getElementById(screen.getByLabelText('Purchase price, CHF').getAttribute('aria-describedby')!)!
        .textContent,
    ).toBe('Enter a price greater than 0, with at most two decimals.')

    type('Purchase price', '0')
    save()
    expect(screen.getByLabelText('Purchase price, CHF').getAttribute('aria-invalid')).toBe('true')
    expect(updateAsset).not.toHaveBeenCalled()
  })

  it('an emptied purchase date is refused on the field', async () => {
    await renderDialog()
    type('Purchase date', '')
    save()
    expect(screen.getByLabelText('Purchase date').getAttribute('aria-invalid')).toBe('true')
    expect(updateAsset).not.toHaveBeenCalled()
  })
})

describe('the invoice reference and a linked file (G6)', () => {
  const linked = { invoiceFile: { id: 'f1', fileName: 'invoice-77.pdf' } }

  it('warns, before saving, that a different reference unlinks the file', async () => {
    await renderDialog(linked)
    expect(screen.queryByTestId('edit-unlink-warning')).toBeNull()

    type('Invoice reference', 'INV-78')

    const warning = screen.getByTestId('edit-unlink-warning')
    expect(warning.textContent).toContain('invoice-77.pdf')
    expect(warning.textContent).toContain('unlinks')
    const field = screen.getByLabelText('Invoice reference')
    expect(field.getAttribute('aria-describedby')).toContain(warning.id)
  })

  it('does not warn when the reference is unchanged again, or when no file is linked', async () => {
    await renderDialog(linked)
    type('Invoice reference', 'INV-78')
    type('Invoice reference', 'INV-77')
    expect(screen.queryByTestId('edit-unlink-warning')).toBeNull()
  })

  it('does not warn without a linked file', async () => {
    await renderDialog()
    type('Invoice reference', 'INV-78')
    expect(screen.queryByTestId('edit-unlink-warning')).toBeNull()
  })
})

describe('server conflicts', () => {
  const fail = (error: unknown) => updateAsset.mockRejectedValue(error)

  it('serial_conflict is a field error naming the serial, with a link to the other asset', async () => {
    fail(
      new ApiError({
        status: 409,
        title: 'Conflict',
        code: 'serial_conflict',
        extras: { serialNumber: 'SN999', assetId: 'a9' },
      }),
    )
    await renderDialog()
    type('Serial number', 'SN999')
    save()

    const field = screen.getByLabelText('Serial number')
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'))
    const message = document.getElementById(field.getAttribute('aria-describedby')!)!
    expect(message.textContent).toContain('Serial number SN999 is already used by an active asset of this entity.')
    expect(within(message).getByRole('link', { name: 'View the asset that uses it' }).getAttribute('href')).toBe(
      '/assets/a9',
    )
    expect(screen.getByRole('dialog')).not.toBeNull()
  })

  it('serial_conflict without an asset id has no link', async () => {
    fail(new ApiError({ status: 409, title: 'Conflict', code: 'serial_conflict', extras: { serialNumber: 'SN999' } }))
    await renderDialog()
    type('Serial number', 'SN999')
    save()

    await waitFor(() => expect(screen.getByLabelText('Serial number').getAttribute('aria-invalid')).toBe('true'))
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('fiscal_year_closed is a banner naming the year; the price and date stay visible with the typed values', async () => {
    fail(new ApiError({ status: 409, title: 'Conflict', code: 'fiscal_year_closed', extras: { year: 2025 } }))
    await renderDialog()
    type('Purchase price', '1000')
    save()

    const banner = await screen.findByTestId('edit-year-closed')
    expect(banner.getAttribute('role')).toBe('alert')
    expect(banner.textContent).toBe('Price and purchase date cannot change because 2025 is closed.')
    expect((screen.getByLabelText('Purchase price, CHF') as HTMLInputElement).value).toBe('1000')
    expect(screen.getByLabelText('Purchase date')).not.toBeNull()
    expect(screen.getByLabelText('Purchase price, CHF').getAttribute('aria-describedby')).toContain(banner.id)
    expect(screen.getByLabelText('Purchase date').getAttribute('aria-describedby')).toContain(banner.id)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('fiscal_year_closed without a year uses the year-less banner', async () => {
    fail(new ApiError({ status: 409, title: 'Conflict', code: 'fiscal_year_closed' }))
    await renderDialog()
    type('Purchase price', '1000')
    save()

    expect((await screen.findByTestId('edit-year-closed')).textContent).toBe(
      'Price and purchase date cannot change because their year is closed.',
    )
  })

  it('asset_disposed hands over to the page', async () => {
    fail(new ApiError({ status: 409, title: 'Conflict', code: 'asset_disposed' }))
    await renderDialog()
    type('Location / note', 'x')
    save()

    await waitFor(() => expect(onConflict).toHaveBeenCalledWith('asset_disposed'))
  })

  it('a 404 hands over to the page as not found', async () => {
    fail(new ApiError({ status: 404, title: 'Not Found' }))
    await renderDialog()
    type('Location / note', 'x')
    save()

    await waitFor(() => expect(onConflict).toHaveBeenCalledWith('not_found'))
  })

  it('a 422 naming a field shows on that field', async () => {
    fail(new ApiError({ status: 422, title: 'Unprocessable', extras: { field: 'purchasePriceCents' } }))
    await renderDialog()
    type('Purchase price', '5')
    save()

    await waitFor(() => expect(screen.getByLabelText('Purchase price, CHF').getAttribute('aria-invalid')).toBe('true'))
  })

  it('a 422 without a known field shows the general validation message', async () => {
    fail(new ApiError({ status: 422, title: 'Unprocessable' }))
    await renderDialog()
    type('Location / note', 'x')
    save()

    expect((await screen.findByTestId('edit-asset-error')).textContent).toBe(
      'Check the highlighted fields and try again.',
    )
  })

  it('a 403 says the change is not allowed and keeps the input', async () => {
    fail(new ApiError({ status: 403, title: 'Forbidden' }))
    await renderDialog()
    type('Location / note', 'x')
    save()

    expect((await screen.findByTestId('edit-asset-error')).textContent).toBe(
      'You are not allowed to change these details.',
    )
    expect((screen.getByLabelText('Location / note') as HTMLInputElement).value).toBe('x')
  })

  it('a 503 says authorization is unavailable and nothing was changed', async () => {
    fail(new ApiError({ status: 503, title: 'Unavailable' }))
    await renderDialog()
    type('Location / note', 'x')
    save()

    expect((await screen.findByTestId('edit-asset-error')).textContent).toContain('Authorization service unavailable')
  })

  it('a network failure shows the connection message and keeps the input', async () => {
    fail(new TypeError('Failed to fetch'))
    await renderDialog()
    type('Location / note', 'x')
    save()

    expect((await screen.findByTestId('edit-asset-error')).textContent).toContain('Could not reach the server')
    expect((screen.getByLabelText('Location / note') as HTMLInputElement).value).toBe('x')
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('editing a field clears that field error', async () => {
    fail(new ApiError({ status: 409, title: 'Conflict', code: 'serial_conflict', extras: { serialNumber: 'SN999' } }))
    await renderDialog()
    type('Serial number', 'SN999')
    save()
    await waitFor(() => expect(screen.getByLabelText('Serial number').getAttribute('aria-invalid')).toBe('true'))

    type('Serial number', 'SN1000')

    expect(screen.getByLabelText('Serial number').getAttribute('aria-invalid')).toBeNull()
  })
})
