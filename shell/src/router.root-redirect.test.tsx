/**
 * @vitest-environment jsdom
 *
 * Integration tests for the root-landing redirect (T10, specs/003-suite-shell,
 * AC-3.4, design.md Flow 2): the shell's bare `/` never renders a screen of
 * its own — it redirects to the user's most-recently-used tool, persisted in
 * `localStorage['operai_last_tool']`, falling back to EstimAI when the key is
 * absent or holds an unrecognized/tampered value. Each tool route also writes
 * its id to that key whenever the route becomes active (deep link, sidebar
 * click, or programmatic navigation alike).
 *
 * Mirrors router.integration.test.tsx's technique (real RouterProvider +
 * `window.history` navigation, federated remotes mocked via `vi.mock`) rather
 * than router.test.tsx's static-`window.location` stub, since these tests
 * need a REAL router that actually resolves `/` and follows the redirect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Module mocks — hoisted above imports/dynamic imports of the modules they
// replace.
// ---------------------------------------------------------------------------

// Fully-permissioned fixture shared by usePermissions/ensurePermissions/
// revalidatePermissions below (T24/T25, specs/004-auth-roles-permissions).
// These tests exercise both the root `/` redirect (indexRoute's beforeLoad
// calls `ensurePermissions()`, T25) and tool-route navigation (each tool
// route's access guard force-revalidates via `revalidatePermissions()`), so
// both must resolve a grant for estimai/refund or the guards would redirect
// away instead of letting the intended route render.
const PERMISSIONS_FIXTURE = {
  epoch: 0,
  apps: ['estimai', 'refund'],
  roles: [],
  departments: [],
  permissions: [],
}

vi.mock('./lib/session', () => ({
  getSession: vi.fn(),
  useSession: vi.fn(() => ({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' } },
  })),
  signOut: vi.fn(),
  usePermissions: vi.fn(() => PERMISSIONS_FIXTURE),
  ensurePermissions: vi.fn(async () => PERMISSIONS_FIXTURE),
  revalidatePermissions: vi.fn(async () => PERMISSIONS_FIXTURE),
  // Bug fix (2026-07, shell/src/router.tsx's createToolAccessBeforeLoad):
  // `null` (cold cache) keeps every test in this file exercising the async
  // (revalidate) branch, exactly as before this getter existed. These tests
  // deliberately pre-seed `operai_last_tool` to assert the ROOT REDIRECT
  // target (AC-3.4) — that must never be confused with the tool route's own
  // same-app synchronous fast path (covered in router.access-guard.test.tsx),
  // which additionally requires a warm permissions cache.
  getCachedPermissions: vi.fn(() => null),
  // T11 (specs/005-notification-center): Header now mounts Bell, which reads
  // useUnreadCount() (shell/src/lib/notifications.ts) on every render of the
  // shared chrome these tests exercise. notifications.ts imports
  // apiFetch/onSignOut from this same module, so this mock must supply them
  // too (apiFetch resolving to undefined makes the SSE manager's ticket mint
  // fail closed, same as being signed out — see notifications.ts's
  // mintStreamTicket try/catch — so Bell just renders with 0 unread here).
  apiFetch: vi.fn(),
  onSignOut: vi.fn(),
}))

vi.mock('estimai/App', () => ({
  default: () => <div data-testid="estimai-app">EstimAI mounted</div>,
}))

vi.mock('refund/App', () => ({
  default: () => <div data-testid="refund-app">Refund mounted</div>,
}))

vi.mock('admin/App', () => ({
  default: () => <div data-testid="admin-app">Admin mounted</div>,
}))

vi.mock('notify/App', () => ({
  default: () => <div data-testid="notify-app">Notify mounted</div>,
}))

import { getSession } from './lib/session'

const LAST_TOOL_STORAGE_KEY = 'operai_last_tool'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigates the (real) jsdom location to `path` BEFORE constructing the
 * router, then imports router.tsx fresh (cache-busted) so the module-scope
 * `router` singleton it creates picks up that location as its initial match —
 * same technique as router.integration.test.tsx's `renderShellAt`.
 */
async function renderShellAt(path: string) {
  window.history.pushState(null, '', path)
  const mod = await import('./router?t=' + Date.now())
  const utils = render(<RouterProvider router={mod.router} />)
  return { router: mod.router, ...utils }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  vi.mocked(getSession).mockResolvedValue({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' }, session: {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  window.history.pushState(null, '', '/')
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('root-landing redirect (T10, AC-3.4)', () => {
  it('(a) with no operai_last_tool key, opening / lands on EstimAI', async () => {
    expect(localStorage.getItem(LAST_TOOL_STORAGE_KEY)).toBeNull()

    const { router } = await renderShellAt('/')

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
    expect(screen.queryByTestId('refund-app')).toBeNull()
    expect(router.state.location.pathname).toBe('/estimai')
  })

  it("(b) with operai_last_tool = 'refund', opening / lands on Refund", async () => {
    localStorage.setItem(LAST_TOOL_STORAGE_KEY, 'refund')

    const { router } = await renderShellAt('/')

    expect(await screen.findByTestId('refund-app')).not.toBeNull()
    expect(screen.queryByTestId('estimai-app')).toBeNull()
    expect(router.state.location.pathname).toBe('/refund')
  })

  it('(c) an invalid/tampered stored value falls back to EstimAI, not an arbitrary navigation', async () => {
    localStorage.setItem(LAST_TOOL_STORAGE_KEY, 'https://evil.example.com')

    const { router } = await renderShellAt('/')

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
    expect(screen.queryByTestId('refund-app')).toBeNull()
    expect(router.state.location.pathname).toBe('/estimai')
  })

  it('a stored id for an unknown/future-removed tool falls back to EstimAI', async () => {
    localStorage.setItem(LAST_TOOL_STORAGE_KEY, 'some-removed-tool')

    await renderShellAt('/')

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
  })
})

describe('writing operai_last_tool on tool-route activation (T10, Flow 3 step 4)', () => {
  it('(d) deep-linking straight to /refund writes "refund" to operai_last_tool', async () => {
    await renderShellAt('/refund')

    await screen.findByTestId('refund-app')
    expect(localStorage.getItem(LAST_TOOL_STORAGE_KEY)).toBe('refund')
  })

  it('deep-linking straight to /estimai writes "estimai" to operai_last_tool', async () => {
    await renderShellAt('/estimai')

    await screen.findByTestId('estimai-app')
    expect(localStorage.getItem(LAST_TOOL_STORAGE_KEY)).toBe('estimai')
  })

  it('programmatic navigation to another tool overwrites the stored key', async () => {
    localStorage.setItem(LAST_TOOL_STORAGE_KEY, 'estimai')
    const { router } = await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    await router.navigate({ to: '/refund' })

    expect(await screen.findByTestId('refund-app')).not.toBeNull()
    expect(localStorage.getItem(LAST_TOOL_STORAGE_KEY)).toBe('refund')
  })
})
