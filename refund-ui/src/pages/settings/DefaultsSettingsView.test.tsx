/**
 * @vitest-environment jsdom
 *
 * DefaultsSettingsView (T34, specs/20261119-accounting; it was AccountingSettingsView, T24 of 20261118): the
 * Accounting link note, the default classification card and no catalog cards, with the write controls following
 * `settings:manage` from the shell's permissions (AC-1.7 of 20261118, UI side; AC-4.6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('../../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/accountingApi')>()
  return { ...original, getExpenseTypeDefaults: vi.fn() }
})

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

import * as session from 'shell/session'
import * as accountingApi from '../../lib/accountingApi'
import DefaultsSettingsView from './DefaultsSettingsView'

type Permissions = ReturnType<typeof session.usePermissions>

const grant = (...actions: string[]): Permissions => ({
  epoch: 1,
  apps: ['refund'],
  roles: [],
  departments: [],
  permissions: actions.map((action) => ({ resource: 'settings', action, conditions: null })),
})

beforeEach(() => {
  vi.mocked(accountingApi.getExpenseTypeDefaults).mockResolvedValue({
    entity: 'welld_ch',
    accounting: 'available',
    foreignCurrencyVatCode: null,
    foreignCurrencyVatCodeUsable: false,
    foreignCurrencyVatCodeHistory: [],
    types: [],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DefaultsSettingsView', () => {
  it('heads the default classification card with the Accounting link note', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(grant('read'))
    render(<DefaultsSettingsView />)
    const note = screen.getByTestId('settings-accounting-link-note')
    const card = await screen.findByTestId('settings-defaults-card')
    expect(note.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows Change for settings:manage', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(grant('read', 'manage'))
    render(<DefaultsSettingsView />)
    expect(await screen.findByTestId('settings-foreign-vat-change')).not.toBeNull()
  })

  it('shows the card read-only with settings:read alone', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(grant('read'))
    render(<DefaultsSettingsView />)
    expect(await screen.findByTestId('settings-defaults-card')).not.toBeNull()
    expect(screen.queryByTestId('settings-foreign-vat-change')).toBeNull()
  })

  it('mounts no ledger-account or VAT-code card (they live in Accounting, AC-4.6)', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(grant('read', 'manage'))
    render(<DefaultsSettingsView />)
    await screen.findByTestId('settings-defaults-card')
    expect(screen.queryByTestId('settings-accounts-card')).toBeNull()
    expect(screen.queryByTestId('settings-vat-codes-card')).toBeNull()
    expect(screen.queryByTestId('settings-accounts-add')).toBeNull()
  })

  it('has no <form> of its own for a dialog to nest in', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(grant('read', 'manage'))
    const { container } = render(<DefaultsSettingsView />)
    await screen.findByTestId('settings-foreign-vat-change')
    expect(container.querySelectorAll('form')).toHaveLength(0)
  })
})
