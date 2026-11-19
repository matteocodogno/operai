/**
 * @vitest-environment jsdom
 *
 * ExpenseTypeDefaultsCard (T25, specs/20261118-refund-accounting-export, design S4, F4, UX-2; AC-2.1, AC-2.2, AC-2.5,
 * AC-2.6, AC-2.7, AC-2.8): twelve rows with "None" where nothing is set, who changed it and when, the
 * foreign-currency VAT code and the warning when it is deactivated, the history drawer newest first,
 * Change only with `settings:manage`, focus back on the opener.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expectNoAxeViolations } from '../../test-support/axe'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return {
    ...original,
    getExpenseTypeDefaults: vi.fn(),
    listLedgerAccounts: vi.fn(),
    listVatCodes: vi.fn(),
    putExpenseTypeDefault: vi.fn(),
    putForeignCurrencyVatCode: vi.fn(),
  }
})

import * as accountingApi from '../../lib/accountingApi'
import type { ExpenseTypeDefault, ExpenseTypeDefaults, LedgerAccount, VatCode } from '../../lib/accountingApi'
import { EXPENSE_TYPES } from '../../lib/expenseTypes'
import { ApiError } from '../../lib/refundApi'
import ExpenseTypeDefaultsCard from './ExpenseTypeDefaultsCard'

const ACCOUNT_5901 = { id: 'a1', number: '5901', name: 'Spese viaggi', active: true }
const ACCOUNT_OLD = { id: 'a3', number: '5999', name: 'Vecchio', active: false }
const VAT_NOVAT = { id: 'v1', code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', active: true }
const VAT_IMP81 = { id: 'v2', code: 'IMP81', label: 'Imposta piena', ratePercent: '8.1', active: true }

const blankRow = (type: ExpenseTypeDefault['type']): ExpenseTypeDefault => ({
  type,
  account: null,
  vatCode: null,
  updatedAt: null,
  updatedByEmail: null,
  history: [],
})

const defaults = (overrides: Partial<ExpenseTypeDefaults> = {}): ExpenseTypeDefaults => ({
  entity: 'welld_ch',
  foreignCurrencyVatCode: null,
  foreignCurrencyVatCodeUsable: false,
  foreignCurrencyVatCodeHistory: [],
  types: EXPENSE_TYPES.map((option) =>
    option.id === 'travel_train'
      ? {
          ...blankRow(option.id),
          account: ACCOUNT_5901,
          vatCode: VAT_NOVAT,
          updatedAt: '2026-04-01T09:00:00Z',
          updatedByEmail: 'admin@welld.ch',
          history: [
            { account: null, vatCode: null, at: '2026-03-01T09:00:00Z', byEmail: 'first@welld.ch' },
            { account: ACCOUNT_OLD, vatCode: VAT_NOVAT, at: '2026-03-15T09:00:00Z', byEmail: 'second@welld.ch' },
            { account: ACCOUNT_5901, vatCode: VAT_NOVAT, at: '2026-04-01T09:00:00Z', byEmail: 'admin@welld.ch' },
          ],
        }
      : blankRow(option.id),
  ),
  ...overrides,
})

const account = (a: typeof ACCOUNT_5901): LedgerAccount => ({
  ...a,
  createdAt: '2026-03-01T09:00:00Z',
  createdByEmail: 'admin@welld.ch',
  history: [],
})
const vat = (v: typeof VAT_NOVAT): VatCode => ({
  ...v,
  rateBasisPoints: Math.round(Number(v.ratePercent) * 100),
  createdAt: '2026-03-01T09:00:00Z',
  createdByEmail: 'admin@welld.ch',
  history: [],
})

const problem = (status: number) => new ApiError({ type: 't', title: 'x', status })

beforeEach(() => {
  vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue(defaults())
  vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([
    account(ACCOUNT_5901),
    account({ ...ACCOUNT_5901, id: 'a2', number: '5905', name: 'Spese rimborsi' }),
  ])
  vi.mocked(accountingApi.listVatCodes).mockResolvedValue([vat(VAT_NOVAT), vat(VAT_IMP81)])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.documentElement.removeAttribute('lang')
})

const renderCard = async (canManage = true) => {
  render(<ExpenseTypeDefaultsCard canManage={canManage} />)
  await screen.findByTestId('settings-defaults-table')
}

describe('ExpenseTypeDefaultsCard: the twelve rows (AC-2.2)', () => {
  it('shows a polite loading line and a skeleton while it loads', () => {
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockReturnValue(new Promise(() => {}))
    render(<ExpenseTypeDefaultsCard canManage />)
    expect(screen.getByText('Loading the default classification…').getAttribute('aria-live')).toBe('polite')
    expect(screen.getByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('lists all twelve expense types, each named in the person’s language as the row header', async () => {
    await renderCard()
    expect(screen.getByRole('heading', { name: 'Default classification' })).not.toBeNull()
    expect(screen.getAllByTestId(/^settings-default-row-/)).toHaveLength(12)
    const headers = screen.getAllByRole('rowheader').map((cell) => cell.textContent)
    expect(headers).toEqual(EXPENSE_TYPES.map((option) => option.labelEn))
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Expense type',
      'Default account',
      'Default VAT code',
      'Last changed',
      'Actions',
    ])
  })

  it('writes "None" as real text, in both halves, for a type that has no default, and "Not set yet"', async () => {
    await renderCard()
    const row = screen.getByTestId('settings-default-row-postal')
    expect(within(row).getAllByText('None')).toHaveLength(2)
    expect(within(row).getByText('Not set yet')).not.toBeNull()
  })

  it('shows a configured default number first, with its rate, and who changed it and when', async () => {
    await renderCard()
    const row = screen.getByTestId('settings-default-row-travel_train')
    expect(within(row).getByText('5901 — Spese viaggi')).not.toBeNull()
    expect(within(row).getByText('NOVAT — Senza IVA (0%)')).not.toBeNull()
    expect(within(row).getByText('admin@welld.ch · 01.04.2026')).not.toBeNull()
    expect(within(row).queryByText('None')).toBeNull()
  })

  it('marks a half that points at a deactivated entry with an Inactive badge', async () => {
    const data = defaults()
    data.types = data.types.map((row) => (row.type === 'travel_train' ? { ...row, account: ACCOUNT_OLD } : row))
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue(data)
    await renderCard()
    const row = screen.getByTestId('settings-default-row-travel_train')
    expect(within(row).getByText('5999 — Vecchio')).not.toBeNull()
    expect(within(row).getByText('Inactive')).not.toBeNull()
  })

  it('explains in the description that accounting must choose per line where there is no default', async () => {
    await renderCard()
    expect(
      screen.getByText(/Where a type has no default, accounting must choose on each line before approving\./),
    ).not.toBeNull()
  })
})

describe('ExpenseTypeDefaultsCard: the foreign-currency VAT code (AC-2.5, AC-2.7)', () => {
  it('says "None designated" when nothing is designated, with no warning', async () => {
    await renderCard()
    expect(screen.getByTestId('settings-foreign-vat-value').textContent).toBe('None designated')
    expect(screen.getByText('VAT code for foreign-currency lines')).not.toBeNull()
    expect(screen.queryByTestId('settings-foreign-vat-inactive-warning')).toBeNull()
  })

  it('shows the designated code with its label and rate', async () => {
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue(
      defaults({ foreignCurrencyVatCode: VAT_IMP81, foreignCurrencyVatCodeUsable: true }),
    )
    await renderCard()
    expect(screen.getByTestId('settings-foreign-vat-value').textContent).toBe('IMP81 — Imposta piena (8.1%)')
    expect(screen.queryByTestId('settings-foreign-vat-inactive-warning')).toBeNull()
  })

  it('shows a deactivated designation with an Inactive badge and the warning that foreign lines get no VAT code', async () => {
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue(
      defaults({ foreignCurrencyVatCode: { ...VAT_IMP81, active: false }, foreignCurrencyVatCodeUsable: false }),
    )
    await renderCard()
    expect(within(screen.getByTestId('settings-foreign-vat-value')).getByText('Inactive')).not.toBeNull()
    const warning = screen.getByTestId('settings-foreign-vat-inactive-warning')
    expect(warning.textContent).toContain(
      'IMP81 is deactivated, so foreign-currency lines get no VAT code until you designate another.',
    )
    // a persistent condition read in place, not an announcement
    expect(warning.getAttribute('role')).toBe('note')
  })
})

describe('ExpenseTypeDefaultsCard: read-only without settings:manage (AC-2.8)', () => {
  it('shows no Change button anywhere, but keeps History', async () => {
    await renderCard(false)
    expect(screen.queryByRole('button', { name: /^Change/ })).toBeNull()
    expect(screen.queryByTestId('settings-foreign-vat-change')).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Show the history of/ })).toHaveLength(13)
  })

  it('names every Change button after its type, because twelve identical buttons are unusable', async () => {
    await renderCard()
    const names = screen
      .getAllByRole('button', { name: /^Change the default for / })
      .map((b) => b.getAttribute('aria-label'))
    expect(names).toHaveLength(12)
    expect(names[3]).toBe('Change the default for Travel — train')
    expect(new Set(names).size).toBe(12)
  })
})

describe('ExpenseTypeDefaultsCard: Change', () => {
  it('opens the dialog beside the card with the type’s title, and Cancel returns focus to that row’s Change', async () => {
    await renderCard()
    const change = screen.getByTestId('settings-default-change-travel_train')
    expect(change.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(change)

    const dialog = screen.getByRole('dialog', { name: 'Default classification — Travel — train' })
    expect(screen.getByTestId('settings-defaults-card').contains(dialog)).toBe(false)
    expect(document.querySelectorAll('form form')).toHaveLength(0)

    fireEvent.click(screen.getByTestId('default-classification-cancel'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(change)
  })

  it('saves, shows the server’s row, confirms by type, and returns focus to the Change button', async () => {
    const saved: ExpenseTypeDefault = {
      ...blankRow('travel_train'),
      account: { id: 'a2', number: '5905', name: 'Spese rimborsi', active: true },
      vatCode: VAT_NOVAT,
      updatedAt: '2026-11-18T10:00:00Z',
      updatedByEmail: 'me@welld.ch',
    }
    vi.mocked(accountingApi.putExpenseTypeDefault).mockResolvedValue(saved)
    await renderCard()
    const change = screen.getByTestId('settings-default-change-travel_train')
    fireEvent.click(change)
    await waitFor(() =>
      expect((screen.getByTestId('default-classification-account') as HTMLSelectElement).disabled).toBe(false),
    )
    fireEvent.change(screen.getByTestId('default-classification-account'), { target: { value: 'a2' } })
    fireEvent.click(screen.getByTestId('default-classification-submit'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const row = screen.getByTestId('settings-default-row-travel_train')
    expect(within(row).getByText('5905 — Spese rimborsi')).not.toBeNull()
    expect(within(row).getByText('me@welld.ch · 18.11.2026')).not.toBeNull()
    expect(screen.getByTestId('settings-defaults-success').textContent).toBe('Default saved for Travel — train')
    expect(document.activeElement).toBe(screen.getByTestId('settings-default-change-travel_train'))
    expect(screen.getAllByTestId(/^settings-default-row-/)).toHaveLength(12)
  })

  it('designates the foreign-currency VAT code from its own Change, and the fact shows it', async () => {
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockResolvedValue({
      foreignCurrencyVatCode: VAT_IMP81,
      foreignCurrencyVatCodeUsable: true,
      foreignCurrencyVatCodeHistory: [
        { vatCode: { id: 'v2', code: 'IMP81' }, at: '2026-11-18T10:00:00Z', byEmail: 'me@welld.ch' },
      ],
    })
    await renderCard()
    const change = screen.getByTestId('settings-foreign-vat-change')
    fireEvent.click(change)
    await waitFor(() =>
      expect((screen.getByTestId('foreign-currency-vat-select') as HTMLSelectElement).disabled).toBe(false),
    )
    fireEvent.change(screen.getByTestId('foreign-currency-vat-select'), { target: { value: 'v2' } })
    fireEvent.click(screen.getByTestId('foreign-currency-vat-submit'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('settings-foreign-vat-value').textContent).toBe('IMP81 — Imposta piena (8.1%)')
    expect(screen.getByTestId('settings-defaults-success').textContent).toBe('Foreign-currency VAT code saved')
    expect(document.activeElement).toBe(change)
    // the rest of the card is untouched by the merge
    expect(screen.getAllByTestId(/^settings-default-row-/)).toHaveLength(12)
  })

  it('clears the inactive warning once a usable code is designated', async () => {
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue(
      defaults({ foreignCurrencyVatCode: { ...VAT_IMP81, active: false }, foreignCurrencyVatCodeUsable: false }),
    )
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockResolvedValue({
      foreignCurrencyVatCode: VAT_NOVAT,
      foreignCurrencyVatCodeUsable: true,
      foreignCurrencyVatCodeHistory: [],
    })
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-foreign-vat-change'))
    await waitFor(() =>
      expect((screen.getByTestId('foreign-currency-vat-select') as HTMLSelectElement).disabled).toBe(false),
    )
    fireEvent.change(screen.getByTestId('foreign-currency-vat-select'), { target: { value: 'v1' } })
    fireEvent.click(screen.getByTestId('foreign-currency-vat-submit'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByTestId('settings-foreign-vat-inactive-warning')).toBeNull()
  })
})

describe('ExpenseTypeDefaultsCard: History (AC-2.1, AC-2.5)', () => {
  it('opens a drawer with every change newest first, then closes back onto its button', async () => {
    await renderCard(false)
    const button = screen.getByTestId('settings-default-history-travel_train')
    fireEvent.click(button)

    const drawer = screen.getByRole('dialog', { name: 'History — Travel — train' })
    expect(screen.getByTestId('settings-defaults-card').contains(drawer)).toBe(false)
    const rows = within(drawer).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      'admin@welld.ch',
      'second@welld.ch',
      'first@welld.ch',
    ])
    expect(
      within(drawer)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['When', 'By', 'Account', 'VAT code'])
    // the first ever default was "none"
    expect(within(rows[2]).getAllByText('None')).toHaveLength(2)
    expect(within(rows[1]).getByText('5999 — Vecchio')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Close the history' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('says there are no changes yet for a type that was never configured', async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-default-history-postal'))
    expect(screen.getByText('No changes recorded yet.')).not.toBeNull()
  })

  it('shows the history of the foreign-currency VAT code, newest first, "None" where it was cleared', async () => {
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue(
      defaults({
        foreignCurrencyVatCode: VAT_NOVAT,
        foreignCurrencyVatCodeUsable: true,
        foreignCurrencyVatCodeHistory: [
          { vatCode: { id: 'v2', code: 'IMP81' }, at: '2026-03-01T09:00:00Z', byEmail: 'a@welld.ch' },
          { vatCode: null, at: '2026-03-10T09:00:00Z', byEmail: 'b@welld.ch' },
          { vatCode: { id: 'v1', code: 'NOVAT' }, at: '2026-03-20T09:00:00Z', byEmail: 'c@welld.ch' },
        ],
      }),
    )
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-foreign-vat-history'))
    const drawer = screen.getByRole('dialog', { name: 'History — the foreign-currency VAT code' })
    const rows = within(drawer).getAllByRole('row').slice(1)
    expect(
      rows.map((r) =>
        within(r)
          .getAllByRole('cell')
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ['c@welld.ch', 'NOVAT'],
      ['b@welld.ch', 'None'],
      ['a@welld.ch', 'IMP81'],
    ])
  })
})

describe('ExpenseTypeDefaultsCard: failure states', () => {
  it('shows a retryable error when the load fails', async () => {
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockRejectedValueOnce(problem(500))
    render(<ExpenseTypeDefaultsCard canManage />)
    expect((await screen.findByTestId('error-banner')).textContent).toContain(
      'Could not load the default classification.',
    )
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await screen.findByTestId('settings-defaults-table')
  })

  it('is left out entirely on a 403', async () => {
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockRejectedValue(problem(403))
    const { container } = render(<ExpenseTypeDefaultsCard canManage />)
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })

  it('is in Italian, with a decimal comma, when the page is', async () => {
    document.documentElement.setAttribute('lang', 'it')
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue(
      defaults({ foreignCurrencyVatCode: VAT_IMP81, foreignCurrencyVatCodeUsable: true }),
    )
    await renderCard()
    expect(screen.getByTestId('settings-foreign-vat-value').textContent).toBe('IMP81 — Imposta piena (8,1%)')
  })
})

// T44: automated axe checks (test-support/axe.ts) on every state the card shows, with its dialogs and drawer open.
describe('ExpenseTypeDefaultsCard: accessibility (axe)', () => {
  it('has no violations: loading, the twelve rows, read-only and load failure', async () => {
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockReturnValueOnce(new Promise(() => {}))
    const loading = render(<ExpenseTypeDefaultsCard canManage />)
    await expectNoAxeViolations(loading.container)
    loading.unmount()

    const list = render(<ExpenseTypeDefaultsCard canManage />)
    await screen.findByTestId('settings-defaults-table')
    await expectNoAxeViolations(list.container)
    list.unmount()

    await renderCard(false)
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.getExpenseTypeDefaults).mockRejectedValueOnce(problem(500))
    const failed = render(<ExpenseTypeDefaultsCard canManage />)
    await screen.findByTestId('error-banner')
    await expectNoAxeViolations(failed.container)
  })

  it('has no violations: a designated foreign-currency VAT code, and a deactivated one with its warning', async () => {
    vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue(
      defaults({ foreignCurrencyVatCode: VAT_IMP81, foreignCurrencyVatCodeUsable: true }),
    )
    await renderCard()
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue(
      defaults({ foreignCurrencyVatCode: { ...VAT_IMP81, active: false }, foreignCurrencyVatCodeUsable: false }),
    )
    await renderCard()
    await screen.findByTestId('settings-foreign-vat-inactive-warning')
    await expectNoAxeViolations()
  })

  it('has no violations: the Change dialogs, the success note, and the history drawer', async () => {
    vi.mocked(accountingApi.putExpenseTypeDefault).mockRejectedValueOnce(problem(500))
    await renderCard()
    fireEvent.click(screen.getByTestId('settings-default-change-travel_train'))
    await waitFor(() =>
      expect((screen.getByTestId('default-classification-account') as HTMLSelectElement).disabled).toBe(false),
    )
    await expectNoAxeViolations()
    fireEvent.change(screen.getByTestId('default-classification-account'), { target: { value: 'a2' } })
    fireEvent.click(screen.getByTestId('default-classification-submit'))
    await screen.findByTestId('default-classification-error')
    await expectNoAxeViolations()
    fireEvent.click(screen.getByTestId('default-classification-cancel'))

    fireEvent.click(screen.getByTestId('settings-foreign-vat-change'))
    await waitFor(() =>
      expect((screen.getByTestId('foreign-currency-vat-select') as HTMLSelectElement).disabled).toBe(false),
    )
    await expectNoAxeViolations()
    vi.mocked(accountingApi.putForeignCurrencyVatCode).mockResolvedValue({
      foreignCurrencyVatCode: VAT_IMP81,
      foreignCurrencyVatCodeUsable: true,
      foreignCurrencyVatCodeHistory: [],
    })
    fireEvent.change(screen.getByTestId('foreign-currency-vat-select'), { target: { value: 'v2' } })
    fireEvent.click(screen.getByTestId('foreign-currency-vat-submit'))
    await screen.findByTestId('settings-defaults-success')
    await expectNoAxeViolations()

    fireEvent.click(screen.getByTestId('settings-default-history-travel_train'))
    await screen.findByRole('dialog')
    await expectNoAxeViolations()
    cleanup()

    await renderCard()
    fireEvent.click(screen.getByTestId('settings-default-history-postal'))
    await screen.findByRole('dialog')
    await expectNoAxeViolations()
  })
})
