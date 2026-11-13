/**
 * @vitest-environment jsdom
 *
 * Component tests for SectionNav (T14, specs/20260713-auth-roles-permissions/tasks.md;
 * T31, specs/029-time-tracking — the proactive `time-list:manage` gate).
 * The capability-gated "Refund" entry moved to refund-ui's Settings tab on
 * 2026-11-13 (ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition amendment).
 *
 * Uses a real, minimal TanStack Router harness (mirrors
 * shell/src/components/Sidebar.test.tsx's own technique exactly, same
 * rationale: the whole point of "aria-current on the active section" is
 * that it comes from the ACTUAL current route via `<Link>`'s own
 * active-match mechanism, so a mocked router would test nothing real).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import SectionNav from './SectionNav'
import type { SectionNavProps } from './SectionNav'

// ---------------------------------------------------------------------------
// Module mock — `shell/session`'s usePermissions() (INC-32): SectionNav reads
// the caller's effective permissions from the shell to decide whether the
// "Time lists" entry appears. `beforeEach` defaults to the shell's
// EMPTY_PERMISSIONS (no grants) so the structural tests see the four links;
// the "Time lists" gate block below overrides it per test.
// ---------------------------------------------------------------------------

vi.mock('shell/session', async (importOriginal) => {
  const original = await importOriginal<typeof import('shell/session')>()
  return { ...original, usePermissions: vi.fn() }
})

const NO_GRANTS = { epoch: 0, apps: [], roles: [], departments: [], permissions: [] }

const grant = (permissions: { resource: string; action: string; conditions?: unknown }[]) => ({
  epoch: 1,
  apps: ['admin'],
  roles: ['admin'],
  departments: [],
  permissions,
})

beforeEach(async () => {
  const session = await import('shell/session')
  vi.mocked(session.usePermissions).mockReturnValue(NO_GRANTS)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.pushState(null, '', '/')
})

const ADMIN: SectionNavProps = { showAdmin: true, legalEntities: 'hidden' }

/** Builds a tiny router — SectionNav + Outlet at root, one leaf route per section. */
async function renderNavAt(path: string, props: SectionNavProps = ADMIN) {
  window.history.pushState(null, '', path)

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <SectionNav {...props} />
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
  const legalEntitiesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/legal-entities',
    validateSearch: (raw: Record<string, unknown>) => raw,
    component: () => <p>legal entities</p>,
  })
  const routeTree = rootRoute.addChildren([rolesRoute, departmentsRoute, usersRoute, auditRoute, legalEntitiesRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  await screen.findAllByRole('link')
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

describe('SectionNav by capability', () => {
  it('lists Legal entities after Users and before the far-right Audit when the person may manage an entity', async () => {
    await renderNavAt('/roles', { showAdmin: true, legalEntities: 'shown' })

    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Roles',
      'Departments',
      'Users',
      'Legal entities',
      'Audit',
    ])
    expect(screen.getByRole('link', { name: 'Audit' }).closest('li')?.className).toContain('tab-list-end')
  })

  it('lists only Legal entities for a manager-only person: the other sections are absent, not disabled', async () => {
    await renderNavAt('/legal-entities', { showAdmin: false, legalEntities: 'shown' })

    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['Legal entities'])
    expect(screen.getByRole('navigation', { name: 'Admin sections' })).not.toBeNull()
    expect(screen.queryByText('Roles')).toBeNull()
    expect(document.querySelector('[aria-disabled]')).toBeNull()
  })

  it('holds the place of a section that is still resolving with a silent skeleton tab, no link', async () => {
    await renderNavAt('/roles', { showAdmin: true, legalEntities: 'resolving' })

    expect(screen.getAllByRole('link')).toHaveLength(4)
    expect(screen.queryByRole('link', { name: 'Legal entities' })).toBeNull()
    expect(document.querySelectorAll('.skeleton[aria-hidden="true"]')).toHaveLength(1)
  })

  it('renders nothing at all when there is nothing to list and nothing resolving', async () => {
    window.history.pushState(null, '', '/roles')
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <SectionNav showAdmin={false} legalEntities="hidden" />
          <Outlet />
        </>
      ),
    })
    const rolesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/roles', component: () => <p>roles</p> })
    render(<RouterProvider router={createRouter({ routeTree: rootRoute.addChildren([rolesRoute]) })} />)
    await screen.findByText('roles')

    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('wraps: the tab row reflows instead of scrolling sideways (plan E8, WCAG 1.4.10)', async () => {
    await renderNavAt('/roles', { showAdmin: true, legalEntities: 'shown' })

    const list = screen.getByRole('list')
    expect(list.className).toContain('tab-list-wrap')
  })

  it('marks Legal entities active, with aria-current, on its page whatever its search', async () => {
    await renderNavAt('/legal-entities?entity=welld_ch&view=history', { showAdmin: true, legalEntities: 'shown' })

    expect(screen.getByRole('link', { name: 'Legal entities' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Roles' }).getAttribute('aria-current')).toBeNull()
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
// Time lists gate (T31, specs/029-time-tracking, AC-3.3): out of the DOM until the
// permissions resolve and hold `time-list:manage`, never disabled.
// ---------------------------------------------------------------------------

describe('SectionNav "Time lists" gate (T31, specs/029-time-tracking)', () => {
  const timeListManage = { resource: 'time-list', action: 'manage', conditions: null }

  it('is out of the DOM while the permissions have not resolved (the shell’s empty result)', async () => {
    await renderNavAt('/roles')

    expect(screen.queryByRole('link', { name: 'Time lists' })).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(4)
  })

  it('is out of the DOM for a caller whose permissions do not include time-list:manage', async () => {
    const session = await import('shell/session')
    vi.mocked(session.usePermissions).mockReturnValue(
      grant([
        { resource: 'rate', action: 'read', conditions: null },
        { resource: 'role', action: 'edit', conditions: null },
        // Same action, another resource: not the permission this link needs.
        { resource: 'time-entry', action: 'manage', conditions: null },
        // Same resource, another action: seeing the lists is not managing them.
        { resource: 'time-list', action: 'read', conditions: null },
      ]),
    )

    await renderNavAt('/roles')

    expect(screen.queryByRole('link', { name: 'Time lists' })).toBeNull()
  })

  it('is a real link to /time-lists once time-list:manage is held, with Audit still anchored last', async () => {
    const session = await import('shell/session')
    vi.mocked(session.usePermissions).mockReturnValue(grant([timeListManage]))

    await renderNavAt('/roles')

    const link = await screen.findByRole('link', { name: 'Time lists' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/time-lists')
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Roles',
      'Departments',
      'Users',
      'Time lists',
      'Audit',
    ])
  })


  it('marks "Time lists" active with aria-current="page" when on /time-lists', async () => {
    const session = await import('shell/session')
    vi.mocked(session.usePermissions).mockReturnValue(grant([timeListManage]))

    await renderNavAt('/time-lists')

    const link = await screen.findByRole('link', { name: 'Time lists' })
    expect(link.getAttribute('aria-current')).toBe('page')
  })
})
