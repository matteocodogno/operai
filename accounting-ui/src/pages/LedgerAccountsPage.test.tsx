/**
 * @vitest-environment jsdom
 *
 * LedgerAccountsPage inside the real frame (T29, specs/20261119-accounting, design AS2, AS3, FA2, FA10, UX-4, UX-12, UX-15;
 * AC-1.1, AC-3.4, AC-3.5, AC-8.2, AC-8.3): the card is keyed by entity and reads that entity's path; its write controls come
 * from `/v1/me`'s `canManage`; a list that answers 404 and a write that answers 403 reach the frame, which re-reads `/v1/me`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import AccountingShell from '../components/AccountingShell'
import { createAppRouter } from '../router'
import { fakeApi, meAnswer, meEntity, meItalia, problem } from '../test-support/fakeApi'
import type { FakeAnswer, FakeHandler } from '../test-support/fakeApi'
import { expectNoAxeViolations } from '../test-support/axe'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getAccountingApiBaseUrl: () => 'http://accounting-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

const items = (entity: string, ...rows: Array<[string, string, boolean]>): FakeAnswer => ({
  status: 200,
  body: { entity, items: rows.map(([number, name, active]) => ({ number, name, active })) },
})

const open = (url: string, routes: Record<string, FakeHandler>) => {
  window.history.pushState(null, '', url)
  apiFetch.mockImplementation(fakeApi(routes))
  return render(<RouterProvider router={createAppRouter('/accounting', AccountingShell)} />)
}

const calls = (key: string) =>
  apiFetch.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}` === key)

beforeEach(() => {
  window.scrollTo = () => undefined
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LedgerAccountsPage', () => {
  it('h1 the tool, h2 the view, h3 the card named after the entity; a manager sees Add and per-row actions', async () => {
    const { container } = open('/accounting/ledger-accounts', {
      'GET /v1/me': () => meAnswer(meEntity()),
      'GET /v1/entities/welld_ch/ledger-accounts': () => items('welld_ch', ['1000', 'Cassa', true]),
    })
    await screen.findByTestId('accounting-ledger-table')
    expect(screen.getByRole('heading', { level: 1, name: 'Accounting' })).not.toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'Ledger accounts' })).not.toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: 'Ledger accounts — WellD CH' })).not.toBeNull()
    expect(screen.getByTestId('accounting-ledger-add')).not.toBeNull()
    expect(screen.getByTestId('accounting-ledger-deactivate-1000')).not.toBeNull()
    // one entity: no switch, but the titles still name it (UX-3)
    expect(screen.queryByTestId('accounting-entity-switch')).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('a reader (canManage false for the entity) gets the table and the sentence, no controls (UX-4)', async () => {
    open('/accounting/ledger-accounts', {
      'GET /v1/me': () => meAnswer(meEntity({ canManage: false })),
      'GET /v1/entities/welld_ch/ledger-accounts': () => items('welld_ch', ['1000', 'Cassa', true]),
    })
    await screen.findByTestId('accounting-ledger-table')
    expect(screen.queryByTestId('accounting-ledger-add')).toBeNull()
    expect(screen.getByTestId('accounting-ledger-read-only')).not.toBeNull()
  })

  it('switching entity remounts the card: Italia’s own path, title and empty state; canManage is Italia’s (AC-8.2, AC-8.3)', async () => {
    const user = userEvent.setup()
    open('/accounting/ledger-accounts', {
      'GET /v1/me': () => meAnswer(meEntity({ canManage: true }), meItalia({ canManage: false })),
      'GET /v1/entities/welld_ch/ledger-accounts': () => items('welld_ch', ['1000', 'Cassa', true]),
      'GET /v1/entities/welld_it/ledger-accounts': () => items('welld_it'),
    })
    await screen.findByTestId('accounting-ledger-table')
    expect(screen.getByTestId('accounting-ledger-add')).not.toBeNull()

    await user.selectOptions(screen.getByLabelText('Entity'), 'welld_it')

    const empty = await screen.findByTestId('accounting-empty')
    expect(empty.textContent).toContain('Nothing entered yet for WellD Italia')
    expect(screen.getByRole('heading', { level: 3, name: 'Ledger accounts — WellD Italia' })).not.toBeNull()
    // the CH row is gone with its card, and a reader of Italia gets no Add although the person manages CH
    expect(screen.queryByTestId('accounting-ledger-row-1000')).toBeNull()
    expect(screen.queryByTestId('accounting-ledger-add')).toBeNull()
    expect(window.location.search).toContain('entity=welld_it')
  })

  it('a list that answers 404 re-reads /v1/me, falls back to the entity still covered and says so once (UX-12)', async () => {
    let me = 0
    open('/accounting/ledger-accounts?entity=welld_it', {
      'GET /v1/me': () => (me++ === 0 ? meAnswer(meEntity(), meItalia()) : meAnswer(meEntity())),
      'GET /v1/entities/welld_it/ledger-accounts': () => problem(404, 'not_found'),
      'GET /v1/entities/welld_ch/ledger-accounts': () => items('welld_ch', ['1000', 'Cassa', true]),
    })
    const notice = await screen.findByTestId('accounting-notice')
    expect(notice.textContent).toBe('You no longer have access to WellD Italia. Showing WellD CH.')
    await screen.findByTestId('accounting-ledger-table')
    expect(screen.getByRole('heading', { level: 3, name: 'Ledger accounts — WellD CH' })).not.toBeNull()
    expect(calls('GET /v1/me')).toHaveLength(2)
  })

  it('a write answering 403 re-reads /v1/me: the controls that should not be there disappear, with one note (FA10)', async () => {
    const user = userEvent.setup()
    let me = 0
    open('/accounting/ledger-accounts', {
      'GET /v1/me': () => (me++ === 0 ? meAnswer(meEntity()) : meAnswer(meEntity({ canManage: false }))),
      'GET /v1/entities/welld_ch/ledger-accounts': () => items('welld_ch', ['1000', 'Cassa', true]),
      'POST /v1/entities/welld_ch/ledger-accounts/1000/deactivate': () => problem(403, 'accounting_manage_required'),
    })
    await screen.findByTestId('accounting-ledger-table')
    await user.click(screen.getByTestId('accounting-ledger-deactivate-1000'))
    await user.click(screen.getByTestId('accounting-ledger-deactivate-dialog-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('accounting-ledger-deactivate-dialog-error').textContent).toBe("You don't have permission to do this."),
    )
    await waitFor(() => expect(screen.getByTestId('accounting-notice').textContent).toBe('Your access to Accounting changed. The page was updated.'))
    expect(screen.queryByTestId('accounting-ledger-add')).toBeNull()
    expect(screen.queryByTestId('accounting-ledger-deactivate-1000')).toBeNull()
    expect(within(screen.getByTestId('accounting-ledger-card')).getByTestId('accounting-ledger-read-only')).not.toBeNull()
  })

  it('a list that answers 403 shows PermissionDenied in place of the view (AS3 Denied)', async () => {
    open('/accounting/ledger-accounts', {
      'GET /v1/me': () => meAnswer(meEntity()),
      'GET /v1/entities/welld_ch/ledger-accounts': () => problem(403, 'accounting_forbidden'),
    })
    expect(await screen.findByTestId('accounting-denied')).not.toBeNull()
    expect(screen.queryByTestId('accounting-ledger-card')).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Accounting' })).not.toBeNull()
  })
})
