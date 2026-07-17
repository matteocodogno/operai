/**
 * @vitest-environment jsdom
 *
 * Component tests for ReviewQueuePage — Screen A1 (T18, specs/007-refund-
 * service/tasks.md). Mirrors MyRequestsPage.test.tsx's strategy (mock
 * `../lib/reviewApi` at the module level, keep the real `ApiError`) and its
 * router harness. Covers loading/empty/populated/error/PD, plus the
 * one-shot `confirmation` search-param flash message (T18's return-to-queue
 * announcement after Approve/Reject).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import ReviewQueuePage from './ReviewQueuePage'
import type { ReviewQueueItem } from '../lib/reviewApi'

vi.mock('../lib/reviewApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/reviewApi')>()
  return { ...original, listQueue: vi.fn() }
})

import * as reviewApi from '../lib/reviewApi'
import { ApiError } from '../lib/refundApi'

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

function renderReviewQueuePage(initialPath = '/review') {
  window.history.pushState(null, '', initialPath)
  const rootRoute = createRootRoute()
  const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review',
    component: ReviewQueuePage,
    validateSearch: (search: Record<string, unknown>): { confirmation?: string } => ({
      confirmation: typeof search.confirmation === 'string' ? search.confirmation : undefined,
    }),
  })
  const reviewDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review/$id', component: () => null })
  const routeTree = rootRoute.addChildren([reviewRoute, reviewDetailRoute])
  const router = createRouter({ routeTree })
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const queueItem: ReviewQueueItem = {
  id: 'req-1',
  status: 'submitted',
  owner: { email: 'alice@welld.ch', name: 'Alice' },
  submittedAt: '2026-07-14T00:00:00.000Z',
  subtotals: [{ currency: 'EUR', requestedCents: 4550, approvedCents: null }],
}

describe('ReviewQueuePage — list states', () => {
  it('renders SkeletonListRows while the queue is in-flight', async () => {
    vi.mocked(reviewApi.listQueue).mockReturnValue(pendingPromise())

    renderReviewQueuePage()

    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('renders "Nothing awaiting your decision" when the queue is empty (a real result, not a denial)', async () => {
    vi.mocked(reviewApi.listQueue).mockResolvedValue([])

    renderReviewQueuePage()

    await waitFor(() => expect(screen.getByTestId('review-queue-empty-state')).not.toBeNull())
    expect(screen.getByTestId('review-queue-empty-state').textContent).toBe('Nothing awaiting your decision right now.')
  })

  it('renders a row per queue item with employee, submitted date, and subtotal preview', async () => {
    vi.mocked(reviewApi.listQueue).mockResolvedValue([queueItem])

    renderReviewQueuePage()

    await waitFor(() => expect(screen.getByTestId('review-queue-list')).not.toBeNull())
    const row = screen.getByTestId(`review-queue-row-${queueItem.id}`)
    expect(row.textContent).toContain('Alice')
    expect(row.textContent).toContain('45,50 €')
  })

  it('renders each row as a link to /review/$id', async () => {
    vi.mocked(reviewApi.listQueue).mockResolvedValue([queueItem])

    renderReviewQueuePage()

    await waitFor(() => expect(screen.getByTestId('review-queue-list')).not.toBeNull())
    expect(screen.getByTestId(`review-queue-row-${queueItem.id}`).getAttribute('href')).toBe(`/review/${queueItem.id}`)
  })

  it('renders ErrorBanner and retries on click', async () => {
    vi.mocked(reviewApi.listQueue)
      .mockRejectedValueOnce(new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }))
      .mockResolvedValueOnce([queueItem])

    renderReviewQueuePage()

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    expect(screen.getByRole('alert').textContent).toContain('Boom.')

    fireEvent.click(screen.getByTestId('error-banner-retry'))

    await waitFor(() => expect(screen.getByTestId('review-queue-list')).not.toBeNull())
    expect(reviewApi.listQueue).toHaveBeenCalledTimes(2)
  })

  // QE regression (specs/007-refund-service, T21 verification pass) — the
  // REAL refund-api wire contract sends `owner.name: null` for every request
  // ever created: `POST /requests` always calls `createDraftRequest(sub,
  // email, null)` (requests.routes.ts) because the JWT carries no `name`
  // claim (jwt.middleware.ts only extracts `sub`/`email`) — verified live
  // against a running refund-api (see QE report). `ReviewQueueItem`'s own
  // type declares `owner.name: string` (non-nullable, reviewApi.ts), which
  // is simply WRONG against that real contract — this test uses `as
  // ReviewQueueItem` to force a runtime-accurate fixture through the
  // (incorrect) compile-time type, the same way the real `fetch` response
  // would. Expected to FAIL until reviewApi.ts's type is corrected to
  // `name: string | null` and the row/aria-label fall back to the email.
  it('DEFECT (QE): a request with no owner name never renders the literal string "null"', async () => {
    // `as unknown as ReviewQueueItem`, not a plain `as`: TypeScript itself
    // refuses the direct cast (TS2352, "types don't sufficiently overlap")
    // because `owner.name: string` cannot legally hold `null` — which is
    // exactly the point being demonstrated: the type is wrong against the
    // real wire contract.
    const noNameItem = {
      ...queueItem,
      id: 'req-no-name',
      owner: { email: 'bob@welld.ch', name: null },
    } as unknown as ReviewQueueItem
    vi.mocked(reviewApi.listQueue).mockResolvedValue([noNameItem])

    renderReviewQueuePage()

    await waitFor(() => expect(screen.getByTestId('review-queue-list')).not.toBeNull())
    const row = screen.getByTestId(`review-queue-row-${noNameItem.id}`)
    expect(row.textContent).not.toContain('null')
    expect(row.getAttribute('aria-label')).not.toContain('null')
  })

  it('renders PermissionDenied on a 403 (no request:review at all, AC-5.4), no Retry', async () => {
    vi.mocked(reviewApi.listQueue).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'No review grant.' }),
    )

    renderReviewQueuePage()

    await waitFor(() => expect(screen.getByTestId('permission-denied')).not.toBeNull())
    expect(screen.queryByTestId('error-banner-retry')).toBeNull()
  })
})

describe('ReviewQueuePage — return-to-queue confirmation', () => {
  it('announces a one-shot `confirmation` search param via aria-live, then strips it from the URL', async () => {
    vi.mocked(reviewApi.listQueue).mockResolvedValue([])

    renderReviewQueuePage('/review?confirmation=' + encodeURIComponent("Approved — Alice's request"))

    await waitFor(() =>
      expect(screen.getByTestId('review-queue-live-message').textContent).toBe("Approved — Alice's request"),
    )
    await waitFor(() => expect(window.location.search).toBe(''))
  })

  it('renders no confirmation text when no search param is present', async () => {
    vi.mocked(reviewApi.listQueue).mockResolvedValue([])

    renderReviewQueuePage()

    await waitFor(() => expect(screen.getByTestId('review-queue-empty-state')).not.toBeNull())
    expect(screen.getByTestId('review-queue-live-message').textContent).toBe('')
  })
})
