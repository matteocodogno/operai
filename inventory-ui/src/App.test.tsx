/**
 * @vitest-environment jsdom
 *
 * App wiring (T28, specs/015-hardware-inventory): the exposed `./App` root
 * mounts the inner router rebased to `/inventory` with InventoryShell as its
 * root layout, so the shell's chrome, the capability tabs and the routed page
 * all appear for `/inventory/assets`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getInventoryApiBaseUrl: vi.fn(() => 'http://inventory-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
  usePermissions: vi.fn(() => ({
    epoch: 0,
    apps: ['inventory'],
    roles: [],
    departments: [],
    permissions: [{ resource: 'asset', action: 'manage' }],
  })),
}))
vi.mock('./lib/scopeApi', () => ({ getScope: vi.fn(async () => ({ asset: ['welld_ch'], ledger: [] })) }))

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('App', () => {
  it('mounts InventoryShell as the root layout under /inventory', async () => {
    window.history.pushState(null, '', '/inventory/assets')
    // jsdom does not implement scrolling; the router's scroll restoration calls it on navigation.
    window.scrollTo = () => undefined
    const { default: App } = await import('./App')

    render(<App />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Inventory' })).not.toBeNull()
    expect(screen.getByRole('navigation', { name: 'Inventory sections' })).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Assets' }).getAttribute('href')).toBe('/inventory/assets')
    expect(await screen.findByTestId('inventory-assets-page')).not.toBeNull()
  })
})
