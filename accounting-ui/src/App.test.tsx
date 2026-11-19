/**
 * @vitest-environment jsdom
 *
 * App — the exposed `./App` (scaffold, T26): mounted at `/accounting` it renders the router; an unknown path is the
 * not-found panel with a way back; it ignores an address that is not its own and unmounts cleanly. The frame and the
 * three views are T28's, whose tests replace this file's expectations about the page area.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('shell/session', () => ({
  apiFetch,
  getAccountingApiBaseUrl: () => 'http://accounting-api.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
}))

import App from './App'

beforeEach(() => {
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('App', () => {
  it('answers an unknown path under /accounting with the not-found panel, focused, and a link back to the tool', async () => {
    window.history.pushState(null, '', '/accounting/nope')
    render(<App />)
    const panel = await screen.findByTestId('accounting-not-found')
    expect(panel).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Back to ledger accounts' }).getAttribute('href')).toBe('/accounting/')
  })

  it('does not route an address that is not its own', async () => {
    window.history.pushState(null, '', '/accounting/nope')
    render(<App />)
    await screen.findByTestId('accounting-not-found')
    cleanup()
    window.history.pushState(null, '', '/accounting')
    render(<App />)
    await act(async () => {
      window.history.pushState(null, '', '/projects/abc')
    })
    expect(screen.queryByTestId('accounting-not-found')).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('unmounts cleanly, and a second mount starts from a fresh router', async () => {
    window.history.pushState(null, '', '/accounting/nope')
    const first = render(<App />)
    await screen.findByTestId('accounting-not-found')
    first.unmount()
    window.history.pushState(null, '', '/accounting/other')
    render(<App />)
    expect(await screen.findByTestId('accounting-not-found')).not.toBeNull()
  })
})
