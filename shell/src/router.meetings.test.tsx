/**
 * @vitest-environment jsdom
 *
 * Tests for the `/meetings/$` tool route and the ungated `/my-meetings/$`
 * route (specs/021-meetings, T49, AC-10.1, AC-10.4, AC-10.5, AC-1.4; ADR-0045
 * shape: one remote, two entries, two different guards).
 *
 * Mirrors router.account.test.tsx / router.notify.test.tsx: real RouterProvider,
 * `window.history` navigation, federated remotes mocked via `vi.mock`,
 * `./router` re-imported fresh per test.
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
vi.mock('meetings/App', () => ({ default: () => <div data-testid="meetings-app">Meetings mounted</div> }))
// `meetings/MyMeetings` is registered with vi.doMock in beforeEach (not the
// hoisted vi.mock) so the failing-remote test can replace it and the next test
// gets the healthy one back — a doMock registration outlives vi.resetModules.

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
  vi.doMock('meetings/MyMeetings', () => ({
    default: () => <div data-testid="my-meetings">My meetings mounted</div>,
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

describe('/meetings/$ — the access-gated tool route (AC-10.1, AC-1.4)', () => {
  it('mounts meetings/App for a caller granted meetings, and records it as the last tool', async () => {
    grantApps(['meetings'])

    const { router } = await renderShellAt('/meetings')

    expect(await screen.findByTestId('meetings-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/meetings')
    expect(localStorage.getItem('operai_last_tool')).toBe('meetings')
  })

  it('mounts meetings/App for a deep link below /meetings', async () => {
    grantApps(['meetings'])

    await renderShellAt('/meetings/m/abc')

    expect(await screen.findByTestId('meetings-app')).not.toBeNull()
  })

  it('sends a caller without the meetings grant to no-access, with no Meetings sidebar entry', async () => {
    grantApps([])

    const { router } = await renderShellAt('/meetings')

    expect(await screen.findByRole('heading', { name: 'No apps available yet' })).not.toBeNull()
    expect(router.state.location.pathname).toBe('/no-access')
    expect(screen.queryByTestId('meetings-app')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Meetings' })).toBeNull()
    expect(localStorage.getItem('operai_last_tool')).toBeNull()
  })

  it('redirects a caller granted only another tool to that tool', async () => {
    grantApps(['estimai'])

    const { router } = await renderShellAt('/meetings')

    expect(await screen.findByTestId('estimai-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/estimai')
  })

  it('shows the Meetings sidebar link only to a caller granted meetings', async () => {
    grantApps(['estimai', 'meetings'])
    await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')
    expect(screen.getByRole('link', { name: 'Meetings' }).getAttribute('href')).toBe('/meetings')
  })

  it('carries an app-access beforeLoad on /meetings/$ and none on /my-meetings/$ (ADR-0045 shape)', async () => {
    grantApps(['meetings'])
    const { router } = await renderShellAt('/meetings')
    await screen.findByTestId('meetings-app')

    const routes = router.routesByPath as Record<string, { options: { beforeLoad?: unknown } }>
    expect(typeof routes['/meetings/$'].options.beforeLoad).toBe('function')
    expect(routes['/my-meetings/$'].options.beforeLoad).toBeUndefined()
  })
})

describe('/my-meetings/$ — the ungated, identity-scoped route (AC-10.1, AC-10.4, AC-10.5)', () => {
  it('mounts meetings/MyMeetings for a caller with ZERO grants, with no redirect', async () => {
    grantApps([])

    const { router } = await renderShellAt('/my-meetings')

    expect(await screen.findByTestId('my-meetings')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/my-meetings')
    expect(screen.queryByRole('heading', { name: 'No apps available yet' })).toBeNull()
    // The tool itself stays invisible to this user (AC-10.4).
    expect(screen.queryByRole('link', { name: 'Meetings' })).toBeNull()
  })

  it('mounts for a deep link below /my-meetings (every notification and activity link points at /my-meetings/m/<id>)', async () => {
    grantApps([])

    const { router } = await renderShellAt('/my-meetings/m/abc')

    expect(await screen.findByTestId('my-meetings')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/my-meetings/m/abc')
  })

  it('does not write operai_last_tool, and leaves a previously recorded tool untouched', async () => {
    grantApps(['estimai'])
    localStorage.setItem('operai_last_tool', 'refund')

    await renderShellAt('/my-meetings')

    await screen.findByTestId('my-meetings')
    expect(localStorage.getItem('operai_last_tool')).toBe('refund')
  })

  it('does not write operai_last_tool when it was empty either', async () => {
    grantApps(['meetings'])

    await renderShellAt('/my-meetings')

    await screen.findByTestId('my-meetings')
    expect(localStorage.getItem('operai_last_tool')).toBeNull()
  })

  it("shows RemoteMount's error state inside an intact shell when the remote fails to load", async () => {
    vi.doMock('meetings/MyMeetings', () => {
      throw new Error('Failed to fetch remoteEntry.js')
    })
    grantApps([])

    await renderShellAt('/my-meetings')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("My meetings couldn't load")
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Consultant' })).not.toBeNull()
  })

  it('is reached through the "My meetings" menu row from any tool', async () => {
    grantApps(['estimai'])
    const { router } = await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    fireEvent.click(screen.getByRole('button', { name: 'Consultant' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'My meetings' }))

    expect(await screen.findByTestId('my-meetings')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/my-meetings')
  })
})
