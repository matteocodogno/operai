/**
 * @vitest-environment jsdom
 *
 * Settings, whole page (T44, specs/20261118-refund-accounting-export; T34, specs/20261119-accounting): axe on the page
 * the way a user gets it, through the real route tree, with data in the card. Each card and dialog has its own axe
 * checks beside its unit tests; this one covers what only the page adds: the tab list and its panel, the two views
 * as an administrator and as a reader (no write controls), the Accounting link note with and without the link, and
 * the page without the second view (no `settings:read`).
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
  return { ...original, getExpenseTypeDefaults: vi.fn() }
})

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

import * as session from 'shell/session'
import * as ratesApi from '../../lib/ratesApi'
import * as settingsApi from '../../lib/settingsApi'
import * as accountingApi from '../../lib/accountingApi'
import { EXPENSE_TYPES } from '../../lib/expenseTypes'
import { createAppRouter } from '../../router'

type Permissions = ReturnType<typeof session.usePermissions>

const grant = (apps: string[], ...pairs: [string, string][]): Permissions => ({
  epoch: 1,
  apps,
  roles: [],
  departments: [],
  permissions: pairs.map(([resource, action]) => ({ resource, action, conditions: null })),
})

const RATE_ONLY = grant(['refund'], ['rate', 'read'])
const SETTINGS_READER = grant(['refund'], ['rate', 'read'], ['settings', 'read'])
const SETTINGS_ADMIN = grant(
  ['refund', 'accounting'],
  ['rate', 'read'],
  ['rate', 'manage'],
  ['settings', 'read'],
  ['settings', 'manage'],
)

const ACCOUNT = { id: 'a1', number: '5901', name: 'Spese viaggi', active: true }
const VAT = { id: 'v1', code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', active: true }

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
    ['an administrator, with the link to Accounting', SETTINGS_ADMIN],
    ['a reader, with the note and no link', SETTINGS_READER],
  ])('has no violations for %s: the tab list with each of the two views open', async (_who, permissions) => {
    vi.mocked(session.usePermissions).mockReturnValue(permissions)
    await openSettings()
    await screen.findByTestId('refund-settings-view-general')
    await expectNoAxeViolations()

    fireEvent.click(screen.getByRole('tab', { name: 'Default classification' }))
    await screen.findByTestId('settings-defaults-table')
    expect(screen.getByTestId('settings-accounting-link-note')).not.toBeNull()
    await expectNoAxeViolations()
  })

  it('has no violations on a legacy exchange-rates link, which shows General', async () => {
    await openSettings('?section=exchange-rates&month=2026-03')
    await screen.findByTestId('refund-settings-view-general')
    await waitFor(() => expect(ratesApi.listRates).toHaveBeenCalled())
    await expectNoAxeViolations()
  })
})
