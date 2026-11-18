/**
 * @vitest-environment jsdom
 *
 * ForeignCurrencyVatDialog (T25, specs/20261118-refund-accounting-export, design S6d, F4; AC-2.5, AC-2.6, AC-2.8): active codes
 * and "None designated", Save disabled until the choice differs, a deactivated designation starting on
 * "Choose…", a 422 as a field error with the options reloaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return { ...original, listLedgerAccounts: vi.fn(), listVatCodes: vi.fn(), putForeignCurrencyVatCode: vi.fn() }
})

import * as accountingApi from '../../lib/accountingApi'
import type { ForeignCurrencyVatCodeState, VatCode } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'
import ForeignCurrencyVatDialog from './ForeignCurrencyVatDialog'

const vat = (id: string, code: string, label: string, ratePercent: string, active = true): VatCode => ({
  id,
  code,
  label,
  rateBasisPoints: Math.round(Number(ratePercent) * 100),
  ratePercent,
  active,
  createdAt: '2026-03-01T09:00:00Z',
  createdByEmail: 'admin@welld.ch',
  history: [],
})

const VAT_CODES = [
  vat('v1', 'NOVAT', 'Senza IVA', '0'),
  vat('v2', 'IMP81', 'Imposta piena', '8.1'),
  vat('v3', 'OLD', 'Vecchia', '7.7', false),
]

const state = (code: VatCode | null, usable = true): ForeignCurrencyVatCodeState => ({
  foreignCurrencyVatCode: code
    ? { id: code.id, code: code.code, label: code.label, ratePercent: code.ratePercent, active: code.active }
    : null,
  foreignCurrencyVatCodeUsable: code !== null && usable,
  foreignCurrencyVatCodeHistory: [],
})

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })

const setup = async (current: ForeignCurrencyVatCodeState) => {
  const onSaved = vi.fn()
  const onCancel = vi.fn()
  render(<ForeignCurrencyVatDialog state={current} onSaved={onSaved} onCancel={onCancel} />)
  await waitFor(() => expect(select().disabled).toBe(false))
  return { onSaved, onCancel }
}

const select = () => screen.getByTestId('foreign-currency-vat-select') as HTMLSelectElement
const save = () => screen.getByTestId('foreign-currency-vat-submit') as HTMLButtonElement

beforeEach(() => {
  vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([])
  vi.mocked(accountingApi.listVatCodes).mockResolvedValue(VAT_CODES)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ForeignCurrencyVatDialog', () => {
  it('is titled, explains what the code is for, and offers active VAT codes and "None designated"', async () => {
    await setup(state(VAT_CODES[0]))
    expect(screen.getByRole('dialog', { name: 'VAT code for foreign-currency lines' })).not.toBeNull()
    expect(screen.getByText('WellD CH lines in a currency other than CHF get this code by default.')).not.toBeNull()
    expect(Array.from(select().options).map((option) => option.textContent)).toEqual([
      'None designated',
      'NOVAT — Senza IVA (0%)',
      'IMP81 — Imposta piena (8.1%)',
    ])
    expect(select().value).toBe('v1')
  })

  it('keeps Save disabled until the choice differs, then designates the code by id', async () => {
    const saved = state(VAT_CODES[1])
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockResolvedValue(saved)
    const { onSaved } = await setup(state(VAT_CODES[0]))
    expect(save().disabled).toBe(true)

    fireEvent.change(select(), { target: { value: 'v2' } })
    expect(save().disabled).toBe(false)
    fireEvent.click(save())

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved))
    expect(accountingApi.putForeignCurrencyVatCode).toHaveBeenCalledWith('v2')
  })

  it('clears the designation with None designated (null)', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockResolvedValue(state(null))
    await setup(state(VAT_CODES[0]))
    fireEvent.change(select(), { target: { value: '__none__' } })
    fireEvent.click(save())
    await waitFor(() => expect(accountingApi.putForeignCurrencyVatCode).toHaveBeenCalledWith(null))
  })

  it('starts with nothing designated on None designated, Save disabled', async () => {
    await setup(state(null))
    expect(select().value).toBe('__none__')
    expect(save().disabled).toBe(true)
  })

  it('starts a deactivated designation on "Choose…" with a hint and Save disabled (AC-2.7)', async () => {
    await setup(state(VAT_CODES[2], false))
    expect(select().value).toBe('')
    expect(select().selectedOptions[0].textContent).toBe('Choose…')
    expect(screen.getByText('The current OLD — Vecchia (7.7%) is deactivated. Choose another, or none.')).not.toBeNull()
    expect(save().disabled).toBe(true)
    fireEvent.change(select(), { target: { value: '__none__' } })
    expect(save().disabled).toBe(false)
  })

  it('shows a 422 inactive code as a field error, reloads the options and returns to "Choose…" (AC-2.6)', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockRejectedValue(problem(422, 'vat_code_inactive'))
    const { onSaved } = await setup(state(VAT_CODES[0]))
    fireEvent.change(select(), { target: { value: 'v2' } })
    vi.mocked(accountingApi.listVatCodes).mockResolvedValue([VAT_CODES[0], { ...VAT_CODES[1], active: false }])
    fireEvent.click(save())

    await waitFor(() =>
      expect(screen.getByTestId('foreign-currency-vat-error-field').textContent).toBe(
        'That VAT code has been deactivated. Choose another.',
      ),
    )
    await waitFor(() => expect(accountingApi.listVatCodes).toHaveBeenCalledTimes(2))
    expect(select().value).toBe('')
    expect(save().disabled).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(select()))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('shows 403 and other failures as general messages', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode)
      .mockRejectedValueOnce(problem(403))
      .mockRejectedValueOnce(problem(500))
    await setup(state(VAT_CODES[0]))
    fireEvent.change(select(), { target: { value: 'v2' } })
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('foreign-currency-vat-error').textContent).toBe(
        "You don't have permission to do this.",
      ),
    )
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('foreign-currency-vat-error').textContent).toBe('Could not save. Try again.'),
    )
  })

  it('Cancel cancels', async () => {
    const { onCancel } = await setup(state(VAT_CODES[0]))
    fireEvent.click(screen.getByTestId('foreign-currency-vat-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(accountingApi.putForeignCurrencyVatCode).not.toHaveBeenCalled()
  })
})
