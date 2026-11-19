/**
 * @vitest-environment jsdom
 *
 * Keyboard-only paths of the Accounting app (T46 QE pass, specs/20261119-accounting; AC-8.4 "everything is usable with the
 * keyboard alone"; plan § Test strategy AC-8.4: "keyboard-only add, deactivate and correct (RTL `userEvent.keyboard`, and e2e
 * for one dialog)").
 *
 * The component suites drive every control with `fireEvent.click`, which proves what a control does, not that a person
 * with no pointer can reach and operate it. These tests use `user-event` as a keyboard would: Tab (bounded, so an
 * unreachable control is a failure and not a hang), Enter, Space and Escape, never a click. Each path is the one the plan
 * names: add an account, deactivate and reactivate it, and correct a rate. The e2e (`shell/e2e/accounting.spec.ts`) repeats
 * the add path in a real browser: that run is the owner's (T51).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeApi } from './test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from './test-support/fakeApi'
import type { LedgerAccount } from './lib/catalogApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({ apiFetch, getAccountingApiBaseUrl: () => 'http://accounting-api.test' }))

import LedgerAccountsCard from './components/LedgerAccountsCard'
import ExchangeRatesCard from './components/ExchangeRatesCard'

const ACTIVE: LedgerAccount = { number: '5905', name: 'Spese rimborsi', active: true }
const LIST = 'GET /v1/entities/welld_ch/ledger-accounts'
const list = (...items: LedgerAccount[]): FakeAnswer => ({ status: 200, body: { entity: 'welld_ch', items } })
const serve = (routes: Record<string, FakeHandler>) => apiFetch.mockImplementation(fakeApi(routes))
const calls = (key: string) =>
  apiFetch.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}` === key)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** Tab until `testId` has the focus; fails (instead of hanging) when it is not reached within `max` presses. */
async function tabTo(user: ReturnType<typeof userEvent.setup>, testId: string, max = 25): Promise<HTMLElement> {
  const target = screen.getByTestId(testId)
  for (let i = 0; i < max; i++) {
    if (document.activeElement === target) return target
    await user.tab()
  }
  expect(document.activeElement, `${testId} is not reachable with Tab within ${max} presses`).toBe(target)
  return target
}

describe('Accounting: the ledger-account paths with the keyboard alone (AC-8.4, AC-1.1, AC-1.4, AC-1.9)', () => {
  it('adds an account: Tab to Add, Enter, type, Tab, type, Enter; focus comes back to Add', async () => {
    const created: LedgerAccount = { number: '2620.1', name: 'Anticipi', active: true }
    let added = false
    serve({
      [LIST]: () => list(ACTIVE, ...(added ? [created] : [])),
      'POST /v1/entities/welld_ch/ledger-accounts': () => ((added = true), { status: 201, body: created }),
    })
    const user = userEvent.setup()
    render(<LedgerAccountsCard entity="welld_ch" canManage onEntityGone={vi.fn()} onWriteRefused={vi.fn()} />)
    await screen.findByTestId('accounting-ledger-table')

    await tabTo(user, 'accounting-ledger-add')
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Add ledger account — WellD CH' })
    expect(dialog).not.toBeNull()
    // the dialog puts the focus on its first field, and the fields follow in reading order
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-number'))
    await user.keyboard('2620.1')
    await user.tab()
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-name'))
    await user.keyboard('Anticipi{Enter}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(JSON.parse(String(calls('POST /v1/entities/welld_ch/ledger-accounts')[0]![1]!.body))).toEqual({ number: '2620.1', name: 'Anticipi' })
    expect(screen.getByTestId('accounting-ledger-row-2620.1')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-add'))
  })

  it('a refused value takes the focus, and Escape closes the dialog without a request', async () => {
    serve({ [LIST]: () => list(ACTIVE) })
    const user = userEvent.setup()
    render(<LedgerAccountsCard entity="welld_ch" canManage onEntityGone={vi.fn()} onWriteRefused={vi.fn()} />)
    await screen.findByTestId('accounting-ledger-table')

    await tabTo(user, 'accounting-ledger-add')
    await user.keyboard(' ') // Space activates a button too
    await screen.findByRole('dialog')
    await user.keyboard('59a05')
    await user.tab()
    await user.keyboard('Spese{Enter}') // a number with a letter, a valid name
    // nothing was sent, and the refused field (the number, the first one) holds the focus with an alert of its own
    expect(calls('POST /v1/entities/welld_ch/ledger-accounts')).toHaveLength(0)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-number')))
    expect(within(screen.getByRole('dialog')).getAllByRole('alert').length).toBeGreaterThan(0)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls('POST /v1/entities/welld_ch/ledger-accounts')).toHaveLength(0)
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-add'))
  })

  it('deactivates and reactivates: Tab to the row action, Enter, Tab from Cancel to Confirm, Enter; then Enter on Reactivate', async () => {
    serve({
      [LIST]: () => list(ACTIVE),
      'POST /v1/entities/welld_ch/ledger-accounts/5905/deactivate': () => ({ status: 200, body: { ...ACTIVE, active: false } }),
      'POST /v1/entities/welld_ch/ledger-accounts/5905/reactivate': () => ({ status: 200, body: ACTIVE }),
    })
    const user = userEvent.setup()
    render(<LedgerAccountsCard entity="welld_ch" canManage onEntityGone={vi.fn()} onWriteRefused={vi.fn()} />)
    await screen.findByTestId('accounting-ledger-table')

    await tabTo(user, 'accounting-ledger-deactivate-5905')
    await user.keyboard('{Enter}')
    await screen.findByRole('alertdialog', { name: 'Deactivate account 5905?' })
    // the safe button has the focus first; the confirm is one Tab away
    expect(document.activeElement).toBe(screen.getByTestId('accounting-ledger-deactivate-dialog-cancel'))
    await tabTo(user, 'accounting-ledger-deactivate-dialog-confirm', 4)
    await user.keyboard('{Enter}')

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const row = screen.getByTestId('accounting-ledger-row-5905')
    expect(within(row).getByText('Inactive')).not.toBeNull()
    expect(document.activeElement).toBe(within(row).getByRole('rowheader'))
    expect(calls('POST /v1/entities/welld_ch/ledger-accounts/5905/deactivate')).toHaveLength(1)

    await tabTo(user, 'accounting-ledger-reactivate-5905')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(within(screen.getByTestId('accounting-ledger-row-5905')).queryByText('Inactive')).toBeNull())
    expect(calls('POST /v1/entities/welld_ch/ledger-accounts/5905/reactivate')).toHaveLength(1)
  })
})

