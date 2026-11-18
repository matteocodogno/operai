/**
 * @vitest-environment jsdom
 *
 * The Settings views (T23, specs/20261118-refund-accounting-export, design UX-1 / S1; AC-1.7, AC-2.8, AC-5.7 UI side):
 * a tab list only when the user can open more than one view, only the open view mounted, the view and the
 * exchange-rates month in the URL (`?section=`, `&month=`), and the page working outside a router.
 *
 * The page is mounted through the real route tree (`createAppRouter`), so the search validation and the
 * tab-to-URL wiring under test are the shipped ones. The mileage-rate and email APIs are mocked: the General
 * view is today's page and is covered by SettingsPage.test.tsx.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'
import SettingsPage from '../SettingsPage'

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
  return { ...original, listLedgerAccounts: vi.fn(), listVatCodes: vi.fn() }
})

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

import * as session from 'shell/session'
import * as ratesApi from '../../lib/ratesApi'
import * as settingsApi from '../../lib/settingsApi'
import * as accountingApi from '../../lib/accountingApi'
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

const openSettings = async (search = '') => {
  window.history.pushState(null, '', `/settings${search}`)
  const router = createAppRouter()
  render(<RouterProvider router={router} />)
  await screen.findByTestId('refund-settings-page')
  return router
}

const tabNames = () => screen.queryAllByRole('tab').map((tab) => tab.textContent)

beforeEach(() => {
  vi.mocked(session.usePermissions).mockReturnValue(SETTINGS_ADMIN)
  vi.mocked(ratesApi.listRates).mockResolvedValue({ entities: [] })
  vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([])
  vi.mocked(accountingApi.listVatCodes).mockResolvedValue([])
  vi.mocked(settingsApi.getSetting).mockResolvedValue({
    key: 'accounting-distribution-email',
    value: null,
    configured: false,
    updatedAt: null,
    updatedByEmail: null,
    history: [],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState(null, '', '/')
})

describe('which views a user gets (AC-1.7, AC-2.8, AC-5.7, UI side)', () => {
  it('without settings:read there is no tab list at all: the page is today’s page', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(RATE_ONLY)
    await openSettings()

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.getByTestId('refund-settings-view-general')).not.toBeNull()
    expect(screen.queryByTestId('refund-settings-accounting')).toBeNull()
    expect(screen.queryByTestId('refund-settings-exchange-rates')).toBeNull()
    expect(
      screen.getByText('The per-km mileage rate of each entity and the address that receives the monthly batch.'),
    ).not.toBeNull()
  })

  it('with no grants at all (permissions not resolved yet) it fails closed to the General view', async () => {
    vi.mocked(session.usePermissions).mockReturnValue({
      epoch: 0,
      apps: [],
      roles: [],
      departments: [],
      permissions: [],
    })
    await openSettings()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByTestId('refund-settings-view-general')).not.toBeNull()
  })

  it.each(['?section=accounting', '?section=exchange-rates&month=2026-03'])(
    'without settings:read, a deep link %s still shows only General, and nothing of the other views mounts',
    async (search) => {
      vi.mocked(session.usePermissions).mockReturnValue(RATE_ONLY)
      await openSettings(search)

      expect(screen.getByTestId('refund-settings-view-general')).not.toBeNull()
      expect(screen.queryByTestId('refund-settings-accounting')).toBeNull()
      expect(screen.queryByTestId('refund-settings-exchange-rates')).toBeNull()
    },
  )

  it('with settings:read the three views are offered, in order, in a labelled tab list', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(SETTINGS_READER)
    await openSettings()

    expect(screen.getByRole('tablist', { name: 'Settings sections' })).not.toBeNull()
    expect(tabNames()).toEqual(['General', 'Accounts and VAT', 'Exchange rates'])
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true')
    expect(
      screen.getByText(
        'The mileage rates, the accounting setup (ledger accounts, VAT codes and default classification) and the monthly exchange rates.',
      ),
    ).not.toBeNull()
  })

  it('a user with settings:read but no rate grant still gets the views (the General cards handle their own 403)', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(grant(['settings', 'read']))
    await openSettings()
    expect(tabNames()).toHaveLength(3)
  })
})

describe('?section= picks the view, and only that view is mounted', () => {
  it('opens on General by default, and does not touch the other views’ hosts', async () => {
    await openSettings()
    expect(screen.getByTestId('refund-settings-view-general')).not.toBeNull()
    await waitFor(() => expect(ratesApi.listRates).toHaveBeenCalled())
    expect(screen.queryByTestId('refund-settings-accounting')).toBeNull()
    expect(screen.queryByTestId('refund-settings-exchange-rates')).toBeNull()
    expect(accountingApi.listLedgerAccounts).not.toHaveBeenCalled()
  })

  it('?section=exchange-rates mounts only the exchange-rates view: General, with its fetches, never mounts', async () => {
    await openSettings('?section=exchange-rates')

    expect(screen.getByTestId('refund-settings-exchange-rates')).not.toBeNull()
    expect(screen.queryByTestId('refund-settings-accounting')).toBeNull()
    expect(screen.queryByTestId('rates-section-welld_ch')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Exchange rates' }).getAttribute('aria-selected')).toBe('true')
    expect(ratesApi.listRates).not.toHaveBeenCalled()
    expect(settingsApi.getSetting).not.toHaveBeenCalled()
  })

  it('?section=accounting mounts only the accounting view, with its cards', async () => {
    await openSettings('?section=accounting')
    expect(screen.getByTestId('refund-settings-accounting')).not.toBeNull()
    expect(await screen.findByTestId('settings-accounts-card')).not.toBeNull()
    expect(screen.getByTestId('settings-vat-codes-card')).not.toBeNull()
    expect(screen.queryByTestId('refund-settings-exchange-rates')).toBeNull()
    expect(ratesApi.listRates).not.toHaveBeenCalled()
  })

  it.each([
    '?section=bogus',
    '?section=',
    '?section=General',
    '?section=%3Cscript%3E',
    '?section=1&section=accounting',
  ])('an unknown section (%s) falls back to the first view, with no error', async (search) => {
    await openSettings(search)
    expect(screen.getByTestId('refund-settings-view-general')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the open tab’s panel is labelled by it', async () => {
    await openSettings('?section=accounting')
    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: 'Accounts and VAT' }).id)
  })
})

describe('switching views', () => {
  it('a tab click opens that view, unmounts the previous one and replaces the URL entry (Back does not walk tab clicks)', async () => {
    const router = await openSettings()
    await waitFor(() => expect(ratesApi.listRates).toHaveBeenCalled())
    const historyLength = window.history.length

    fireEvent.click(screen.getByRole('tab', { name: 'Accounts and VAT' }))

    await waitFor(() => expect(screen.getByTestId('refund-settings-accounting')).not.toBeNull())
    expect(screen.queryByTestId('rates-section-welld_ch')).toBeNull()
    expect(screen.queryByTestId('refund-settings-view-general')).toBeNull()
    expect(router.state.location.search).toEqual({ section: 'accounting' })
    expect(window.location.search).toBe('?section=accounting')
    expect(window.history.length).toBe(historyLength)
  })

  it('leaving the exchange-rates view drops the month from the URL', async () => {
    const router = await openSettings('?section=exchange-rates&month=2026-03')
    expect(router.state.location.search).toEqual({ section: 'exchange-rates', month: '2026-03' })

    fireEvent.click(screen.getByRole('tab', { name: 'General' }))

    await waitFor(() => expect(screen.getByTestId('refund-settings-view-general')).not.toBeNull())
    expect(window.location.search).toBe('?section=general')
  })

  it('arrow keys and End move between the tabs and open the focused view', async () => {
    await openSettings()
    const general = screen.getByRole('tab', { name: 'General' })
    general.focus()

    fireEvent.keyDown(general, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByTestId('refund-settings-accounting')).not.toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Accounts and VAT' }))

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    await waitFor(() => expect(screen.getByTestId('refund-settings-exchange-rates')).not.toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Exchange rates' }))
  })
})

describe('?month= is the exchange-rates deep link', () => {
  it('reaches the exchange-rates view when it is a YYYY-MM month', async () => {
    await openSettings('?section=exchange-rates&month=2026-03')
    expect(screen.getByTestId('refund-settings-exchange-rates').getAttribute('data-month')).toBe('2026-03')
  })

  it.each(['2026-13', '2026-3', 'march', '2026-03-01', '', '2026-00', '%22%3E%3Cb%3E'])(
    'drops %j: a malformed month never reaches the view',
    async (month) => {
      await openSettings(`?section=exchange-rates&month=${month}`)
      expect(screen.getByTestId('refund-settings-exchange-rates').hasAttribute('data-month')).toBe(false)
    },
  )
})

describe('outside a router', () => {
  it('SettingsPage keeps its own choice when nobody controls it', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(SETTINGS_READER)
    render(<SettingsPage />)

    expect(screen.getByTestId('refund-settings-view-general')).not.toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Exchange rates' }))
    expect(screen.getByTestId('refund-settings-exchange-rates')).not.toBeNull()
    expect(screen.queryByTestId('refund-settings-view-general')).toBeNull()
  })

  it('SettingsPage starts on the section it was given', () => {
    vi.mocked(session.usePermissions).mockReturnValue(SETTINGS_READER)
    render(<SettingsPage section="accounting" />)
    expect(screen.getByTestId('refund-settings-accounting')).not.toBeNull()
  })

  it('a controlled SettingsPage reports the pick and does not switch by itself', () => {
    vi.mocked(session.usePermissions).mockReturnValue(SETTINGS_READER)
    const onSectionChange = vi.fn()
    render(<SettingsPage section="general" onSectionChange={onSectionChange} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Accounts and VAT' }))

    expect(onSectionChange).toHaveBeenCalledWith('accounting')
    expect(screen.getByTestId('refund-settings-view-general')).not.toBeNull()
  })
})
