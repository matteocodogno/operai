/**
 * @vitest-environment jsdom
 *
 * LineClassificationPanel (T28, specs/20261118-refund-accounting-export, design S7, F5, F6, UX-4, UX-14; AC-3.1, AC-3.2,
 * AC-3.3, AC-3.6, AC-3.7, AC-3.8, AC-3.9): the Default / Set by hand markers, the server's amounts (never computed
 * here), the rate-missing state, change on select with its saving, saved and refused states, an inactive current
 * value, read-only and locked.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import type { AccountingLine, AccountingOptions, ClassificationState } from '../lib/accountingApi'
import { ApiError } from '../lib/refundApi'
import LineClassificationPanel from './LineClassificationPanel'
import type { LineClassificationPanelProps } from './LineClassificationPanel'

afterEach(() => {
  cleanup()
})

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })

const TRAIN = { id: 'acc-train', number: '5901', name: 'Spese viaggi in treno', active: true }
const HOTEL = { id: 'acc-hotel', number: '5902', name: 'Spese alberghi', active: true }
const NOVAT = { id: 'vat-0', code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', active: true }
const IMP81 = { id: 'vat-81', code: 'IMP81', label: 'Imposta piena', ratePercent: '8.1', active: true }

const OPTIONS: AccountingOptions = {
  ledgerAccounts: [TRAIN, HOTEL].map(({ id, number, name }) => ({ id, number, name })),
  vatCodes: [NOVAT, IMP81].map(({ id, code, label, ratePercent }) => ({ id, code, label, ratePercent })),
}

const eurLine = (overrides: Partial<AccountingLine> = {}): AccountingLine => ({
  lineId: 'l1',
  entity: 'welld_ch',
  date: '2026-03-19',
  type: 'travel_train',
  currency: 'EUR',
  amountCents: 5200,
  receiptNumber: null,
  employee: { name: 'Matteo', email: 'm@welld.ch' },
  rejected: false,
  classification: { account: TRAIN, accountIsDefault: true, vatCode: NOVAT, vatCodeIsDefault: true },
  chf: { amountCents: 4808, rateMicros: 924600, rate: '0.9246', rateMonth: '2026-03', rateMissing: false },
  vatAmountCents: 0,
  ...overrides,
})

const chfLine = (overrides: Partial<AccountingLine> = {}): AccountingLine =>
  eurLine({
    currency: 'CHF',
    amountCents: 2000,
    classification: { account: TRAIN, accountIsDefault: true, vatCode: IMP81, vatCodeIsDefault: true },
    chf: { amountCents: 2000, rateMicros: null, rate: null, rateMonth: null, rateMissing: false },
    vatAmountCents: 156,
    ...overrides,
  })

const renderPanel = async (line: AccountingLine, props: Partial<LineClassificationPanelProps> = {}) => {
  const onClassify = vi.fn<LineClassificationPanelProps['onClassify']>()
  const onConflict = vi.fn()
  const onOptionsStale = vi.fn()
  window.history.pushState(null, '', '/')
  const rootRoute = createRootRoute()
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <LineClassificationPanel
        line={line}
        lineLabel="19.03.2026 · Milan–Lugano return"
        state="review"
        canChange
        options={OPTIONS}
        canOpenRates={false}
        onClassify={onClassify}
        onConflict={onConflict}
        onOptionsStale={onOptionsStale}
        {...props}
      />
    ),
  })
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => null,
    validateSearch: (search: Record<string, unknown>): { section?: string; month?: string } => ({
      section: typeof search.section === 'string' ? search.section : undefined,
      month: typeof search.month === 'string' ? search.month : undefined,
    }),
  })
  const router = createRouter({ routeTree: rootRoute.addChildren([index, settings]) })
  render(<RouterProvider router={router} />)
  await screen.findByTestId(`classification-${line.lineId}`)
  return { onClassify, onConflict, onOptionsStale }
}

const account = () => screen.getByTestId('classification-l1-account') as HTMLSelectElement
const vat = () => screen.getByTestId('classification-l1-vat-code') as HTMLSelectElement

describe('LineClassificationPanel: editable', () => {
  it('is a group named for its line, with number-first options and the two values selected (AC-3.1)', async () => {
    await renderPanel(eurLine())
    const group = screen.getByRole('group', { name: 'Classification for 19.03.2026 · Milan–Lugano return' })
    expect(group.tagName).toBe('FIELDSET')
    expect(account().value).toBe('acc-train')
    expect(vat().value).toBe('vat-0')
    expect(Array.from(account().options).map((option) => option.textContent)).toEqual([
      '5901 — Spese viaggi in treno',
      '5902 — Spese alberghi',
    ])
    expect(Array.from(vat().options).map((option) => option.textContent)).toEqual([
      'NOVAT — Senza IVA (0%)',
      'IMP81 — Imposta piena (8.1%)',
    ])
    expect(screen.getByLabelText(/^Account/)).toBe(account())
    expect(screen.getByLabelText(/^VAT code/)).toBe(vat())
  })

  it('marks each half as Default or Set by hand in its hint, which describes the select (AC-3.3)', async () => {
    await renderPanel(
      eurLine({
        classification: { account: TRAIN, accountIsDefault: true, vatCode: IMP81, vatCodeIsDefault: false },
      }),
    )
    const accountHint = document.getElementById(account().getAttribute('aria-describedby') ?? '')
    const vatHint = document.getElementById(vat().getAttribute('aria-describedby') ?? '')
    expect(accountHint?.textContent).toBe('Default')
    expect(vatHint?.textContent).toBe('Set by hand')
  })

  it('shows, for a foreign line, the rate with its month, the CHF amount and the VAT amount as the server sent them (AC-3.2, AC-3.8)', async () => {
    await renderPanel(eurLine())
    expect(screen.getByTestId('classification-l1-rate').textContent).toBe('0.9246 · March 2026')
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('CHF 48.08')
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toBe('CHF 0.00')
  })

  it('shows, for a CHF line, only the VAT amount with its rate', async () => {
    await renderPanel(chfLine())
    expect(screen.queryByTestId('classification-l1-rate')).toBeNull()
    expect(screen.queryByTestId('classification-l1-chf')).toBeNull()
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toBe('CHF 1.56 (8.1%)')
  })

  it('shows a rate of 0% as a real CHF 0.00, not "—"', async () => {
    await renderPanel(chfLine({ vatAmountCents: 0 }))
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toMatch(/^CHF 0\.00/)
  })

  it('does not compute: whatever amounts the server sent are the ones shown', async () => {
    await renderPanel(eurLine({ chf: { amountCents: 1, rateMicros: 1, rate: '0.000001', rateMonth: '2026-03', rateMissing: false }, vatAmountCents: 7 }))
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('CHF 0.01')
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toBe('CHF 0.07')
  })

  it('says the amounts follow the approved total before approval, and not after', async () => {
    await renderPanel(eurLine())
    expect(screen.getByText('Amounts follow the approved total as it stands now.')).not.toBeNull()
    cleanup()
    await renderPanel(eurLine(), { state: 'post_approval' })
    expect(screen.queryByText('Amounts follow the approved total as it stands now.')).toBeNull()
  })

  it('a missing rate is a badge with help and "—" for both amounts, never 0', async () => {
    await renderPanel(
      eurLine({
        chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateMissing: true },
        vatAmountCents: null,
      }),
    )
    const missing = screen.getByTestId('classification-l1-rate-missing')
    expect(within(missing).getByText('Rate missing')).not.toBeNull()
    expect(missing.textContent).toContain('No EUR rate for March 2026. The CHF and VAT amounts need it.')
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('—')
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toBe('—')
    expect(screen.queryByRole('link', { name: 'Open exchange rates' })).toBeNull()
  })

  it('offers "Open exchange rates" to that month only with settings:read', async () => {
    await renderPanel(
      eurLine({
        chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateMissing: true },
        vatAmountCents: null,
      }),
      { canOpenRates: true },
    )
    const link = screen.getByRole('link', { name: 'Open exchange rates' })
    expect(link.getAttribute('href')).toBe('/settings?section=exchange-rates&month=2026-03')
  })

  it('a missing value reads "Choose …" with "Required to approve.", and is no error yet', async () => {
    await renderPanel(
      eurLine({
        classification: { account: null, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true },
        vatAmountCents: 0,
      }),
    )
    expect(account().value).toBe('')
    expect(within(account()).getByText('Choose an account')).not.toBeNull()
    expect(document.getElementById(account().getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Required to approve.',
    )
    expect(account().getAttribute('aria-invalid')).toBeNull()
  })

  it('after a refused approval a missing value is invalid with its own error, cleared once a value exists (AC-3.4)', async () => {
    const missingBoth = eurLine({
      classification: { account: null, accountIsDefault: false, vatCode: null, vatCodeIsDefault: false },
      vatAmountCents: null,
    })
    await renderPanel(missingBoth, { missing: { account: true, vatCode: false } })
    expect(account().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Choose an account.').getAttribute('role')).toBe('alert')
    expect(vat().getAttribute('aria-invalid')).toBeNull()
    cleanup()
    // The refusal named it, but a value has been chosen since.
    await renderPanel(eurLine(), { missing: { account: true, vatCode: true } })
    expect(account().getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryByText('Choose an account.')).toBeNull()
  })

  it('carries a data attribute on each select so the page can move focus to the first missing one', async () => {
    await renderPanel(eurLine())
    expect(account().getAttribute('data-classification-field')).toBe('account')
    expect(vat().getAttribute('data-classification-field')).toBe('vat')
  })

  it('shows an inactive current value as a disabled selected option, with its hint (AC-1.3, AC-1.6)', async () => {
    const inactive = { ...TRAIN, active: false }
    await renderPanel(
      eurLine({ classification: { account: inactive, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }),
      // The options hold active entries only, so the deactivated one is not among them.
      { options: { ledgerAccounts: [{ id: HOTEL.id, number: HOTEL.number, name: HOTEL.name }], vatCodes: OPTIONS.vatCodes } },
    )
    expect(account().value).toBe('acc-train')
    const selected = account().selectedOptions[0]
    expect(selected.textContent).toBe('5901 — Spese viaggi in treno (inactive)')
    expect(selected.disabled).toBe(true)
    expect(document.getElementById(account().getAttribute('aria-describedby') ?? '')?.textContent).toContain(
      'This account is deactivated. The line keeps it; choose an active one to change it.',
    )
  })

  it('keeps an active value that the options do not list selectable', async () => {
    await renderPanel(eurLine(), { options: { ledgerAccounts: [HOTEL], vatCodes: OPTIONS.vatCodes } })
    expect(account().value).toBe('acc-train')
  })

  it('waits, disabled, while the options load', async () => {
    await renderPanel(eurLine(), { options: null })
    expect(account().disabled).toBe(true)
    expect(vat().disabled).toBe(true)
  })
})

describe('LineClassificationPanel: changing a value (UX-4, UX-14)', () => {
  it('saves on change with only that value, and no confirmation dialog', async () => {
    const { onClassify } = await renderPanel(eurLine())
    onClassify.mockResolvedValue(
      eurLine({ classification: { account: HOTEL, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }),
    )
    fireEvent.change(account(), { target: { value: 'acc-hotel' } })
    await waitFor(() => expect(onClassify).toHaveBeenCalledWith({ ledgerAccountId: 'acc-hotel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.change(vat(), { target: { value: 'vat-81' } })
    await waitFor(() => expect(onClassify).toHaveBeenCalledWith({ vatCodeId: 'vat-81' }))
  })

  it('shows Saving… and the chosen value while it saves, ignores another change, keeps focus, then confirms politely', async () => {
    const { onClassify } = await renderPanel(eurLine())
    let resolve!: (line: AccountingLine) => void
    onClassify.mockReturnValue(new Promise((r) => (resolve = r)))
    account().focus()
    fireEvent.change(account(), { target: { value: 'acc-hotel' } })

    await waitFor(() => expect(account().getAttribute('aria-busy')).toBe('true'))
    expect(account().value).toBe('acc-hotel')
    expect(account().disabled).toBe(false)
    expect(document.activeElement).toBe(account())
    expect(document.getElementById(account().getAttribute('aria-describedby') ?? '')?.textContent).toBe('Saving…')
    fireEvent.change(account(), { target: { value: 'acc-train' } })
    expect(onClassify).toHaveBeenCalledTimes(1)

    resolve(
      eurLine({ classification: { account: HOTEL, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }),
    )
    const status = screen.getByTestId('classification-l1-saved')
    await waitFor(() => expect(status.textContent).toBe('Account set to 5902 — Spese alberghi'))
    expect(status.getAttribute('role')).toBe('status')
    expect(account().getAttribute('aria-busy')).toBeNull()
  })

  it('says the VAT code was set', async () => {
    const { onClassify } = await renderPanel(eurLine())
    onClassify.mockResolvedValue(
      eurLine({ classification: { account: TRAIN, accountIsDefault: true, vatCode: IMP81, vatCodeIsDefault: false } }),
    )
    fireEvent.change(vat(), { target: { value: 'vat-81' } })
    await waitFor(() =>
      expect(screen.getByTestId('classification-l1-saved').textContent).toBe(
        'VAT code set to IMP81 — Imposta piena (8.1%)',
      ),
    )
  })

  it('does not save when the same value is chosen again', async () => {
    const { onClassify } = await renderPanel(eurLine())
    fireEvent.change(account(), { target: { value: 'acc-train' } })
    expect(onClassify).not.toHaveBeenCalled()
  })

  it('reverts to the last saved value and says why on a 422 for a deactivated account, asking for fresh options', async () => {
    const { onClassify, onOptionsStale } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(422, 'ledger_account_inactive'))
    fireEvent.change(account(), { target: { value: 'acc-hotel' } })
    const alert = await screen.findByText('That account was deactivated. Choose another.')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(account().value).toBe('acc-train')
    expect(onOptionsStale).toHaveBeenCalledTimes(1)
  })

  it('says so for a deactivated VAT code', async () => {
    const { onClassify, onOptionsStale } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(422, 'vat_code_inactive'))
    fireEvent.change(vat(), { target: { value: 'vat-81' } })
    expect(await screen.findByText('That VAT code was deactivated. Choose another.')).not.toBeNull()
    expect(vat().value).toBe('vat-0')
    expect(onOptionsStale).toHaveBeenCalled()
  })

  it.each([
    [403, "You don't have permission to change this classification."],
    [500, 'Could not change the classification. Try again.'],
  ])('a %i reverts and shows its own alert under the select', async (status, message) => {
    const { onClassify, onConflict } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(status))
    fireEvent.change(account(), { target: { value: 'acc-hotel' } })
    expect((await screen.findByText(message)).getAttribute('role')).toBe('alert')
    expect(account().value).toBe('acc-train')
    expect(account().getAttribute('aria-invalid')).toBe('true')
    expect(onConflict).not.toHaveBeenCalled()
  })

  it('hands a 409 to the page (its own guardrail) and reverts, with no inline message', async () => {
    const { onClassify, onConflict } = await renderPanel(eurLine())
    const conflict = problem(409, 'classification_locked')
    onClassify.mockRejectedValue(conflict)
    fireEvent.change(account(), { target: { value: 'acc-hotel' } })
    await waitFor(() => expect(onConflict).toHaveBeenCalledWith(conflict))
    expect(account().value).toBe('acc-train')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('LineClassificationPanel: read-only', () => {
  it.each<[ClassificationState, string]>([
    ['review', 'You can view the classification but not change it.'],
    ['post_approval', 'You can view the classification but not change it.'],
  ])('without the capability in state %s: values as text with markers, no select, and why (AC-3.6)', async (state, why) => {
    await renderPanel(
      eurLine({ classification: { account: TRAIN, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }),
      { state: state as 'review', canChange: false },
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    const values = screen.getByTestId('classification-l1-values')
    expect(values.textContent).toContain('5901 — Spese viaggi in treno')
    expect(values.textContent).toContain('Set by hand')
    expect(values.textContent).toContain('NOVAT — Senza IVA (0%)')
    expect(values.textContent).toContain('Default')
    expect(screen.getByTestId('classification-l1-why').textContent).toBe(why)
    // The amounts are still there.
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('CHF 48.08')
  })

  it('locked when the batch is paid: no select even with the capability, a lock and its reason (AC-3.7)', async () => {
    await renderPanel(eurLine(), { state: 'locked', canChange: true })
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByTestId('classification-l1').getAttribute('data-mode')).toBe('locked')
    const why = screen.getByTestId('classification-l1-why')
    expect(why.textContent).toBe('Locked: its batch has been paid.')
    expect(why.querySelector('svg')).not.toBeNull()
  })

  it('shows "—" for a value that is not set, and "(inactive)" for a deactivated one', async () => {
    await renderPanel(
      eurLine({
        classification: { account: { ...TRAIN, active: false }, accountIsDefault: false, vatCode: null, vatCodeIsDefault: false },
        vatAmountCents: null,
      }),
      { state: 'locked' },
    )
    const values = screen.getByTestId('classification-l1-values')
    expect(values.textContent).toContain('5901 — Spese viaggi in treno (inactive)')
    expect(values.textContent).toContain('—')
  })
})

describe('LineClassificationPanel: not for every line', () => {
  it('renders nothing for a line without a classification (WellD Italia, rejected)', async () => {
    window.history.pushState(null, '', '/')
    const { container } = render(
      <LineClassificationPanel
        line={eurLine({ entity: 'welld_it', classification: null })}
        lineLabel="x"
        state="review"
        canChange
        options={OPTIONS}
        canOpenRates={false}
        onClassify={vi.fn()}
        onConflict={vi.fn()}
        onOptionsStale={vi.fn()}
      />,
    )
    expect(container.innerHTML).toBe('')
  })
})
