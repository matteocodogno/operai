/**
 * @vitest-environment jsdom
 *
 * Component tests for NewRequestPage (T16, specs/007-refund-service/
 * tasks.md, design.md F1 step 1). Covers: the spinner while `POST
 * /requests` is in flight, a successful create redirecting to Screen R2,
 * and a failed create rendering "Try again" / "Back to my requests".
 *
 * Router harness mirrors admin-ui/src/pages/UsersPage.test.tsx: NewRequestPage
 * both navigates programmatically (`useNavigate`, on create success) and
 * renders a `<Link>` ("Back to my requests"), so a real router context is
 * needed rather than mocking `@tanstack/react-router`.
 */

import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import NewRequestPage from './NewRequestPage'
import type { RefundRequestDetail } from '../lib/requestsApi'

vi.mock('../lib/requestsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/requestsApi')>()
  return { ...original, create: vi.fn() }
})

import * as requestsApi from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

function renderNewRequestPage(options?: { strictMode?: boolean }) {
  window.history.pushState(null, '', '/requests/new')
  const rootRoute = createRootRoute()
  const requestsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/requests', component: () => null })
  const newRequestRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/requests/new',
    component: NewRequestPage,
  })
  const requestDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/requests/$id',
    component: () => null,
  })
  const routeTree = rootRoute.addChildren([requestsRoute, newRequestRoute, requestDetailRoute])
  const router = createRouter({ routeTree })
  const tree = <RouterProvider router={router} />
  return render(options?.strictMode ? <StrictMode>{tree}</StrictMode> : tree)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState(null, '', '/')
})

const created: RefundRequestDetail = {
  id: 'req-new',
  status: 'draft',
  owner: { userId: 'u1', email: 'a@welld.ch', name: 'A' },
  submittedAt: null,
  decidedAt: null,
  decidedBy: null,
  rejectionMotivation: null,
  paidAt: null,
  paidBy: null,
  lines: [],
  subtotals: [],
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
}

describe('NewRequestPage', () => {
  it('shows a spinner while POST /requests is in flight', async () => {
    vi.mocked(requestsApi.create).mockReturnValue(pendingPromise())

    renderNewRequestPage()

    expect(await screen.findByTestId('new-request-spinner')).not.toBeNull()
  })

  it('redirects to /requests/$id with the created id on success', async () => {
    vi.mocked(requestsApi.create).mockResolvedValue(created)

    renderNewRequestPage()

    await waitFor(() => expect(window.location.pathname).toBe('/requests/req-new'))
  })

  it('shows an inline error with Try again / Back to my requests on failure, and retries', async () => {
    vi.mocked(requestsApi.create)
      .mockRejectedValueOnce(
        new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }),
      )
      .mockResolvedValueOnce(created)

    renderNewRequestPage()

    await waitFor(() => expect(screen.getByTestId('new-request-error')).not.toBeNull())
    expect(screen.getByTestId('new-request-error').textContent).toContain('Boom.')
    expect(screen.getByTestId('new-request-back-link').getAttribute('href')).toBe('/requests')

    fireEvent.click(screen.getByTestId('new-request-try-again'))

    await waitFor(() => expect(window.location.pathname).toBe('/requests/req-new'))
    expect(requestsApi.create).toHaveBeenCalledTimes(2)
  })

  it('creates exactly one draft under StrictMode double-invoke (regression: double-create bug)', async () => {
    vi.mocked(requestsApi.create).mockResolvedValue(created)

    renderNewRequestPage({ strictMode: true })

    await waitFor(() => expect(window.location.pathname).toBe('/requests/req-new'))

    // StrictMode mounts, unmounts, and remounts this component's effects on
    // the same instance in dev — asserting a single call here is the whole
    // point of the test: it fails against the pre-fix code (two POSTs, two
    // drafts) and passes once the effect is made idempotent per `attempt`.
    expect(requestsApi.create).toHaveBeenCalledTimes(1)
  })
})
