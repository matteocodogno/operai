/**
 * @vitest-environment jsdom
 *
 * Component tests for RefundShell (T14, specs/007-refund-service/tasks.md;
 * accounting-tab permission gate added as a follow-up to
 * specs/008-refund-monthly-processing).
 *
 * Uses a real, minimal TanStack Router harness (mirrors
 * admin-ui/src/components/SectionNav.test.tsx's technique exactly, same
 * rationale: "aria-current on the active section" only means something when
 * it comes from a real route via `<Link>`'s own active-match mechanism).
 *
 * `usePermissions` (shell/session) IS mocked here, deliberately — mirrors
 * shell/src/components/Sidebar.test.tsx's own rationale exactly: it is the
 * one dependency this gate adds, and controlling its return value directly
 * pins down exactly which nav items a given permission set produces, without
 * standing up a fake `/authz/me` fetch. The default (`beforeEach`) grants
 * `request:review`, so every pre-existing test in this file keeps observing
 * the same three-item nav it always has; the new "accounting nav tab gating"
 * describe block below overrides the mock per test to exercise the gate
 * itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { Permission, PermissionsResult } from 'shell/session'

const { usePermissions } = vi.hoisted(() => ({ usePermissions: vi.fn() }))
vi.mock('shell/session', () => ({ usePermissions }))

import RefundShell from './RefundShell'

/** Builds a full PermissionsResult from just the `permissions` a test cares about. */
const permissionsWith = (permissions: Permission[]): PermissionsResult => ({
  epoch: 0,
  apps: ['refund'],
  roles: [],
  departments: [],
  permissions,
})

const REQUEST_REVIEW_UNCONDITIONED: Permission = { resource: 'request', action: 'review' }
const REQUEST_REVIEW_ENTITY_SCOPED: Permission = {
  resource: 'request',
  action: 'review',
  conditions: { entity: 'acme' },
}

beforeEach(() => {
  // Default: request:review granted — matches every pre-existing test's
  // expectation of a three-item nav.
  usePermissions.mockReturnValue(permissionsWith([REQUEST_REVIEW_UNCONDITIONED]))
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
  vi.clearAllMocks()
})

async function renderShellAt(path: string) {
  window.history.pushState(null, '', path)

  const rootRoute = createRootRoute({ component: RefundShell })
  const requestsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/requests',
    component: () => <p>requests</p>,
  })
  const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review',
    component: () => <p>review</p>,
  })
  const batchesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/batches',
    component: () => <p>batches</p>,
  })
  const routeTree = rootRoute.addChildren([requestsRoute, reviewRoute, batchesRoute])
  const router = createRouter({ routeTree })
  const utils = render(<RouterProvider router={router} />)
  await screen.findByRole('heading', { name: /^refund$/i })
  return utils
}

describe('RefundShell structure', () => {
  it('renders the tool heading', async () => {
    await renderShellAt('/requests')

    expect(screen.getByRole('heading', { name: /^refund$/i })).not.toBeNull()
  })

  it('renders a real nav landmark labelled "Refund navigation"', async () => {
    await renderShellAt('/requests')

    expect(screen.getByRole('navigation', { name: 'Refund navigation' })).not.toBeNull()
  })

  it('renders exactly the three nav links, as real <a> elements (not buttons/divs)', async () => {
    await renderShellAt('/requests')

    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['My requests', 'Review queue', 'Monthly processing'])
    links.forEach((link) => expect(link.tagName).toBe('A'))
  })

  it('renders the routed content via <Outlet/>', async () => {
    await renderShellAt('/requests')

    expect(screen.getByText('requests')).not.toBeNull()
  })
})

describe('RefundShell nav active state (aria-current)', () => {
  it('marks "My requests" active on /requests, "Review queue" not active', async () => {
    await renderShellAt('/requests')

    expect(screen.getByRole('link', { name: 'My requests' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Review queue' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks "Review queue" active on /review, "My requests" not active', async () => {
    await renderShellAt('/review')

    expect(screen.getByRole('link', { name: 'Review queue' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'My requests' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks "Monthly processing" active on /batches, the others not active', async () => {
    await renderShellAt('/batches')

    expect(screen.getByRole('link', { name: 'Monthly processing' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'My requests' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('link', { name: 'Review queue' }).getAttribute('aria-current')).toBeNull()
  })
})

describe('RefundShell accounting nav tab gating', () => {
  it('hides "Review queue" and "Monthly processing" — keeps "My requests" — when the caller has no request:review grant', async () => {
    usePermissions.mockReturnValue(permissionsWith([]))

    await renderShellAt('/requests')

    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['My requests'])
  })

  it('shows all three tabs when the caller holds an unconditioned request:review grant', async () => {
    usePermissions.mockReturnValue(permissionsWith([REQUEST_REVIEW_UNCONDITIONED]))

    await renderShellAt('/requests')

    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['My requests', 'Review queue', 'Monthly processing'])
  })

  it('shows all three tabs when the caller holds only an entity-scoped request:review grant (presence, not scope, gates the tab)', async () => {
    usePermissions.mockReturnValue(permissionsWith([REQUEST_REVIEW_ENTITY_SCOPED]))

    await renderShellAt('/requests')

    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['My requests', 'Review queue', 'Monthly processing'])
  })

  it('only shows "My requests" on the first render before permissions resolve (EMPTY_PERMISSIONS)', async () => {
    usePermissions.mockReturnValue(permissionsWith([]))

    await renderShellAt('/requests')

    expect(screen.getByRole('link', { name: 'My requests' })).not.toBeNull()
    expect(screen.queryByRole('link', { name: 'Review queue' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Monthly processing' })).toBeNull()
  })

  it('does not render "Review queue"/"Monthly processing" for a permission on a different resource/action', async () => {
    usePermissions.mockReturnValue(
      permissionsWith([
        { resource: 'request', action: 'create' },
        { resource: 'department', action: 'review' },
      ]),
    )

    await renderShellAt('/requests')

    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['My requests'])
  })
})
