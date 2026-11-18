/**
 * @vitest-environment jsdom
 *
 * LedgerAccountsCard (T24, specs/20261118-refund-accounting-export, design S2, F1, F2; AC-1.1, AC-1.2, AC-1.7, AC-1.9,
 * AC-1.11): the list and its states, Add, the Deactivate confirm, Reactivate, a stale list's 409, read-only
 * without `settings:manage`, no edit control, and no dialog inside a form.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return {
    ...original,
    listLedgerAccounts: vi.fn(),
    createLedgerAccount: vi.fn(),
    deactivateLedgerAccount: vi.fn(),
    reactivateLedgerAccount: vi.fn(),
  }
})

import * as accountingApi from '../../lib/accountingApi'
import type { LedgerAccount } from '../../lib/accountingApi'
import { ApiError } from '../../lib/refundApi'
import LedgerAccountsCard from './LedgerAccountsCard'

const account = (overrides: Partial<LedgerAccount> = {}): LedgerAccount => ({
  id: 'a1',
  number: '5905',
  name: 'Spese rimborsi',
  active: true,
  createdAt: '2026-03-01T09:00:00Z',
  createdByEmail: 'admin@welld.ch',
  history: [],
  ...overrides,
})

const ACTIVE = account()
const INACTIVE = account({ id: 'a2', number: '5901', name: 'Spese viaggi', active: false })

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })

const pending = <T,>() => new Promise<T>(() => {})

beforeEach(() => {
  vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([ACTIVE, INACTIVE])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderCard = async (canManage = true) => {
  const view = render(<LedgerAccountsCard canManage={canManage} />)
  await screen.findByTestId('settings-accounts-table')
  return view
}

describe('LedgerAccountsCard: the list', () => {
  it('shows a polite loading line and a skeleton while the list loads', () => {
    vi.mocked(accountingApi.listLedgerAccounts).mockReturnValue(pending())
    render(<LedgerAccountsCard canManage />)
    expect(screen.getByText('Loading ledger accounts…').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
    expect(screen.queryByTestId('settings-accounts-table')).toBeNull()
  })

  it('lists number (row header, mono), name, status badge with its word, and who added it and when', async () => {
    await renderCard()
    expect(screen.getByRole('heading', { name: 'Ledger accounts' })).not.toBeNull()
    const row = screen.getByTestId('settings-account-row-a1')
    const header = within(row).getByRole('rowheader')
    expect(header.textContent).toBe('5905')
    expect(header.querySelector('.font-mono')).not.toBeNull()
    expect(within(row).getByText('Spese rimborsi')).not.toBeNull()
    expect(within(row).getByText('Active')).not.toBeNull()
    expect(within(row).getByText('admin@welld.ch · 01.03.2026')).not.toBeNull()
    expect(within(screen.getByTestId('settings-account-row-a2')).getByText('Inactive')).not.toBeNull()
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Number',
      'Name',
      'Status',
      'Added',
      'Actions',
    ])
  })

  it('says there are no accounts yet, with no call to action of its own', async () => {
    vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([])
    render(<LedgerAccountsCard canManage />)
    const empty = await screen.findByTestId('settings-accounts-empty')
    expect(empty.textContent).toContain('No ledger accounts yet')
    expect(empty.textContent).toContain('Add the accounts that refunds are booked to.')
    expect(within(empty).queryByRole('button')).toBeNull()
    expect(screen.getByTestId('settings-accounts-add')).not.toBeNull()
  })

  it('shows a retryable error when the load fails, and loads again on Retry', async () => {
    vi.mocked(accountingApi.listLedgerAccounts).mockRejectedValueOnce(problem(500))
    render(<LedgerAccountsCard canManage />)
    expect((await screen.findByTestId('error-banner')).textContent).toContain('Could not load the ledger accounts.')

    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await screen.findByTestId('settings-accounts-table')
    expect(accountingApi.listLedgerAccounts).toHaveBeenCalledTimes(2)
  })

  it('is left out entirely when the list answers 403 (no settings:read)', async () => {
    vi.mocked(accountingApi.listLedgerAccounts).mockRejectedValue(problem(403))
    const { container } = render(<LedgerAccountsCard canManage />)
    await waitFor(() => expect(accountingApi.listLedgerAccounts).toHaveBeenCalled())
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })
})

describe('LedgerAccountsCard: read-only without settings:manage (AC-1.7)', () => {
  it('shows the table with no Add button, no Actions column and no row buttons', async () => {
    await renderCard(false)
    expect(screen.queryByTestId('settings-accounts-add')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull()
    expect(within(screen.getByTestId('settings-accounts-table')).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Add account|Deactivate|Reactivate/ })).toBeNull()
  })
})

describe('LedgerAccountsCard: no edit control (AC-1.1)', () => {
  it('offers only Deactivate and Reactivate on a row, never an edit, and no field in the table', async () => {
    await renderCard()
    const buttons = within(screen.getByTestId('settings-accounts-table')).getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Deactivate account 5905',
      'Reactivate account 5901',
    ])
    expect(screen.getByTestId('settings-accounts-table').querySelector('input, select, textarea')).toBeNull()
    expect(screen.queryByRole('button', { name: /edit|modify|rename/i })).toBeNull()
  })
})

describe('LedgerAccountsCard: Add account (AC-1.1, AC-1.2)', () => {
  it('opens the dialog beside the card, adds the account, shows the row and a confirmation, and returns focus to Add', async () => {
    const created = account({ id: 'a3', number: '2620.1', name: 'Anticipi' })
    vi.mocked(accountingApi.createLedgerAccount).mockResolvedValue(created)
    vi.mocked(accountingApi.listLedgerAccounts)
      .mockResolvedValueOnce([ACTIVE, INACTIVE])
      .mockResolvedValue([ACTIVE, INACTIVE, created])
    await renderCard()

    const addButton = screen.getByTestId('settings-accounts-add')
    expect(addButton.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(addButton)
    const dialog = screen.getByRole('dialog', { name: 'Add ledger account' })
    // ADR 20261118 dialog-beside-form: the dialog is never inside the card, and no form holds another form.
    expect(screen.getByTestId('settings-accounts-card').contains(dialog)).toBe(false)
    expect(document.querySelectorAll('form form')).toHaveLength(0)

    fireEvent.change(screen.getByTestId('add-ledger-account-number'), { target: { value: '2620.1' } })
    fireEvent.change(screen.getByTestId('add-ledger-account-name'), { target: { value: 'Anticipi' } })
    fireEvent.click(screen.getByTestId('add-ledger-account-submit'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('settings-account-row-a3').textContent).toContain('2620.1')
    expect(screen.getByTestId('settings-accounts-success').textContent).toBe('Account 2620.1 added')
    expect(document.activeElement).toBe(screen.getByTestId('settings-accounts-add'))
    // the server's list is loaded after the optimistic row
    await waitFor(() => expect(accountingApi.listLedgerAccounts).toHaveBeenCalledTimes(2))
    expect(screen.getAllByTestId(/^settings-account-row-/)).toHaveLength(3)
  })

  it('names a duplicate number on the field (a deactivated one with the reactivate hint) and the row is not added', async () => {
    vi.mocked(accountingApi.createLedgerAccount).mockRejectedValue(problem(409, 'ledger_account_duplicate'))
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-accounts-add'))
    fireEvent.change(screen.getByTestId('add-ledger-account-number'), { target: { value: '5901' } })
    fireEvent.blur(screen.getByTestId('add-ledger-account-number'))
    expect(screen.getByTestId('add-ledger-account-number-error').textContent).toBe(
      'Account 5901 already exists but is deactivated. Reactivate it from the list.',
    )
    expect(screen.getAllByTestId(/^settings-account-row-/)).toHaveLength(2)
  })

  it('Cancel closes the dialog without a request and returns focus to Add', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-accounts-add'))
    fireEvent.click(screen.getByTestId('add-ledger-account-cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(accountingApi.createLedgerAccount).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByTestId('settings-accounts-add'))
  })
})

describe('LedgerAccountsCard: Deactivate (AC-1.3, AC-1.9)', () => {
  it('asks first, saying what changes, and Cancel does nothing', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-account-deactivate-a1'))

    const dialog = screen.getByRole('alertdialog', { name: 'Deactivate account 5905?' })
    expect(within(dialog).getByText(/Lines already classified with it keep it\./)).not.toBeNull()
    expect(within(dialog).getByText(/You can reactivate it at any time\./)).not.toBeNull()
    // reversible, so the confirm is the primary tone and not the danger one (UX-3)
    expect(screen.getByTestId('deactivate-ledger-account-confirm').className).toContain('btn-primary')

    fireEvent.click(screen.getByTestId('deactivate-ledger-account-cancel'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(accountingApi.deactivateLedgerAccount).not.toHaveBeenCalled()
  })

  it('on confirm marks the row inactive, offers Reactivate, confirms, and moves focus to the row header', async () => {
    vi.mocked(accountingApi.deactivateLedgerAccount).mockResolvedValue({ ...ACTIVE, active: false })
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-account-deactivate-a1'))
    fireEvent.click(screen.getByTestId('deactivate-ledger-account-confirm'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(accountingApi.deactivateLedgerAccount).toHaveBeenCalledWith('a1')
    const row = screen.getByTestId('settings-account-row-a1')
    expect(within(row).getByText('Inactive')).not.toBeNull()
    expect(screen.queryByTestId('settings-account-deactivate-a1')).toBeNull()
    expect(screen.getByTestId('settings-account-reactivate-a1')).not.toBeNull()
    expect(screen.getByTestId('settings-accounts-success').textContent).toBe('Account 5905 deactivated')
    expect(document.activeElement).toBe(within(row).getByRole('rowheader'))
  })

  it('is busy while saving: not dismissible, and the row actions are disabled', async () => {
    vi.mocked(accountingApi.deactivateLedgerAccount).mockReturnValue(pending())
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-account-deactivate-a1'))
    fireEvent.click(screen.getByTestId('deactivate-ledger-account-confirm'))

    await waitFor(() =>
      expect(screen.getByTestId('deactivate-ledger-account-confirm').textContent).toBe('Deactivating…'),
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).not.toBeNull()
    expect((screen.getByTestId('settings-account-reactivate-a2') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the confirm open with a retry message on a server failure, and a permission message on 403', async () => {
    vi.mocked(accountingApi.deactivateLedgerAccount)
      .mockRejectedValueOnce(problem(500))
      .mockRejectedValueOnce(problem(403))
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-account-deactivate-a1'))
    fireEvent.click(screen.getByTestId('deactivate-ledger-account-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('deactivate-ledger-account-error').textContent).toBe('Could not save. Try again.'),
    )
    expect(within(screen.getByTestId('settings-account-row-a1')).getByText('Active')).not.toBeNull()

    fireEvent.click(screen.getByTestId('deactivate-ledger-account-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('deactivate-ledger-account-error').textContent).toBe(
        "You don't have permission to do this.",
      ),
    )
  })

  it('a stale list (409 already_inactive) is said in an alert, closes the confirm and reloads the list', async () => {
    vi.mocked(accountingApi.deactivateLedgerAccount).mockRejectedValue(problem(409, 'already_inactive'))
    await renderCard()
    vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([{ ...ACTIVE, active: false }, INACTIVE])
    fireEvent.click(screen.getByTestId('settings-account-deactivate-a1'))
    fireEvent.click(screen.getByTestId('deactivate-ledger-account-confirm'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByTestId('settings-accounts-action-error').textContent).toContain(
      'Account 5905 is already deactivated.',
    )
    await waitFor(() => expect(accountingApi.listLedgerAccounts).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(within(screen.getByTestId('settings-account-row-a1')).getByText('Inactive')).not.toBeNull(),
    )
  })
})

describe('LedgerAccountsCard: Reactivate (AC-1.9, AC-1.11)', () => {
  it('acts at once, with no dialog, marks the row active, confirms and moves focus to the row header', async () => {
    vi.mocked(accountingApi.reactivateLedgerAccount).mockResolvedValue({ ...INACTIVE, active: true })
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-account-reactivate-a2'))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    await waitFor(() => expect(screen.getByTestId('settings-account-deactivate-a2')).not.toBeNull())
    expect(accountingApi.reactivateLedgerAccount).toHaveBeenCalledWith('a2')
    const row = screen.getByTestId('settings-account-row-a2')
    expect(within(row).getByText('Active')).not.toBeNull()
    expect(screen.getByTestId('settings-accounts-success').textContent).toBe('Account 5901 reactivated')
    expect(document.activeElement).toBe(within(row).getByRole('rowheader'))
  })

  it('a stale list (409 already_active) shows the alert "Account 5901 is already active." and reloads', async () => {
    vi.mocked(accountingApi.reactivateLedgerAccount).mockRejectedValue(problem(409, 'already_active'))
    await renderCard()
    vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([ACTIVE, { ...INACTIVE, active: true }])
    fireEvent.click(screen.getByTestId('settings-account-reactivate-a2'))

    const alert = await screen.findByTestId('settings-accounts-action-error')
    expect(alert.textContent).toContain('Account 5901 is already active.')
    expect(alert.getAttribute('role')).toBe('alert')
    await waitFor(() => expect(accountingApi.listLedgerAccounts).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('settings-account-deactivate-a2')).not.toBeNull())
    expect(screen.queryByTestId('settings-accounts-success')).toBeNull()
  })

  it('shows a permission or generic failure in the same alert, and changes nothing', async () => {
    vi.mocked(accountingApi.reactivateLedgerAccount)
      .mockRejectedValueOnce(problem(403))
      .mockRejectedValueOnce(problem(500))
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-account-reactivate-a2'))
    expect((await screen.findByTestId('settings-accounts-action-error')).textContent).toContain(
      "You don't have permission to do this.",
    )
    fireEvent.click(screen.getByTestId('settings-account-reactivate-a2'))
    await waitFor(() =>
      expect(screen.getByTestId('settings-accounts-action-error').textContent).toContain('Could not save. Try again.'),
    )
    expect(within(screen.getByTestId('settings-account-row-a2')).getByText('Inactive')).not.toBeNull()
  })

  it('dismisses the failure alert', async () => {
    vi.mocked(accountingApi.reactivateLedgerAccount).mockRejectedValue(problem(500))
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-account-reactivate-a2'))
    await screen.findByTestId('settings-accounts-action-error')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByTestId('settings-accounts-action-error')).toBeNull()
  })
})