describe('Accounting: a rate correction with the keyboard alone (AC-8.4, AC-2.4)', () => {
  it('Tab to Correct, Enter, type the rate, Enter; the cell shows it and the focus returns to the opener', async () => {
    const march = { month: '2026-03', rates: { EUR: { status: 'fetched', rateMicros: 924600, rate: '0.9246' }, USD: { status: 'missing' }, GBP: { status: 'missing' } } }
    const body = (usd: unknown) => ({
      entity: 'welld_ch',
      ownCurrency: 'CHF',
      currencies: ['EUR', 'USD', 'GBP'],
      source: { name: 'bazg' },
      months: [{ ...march, rates: { ...march.rates, USD: usd } }],
      lastFetch: null,
      fetchDue: false,
    })
    let corrected = false
    serve({
      'GET /v1/entities/welld_ch/exchange-rates': () => ({ status: 200, body: body(corrected ? { status: 'corrected', rateMicros: 810200, rate: '0.8102' } : { status: 'missing' }) }),
      'PUT /v1/entities/welld_ch/exchange-rates/2026-03/USD': () => (
        (corrected = true),
        { status: 200, body: { month: '2026-03', rates: { ...march.rates, USD: { status: 'corrected', rateMicros: 810200, rate: '0.8102' } } } }
      ),
    })
    const user = userEvent.setup()
    render(<ExchangeRatesCard entity="welld_ch" canManage onEntityGone={vi.fn()} onWriteRefused={vi.fn()} />)
    await screen.findByTestId('accounting-fx-correct-2026-03-USD')

    await tabTo(user, 'accounting-fx-correct-2026-03-USD', 40)
    await user.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'Correct rate — USD · March 2026' })
    expect(document.activeElement).toBe(screen.getByTestId('accounting-fx-correction-value'))
    await user.keyboard('0.8102{Enter}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const put = apiFetch.mock.calls.find(([url, init]) => init?.method === 'PUT' && String(url).endsWith('/exchange-rates/2026-03/USD'))
    expect(put).toBeDefined()
    expect(JSON.parse(String(put![1]!.body))).toMatchObject({ rate: '0.8102' })
    // the row was re-read, so the opener is a new node: the focus is on the same control, by its test id
    expect(document.activeElement).toBe(screen.getByTestId('accounting-fx-correct-2026-03-USD'))
  })
})

beforeEach(() => {
  apiFetch.mockReset()
})
