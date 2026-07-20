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
 * via `requestsApi` (built on `shell/session`'s `apiFetch`).
 *
 * T18 update: `/review` and `/review/$id` are likewise no longer static
 * placeholders — they fetch via `reviewApi`/`requestsApi` (same `apiFetch`
 * plumbing). `apiFetch` is mocked module-wide here purely so these
 * ROUTING-level tests don't need real network — the real fetch/mutation
 * behavior of each screen is covered by its own test file
 * (MyRequestsPage.test.tsx, NewRequestPage.test.tsx,
 * RequestDetailPage.test.tsx, ReviewQueuePage.test.tsx,
 * ReviewDetailPage.test.tsx).
 *
 * T9 update (specs/008-refund-monthly-processing/tasks.md): `/batches`,
 * `/batches/new`, and `/batches/$id` (Screens B1/B2/B3) are added, still as
 * static placeholders (real screens are T11-T13) — same "prove the route
 * mounts, real fetch behavior belongs to the screen's own test file"
 * posture already established above.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider } from '@tanstack/react-router'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  // RefundShell (the router's root component) reads usePermissions() to
  // gate the "Review queue"/"Monthly processing" tabs (specs/008 follow-up,
  // RefundShell.tsx); these ROUTING-level tests aren't about that gate, so
  // grant request:review unconditionally to preserve the pre-existing
  // "all three tabs render" shape. RefundShell.test.tsx covers the gate
  // itself in isolation.
  usePermissions: vi.fn(() => ({
    epoch: 0,
    apps: ['refund'],
    roles: [],
    departments: [],
    permissions: [{ resource: 'request', action: 'review' }],
  })),
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
  it('mounts the index redirect and the eight routes (requests, requests/new, requests/$id, review, review/$id, batches, batches/new, batches/$id) as direct children of root', async () => {
    const { createAppRouter } = await importRouter()
    const routeTree = createAppRouter().routeTree as unknown as { children?: RouteTreeNode[] }

    const childPaths = (routeTree.children ?? [])
      .map((child) => child.fullPath)
      .filter((path): path is string => path !== undefined)
      .sort()

    expect(childPaths).toEqual(
      [
        '/',
        '/requests',
        '/requests/new',
        '/requests/$id',
        '/review',
        '/review/$id',
        '/batches',
        '/batches/new',
        '/batches/$id',
      ].sort(),
    )
    expect(routeTree.children).toHaveLength(9)
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

  it('visiting /review renders Screen A1 (refund-review-queue-page)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(200, []))
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

  it('visiting /review/$id resolves the id param and fetches that request', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'rev-xyz',
        status: 'submitted',
        owner: { userId: 'u1', email: 'a@welld.ch', name: 'A' },
        submittedAt: '2026-07-15T00:00:00.000Z',
        decidedAt: null,
        decidedBy: null,
        rejectionMotivation: null,
        lines: [],
        subtotals: [],
        createdAt: '2026-07-15T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
      }),
    )
    window.history.pushState(null, '', '/review/rev-xyz')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-review-detail-page')).not.toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('refund-review-detail-id').textContent).toBe('rev-xyz')
    })
  })

  it('visiting /batches renders Screen B1 (refund-batch-history-page)', async () => {
    window.history.pushState(null, '', '/batches')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-batch-history-page')).not.toBeNull()
  })

  it('visiting /batches/new renders Screen B2 (refund-compile-batch-page)', async () => {
    window.history.pushState(null, '', '/batches/new')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-compile-batch-page')).not.toBeNull()
  })

  it('visiting /batches/$id resolves the id param and renders Screen B3 (refund-batch-detail-page)', async () => {
    window.history.pushState(null, '', '/batches/batch-abc')
    const { createAppRouter } = await importRouter()
    const router = createAppRouter()

    render(<RouterProvider router={router} />)

    expect(await screen.findByTestId('refund-batch-detail-page')).not.toBeNull()
    expect(screen.getByTestId('refund-batch-detail-id').textContent).toBe('batch-abc')
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
    expect(screen.getAllByRole('link')).toHaveLength(3)
  })
})
