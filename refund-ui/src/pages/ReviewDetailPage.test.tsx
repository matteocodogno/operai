/**
 * @vitest-environment jsdom
 *
 * Component tests for ReviewDetailPage — Screen A2 (T18, specs/007-refund-
 * service/tasks.md). `../lib/requestsApi`, `../lib/reviewApi`, and
 * `../lib/attachmentsApi` are mocked at the module level (keeping the real
 * `ApiError`). Rendered inside a real, minimal router (mirrors
 * RequestDetailPage.test.tsx) so `useNavigate`/`Link`/the `/review` search
 * param round-trip resolve exactly as they do in the app.
 *
 * Note on PD: design.md gives Screen A2 only L/Err/NF/G states — no PD.
 * `GET /requests/:id` 404s for an out-of-scope/nonexistent request even for
 * accounting (plan.md's denial table: "Non-owner-non-accounting on any
 * /requests/:id → 404"); the capability-absent 403 only exists on
 * `GET /review/requests` (Screen A1), covered by ReviewQueuePage.test.tsx's
 * "no request:review at all" test.
 *
 * Covers: L/Err/NF, the decidable `submitted` render (full RO lines +
 * approved-total inputs), the approve/reject flows (including the
 * return-to-queue confirmation search param and 409 → GuardrailDialog), and
 * the decided (approved/rejected) read-only variant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import type { Permission, PermissionsResult, ShellSessionState } from 'shell/session'
import ReviewDetailPage from './ReviewDetailPage'
import type { RefundRequestDetail } from '../lib/requestsApi'

vi.mock('../lib/requestsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/requestsApi')>()
  return { ...original, get: vi.fn() }
})

vi.mock('../lib/reviewApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/reviewApi')>()
  return { ...original, setApprovedTotal: vi.fn(), approve: vi.fn(), reject: vi.fn() }
})

vi.mock('../lib/attachmentsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/attachmentsApi')>()
  return { ...original, getDownloadUrl: vi.fn() }
})

// specs/010-self-approval-control — `useSession`/`usePermissions` (shell/session)
// ARE mocked here, deliberately (mirrors RefundShell.test.tsx's own rationale):
// they're the two dependencies the passive Approve-disable check adds.
// Defaults (`beforeEach`) return no signed-in identity and no permissions at
// all, so every PRE-EXISTING test in this file keeps observing an always-
// enabled Approve button exactly as before — `isOwner` is false whenever
// `currentUserId` is undefined, regardless of what `usePermissions` returns.
// The "self-approval control" describe block below overrides both mocks per
// test to exercise the disable/enable/403-mapping behavior itself.
const { useSessionMock, usePermissionsMock } = vi.hoisted(() => ({
  useSessionMock: vi.fn<() => ShellSessionState>(),
  usePermissionsMock: vi.fn<() => PermissionsResult>(),
}))
vi.mock('shell/session', () => ({
  useSession: () => useSessionMock(),
  usePermissions: () => usePermissionsMock(),
}))

import * as requestsApi from '../lib/requestsApi'
import * as reviewApi from '../lib/reviewApi'
import { ApiError } from '../lib/refundApi'

/** Builds a full PermissionsResult from just the `permissions` a test cares about (mirrors RefundShell.test.tsx's `permissionsWith`). */
const permissionsWith = (permissions: Permission[]): PermissionsResult => ({
  epoch: 0,
  apps: ['refund'],
  roles: [],
  departments: [],
  permissions,
})

const REQUEST_APPROVE_SELF_RESTRICTED: Permission = {
  resource: 'request',
  action: 'approve',
  conditions: { attributes: [{ key: 'self-approval', match: 'deny' }] },
}
const REQUEST_APPROVE_UNCONDITIONED: Permission = { resource: 'request', action: 'approve' }

beforeEach(() => {
  useSessionMock.mockReturnValue({ data: null })
  usePermissionsMock.mockReturnValue(permissionsWith([]))
})

function pendingPromise<T>(): Promise<T> {
  return new Promise(() => {})
}

