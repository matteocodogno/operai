/**
 * @vitest-environment jsdom
 *
 * VatCodesCard (T24, specs/20261118-refund-accounting-export, design S3, F2, F3; AC-1.4, AC-1.5, AC-1.7, AC-1.10,
 * AC-1.11): the list with its fixed rates, Add, Deactivate (confirmed) and Reactivate, a stale list's 409,
 * read-only without `settings:manage`, and above all NO edit control for a rate (AC-1.5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return {
    ...original,
    listVatCodes: vi.fn(),
    createVatCode: vi.fn(),
    deactivateVatCode: vi.fn(),
    reactivateVatCode: vi.fn(),
  }
})

import * as accountingApi from '../../lib/accountingApi'
import type { VatCode } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'
import VatCodesCard from './VatCodesCard'

const vatCode = (overrides: Partial<VatCode> = {}): VatCode => ({
  id: 'v1',
  code: 'IMP81',
  label: 'Imposta piena',
  rateBasisPoints: 810,
  ratePercent: '8.1',
  active: true,
  createdAt: '2026-03-01T09:00:00Z',
  createdByEmail: 'admin@welld.ch',
  history: [],
  ...overrides,
})

const ACTIVE = vatCode()
const INACTIVE = vatCode({ id: 'v2', code: 'OLD77', label: 'Vecchia aliquota', ratePercent: '7.7', active: false })

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })
const pending = <T,>() => new Promise<T>(() => {})

beforeEach(() => {
  vi.mocked(accountingApi.listVatCodes).mockResolvedValue([ACTIVE, INACTIVE])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.documentElement.removeAttribute('lang')
})

const renderCard = async (canManage = true) => {
  const view = render(<VatCodesCard canManage={canManage} />)
  await screen.findByTestId('settings-vat-codes-table')
  return view
}

describe('VatCodesCard: the list', () => {
  it('shows a polite loading line and a skeleton while the list loads', () => {
    vi.mocked(accountingApi.listVatCodes).mockReturnValue(pending())
    render(<VatCodesCard canManage />)
    expect(screen.getByText('Loading VAT codes…').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('lists code (row header, mono), label, rate as a percent, status and who added it and when', async () => {
    await renderCard()
    expect(screen.getByRole('heading', { name: 'VAT codes' })).not.toBeNull()
    const row = screen.getByTestId('settings-vat-code-row-v1')
    expect(within(row).getByRole('rowheader').textContent).toBe('IMP81')
    expect(within(row).getByText('Imposta piena')).not.toBeNull()
    expect(within(row).getByText('8.1%')).not.toBeNull()
    expect(within(row).getByText('Active')).not.toBeNull()
    expect(within(row).getByText('admin@welld.ch · 01.03.2026')).not.toBeNull()
    expect(within(screen.getByTestId('settings-vat-code-row-v2')).getByText('Inactive')).not.toBeNull()
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Code',
      'Label',
      'VAT rate',
      'Status',
      'Added',
      'Actions',
    ])
  })

  it('writes the rate with the viewer’s decimal mark', async () => {
    document.documentElement.setAttribute('lang', 'it')
    await renderCard()
    expect(within(screen.getByTestId('settings-vat-code-row-v1')).getByText('8,1%')).not.toBeNull()
  })

  it('says there are no VAT codes yet', async () => {
    vi.mocked(accountingApi.listVatCodes).mockResolvedValue([])
    render(<VatCodesCard canManage />)
    expect((await screen.findByTestId('settings-vat-codes-empty')).textContent).toContain('No VAT codes yet')
  })

  it('shows a retryable error, and is left out entirely on a 403', async () => {
    vi.mocked(accountingApi.listVatCodes).mockRejectedValueOnce(problem(500))
    render(<VatCodesCard canManage />)
    expect((await screen.findByTestId('error-banner')).textContent).toContain('Could not load the VAT codes.')
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await screen.findByTestId('settings-vat-codes-table')

    cleanup()
    vi.mocked(accountingApi.listVatCodes).mockRejectedValue(problem(403))
    const { container } = render(<VatCodesCard canManage />)
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })
})

describe('VatCodesCard: no rate edit control (AC-1.5)', () => {
  it('has Deactivate and Reactivate as its only row actions, and no field or edit affordance anywhere', async () => {
    await renderCard()
    const table = screen.getByTestId('settings-vat-codes-table')
    expect(
      within(table)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Deactivate VAT code IMP81', 'Reactivate VAT code OLD77'])
    expect(table.querySelector('input, select, textarea')).toBeNull()
    expect(screen.queryByRole('button', { name: /edit|modify|change|rate/i })).toBeNull()
    expect(screen.queryByRole('link', { name: /edit/i })).toBeNull()
  })

  it('is read-only without settings:manage: no Add, no Actions column', async () => {
    await renderCard(false)
    expect(screen.queryByTestId('settings-vat-codes-add')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull()
    expect(within(screen.getByTestId('settings-vat-codes-table')).queryAllByRole('button')).toHaveLength(0)
  })
})

describe('VatCodesCard: Add VAT code (AC-1.4)', () => {
  it('adds a code beside the card, shows the row and a confirmation, and returns focus to Add', async () => {
    const created = vatCode({ id: 'v3', code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', rateBasisPoints: 0 })
    vi.mocked(accountingApi.createVatCode).mockResolvedValue(created)
    vi.mocked(accountingApi.listVatCodes)
      .mockResolvedValueOnce([ACTIVE, INACTIVE])
      .mockResolvedValue([ACTIVE, INACTIVE, created])
    await renderCard()

    const addButton = screen.getByTestId('settings-vat-codes-add')
    expect(addButton.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(addButton)
    const dialog = screen.getByRole('dialog', { name: 'Add VAT code' })
    expect(screen.getByTestId('settings-vat-codes-card').contains(dialog)).toBe(false)
    expect(document.querySelectorAll('form form')).toHaveLength(0)

    fireEvent.change(screen.getByTestId('add-vat-code-code'), { target: { value: 'novat' } })
    fireEvent.change(screen.getByTestId('add-vat-code-label'), { target: { value: 'Senza IVA' } })
    fireEvent.change(screen.getByTestId('add-vat-code-rate'), { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('add-vat-code-submit'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(accountingApi.createVatCode).toHaveBeenCalledWith({ code: 'NOVAT', label: 'Senza IVA', ratePercent: '0' })
    expect(within(screen.getByTestId('settings-vat-code-row-v3')).getByText('0%')).not.toBeNull()
    expect(screen.getByTestId('settings-vat-codes-success').textContent).toBe('VAT code NOVAT added')
    expect(document.activeElement).toBe(screen.getByTestId('settings-vat-codes-add'))
    await waitFor(() => expect(accountingApi.listVatCodes).toHaveBeenCalledTimes(2))
  })

  it('names a duplicate, deactivated one with the reactivate hint, and Cancel returns focus to Add', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-vat-codes-add'))
    fireEvent.change(screen.getByTestId('add-vat-code-code'), { target: { value: 'old77' } })
    fireEvent.blur(screen.getByTestId('add-vat-code-code'))
    expect(screen.getByTestId('add-vat-code-code-error').textContent).toBe(
      'VAT code OLD77 already exists but is deactivated. Reactivate it from the list.',
    )
    fireEvent.click(screen.getByTestId('add-vat-code-cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(accountingApi.createVatCode).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByTestId('settings-vat-codes-add'))
  })
})

describe('VatCodesCard: Deactivate and Reactivate (AC-1.10, AC-1.11)', () => {
  it('asks first with its own consequences, and Cancel does nothing', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-vat-code-deactivate-v1'))
    const dialog = screen.getByRole('alertdialog', { name: 'Deactivate VAT code IMP81?' })
    expect(within(dialog).getByText(/Its rate never changes\./)).not.toBeNull()
    expect(within(dialog).getByText(/as the foreign-currency VAT code/)).not.toBeNull()
    fireEvent.click(screen.getByTestId('deactivate-vat-code-cancel'))
    expect(accountingApi.deactivateVatCode).not.toHaveBeenCalled()
  })

  it('deactivates on confirm, swaps the action to Reactivate, confirms and focuses the row header', async () => {
    vi.mocked(accountingApi.deactivateVatCode).mockResolvedValue({ ...ACTIVE, active: false })
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-vat-code-deactivate-v1'))
    fireEvent.click(screen.getByTestId('deactivate-vat-code-confirm'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(accountingApi.deactivateVatCode).toHaveBeenCalledWith('v1')
    const row = screen.getByTestId('settings-vat-code-row-v1')
    expect(within(row).getByText('Inactive')).not.toBeNull()
    expect(screen.getByTestId('settings-vat-code-reactivate-v1')).not.toBeNull()
    expect(screen.getByTestId('settings-vat-codes-success').textContent).toBe('VAT code IMP81 deactivated')
    expect(document.activeElement).toBe(within(row).getByRole('rowheader'))
  })

  it('reactivates at once, with no dialog', async () => {
    vi.mocked(accountingApi.reactivateVatCode).mockResolvedValue({ ...INACTIVE, active: true })
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-vat-code-reactivate-v2'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await waitFor(() => expect(screen.getByTestId('settings-vat-code-deactivate-v2')).not.toBeNull())
    expect(screen.getByTestId('settings-vat-codes-success').textContent).toBe('VAT code OLD77 reactivated')
    expect(document.activeElement).toBe(within(screen.getByTestId('settings-vat-code-row-v2')).getByRole('rowheader'))
  })

  it('a stale list on reactivate (409 already_active) shows an alert naming the code and reloads', async () => {
    vi.mocked(accountingApi.reactivateVatCode).mockRejectedValue(problem(409, 'already_active'))
    await renderCard()
    vi.mocked(accountingApi.listVatCodes).mockResolvedValue([ACTIVE, { ...INACTIVE, active: true }])
    fireEvent.click(screen.getByTestId('settings-vat-code-reactivate-v2'))

    expect((await screen.findByTestId('settings-vat-codes-action-error')).textContent).toContain(
      'VAT code OLD77 is already active.',
    )
    await waitFor(() => expect(accountingApi.listVatCodes).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('settings-vat-code-deactivate-v2')).not.toBeNull())
  })

  it('a stale list on deactivate (409 already_inactive) closes the confirm, says so and reloads', async () => {
    vi.mocked(accountingApi.deactivateVatCode).mockRejectedValue(problem(409, 'already_inactive'))
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-vat-code-deactivate-v1'))
    fireEvent.click(screen.getByTestId('deactivate-vat-code-confirm'))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('settings-vat-codes-action-error').textContent).toContain(
      'VAT code IMP81 is already deactivated.',
    )
    await waitFor(() => expect(accountingApi.listVatCodes).toHaveBeenCalledTimes(2))
  })

  it('keeps the confirm open on a server failure, busy while saving', async () => {
    vi.mocked(accountingApi.deactivateVatCode).mockRejectedValueOnce(problem(500)).mockReturnValueOnce(pending())
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-vat-code-deactivate-v1'))
    fireEvent.click(screen.getByTestId('deactivate-vat-code-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('deactivate-vat-code-error').textContent).toBe('Could not save. Try again.'),
    )
    fireEvent.click(screen.getByTestId('deactivate-vat-code-confirm'))
    await waitFor(() => expect(screen.getByTestId('deactivate-vat-code-confirm').textContent).toBe('Deactivating…'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).not.toBeNull()
  })
})
