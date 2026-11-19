/**
 * @vitest-environment jsdom
 *
 * Component tests for BatchDetailPage — Screen B3 (T12, specs/20260719-refund-
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expectNoAxeViolations } from '../test-support/axe'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import BatchDetailPage from './BatchDetailPage'
import type { BatchDetail } from '../lib/batchesApi'
import { strings } from '../strings'

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

vi.mock('../lib/accountingExportApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/accountingExportApi')>()
  return { ...original, getAccountingExport: vi.fn(), downloadAccountingFile: vi.fn() }
})

import * as batchesApi from '../lib/batchesApi'
import * as exportApi from '../lib/accountingExportApi'
import type { AccountingExportSummary } from '../lib/accountingExportApi'
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

const exportSummary = (overrides: Partial<AccountingExportSummary> = {}): AccountingExportSummary => ({
  batchId: 'batch-1',
  batchStatus: 'compiled',
  exportable: true,
  rowCount: 4,
  excludedLineCount: 0,
  blockers: { missingRates: [], unclassifiedLines: [], unnumberedLines: [], accountingUnavailable: false },
  ratePendingLineCount: 0,
  fetchAttempted: false,
  viewer: { canOpenAccountingRates: true },
  ...overrides,
})

beforeEach(() => {
  vi.mocked(exportApi.getAccountingExport).mockReset()
  vi.mocked(exportApi.getAccountingExport).mockResolvedValue(exportSummary())
})

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
  paidBy: { email: 'acct@welld.ch' },
}

const discardedBatch: BatchDetail = {
  ...compiledBatch,
  status: 'discarded',
  discardedAt: '2026-07-20T09:00:00.000Z',
  discardedBy: { email: 'acct@welld.ch' },
}

describe('BatchDetailPage — loading / error / not found / PD', () => {
  it('shows SkeletonListRows while loading', async () => {
    vi.mocked(batchesApi.get).mockReturnValue(pendingPromise())
    renderBatchDetailPage()
    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('shows ErrorBanner + Retry on a non-404/403 failure', async () => {
    vi.mocked(batchesApi.get)
      .mockRejectedValueOnce(
        new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }),
      )
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

  it('meta row: labels the batch id as the batch reference and names who generated it', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    const reference = screen.getByTestId('batch-detail-reference')
    expect(reference.textContent).toContain('Batch reference')
    expect(reference.textContent).toContain(compiledBatch.id)
    expect(reference.getAttribute('title')).toBeTruthy()
    expect(screen.getByTestId('batch-detail-generated').textContent).toContain(compiledBatch.createdBy.email)
  })

  it('paid: shows the paid stamp line, no Mark-as-paid/Discard', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(paidBatch)
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    const paidLine = screen.getByTestId('batch-detail-paid-line').textContent
    expect(paidLine).toContain('acct@welld.ch')
    expect(paidLine).not.toContain('[object Object]')
    expect(screen.queryByTestId('batch-detail-mark-paid')).toBeNull()
    expect(screen.queryByTestId('batch-detail-discard')).toBeNull()
  })

  it('discarded: shows the discarded stamp line, no Mark-as-paid/Discard', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(discardedBatch)
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    const discardedLine = screen.getByTestId('batch-detail-discarded-line').textContent
    expect(discardedLine).toContain('acct@welld.ch')
    expect(discardedLine).not.toContain('[object Object]')
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

  it('pdf: null (OWASP A04 fix round — refund-api degraded a render/store failure) renders a "PDF temporarily unavailable" state, not a broken download control', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue({ ...compiledBatch, pdf: null })
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    expect(screen.getByTestId('batch-detail-pdf-unavailable').textContent).toBe('PDF temporarily unavailable')
    expect(screen.queryByTestId('batch-pdf-link-batch-1')).toBeNull()
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

describe('BatchDetailPage — delivery status display (specs/20260722-refund-settings AC-2.2)', () => {
  it('emailStatus:"blocked_unconfigured" renders the distinguishable, actionable blocked message', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue({
      ...compiledBatch,
      email: { status: 'blocked_unconfigured', lastAttemptAt: '2026-07-21T00:01:00.000Z' },
    })
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    expect(screen.getByTestId('batch-detail-email-status').textContent).toBe(
      strings.pages.batchDetail.email.blocked_unconfigured,
    )
    expect(screen.getByTestId('batch-detail-email-status').textContent).not.toBe(strings.pages.batchDetail.email.failed)
  })

  it('emailStatus:"failed" still renders its own, distinct ordinary-failure copy', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue({
      ...compiledBatch,
      email: { status: 'failed', lastAttemptAt: '2026-07-21T00:01:00.000Z' },
    })
    renderBatchDetailPage()

    await waitFor(() => expect(screen.getByTestId('batch-detail-loaded')).not.toBeNull())
    expect(screen.getByTestId('batch-detail-email-status').textContent).toBe(strings.pages.batchDetail.email.failed)
    expect(screen.getByTestId('batch-detail-email-status').textContent).not.toBe(
      strings.pages.batchDetail.email.blocked_unconfigured,
    )
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
    vi.mocked(batchesApi.markPaid).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 }),
    )
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
    vi.mocked(batchesApi.discard).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 }),
    )
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
    // INC-19: shown too, not only announced — and not announced a second time.
    const banner = screen.getByTestId('batch-detail-confirmation')
    expect(banner.textContent).toContain('Batch compiled — 2 requests')
    expect(banner.getAttribute('aria-live')).toBe('off')
  })
})

describe('BatchDetailPage — accounting export card (T30, specs/20261118-refund-accounting-export, F9; AC-6.1, AC-6.5, AC-6.9)', () => {
  it.each([
    ['compiled', compiledBatch],
    ['paid', paidBatch],
  ])('a %s batch shows the card under the summary and above the employee groups', async (_status, batch) => {
    vi.mocked(batchesApi.get).mockResolvedValue(batch)
    renderBatchDetailPage()

    const card = await screen.findByTestId('accounting-export-card')
    await screen.findByTestId('accounting-export-ready')
    const groups = screen.getByTestId('batch-employee-group-list')
    const summary = screen.getByRole('heading', { name: 'Summary' })
    expect(summary.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(card.compareDocumentPosition(groups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(exportApi.getAccountingExport).toHaveBeenCalledWith('batch-1')
  })

  it('a discarded batch has no card, and the export is never asked (AC-6.9)', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(discardedBatch)
    renderBatchDetailPage()

    await screen.findByTestId('batch-detail-loaded')
    expect(screen.queryByTestId('accounting-export-card')).toBeNull()
    expect(exportApi.getAccountingExport).not.toHaveBeenCalled()
  })

  it('the card does not hold the page back: the batch shows while the check is still running', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    vi.mocked(exportApi.getAccountingExport).mockReturnValue(pendingPromise())
    renderBatchDetailPage()

    expect(await screen.findByTestId('batch-detail-mark-paid')).not.toBeNull()
    expect(screen.getByTestId('batch-employee-group-list')).not.toBeNull()
    expect(screen.getByTestId('accounting-export-skeleton')).not.toBeNull()
  })

  describe('T37, specs/20261119-accounting (AC-5.6, AC-6.6, AC-6.7, AC-7.3)', () => {
    const missingMarch = (overrides: Partial<AccountingExportSummary> = {}) =>
      exportSummary({
        exportable: false,
        blockers: {
          missingRates: [{ currency: 'EUR', month: '2026-03', reason: 'not_published' }],
          unclassifiedLines: [],
          unnumberedLines: [],
          accountingUnavailable: false,
        },
        ...overrides,
      })

    it('Accounting cannot be read: its own heading, not a missing rate, and Mark as paid and Discard still work', async () => {
      vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
      vi.mocked(exportApi.getAccountingExport).mockResolvedValue(
        exportSummary({
          exportable: false,
          ratePendingLineCount: 2,
          blockers: { missingRates: [], unclassifiedLines: [], unnumberedLines: [], accountingUnavailable: true },
        }),
      )
      renderBatchDetailPage()

      await screen.findByTestId('accounting-export-blocked')
      expect(screen.getByRole('heading', { name: 'Accounting cannot be read' })).not.toBeNull()
      expect(screen.queryByTestId('accounting-export-missing-rates')).toBeNull()
      expect((screen.getByTestId('batch-detail-mark-paid') as HTMLButtonElement).disabled).toBe(false)
      expect((screen.getByTestId('batch-detail-discard') as HTMLButtonElement).disabled).toBe(false)
    })

    it('a not-published rate says so, and links to the month in Accounting only with the viewer flag', async () => {
      vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
      vi.mocked(exportApi.getAccountingExport).mockResolvedValue(missingMarch())
      renderBatchDetailPage()

      const list = await screen.findByTestId('accounting-export-missing-rates')
      expect(list.textContent).toContain('EUR · March 2026 — not published yet')
      expect(within(list).getByRole('link').getAttribute('href')).toBe(
        '/accounting/exchange-rates?entity=welld_ch&month=2026-03',
      )
      cleanup()

      vi.mocked(exportApi.getAccountingExport).mockResolvedValue(
        missingMarch({ viewer: { canOpenAccountingRates: false } }),
      )
      renderBatchDetailPage()
      const askList = await screen.findByTestId('accounting-export-missing-rates')
      expect(within(askList).queryByRole('link')).toBeNull()
      expect(askList.textContent).toContain('Ask an accounting manager to enter or fetch it.')
    })

    it('the pending sentence shows on a ready batch', async () => {
      vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
      vi.mocked(exportApi.getAccountingExport).mockResolvedValue(exportSummary({ ratePendingLineCount: 1 }))
      renderBatchDetailPage()
      expect((await screen.findByTestId('accounting-export-pending')).textContent).toBe(
        '1 line gets its exchange rate at this export.',
      )
    })
  })

  it('a blocked export leaves Mark as paid and Discard working (AC-6.5)', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    vi.mocked(batchesApi.markPaid).mockResolvedValue(paidBatch)
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(
      exportSummary({
        exportable: false,
        blockers: {
          missingRates: [{ currency: 'EUR', month: '2026-03', reason: null }],
          unclassifiedLines: [],
          unnumberedLines: [],
          accountingUnavailable: false,
        },
      }),
    )
    renderBatchDetailPage()

    await screen.findByTestId('accounting-export-blocked')
    expect((screen.getByTestId('batch-detail-mark-paid') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('batch-detail-discard') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('batch-detail-mark-paid'))
    fireEvent.click(await screen.findByTestId('mark-paid-dialog-checkbox'))
    fireEvent.click(screen.getByTestId('mark-paid-dialog-confirm'))
    await waitFor(() => expect(batchesApi.markPaid).toHaveBeenCalledWith('batch-1'))
  })

  it('a batch found discarded by the export removes the card and says so politely', async () => {
    vi.mocked(batchesApi.get).mockResolvedValueOnce(compiledBatch).mockResolvedValue(discardedBatch)
    vi.mocked(exportApi.getAccountingExport).mockRejectedValue(
      new ApiError({ type: 't', title: 'Conflict', status: 409, code: 'batch_discarded' }),
    )
    renderBatchDetailPage()

    await waitFor(() =>
      expect(screen.getByTestId('batch-detail-live-message').textContent).toBe(
        'This batch has been discarded; the export is no longer available.',
      ),
    )
    await waitFor(() => expect(screen.queryByTestId('accounting-export-card')).toBeNull())
    expect(screen.getByTestId('batch-detail-discarded-line')).not.toBeNull()
  })
})

// T44: automated axe checks (test-support/axe.ts) on the batch page with the accounting export card in each of its states.
describe('BatchDetailPage — accessibility (axe)', () => {
  const withReceipts: BatchDetail = {
    ...compiledBatch,
    employees: [
      {
        ...compiledBatch.employees[0],
        requests: [{ ...compiledBatch.employees[0].requests[0], receiptNumbers: ['MC26/014', 'MC26/015'] }],
      },
    ],
  }
  const blocked = exportSummary({
    exportable: false,
    rowCount: 0,
    blockers: {
      missingRates: [{ currency: 'EUR', month: '2026-03', reason: 'not_published' }],
      accountingUnavailable: false,
      unclassifiedLines: [
        {
          lineId: 'l1',
          requestId: 'req-1',
          date: '2026-03-19',
          type: 'travel_train',
          employee: 'Alice',
          receiptNumber: 'MC26/014',
          missing: ['account'],
        },
      ],
      unnumberedLines: [],
    },
  })

  it.each([
    [
      'compiled, export ready, receipt numbers under the rows',
      withReceipts,
      exportSummary(),
      'accounting-export-ready',
    ],
    [
      'compiled, export ready, no receipt numbers',
      compiledBatch,
      exportSummary({ excludedLineCount: 2 }),
      'accounting-export-ready',
    ],
    ['compiled, export blocked', withReceipts, blocked, 'accounting-export-blocked'],
    ['paid, export ready', paidBatch, exportSummary({ batchStatus: 'paid' }), 'accounting-export-ready'],
    [
      'compiled, export ready with lines that get their rate at the export',
      withReceipts,
      exportSummary({ ratePendingLineCount: 2 }),
      'accounting-export-pending',
    ],
    [
      'compiled, Accounting cannot be read',
      withReceipts,
      exportSummary({
        exportable: false,
        ratePendingLineCount: 2,
        blockers: { missingRates: [], unclassifiedLines: [], unnumberedLines: [], accountingUnavailable: true },
      }),
      'accounting-export-unavailable',
    ],
  ])('has no violations: %s', async (_name, batch, summary, settled) => {
    vi.mocked(batchesApi.get).mockResolvedValue(batch)
    vi.mocked(exportApi.getAccountingExport).mockResolvedValue(summary)
    renderBatchDetailPage()
    await screen.findByTestId(settled)
    await expectNoAxeViolations()
  })

  it('has no violations: the export card still loading, and a discarded batch (no card)', async () => {
    vi.mocked(batchesApi.get).mockResolvedValue(compiledBatch)
    vi.mocked(exportApi.getAccountingExport).mockReturnValue(pendingPromise())
    renderBatchDetailPage()
    await screen.findByTestId('accounting-export-skeleton')
    await expectNoAxeViolations()
    cleanup()

    vi.mocked(batchesApi.get).mockResolvedValue(discardedBatch)
    renderBatchDetailPage()
    await screen.findByTestId('batch-detail-discarded-line')
    await expectNoAxeViolations()
  })
})
