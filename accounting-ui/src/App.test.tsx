/**
 * @vitest-environment jsdom
 *
 * App — the exposed `./App` (design F1; T26 scaffold, T28 frame): mounted at `/accounting` it loads the frame and shows the
 * ledger accounts; it ignores an address that is not its own, so no request leaves for a path the shell has moved on from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { fakeApi, meAnswer, meEntity } from './test-support/fakeApi'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getAccountingApiBaseUrl: () => 'http://accounting-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

import App from './App'

beforeEach(() => {
  window.scrollTo = () => undefined
  apiFetch.mockImplementation(fakeApi({ 'GET /v1/me': () => meAnswer(meEntity()) }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('App', () => {
  it('mounts the tool at /accounting: the title, the three tabs, then the ledger accounts', async () => {
    window.history.pushState(null, '', '/accounting')
    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Accounting' })).not.toBeNull()
    expect(await screen.findByTestId('accounting-ledger-page')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Ledger accounts' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'VAT codes' })).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Exchange rates' })).not.toBeNull()
    expect(window.location.pathname).toBe('/accounting/ledger-accounts')
  })

  it('answers an unknown path under /accounting with the not-found view in the frame', async () => {
    window.history.pushState(null, '', '/accounting/nope')
    render(<App />)
    expect(await screen.findByTestId('accounting-not-found')).not.toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Accounting' })).not.toBeNull()
  })

  it('does not route an address that is not its own', async () => {
    window.history.pushState(null, '', '/accounting/ledger-accounts')
    render(<App />)
    await screen.findByTestId('accounting-ledger-page')
    apiFetch.mockClear()
    await act(async () => {
      window.history.pushState(null, '', '/projects/abc')
    })
    expect(screen.queryByTestId('accounting-not-found')).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('unmounts cleanly, and a second mount starts from a fresh router', async () => {
    window.history.pushState(null, '', '/accounting/ledger-accounts')
    const first = render(<App />)
    await screen.findByTestId('accounting-ledger-page')
    first.unmount()
    window.history.pushState(null, '', '/accounting/vat-codes')
    render(<App />)
    expect(await screen.findByTestId('accounting-vat-page')).not.toBeNull()
  })
})
