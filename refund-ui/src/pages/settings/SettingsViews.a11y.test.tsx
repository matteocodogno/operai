/**
 * @vitest-environment jsdom
 *
 * Settings, whole page (T44, specs/20261118-refund-accounting-export): axe on the page the way a user gets it, through
 * the real route tree, with data in every card. Each card and dialog has its own axe checks beside its unit tests;
 * this one covers what only the page adds: the tab list and its panel, the three views as an administrator and as
 * a reader (no write controls), and the page without the new views (no `settings:read`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import { expectNoAxeViolations } from '../../test-support/axe'

vi.mock('../../lib/ratesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/ratesApi')>()
  return { ...original, listRates: vi.fn(), addRate: vi.fn() }
})

vi.mock('../../lib/settingsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/settingsApi')>()
  return { ...original, getSetting: vi.fn(), putSetting: vi.fn() }
})

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return { ...original, listLedgerAccounts: vi.fn(), listVatCodes: vi.fn(), getExpenseTypeDefaults: vi.fn() }
})

vi.mock('../../lib/exchangeRatesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/exchangeRatesApi')>()
  return { ...original, listExchangeRates: vi.fn(), fetchExchangeRates: vi.fn(), putExchangeRate: vi.fn() }
})

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

import * as session from 'shell/session'
import * as ratesApi from '../../lib/ratesApi'
import * as settingsApi from '../../lib/settingsApi'
import * as accountingApi from '../../lib/accountingApi'
import * as exchangeRatesApi from '../../lib/exchangeRatesApi'
import { EXPENSE_TYPES } from '../../lib/expenseTypes'
import { createAppRouter } from '../../router'

type Permissions = ReturnType<typeof session.usePermissions>

const grant = (...pairs: [string, string][]): Permissions => ({
  epoch: 1,
  apps: ['refund'],
  roles: [],
  departments: [],
  permissions: pairs.map(([resource, action]) => ({ resource, action, conditions: null })),
})

const RATE_ONLY = grant(['rate', 'read'])
const SETTINGS_READER = grant(['rate', 'read'], ['settings', 'read'])
const SETTINGS_ADMIN = grant(['rate', 'read'], ['rate', 'manage'], ['settings', 'read'], ['settings', 'manage'])

const ACCOUNT = { id: 'a1', number: '5901', name: 'Spese viaggi', active: true }
const VAT = { id: 'v1', code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', active: true }
const audit = { createdAt: '2026-03-01T09:00:00Z', createdByEmail: 'admin@welld.ch', history: [] }

const fetched = (rate: string, micros: number) => ({
  status: 'fetched' as const,
  rateMicros: micros,
  rate,
  fetchedAt: '2026-04-02T07:00:00Z',
  history: [{ origin: 'fetched' as const, rate, at: '2026-04-02T07:00:00Z', byEmail: 'system' }],
})

beforeEach(() => {
  vi.mocked(session.usePermissions).mockReturnValue(SETTINGS_ADMIN)
  vi.mocked(ratesApi.listRates).mockResolvedValue({ entities: [] })
  vi.mocked(settingsApi.getSetting).mockResolvedValue({
    key: 'accounting-distribution-email',
    value: null,
    configured: false,
    updatedAt: null,
    updatedByEmail: null,
    history: [],
  })
  vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([
    { ...ACCOUNT, ...audit },
    { id: 'a2', number: '5902', name: 'Spese alberghi', active: false, ...audit },
  ])
  vi.mocked(accountingApi.listVatCodes).mockResolvedValue([
    { ...VAT, rateBasisPoints: 0, ...audit },
    {
      id: 'v2',
      code: 'IMP81',
      label: 'Imposta piena',
      ratePercent: '8.1',
      rateBasisPoints: 810,
      active: false,
      ...audit,
    },
  ])
  vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue({
    entity: 'welld_ch',
    foreignCurrencyVatCode: VAT,
    foreignCurrencyVatCodeUsable: true,
    foreignCurrencyVatCodeHistory: [],
    types: EXPENSE_TYPES.map((option) => ({
      type: option.id,
      account: option.id === 'travel_train' ? ACCOUNT : null,
      vatCode: option.id === 'travel_train' ? VAT : null,
      updatedAt: option.id === 'travel_train' ? '2026-04-01T09:00:00Z' : null,
      updatedByEmail: option.id === 'travel_train' ? 'admin@welld.ch' : null,
      history: [],
    })),
  })
  vi.mocked(exchangeRatesApi.listExchangeRates).mockResolvedValue({
    months: [
      {
        month: '2026-03',
        rates: { EUR: fetched('0.9246', 924600), USD: fetched('0.8102', 810200), GBP: { status: 'missing' } },
      },
    ],
    lastFetch: { at: '2026-11-18T09:14:00Z', outcome: 'failed', errorCode: 'timeout', month: '2026-10' },
    fetchDue: false,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState(null, '', '/')
})

const openSettings = async (search = '') => {
  window.history.pushState(null, '', `/settings${search}`)
  render(<RouterProvider router={createAppRouter()} />)
  await screen.findByTestId('refund-settings-page')
}

describe('Settings page: accessibility (axe)', () => {
  it('has no violations without settings:read: no tab list, the General view only', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(RATE_ONLY)
    await openSettings()
    await screen.findByTestId('refund-settings-view-general')
    await waitFor(() => expect(ratesApi.listRates).toHaveBeenCalled())
    await expectNoAxeViolations()
  })

  it.each([
    ['an administrator', SETTINGS_ADMIN],
    ['a reader', SETTINGS_READER],
  ])('has no violations for %s: the tab list with each of the three views open', async (_who, permissions) => {
    vi.mocked(session.usePermissions).mockReturnValue(permissions)
    await openSettings()
    await screen.findByTestId('refund-settings-view-general')
    await expectNoAxeViolations()

    fireEvent.click(screen.getByRole('tab', { name: 'Accounts and VAT' }))
    await screen.findByTestId('settings-accounts-table')
    await screen.findByTestId('settings-vat-codes-table')
    await screen.findByTestId('settings-defaults-table')
    await expectNoAxeViolations()

    fireEvent.click(screen.getByRole('tab', { name: 'Exchange rates' }))
    await screen.findByTestId('settings-fx-table')
    await screen.findByTestId('settings-fx-failed')
    await expectNoAxeViolations()
  })

  it('has no violations on the deep link to a month of the exchange rates', async () => {
    await openSettings('?section=exchange-rates&month=2026-03')
    await screen.findByTestId('settings-fx-table')
    await expectNoAxeViolations()
  })
})
