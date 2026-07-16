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
 *
 * T16 update (specs/007-refund-service/tasks.md): `/requests`, `/requests/
 * new`, and `/requests/$id` are no longer static placeholders — they fetch
 * via `requestsApi` (built on `shell/session`'s `apiFetch`). `/review` and
 * `/review/$id` remain T14 placeholders (T18's scope) so their assertions
 * are unchanged. `apiFetch` is mocked module-wide here purely so these
 * ROUTING-level tests don't need real network — the real fetch/mutation
 * behavior of each screen is covered by its own test file
 * (MyRequestsPage.test.tsx, NewRequestPage.test.tsx,
 * RequestDetailPage.test.tsx).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from 'shell/session'

/** Minimal shape of a TanStack Router route object needed for these assertions. */
interface RouteTreeNode {
  id: string
  fullPath?: string
}

const REFUND_API_URL = 'http://refund-api.test'

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Imports the router module fresh (cache-busted) so each test builds its own route tree/instance. */
const importRouter = () => import('./router?t=' + Date.now())

beforeEach(() => {
  vi.stubEnv('VITE_REFUND_API_URL', REFUND_API_URL)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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
  it('visiting /requests renders Screen R1 (refund-my-requests-page)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, []))
    window.history.pushState(null, '', '/requests')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-my-requests-page')).not.toBeNull()
  })

  it('visiting /review renders its placeholder (refund-review-queue-page)', async () => {
    window.history.pushState(null, '', '/review')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-review-queue-page')).not.toBeNull()
  })

  it('visiting /requests/new immediately creates a draft and redirects to Screen R2, not Screen R1', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(201, {
        id: 'req-new-1',
        status: 'draft',
        owner: { userId: 'u1', email: 'a@welld.ch', name: 'A' },
        submittedAt: null,
        decidedAt: null,
        decidedBy: null,
        rejectionMotivation: null,
        lines: [],
        subtotals: [],
        createdAt: '2026-07-16T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
      }),
    )
    window.history.pushState(null, '', '/requests/new')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    await waitFor(() => {
      expect(screen.getByTestId('refund-request-detail-id').textContent).toBe('req-new-1')
    })
    expect(await screen.findByTestId('refund-request-detail-page')).not.toBeNull()
    expect(window.location.pathname).toBe('/requests/req-new-1')
  })

  it('visiting /requests/$id resolves the id param and fetches that request', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'req-abc',
        status: 'draft',
        owner: { userId: 'u1', email: 'a@welld.ch', name: 'A' },
        submittedAt: null,
        decidedAt: null,
        decidedBy: null,
        rejectionMotivation: null,
        lines: [],
        subtotals: [],
        createdAt: '2026-07-16T00:00:00.000Z',
        updatedAt: '2026-07-16T00:00:00.000Z',
      }),
    )
    window.history.pushState(null, '', '/requests/req-abc')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-request-detail-page')).not.toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('refund-request-detail-id').textContent).toBe('req-abc')
    })
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
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, []))
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
