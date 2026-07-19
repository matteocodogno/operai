/**
 * @vitest-environment jsdom
 *
 * Component tests for BatchHistoryPage — Screen B1 (T13, specs/008-refund-
 * monthly-processing/tasks.md). `../lib/batchesApi` is mocked at the module
 * level (keeping the real `ApiError`). Rendered inside a real, minimal
 * router (mirrors ReviewQueuePage.test.tsx) so `Link` resolves exactly as it
 * does in the app.
 *
 * Covers: L/E/P/Err/PD, every status appearing in the list (AC-8.2), and
 * that each row opens Screen B3.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import BatchHistoryPage from './BatchHistoryPage'
import type { BatchSummary } from '../lib/batchesApi'

vi.mock('../lib/batchesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/batchesApi')>()
  return { ...original, list: vi.fn() }
})

import * as batchesApi from '../lib/batchesApi'
import { ApiError } from '../lib/refundApi'

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

function renderBatchHistoryPage() {
  window.history.pushState(null, '', '/batches')
  const rootRoute = createRootRoute()
  const batchesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches', component: BatchHistoryPage })
  const compileBatchRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches/new', component: () => null })
  const batchDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches/$id', component: () => null })
  const routeTree = rootRoute.addChildren([batchesRoute, compileBatchRoute, batchDetailRoute])
  const router = createRouter({ routeTree })
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState(null, '', '/')
})

const items: BatchSummary[] = [
  {
    id: 'batch-1',
    cutoff: '2026-07-19T00:00:00.000Z',
    status: 'compiled',
    requestCount: 2,
    subtotals: [{ currency: 'EUR', approvedCents: 5000 }],
    emailStatus: 'sent',
    createdAt: '2026-07-19T00:00:00.000Z',
  },
  {
    id: 'batch-2',
    cutoff: '2026-06-19T00:00:00.000Z',
    status: 'paid',
    requestCount: 1,
    subtotals: [{ currency: 'CHF', approvedCents: 12000 }],
    emailStatus: 'sent',
    createdAt: '2026-06-19T00:00:00.000Z',
  },
  {
    id: 'batch-3',
    cutoff: '2026-05-19T00:00:00.000Z',
    status: 'discarded',
    requestCount: 1,
    subtotals: [],
    emailStatus: 'failed',
    createdAt: '2026-05-19T00:00:00.000Z',
  },
]

describe('BatchHistoryPage — loading / error / PD', () => {
  it('shows SkeletonListRows while loading', async () => {
    vi.mocked(batchesApi.list).mockReturnValue(pendingPromise())
    renderBatchHistoryPage()
    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('shows ErrorBanner + Retry on a non-403 failure, and Retry re-fetches', async () => {
    vi.mocked(batchesApi.list)
      .mockRejectedValueOnce(new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }))
      .mockResolvedValueOnce(items)
    renderBatchHistoryPage()

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await waitFor(() => expect(screen.getByTestId('batch-history-list')).not.toBeNull())
  })

  it('shows PermissionDenied with no Retry, and hides "+ Compile new batch" (AC-8.3)', async () => {
    vi.mocked(batchesApi.list).mockRejectedValue(new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }))
    renderBatchHistoryPage()

    await waitFor(() => expect(screen.getByTestId('permission-denied')).not.toBeNull())
    expect(screen.queryByTestId('error-banner-retry')).toBeNull()
    expect(screen.queryByTestId('batch-history-new-button')).toBeNull()
  })
})

describe('BatchHistoryPage — empty', () => {
  it('shows the zero-batches-ever onboarding state with a CTA', async () => {
    vi.mocked(batchesApi.list).mockResolvedValue([])
    renderBatchHistoryPage()

    await waitFor(() => expect(screen.getByTestId('batch-history-empty-state')).not.toBeNull())
    expect(screen.getByTestId('batch-history-empty-new-button').getAttribute('href')).toBe('/batches/new')
  })
})

describe('BatchHistoryPage — populated (AC-8.2: every status listed)', () => {
  it('lists every batch regardless of status, and each row opens Screen B3', async () => {
    vi.mocked(batchesApi.list).mockResolvedValue(items)
    renderBatchHistoryPage()

    await waitFor(() => expect(screen.getByTestId('batch-history-list')).not.toBeNull())
    expect(screen.getByTestId('batch-history-row-batch-1')).not.toBeNull()
    expect(screen.getByTestId('batch-history-row-batch-2')).not.toBeNull()
    expect(screen.getByTestId('batch-history-row-batch-3')).not.toBeNull()
    expect(screen.getByTestId('batch-history-row-batch-1').getAttribute('href')).toBe('/batches/batch-1')

    // Per-currency preview + compact email-status indicator both render.
    expect(screen.getByTestId('batch-history-row-batch-1').textContent).toContain('50,00 €')
    expect(screen.getByTestId('batch-history-row-batch-3-email').textContent).toMatch(/failed/i)
  })
})
