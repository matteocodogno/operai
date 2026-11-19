/**
 * @vitest-environment jsdom
 *
 * ForeignCurrencyVatDialog (T25, specs/20261118-refund-accounting-export, design S6d, F4; AC-2.5, AC-2.6, AC-2.8): active codes
 * and "None designated", Save disabled until the choice differs, a deactivated designation starting on
 * "Choose…", a 422 as a field error with the options reloaded.
 *
 * T35, specs/20261119-accounting (RS3; AC-4.4, AC-4.5, AC-6.9, AC-6.10): the codes come from Accounting through
 * `GET /accounting/options` and are sent by code; a designation that is deactivated or no longer in Accounting
 * starts on "Choose…"; a 422 `vat_code_not_found` is a field error; Accounting unreadable shows the AC-6.10 message
 * with no options and a "Try again"; a save refused with 503 says nothing was saved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expectNoAxeViolations } from '../../test-support/axe'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return { ...original, getAccountingOptions: vi.fn(), putForeignCurrencyVatCode: vi.fn() }
})

import * as accountingApi from '../../lib/accountingApi'
import type { EntryState, ForeignCurrencyVatCodeState } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'
import ForeignCurrencyVatDialog from './ForeignCurrencyVatDialog'

type Code = { code: string; label: string; ratePercent: string }
const NOVAT: Code = { code: 'NOVAT', label: 'Senza IVA', ratePercent: '0' }
const IMP81: Code = { code: 'IMP81', label: 'Imposta piena', ratePercent: '8.1' }
const OLD: Code = { code: 'OLD', label: 'Vecchia', ratePercent: '7.7' }

const optionsOf = (...codes: Code[]) => ({
  ledgerAccounts: [],
  vatCodes: codes.map((code) => ({ ...code, rateBasisPoints: Math.round(Number(code.ratePercent) * 100) })),
})
const ACTIVE = optionsOf(NOVAT, IMP81)

const state = (code: Code | null, entryState: EntryState = 'active'): ForeignCurrencyVatCodeState => ({
  foreignCurrencyVatCode: code ? { ...code, state: entryState } : null,
  foreignCurrencyVatCodeUsable: code !== null && entryState === 'active',
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
  vi.mocked(accountingApi.getAccountingOptions).mockResolvedValue(ACTIVE)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ForeignCurrencyVatDialog', () => {
  it('is titled, explains what the code is for, and offers active VAT codes and "None designated"', async () => {
    await setup(state(NOVAT))
    expect(screen.getByRole('dialog', { name: 'VAT code for foreign-currency lines' })).not.toBeNull()
    expect(screen.getByText('WellD CH lines in a currency other than CHF get this code by default.')).not.toBeNull()
    expect(Array.from(select().options).map((option) => option.textContent)).toEqual([
      'None designated',
      'NOVAT — Senza IVA (0%)',
      'IMP81 — Imposta piena (8.1%)',
    ])
    expect(select().value).toBe('NOVAT')
  })

  it('keeps Save disabled until the choice differs, then designates the code by its code', async () => {
    const saved = state(IMP81)
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockResolvedValue(saved)
    const { onSaved } = await setup(state(NOVAT))
    expect(save().disabled).toBe(true)

    fireEvent.change(select(), { target: { value: 'IMP81' } })
    expect(save().disabled).toBe(false)
    fireEvent.click(save())

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved))
    expect(accountingApi.putForeignCurrencyVatCode).toHaveBeenCalledWith('IMP81')
  })

  it('clears the designation with None designated (null)', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockResolvedValue(state(null))
    await setup(state(NOVAT))
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
    await setup(state(OLD, 'deactivated'))
    expect(select().value).toBe('')
    expect(select().selectedOptions[0].textContent).toBe('Choose…')
    expect(screen.getByText('The current OLD — Vecchia (7.7%) is deactivated. Choose another, or none.')).not.toBeNull()
    expect(save().disabled).toBe(true)
    fireEvent.change(select(), { target: { value: '__none__' } })
    expect(save().disabled).toBe(false)
  })

  it('shows a 422 inactive code as a field error, reloads the options and returns to "Choose…" (AC-2.6)', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockRejectedValue(problem(422, 'vat_code_inactive'))
    const { onSaved } = await setup(state(NOVAT))
    fireEvent.change(select(), { target: { value: 'IMP81' } })
    vi.mocked(accountingApi.getAccountingOptions).mockResolvedValue(optionsOf(NOVAT))
    fireEvent.click(save())

    await waitFor(() =>
      expect(screen.getByTestId('foreign-currency-vat-error-field').textContent).toBe(
        'That VAT code has been deactivated. Choose another.',
      ),
    )
    await waitFor(() => expect(accountingApi.getAccountingOptions).toHaveBeenCalledTimes(2))
    expect(select().value).toBe('')
    expect(save().disabled).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(select()))
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('a designation that is no longer in Accounting starts on "Choose…" with its own hint', async () => {
    await setup(state(OLD, 'not_found'))
    expect(select().value).toBe('')
    expect(
      screen.getByText('The current OLD — Vecchia (7.7%) is no longer in Accounting. Choose another, or none.'),
    ).not.toBeNull()
    expect(save().disabled).toBe(true)
  })

  it('shows a 422 not-found code as its own field error and reloads the options', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockRejectedValue(problem(422, 'vat_code_not_found'))
    await setup(state(NOVAT))
    fireEvent.change(select(), { target: { value: 'IMP81' } })
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('foreign-currency-vat-error-field').textContent).toBe(
        'That VAT code is no longer in Accounting. Choose another.',
      ),
    )
    await waitFor(() => expect(accountingApi.getAccountingOptions).toHaveBeenCalledTimes(2))
    expect(select().value).toBe('')
  })

  it('Accounting cannot be read: the AC-6.10 message in an alert, no options, Save disabled, and Try again reads again', async () => {
    vi.mocked(accountingApi.getAccountingOptions).mockRejectedValueOnce(problem(503, 'accounting_unavailable'))
    render(<ForeignCurrencyVatDialog state={state(NOVAT)} onSaved={vi.fn()} onCancel={vi.fn()} />)

    const alert = await screen.findByTestId('foreign-currency-vat-unavailable')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain(
      "Accounting's reference data cannot be read right now, so there is nothing to choose from. Try again in a few minutes.",
    )
    expect(select().disabled).toBe(true)
    expect(save().disabled).toBe(true)
    expect(screen.queryByTestId('error-banner')).toBeNull()

    fireEvent.click(screen.getByTestId('foreign-currency-vat-try-again'))
    await waitFor(() => expect(select().disabled).toBe(false))
    expect(screen.queryByTestId('foreign-currency-vat-unavailable')).toBeNull()
  })

  it('a save refused with 503 says nothing was saved and keeps the dialog and the choice', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockRejectedValue(problem(503, 'accounting_unavailable'))
    const { onSaved } = await setup(state(NOVAT))
    fireEvent.change(select(), { target: { value: 'IMP81' } })
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('foreign-currency-vat-error').textContent).toBe(
        "Accounting's reference data cannot be read right now. Nothing was saved. Try again in a few minutes.",
      ),
    )
    expect(select().value).toBe('IMP81')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('shows 403 and other failures as general messages', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode)
      .mockRejectedValueOnce(problem(403))
      .mockRejectedValueOnce(problem(500))
    await setup(state(NOVAT))
    fireEvent.change(select(), { target: { value: 'IMP81' } })
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
    const { onCancel } = await setup(state(NOVAT))
    fireEvent.click(screen.getByTestId('foreign-currency-vat-cancel'))
    expect(onCancel).toHaveBeenCalled()
    expect(accountingApi.putForeignCurrencyVatCode).not.toHaveBeenCalled()
  })
})

// T44: automated axe checks (test-support/axe.ts) on every state of the dialog.
describe('ForeignCurrencyVatDialog: accessibility (axe)', () => {
  it('has no violations: options loading, options failed, loaded, nothing designated, and a deactivated designation', async () => {
    vi.mocked(accountingApi.getAccountingOptions).mockReturnValueOnce(new Promise(() => {}))
    render(<ForeignCurrencyVatDialog state={state(NOVAT)} onSaved={vi.fn()} onCancel={vi.fn()} />)
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.getAccountingOptions).mockRejectedValueOnce(problem(500))
    render(<ForeignCurrencyVatDialog state={state(NOVAT)} onSaved={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByTestId('error-banner')
    await expectNoAxeViolations()
    cleanup()

    await setup(state(NOVAT))
    await expectNoAxeViolations()
    cleanup()

    await setup(state(null))
    await expectNoAxeViolations()
    cleanup()

    await setup(state(OLD, 'deactivated'))
    await expectNoAxeViolations()
    cleanup()

    await setup(state(OLD, 'not_found'))
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.getAccountingOptions).mockRejectedValueOnce(problem(503, 'accounting_unavailable'))
    render(<ForeignCurrencyVatDialog state={state(NOVAT)} onSaved={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByTestId('foreign-currency-vat-unavailable')
    await expectNoAxeViolations()
  })

  it('has no violations: a 422 inactive code as a field error, a general failure, and while saving', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockRejectedValue(problem(422, 'vat_code_inactive'))
    await setup(state(NOVAT))
    fireEvent.change(select(), { target: { value: 'IMP81' } })
    fireEvent.click(save())
    await screen.findByTestId('foreign-currency-vat-error-field')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockRejectedValue(problem(500))
    await setup(state(NOVAT))
    fireEvent.change(select(), { target: { value: 'IMP81' } })
    fireEvent.click(save())
    await screen.findByTestId('foreign-currency-vat-error')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockRejectedValue(problem(503, 'accounting_unavailable'))
    await setup(state(NOVAT))
    fireEvent.change(select(), { target: { value: 'IMP81' } })
    fireEvent.click(save())
    await screen.findByTestId('foreign-currency-vat-error')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockReturnValue(new Promise(() => {}))
    await setup(state(NOVAT))
    fireEvent.change(select(), { target: { value: 'IMP81' } })
    fireEvent.click(save())
    await expectNoAxeViolations()
  })
})
