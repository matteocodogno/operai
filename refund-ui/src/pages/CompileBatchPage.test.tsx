/**
 * @vitest-environment jsdom
 *
 * Component tests for CompileBatchPage — Screen B2 (T11, specs/008-refund-
 * monthly-processing/tasks.md). `../lib/batchesApi` is mocked at the module
 * level (keeping the real `ApiError` from `../lib/refundApi`). Rendered
 * inside a real, minimal router (mirrors ReviewDetailPage.test.tsx/
 * RequestDetailPage.test.tsx) so `useNavigate`/`Link` and the post-compile
 * `confirmation` search param resolve exactly as they do in the app.
 *
 * Covers: L/Err/PD, the empty-set refusal (AC-1.4, Compile disabled), the
 * populated preview (subtotals + employee groups), the compile-confirm
 * dialog (positive tone), success → navigate to the batch detail with a
 * `confirmation` search param, and the 422 stale-candidates race (inline
 * dialog error + a fresh preview reload on cancel).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import CompileBatchPage from './CompileBatchPage'
import type { CandidatePreview, BatchDetail } from '../lib/batchesApi'

vi.mock('../lib/batchesApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/batchesApi')>()
  return { ...original, listCandidates: vi.fn(), compile: vi.fn() }
})

import * as batchesApi from '../lib/batchesApi'
import { ApiError } from '../lib/refundApi'

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

function renderCompileBatchPage() {
  window.history.pushState(null, '', '/batches/new')
  const rootRoute = createRootRoute()
  const batchesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches', component: () => null })
  const compileBatchRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches/new', component: CompileBatchPage })
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

const emptyPreview: CandidatePreview = {
  cutoff: '2026-07-19T00:00:00.000Z',
  requestCount: 0,
  subtotals: [],
  employees: [],
}

const populatedPreview: CandidatePreview = {
  cutoff: '2026-07-19T00:00:00.000Z',
  requestCount: 2,
  subtotals: [{ currency: 'EUR', approvedCents: 5000 }],
  employees: [
    {
      owner: { userId: 'u1', email: 'alice@welld.ch', name: 'Alice' },
      requestIds: ['req-1', 'req-2'],
      subtotals: [{ currency: 'EUR', approvedCents: 5000 }],
    },
  ],
}

const compiledBatch: BatchDetail = {
  id: 'batch-1',
  cutoff: '2026-07-19T00:00:00.000Z',
  status: 'compiled',
  requestCount: 2,
  createdBy: { userId: 'acct-1', email: 'acct@welld.ch' },
  createdAt: '2026-07-19T00:00:00.000Z',
  subtotals: [{ currency: 'EUR', approvedCents: 5000 }],
  employees: [],
  email: { status: null, lastAttemptAt: null },
  paidAt: null,
  paidBy: null,
  discardedAt: null,
  discardedBy: null,
  pdf: { url: 'https://bucket.example/compiled.pdf', expiresAt: '2026-07-19T00:01:00.000Z' },
}

describe('CompileBatchPage — loading / error / PD', () => {
  it('shows SkeletonListRows while the candidate preview is loading', async () => {
    vi.mocked(batchesApi.listCandidates).mockReturnValue(pendingPromise())
    renderCompileBatchPage()
    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('shows ErrorBanner + Retry on a non-403 failure, and Retry re-fetches', async () => {
    vi.mocked(batchesApi.listCandidates)
      .mockRejectedValueOnce(new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }))
      .mockResolvedValueOnce(populatedPreview)
    renderCompileBatchPage()

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await waitFor(() => expect(screen.getByTestId('compile-batch-preview')).not.toBeNull())
    expect(batchesApi.listCandidates).toHaveBeenCalledTimes(2)
  })

  it('shows PermissionDenied with no Retry when request:review is entirely absent (AC-1.8)', async () => {
    vi.mocked(batchesApi.listCandidates).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }),
    )
    renderCompileBatchPage()

    await waitFor(() => expect(screen.getByTestId('permission-denied')).not.toBeNull())
    expect(screen.queryByTestId('compile-batch-cutoff-input')).toBeNull()
    expect(screen.queryByTestId('error-banner-retry')).toBeNull()
  })
})

describe('CompileBatchPage — empty candidate set (AC-1.4)', () => {
  it('shows the refusal message and disables Compile, without calling compile', async () => {
    vi.mocked(batchesApi.listCandidates).mockResolvedValue(emptyPreview)
    renderCompileBatchPage()

    await waitFor(() => expect(screen.getByTestId('compile-batch-empty-state')).not.toBeNull())
    expect(screen.getByTestId('compile-batch-empty-state').textContent).toMatch(/no approved, unbatched requests/i)
    expect(screen.getByTestId('compile-batch-compile-button')).toHaveProperty('disabled', true)
    expect(batchesApi.compile).not.toHaveBeenCalled()
  })
})

describe('CompileBatchPage — populated preview', () => {
  it('renders the overall subtotals + per-employee groups, and enables Compile', async () => {
    vi.mocked(batchesApi.listCandidates).mockResolvedValue(populatedPreview)
    renderCompileBatchPage()

    await waitFor(() => expect(screen.getByTestId('compile-batch-preview')).not.toBeNull())
    // The overall panel + the per-employee group's own panel both render this testid.
    expect(screen.getAllByTestId('batch-subtotals-panel').length).toBeGreaterThan(0)
    expect(screen.getByTestId('batch-employee-group-list')).not.toBeNull()
    expect(screen.getByTestId('compile-batch-compile-button')).toHaveProperty('disabled', false)
  })

  it('re-fetches with a new cutoff when Preview is clicked', async () => {
    vi.mocked(batchesApi.listCandidates).mockResolvedValue(populatedPreview)
    renderCompileBatchPage()
    await waitFor(() => expect(screen.getByTestId('compile-batch-preview')).not.toBeNull())

    fireEvent.change(screen.getByTestId('compile-batch-cutoff-input'), { target: { value: '2026-07-01T09:00' } })
    fireEvent.click(screen.getByTestId('compile-batch-preview-button'))

    await waitFor(() => expect(batchesApi.listCandidates).toHaveBeenCalledTimes(2))
    const secondCallCutoff = vi.mocked(batchesApi.listCandidates).mock.calls[1]?.[0]
    expect(secondCallCutoff).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('CompileBatchPage — compile confirm', () => {
  it('opens a positive-tone confirm dialog, and confirming compiles + navigates to the batch detail with a confirmation', async () => {
    vi.mocked(batchesApi.listCandidates).mockResolvedValue(populatedPreview)
    vi.mocked(batchesApi.compile).mockResolvedValue(compiledBatch)
    renderCompileBatchPage()
    await waitFor(() => expect(screen.getByTestId('compile-batch-compile-button')).toHaveProperty('disabled', false))

    // The frozen cutoff sent to compile() is whatever cutoff produced the
    // on-screen preview (design.md's WYSIWYG rule) — not the mocked
    // response's own `cutoff` field, which the real server would echo back
    // but this test double does not need to.
    const previewedCutoff = vi.mocked(batchesApi.listCandidates).mock.calls[0]?.[0]

    fireEvent.click(screen.getByTestId('compile-batch-compile-button'))
    expect(screen.getByTestId('compile-batch-confirm-modal')).not.toBeNull()

    fireEvent.click(screen.getByTestId('compile-batch-confirm-confirm'))

    await waitFor(() => expect(batchesApi.compile).toHaveBeenCalledWith(previewedCutoff))
    await waitFor(() => expect(window.location.pathname).toBe('/batches/batch-1'))
    expect(window.location.search).toContain('confirmation')
  })

  it('on a 422 (stale candidate set), keeps the dialog open with an inline error, and Cancel re-runs the preview', async () => {
    vi.mocked(batchesApi.listCandidates).mockResolvedValue(populatedPreview)
    vi.mocked(batchesApi.compile).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'Changed.' }),
    )
    renderCompileBatchPage()
    await waitFor(() => expect(screen.getByTestId('compile-batch-compile-button')).toHaveProperty('disabled', false))

    fireEvent.click(screen.getByTestId('compile-batch-compile-button'))
    fireEvent.click(screen.getByTestId('compile-batch-confirm-confirm'))

    await waitFor(() => expect(screen.getByTestId('compile-batch-confirm-error')).not.toBeNull())
    expect(screen.getByTestId('compile-batch-confirm-error').textContent).toMatch(/changed since you last previewed/i)
    // Still on B2 — no navigation happened.
    expect(window.location.pathname).toBe('/batches/new')

    fireEvent.click(screen.getByTestId('compile-batch-confirm-cancel'))
    await waitFor(() => expect(batchesApi.listCandidates).toHaveBeenCalledTimes(2))
  })
})
