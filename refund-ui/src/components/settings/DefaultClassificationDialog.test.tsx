/**
 * @vitest-environment jsdom
 *
 * DefaultClassificationDialog (T25, specs/20261118-refund-accounting-export, design S6c, F4, UX-2; AC-2.1, AC-2.3, AC-2.4):
 * only active options, an explicit None, Save disabled until something differs, a deactivated saved value
 * starting on "Choose…", and a 422 inactive as a field error with the options reloaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expectNoAxeViolations } from '../../test-support/axe'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return { ...original, listLedgerAccounts: vi.fn(), listVatCodes: vi.fn(), putExpenseTypeDefault: vi.fn() }
})

import * as accountingApi from '../../lib/accountingApi'
import type { ExpenseTypeDefault, LedgerAccount, VatCode } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'
import DefaultClassificationDialog from './DefaultClassificationDialog'

const account = (id: string, number: string, name: string, active = true): LedgerAccount => ({
  id,
  number,
  name,
  active,
  createdAt: '2026-03-01T09:00:00Z',
  createdByEmail: 'admin@welld.ch',
  history: [],
})
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

const ACCOUNTS = [
  account('a1', '5901', 'Spese viaggi'),
  account('a2', '5905', 'Spese rimborsi'),
  account('a3', '5999', 'Vecchio', false),
]
const VAT_CODES = [
  vat('v1', 'NOVAT', 'Senza IVA', '0'),
  vat('v2', 'IMP81', 'Imposta piena', '8.1'),
  vat('v3', 'OLD', 'Vecchia', '7.7', false),
]

const row = (overrides: Partial<ExpenseTypeDefault> = {}): ExpenseTypeDefault => ({
  type: 'travel_train',
  account: { id: 'a1', number: '5901', name: 'Spese viaggi', active: true },
  vatCode: { id: 'v1', code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', active: true },
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
  vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue(ACCOUNTS)
  vi.mocked(accountingApi.listVatCodes).mockResolvedValue(VAT_CODES)
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
    expect(accountSelect().value).toBe('a1')
    expect(vatSelect().value).toBe('v1')
  })

  it('offers only ACTIVE entries, number first, behind an explicit None (AC-2.4)', async () => {
    await setup()
    expect(texts(accountSelect())).toEqual(['None (no default)', '5901 — Spese viaggi', '5905 — Spese rimborsi'])
    expect(texts(vatSelect())).toEqual(['None (no default)', 'NOVAT — Senza IVA (0%)', 'IMP81 — Imposta piena (8.1%)'])
  })

  it('has its selects disabled and busy while the options load, and Save disabled', () => {
    vi.mocked(accountingApi.listLedgerAccounts).mockReturnValue(new Promise(() => {}))
    render(<DefaultClassificationDialog row={row()} typeLabel="Travel — train" onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(accountSelect().disabled).toBe(true)
    expect(accountSelect().getAttribute('aria-busy')).toBe('true')
    expect(save().disabled).toBe(true)
  })

  it('shows a retryable error when the options cannot be loaded, and Save stays disabled', async () => {
    vi.mocked(accountingApi.listVatCodes).mockRejectedValueOnce(problem(500))
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
    fireEvent.change(accountSelect(), { target: { value: 'a2' } })
    expect(save().disabled).toBe(false)
    fireEvent.change(accountSelect(), { target: { value: 'a1' } })
    expect(save().disabled).toBe(true)
  })

  it('saves both halves by id and hands the server’s row to the card', async () => {
    const saved = row({ account: { id: 'a2', number: '5905', name: 'Spese rimborsi', active: true } })
    vi.mocked(accountingApi.putExpenseTypeDefault).mockResolvedValue(saved)
    const { onSaved } = await setup()

    fireEvent.change(accountSelect(), { target: { value: 'a2' } })
    fireEvent.click(save())

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved))
    expect(accountingApi.putExpenseTypeDefault).toHaveBeenCalledWith('travel_train', {
      ledgerAccountId: 'a2',
      vatCodeId: 'v1',
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
      ledgerAccountId: null,
      vatCodeId: null,
    })
  })

  it('starts a type with no default on None for both, and Save disabled', async () => {
    await setup(row({ account: null, vatCode: null, updatedAt: null, updatedByEmail: null }))
    expect(accountSelect().value).toBe('__none__')
    expect(vatSelect().value).toBe('__none__')
    expect(save().disabled).toBe(true)
  })

  it('starts a deactivated saved account on "Choose…" with a hint, Save disabled, so saving cannot silently clear it', async () => {
    await setup(row({ account: { id: 'a3', number: '5999', name: 'Vecchio', active: false } }))
    expect(accountSelect().value).toBe('')
    expect(accountSelect().selectedOptions[0].textContent).toBe('Choose…')
    expect(screen.getByText('The current 5999 — Vecchio is deactivated. Choose another, or none.')).not.toBeNull()
    expect(screen.getByTestId('default-classification-inactive-note').textContent).toBe(
      'Lines of this type get no default until you choose another.',
    )
    expect(save().disabled).toBe(true)

    // the other half did not change, but choosing for this one unlocks Save
    fireEvent.change(accountSelect(), { target: { value: 'a2' } })
    expect(save().disabled).toBe(false)
    expect(screen.queryByText(/is deactivated\. Choose another, or none\./)).toBeNull()
  })

  it('lets a deactivated saved value be replaced by None', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockResolvedValue(row({ vatCode: null }))
    await setup(row({ vatCode: { id: 'v3', code: 'OLD', label: 'Vecchia', ratePercent: '7.7', active: false } }))
    expect(vatSelect().value).toBe('')
    expect(save().disabled).toBe(true)
    fireEvent.change(vatSelect(), { target: { value: '__none__' } })
    fireEvent.click(save())
    await waitFor(() => expect(accountingApi.putExpenseTypeDefault).toHaveBeenCalled())
    expect(accountingApi.putExpenseTypeDefault).toHaveBeenCalledWith('travel_train', {
      ledgerAccountId: 'a1',
      vatCodeId: null,
    })
  })

  it('treats a saved entry that was deactivated since the card loaded as unchosen', async () => {
    vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([
      account('a1', '5901', 'Spese viaggi', false),
      ACCOUNTS[1],
    ])
    await setup()
    expect(accountSelect().value).toBe('')
    expect(save().disabled).toBe(true)
  })

  it('shows a 422 inactive account as a field error, reloads the options and puts that half back on "Choose…"', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(422, 'ledger_account_inactive'))
    const { onSaved } = await setup()
    fireEvent.change(accountSelect(), { target: { value: 'a2' } })
    vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([
      ACCOUNTS[0],
      account('a2', '5905', 'Spese rimborsi', false),
    ])
    fireEvent.click(save())

    await waitFor(() =>
      expect(screen.getByTestId('default-classification-account-error').textContent).toBe(
        'That account has been deactivated. Choose another.',
      ),
    )
    await waitFor(() => expect(accountingApi.listLedgerAccounts).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(texts(accountSelect())).not.toContain('5905 — Spese rimborsi'))
    expect(accountSelect().value).toBe('')
    expect(accountSelect().getAttribute('aria-invalid')).toBe('true')
    expect(save().disabled).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(accountSelect()))
    expect(onSaved).not.toHaveBeenCalled()

    // choosing again clears the error
    fireEvent.change(accountSelect(), { target: { value: 'a1' } })
    expect(screen.queryByTestId('default-classification-account-error')).toBeNull()
  })

  it('shows a 422 inactive VAT code on the VAT select, and an unknown one the same way', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValueOnce(problem(422, 'vat_code_inactive'))
    await setup()
    fireEvent.change(vatSelect(), { target: { value: 'v2' } })
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
    fireEvent.change(accountSelect(), { target: { value: 'a2' } })
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
    expect(accountSelect().value).toBe('a2')
  })

  it('is busy while saving, and a second press sends nothing', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockReturnValue(new Promise(() => {}))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: 'a2' } })
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
    vi.mocked(accountingApi.listLedgerAccounts).mockReturnValueOnce(new Promise(() => {}))
    render(<DefaultClassificationDialog row={row()} typeLabel="Travel — train" onSaved={vi.fn()} onCancel={vi.fn()} />)
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.listVatCodes).mockRejectedValueOnce(problem(500))
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

    await setup(row({ account: { id: 'a3', number: '5999', name: 'Vecchio', active: false } }))
    await screen.findByTestId('default-classification-inactive-note')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(422, 'ledger_account_inactive'))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: 'a2' } })
    fireEvent.click(save())
    await screen.findByTestId('default-classification-account-error')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValue(problem(500))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: 'a2' } })
    fireEvent.click(save())
    await screen.findByTestId('default-classification-error')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.putExpenseTypeDefault).mockReturnValue(new Promise(() => {}))
    await setup()
    fireEvent.change(accountSelect(), { target: { value: 'a2' } })
    fireEvent.click(save())
    await expectNoAxeViolations()
  })
})