function renderReviewDetailPage(id = 'req-1') {
  window.history.pushState(null, '', `/review/${id}`)
  const rootRoute = createRootRoute()
  const reviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review',
    component: () => null,
    validateSearch: (search: Record<string, unknown>): { confirmation?: string } => ({
      confirmation: typeof search.confirmation === 'string' ? search.confirmation : undefined,
    }),
  })
  const reviewDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review/$id', component: ReviewDetailPage })
  const routeTree = rootRoute.addChildren([reviewRoute, reviewDetailRoute])
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
  status: 'submitted',
  owner: { userId: 'u1', email: 'alice@welld.ch', name: 'Alice' },
  submittedAt: '2026-07-14T00:00:00.000Z',
  decidedAt: null,
  decidedBy: null,
  rejectionMotivation: null,
  paidAt: null,
  paidBy: null,
  lines: [
    {
      id: 'line-1',
      date: '2026-07-01',
      type: 'stationery',
      motivo: 'Pens',
      entity: 'welld_it',
      currency: 'EUR',
      requestedAmountCents: 1000,
      km: null,
      approvedTotalCents: null,
      attachments: [],
    },
  ],
  subtotals: [{ currency: 'EUR', requestedCents: 1000, approvedCents: null }],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
}

describe('ReviewDetailPage — loading / error / not found', () => {
  it('shows SkeletonListRows while loading', async () => {
    vi.mocked(requestsApi.get).mockReturnValue(pendingPromise())
    renderReviewDetailPage()
    expect(await screen.findByTestId('skeleton-list-rows')).not.toBeNull()
  })

  it('shows ErrorBanner + Retry on a non-404 failure', async () => {
    vi.mocked(requestsApi.get)
      .mockRejectedValueOnce(new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }))
      .mockResolvedValueOnce(baseRequest)
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull())
    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await waitFor(() => expect(screen.getByTestId('review-detail-decidable')).not.toBeNull())
  })

  it('shows a neutral not-found state on a 404 (out-of-scope or nonexistent, AC-6.4) — never "permission denied"', async () => {
    vi.mocked(requestsApi.get).mockRejectedValue(new ApiError({ type: 'about:blank', title: 'Not Found', status: 404 }))
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-not-found')).not.toBeNull())
    expect(screen.getByTestId('review-detail-not-found').textContent).not.toMatch(/permission/i)
    expect(screen.getByTestId('review-detail-not-found-back').getAttribute('href')).toBe('/review')
  })
})

