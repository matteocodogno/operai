/**
 * @vitest-environment jsdom
 *
 * AccountingSettingsView (T24, specs/20261118-refund-accounting-export): the two catalog cards, and the write controls
 * following `settings:manage` from the shell's permissions (AC-1.7, UI side).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return { ...original, listLedgerAccounts: vi.fn(), listVatCodes: vi.fn() }
})

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

import * as session from 'shell/session'
import * as accountingApi from '../../lib/accountingApi'
import AccountingSettingsView from './AccountingSettingsView'

type Permissions = ReturnType<typeof session.usePermissions>

const grant = (...actions: string[]): Permissions => ({
  epoch: 1,
  apps: ['refund'],
  roles: [],
  departments: [],
  permissions: actions.map((action) => ({ resource: 'settings', action, conditions: null })),
})

beforeEach(() => {
  vi.mocked(accountingApi.listLedgerAccounts).mockResolvedValue([])
  vi.mocked(accountingApi.listVatCodes).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AccountingSettingsView', () => {
  it('shows the ledger accounts and VAT codes cards with their Add buttons for settings:manage', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(grant('read', 'manage'))
    render(<AccountingSettingsView />)
    expect(await screen.findByTestId('settings-accounts-add')).not.toBeNull()
    expect(screen.getByTestId('settings-vat-codes-add')).not.toBeNull()
  })

  it('shows both cards read-only with settings:read alone', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(grant('read'))
    render(<AccountingSettingsView />)
    expect(await screen.findByTestId('settings-accounts-card')).not.toBeNull()
    expect(screen.getByTestId('settings-vat-codes-card')).not.toBeNull()
    await screen.findAllByText('No ledger accounts yet')
    expect(screen.queryByTestId('settings-accounts-add')).toBeNull()
    expect(screen.queryByTestId('settings-vat-codes-add')).toBeNull()
  })

  it('has no <form> of its own for a dialog to nest in', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(grant('read', 'manage'))
    const { container } = render(<AccountingSettingsView />)
    await screen.findByTestId('settings-accounts-add')
    expect(container.querySelectorAll('form')).toHaveLength(0)
  })
})
