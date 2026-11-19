/**
 * @vitest-environment jsdom
 *
 * The inner router with its real frame (T28; design UX-1, AS1, AS7; AC-8.2, AC-3.5, AC-3.6): `/accounting` goes to the ledger
 * accounts, the three views are routes shown as a `TabNav` of links that carry `?entity=` and drop `?month=`, an unknown path is
 * the not-found view inside the frame, and axe finds nothing on any of the three views.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider } from '@tanstack/react-router'
import AccountingShell from './components/AccountingShell'
import { createAppRouter, validateAccountingSearch } from './router'
import { fakeApi, meAnswer, meEntity, meItalia } from './test-support/fakeApi'
import { expectNoAxeViolations } from './test-support/axe'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getAccountingApiBaseUrl: () => 'http://accounting-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

const renderAt = (path: string) => {
  window.history.pushState(null, '', path)
  return render(<RouterProvider router={createAppRouter('/accounting', AccountingShell)} />)
}

beforeEach(() => {
  window.scrollTo = () => undefined
  apiFetch.mockImplementation(
    fakeApi({
      'GET /v1/me': () => meAnswer(meEntity(), meItalia()),
      ...Object.fromEntries(
        ['welld_ch', 'welld_it'].flatMap((entity) =>
          ['ledger-accounts', 'vat-codes'].map((resource) => [
            `GET /v1/entities/${entity}/${resource}`,
            () => ({ status: 200, body: { entity, items: [] } }),
          ]),
        ),
      ),
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const nav = () => screen.getByRole('navigation', { name: 'Accounting sections' })
const tab = (name: string) => within(nav()).getByRole('link', { name })

describe('validateAccountingSearch', () => {
  it('keeps the entity as the string it is (the frame classifies it) and a month only when it is YYYY-MM', () => {
    expect(validateAccountingSearch({ entity: 'welld_it', month: '2026-03' })).toEqual({
      entity: 'welld_it',
      month: '2026-03',
    })
    expect(validateAccountingSearch({ entity: 'xyz' })).toEqual({ entity: 'xyz', month: undefined })
    for (const month of ['2026-3', '2026-13', '2026-00', '202603', '2026-03-01', 'march', 7, null]) {
      expect(validateAccountingSearch({ month }).month).toBeUndefined()
    }
    expect(validateAccountingSearch({ entity: '', month: '' })).toEqual({ entity: undefined, month: undefined })
    expect(validateAccountingSearch({ entity: 7 })).toEqual({ entity: undefined, month: undefined })
  })
})

describe('createAppRouter', () => {
  it('redirects the tool root to the ledger accounts, keeping ?entity=', async () => {
    renderAt('/accounting')
    expect(await screen.findByTestId('accounting-ledger-page')).not.toBeNull()
    expect(window.location.pathname).toBe('/accounting/ledger-accounts')

    cleanup()
    renderAt('/accounting/?entity=welld_it&month=2026-03')
    expect(await screen.findByTestId('accounting-ledger-page')).not.toBeNull()
    expect(window.location.pathname).toBe('/accounting/ledger-accounts')
    expect(window.location.search).toBe('?entity=welld_it')
    // The card names the entity the address asked for (UX-3).
    expect(await screen.findByRole('heading', { level: 3, name: 'Ledger accounts — WellD Italia' })).not.toBeNull()
  })

  it('serves each view as a route under the one h1, with its own h2 and the entity shown', async () => {
    renderAt('/accounting/vat-codes')
    expect(await screen.findByRole('heading', { level: 2, name: 'VAT codes' })).not.toBeNull()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(await screen.findByRole('heading', { level: 3, name: 'VAT codes — WellD CH' })).not.toBeNull()

    cleanup()
    renderAt('/accounting/exchange-rates')
    expect(await screen.findByRole('heading', { level: 2, name: 'Exchange rates' })).not.toBeNull()
    expect(screen.getByTestId('accounting-fx-entity').textContent).toBe('WellD CH')
  })

  it('answers an unknown path with the not-found view INSIDE the frame, focused, with a way back', async () => {
    renderAt('/accounting/nope')
    const heading = await screen.findByRole('heading', { name: 'This page does not exist' })
    expect(document.activeElement).toBe(heading)
    expect(screen.getByRole('heading', { level: 1, name: 'Accounting' })).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Back to ledger accounts' }).getAttribute('href')).toBe('/accounting/')
  })
})

describe('the TabNav (design UX-1)', () => {
  it('is one labelled nav of three links to the views, the open one marked aria-current', async () => {
    renderAt('/accounting/vat-codes')
    await screen.findByTestId('accounting-vat-page')
    expect(
      within(nav())
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Ledger accounts', 'VAT codes', 'Exchange rates'])
    expect(tab('VAT codes').getAttribute('aria-current')).toBe('page')
    expect(tab('Ledger accounts').getAttribute('aria-current')).toBeNull()
    expect(tab('Exchange rates').getAttribute('aria-current')).toBeNull()
  })

  it('carries ?entity= from tab to tab and drops ?month= when leaving Exchange rates', async () => {
    const user = userEvent.setup()
    renderAt('/accounting/exchange-rates?entity=welld_it&month=2026-03')
    await screen.findByTestId('accounting-fx-page')
    // The open tab stays marked although its address carries a month the link does not.
    expect(tab('Exchange rates').getAttribute('aria-current')).toBe('page')
    expect(tab('Ledger accounts').getAttribute('href')).toBe('/accounting/ledger-accounts?entity=welld_it')
    expect(tab('VAT codes').getAttribute('href')).toBe('/accounting/vat-codes?entity=welld_it')
    expect(tab('Exchange rates').getAttribute('href')).not.toContain('month')

    await user.click(tab('VAT codes'))
    expect(await screen.findByTestId('accounting-vat-page')).not.toBeNull()
    expect(window.location.search).toBe('?entity=welld_it')
    expect(await screen.findByRole('heading', { level: 3, name: 'VAT codes — WellD Italia' })).not.toBeNull()
    expect(tab('VAT codes').getAttribute('aria-current')).toBe('page')

    // Back walks the views (each tab is a page with its own URL).
    window.history.back()
    await waitFor(() => expect(screen.queryByTestId('accounting-fx-page')).not.toBeNull())
  })

  it('carries nothing when the address has no entity, or a garbage one (the frame rewrites that)', async () => {
    renderAt('/accounting/ledger-accounts')
    await screen.findByTestId('accounting-ledger-page')
    expect(tab('VAT codes').getAttribute('href')).toBe('/accounting/vat-codes')
    cleanup()
    renderAt('/accounting/ledger-accounts?entity=xyz')
    await screen.findByTestId('accounting-ledger-page')
    await waitFor(() => expect(window.location.search).toBe('?entity=welld_ch'))
    expect(tab('VAT codes').getAttribute('href')).toBe('/accounting/vat-codes?entity=welld_ch')
  })

  it('does not carry an entity the person does not cover', async () => {
    apiFetch.mockImplementation(fakeApi({ 'GET /v1/me': () => meAnswer(meEntity()) }))
    renderAt('/accounting/vat-codes?entity=welld_it')
    await screen.findByTestId('accounting-not-found')
    expect(tab('Ledger accounts').getAttribute('href')).toBe('/accounting/ledger-accounts')
  })

  it.each([
    ['/accounting/ledger-accounts', 'accounting-ledger-page'],
    ['/accounting/vat-codes', 'accounting-vat-page'],
    ['/accounting/exchange-rates?entity=welld_it&month=2026-03', 'accounting-fx-page'],
  ])('has no axe violation on %s', async (path, testId) => {
    const { container } = renderAt(path)
    await screen.findByTestId(testId)
    await expectNoAxeViolations(container)
  })
})