describe('ReviewDetailPage — submitted (decidable) variant', () => {
  it('shows the employee identity, full RO lines, and an approved-total input with a row-identity aria-label', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-decidable')).not.toBeNull())
    expect(screen.getByTestId('review-detail-requested-by').textContent).toBe('Requested by Alice (alice@welld.ch)')
    expect(screen.queryByTestId('row-line-1-motivo')).toBeNull() // read-only, no edit inputs
    const input = screen.getByTestId('row-line-1-approved-total') as HTMLInputElement
    expect(input.value).toBe('10.00')
    expect(input.getAttribute('aria-label')).toBe('Approved total for 2026-07-01 · Pens · EUR')
  })

  // QE regression (specs/007-refund-service, T21 verification pass) — same
  // defect as ReviewQueuePage.test.tsx's own "DEFECT (QE)" case: refund-api
  // NEVER populates `owner.name` (verified live — `POST /requests` always
  // calls `createDraftRequest(sub, email, null)`, requests.routes.ts, since
  // the JWT carries no `name` claim). `RefundRequestDetail`'s type declares
  // `owner.name: string` (non-nullable, requestsApi.ts) — wrong against the
  // real contract. Expected to FAIL until the type is corrected to
  // `string | null` and this line falls back to the email alone.
  it('DEFECT (QE): a request with no owner name never renders "Requested by null"', async () => {
    // `as unknown as RefundRequestDetail` — see ReviewQueuePage.test.tsx's
    // matching DEFECT test doc comment: TypeScript's direct `as` refuses
    // this (TS2352) because the declared type is wrong against the real
    // wire contract, which is exactly the defect being demonstrated.
    const noNameRequest = {
      ...baseRequest,
      owner: { ...baseRequest.owner, name: null },
    } as unknown as RefundRequestDetail
    vi.mocked(requestsApi.get).mockResolvedValue(noNameRequest)
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-decidable')).not.toBeNull())
    expect(screen.getByTestId('review-detail-requested-by').textContent).not.toContain('null')
  })

  it('write-on-change-only: setApprovedTotal is called with the new cents on blur after an edit, and reloads', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    vi.mocked(reviewApi.setApprovedTotal).mockResolvedValue({ ...baseRequest.lines[0], approvedTotalCents: 750 })
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('row-line-1-approved-total')).not.toBeNull())
    const input = screen.getByTestId('row-line-1-approved-total')
    fireEvent.change(input, { target: { value: '7.50' } })
    fireEvent.blur(input)

    await waitFor(() => expect(reviewApi.setApprovedTotal).toHaveBeenCalledWith('req-1', 'line-1', 750))
    await waitFor(() => expect(requestsApi.get).toHaveBeenCalledTimes(2))
  })

  it('a 409 on approved-total change surfaces GuardrailDialog and reloads', async () => {
    vi.mocked(requestsApi.get)
      .mockResolvedValueOnce(baseRequest)
      .mockResolvedValueOnce({ ...baseRequest, status: 'approved', decidedAt: '2026-07-15T00:00:00.000Z' })
    vi.mocked(reviewApi.setApprovedTotal).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'Already decided.' }),
    )
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('row-line-1-approved-total')).not.toBeNull())
    const input = screen.getByTestId('row-line-1-approved-total')
    fireEvent.change(input, { target: { value: '7.50' } })
    fireEvent.blur(input)

    await waitFor(() => expect(screen.getByTestId('guardrail-dialog')).not.toBeNull())
    fireEvent.click(screen.getByTestId('guardrail-dialog-ok'))
    await waitFor(() => expect(screen.getByTestId('review-detail-approved')).not.toBeNull())
  })

  it('Approve: opens ApproveDialog, confirming calls reviewApi.approve and navigates back to the queue with a confirmation', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    vi.mocked(reviewApi.approve).mockResolvedValue({ ...baseRequest, status: 'approved' })
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-approve')).not.toBeNull())
    fireEvent.click(screen.getByTestId('review-detail-approve'))
    expect(screen.getByTestId('approve-dialog-modal')).not.toBeNull()

    fireEvent.click(screen.getByTestId('approve-dialog-confirm'))

    await waitFor(() => expect(reviewApi.approve).toHaveBeenCalledWith('req-1'))
    await waitFor(() => expect(window.location.pathname).toBe('/review'))
    expect(window.location.search).toContain('confirmation')
  })

  it('Approve 409 surfaces GuardrailDialog instead of navigating away', async () => {
    vi.mocked(requestsApi.get)
      .mockResolvedValueOnce(baseRequest)
      .mockResolvedValueOnce({ ...baseRequest, status: 'rejected', decidedAt: '2026-07-15T00:00:00.000Z', rejectionMotivation: 'Beat you to it.' })
    vi.mocked(reviewApi.approve).mockRejectedValue(new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 }))
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-approve')).not.toBeNull())
    fireEvent.click(screen.getByTestId('review-detail-approve'))
    fireEvent.click(screen.getByTestId('approve-dialog-confirm'))

    await waitFor(() => expect(screen.getByTestId('guardrail-dialog')).not.toBeNull())
    expect(window.location.pathname).toBe('/review/req-1')
  })

  it('Reject: RejectDialog stays disabled until motivation is entered; confirming calls reviewApi.reject and navigates back', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    vi.mocked(reviewApi.reject).mockResolvedValue({ ...baseRequest, status: 'rejected', rejectionMotivation: 'Missing receipt.' })
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-reject')).not.toBeNull())
    fireEvent.click(screen.getByTestId('review-detail-reject'))

    const confirmBtn = screen.getByTestId('reject-dialog-confirm')
    expect(confirmBtn.hasAttribute('disabled')).toBe(true)

    fireEvent.change(screen.getByTestId('reject-dialog-motivation'), { target: { value: 'Missing receipt.' } })
    expect(confirmBtn.hasAttribute('disabled')).toBe(false)

    fireEvent.click(confirmBtn)

    await waitFor(() => expect(reviewApi.reject).toHaveBeenCalledWith('req-1', 'Missing receipt.'))
    await waitFor(() => expect(window.location.pathname).toBe('/review'))
  })
})

