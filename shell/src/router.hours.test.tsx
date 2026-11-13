/**
 * @vitest-environment jsdom
 *
 * Tests for the ungated `/hours/$` route (specs/029-time-tracking, T23, AC-5.1, AC-5.3,
 * AC-5.5; ADR-0090; design.md F8 and S6).
 *
 * `hours-ui` is a remote with NO gated half: every screen is for a signed-in person's own
 * hours, so a caller with zero app grants must reach it (ADR-0034's test). The route is a
 * child of `shellRoute` like `/my-meetings/$`, with no `beforeLoad`, no `recordLastTool` and
 * no `TOOLS` entry; the `_authed` session guard on its ancestors still applies.
 *
 * Mirrors router.meetings.test.tsx: real RouterProvider, `window.history` navigation, the
 * federated remote mocked via `vi.doMock`, `./router` re-imported fresh per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

const { getSession, usePermissions, ensurePermissions, revalidatePermissions, apiFetch } = vi.hoisted(() => ({
  getSession: vi.fn(),
  usePermissions: vi.fn(),
  ensurePermissions: vi.fn(),
  revalidatePermissions: vi.fn(),
  apiFetch: vi.fn(),
}))

vi.mock('./lib/session', () => ({
  getSession,
  useSession: vi.fn(() => ({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' } },
  })),
  signOut: vi.fn(),
  usePermissions,
  ensurePermissions,
  revalidatePermissions,
  getCachedSession: vi.fn(() => null),
  getCachedPermissions: vi.fn(() => null),
  apiFetch,
  onSignOut: vi.fn(),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

vi.mock('estimai/App', () => ({ default: () => <div data-testid="estimai-app">EstimAI mounted</div> }))
vi.mock('refund/App', () => ({ default: () => <div data-testid="refund-app">Refund mounted</div> }))
vi.mock('admin/App', () => ({ default: () => <div data-testid="admin-app">Admin mounted</div> }))
vi.mock('notify/App', () => ({ default: () => <div data-testid="notify-app">Notify mounted</div> }))
// `hours/App` is registered with vi.doMock in beforeEach (not the hoisted vi.mock) so the
// failing-remote test can replace it and the next test gets the healthy one back.

const permissionsWith = (apps: string[]) => ({
  epoch: 0,
  apps,
  roles: [],
  departments: [],
  permissions: [],
})

function grantApps(apps: string[]) {
  usePermissions.mockReturnValue(permissionsWith(apps))
  ensurePermissions.mockResolvedValue(permissionsWith(apps))
  revalidatePermissions.mockResolvedValue(permissionsWith(apps))
}

async function renderShellAt(path: string) {
  window.history.pushState(null, '', path)
  const mod = await import('./router?t=' + Date.now())
  const utils = render(<RouterProvider router={mod.router} />)
  return { router: mod.router, ...utils }
}

beforeEach(() => {
  vi.doMock('hours/App', () => ({
    default: () => <div data-testid="hours-app">Hours mounted</div>,
  }))
  vi.stubEnv('VITE_AUTH_URL', 'http://auth.test')
  getSession.mockResolvedValue({
    data: { user: { id: 'u1', email: 'consultant@welld.ch', name: 'Consultant' }, session: {} },
  })
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) })
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
  window.history.pushState(null, '', '/')
  localStorage.clear()
})

describe('/hours/$ — the ungated route (AC-5.1)', () => {
  it('mounts hours/App for a caller with ZERO grants, with no access redirect', async () => {
    grantApps([])

    const { router } = await renderShellAt('/hours')

    expect(await screen.findByTestId('hours-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/hours')
    expect(screen.queryByRole('heading', { name: 'No apps available yet' })).toBeNull()
  })

  it('mounts hours/App for the deep link /hours/all (the remote has its own inner router)', async () => {
    grantApps([])

    const { router } = await renderShellAt('/hours/all')

    expect(await screen.findByTestId('hours-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/hours/all')
    expect(screen.queryByRole('heading', { name: 'No apps available yet' })).toBeNull()
  })

  it('shows no Hours entry in the tool sidebar, whatever the grants (it is not a tool)', async () => {
    grantApps(['estimai', 'refund', 'admin', 'inventory', 'crm', 'meetings', 'projects', 'hours'])

    await renderShellAt('/hours')

    await screen.findByTestId('hours-app')
    expect(screen.queryByRole('link', { name: /hours/i })).toBeNull()
  })

  it('has no app-access beforeLoad, unlike every tool route (ADR-0090)', async () => {
    grantApps([])
    const { router } = await renderShellAt('/hours')
    await screen.findByTestId('hours-app')

    const routes = router.routesByPath as Record<string, { options: { beforeLoad?: unknown } }>
    expect(routes['/hours/$']).toBeDefined()
    expect(routes['/hours/$'].options.beforeLoad).toBeUndefined()
    // The tool routes keep theirs: the absence above is a choice, not a default.
    expect(typeof routes['/projects/$'].options.beforeLoad).toBe('function')
  })

  it('does not write operai_last_tool, and leaves a previously recorded tool untouched', async () => {
    grantApps(['estimai'])
    localStorage.setItem('operai_last_tool', 'refund')

    await renderShellAt('/hours')

    await screen.findByTestId('hours-app')
    expect(localStorage.getItem('operai_last_tool')).toBe('refund')
  })

  it('does not write operai_last_tool when it was empty either', async () => {
    grantApps(['estimai'])

    await renderShellAt('/hours/all')

    await screen.findByTestId('hours-app')
    expect(localStorage.getItem('operai_last_tool')).toBeNull()
  })

  it('forces no permissions revalidation on entry: with no guard there is no `GET /authz/me` on the way in', async () => {
    grantApps(['estimai'])

    await renderShellAt('/hours')

    await screen.findByTestId('hours-app')
    expect(revalidatePermissions).not.toHaveBeenCalled()
  })
})

describe('/hours/$ — still behind the session guard (AC-5.3)', () => {
  it('does not mount the remote, and asks for the session, when nobody is signed in', async () => {
    getSession.mockResolvedValue(null)
    grantApps([])
    // The guard's redirect leaves the document for the sign-in page; jsdom cannot navigate and
    // says so on the console, which is not what this test is about.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderShellAt('/hours')

    await vi.waitFor(() => expect(getSession).toHaveBeenCalled())
    expect(screen.queryByTestId('hours-app')).toBeNull()
  })

  it('sits under the _authed and _shell layout routes, like every other screen in the chrome', async () => {
    grantApps([])
    const { router } = await renderShellAt('/hours')
    await screen.findByTestId('hours-app')

    const route = (
      router.routesByPath as Record<string, { parentRoute?: { id: string; parentRoute?: { id: string } } }>
    )['/hours/$']
    expect(route.parentRoute?.id).toBe('/_authed/_shell')
    expect(route.parentRoute?.parentRoute?.id).toBe('/_authed')
  })
})

describe('/hours/$ — the remote failing to load (design F8)', () => {
  it("shows RemoteMount's error state inside an intact shell, with Retry", async () => {
    vi.doMock('hours/App', () => {
      throw new Error('Failed to fetch remoteEntry.js')
    })
    grantApps([])

    await renderShellAt('/hours')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Hours couldn't load")
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Consultant' })).not.toBeNull()
  })
})

describe('/hours/$ — reached from the user menu (design S6)', () => {
  it('is reached through the "My hours" menu row from any tool, for a caller with only that tool', async () => {
    grantApps(['estimai'])
    const { router } = await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    fireEvent.click(screen.getByRole('button', { name: 'Consultant' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'My hours' }))

    expect(await screen.findByTestId('hours-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/hours')
  })
})
