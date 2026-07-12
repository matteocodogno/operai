/**
 * @vitest-environment jsdom
 *
 * Router structure + navigation tests for admin-ui's inner router (T14,
 * specs/004-auth-roles-permissions/tasks.md — "give admin-ui its inner
 * TanStack Router … done when: the four sections route client-side under
 * `/admin`"). Mirrors estimai-ui/src/router.test.tsx's technique (structural
 * assertions on the route tree + behavioral RouterProvider renders), using
 * the basepath-less `createAppRouter()` factory for these tests; App.test.tsx
 * separately covers the exposed remote's own hardcoded `/admin` basepath.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of a TanStack Router route object needed for these assertions. */
interface RouteTreeNode {
  id: string
  fullPath?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Imports the router module fresh (cache-busted) so each test builds its own route tree/instance. */
const importRouter = () => import('./router?t=' + Date.now())

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.pushState(null, '', '/')
})

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('router structure', () => {
  it('mounts the index redirect and the four section routes as direct children of root', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childPaths = (routeTree.children ?? [])
      .map((child) => child.fullPath)
      .filter((path): path is string => path !== undefined)
      .sort()

    expect(childPaths).toEqual(['/', '/audit', '/departments', '/roles', '/users'].sort())
    expect(routeTree.children).toHaveLength(5)
  })

  it('has no `_authed` (or other guard) layout route in the tree — mirrors estimai-ui/T13, AC-2.3', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childIds = (routeTree.children ?? []).map((child) => child.id)

    expect(childIds).not.toContain('_authed')
  })
})

// ---------------------------------------------------------------------------
// Navigation — the four sections route client-side (this task's done-when)
// ---------------------------------------------------------------------------

describe('the four sections route client-side', () => {
  it.each([
    ['/roles', 'admin-roles-page', 'Roles'],
    ['/departments', 'admin-departments-page', 'Departments'],
    ['/users', 'admin-users-page', 'Users'],
    ['/audit', 'admin-audit-page', 'Audit'],
  ] as const)('visiting %s renders its section (%s) and marks its nav link active', async (path, testId, label) => {
    window.history.pushState(null, '', path)
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId(testId)).not.toBeNull()

    const activeLink = screen.getByRole('link', { name: label })
    expect(activeLink.getAttribute('aria-current')).toBe('page')

    // The other three sections' links are present but not active.
    const allLinks = screen.getAllByRole('link')
    const inactiveLinks = allLinks.filter((link) => link !== activeLink)
    expect(inactiveLinks).toHaveLength(3)
    inactiveLinks.forEach((link) => expect(link.getAttribute('aria-current')).toBeNull())
  })

  it('root ("/") redirects to /roles', async () => {
    window.history.pushState(null, '', '/')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    await screen.findByTestId('admin-roles-page')
    expect(window.location.pathname).toBe('/roles')
  })

  it('an unmatched path renders the not-found fallback, with the section nav still mounted', async () => {
    window.history.pushState(null, '', '/nonexistent')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('admin-not-found-page')).not.toBeNull()
    // Chrome (nav) is not replaced by the not-found fallback.
    expect(screen.getByRole('navigation', { name: 'Admin sections' })).not.toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(4)
  })
})