// specs/010-self-approval-control (plan.md D5, ADR-0026) — T5: passive UI
// reflection of the self-approval segregation-of-duties control. `baseRequest`
// is owned by `u1` (owner.userId, above).
describe('ReviewDetailPage — self-approval control (specs/010)', () => {
  it('disables Approve with an explanatory tooltip when the caller owns the request AND their approve grant carries the self-approval restriction', async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: 'u1' } } })
    usePermissionsMock.mockReturnValue(permissionsWith([REQUEST_APPROVE_SELF_RESTRICTED]))
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderReviewDetailPage()

    const approveButton = await screen.findByTestId('review-detail-approve')
    expect(approveButton.getAttribute('aria-disabled')).toBe('true')
    expect(approveButton.getAttribute('title')).toBe('You cannot approve a refund request you submitted yourself.')

    // Defense-in-depth: clicking the disabled button never opens ApproveDialog.
    fireEvent.click(approveButton)
    expect(screen.queryByTestId('approve-dialog-modal')).toBeNull()
  })

  it('leaves Reject (and the approved-total input) enabled even when Approve is self-approval-disabled', async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: 'u1' } } })
    usePermissionsMock.mockReturnValue(permissionsWith([REQUEST_APPROVE_SELF_RESTRICTED]))
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderReviewDetailPage()

    await screen.findByTestId('review-detail-approve')
    const rejectButton = screen.getByTestId('review-detail-reject')
    expect(rejectButton.getAttribute('aria-disabled')).not.toBe('true')
    fireEvent.click(rejectButton)
    expect(screen.getByTestId('reject-dialog-modal')).not.toBeNull()

    const approvedTotalInput = screen.getByTestId('row-line-1-approved-total') as HTMLInputElement
    expect(approvedTotalInput.disabled).toBe(false)
  })

  it('keeps Approve enabled when the caller does NOT own the request, even under a restricted approve grant', async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: 'someone-else' } } })
    usePermissionsMock.mockReturnValue(permissionsWith([REQUEST_APPROVE_SELF_RESTRICTED]))
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderReviewDetailPage()

    const approveButton = await screen.findByTestId('review-detail-approve')
    expect(approveButton.getAttribute('aria-disabled')).not.toBe('true')
    expect(approveButton.getAttribute('title')).toBeNull()

    fireEvent.click(approveButton)
    expect(screen.getByTestId('approve-dialog-modal')).not.toBeNull()
  })

  it('keeps Approve enabled when the caller owns the request but their approve grant lacks the self-approval attribute', async () => {
    useSessionMock.mockReturnValue({ data: { user: { id: 'u1' } } })
    usePermissionsMock.mockReturnValue(permissionsWith([REQUEST_APPROVE_UNCONDITIONED]))
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderReviewDetailPage()

    const approveButton = await screen.findByTestId('review-detail-approve')
    expect(approveButton.getAttribute('aria-disabled')).not.toBe('true')

    fireEvent.click(approveButton)
    expect(screen.getByTestId('approve-dialog-modal')).not.toBeNull()
  })

  it('maps a 403 with code "self_approval_forbidden" to localized copy in the decision-dialog error path (e.g. stale client state)', async () => {
    // Caller appears un-owning/unrestricted client-side (button enabled), but
    // the server denies anyway — proves the server 403 is authoritative and
    // its `code` is mapped to strings.ts copy, never the raw server `detail`.
    useSessionMock.mockReturnValue({ data: { user: { id: 'someone-else' } } })
    usePermissionsMock.mockReturnValue(permissionsWith([REQUEST_APPROVE_SELF_RESTRICTED]))
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    vi.mocked(reviewApi.approve).mockRejectedValue(
      new ApiError({
        type: 'https://httpstatuses.com/403',
        title: 'Forbidden',
        status: 403,
        detail: 'You cannot approve a refund request you submitted yourself.',
        instance: '/review/requests/req-1/approve',
        code: 'self_approval_forbidden',
      }),
    )
    renderReviewDetailPage()

    const approveButton = await screen.findByTestId('review-detail-approve')
    fireEvent.click(approveButton)
    fireEvent.click(screen.getByTestId('approve-dialog-confirm'))

    await waitFor(() => expect(screen.getByTestId('approve-dialog-error')).not.toBeNull())
    expect(screen.getByTestId('approve-dialog-error').textContent).toBe(
      'You cannot approve a refund request you submitted yourself.',
    )
  })
})

