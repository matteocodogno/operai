/**
 * @vitest-environment jsdom
 *
 * Component tests for SectionNav (T14, specs/004-auth-roles-permissions/tasks.md;
 * T11, specs/009-mileage-rate — the proactive `rate:read` gate).
 *
 * Uses a real, minimal TanStack Router harness (mirrors
 * shell/src/components/Sidebar.test.tsx's own technique exactly, same
 * rationale: the whole point of "aria-current on the active section" is
 * that it comes from the ACTUAL current route via `<Link>`'s own
 * active-match mechanism, so a mocked router would test nothing real).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import SectionNav from './SectionNav'

// ---------------------------------------------------------------------------
// Module mock — adminApi.getMe() (T11, specs/009-mileage-rate): SectionNav
// now resolves the caller's live permissions on mount to decide whether the
// "Mileage Rates" entry appears (design.md F7). `beforeEach` below defaults
// to "no grants" (mirrors `EMPTY_PERMISSIONS`) so every pre-existing test in
// this file — none of which anticipated this call — keeps seeing exactly the
// original four links; the dedicated "Mileage Rates gate" describe block
// below overrides the resolution per test.
// ---------------------------------------------------------------------------

vi.mock('../lib/adminApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/adminApi')>()
  return { ...original, getMe: vi.fn() }
})

beforeEach(async () => {
  const adminApi = await import('../lib/adminApi')
  vi.mocked(adminApi.getMe).mockResolvedValue({
    epoch: 0,
    apps: ['admin'],
    roles: [],
    departments: [],
    permissions: [],
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.pushState(null, '', '/')
})

/** Builds a tiny router — SectionNav + Outlet at root, one leaf route per section. */
async function renderNavAt(path: string) {
  window.history.pushState(null, '', path)

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <SectionNav />
        <Outlet />
      </>
    ),
  })
  const rolesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/roles', component: () => <p>roles</p> })
  const departmentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/departments',
    component: () => <p>departments</p>,
  })
  const usersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/users', component: () => <p>users</p> })
  const auditRoute = createRoute({ getParentRoute: () => rootRoute, path: '/audit', component: () => <p>audit</p> })
  const ratesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/rates', component: () => <p>rates</p> })
  const routeTree = rootRoute.addChildren([rolesRoute, departmentsRoute, usersRoute, auditRoute, ratesRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  await screen.findByRole('link', { name: 'Roles' })
  return utils
}

describe('SectionNav structure', () => {
  it('renders a real nav landmark labelled "Admin sections"', async () => {
    await renderNavAt('/roles')

    expect(screen.getByRole('navigation', { name: 'Admin sections' })).not.toBeNull()
  })

  it('renders the four sections, in IA order, as real links (not buttons/divs)', async () => {
    await renderNavAt('/roles')

    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['Roles', 'Departments', 'Users', 'Audit'])
    links.forEach((link) => expect(link.tagName).toBe('A'))
  })
})

describe('SectionNav active state (aria-current)', () => {
  it('marks Roles active with aria-current="page" when on /roles, no other section active', async () => {
    await renderNavAt('/roles')

    expect(screen.getByRole('link', { name: 'Roles' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Departments' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('link', { name: 'Users' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('link', { name: 'Audit' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks Audit active with aria-current="page" when on /audit', async () => {
    await renderNavAt('/audit')

    expect(screen.getByRole('link', { name: 'Audit' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Roles' }).getAttribute('aria-current')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Mileage Rates gate (T11, specs/009-mileage-rate, design.md F7 — the first
// capability-driven proactive UI hide in this app)
// ---------------------------------------------------------------------------

describe('SectionNav "Mileage Rates" gate (T11, specs/009-mileage-rate)', () => {
  it('hides "Mileage Rates" by default (no grant resolved yet / resolved with no rate:read)', async () => {
    await renderNavAt('/roles')

    expect(screen.queryByRole('link', { name: 'Mileage Rates' })).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(4)
  })

  it('appends "Mileage Rates" once GET /authz/me resolves rate:read', async () => {
    const adminApi = await import('../lib/adminApi')
    vi.mocked(adminApi.getMe).mockResolvedValue({
      epoch: 1,
      apps: ['admin'],
      roles: ['admin'],
      departments: [],
      permissions: [{ resource: 'rate', action: 'read', conditions: null }],
    })

    await renderNavAt('/roles')

    const link = await screen.findByRole('link', { name: 'Mileage Rates' })
    expect(link.tagName).toBe('A')
    // Appended after the four existing sections — IA order preserved.
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Roles',
      'Departments',
      'Users',
      'Audit',
      'Mileage Rates',
    ])
  })

  it('marks "Mileage Rates" active with aria-current="page" when on /rates', async () => {
    const adminApi = await import('../lib/adminApi')
    vi.mocked(adminApi.getMe).mockResolvedValue({
      epoch: 1,
      apps: ['admin'],
      roles: ['admin'],
      departments: [],
      permissions: [{ resource: 'rate', action: 'read', conditions: null }],
    })

    await renderNavAt('/rates')

    const link = await screen.findByRole('link', { name: 'Mileage Rates' })
    expect(link.getAttribute('aria-current')).toBe('page')
  })

  it('stays hidden when GET /authz/me grants an unrelated permission but not rate:read', async () => {
    const adminApi = await import('../lib/adminApi')
    vi.mocked(adminApi.getMe).mockResolvedValue({
      epoch: 1,
      apps: ['admin'],
      roles: ['admin'],
      departments: [],
      permissions: [{ resource: 'role', action: 'edit', conditions: null }],
    })

    await renderNavAt('/roles')

    await waitFor(() => {
      expect(vi.mocked(adminApi.getMe)).toHaveBeenCalled()
    })
    expect(screen.queryByRole('link', { name: 'Mileage Rates' })).toBeNull()
  })

  it('fails closed (stays hidden) when GET /authz/me rejects', async () => {
    const adminApi = await import('../lib/adminApi')
    vi.mocked(adminApi.getMe).mockRejectedValue(new Error('network error'))

    await renderNavAt('/roles')

    await waitFor(() => {
      expect(vi.mocked(adminApi.getMe)).toHaveBeenCalled()
    })
    expect(screen.queryByRole('link', { name: 'Mileage Rates' })).toBeNull()
  })
})
