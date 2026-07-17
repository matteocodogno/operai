/**
 * @vitest-environment jsdom
 *
 * Component tests for MyRequestsPage — Screen R1 (T16, specs/007-refund-
 * service/tasks.md). Mirrors admin-ui/src/pages/RolesPage.test.tsx's
 * strategy (mock `../lib/requestsApi` at the module level, keep the real
 * `ApiError`) and admin-ui/src/pages/UsersPage.test.tsx's router harness
 * (MyRequestsPage renders real `<Link>`s, which need a real router context
 * to resolve `to`/`params` — a minimal two-route tree is enough).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import MyRequestsPage from './MyRequestsPage'
import type { RequestListItem } from '../lib/requestsApi'

vi.mock('../lib/requestsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/requestsApi')>()
  return { ...original, list: vi.fn() }
})

import * as requestsApi from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

function renderMyRequestsPage() {
  window.history.pushState(null, '', '/requests')
  const rootRoute = createRootRoute()
  const requestsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/requests', component: MyRequestsPage })
  const newRequestRoute = createRoute({ getParentRoute: () => rootRoute, path: '/requests/new', component: () => null })
  const requestDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/requests/$id', component: () => null })
  const routeTree = rootRoute.addChildren([requestsRoute, newRequestRoute, requestDetailRoute])
  const router = createRouter({ routeTree })
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const draftItem: RequestListItem = {
  id: 'req-1',
  status: 'draft',
  updatedAt: '2026-07-10T00:00:00.000Z',
  subtotals: [],
}

const submittedItem: RequestListItem = {
  id: 'req-2',
  status: 'submitted',
  updatedAt: '2026-07-15T00:00:00.000Z',
  subtotals: [{ currency: 'EUR', requestedCents: 4550, approvedCents: null }],
}

describe('MyRequestsPage — list states', () => {
  it('renders SkeletonListRows while the list is in-flight', async () => {
    vi.mocked(requestsApi.list).mockReturnValue(pendingPromise())

    renderMyRequestsPage()

    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('renders the onboarding empty state with a "+ New request" CTA when there are no requests', async () => {
    vi.mocked(requestsApi.list).mockResolvedValue([])

    renderMyRequestsPage()

    await waitFor(() => expect(screen.getByTestId('my-requests-empty-state')).not.toBeNull())
    expect(screen.getByTestId('my-requests-empty-new-button').getAttribute('href')).toBe('/requests/new')
  })

  it('renders a row per request with its status badge, updated date, and subtotal preview', async () => {
    vi.mocked(requestsApi.list).mockResolvedValue([draftItem, submittedItem])

    renderMyRequestsPage()

    await waitFor(() => expect(screen.getByTestId('my-requests-list')).not.toBeNull())
    expect(screen.getByTestId(`my-requests-row-${draftItem.id}`).textContent).toContain('Draft')
    const submittedRow = screen.getByTestId(`my-requests-row-${submittedItem.id}`)
    expect(submittedRow.textContent).toContain('Awaiting decision')
    expect(submittedRow.textContent).toContain('45,50 €')
  })

  it('renders each row as a link to /requests/$id', async () => {
    vi.mocked(requestsApi.list).mockResolvedValue([draftItem])

    renderMyRequestsPage()

    await waitFor(() => expect(screen.getByTestId('my-requests-list')).not.toBeNull())
    expect(screen.getByTestId(`my-requests-row-${draftItem.id}`).getAttribute('href')).toBe(`/requests/${draftItem.id}`)
  })

  it('renders ErrorBanner and retries on click', async () => {
    vi.mocked(requestsApi.list)
      .mockRejectedValueOnce(new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }))
      .mockResolvedValueOnce([draftItem])

    renderMyRequestsPage()

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    expect(screen.getByRole('alert').textContent).toContain('Boom.')

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => expect(screen.getByTestId('my-requests-list')).not.toBeNull())
    expect(requestsApi.list).toHaveBeenCalledTimes(2)
  })

  it('renders PermissionDenied on a 403, no "+ New request" button, no Retry', async () => {
    vi.mocked(requestsApi.list).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'No refund access.' }),
    )

    renderMyRequestsPage()

    await waitFor(() => expect(screen.getByTestId('permission-denied')).not.toBeNull())
    expect(screen.queryByTestId('my-requests-new-button')).toBeNull()
    expect(screen.queryByTestId('error-banner-retry')).toBeNull()
  })
})