describe('ReviewDetailPage — decided (approved/rejected) read-only variant', () => {
  it('approved: shows requested + approved per line, both subtotals, MonthlyProcessingNote, and no decide actions', async () => {
    const approvedRequest: RefundRequestDetail = {
      ...baseRequest,
      status: 'approved',
      lines: [{ ...baseRequest.lines[0], approvedTotalCents: 800 }],
      subtotals: [{ currency: 'EUR', requestedCents: 1000, approvedCents: 800 }],
      decidedAt: '2026-07-15T00:00:00.000Z',
      decidedBy: { email: 'acct@welld.ch' },
    }
    vi.mocked(requestsApi.get).mockResolvedValue(approvedRequest)
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-approved')).not.toBeNull())
    expect(screen.getByTestId('monthly-processing-note')).not.toBeNull()
    expect(screen.getByTestId('expense-line-row-line-1').textContent).toContain('8,00 €')
    expect(screen.queryByTestId('row-line-1-approved-total')).toBeNull()
    expect(screen.queryByTestId('review-detail-approve')).toBeNull()
    expect(screen.queryByTestId('review-detail-reject')).toBeNull()
  })

  it('rejected: shows the rejection motivation and no decide actions', async () => {
    const rejectedRequest: RefundRequestDetail = {
      ...baseRequest,
      status: 'rejected',
      rejectionMotivation: 'Missing receipt.',
      decidedAt: '2026-07-15T00:00:00.000Z',
      decidedBy: { email: 'acct@welld.ch' },
    }
    vi.mocked(requestsApi.get).mockResolvedValue(rejectedRequest)
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-rejected')).not.toBeNull())
    expect(screen.getByTestId('review-detail-rejection-motivation').textContent).toContain('Missing receipt.')
    expect(screen.queryByTestId('review-detail-approve')).toBeNull()
    expect(screen.queryByTestId('row-line-1-approved-total')).toBeNull()
  })

  it('paid: shows requested + approved per line, a "Paid on <date> by <email>" line, no MonthlyProcessingNote, and no decide actions (T13, specs/008-refund-monthly-processing)', async () => {
    const paidRequest: RefundRequestDetail = {
      ...baseRequest,
      status: 'paid',
      lines: [{ ...baseRequest.lines[0], approvedTotalCents: 800 }],
      subtotals: [{ currency: 'EUR', requestedCents: 1000, approvedCents: 800 }],
      decidedAt: '2026-07-15T00:00:00.000Z',
      decidedBy: { email: 'acct@welld.ch' },
      paidAt: '2026-07-16T00:00:00.000Z',
      paidBy: 'acct2@welld.ch',
    }
    vi.mocked(requestsApi.get).mockResolvedValue(paidRequest)
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-paid')).not.toBeNull())
    expect(screen.getByTestId('review-detail-paid-line').textContent).toContain('acct2@welld.ch')
    expect(screen.getByTestId('expense-line-row-line-1').textContent).toContain('8,00 €')
    expect(screen.queryByTestId('monthly-processing-note')).toBeNull()
    expect(screen.queryByTestId('review-detail-approve')).toBeNull()
    expect(screen.queryByTestId('review-detail-reject')).toBeNull()
  })
})
