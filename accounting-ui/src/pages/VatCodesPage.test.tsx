/**
 * @vitest-environment jsdom
 *
 * VatCodesPage inside the real frame (T30, specs/20261119-accounting, design AS2, AS4, FA2, FA10, UX-3, UX-4, UX-12; AC-1.5,
 * AC-3.4, AC-8.2, AC-8.3): the card is keyed by entity and reads that entity's path, its write controls come from `/v1/me`'s
 * `canManage`, and the frame hears a 404 from the list and a 403 from a write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

const codes = (entity: string, ...rows: Array<[string, string, string, boolean]>): FakeAnswer => ({
  status: 200,
  body: {
    entity,
    items: rows.map(([code, label, ratePercent, active]) => ({ code, label, ratePercent, rateBasisPoints: Number(ratePercent) * 100, active })),
  },
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

describe('VatCodesPage', () => {
  it('h1 the tool, h2 the view, h3 the card named after the entity; a manager sees Add and per-row actions', async () => {
    const { container } = open('/accounting/vat-codes', {
      'GET /v1/me': () => meAnswer(meEntity()),
      'GET /v1/entities/welld_ch/vat-codes': () => codes('welld_ch', ['IMP81', 'Imposta', '8.1', true]),
    })
    await screen.findByTestId('accounting-vat-table')
    expect(screen.getByRole('heading', { level: 1, name: 'Accounting' })).not.toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: 'VAT codes' })).not.toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: 'VAT codes — WellD CH' })).not.toBeNull()
    expect(screen.getByTestId('accounting-vat-add')).not.toBeNull()
    expect(screen.queryByTestId('accounting-entity-switch')).toBeNull()
    await expectNoAxeViolations(container)
  })

  it('switching entity remounts the card: Italia’s own path, title and empty state; canManage is Italia’s', async () => {
    const user = userEvent.setup()
    open('/accounting/vat-codes', {
      'GET /v1/me': () => meAnswer(meEntity({ canManage: true }), meItalia({ canManage: false })),
      'GET /v1/entities/welld_ch/vat-codes': () => codes('welld_ch', ['IMP81', 'Imposta', '8.1', true]),
      'GET /v1/entities/welld_it/vat-codes': () => codes('welld_it'),
    })
    await screen.findByTestId('accounting-vat-table')
    await user.selectOptions(screen.getByLabelText('Entity'), 'welld_it')
    const empty = await screen.findByTestId('accounting-empty')
    expect(empty.textContent).toContain('Nothing entered yet for WellD Italia')
    expect(screen.queryByTestId('accounting-vat-row-IMP81')).toBeNull()
    expect(screen.queryByTestId('accounting-vat-add')).toBeNull()
  })

  it('a list that answers 404 re-reads /v1/me, falls back and says so once', async () => {
    let me = 0
    open('/accounting/vat-codes?entity=welld_it', {
      'GET /v1/me': () => (me++ === 0 ? meAnswer(meEntity(), meItalia()) : meAnswer(meEntity())),
      'GET /v1/entities/welld_it/vat-codes': () => problem(404, 'not_found'),
      'GET /v1/entities/welld_ch/vat-codes': () => codes('welld_ch', ['IMP81', 'Imposta', '8.1', true]),
    })
    expect((await screen.findByTestId('accounting-notice')).textContent).toBe(
      'You no longer have access to WellD Italia. Showing WellD CH.',
    )
    await screen.findByTestId('accounting-vat-table')
  })

  it('a write answering 403 re-reads /v1/me: the controls disappear, with one note', async () => {
    const user = userEvent.setup()
    let me = 0
    open('/accounting/vat-codes', {
      'GET /v1/me': () => (me++ === 0 ? meAnswer(meEntity()) : meAnswer(meEntity({ canManage: false }))),
      'GET /v1/entities/welld_ch/vat-codes': () => codes('welld_ch', ['IMP81', 'Imposta', '8.1', true]),
      'POST /v1/entities/welld_ch/vat-codes/IMP81/deactivate': () => problem(403, 'accounting_manage_required'),
    })
    await screen.findByTestId('accounting-vat-table')
    await user.click(screen.getByTestId('accounting-vat-deactivate-IMP81'))
    await user.click(screen.getByTestId('accounting-vat-deactivate-dialog-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('accounting-notice').textContent).toBe('Your access to Accounting changed. The page was updated.'),
    )
    expect(screen.queryByTestId('accounting-vat-add')).toBeNull()
    expect(screen.queryByTestId('accounting-vat-deactivate-IMP81')).toBeNull()
    expect(screen.getByTestId('accounting-vat-read-only')).not.toBeNull()
  })
})
