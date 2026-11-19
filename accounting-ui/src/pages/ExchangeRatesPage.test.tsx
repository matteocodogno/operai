/**
 * @vitest-environment jsdom
 *
 * ExchangeRatesPage inside the real frame (T31, specs/20261119-accounting, design AS2, AS5, FA2, FA9, FA10, UX-11, UX-12, UX-13;
 * AC-2.3, AC-2.11, AC-3.4, AC-7.3, AC-8.2): the card is keyed by entity and reads that entity's path; WellD Italia shows the
 * no-source panel; `?month=` is the AC-7.3 deep link and is dropped when the entity changes; the frame hears a 404 from the list
 * and a 403 from a write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import AccountingShell from '../components/AccountingShell'
import { createAppRouter } from '../router'
import { fakeApi, meAnswer, meEntity, meItalia, problem } from '../test-support/fakeApi'
import type { FakeHandler } from '../test-support/fakeApi'
import { expectNoAxeViolations } from '../test-support/axe'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getAccountingApiBaseUrl: () => 'http://accounting-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

const eur = { status: 'fetched', rateMicros: 924600, rate: '0.9246' }
const chRates = (overrides: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    entity: 'welld_ch',
    ownCurrency: 'CHF',
    currencies: ['EUR'],
    source: { name: 'bazg' },
    months: [
      { month: '2026-03', rates: { EUR: eur } },
      { month: '2026-02', rates: { EUR: eur } },
    ],
    lastFetch: null,
    fetchDue: false,
    ...overrides,
  },
})
const itRates = () => ({
  status: 200,
  body: { entity: 'welld_it', ownCurrency: 'EUR', currencies: [], source: null, months: [], lastFetch: null, fetchDue: false },
})

const open = (url: string, routes: Record<string, FakeHandler>) => {
  window.history.pushState(null, '', url)
  apiFetch.mockImplementation(fakeApi(routes))
  return render(<RouterProvider router={createAppRouter('/accounting', AccountingShell)} />)
}

beforeEach(() => {
  window.scrollTo = () => undefined
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ExchangeRatesPage', () => {
  it('h1 the tool, h2 the view, h3 the card named after the entity', async () => {
    const { container } = open('/accounting/exchange-rates', {
      'GET /v1/me': () => meAnswer(meEntity()),
      'GET /v1/entities/welld_ch/exchange-rates': () => chRates(),
    })
    await screen.findByTestId('accounting-fx-table')
    expect(screen.getByRole('heading', { level: 1, name: 'Accounting' })).not.toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Exchange rates' })).not.toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: 'Exchange rates — WellD CH' })).not.toBeNull()
    await expectNoAxeViolations(container)
  })

  it('?month= is the AC-7.3 deep link: it focuses that row, and the entity comes from the same address', async () => {
    open('/accounting/exchange-rates?entity=welld_ch&month=2026-02', {
      'GET /v1/me': () => meAnswer(meEntity()),
      'GET /v1/entities/welld_ch/exchange-rates': () => chRates(),
    })
    await screen.findByTestId('accounting-fx-table')
    expect(document.activeElement).toBe(within(screen.getByTestId('accounting-fx-row-2026-02')).getByRole('rowheader'))
  })

  it('a deep-linked month the table does not list says so', async () => {
    open('/accounting/exchange-rates?entity=welld_ch&month=2026-11', {
      'GET /v1/me': () => meAnswer(meEntity()),
      'GET /v1/entities/welld_ch/exchange-rates': () => chRates(),
    })
    expect((await screen.findByTestId('accounting-fx-deeplink-note')).textContent).toContain('November 2026 is not in the list.')
  })

  it('switching entity remounts the card: Italia’s own path, the no-source panel, and the month of the old link is dropped', async () => {
    const user = userEvent.setup()
    open('/accounting/exchange-rates?month=2026-02', {
      'GET /v1/me': () => meAnswer(meEntity(), meItalia()),
      'GET /v1/entities/welld_ch/exchange-rates': () => chRates(),
      'GET /v1/entities/welld_it/exchange-rates': () => itRates(),
    })
    await screen.findByTestId('accounting-fx-table')
    await user.selectOptions(screen.getByLabelText('Entity'), 'welld_it')
    const panel = await screen.findByTestId('accounting-fx-no-source')
    expect(panel.textContent).toContain('No official source for WellD Italia yet')
    expect(screen.queryByTestId('accounting-fx-table')).toBeNull()
    expect(screen.queryByTestId('accounting-fx-deeplink-note')).toBeNull()
    expect(window.location.search).toContain('entity=welld_it')
    expect(window.location.search).not.toContain('month')
  })

  it('a list that answers 404 re-reads /v1/me, falls back and says so once', async () => {
    let me = 0
    open('/accounting/exchange-rates?entity=welld_it', {
      'GET /v1/me': () => (me++ === 0 ? meAnswer(meEntity(), meItalia()) : meAnswer(meEntity())),
      'GET /v1/entities/welld_it/exchange-rates': () => problem(404, 'not_found'),
      'GET /v1/entities/welld_ch/exchange-rates': () => chRates(),
    })
    expect((await screen.findByTestId('accounting-notice')).textContent).toBe(
      'You no longer have access to WellD Italia. Showing WellD CH.',
    )
    await screen.findByTestId('accounting-fx-table')
  })

  it('a correction answering 403 re-reads /v1/me: the controls disappear, with one note', async () => {
    const user = userEvent.setup()
    let me = 0
    open('/accounting/exchange-rates', {
      'GET /v1/me': () => (me++ === 0 ? meAnswer(meEntity()) : meAnswer(meEntity({ canManage: false }))),
      'GET /v1/entities/welld_ch/exchange-rates': () => chRates(),
      'PUT /v1/entities/welld_ch/exchange-rates/2026-03/EUR': () => problem(403, 'accounting_manage_required'),
    })
    await screen.findByTestId('accounting-fx-table')
    await user.click(screen.getByTestId('accounting-fx-correct-2026-03-EUR'))
    await user.type(screen.getByTestId('accounting-fx-correction-value'), '0.93')
    await user.click(screen.getByTestId('accounting-fx-correction-submit'))
    await waitFor(() =>
      expect(screen.getByTestId('accounting-notice').textContent).toBe('Your access to Accounting changed. The page was updated.'),
    )
    expect(screen.queryByTestId('accounting-fx-fetch-now')).toBeNull()
    expect(screen.queryByTestId('accounting-fx-correct-2026-02-EUR')).toBeNull()
    expect(screen.getByTestId('accounting-fx-read-only')).not.toBeNull()
  })
})
