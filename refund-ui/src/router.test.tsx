/**
 * @vitest-environment jsdom
 *
 * Router structure + navigation tests for refund-ui's inner router (T14,
 * specs/007-refund-service/tasks.md — "the router mounts all five routes
 * with placeholder screens"). Mirrors admin-ui/src/router.test.tsx's
 * technique (structural assertions on the route tree + behavioral
 * RouterProvider renders), using the basepath-less `createAppRouter()`
 * factory; App.test.tsx separately covers the exposed remote's own
 * hardcoded `/refund` basepath.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

/** Minimal shape of a TanStack Router route object needed for these assertions. */
interface RouteTreeNode {
  id: string
  fullPath?: string
}

/** Imports the router module fresh (cache-busted) so each test builds its own route tree/instance. */
const importRouter = () => import('./router?t=' + Date.now())

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.pushState(null, '', '/')
})

describe('router structure', () => {
  it('mounts the index redirect and the five routes (requests, requests/new, requests/$id, review, review/$id) as direct children of root', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childPaths = (routeTree.children ?? [])
      .map((child) => child.fullPath)
      .filter((path): path is string => path !== undefined)
      .sort()

    expect(childPaths).toEqual(
      ['/', '/requests', '/requests/new', '/requests/$id', '/review', '/review/$id'].sort(),
    )
    expect(routeTree.children).toHaveLength(6)
  })

  it('has no `_authed` (or other guard) layout route in the tree — mirrors admin-ui/estimai-ui, ADR-0006', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childIds = (routeTree.children ?? []).map((child) => child.id)

    expect(childIds).not.toContain('_authed')
  })
})

describe('the five routes render client-side', () => {
  it.each([
    ['/requests', 'refund-my-requests-page'],
    ['/requests/new', 'refund-new-request-page'],
    ['/review', 'refund-review-queue-page'],
  ] as const)('visiting %s renders its placeholder (%s)', async (path, testId) => {
    window.history.pushState(null, '', path)
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId(testId)).not.toBeNull()
  })

  it('visiting /requests/new renders Screen "new request", not the /requests/$id detail route (static-vs-dynamic-segment precedence)', async () => {
    window.history.pushState(null, '', '/requests/new')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-new-request-page')).not.toBeNull()
    expect(screen.queryByTestId('refund-request-detail-page')).toBeNull()
  })

  it('visiting /requests/$id resolves the id param', async () => {
    window.history.pushState(null, '', '/requests/req-abc')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-request-detail-page')).not.toBeNull()
    expect(screen.getByTestId('refund-request-detail-id').textContent).toBe('req-abc')
  })

  it('visiting /review/$id resolves the id param', async () => {
    window.history.pushState(null, '', '/review/rev-xyz')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-review-detail-page')).not.toBeNull()
    expect(screen.getByTestId('refund-review-detail-id').textContent).toBe('rev-xyz')
  })

  it('root ("/") redirects to /requests', async () => {
    window.history.pushState(null, '', '/')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    await screen.findByTestId('refund-my-requests-page')
    expect(window.location.pathname).toBe('/requests')
  })

  it('an unmatched path renders the not-found fallback, with the nav still mounted', async () => {
    window.history.pushState(null, '', '/nonexistent')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-not-found-page')).not.toBeNull()
    expect(screen.getByRole('navigation', { name: 'Refund navigation' })).not.toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })
})
