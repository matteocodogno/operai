/**
 * @vitest-environment jsdom
 *
 * LineClassificationPanel (T28, specs/20261118-refund-accounting-export, design S7, F5, F6, UX-4, UX-14; AC-3.1, AC-3.2,
 * AC-3.3, AC-3.6, AC-3.7, AC-3.8, AC-3.9): the Default / Set by hand markers, the server's amounts (never computed
 * here), the rate-missing state, change on select with its saving, saved and refused states, an inactive current
 * value, read-only and locked.
 *
 * T36, specs/20261119-accounting (RS4, UX-18 to UX-21, UX-23; AC-4.1 to AC-4.3, AC-4.9, AC-5.2, AC-5.6, AC-6.1, AC-6.5,
 * AC-6.10, AC-7.3): a copy deactivated or no longer in Accounting stays selected and marked; a type default that is
 * no longer usable reads as missing with its reason; "No rate yet" before approval and "Rate pending" after it,
 * "—" never 0; the Accounting link only when the view says so, else "ask an accounting manager"; Accounting
 * unreadable is the read-only group with the values as recorded; a 503 on a save reverts and says nothing changed;
 * after approval the values are kept as booked.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expectNoAxeViolations } from '../test-support/axe'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import type { AccountingLine, AccountingOptions, ClassificationState } from '../lib/accountingApi'
import { ApiError } from '../lib/refundApi'
import LineClassificationPanel from './LineClassificationPanel'
import type { LineClassificationPanelProps } from './LineClassificationPanel'

afterEach(() => {
  cleanup()
})

const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })

const TRAIN = { number: '5901', name: 'Spese viaggi in treno', state: 'active' as const }
const HOTEL = { number: '5902', name: 'Spese alberghi', state: 'active' as const }
const NOVAT = { code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', state: 'active' as const }
const IMP81 = { code: 'IMP81', label: 'Imposta piena', ratePercent: '8.1', state: 'active' as const }

const OPTIONS: AccountingOptions = {
  ledgerAccounts: [TRAIN, HOTEL].map(({ number, name }) => ({ number, name })),
  vatCodes: [NOVAT, IMP81].map(({ code, label, ratePercent }) => ({
    code,
    label,
    ratePercent,
    rateBasisPoints: Math.round(Number(ratePercent) * 100),
  })),
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
  inScope: true,
  classification: { account: TRAIN, accountIsDefault: true, vatCode: NOVAT, vatCodeIsDefault: true },
  chf: { amountCents: 4808, rateMicros: 924600, rate: '0.9246', rateMonth: '2026-03', rateStatus: 'in_effect' },
  vatAmountCents: 0,
  ...overrides,
})

const chfLine = (overrides: Partial<AccountingLine> = {}): AccountingLine =>
  eurLine({
    currency: 'CHF',
    amountCents: 2000,
    classification: { account: TRAIN, accountIsDefault: true, vatCode: IMP81, vatCodeIsDefault: true },
    chf: { amountCents: 2000, rateMicros: null, rate: null, rateMonth: null, rateStatus: 'not_applicable' },
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
  const router = createRouter({ routeTree: rootRoute.addChildren([index]) })
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
    expect(account().value).toBe('5901')
    expect(vat().value).toBe('NOVAT')
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
    await renderPanel(eurLine({ chf: { amountCents: 1, rateMicros: 1, rate: '0.000001', rateMonth: '2026-03', rateStatus: 'in_effect' }, vatAmountCents: 7 }))
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('CHF 0.01')
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toBe('CHF 0.07')
  })

  it('says the amounts follow the approved total before approval, and not after', async () => {
    await renderPanel(eurLine())
    const follows =
      'Amounts follow the approved total and the exchange rate as they stand now. They are fixed when the request is approved.'
    expect(screen.getByText(follows)).not.toBeNull()
    cleanup()
    await renderPanel(eurLine(), { state: 'post_approval' })
    expect(screen.queryByText(follows)).toBeNull()
  })

  it('after approval says the account, VAT code and rate are kept as booked (AC-5.3, UX-20)', async () => {
    const frozen = 'Account, VAT code and rate are kept as booked. Later changes in Accounting do not change this line.'
    await renderPanel(eurLine(), { state: 'post_approval' })
    expect(screen.getByText(frozen)).not.toBeNull()
    cleanup()
    await renderPanel(eurLine(), { state: 'post_approval', canChange: false })
    expect(screen.getByText(frozen)).not.toBeNull()
    cleanup()
    await renderPanel(eurLine())
    expect(screen.queryByText(frozen)).toBeNull()
  })

  it('before approval, no rate is "No rate yet": a badge, help saying approval is still possible, "—" for both amounts, never 0 (UX-20)', async () => {
    await renderPanel(
      eurLine({
        chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'missing' },
        vatAmountCents: null,
      }),
    )
    const missing = screen.getByTestId('classification-l1-rate-missing')
    expect(within(missing).getByText('No rate yet')).not.toBeNull()
    expect(missing.textContent).toContain(
      'No EUR rate for March 2026 yet. You can still approve: the rate is copied at the first export.',
    )
    expect(missing.textContent).not.toContain('need it')
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('—')
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toBe('—')
    expect(screen.queryByRole('link', { name: 'Open exchange rates' })).toBeNull()
  })

  it('after approval, a rate not copied yet is "Rate pending": the first export copies it, "—" for both amounts (AC-5.6)', async () => {
    await renderPanel(
      eurLine({
        chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'pending' },
        vatAmountCents: null,
      }),
      { state: 'post_approval' },
    )
    const pending = screen.getByTestId('classification-l1-rate-pending')
    expect(within(pending).getByText('Rate pending')).not.toBeNull()
    expect(pending.textContent).toContain(
      'No EUR rate for March 2026 yet. It is copied at the first accounting export of the batch.',
    )
    expect(screen.queryByTestId('classification-l1-rate-missing')).toBeNull()
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('—')
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toBe('—')
  })

  it('a pending rate is shown read-only too (a paid batch resolves it at export, not here)', async () => {
    await renderPanel(
      eurLine({
        chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'pending' },
        vatAmountCents: null,
      }),
      { state: 'locked' },
    )
    expect(within(screen.getByTestId('classification-l1-rate-pending')).getByText('Rate pending')).not.toBeNull()
    expect(screen.getByTestId('classification-l1-why').textContent).toBe('Locked: its batch has been paid.')
  })

  it('a missing rate without the Accounting link says who can fix it (A-8, AC-7.3)', async () => {
    await renderPanel(
      eurLine({
        chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'missing' },
        vatAmountCents: null,
      }),
    )
    expect(screen.getByTestId('classification-l1-rate-missing').textContent).toContain(
      'Ask an accounting manager to enter or fetch it.',
    )
    expect(screen.queryByText(/administrator/)).toBeNull()
    cleanup()
    await renderPanel(
      eurLine({
        chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'missing' },
        vatAmountCents: null,
      }),
      { canOpenRates: true },
    )
    expect(screen.getByTestId('classification-l1-rate-missing').textContent).not.toContain('Ask an accounting manager')
  })

  it('offers "Open exchange rates" to that month in Accounting only when the view allows it (AC-7.3)', async () => {
    await renderPanel(
      eurLine({
        chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'missing' },
        vatAmountCents: null,
      }),
      { canOpenRates: true },
    )
    const link = screen.getByRole('link', { name: 'Open exchange rates' })
    expect(link.getAttribute('href')).toBe('/accounting/exchange-rates?entity=welld_ch&month=2026-03')
    expect(link.className).toContain('link')
  })

  it('a rate month with no month on the line falls back to the line’s own month for the link', async () => {
    await renderPanel(
      eurLine({
        chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: null, rateStatus: 'missing' },
        vatAmountCents: null,
      }),
      { canOpenRates: true },
    )
    expect(screen.getByRole('link', { name: 'Open exchange rates' }).getAttribute('href')).toBe(
      '/accounting/exchange-rates?entity=welld_ch&month=2026-03',
    )
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
    const inactive = { ...TRAIN, state: 'deactivated' as const }
    await renderPanel(
      eurLine({ classification: { account: inactive, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }),
      // The options hold active entries only, so the deactivated one is not among them.
      { options: { ledgerAccounts: [{ number: HOTEL.number, name: HOTEL.name }], vatCodes: OPTIONS.vatCodes } },
    )
    expect(account().value).toBe('5901')
    const selected = account().selectedOptions[0]
    expect(selected.textContent).toBe('5901 — Spese viaggi in treno (deactivated)')
    expect(selected.disabled).toBe(true)
    expect(document.getElementById(account().getAttribute('aria-describedby') ?? '')?.textContent).toContain(
      'This account is deactivated in Accounting. The line keeps it; choose an active one to change it.',
    )
  })

  it('shows a copy that is no longer in Accounting as a disabled selected option "(not in Accounting)", with its hint (AC-4.5)', async () => {
    const gone = { ...TRAIN, state: 'not_found' as const }
    await renderPanel(
      eurLine({ classification: { account: gone, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }),
      { options: { ledgerAccounts: [{ number: HOTEL.number, name: HOTEL.name }], vatCodes: OPTIONS.vatCodes } },
    )
    expect(account().value).toBe('5901')
    expect(account().selectedOptions[0].textContent).toBe('5901 — Spese viaggi in treno (not in Accounting)')
    expect(account().selectedOptions[0].disabled).toBe(true)
    expect(document.getElementById(account().getAttribute('aria-describedby') ?? '')?.textContent).toContain(
      'This account is no longer in Accounting. The line keeps it; choose another to change it.',
    )
  })

  it('does the same for a VAT code, deactivated and not found', async () => {
    await renderPanel(
      eurLine({
        classification: {
          account: TRAIN,
          accountIsDefault: true,
          vatCode: { ...NOVAT, state: 'deactivated' },
          vatCodeIsDefault: false,
        },
      }),
      { options: { ledgerAccounts: OPTIONS.ledgerAccounts, vatCodes: [OPTIONS.vatCodes[1]] } },
    )
    expect(vat().selectedOptions[0].textContent).toBe('NOVAT — Senza IVA (0%) (deactivated)')
    expect(document.getElementById(vat().getAttribute('aria-describedby') ?? '')?.textContent).toContain(
      'This VAT code is deactivated in Accounting. The line keeps it; choose an active one to change it.',
    )
    cleanup()
    await renderPanel(
      eurLine({
        classification: {
          account: TRAIN,
          accountIsDefault: true,
          vatCode: { ...NOVAT, state: 'not_found' },
          vatCodeIsDefault: false,
        },
      }),
      { options: { ledgerAccounts: OPTIONS.ledgerAccounts, vatCodes: [OPTIONS.vatCodes[1]] } },
    )
    expect(vat().selectedOptions[0].textContent).toBe('NOVAT — Senza IVA (0%) (not in Accounting)')
    expect(document.getElementById(vat().getAttribute('aria-describedby') ?? '')?.textContent).toContain(
      'This VAT code is no longer in Accounting. The line keeps it; choose another to change it.',
    )
  })

  it('a deactivated TYPE DEFAULT (not set by hand, before approval) reads as missing, with the reason (RS4, AC-6.3)', async () => {
    await renderPanel(
      eurLine({
        classification: {
          account: { ...TRAIN, state: 'deactivated' },
          accountIsDefault: true,
          vatCode: NOVAT,
          vatCodeIsDefault: true,
        },
      }),
    )
    expect(account().value).toBe('')
    expect(within(account()).getByText('Choose an account')).not.toBeNull()
    const hint = document.getElementById(account().getAttribute('aria-describedby') ?? '')?.textContent
    expect(hint).toBe('The default account for this type is deactivated in Accounting. Choose one.')
    expect(hint).not.toContain('Required to approve.')
    expect(account().getAttribute('aria-invalid')).toBeNull()
    // The other half is fine.
    expect(vat().value).toBe('NOVAT')
  })

  it('a TYPE DEFAULT that is no longer in Accounting says so for the account and for the VAT code', async () => {
    await renderPanel(
      eurLine({
        classification: {
          account: { ...TRAIN, state: 'not_found' },
          accountIsDefault: true,
          vatCode: { ...NOVAT, state: 'not_found' },
          vatCodeIsDefault: true,
        },
      }),
    )
    expect(document.getElementById(account().getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'The default account for this type is no longer in Accounting. Choose one.',
    )
    expect(vat().value).toBe('')
    expect(document.getElementById(vat().getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'The default VAT code for this type is no longer in Accounting. Choose one.',
    )
  })

  it('a refused approval makes the unusable default invalid and names it like any other missing value (AC-6.3)', async () => {
    await renderPanel(
      eurLine({
        classification: {
          account: { ...TRAIN, state: 'deactivated' },
          accountIsDefault: true,
          vatCode: NOVAT,
          vatCodeIsDefault: true,
        },
      }),
      { missing: { account: true, vatCode: false } },
    )
    expect(account().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('Choose an account.').getAttribute('role')).toBe('alert')
  })

  it('after approval the same default is the line’s own copy: it stays selected, marked, not missing', async () => {
    await renderPanel(
      eurLine({
        classification: {
          account: { ...TRAIN, state: 'deactivated' },
          accountIsDefault: true,
          vatCode: NOVAT,
          vatCodeIsDefault: true,
        },
      }),
      {
        state: 'post_approval',
        options: { ledgerAccounts: [{ number: HOTEL.number, name: HOTEL.name }], vatCodes: OPTIONS.vatCodes },
      },
    )
    expect(account().value).toBe('5901')
    expect(account().selectedOptions[0].textContent).toContain('(deactivated)')
  })

  it('a default set by hand that is deactivated stays selected and marked, not missing', async () => {
    await renderPanel(
      eurLine({
        classification: {
          account: { ...TRAIN, state: 'deactivated' },
          accountIsDefault: false,
          vatCode: NOVAT,
          vatCodeIsDefault: true,
        },
      }),
    )
    expect(account().value).toBe('5901')
  })

  it('keeps an active value that the options do not list selectable', async () => {
    await renderPanel(eurLine(), { options: { ledgerAccounts: [{ number: HOTEL.number, name: HOTEL.name }], vatCodes: OPTIONS.vatCodes } })
    expect(account().value).toBe('5901')
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
    fireEvent.change(account(), { target: { value: '5902' } })
    await waitFor(() => expect(onClassify).toHaveBeenCalledWith({ accountNumber: '5902' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.change(vat(), { target: { value: 'IMP81' } })
    await waitFor(() => expect(onClassify).toHaveBeenCalledWith({ vatCode: 'IMP81' }))
  })

  it('shows Saving… and the chosen value while it saves, ignores another change, keeps focus, then confirms politely', async () => {
    const { onClassify } = await renderPanel(eurLine())
    let resolve!: (line: AccountingLine) => void
    onClassify.mockReturnValue(new Promise((r) => (resolve = r)))
    account().focus()
    fireEvent.change(account(), { target: { value: '5902' } })

    await waitFor(() => expect(account().getAttribute('aria-busy')).toBe('true'))
    expect(account().value).toBe('5902')
    expect(account().disabled).toBe(false)
    expect(document.activeElement).toBe(account())
    expect(document.getElementById(account().getAttribute('aria-describedby') ?? '')?.textContent).toBe('Saving…')
    fireEvent.change(account(), { target: { value: '5901' } })
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
    fireEvent.change(vat(), { target: { value: 'IMP81' } })
    await waitFor(() =>
      expect(screen.getByTestId('classification-l1-saved').textContent).toBe(
        'VAT code set to IMP81 — Imposta piena (8.1%)',
      ),
    )
  })

  it('does not save when the same value is chosen again', async () => {
    const { onClassify } = await renderPanel(eurLine())
    fireEvent.change(account(), { target: { value: '5901' } })
    expect(onClassify).not.toHaveBeenCalled()
  })

  it('reverts to the last saved value and says why on a 422 for a deactivated account, asking for fresh options', async () => {
    const { onClassify, onOptionsStale } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(422, 'ledger_account_inactive'))
    fireEvent.change(account(), { target: { value: '5902' } })
    const alert = await screen.findByText('That account was deactivated. Choose another.')
    expect(alert.getAttribute('role')).toBe('alert')
    expect(account().value).toBe('5901')
    expect(onOptionsStale).toHaveBeenCalledTimes(1)
  })

  it('says so for a deactivated VAT code', async () => {
    const { onClassify, onOptionsStale } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(422, 'vat_code_inactive'))
    fireEvent.change(vat(), { target: { value: 'IMP81' } })
    expect(await screen.findByText('That VAT code was deactivated. Choose another.')).not.toBeNull()
    expect(vat().value).toBe('NOVAT')
    expect(onOptionsStale).toHaveBeenCalled()
  })

  it.each([
    [403, "You don't have permission to change this classification."],
    [500, 'Could not change the classification. Try again.'],
  ])('a %i reverts and shows its own alert under the select', async (status, message) => {
    const { onClassify, onConflict } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(status))
    fireEvent.change(account(), { target: { value: '5902' } })
    expect((await screen.findByText(message)).getAttribute('role')).toBe('alert')
    expect(account().value).toBe('5901')
    expect(account().getAttribute('aria-invalid')).toBe('true')
    expect(onConflict).not.toHaveBeenCalled()
  })

  it('hands a 409 to the page (its own guardrail) and reverts, with no inline message', async () => {
    const { onClassify, onConflict } = await renderPanel(eurLine())
    const conflict = problem(409, 'classification_locked')
    onClassify.mockRejectedValue(conflict)
    fireEvent.change(account(), { target: { value: '5902' } })
    await waitFor(() => expect(onConflict).toHaveBeenCalledWith(conflict))
    expect(account().value).toBe('5901')
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

  it('shows "—" for a value that is not set, and "(deactivated)" for a deactivated one', async () => {
    await renderPanel(
      eurLine({
        classification: { account: { ...TRAIN, state: 'deactivated' as const }, accountIsDefault: false, vatCode: null, vatCodeIsDefault: false },
        vatAmountCents: null,
      }),
      { state: 'locked' },
    )
    const values = screen.getByTestId('classification-l1-values')
    expect(values.textContent).toContain('5901 — Spese viaggi in treno (deactivated)')
    expect(values.textContent).toContain('—')
  })
})

describe('LineClassificationPanel: Accounting cannot be read (AC-6.5, UX-19)', () => {
  const unverified = (line: AccountingLine): AccountingLine => ({
    ...line,
    classification: line.classification && {
      account: line.classification.account && { ...line.classification.account, state: 'unverified' },
      accountIsDefault: line.classification.accountIsDefault,
      vatCode: line.classification.vatCode && { ...line.classification.vatCode, state: 'unverified' },
      vatCodeIsDefault: line.classification.vatCodeIsDefault,
    },
    chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'unavailable' },
    vatAmountCents: null,
  })

  it('is the read-only group: no select, the values as recorded, each marked "Default (as recorded)" or "Set by hand"', async () => {
    await renderPanel(
      unverified(
        eurLine({
          classification: { account: TRAIN, accountIsDefault: true, vatCode: NOVAT, vatCodeIsDefault: false },
        }),
      ),
      { accountingUnavailable: true },
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    const values = screen.getByTestId('classification-l1-values')
    expect(values.textContent).toContain('5901 — Spese viaggi in treno')
    expect(values.textContent).toContain('Default (as recorded)')
    expect(values.textContent).toContain('NOVAT — Senza IVA (0%)')
    expect(values.textContent).toContain('Set by hand')
    expect(values.textContent).not.toMatch(/deactivated|not in Accounting/)
    expect(screen.getByTestId('classification-l1').getAttribute('data-mode')).toBe('readOnly')
  })

  it('says why in a focusable status sentence, and "—" where nothing is recorded or known, never 0', async () => {
    await renderPanel(
      unverified(
        eurLine({
          classification: { account: null, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true },
        }),
      ),
      { accountingUnavailable: true },
    )
    const why = screen.getByTestId('classification-l1-why')
    expect(why.textContent).toBe('Accounting cannot be read now, so this classification cannot be changed.')
    expect(why.getAttribute('role')).toBe('status')
    expect(why.getAttribute('tabindex')).toBe('-1')
    expect(screen.getByTestId('classification-l1-values').textContent).toContain('—')
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('—')
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toBe('—')
    expect(screen.queryByTestId('classification-l1-rate-missing')).toBeNull()
    expect(screen.queryByTestId('classification-l1-rate-pending')).toBeNull()
  })

  it('keeps a person without the capability on the plain read-only sentence', async () => {
    await renderPanel(unverified(eurLine()), { accountingUnavailable: true, canChange: false })
    expect(screen.getByTestId('classification-l1-why').textContent).toBe(
      'You can view the classification but not change it.',
    )
  })

  it('says it for a paid batch as the lock, not as an Accounting outage', async () => {
    await renderPanel(unverified(eurLine()), { accountingUnavailable: true, state: 'locked' })
    expect(screen.getByTestId('classification-l1-why').textContent).toBe('Locked: its batch has been paid.')
  })

  it('does not claim "kept as booked" for a value it could not check, and has no select for a CHF line either', async () => {
    await renderPanel(unverified(chfLine()), { accountingUnavailable: true, state: 'post_approval' })
    expect(screen.queryByText(/kept as booked/)).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})

describe('LineClassificationPanel: a save refused because Accounting cannot be read (AC-6.1, AC-6.5, AC-6.10)', () => {
  it('puts the value back, says the classification was not changed in an alert under the select, and asks for the view again', async () => {
    const onAccountingUnavailable = vi.fn()
    const { onClassify } = await renderPanel(eurLine(), { onAccountingUnavailable })
    onClassify.mockRejectedValue(problem(503, 'accounting_unavailable'))

    fireEvent.change(account(), { target: { value: '5902' } })

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        "Accounting's reference data cannot be read right now. The classification was not changed. Try again in a few minutes.",
      ),
    )
    expect(account().value).toBe('5901')
    expect(account().getAttribute('aria-invalid')).toBe('true')
    expect(onAccountingUnavailable).toHaveBeenCalledTimes(1)
  })

  it('moves focus to the reason when the view then says Accounting cannot be read, since the select is gone', async () => {
    const onClassifyRef = { current: null as null | LineClassificationPanelProps['onClassify'] }
    const view = (unavailable: boolean) => (
      <LineClassificationPanel
        line={eurLine()}
        lineLabel="x"
        state="review"
        canChange
        options={OPTIONS}
        canOpenRates={false}
        accountingUnavailable={unavailable}
        onClassify={(body) => onClassifyRef.current!(body)}
        onConflict={vi.fn()}
        onOptionsStale={vi.fn()}
      />
    )
    onClassifyRef.current = vi.fn().mockRejectedValue(problem(503, 'accounting_unavailable'))
    const { rerender } = render(view(false))
    fireEvent.change(account(), { target: { value: '5902' } })
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    rerender(view(true))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('classification-l1-why')))
  })

  it('a panel that did not save anything keeps focus where it was when the view turns unavailable', async () => {
    const view = (unavailable: boolean) => (
      <LineClassificationPanel
        line={eurLine()}
        lineLabel="x"
        state="review"
        canChange
        options={OPTIONS}
        canOpenRates={false}
        accountingUnavailable={unavailable}
        onClassify={vi.fn()}
        onConflict={vi.fn()}
        onOptionsStale={vi.fn()}
      />
    )
    const { rerender } = render(view(false))
    account().focus()
    rerender(view(true))
    expect(document.activeElement).not.toBe(screen.getByTestId('classification-l1-why'))
  })

  it.each([
    ['ledger_account_not_found', 'account', 'That account is no longer in Accounting. Choose another.'],
    ['vat_code_not_found', 'vat', 'That VAT code is no longer in Accounting. Choose another.'],
  ])('a 422 %s reverts the select, says so under it and reloads the options', async (code, which, text) => {
    const { onClassify, onOptionsStale } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(422, code))
    const select = which === 'account' ? account() : vat()
    fireEvent.change(select, { target: { value: which === 'account' ? '5902' : 'IMP81' } })
    await waitFor(() => expect(screen.getByText(text).getAttribute('role')).toBe('alert'))
    expect(select.value).toBe(which === 'account' ? '5901' : 'NOVAT')
    expect(onOptionsStale).toHaveBeenCalled()
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

describe('LineClassificationPanel: segregation of duties and entity scope (plan.md SR-1, SR-2; AC-3.3, AC-3.6, AC-3.10)', () => {
  const SELF_NOTE = "You can't classify your own request. Someone else has to do it."

  it('selfRestricted: the values as text with markers, no select even with the capability, and the note that says why', async () => {
    await renderPanel(
      eurLine({ classification: { account: TRAIN, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }),
      { selfRestricted: true, canChange: true },
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByTestId('classification-l1').getAttribute('data-mode')).toBe('readOnly')
    expect(screen.getByTestId('classification-l1-values').textContent).toContain('5901 — Spese viaggi in treno')
    expect(screen.getByTestId('classification-l1-why').textContent).toBe(SELF_NOTE)
    // The server's amounts stay visible: the caller may still read their own request's booking.
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('CHF 48.08')
  })

  it('selfRestricted without the capability keeps the plain read-only sentence, and a paid batch keeps its lock', async () => {
    await renderPanel(eurLine(), { selfRestricted: true, canChange: false })
    expect(screen.getByTestId('classification-l1-why').textContent).toBe(
      'You can view the classification but not change it.',
    )
    cleanup()
    await renderPanel(eurLine(), { selfRestricted: true, canChange: true, state: 'locked' })
    expect(screen.getByTestId('classification-l1-why').textContent).toBe('Locked: its batch has been paid.')
  })

  it('a 403 self_approval_forbidden reverts the select, turns the panel read-only with the note, tells the page, and shows no alert', async () => {
    const onSelfRestricted = vi.fn()
    const { onClassify, onConflict } = await renderPanel(eurLine(), { onSelfRestricted })
    onClassify.mockRejectedValue(problem(403, 'self_approval_forbidden'))
    fireEvent.change(account(), { target: { value: '5902' } })

    expect(await screen.findByTestId('classification-l1-why')).not.toBeNull()
    expect(screen.getByTestId('classification-l1-why').textContent).toBe(SELF_NOTE)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText("You don't have permission to change this classification.")).toBeNull()
    // The value shown is the last saved one, not the one the user tried.
    expect(screen.getByTestId('classification-l1-values').textContent).toContain('5901 — Spese viaggi in treno')
    expect(screen.getByTestId('classification-l1-values').textContent).not.toContain('5902')
    expect(onSelfRestricted).toHaveBeenCalledTimes(1)
    expect(onConflict).not.toHaveBeenCalled()
  })

  it('after a 403 self_approval_forbidden focus moves to the reason, a status the user can read (A-2)', async () => {
    const { onClassify } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(403, 'self_approval_forbidden'))
    account().focus()
    fireEvent.change(account(), { target: { value: '5902' } })

    const why = await screen.findByTestId('classification-l1-why')
    await waitFor(() => expect(document.activeElement).toBe(why))
    expect(why.getAttribute('tabindex')).toBe('-1')
    expect(why.getAttribute('role')).toBe('status')
  })

  it('a panel that is read-only from the start does not take focus (A-2)', async () => {
    await renderPanel(eurLine(), { selfRestricted: true })
    expect(document.activeElement).toBe(document.body)
    expect(screen.getByTestId('classification-l1-why').getAttribute('role')).toBe('status')
  })

  it('the same 403 on the VAT select does the same', async () => {
    const { onClassify } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(403, 'self_approval_forbidden'))
    fireEvent.change(vat(), { target: { value: 'IMP81' } })
    expect((await screen.findByTestId('classification-l1-why')).textContent).toBe(SELF_NOTE)
    expect(screen.getByTestId('classification-l1-values').textContent).toContain('NOVAT')
  })

  it('a 404 reverts, says the line is outside the entity scope, and asks the page to load the view again', async () => {
    const onOutOfScope = vi.fn()
    const { onClassify } = await renderPanel(eurLine(), { onOutOfScope })
    onClassify.mockRejectedValue(problem(404, 'not_found'))
    fireEvent.change(account(), { target: { value: '5902' } })
    const alert = await screen.findByText("This line is outside your entity scope, so you can't change it.")
    expect(alert.getAttribute('role')).toBe('alert')
    expect(account().value).toBe('5901')
    expect(onOutOfScope).toHaveBeenCalledTimes(1)
  })

  it('an out-of-scope line is one short note: no select, no account, VAT code, rate, CHF or VAT figure', async () => {
    window.history.pushState(null, '', '/')
    render(
      <LineClassificationPanel
        line={eurLine({ inScope: false, classification: null, chf: null, vatAmountCents: null })}
        lineLabel="x"
        state="review"
        canChange
        options={OPTIONS}
        canOpenRates
        onClassify={vi.fn()}
        onConflict={vi.fn()}
        onOptionsStale={vi.fn()}
      />,
    )
    const note = screen.getByTestId('classification-l1-out-of-scope')
    expect(note.textContent).toBe(
      'Not shown: this line is outside your entity scope. Ask a colleague with WellD CH access.',
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByTestId('classification-l1')).toBeNull()
    expect(screen.queryByTestId('classification-l1-chf')).toBeNull()
    expect(screen.queryByTestId('classification-l1-vat-amount')).toBeNull()
    expect(document.body.textContent).not.toMatch(/5901|NOVAT|0\.9246|CHF \d/)
  })

  it('an in-scope line whose CHF block is missing shows "—", never a figure or a crash', async () => {
    await renderPanel(eurLine({ chf: null, vatAmountCents: null }), { canChange: false })
    expect(screen.getByTestId('classification-l1-chf').textContent).toBe('—')
    expect(screen.getByTestId('classification-l1-vat-amount').textContent).toBe('—')
  })
})

// T44: automated axe checks (test-support/axe.ts) on every state the panel has. Each state is rendered by itself.
describe('LineClassificationPanel: accessibility (axe)', () => {
  const missingRate = () =>
    eurLine({
      chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'missing' },
      vatAmountCents: null,
    })

  const states: Array<[string, () => AccountingLine, Partial<LineClassificationPanelProps>]> = [
    ['editable foreign line', () => eurLine(), {}],
    ['editable CHF line', () => chfLine(), {}],
    ['editable, post-approval (no amounts note)', () => eurLine(), { state: 'post_approval' }],
    ['options still loading', () => eurLine(), { options: null }],
    [
      'a set-by-hand value',
      () => eurLine({ classification: { account: HOTEL, accountIsDefault: false, vatCode: IMP81, vatCodeIsDefault: false } }),
      {},
    ],
    [
      'both values missing, before any refusal',
      () => eurLine({ classification: { account: null, accountIsDefault: false, vatCode: null, vatCodeIsDefault: false }, vatAmountCents: null }),
      {},
    ],
    [
      'both values missing, after a refused approval',
      () => eurLine({ classification: { account: null, accountIsDefault: false, vatCode: null, vatCodeIsDefault: false }, vatAmountCents: null }),
      { missing: { account: true, vatCode: true } },
    ],
    [
      'an inactive current value',
      () => eurLine({ classification: { account: { ...TRAIN, state: 'deactivated' as const }, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }),
      { options: { ledgerAccounts: [{ number: HOTEL.number, name: HOTEL.name }], vatCodes: OPTIONS.vatCodes } },
    ],
    ['rate missing, without the Accounting link', missingRate, {}],
    ['rate missing, with the link to the rates', missingRate, { canOpenRates: true }],
    [
      'rate pending after approval, with the link and without',
      () =>
        eurLine({
          chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'pending' },
          vatAmountCents: null,
        }),
      { state: 'post_approval', canOpenRates: true },
    ],
    [
      'a copy that is no longer in Accounting',
      () =>
        eurLine({
          classification: {
            account: { ...TRAIN, state: 'not_found' },
            accountIsDefault: false,
            vatCode: { ...NOVAT, state: 'deactivated' },
            vatCodeIsDefault: false,
          },
        }),
      { options: { ledgerAccounts: [{ number: HOTEL.number, name: HOTEL.name }], vatCodes: [OPTIONS.vatCodes[1]] } },
    ],
    [
      'a type default that is no longer usable, shown as missing with its reason',
      () =>
        eurLine({
          classification: {
            account: { ...TRAIN, state: 'deactivated' },
            accountIsDefault: true,
            vatCode: { ...NOVAT, state: 'not_found' },
            vatCodeIsDefault: true,
          },
        }),
      { missing: { account: true, vatCode: true } },
    ],
    [
      'Accounting cannot be read',
      () =>
        eurLine({
          classification: {
            account: { ...TRAIN, state: 'unverified' },
            accountIsDefault: true,
            vatCode: { ...NOVAT, state: 'unverified' },
            vatCodeIsDefault: false,
          },
          chf: { amountCents: null, rateMicros: null, rate: null, rateMonth: '2026-03', rateStatus: 'unavailable' },
          vatAmountCents: null,
        }),
      { accountingUnavailable: true },
    ],
    ['after approval, kept as booked', () => eurLine(), { state: 'post_approval' }],
    ['read-only without the capability', () => eurLine(), { canChange: false }],
    ['read-only, post-approval', () => eurLine(), { canChange: false, state: 'post_approval' }],
    ['read-only, CHF block missing', () => eurLine({ chf: null, vatAmountCents: null }), { canChange: false }],
    ['read-only, a value not set', () => eurLine({ classification: { account: null, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }), { canChange: false }],
    ['locked: the batch is paid', () => eurLine(), { state: 'locked' }],
    ['self-restricted, with the capability', () => eurLine(), { selfRestricted: true, canChange: true }],
    ['self-restricted, without the capability', () => eurLine(), { selfRestricted: true, canChange: false }],
    ['self-restricted, in a paid batch', () => eurLine(), { selfRestricted: true, canChange: true, state: 'locked' }],
  ]

  it.each(states)('has no violations: %s', async (_name, line, props) => {
    await renderPanel(line(), props)
    await expectNoAxeViolations()
  })

  it('has no violations: saving, saved, and each refusal of a change', async () => {
    const { onClassify } = await renderPanel(eurLine())
    onClassify.mockReturnValueOnce(new Promise(() => {}))
    fireEvent.change(account(), { target: { value: '5902' } })
    await waitFor(() => expect(account().getAttribute('aria-busy')).toBe('true'))
    await expectNoAxeViolations()
    cleanup()

    const saved = await renderPanel(eurLine())
    saved.onClassify.mockResolvedValue(
      eurLine({ classification: { account: HOTEL, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true } }),
    )
    fireEvent.change(account(), { target: { value: '5902' } })
    await screen.findByTestId('classification-l1-saved')
    await expectNoAxeViolations()
    cleanup()

    for (const [error, expected] of [
      [problem(422, 'ledger_account_inactive'), 'That account was deactivated. Choose another.'],
      [problem(403), "You don't have permission to change this classification."],
      [problem(500), 'Could not change the classification. Try again.'],
      [problem(404, 'not_found'), "This line is outside your entity scope, so you can't change it."],
    ] as const) {
      const { onClassify: classify } = await renderPanel(eurLine())
      classify.mockRejectedValue(error)
      fireEvent.change(account(), { target: { value: '5902' } })
      await screen.findByText(expected)
      await expectNoAxeViolations()
      cleanup()
    }
  })

  it('has no violations: the panel after a 403 self_approval_forbidden turned it read-only', async () => {
    const { onClassify } = await renderPanel(eurLine())
    onClassify.mockRejectedValue(problem(403, 'self_approval_forbidden'))
    fireEvent.change(account(), { target: { value: '5902' } })
    await screen.findByTestId('classification-l1-why')
    await expectNoAxeViolations()
  })

  it('has no violations: an out-of-scope line (one note)', async () => {
    window.history.pushState(null, '', '/')
    render(
      <LineClassificationPanel
        line={eurLine({ inScope: false, classification: null, chf: null, vatAmountCents: null })}
        lineLabel="x"
        state="review"
        canChange
        options={OPTIONS}
        canOpenRates
        onClassify={vi.fn()}
        onConflict={vi.fn()}
        onOptionsStale={vi.fn()}
      />,
    )
    await screen.findByTestId('classification-l1-out-of-scope')
    await expectNoAxeViolations()
  })
})
