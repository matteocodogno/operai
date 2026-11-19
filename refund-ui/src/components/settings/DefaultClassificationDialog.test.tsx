/**
 * @vitest-environment jsdom
 *
 * DefaultClassificationDialog (T25, specs/20261118-refund-accounting-export, design S6c, F4, UX-2; AC-2.1, AC-2.3, AC-2.4):
 * only active options, an explicit None, Save disabled until something differs, a deactivated saved value
 * starting on "Choose…", and a 422 inactive as a field error with the options reloaded.
 *
 * T35, specs/20261119-accounting (RS3; AC-4.4, AC-4.5, AC-6.9, AC-6.10): the options are Accounting's, read through
 * `GET /accounting/options` and keyed by number and code; a saved entry that is deactivated or no longer in
 * Accounting starts on "Choose…"; a 422 `*_not_found` is a field error too; Accounting unreadable shows the
 * AC-6.10 message with no options, and a "Try again"; a save refused with 503 says nothing was saved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expectNoAxeViolations } from '../../test-support/axe'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return { ...original, getAccountingOptions: vi.fn(), putExpenseTypeDefault: vi.fn() }
})

import * as accountingApi from '../../lib/accountingApi'
import type { AccountingOptions, ExpenseTypeDefault } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'
import DefaultClassificationDialog from './DefaultClassificationDialog'

const OPTIONS: AccountingOptions = {
  ledgerAccounts: [
    { number: '5901', name: 'Spese viaggi' },
    { number: '5905', name: 'Spese rimborsi' },
  ],
  vatCodes: [
    { code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', rateBasisPoints: 0 },
    { code: 'IMP81', label: 'Imposta piena', ratePercent: '8.1', rateBasisPoints: 810 },
  ],
}

const row = (overrides: Partial<ExpenseTypeDefault> = {}): ExpenseTypeDefault => ({
  type: 'travel_train',
  account: { number: '5901', name: 'Spese viaggi', state: 'active' },
  vatCode: { code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', state: 'active' },
  updatedAt: '2026-04-01T09:00:00Z',
  updatedByEmail: 'admin@welld.ch',
  history: [],
  ...overrides,
})

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })

const setup = async (current: ExpenseTypeDefault = row()) => {
  const onSaved = vi.fn()
  const onCancel = vi.fn()
  render(<DefaultClassificationDialog row={current} typeLabel="Travel — train" onSaved={onSaved} onCancel={onCancel} />)
  await waitFor(() =>
    expect((screen.getByTestId('default-classification-account') as HTMLSelectElement).disabled).toBe(false),
  )
  return { onSaved, onCancel }
}

const accountSelect = () => screen.getByTestId('default-classification-account') as HTMLSelectElement
const vatSelect = () => screen.getByTestId('default-classification-vat-code') as HTMLSelectElement
const save = () => screen.getByTestId('default-classification-submit') as HTMLButtonElement
const texts = (select: HTMLSelectElement) => Array.from(select.options).map((option) => option.textContent)

beforeEach(() => {
  vi.mocked(accountingApi.getAccountingOptions).mockResolvedValue(OPTIONS)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DefaultClassificationDialog', () => {
  it('is titled with the type, says approved lines keep what they have (AC-2.3), and starts on the saved values', async () => {
    await setup()
    expect(screen.getByRole('dialog', { name: 'Default classification — Travel — train' })).not.toBeNull()
    expect(
      screen.getByText('Applies to lines reviewed from now on. Lines already approved keep what they have.'),
    ).not.toBeNull()
    expect(accountSelect().value).toBe('5901')
    expect(vatSelect().value).toBe('NOVAT')
  })

  it('reads the options live from Accounting through refund-api, whatever the administrator may do there (AC-4.4)', async () => {
    await setup()
    expect(accountingApi.getAccountingOptions).toHaveBeenCalledTimes(1)
  })

  it('offers only the ACTIVE entries Accounting returns, number first, behind an explicit None (AC-2.4, AC-4.4)', async () => {
    await setup()
    expect(texts(accountSelect())).toEqual(['None (no default)', '5901 — Spese viaggi', '5905 — Spese rimborsi'])
    expect(texts(vatSelect())).toEqual(['None (no default)', 'NOVAT — Senza IVA (0%)', 'IMP81 — Imposta piena (8.1%)'])
  })

  it('has its selects disabled and busy while the options load, and Save disabled', () => {
    vi.mocked(accountingApi.getAccountingOptions).mockReturnValue(new Promise(() => {}))
    render(<DefaultClassificationDialog row={row()} typeLabel="Travel — train" onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(accountSelect().disabled).toBe(true)
    expect(accountSelect().getAttribute('aria-busy')).toBe('true')
    expect(save().disabled).toBe(true)
  })

  it('shows a retryable error when the options cannot be loaded, and Save stays disabled', async () => {
    vi.mocked(accountingApi.getAccountingOptions).mockRejectedValueOnce(problem(500))
    render(<DefaultClassificationDialog row={row()} typeLabel="Travel — train" onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect((await screen.findByTestId('error-banner')).textContent).toContain(
      'Could not load the default classification.',
    )
    expect(save().disabled).toBe(true)

    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await waitFor(() => expect(accountSelect().disabled).toBe(false))
  })

  it('keeps Save disabled until something differs from what is saved, and again when it is put back', async () => {
    await setup()
    expect(save().disabled).toBe(true)
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    expect(save().disabled).toBe(false)
    fireEvent.change(accountSelect(), { target: { value: '5901' } })
    expect(save().disabled).toBe(true)
  })

  it('saves both halves by number and code and hands the server’s row to the card', async () => {
    const saved = row({ account: { number: '5905', name: 'Spese rimborsi', state: 'active' } })
    vi.mocked(accountingApi.putExpenseTypeDefault).mockResolvedValue(saved)
    const { onSaved } = await setup()

    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved))
    expect(accountingApi.putExpenseTypeDefault).toHaveBeenCalledWith('travel_train', {
      accountNumber: '5905',
      vatCode: 'NOVAT',
    })
  })

  it('sends null for None, on either half, and None counts as a change', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockResolvedValue(row({ account: null, vatCode: null }))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: '__none__' } })
    fireEvent.change(vatSelect(), { target: { value: '__none__' } })
    expect(save().disabled).toBe(false)
    fireEvent.click(save())
    await waitFor(() => expect(accountingApi.putExpenseTypeDefault).toHaveBeenCalled())
    expect(accountingApi.putExpenseTypeDefault).toHaveBeenCalledWith('travel_train', {
      accountNumber: null,
      vatCode: null,
    })
  })

  it('starts a type with no default on None for both, and Save disabled', async () => {
    await setup(row({ account: null, vatCode: null, updatedAt: null, updatedByEmail: null }))
    expect(accountSelect().value).toBe('__none__')
    expect(vatSelect().value).toBe('__none__')
    expect(save().disabled).toBe(true)
  })

  it('starts a deactivated saved account on "Choose…" with a hint, Save disabled, so saving cannot silently clear it', async () => {
    await setup(row({ account: { number: '5999', name: 'Vecchio', state: 'deactivated' } }))
    expect(accountSelect().value).toBe('')
    expect(accountSelect().selectedOptions[0].textContent).toBe('Choose…')
    expect(screen.getByText('The current 5999 — Vecchio is deactivated. Choose another, or none.')).not.toBeNull()
    expect(screen.getByTestId('default-classification-inactive-note').textContent).toBe(
      'Lines of this type get no default until you choose another.',
    )
    expect(save().disabled).toBe(true)

    // the other half did not change, but choosing for this one unlocks Save
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    expect(save().disabled).toBe(false)
    expect(screen.queryByText(/is deactivated\. Choose another, or none\./)).toBeNull()
  })

  it('lets a deactivated saved value be replaced by None', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockResolvedValue(row({ vatCode: null }))
    await setup(row({ vatCode: { code: 'OLD', label: 'Vecchia', ratePercent: '7.7', state: 'deactivated' } }))
    expect(vatSelect().value).toBe('')
    expect(save().disabled).toBe(true)
    fireEvent.change(vatSelect(), { target: { value: '__none__' } })
    fireEvent.click(save())
    await waitFor(() => expect(accountingApi.putExpenseTypeDefault).toHaveBeenCalled())
    expect(accountingApi.putExpenseTypeDefault).toHaveBeenCalledWith('travel_train', {
      accountNumber: '5901',
      vatCode: null,
    })
  })

  it('treats a saved entry that was deactivated since the card loaded as unchosen', async () => {
    vi.mocked(accountingApi.getAccountingOptions).mockResolvedValue({
      ...OPTIONS,
      ledgerAccounts: [OPTIONS.ledgerAccounts[1]],
    })
    await setup()
    expect(accountSelect().value).toBe('')
    expect(save().disabled).toBe(true)
  })

  it('shows a 422 inactive account as a field error, reloads the options and puts that half back on "Choose…"', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(422, 'ledger_account_inactive'))
    const { onSaved } = await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    vi.mocked(accountingApi.getAccountingOptions).mockResolvedValue({
      ...OPTIONS,
      ledgerAccounts: [OPTIONS.ledgerAccounts[0]],
    })
    fireEvent.click(save())

    await waitFor(() =>
      expect(screen.getByTestId('default-classification-account-error').textContent).toBe(
        'That account has been deactivated. Choose another.',
      ),
    )
    await waitFor(() => expect(accountingApi.getAccountingOptions).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(texts(accountSelect())).not.toContain('5905 — Spese rimborsi'))
    expect(accountSelect().value).toBe('')
    expect(accountSelect().getAttribute('aria-invalid')).toBe('true')
    expect(save().disabled).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(accountSelect()))
    expect(onSaved).not.toHaveBeenCalled()

    // choosing again clears the error
    fireEvent.change(accountSelect(), { target: { value: '5901' } })
    expect(screen.queryByTestId('default-classification-account-error')).toBeNull()
  })

  it('shows a 422 not-found account (removed from Accounting while open) as its own field error, and reloads', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(422, 'ledger_account_not_found'))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('default-classification-account-error').textContent).toBe(
        'That account is no longer in Accounting. Choose another.',
      ),
    )
    await waitFor(() => expect(accountingApi.getAccountingOptions).toHaveBeenCalledTimes(2))
    expect(accountSelect().value).toBe('')
    await waitFor(() => expect(document.activeElement).toBe(accountSelect()))
  })

  it('shows a 422 not-found VAT code on the VAT select', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(422, 'vat_code_not_found'))
    await setup()
    fireEvent.change(vatSelect(), { target: { value: 'IMP81' } })
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('default-classification-vat-error').textContent).toBe(
        'That VAT code is no longer in Accounting. Choose another.',
      ),
    )
    expect(vatSelect().value).toBe('')
  })

  it('a saved account that is no longer in Accounting starts on "Choose…" with its own hint and the same sentence about the lines', async () => {
    await setup(row({ account: { number: '5999', name: 'Sparito', state: 'not_found' } }))
    expect(accountSelect().value).toBe('')
    expect(
      screen.getByText('The current 5999 — Sparito is no longer in Accounting. Choose another, or none.'),
    ).not.toBeNull()
    expect(screen.getByTestId('default-classification-inactive-note')).not.toBeNull()
    expect(save().disabled).toBe(true)
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    expect(save().disabled).toBe(false)
  })

  it('a saved VAT code that is no longer in Accounting does the same', async () => {
    await setup(row({ vatCode: { code: 'GONE', label: 'Sparito', ratePercent: '2.6', state: 'not_found' } }))
    expect(vatSelect().value).toBe('')
    expect(
      screen.getByText('The current GONE — Sparito (2.6%) is no longer in Accounting. Choose another, or none.'),
    ).not.toBeNull()
  })

  it('Accounting cannot be read: the AC-6.10 message in an alert, no options, Save disabled, and Try again reads again', async () => {
    vi.mocked(accountingApi.getAccountingOptions).mockRejectedValueOnce(problem(503, 'accounting_unavailable'))
    render(<DefaultClassificationDialog row={row()} typeLabel="Travel — train" onSaved={vi.fn()} onCancel={vi.fn()} />)

    const alert = await screen.findByTestId('default-classification-unavailable')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain(
      "Accounting's reference data cannot be read right now, so there is nothing to choose from. Try again in a few minutes.",
    )
    expect(alert.textContent).not.toMatch(/https?:|\/|@/)
    expect(screen.queryByTestId('error-banner')).toBeNull()
    expect(accountSelect().disabled).toBe(true)
    expect(Array.from(accountSelect().options).map((option) => option.value)).not.toContain('5905')
    expect(save().disabled).toBe(true)

    fireEvent.click(screen.getByTestId('default-classification-try-again'))
    await waitFor(() => expect(accountSelect().disabled).toBe(false))
    expect(screen.queryByTestId('default-classification-unavailable')).toBeNull()
    expect(accountingApi.getAccountingOptions).toHaveBeenCalledTimes(2)
  })

  it('a save refused with 503 says nothing was saved, keeps the dialog open and the choices', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(503, 'accounting_unavailable'))
    const { onSaved } = await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('default-classification-error').textContent).toBe(
        "Accounting's reference data cannot be read right now. Nothing was saved. Try again in a few minutes.",
      ),
    )
    expect(accountSelect().value).toBe('5905')
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).not.toBeNull()
  })

  it('shows a 422 inactive VAT code on the VAT select, and an unknown one the same way', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValueOnce(problem(422, 'vat_code_inactive'))
    await setup()
    fireEvent.change(vatSelect(), { target: { value: 'IMP81' } })
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('default-classification-vat-error').textContent).toBe(
        'That VAT code has been deactivated. Choose another.',
      ),
    )
    expect(vatSelect().value).toBe('')
    await waitFor(() => expect(document.activeElement).toBe(vatSelect()))
  })

  it('shows 403 as a permission message and other failures as a retry message, keeping the choices', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault)
      .mockRejectedValueOnce(problem(403))
      .mockRejectedValueOnce(problem(500))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('default-classification-error').textContent).toBe(
        "You don't have permission to do this.",
      ),
    )
    fireEvent.click(save())
    await waitFor(() =>
      expect(screen.getByTestId('default-classification-error').textContent).toBe('Could not save. Try again.'),
    )
    expect(accountSelect().value).toBe('5905')
  })

  it('is busy while saving, and a second press sends nothing', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockReturnValue(new Promise(() => {}))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())
    await waitFor(() => expect(save().textContent).toBe('Saving…'))
    expect(accountSelect().matches(':disabled')).toBe(true)
    fireEvent.click(save())
    expect(accountingApi.putExpenseTypeDefault).toHaveBeenCalledTimes(1)
  })

  it('Cancel and Escape cancel without a request', async () => {
    const { onCancel } = await setup()
    fireEvent.click(screen.getByTestId('default-classification-cancel'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(accountingApi.putExpenseTypeDefault).not.toHaveBeenCalled()
  })

  it('has labelled fields, required, in the dialog', async () => {
    await setup()
    const dialog = screen.getByRole('dialog')
    expect(
      within(dialog)
        .getByLabelText(/Default account/)
        .getAttribute('aria-required'),
    ).toBe('true')
    expect(
      within(dialog)
        .getByLabelText(/Default VAT code/)
        .getAttribute('aria-required'),
    ).toBe('true')
  })
})

// T44: automated axe checks (test-support/axe.ts) on every state of the dialog.
describe('DefaultClassificationDialog: accessibility (axe)', () => {
  it('has no violations: options loading, options failed, and loaded on the saved values', async () => {
    vi.mocked(accountingApi.getAccountingOptions).mockReturnValueOnce(new Promise(() => {}))
    render(<DefaultClassificationDialog row={row()} typeLabel="Travel — train" onSaved={vi.fn()} onCancel={vi.fn()} />)
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.getAccountingOptions).mockRejectedValueOnce(problem(500))
    render(<DefaultClassificationDialog row={row()} typeLabel="Travel — train" onSaved={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByTestId('error-banner')
    await expectNoAxeViolations()
    cleanup()

    await setup()
    await expectNoAxeViolations()
  })

  it('has no violations: a type with no default, a deactivated saved account with its notes, and each save failure', async () => {
    await setup(row({ account: null, vatCode: null }))
    await expectNoAxeViolations()
    cleanup()

    await setup(row({ account: { number: '5999', name: 'Vecchio', state: 'deactivated' } }))
    await screen.findByTestId('default-classification-inactive-note')
    await expectNoAxeViolations()
    cleanup()

    await setup(row({ account: { number: '5999', name: 'Sparito', state: 'not_found' } }))
    await screen.findByTestId('default-classification-inactive-note')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.getAccountingOptions).mockRejectedValueOnce(problem(503, 'accounting_unavailable'))
    render(<DefaultClassificationDialog row={row()} typeLabel="Travel — train" onSaved={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByTestId('default-classification-unavailable')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(503, 'accounting_unavailable'))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())
    await screen.findByTestId('default-classification-error')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(422, 'ledger_account_not_found'))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())
    await screen.findByTestId('default-classification-account-error')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(422, 'ledger_account_inactive'))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())
    await screen.findByTestId('default-classification-account-error')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(500))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())
    await screen.findByTestId('default-classification-error')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putExpenseTypeDefault).mockReturnValue(new Promise(() => {}))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: '5905' } })
    fireEvent.click(save())
    await expectNoAxeViolations()
  })
})
