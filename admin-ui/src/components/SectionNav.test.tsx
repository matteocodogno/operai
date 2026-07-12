/**
 * @vitest-environment jsdom
 *
 * Component tests for SectionNav (T14, specs/004-auth-roles-permissions/tasks.md).
 *
 * Uses a real, minimal TanStack Router harness (mirrors
 * shell/src/components/Sidebar.test.tsx's own technique exactly, same
 * rationale: the whole point of "aria-current on the active section" is
 * that it comes from the ACTUAL current route via `<Link>`'s own
 * active-match mechanism, so a mocked router would test nothing real).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import SectionNav from './SectionNav'

afterEach(() => {
  cleanup()
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
  const routeTree = rootRoute.addChildren([rolesRoute, departmentsRoute, usersRoute, auditRoute])
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
