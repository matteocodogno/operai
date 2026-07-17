/**
 * @vitest-environment jsdom
 *
 * Component tests for RequestDetailPage — Screen R2 (T16,
 * specs/007-refund-service/tasks.md). `../lib/requestsApi` is mocked at the
 * module level (keeping the real `SubmitValidationApiError`/`ApiError`
 * classes via `importOriginal`). RequestDetailPage renders real `<Link>`s
 * and calls `useNavigate` (delete-request success), so — mirroring
 * admin-ui/src/pages/UsersPage.test.tsx — it's rendered inside a real,
 * minimal router (the `$id` param comes from the pushed URL, exactly as
 * `getRouteApi('/requests/$id').useParams()` resolves it in the app).
 *
 * Covers every status-driven variant plus L/Err/NF/G, the
 * submit-blocked-on-0-lines note, the 422 validation-summary jump behavior,
 * and MonthlyProcessingNote present only on `approved`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import RequestDetailPage from './RequestDetailPage'
import type { RefundRequestDetail } from '../lib/requestsApi'

vi.mock('../lib/requestsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/requestsApi')>()
  return {
    ...original,
    get: vi.fn(),
    addLine: vi.fn(),
    updateLine: vi.fn(),
    removeLine: vi.fn(),
    submit: vi.fn(),
    withdraw: vi.fn(),
    remove: vi.fn(),
  }
})

vi.mock('../lib/attachmentsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/attachmentsApi')>()
  return {
    ...original,
    uploadAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    getDownloadUrl: vi.fn(),
  }
})

import * as requestsApi from '../lib/requestsApi'
import { SubmitValidationApiError } from '../lib/requestsApi'
import * as attachmentsApi from '../lib/attachmentsApi'
import { ApiError } from '../lib/refundApi'

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

function renderRequestDetailPage(id = 'req-1') {
  window.history.pushState(null, '', `/requests/${id}`)
  const rootRoute = createRootRoute()
  const requestsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/requests', component: () => null })
  const newRequestRoute = createRoute({ getParentRoute: () => rootRoute, path: '/requests/new', component: () => null })
  const requestDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/requests/$id',
    component: RequestDetailPage,
  })
  const routeTree = rootRoute.addChildren([requestsRoute, newRequestRoute, requestDetailRoute])
  const router = createRouter({ routeTree })
  return render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.history.pushState(null, '', '/')
})

const baseRequest: RefundRequestDetail = {
  id: 'req-1',
  status: 'draft',
  owner: { userId: 'u1', email: 'a@welld.ch', name: 'A' },
  submittedAt: null,
  decidedAt: null,
  decidedBy: null,
  rejectionMotivation: null,
  lines: [],
  subtotals: [],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
}

const oneLine = {
  id: 'line-1',
  date: '2026-07-01',
  type: 'stationery' as const,
  motivo: 'Pens',
  entity: 'welld_it' as const,
  currency: 'EUR' as const,
  requestedAmountCents: 1000,
  km: null,
  approvedTotalCents: null,
  attachments: [],
}

describe('RequestDetailPage — loading / error / not found', () => {
  it('shows SkeletonListRows while loading', async () => {
    vi.mocked(requestsApi.get).mockReturnValue(pendingPromise())
    renderRequestDetailPage()
    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('shows ErrorBanner + Retry on a non-404 failure', async () => {
    vi.mocked(requestsApi.get)
      .mockRejectedValueOnce(new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }))
      .mockResolvedValueOnce(baseRequest)
    renderRequestDetailPage()

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await waitFor(() => expect(screen.getByTestId('request-detail-draft')).not.toBeNull())
  })

  it('shows a neutral not-found state on 404 (never "permission denied")', async () => {
    vi.mocked(requestsApi.get).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Not Found', status: 404 }),
    )
    renderRequestDetailPage()

    await waitFor(() => expect(screen.getByTestId('request-detail-not-found')).not.toBeNull())
    expect(screen.getByTestId('request-detail-not-found').textContent).not.toMatch(/permission/i)
    expect(screen.getByTestId('request-detail-not-found-back').getAttribute('href')).toBe('/requests')
  })
})

describe('RequestDetailPage — draft variant', () => {
  it('adds a line via the composer and re-fetches the request', async () => {
    vi.mocked(requestsApi.get).mockResolvedValueOnce(baseRequest).mockResolvedValueOnce({ ...baseRequest, lines: [oneLine] })
    vi.mocked(requestsApi.addLine).mockResolvedValue(oneLine)

    renderRequestDetailPage()
    await waitFor(() => expect(screen.getByTestId('request-detail-lines-empty')).not.toBeNull())

    fireEvent.change(screen.getByTestId('composer-date'), { target: { value: '2026-07-01' } })
    fireEvent.change(screen.getByTestId('composer-type'), { target: { value: 'stationery' } })
    fireEvent.change(screen.getByTestId('composer-motivo'), { target: { value: 'Pens' } })
    fireEvent.change(screen.getByTestId('composer-amount'), { target: { value: '10.00' } })
    fireEvent.change(screen.getByTestId('composer-entity'), { target: { value: 'welld_it' } })
    fireEvent.change(screen.getByTestId('composer-currency'), { target: { value: 'EUR' } })
    fireEvent.click(screen.getByTestId('composer-add-button'))

    await waitFor(() => expect(requestsApi.addLine).toHaveBeenCalledWith('req-1', expect.objectContaining({ motivo: 'Pens' })))
    await waitFor(() => expect(screen.getByTestId('expense-line-row-line-1')).not.toBeNull())
  })

  it('disables Submit and shows the blocked note at zero lines', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderRequestDetailPage()

    await waitFor(() => expect(screen.getByTestId('request-detail-submit')).not.toBeNull())
    expect(screen.getByTestId('request-detail-submit')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('request-detail-submit-blocked-note')).not.toBeNull()
  })

  it('submits successfully, flips to the submitted (RO) variant, and announces + focuses the heading', async () => {
    const withLine = { ...baseRequest, lines: [oneLine] }
    const submitted = { ...withLine, status: 'submitted' as const }
    vi.mocked(requestsApi.get).mockResolvedValue(withLine)
    vi.mocked(requestsApi.submit).mockResolvedValue(submitted)

    renderRequestDetailPage()
    await waitFor(() => expect(screen.getByTestId('request-detail-submit')).toHaveProperty('disabled', false))

    fireEvent.click(screen.getByTestId('request-detail-submit'))

    await waitFor(() => expect(screen.getByTestId('request-detail-submitted')).not.toBeNull())
    expect(screen.getByTestId('request-detail-live-message').textContent).toContain('Submitted')
    expect(document.activeElement?.id).toBe('refund-request-detail-heading')
  })

  it('on a 422, renders SubmitValidationSummary and jumping focuses the offending row, keeping the draft editable', async () => {
    const withLine = { ...baseRequest, lines: [oneLine] }
    vi.mocked(requestsApi.get).mockResolvedValue(withLine)
    vi.mocked(requestsApi.submit).mockRejectedValue(
      new SubmitValidationApiError({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Some lines are incomplete',
        offendingLineIds: ['line-1'],
      }),
    )

    renderRequestDetailPage()
    await waitFor(() => expect(screen.getByTestId('request-detail-submit')).toHaveProperty('disabled', false))

    fireEvent.click(screen.getByTestId('request-detail-submit'))

    await waitFor(() => expect(screen.getByTestId('submit-validation-summary')).not.toBeNull())
    // Draft stays fully editable — nothing lost.
    expect(screen.getByTestId('request-detail-draft')).not.toBeNull()
    expect(screen.getByTestId('expense-line-row-line-1')).not.toBeNull()

    fireEvent.click(screen.getByTestId('submit-validation-summary-jump-line-1'))
    expect(document.activeElement).toBe(screen.getByTestId('expense-line-row-line-1'))
  })

  it('deletes the request via ConfirmDeleteModal and navigates back to /requests', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    vi.mocked(requestsApi.remove).mockResolvedValue(undefined)

    renderRequestDetailPage()
    await waitFor(() => expect(screen.getByTestId('request-detail-delete-request')).not.toBeNull())

    fireEvent.click(screen.getByTestId('request-detail-delete-request'))
    expect(screen.getByTestId('confirm-delete-modal')).not.toBeNull()

    fireEvent.click(screen.getByTestId('confirm-delete-confirm'))

    await waitFor(() => expect(requestsApi.remove).toHaveBeenCalledWith('req-1'))
    await waitFor(() => expect(window.location.pathname).toBe('/requests'))
  })
})

describe('RequestDetailPage — submitted variant', () => {
  const submittedRequest = { ...baseRequest, status: 'submitted' as const, lines: [oneLine] }

  it('renders no editing controls, only Withdraw', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(submittedRequest)
    renderRequestDetailPage()

    await waitFor(() => expect(screen.getByTestId('request-detail-submitted')).not.toBeNull())
    expect(screen.queryByTestId('composer-add-button')).toBeNull()
    expect(screen.queryByTestId('row-line-1-motivo')).toBeNull()
    expect(screen.getByTestId('request-detail-withdraw')).not.toBeNull()
  })

  it('withdraw success flips back to the draft (editable) variant with a confirmation', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(submittedRequest)
    vi.mocked(requestsApi.withdraw).mockResolvedValue({ ...submittedRequest, status: 'draft' })

    renderRequestDetailPage()
    await waitFor(() => expect(screen.getByTestId('request-detail-withdraw')).not.toBeNull())

    fireEvent.click(screen.getByTestId('request-detail-withdraw'))

    await waitFor(() => expect(screen.getByTestId('request-detail-draft')).not.toBeNull())
    expect(screen.getByTestId('request-detail-live-message').textContent).toContain('Withdrawn')
  })

  it('withdraw 409 surfaces GuardrailDialog and reloads the (now decided) record', async () => {
    vi.mocked(requestsApi.get)
      .mockResolvedValueOnce(submittedRequest)
      .mockResolvedValueOnce({ ...submittedRequest, status: 'approved', decidedAt: '2026-07-05T00:00:00.000Z' })
    vi.mocked(requestsApi.withdraw).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Already decided.' }),
    )

    renderRequestDetailPage()
    await waitFor(() => expect(screen.getByTestId('request-detail-withdraw')).not.toBeNull())

    fireEvent.click(screen.getByTestId('request-detail-withdraw'))

    await waitFor(() => expect(screen.getByTestId('guardrail-dialog')).not.toBeNull())
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))

    await waitFor(() => expect(screen.getByTestId('request-detail-approved')).not.toBeNull())
  })
})

describe('RequestDetailPage — approved variant', () => {
  it('shows requested + approved per line, both subtotals, and MonthlyProcessingNote', async () => {
    const approvedRequest = {
      ...baseRequest,
      status: 'approved' as const,
      lines: [{ ...oneLine, approvedTotalCents: 800 }],
      subtotals: [{ currency: 'EUR' as const, requestedCents: 1000, approvedCents: 800 }],
      decidedAt: '2026-07-05T00:00:00.000Z',
      decidedBy: { email: 'acct@welld.ch' },
    }
    vi.mocked(requestsApi.get).mockResolvedValue(approvedRequest)

    renderRequestDetailPage()

    await waitFor(() => expect(screen.getByTestId('request-detail-approved')).not.toBeNull())
    expect(screen.getByTestId('monthly-processing-note')).not.toBeNull()
    expect(screen.getByTestId('expense-line-row-line-1').textContent).toContain('8,00 €')
    expect(screen.getByTestId('subtotals-panel-card-EUR').textContent).toContain('8,00 €')
  })
})

describe('RequestDetailPage — rejected variant', () => {
  it('shows the rejection motivation and a "+ New request" link, and no MonthlyProcessingNote', async () => {
    const rejectedRequest = {
      ...baseRequest,
      status: 'rejected' as const,
      lines: [oneLine],
      rejectionMotivation: 'Missing receipt.',
      decidedAt: '2026-07-05T00:00:00.000Z',
      decidedBy: { email: 'acct@welld.ch' },
    }
    vi.mocked(requestsApi.get).mockResolvedValue(rejectedRequest)

    renderRequestDetailPage()

    await waitFor(() => expect(screen.getByTestId('request-detail-rejected')).not.toBeNull())
    expect(screen.getByTestId('request-detail-rejection-motivation').textContent).toContain('Missing receipt.')
    expect(screen.getByTestId('request-detail-new-request-link').getAttribute('href')).toBe('/requests/new')
    expect(screen.queryByTestId('monthly-processing-note')).toBeNull()
  })
})

describe('RequestDetailPage — attachment wiring (T17)', () => {
  it('draft mode: uploading a file calls attachmentsApi.uploadAttachment scoped to the request+line, then reloads', async () => {
    const withLine = { ...baseRequest, lines: [oneLine] }
    vi.mocked(requestsApi.get).mockResolvedValue(withLine)
    const stored = { id: 'a1', fileName: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 1024 }
    vi.mocked(attachmentsApi.uploadAttachment).mockResolvedValue({ ...stored, uploadStatus: 'stored' as const })

    renderRequestDetailPage()
    await waitFor(() => expect(screen.getByTestId('attachment-input-line-1')).not.toBeNull())

    const file = new File([new Uint8Array(10)], 'receipt.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByTestId('attachment-input-line-1'), { target: { files: [file] } })

    await waitFor(() => expect(attachmentsApi.uploadAttachment).toHaveBeenCalledWith('req-1', 'line-1', file))
    await waitFor(() => expect(requestsApi.get).toHaveBeenCalledTimes(2))
  })

  it('draft mode: removing a persisted attachment calls attachmentsApi.removeAttachment, 409 surfaces GuardrailDialog', async () => {
    const withAttachment = { ...baseRequest, lines: [{ ...oneLine, attachments: [{ id: 'a1', fileName: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 1024 }] }] }
    vi.mocked(requestsApi.get).mockResolvedValue(withAttachment)
    vi.mocked(attachmentsApi.removeAttachment).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Not a draft.' }),
    )

    renderRequestDetailPage()
    await waitFor(() => expect(screen.getByTestId('attachment-remove-a1')).not.toBeNull())

    fireEvent.click(screen.getByTestId('attachment-remove-a1'))

    await waitFor(() => expect(attachmentsApi.removeAttachment).toHaveBeenCalledWith('req-1', 'line-1', 'a1'))
    await waitFor(() => expect(screen.getByTestId('guardrail-dialog')).not.toBeNull())
  })

  it('submitted variant: attachments render download-only, scoped to the request+line', async () => {
    const submittedWithAttachment = {
      ...baseRequest,
      status: 'submitted' as const,
      lines: [{ ...oneLine, attachments: [{ id: 'a1', fileName: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 1024 }] }],
    }
    vi.mocked(requestsApi.get).mockResolvedValue(submittedWithAttachment)
    vi.mocked(attachmentsApi.getDownloadUrl).mockResolvedValue({ url: 'https://signed.example/a1', expiresAt: '2026-07-16T00:01:00.000Z' })

    renderRequestDetailPage()
    await waitFor(() => expect(screen.getByTestId('attachment-download-a1')).not.toBeNull())
    expect(screen.queryByTestId('attachment-remove-a1')).toBeNull()

    fireEvent.click(screen.getByTestId('attachment-download-a1'))
    await waitFor(() => expect(attachmentsApi.getDownloadUrl).toHaveBeenCalledWith('req-1', 'line-1', 'a1'))
  })
})
