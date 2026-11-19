/**
 * @vitest-environment jsdom
 *
 * AccountingLinkNote (T34, specs/20261119-accounting, AC-4.6, UX-16, UX-17): a link with Accounting among the
 * user's apps, the sentence alone without it, in both languages.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

import * as session from 'shell/session'
import { catalogs } from '../strings'
import { expectNoAxeViolations } from '../test-support/axe'
import AccountingLinkNote from './AccountingLinkNote'

type Permissions = ReturnType<typeof session.usePermissions>

const withApps = (apps: string[]): Permissions => ({ epoch: 1, apps, roles: [], departments: [], permissions: [] })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AccountingLinkNote', () => {
  it('with Accounting among the apps: the sentence and a plain link to /accounting', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(withApps(['refund', 'accounting']))
    render(<AccountingLinkNote />)

    const link = screen.getByRole('link', { name: catalogs.en.settings.accountingLink.linkLabel })
    expect(link.getAttribute('href')).toBe('/accounting')
    expect(link.textContent).toBe('Open Accounting')
    expect(link.className).toContain('link')
    expect(screen.getByTestId('settings-accounting-link-note').textContent).toContain(
      'Ledger accounts, VAT codes and exchange rates are kept in the Accounting app.',
    )
    await expectNoAxeViolations()
  })

  it('without Accounting among the apps: who keeps the entries, and no link', async () => {
    vi.mocked(session.usePermissions).mockReturnValue(withApps(['refund']))
    render(<AccountingLinkNote />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByTestId('settings-accounting-link-note').textContent).toBe(
      'Ledger accounts, VAT codes and exchange rates are kept in the Accounting app by accounting managers. Ask one of them if an entry is missing.',
    )
    await expectNoAxeViolations()
  })

  it('with no grants resolved yet it fails closed to the text without a link', () => {
    vi.mocked(session.usePermissions).mockReturnValue(withApps([]))
    render(<AccountingLinkNote />)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('the Italian note names the app Contabilità, with and without the link', () => {
    const it_ = catalogs.it.settings.accountingLink
    expect(it_.withAccess).toContain('Contabilità')
    expect(it_.withoutAccess).toContain('responsabili della contabilità')
  })

  it('the link’s accessible name starts with its visible text (WCAG 2.5.3)', () => {
    for (const lang of [catalogs.en, catalogs.it]) {
      expect(lang.settings.accountingLink.linkLabel.startsWith(lang.settings.accountingLink.linkText)).toBe(true)
    }
  })
})
