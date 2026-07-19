/**
 * @vitest-environment jsdom
 *
 * Component tests for BatchDetailPage — Screen B3 (T12, specs/008-refund-
 * monthly-processing/tasks.md). `../lib/batchesApi` is mocked at the module
 * level (keeping the real `ApiError` from `../lib/refundApi`). Rendered
 * inside a real, minimal router (mirrors CompileBatchPage.test.tsx) with
 * `validateSearch` on `/batches/$id` so the post-compile `confirmation`
 * search param round-trips exactly as it does in the app.
 *
 * Covers: L/Err/NF/PD, the status-driven variants (compiled/paid/discarded),
 * resend email (success + failure toast), mark-as-paid (MarkPaidDialog
 * open → success reload-in-place, and the 409 → GuardrailDialog race),
 * discard (ConfirmDeleteModal → success reload-in-place, and the 409 race),
 * the PDF mint affordance, and the one-shot post-compile confirmation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import BatchDetailPage from './BatchDetailPage'
import type { BatchDetail } from '../lib/batchesApi'

vi.mock('../lib/batchesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/batchesApi')>()
  return {
    ...original,
    get: vi.fn(),
    getPdfUrl: vi.fn(),
    sendEmail: vi.fn(),
    markPaid: vi.fn(),
    discard: vi.fn(),
  }
})

import * as batchesApi from '../lib/batchesApi'
import { ApiError } from '../lib/refundApi'

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

function renderBatchDetailPage(id = 'batch-1', search = '') {
  window.history.pushState(null, '', `/batches/${id}${search}`)
  const rootRoute = createRootRoute()
  const batchesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches', component: () => null })
  const batchDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/batches/$id',
    component: BatchDetailPage,
    validateSearch: (search: Record<string, unknown>): { confirmation?: string } => ({
      confirmation: typeof search.confirmation === 'string' ? search.confirmation : undefined,
    }),
  })
  const routeTree = rootRoute.addChildren([batchesRoute, batchDetailRoute])
  const router = createRouter({ routeTree })
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState(null, '', '/')
})

const compiledBatch: BatchDetail = {
  id: 'batch-1',
  cutoff: '2026-07-19T00:00:00.000Z',
  status: 'compiled',
  requestCount: 2,
  createdBy: { userId: 'acct-1', email: 'acct@welld.ch' },
  createdAt: '2026-07-19T00:00:00.000Z',
  subtotals: [{ currency: 'EUR', approvedCents: 5000 }],
  employees: [
    {
      owner: { userId: 'u1', email: 'alice@welld.ch', name: 'Alice' },
      requests: [{ id: 'req-1', status: 'approved', subtotals: [{ currency: 'EUR', approvedCents: 5000 }] }],
    },
  ],
  email: { status: 'sent', lastAttemptAt: '2026-07-19T00:01:00.000Z' },
  paidAt: null,
  paidBy: null,
  discardedAt: null,
  discardedBy: null,
  pdf: { url: 'https://bucket.example/compiled.pdf', expiresAt: '2026-07-19T00:01:00.000Z' },
}

const paidBatch: BatchDetail = {
  ...compiledBatch,
  status: 'paid',
  paidAt: '2026-07-20T09:00:00.000Z',
  paidBy: 'acct@welld.ch',
}

const discardedBatch: BatchDetail = {
  ...compiledBatch,
  status: 'discarded',
  discardedAt: '2026-07-20T09:00:00.000Z',
  discardedBy: 'acct@welld.ch',
}

describe('BatchDetailPage — loading / error / not found / PD', () => {
  it('shows SkeletonListRows while loading', async () => {
    vi.mocked(batchesApi.get).mockReturnValue(pendingPromise())
    renderBatchDetailPage()
    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('shows ErrorBanner + Retry on a non-404/403 failure', async () => {
    vi.mocked(batchesApi.get)
      .mockRejectedValueOnce(new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }))
      .mockResolvedValueOnce(compiledBatch)
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
  })

  it('shows a neutral not-found state on 404, with a back link', async () => {
    vi.mocked(batchesApi.get).mockRejectedValue(new ApiError({ type: 'about:blank', title: 'Not Found', status: 404 }))
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-not-found')).not.toBeNull())
    expect(screen.getByTestId('batch-detail-not-found-back').getAttribute('href')).toBe('/batches')
  })

  it('shows PermissionDenied with no Retry on 403 (AC-2.3)', async () => {
    vi.mocked(batchesApi.get).mockRejectedValue(new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }))
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('permission-denied')).not.toBeNull())
    expect(screen.queryByTestId('error-banner-retry')).toBeNull()
  })
})

describe('BatchDetailPage — status-driven variants', () => {
  it('compiled: shows Mark-as-paid + Discard, no paid/discarded stamp lines', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    expect(screen.getByTestId('batch-detail-mark-paid')).not.toBeNull()
    expect(screen.getByTestId('batch-detail-discard')).not.toBeNull()
    expect(screen.queryByTestId('batch-detail-paid-line')).toBeNull()
    expect(screen.queryByTestId('batch-detail-discarded-line')).toBeNull()
    expect(screen.getByTestId('batch-employee-group-list')).not.toBeNull()
  })

  it('paid: shows the paid stamp line, no Mark-as-paid/Discard', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(paidBatch)
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    expect(screen.getByTestId('batch-detail-paid-line').textContent).toContain('acct@welld.ch')
    expect(screen.queryByTestId('batch-detail-mark-paid')).toBeNull()
    expect(screen.queryByTestId('batch-detail-discard')).toBeNull()
  })

  it('discarded: shows the discarded stamp line, no Mark-as-paid/Discard', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(discardedBatch)
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    expect(screen.getByTestId('batch-detail-discarded-line').textContent).toContain('acct@welld.ch')
    expect(screen.queryByTestId('batch-detail-mark-paid')).toBeNull()
    expect(screen.queryByTestId('batch-detail-discard')).toBeNull()
  })
})

describe('BatchDetailPage — PDF mint', () => {
  it('BatchPdfLink mints on click', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    vi.mocked(batchesApi.getPdfUrl).mockResolvedValue({ url: 'https://bucket.example/fresh.pdf', expiresAt: '…' })
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    fireEvent.click(screen.getByTestId('batch-pdf-link-batch-1'))
    await waitFor(() => expect(batchesApi.getPdfUrl).toHaveBeenCalledWith('batch-1'))
  })
})

describe('BatchDetailPage — resend email', () => {
  it('on a sent response, reloads and shows a success toast', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    vi.mocked(batchesApi.sendEmail).mockResolvedValue({ emailStatus: 'sent' })
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    fireEvent.click(screen.getByTestId('batch-detail-resend-email'))

    await waitFor(() => expect(screen.getByTestId('toast-banner')).not.toBeNull())
    expect(screen.getByTestId('toast-banner').getAttribute('role')).toBe('status')
    expect(batchesApi.get).toHaveBeenCalledTimes(2)
  })

  it('on a failed response, shows an error toast', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    vi.mocked(batchesApi.sendEmail).mockResolvedValue({ emailStatus: 'failed' })
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    fireEvent.click(screen.getByTestId('batch-detail-resend-email'))

    await waitFor(() => expect(screen.getByTestId('toast-banner')).not.toBeNull())
    expect(screen.getByTestId('toast-banner').getAttribute('role')).toBe('alert')
  })
})

describe('BatchDetailPage — mark as paid (design.md F4)', () => {
  it('opens MarkPaidDialog, confirming (checkbox checked) updates the batch in place with an aria-live confirmation', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    vi.mocked(batchesApi.markPaid).mockResolvedValue(paidBatch)
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    fireEvent.click(screen.getByTestId('batch-detail-mark-paid'))
    expect(screen.getByTestId('mark-paid-dialog-modal')).not.toBeNull()

    fireEvent.click(screen.getByTestId('mark-paid-dialog-checkbox'))
    fireEvent.click(screen.getByTestId('mark-paid-dialog-confirm'))

    await waitFor(() => expect(screen.getByTestId('batch-detail-paid-line')).not.toBeNull())
    expect(screen.queryByTestId('mark-paid-dialog-modal')).toBeNull()
    expect(screen.getByTestId('batch-detail-live-message').textContent).toMatch(/marked as paid/i)
  })

  it('on a 409 (already resolved), shows GuardrailDialog and reloads to the real state', async () => {
    vi.mocked(batchesApi.get).mockResolvedValueOnce(compiledBatch).mockResolvedValueOnce(paidBatch)
    vi.mocked(batchesApi.markPaid).mockRejectedValue(new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 }))
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    fireEvent.click(screen.getByTestId('batch-detail-mark-paid'))
    fireEvent.click(screen.getByTestId('mark-paid-dialog-checkbox'))
    fireEvent.click(screen.getByTestId('mark-paid-dialog-confirm'))

    await waitFor(() => expect(screen.getByTestId('guardrail-dialog')).not.toBeNull())
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))

    await waitFor(() => expect(screen.getByTestId('batch-detail-paid-line')).not.toBeNull())
  })
})

describe('BatchDetailPage — discard (design.md F6)', () => {
  it('opens ConfirmDeleteModal (destructive), confirming updates the batch in place', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    vi.mocked(batchesApi.discard).mockResolvedValue(discardedBatch)
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    fireEvent.click(screen.getByTestId('batch-detail-discard'))
    expect(screen.getByTestId('batch-discard-confirm-modal')).not.toBeNull()

    fireEvent.click(screen.getByTestId('batch-discard-confirm-confirm'))

    await waitFor(() => expect(screen.getByTestId('batch-detail-discarded-line')).not.toBeNull())
    expect(screen.getByTestId('batch-detail-live-message').textContent).toMatch(/discarded/i)
  })

  it('on a 409 (already resolved), shows GuardrailDialog and reloads', async () => {
    vi.mocked(batchesApi.get).mockResolvedValueOnce(compiledBatch).mockResolvedValueOnce(paidBatch)
    vi.mocked(batchesApi.discard).mockRejectedValue(new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 }))
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    fireEvent.click(screen.getByTestId('batch-detail-discard'))
    fireEvent.click(screen.getByTestId('batch-discard-confirm-confirm'))

    await waitFor(() => expect(screen.getByTestId('guardrail-dialog')).not.toBeNull())
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))

    await waitFor(() => expect(screen.getByTestId('batch-detail-paid-line')).not.toBeNull())
  })
})

describe('BatchDetailPage — post-compile confirmation (design.md F1 step 6)', () => {
  it('announces the one-shot confirmation search param and strips it from the URL', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    renderBatchDetailPage('batch-1', '?confirmation=Batch%20compiled%20%E2%80%94%202%20requests')

    await waitFor(() =>
      expect(screen.getByTestId('batch-detail-live-message').textContent).toBe('Batch compiled — 2 requests'),
    )
    await waitFor(() => expect(window.location.search).toBe(''))
  })
})
