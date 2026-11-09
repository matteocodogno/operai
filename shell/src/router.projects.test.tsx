/**
 * @vitest-environment jsdom
 *
 * Tests for the `/projects/$` tool route (specs/024-projects, T15, AC-4.1): the
 * Projects module appears in the suite only for holders of `projects:access`
 * (ADR-0007 posture), the same gate the other tools sit behind.
 *
 * Mirrors router.inventory.test.tsx: real RouterProvider, `window.history`
 * navigation, federated remotes mocked via `vi.mock`, `./router` re-imported fresh
 * per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
vi.mock('inventory/App', () => ({ default: () => <div data-testid="inventory-app">Inventory mounted</div> }))
vi.mock('crm/App', () => ({ default: () => <div data-testid="crm-app">CRM mounted</div> }))
vi.mock('projects/App', () => ({ default: () => <div data-testid="projects-app">Projects mounted</div> }))

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

describe('/projects/$ — the access-gated tool route (AC-4.1)', () => {
  it('mounts projects/App for a caller granted projects, and records it as the last tool', async () => {
    grantApps(['projects'])

    const { router } = await renderShellAt('/projects')

    expect(await screen.findByTestId('projects-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/projects')
    expect(localStorage.getItem('operai_last_tool')).toBe('projects')
  })

  it('mounts projects/App for a deep link below /projects (a project page)', async () => {
    grantApps(['projects'])

    await renderShellAt('/projects/clx123')

    expect(await screen.findByTestId('projects-app')).not.toBeNull()
  })

  it('redirects a caller with NO grants to /no-access, with no Projects sidebar entry', async () => {
    grantApps([])

    const { router } = await renderShellAt('/projects')

    expect(await screen.findByRole('heading', { name: 'No apps available yet' })).not.toBeNull()
    expect(router.state.location.pathname).toBe('/no-access')
    expect(screen.queryByTestId('projects-app')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Projects' })).toBeNull()
    expect(localStorage.getItem('operai_last_tool')).toBeNull()
  })

  it('does not let crm:access stand in for projects:access (D13)', async () => {
    grantApps(['crm'])

    const { router } = await renderShellAt('/projects')

    expect(await screen.findByTestId('crm-app')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/crm')
    expect(screen.queryByTestId('projects-app')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Projects' })).toBeNull()
  })

  it('shows the Projects sidebar link only to a caller granted projects', async () => {
    grantApps(['estimai', 'projects'])
    await renderShellAt('/estimai')
    await screen.findByTestId('estimai-app')

    expect(screen.getByRole('link', { name: 'Projects' }).getAttribute('href')).toBe('/projects')
  })
})
