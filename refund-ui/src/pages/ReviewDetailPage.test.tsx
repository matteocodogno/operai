/**
 * @vitest-environment jsdom
 *
 * Component tests for ReviewDetailPage — Screen A2 (T18, specs/20260716-refund-
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
  return { ...original, setApprovedTotal: vi.fn(), approve: vi.fn(), reject: vi.fn(), rejectLine: vi.fn(), restoreLine: vi.fn() }
})

vi.mock('../lib/accountingApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/accountingApi')>()
  return { ...original, getRequestAccounting: vi.fn(), getAccountingOptions: vi.fn(), classifyLine: vi.fn() }
})

vi.mock('../lib/attachmentsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/attachmentsApi')>()
  return { ...original, getDownloadUrl: vi.fn() }
})

// specs/20260721-self-approval-control — `useSession`/`usePermissions` (shell/session)
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
import * as accountingApi from '../lib/accountingApi'
import type { AccountingLine, RequestAccounting } from '../lib/accountingApi'
import { ApiError } from '../lib/refundApi'
import { strings } from '../strings'

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
  const reviewDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/review/$id',
    component: ReviewDetailPage,
  })
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
      .mockRejectedValueOnce(
        new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500, detail: 'Boom.' }),
      )
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
    // The accessible name carries the SAME date string a sighted reader sees
    // (DD.MM.YYYY, lib/dates.ts) — a screen-reader user hearing a raw ISO date
    // while the row shows 01.07.2026 could not match the two.
    expect(input.getAttribute('aria-label')).toBe('Approved total for 01.07.2026 · Pens · EUR')
  })

  // QE regression (specs/20260716-refund-service, T21 verification pass) — same
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
      .mockResolvedValueOnce({
        ...baseRequest,
        status: 'rejected',
        decidedAt: '2026-07-15T00:00:00.000Z',
        rejectionMotivation: 'Beat you to it.',
      })
    vi.mocked(reviewApi.approve).mockRejectedValue(
      new ApiError({ type: 'about:blank', title: 'Conflict', status: 409 }),
    )
    renderReviewDetailPage()

    await waitFor(() => expect(screen.getByTestId('review-detail-approve')).not.toBeNull())
    fireEvent.click(screen.getByTestId('review-detail-approve'))
    fireEvent.click(screen.getByTestId('approve-dialog-confirm'))

    await waitFor(() => expect(screen.getByTestId('guardrail-dialog')).not.toBeNull())
    expect(window.location.pathname).toBe('/review/req-1')
  })

  it('Reject: RejectDialog stays disabled until motivation is entered; confirming calls reviewApi.reject and navigates back', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    vi.mocked(reviewApi.reject).mockResolvedValue({
      ...baseRequest,
      status: 'rejected',
      rejectionMotivation: 'Missing receipt.',
    })
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

// specs/20260721-self-approval-control (plan.md D5, ADR 20260721-self-approval-condition-and-403-exception) — T5: passive UI
// reflection of the self-approval segregation-of-duties control. `baseRequest`
// is owned by `u1` (owner.userId, above).
describe('ReviewDetailPage — self-approval control (specs/20260721-self-approval-control)', () => {
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

// ─── Status visibility ──────────────────────────────────────────────────────
//
// The page used to state its status NOWHERE. An approved request was
// identifiable only by the ABSENCE of the Approve/Reject buttons and the
// presence of the monthly note — the reader had to notice something that was
// not there. These pin the two positive signals that replaced that inference,
// so neither can be removed without a failing test.

describe('ReviewDetailPage — the status is stated, not inferred', () => {
  const decided = (over: Partial<RefundRequestDetail>): RefundRequestDetail => ({
    ...baseRequest,
    decidedAt: '2026-08-22T14:30:00.000Z',
    decidedBy: { email: 'chiara.rossi@welld.ch' },
    ...over,
  })

  it('badges the status beside the heading, agreeing with the queue row', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(decided({ status: 'approved' }))
    renderReviewDetailPage()

    const badge = await screen.findByTestId('request-status-badge')
    expect(badge.textContent).toContain('Approved')

    // Beside the heading, not adrift somewhere in the body.
    const heading = document.getElementById('refund-review-detail-heading')
    expect(heading).not.toBeNull()
    expect(badge.parentElement?.contains(heading as Node)).toBe(true)
  })

  it('badges a submitted request too, so status is never left to inference', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderReviewDetailPage()

    const badge = await screen.findByTestId('request-status-badge')
    // "Awaiting decision", not "Submitted" — the queue's own copy, which reads
    // from the reviewer's point of view rather than the employee's.
    expect(badge.textContent).toContain('Awaiting decision')
  })

  it('names who approved the request and when — the counterpart to "Paid on X by Y"', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(decided({ status: 'approved' }))
    renderReviewDetailPage()

    const line = await screen.findByTestId('review-detail-decision-line')
    expect(line.textContent).toBe('Approved on 22.08.2026 by chiara.rossi@welld.ch')
  })

  it('names who rejected the request and when — the motivation says why, not who', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(
      decided({ status: 'rejected', rejectionMotivation: 'Missing receipt' }),
    )
    renderReviewDetailPage()

    const line = await screen.findByTestId('review-detail-decision-line')
    expect(line.textContent).toBe('Rejected on 22.08.2026 by chiara.rossi@welld.ch')
  })

  // A paid request carries TWO events by two different people: the decision
  // and the payout. Neither replaces the other.
  it('shows both the approval stamp and the payout stamp on a paid request', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(
      decided({
        status: 'paid',
        paidAt: '2026-09-01T09:00:00.000Z',
        paidBy: 'accounting@welld.ch',
      }),
    )
    renderReviewDetailPage()

    const decision = await screen.findByTestId('review-detail-decision-line')
    expect(decision.textContent).toContain('Approved on 22.08.2026 by chiara.rossi@welld.ch')
    expect(screen.getByTestId('review-detail-paid-line').textContent).toContain('accounting@welld.ch')
  })

  it('shows no decision stamp while the request is still awaiting one', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderReviewDetailPage()

    await waitFor(() => expect(screen.queryByTestId('review-detail-requested-by')).not.toBeNull())
    expect(screen.queryByTestId('review-detail-decision-line')).toBeNull()
  })

  // Never render half a stamp: "Approved on 22.08.2026 by undefined" is worse
  // than saying nothing, because it looks like a record rather than a gap.
  it('renders no stamp at all when the decider is missing from the record', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(decided({ status: 'approved', decidedBy: null }))
    renderReviewDetailPage()

    await waitFor(() => expect(screen.queryByTestId('review-detail-approved')).not.toBeNull())
    expect(screen.queryByTestId('review-detail-decision-line')).toBeNull()
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
    expect(screen.getByTestId('expense-line-row-line-1').textContent).toContain('EUR 8.00')
    expect(screen.queryByTestId('row-line-1-approved-total')).toBeNull()
    expect(screen.queryByTestId('review-detail-approve')).toBeNull()
    expect(screen.queryByTestId('review-detail-reject')).toBeNull()
  })

  // Placement, not just presence. The export first shipped between the totals
  // card and the line list, where it read as orphaned — it acts on the WHOLE
  // request, so it belongs in the header row beside the title, not inside one
  // of the body sections. Asserting only "the button exists" would let it
  // silently drift back, so these pin the DOM relationship.
  it('renders the export control in the header row, not inside the approved body section', async () => {
    const approvedRequest = {
      ...baseRequest,
      status: 'approved' as const,
      lines: [{ ...baseRequest.lines[0], approvedTotalCents: 800 }],
      subtotals: [{ currency: 'EUR' as const, requestedCents: 1000, approvedCents: 800 }],
      decidedAt: '2026-07-15T00:00:00.000Z',
      decidedBy: { email: 'acct@welld.ch' },
    }
    vi.mocked(requestsApi.get).mockResolvedValue(approvedRequest)
    renderReviewDetailPage()

    const exportButton = await screen.findByTestId(`request-export-link-${approvedRequest.id}`)

    // It must NOT live inside the approved body block it used to sit in.
    expect(screen.getByTestId('review-detail-approved').contains(exportButton)).toBe(false)
    // It must share a row with the heading — i.e. their nearest common
    // ancestor is the header row, not the whole page.
    const heading = document.getElementById('refund-review-detail-heading')
    expect(heading).not.toBeNull()
    const row = exportButton.closest('div')?.parentElement
    expect(row?.contains(heading as Node)).toBe(true)
  })

  it('shows no export control while the request is not archivable', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderReviewDetailPage()

    await waitFor(() => expect(screen.queryByTestId('expense-line-row-line-1')).not.toBeNull())
    expect(screen.queryByTestId(`request-export-link-${baseRequest.id}`)).toBeNull()
  })
  // Placement: a footnote to the totals, not a banner appended after every
  // expense line. It answers "when does this figure get paid", so it belongs
  // with the figure.
  it('renders the monthly-processing note directly under the totals, not after the lines', async () => {
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

    const note = await screen.findByTestId('monthly-processing-note')
    const panel = screen.getByTestId('subtotals-panel')

    // Same wrapper as the totals, so the two read as one block.
    expect(note.parentElement?.contains(panel)).toBe(true)
    // And it precedes the expense lines rather than trailing them.
    expect(
      note.compareDocumentPosition(screen.getByTestId('expense-line-row-line-1')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
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

  it('paid: shows requested + approved per line, a "Paid on <date> by <email>" line, no MonthlyProcessingNote, and no decide actions (T13, specs/20260719-refund-monthly-processing)', async () => {
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
    expect(screen.getByTestId('expense-line-row-line-1').textContent).toContain('EUR 8.00')
    expect(screen.queryByTestId('monthly-processing-note')).toBeNull()
    expect(screen.queryByTestId('review-detail-approve')).toBeNull()
    expect(screen.queryByTestId('review-detail-reject')).toBeNull()
  })
})

describe('ReviewDetailPage — line rejection (specs/20260716-refund-service amendment, 2026-11-10)', () => {
  const rejection = { reason: 'No receipt', rejectedAt: '2026-07-15T10:00:00.000Z', rejectedBy: { email: 'acct@welld.ch' } }
  const twoLines: RefundRequestDetail = {
    ...baseRequest,
    lines: [
      baseRequest.lines[0]!,
      { ...baseRequest.lines[0]!, id: 'line-2', motivo: 'Lunch', requestedAmountCents: 2500 },
    ],
  }

  it('rejecting a line needs a reason; confirming calls reviewApi.rejectLine and reloads', async () => {
    vi.mocked(requestsApi.get).mockResolvedValueOnce(twoLines).mockResolvedValueOnce({
      ...twoLines,
      lines: [{ ...twoLines.lines[0]!, approvedTotalCents: 0, rejection }, twoLines.lines[1]!],
    })
    vi.mocked(reviewApi.rejectLine).mockResolvedValue({ ...twoLines.lines[0]!, approvedTotalCents: 0, rejection })
    renderReviewDetailPage()

    fireEvent.click(await screen.findByTestId('row-line-1-reject'))
    // Confirm with no reason: refused client-side, nothing sent.
    fireEvent.click(screen.getByTestId('row-line-1-reject-dialog-confirm'))
    expect(await screen.findByText('Enter the reason for rejecting this line.')).not.toBeNull()
    expect(reviewApi.rejectLine).not.toHaveBeenCalled()
    // A failed submit moves focus to the invalid field (design-system.md § Forms).
    expect(document.activeElement).toBe(screen.getByTestId('row-line-1-reject-reason'))
    // A stray click on the backdrop keeps the dialog — and what was typed.
    fireEvent.change(screen.getByTestId('row-line-1-reject-reason'), { target: { value: 'draft' } })
    fireEvent.click(screen.getByTestId('row-line-1-reject-dialog-backdrop'))
    expect((screen.getByTestId('row-line-1-reject-reason') as HTMLTextAreaElement).value).toBe('draft')

    fireEvent.change(screen.getByTestId('row-line-1-reject-reason'), { target: { value: '  No receipt ' } })
    fireEvent.click(screen.getByTestId('row-line-1-reject-dialog-confirm'))
    await waitFor(() => expect(reviewApi.rejectLine).toHaveBeenCalledWith('req-1', 'line-1', 'No receipt'))

    expect((await screen.findByTestId('row-line-1-rejection-reason')).textContent).toBe('No receipt')
    expect(screen.getByTestId('row-line-1-rejected-badge')).not.toBeNull()
    expect(screen.getByTestId('row-line-1-rejected-by').textContent).toBe('Rejected by acct@welld.ch')
    // A rejected line has no approved-total input; the other line still does.
    expect(screen.queryByTestId('row-line-1-approved-total')).toBeNull()
    expect(screen.getByTestId('row-line-2-approved-total')).not.toBeNull()
    expect(screen.queryByTestId('row-line-1-reject-dialog-confirm')).toBeNull()
    // One line left: the request can still be approved.
    expect(screen.getByTestId('review-detail-approve').getAttribute('aria-disabled')).not.toBe('true')
  })

  it('restore calls reviewApi.restoreLine', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue({
      ...twoLines,
      lines: [{ ...twoLines.lines[0]!, approvedTotalCents: 0, rejection }, twoLines.lines[1]!],
    })
    vi.mocked(reviewApi.restoreLine).mockResolvedValue(twoLines.lines[0]!)
    renderReviewDetailPage()

    fireEvent.click(await screen.findByTestId('row-line-1-restore'))
    await waitFor(() => expect(reviewApi.restoreLine).toHaveBeenCalledWith('req-1', 'line-1'))
  })

  it('disables Approve, with the reason, when every line is rejected', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue({
      ...baseRequest,
      lines: [{ ...baseRequest.lines[0]!, approvedTotalCents: 0, rejection }],
    })
    renderReviewDetailPage()

    const approve = await screen.findByTestId('review-detail-approve')
    expect(approve.getAttribute('aria-disabled')).toBe('true')
    expect(approve.getAttribute('title')).toBe('Every line is rejected — reject the request instead.')
    fireEvent.click(approve)
    expect(screen.queryByTestId('approve-dialog-modal')).toBeNull()
    // Rejecting the whole request stays available.
    expect((screen.getByTestId('review-detail-reject') as HTMLButtonElement).disabled).toBe(false)
  })

  it('an approved request shows the rejected line with its reason', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue({
      ...twoLines,
      status: 'approved',
      decidedAt: '2026-07-16T00:00:00.000Z',
      decidedBy: { email: 'acct@welld.ch' },
      lines: [
        { ...twoLines.lines[0]!, approvedTotalCents: 0, rejection },
        { ...twoLines.lines[1]!, approvedTotalCents: 2500 },
      ],
      subtotals: [{ currency: 'EUR', requestedCents: 3500, approvedCents: 2500 }],
    })
    renderReviewDetailPage()

    expect((await screen.findByTestId('row-line-1-rejection-reason')).textContent).toBe('No receipt')
    expect(screen.queryByTestId('row-line-2-rejection')).toBeNull()
    expect(screen.queryByTestId('row-line-1-restore')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Classification (T28, specs/20261118-refund-accounting-export, design S7, F5, F6; AC-3.1, AC-3.3, AC-3.6, AC-3.7, AC-3.9, AC-3.10)
// ---------------------------------------------------------------------------

describe('ReviewDetailPage — line classification panels', () => {
  const problem = (status: number, code?: string) => new ApiError({ type: 't', title: 'x', status, code })

  const TRAIN = { id: 'acc-train', number: '5901', name: 'Spese viaggi in treno', active: true }
  const HOTEL = { id: 'acc-hotel', number: '5902', name: 'Spese alberghi', active: true }
  const NOVAT = { id: 'vat-0', code: 'NOVAT', label: 'Senza IVA', ratePercent: '0', active: true }
  const OPTIONS = {
    ledgerAccounts: [TRAIN, HOTEL].map(({ id, number, name }) => ({ id, number, name })),
    vatCodes: [{ id: 'vat-0', code: 'NOVAT', label: 'Senza IVA', ratePercent: '0' }],
  }

  const chLine = (id: string, overrides: Partial<RefundRequestDetail['lines'][number]> = {}) => ({
    ...baseRequest.lines[0],
    id,
    entity: 'welld_ch' as const,
    motivo: `Line ${id}`,
    ...overrides,
  })

  const accLine = (lineId: string, overrides: Partial<AccountingLine> = {}): AccountingLine => ({
    lineId,
    entity: 'welld_ch',
    date: '2026-07-01',
    type: 'stationery',
    currency: 'EUR',
    amountCents: 1000,
    receiptNumber: null,
    employee: { name: 'Alice', email: 'alice@welld.ch' },
    rejected: false,
    inScope: true,
    classification: { account: TRAIN, accountIsDefault: true, vatCode: NOVAT, vatCodeIsDefault: true },
    chf: { amountCents: 924, rateMicros: 924600, rate: '0.9246', rateMonth: '2026-07', rateMissing: false },
    vatAmountCents: 0,
    ...overrides,
  })

  const view = (
    lines: AccountingLine[],
    classificationState: RequestAccounting['classificationState'] = 'review',
    status: RequestAccounting['status'] = 'submitted',
    selfRestricted = false,
  ): RequestAccounting => ({
    requestId: 'req-1',
    status,
    batch: null,
    classificationState,
    selfRestricted,
    lines,
  })

  const withCh = (overrides: Partial<RefundRequestDetail> = {}): RefundRequestDetail => ({
    ...baseRequest,
    lines: [chLine('c1')],
    ...overrides,
  })

  const REVIEWER = [
    { resource: 'request', action: 'set-approved-total' },
    { resource: 'request', action: 'reclassify' },
  ] as Permission[]

  beforeEach(() => {
    // `clearAllMocks` keeps queued `Once` answers: start each of these from nothing.
    vi.mocked(requestsApi.get).mockReset()
    vi.mocked(accountingApi.getRequestAccounting).mockReset()
    vi.mocked(accountingApi.classifyLine).mockReset()
    usePermissionsMock.mockReturnValue(permissionsWith(REVIEWER))
    vi.mocked(accountingApi.getAccountingOptions).mockResolvedValue(OPTIONS)
  })

  /** The select, once the options have loaded (until then it is disabled and ignores a change). */
  const readySelect = async (testId: string) => {
    const select = (await screen.findByTestId(testId)) as HTMLSelectElement
    await waitFor(() => expect(select.disabled).toBe(false))
    return select
  }

  const panel = (lineId: string) => screen.queryByTestId(`classification-${lineId}`)

  it('shows a panel with defaults and markers inside each WellD CH line, and none on a WellD Italia or rejected line (AC-3.1, AC-3.9)', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(
      withCh({
        lines: [
          chLine('c1'),
          { ...baseRequest.lines[0], id: 'it1' },
          chLine('c2', {
            rejection: { reason: 'no', rejectedBy: { email: 'a@b.c' }, rejectedAt: '2026-07-02T00:00:00.000Z' },
            approvedTotalCents: 0,
          }),
        ],
      }),
    )
    vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(
      view([
        accLine('c1'),
        accLine('it1', { entity: 'welld_it', classification: null }),
        accLine('c2', { rejected: true, classification: null }),
      ]),
    )
    renderReviewDetailPage()

    const c1 = await screen.findByTestId('classification-c1')
    expect(screen.getByTestId('expense-line-row-c1').contains(c1)).toBe(true)
    expect((screen.getByTestId('classification-c1-account') as HTMLSelectElement).value).toBe('acc-train')
    expect(c1.textContent).toContain('Default')
    expect(panel('it1')).toBeNull()
    expect(panel('c2')).toBeNull()
    expect(screen.getByTestId('expense-line-row-it1').textContent).not.toMatch(/Classification|VAT code/)
    expect(screen.getByRole('group', { name: 'Classification for 01.07.2026 · Line c1' })).not.toBeNull()
  })

  it('never calls the accounting endpoint for a request with no WellD CH line to classify (UX-13)', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
    renderReviewDetailPage()
    await screen.findByTestId('review-detail-decidable')
    await waitFor(() => expect(accountingApi.getRequestAccounting).not.toHaveBeenCalled())
    expect(accountingApi.getAccountingOptions).not.toHaveBeenCalled()
  })

  it('shows a skeleton only inside CH lines and one polite loading line while the view loads', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(withCh({ lines: [chLine('c1'), { ...baseRequest.lines[0], id: 'it1' }] }))
    vi.mocked(accountingApi.getRequestAccounting).mockReturnValue(pendingPromise())
    renderReviewDetailPage()

    expect(await screen.findByTestId('classification-c1-loading')).not.toBeNull()
    expect(screen.queryByTestId('classification-it1-loading')).toBeNull()
    expect(screen.getAllByText('Loading classification…')).toHaveLength(1)
    expect(screen.getByText('Loading classification…').getAttribute('aria-live')).toBe('polite')
  })

  it('a failed load is ONE banner with Retry above the lines, and the page keeps working', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(withCh({ lines: [chLine('c1'), chLine('c2')] }))
    vi.mocked(accountingApi.getRequestAccounting)
      .mockRejectedValueOnce(problem(500))
      .mockResolvedValue(view([accLine('c1'), accLine('c2')]))
    renderReviewDetailPage()

    const banner = await screen.findByText('Could not load the classification.')
    expect(screen.getAllByText('Could not load the classification.')).toHaveLength(1)
    expect(panel('c1')).toBeNull()
    expect(screen.getByTestId('review-detail-approve')).not.toBeNull()
    expect(banner.closest('[data-testid="review-detail-decidable"]')).not.toBeNull()

    fireEvent.click(screen.getByTestId('error-banner-retry'))
    await screen.findByTestId('classification-c1')
    expect(panel('c2')).not.toBeNull()
    expect(screen.queryByText('Could not load the classification.')).toBeNull()
  })

  it.each([403, 404])('a %i is an info note, no retry, and Approve is still there', async (status) => {
    vi.mocked(requestsApi.get).mockResolvedValue(withCh())
    vi.mocked(accountingApi.getRequestAccounting).mockRejectedValue(problem(status))
    renderReviewDetailPage()

    expect((await screen.findByTestId('classification-unavailable')).textContent).toBe(
      'The classification is not available for this request.',
    )
    expect(screen.queryByTestId('error-banner-retry')).toBeNull()
    expect(panel('c1')).toBeNull()
    expect(screen.queryByTestId('classification-c1-loading')).toBeNull()
    expect(screen.getByTestId('review-detail-approve')).not.toBeNull()
  })

  it('changing a select saves that one value and shows the server\u2019s answer, amounts included (AC-3.3)', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(withCh())
    vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')]))
    vi.mocked(accountingApi.classifyLine).mockResolvedValue(
      accLine('c1', {
        classification: { account: HOTEL, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true },
        chf: { amountCents: 999, rateMicros: 924600, rate: '0.9246', rateMonth: '2026-07', rateMissing: false },
      }),
    )
    renderReviewDetailPage()

    const select = await readySelect('classification-c1-account')
    fireEvent.change(select, { target: { value: 'acc-hotel' } })

    await waitFor(() => expect(accountingApi.classifyLine).toHaveBeenCalledWith('req-1', 'c1', { ledgerAccountId: 'acc-hotel' }))
    await waitFor(() => expect(screen.getByTestId('classification-c1-chf').textContent).toBe('CHF 9.99'))
    expect(screen.getByTestId('classification-c1').textContent).toContain('Set by hand')
    expect((screen.getByTestId('classification-c1-account') as HTMLSelectElement).value).toBe('acc-hotel')
    // The options were loaded once and not again.
    expect(accountingApi.getAccountingOptions).toHaveBeenCalledTimes(1)
    // A save merges the answer: it does not reload the view.
    expect(accountingApi.getRequestAccounting).toHaveBeenCalledTimes(1)
  })

  it('reloads the accounting view after an approved-total change, because the figures follow it', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(withCh())
    vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')]))
    vi.mocked(reviewApi.setApprovedTotal).mockResolvedValue({ ...chLine('c1'), approvedTotalCents: 750 })
    renderReviewDetailPage()

    await screen.findByTestId('classification-c1')
    const input = screen.getByTestId('row-c1-approved-total')
    fireEvent.change(input, { target: { value: '7.50' } })
    fireEvent.blur(input)

    await waitFor(() => expect(accountingApi.getRequestAccounting).toHaveBeenCalledTimes(2))
    // The panel stays on screen across the reload: no skeleton flash.
    expect(panel('c1')).not.toBeNull()
  })

  it('reloads the accounting view after a line is rejected and after it is restored', async () => {
    const rejection = { reason: 'no', rejectedBy: { email: 'a@b.c' }, rejectedAt: '2026-07-02T00:00:00.000Z' }
    const both = withCh({ lines: [chLine('c1'), chLine('c2')] })
    vi.mocked(requestsApi.get)
      .mockResolvedValueOnce(both)
      .mockResolvedValueOnce(withCh({ lines: [chLine('c1', { rejection, approvedTotalCents: 0 }), chLine('c2')] }))
      .mockResolvedValue(both)
    vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1'), accLine('c2')]))
    vi.mocked(reviewApi.rejectLine).mockResolvedValue({ ...chLine('c1'), rejection, approvedTotalCents: 0 })
    vi.mocked(reviewApi.restoreLine).mockResolvedValue(chLine('c1'))
    renderReviewDetailPage()

    await screen.findByTestId('classification-c1')
    fireEvent.click(screen.getByTestId('row-c1-reject'))
    fireEvent.change(await screen.findByTestId('row-c1-reject-reason'), { target: { value: 'no' } })
    fireEvent.click(screen.getByTestId('row-c1-reject-dialog-confirm'))

    // Rejected: its panel is gone, the other line keeps its own, and the view was loaded again.
    await waitFor(() => expect(panel('c1')).toBeNull())
    expect(panel('c2')).not.toBeNull()
    await waitFor(() => expect(accountingApi.getRequestAccounting).toHaveBeenCalledTimes(2))

    fireEvent.click(await screen.findByTestId('row-c1-restore'))
    await waitFor(() => expect(accountingApi.getRequestAccounting).toHaveBeenCalledTimes(3))
    await screen.findByTestId('classification-c1')
  })

  it('a 409 classification_locked opens its own guardrail and reloads the request and the view (AC-3.7)', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(withCh({ status: 'approved', decidedAt: '2026-07-05T00:00:00.000Z', decidedBy: { email: 'x@y.z' } }))
    vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')], 'post_approval', 'approved'))
    vi.mocked(accountingApi.classifyLine).mockRejectedValue(problem(409, 'classification_locked'))
    renderReviewDetailPage()

    const select = await readySelect('classification-c1-account')
    fireEvent.change(select, { target: { value: 'acc-hotel' } })

    const dialog = await screen.findByTestId('guardrail-dialog')
    expect(dialog.textContent).toContain('This line is locked')
    expect(dialog.textContent).toContain('Its batch has been paid, so the classification can no longer change.')
    await waitFor(() => expect(accountingApi.getRequestAccounting).toHaveBeenCalledTimes(2))
    expect(requestsApi.get).toHaveBeenCalledTimes(2)
    expect((screen.getByTestId('classification-c1-account') as HTMLSelectElement).value).toBe('acc-train')
  })

  it('any other 409 on a classification shows the existing "already decided" guardrail', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(withCh())
    vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')]))
    vi.mocked(accountingApi.classifyLine).mockRejectedValue(problem(409, 'not_classifiable_status'))
    renderReviewDetailPage()

    fireEvent.change(await readySelect('classification-c1-account'), { target: { value: 'acc-hotel' } })
    const dialog = await screen.findByTestId('guardrail-dialog')
    expect(dialog.textContent).toContain(strings.pages.reviewDetail.guardrail.title)
  })

  it('a 422 inactive reloads the options once more', async () => {
    vi.mocked(requestsApi.get).mockResolvedValue(withCh())
    vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')]))
    vi.mocked(accountingApi.classifyLine).mockRejectedValue(problem(422, 'ledger_account_inactive'))
    renderReviewDetailPage()

    fireEvent.change(await readySelect('classification-c1-account'), { target: { value: 'acc-hotel' } })
    await screen.findByText('That account was deactivated. Choose another.')
    await waitFor(() => expect(accountingApi.getAccountingOptions).toHaveBeenCalledTimes(2))
  })

  describe('a refused approval (T29, S8, UX-5, G1, G2; AC-3.4)', () => {
    const missingRequest = withCh({ lines: [chLine('c1'), chLine('c2'), { ...baseRequest.lines[0], id: 'it1' }] })
    const missingView = (overrides: Partial<Record<string, AccountingLine>> = {}) =>
      view([
        overrides.c1 ??
          accLine('c1', {
            classification: { account: null, accountIsDefault: false, vatCode: NOVAT, vatCodeIsDefault: true },
          }),
        overrides.c2 ??
          accLine('c2', {
            classification: { account: null, accountIsDefault: false, vatCode: null, vatCodeIsDefault: false },
            vatAmountCents: null,
          }),
        accLine('it1', { entity: 'welld_it', classification: null }),
      ])
    const refusedWith = (lines: unknown[]) =>
      new ApiError({ type: 't', title: 'Conflict', status: 409, code: 'classification_missing' }, { lines })
    const refusal = refusedWith([
      { lineId: 'c2', date: '2026-07-01', type: 'stationery', missing: ['account', 'vatCode'] },
      { lineId: 'c1', date: '2026-07-01', type: 'stationery', missing: ['account'] },
    ])

    const approve = async () => {
      fireEvent.click(await screen.findByTestId('review-detail-approve'))
      fireEvent.click(screen.getByTestId('approve-dialog-confirm'))
    }

    it('closes the dialog and shows one ErrorSummary link per missing value, in page order, with focus on the first select', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(missingRequest)
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(missingView())
      vi.mocked(reviewApi.approve).mockRejectedValue(refusal)
      renderReviewDetailPage()
      await readySelect('classification-c1-account')
      await approve()

      const summary = await screen.findByTestId('classification-missing-summary')
      expect(screen.queryByTestId('approve-dialog-modal')).toBeNull()
      expect(screen.queryByTestId('guardrail-dialog')).toBeNull()
      expect(summary.getAttribute('role')).toBe('alert')
      expect(screen.getByTestId('classification-missing-summary-title').textContent).toBe(
        'Nothing was approved. 3 values need your attention.',
      )
      expect(screen.getAllByTestId('classification-missing-summary-item').map((item) => item.textContent)).toEqual([
        '01.07.2026 · Line c1: choose an account',
        '01.07.2026 · Line c2: choose an account',
        '01.07.2026 · Line c2: choose a VAT code',
      ])
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('classification-c1-account')))
      // Every missing select carries its own error; a present value carries none.
      expect(screen.getByTestId('classification-c1-account').getAttribute('aria-invalid')).toBe('true')
      expect(screen.getByTestId('classification-c1-vat-code').getAttribute('aria-invalid')).toBeNull()
      expect(screen.getByTestId('classification-c2-vat-code').getAttribute('aria-invalid')).toBe('true')
      // The request and the view were loaded again, and nothing navigated.
      await waitFor(() => expect(accountingApi.getRequestAccounting).toHaveBeenCalledTimes(2))
      expect(window.location.pathname).toBe('/review/req-1')
    })

    it('a link moves focus to its select', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(missingRequest)
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(missingView())
      vi.mocked(reviewApi.approve).mockRejectedValue(refusal)
      renderReviewDetailPage()
      await readySelect('classification-c1-account')
      await approve()
      await screen.findByTestId('classification-missing-summary')

      fireEvent.click(screen.getAllByTestId('classification-missing-summary-item')[2])
      expect(document.activeElement).toBe(screen.getByTestId('classification-c2-vat-code'))
    })

    it('the summary and the errors clear value by value as they are chosen', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(missingRequest)
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(missingView())
      vi.mocked(reviewApi.approve).mockRejectedValue(refusal)
      vi.mocked(accountingApi.classifyLine).mockResolvedValue(accLine('c1'))
      renderReviewDetailPage()
      const select = await readySelect('classification-c1-account')
      await approve()
      await screen.findByTestId('classification-missing-summary')

      fireEvent.change(select, { target: { value: 'acc-train' } })
      await waitFor(() =>
        expect(screen.getByTestId('classification-missing-summary-title').textContent).toBe(
          'Nothing was approved. 2 values need your attention.',
        ),
      )
      expect(screen.getByTestId('classification-c1-account').getAttribute('aria-invalid')).toBeNull()
      expect(screen.getAllByTestId('classification-missing-summary-item')).toHaveLength(2)
    })

    it('drops a line the page no longer has and says nothing about it', async () => {
      const ghost = refusedWith([
        { lineId: 'gone', date: '2026-07-01', type: 'stationery', missing: ['account'] },
        { lineId: 'c1', date: '2026-07-01', type: 'stationery', missing: ['account'] },
      ])
      vi.mocked(requestsApi.get).mockResolvedValue(missingRequest)
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(missingView())
      vi.mocked(reviewApi.approve).mockRejectedValue(ghost)
      renderReviewDetailPage()
      await readySelect('classification-c1-account')
      await approve()

      await screen.findByTestId('classification-missing-summary')
      expect(screen.getAllByTestId('classification-missing-summary-item')).toHaveLength(1)
    })

    it('accounting_release_pending stays in the dialog with its own sentence, and Approve can be pressed again', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
      vi.mocked(reviewApi.approve).mockRejectedValue(problem(409, 'accounting_release_pending'))
      renderReviewDetailPage()
      await approve()

      const error = await screen.findByTestId('approve-dialog-error')
      expect(error.textContent).toBe(
        'Approvals are not available yet: the accounting setup has not been completed. Ask an administrator.',
      )
      expect(screen.queryByTestId('guardrail-dialog')).toBeNull()
      expect(screen.queryByTestId('classification-missing-summary')).toBeNull()
      expect((screen.getByTestId('approve-dialog-confirm') as HTMLButtonElement).disabled).toBe(false)
      vi.mocked(reviewApi.approve).mockResolvedValue(baseRequest)
      fireEvent.click(screen.getByTestId('approve-dialog-confirm'))
      await waitFor(() => expect(reviewApi.approve).toHaveBeenCalledTimes(2))
    })

    it('all_lines_rejected is unchanged: its own sentence in the dialog', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
      vi.mocked(reviewApi.approve).mockRejectedValue(problem(409, 'all_lines_rejected'))
      renderReviewDetailPage()
      await approve()

      expect((await screen.findByTestId('approve-dialog-error')).textContent).toBe(
        'Every line is rejected — reject the request instead.',
      )
      expect(screen.queryByTestId('guardrail-dialog')).toBeNull()
    })

    it.each([[undefined], ['request_not_submitted']])(
      'any other 409 (code %s) still shows "already decided" and reloads',
      async (code) => {
        vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
        vi.mocked(reviewApi.approve).mockRejectedValue(problem(409, code))
        renderReviewDetailPage()
        await approve()

        const dialog = await screen.findByTestId('guardrail-dialog')
        expect(dialog.textContent).toContain(strings.pages.reviewDetail.guardrail.title)
        expect(screen.queryByTestId('approve-dialog-modal')).toBeNull()
        expect(screen.queryByTestId('classification-missing-summary')).toBeNull()
        await waitFor(() => expect(requestsApi.get).toHaveBeenCalledTimes(2))
      },
    )

    it('a refusal that names no usable line keeps the dialog and shows the server\u2019s sentence', async () => {
      const empty = new ApiError({ type: 't', title: 'Conflict', status: 409, code: 'classification_missing', detail: 'Missing.' })
      vi.mocked(requestsApi.get).mockResolvedValue(baseRequest)
      vi.mocked(reviewApi.approve).mockRejectedValue(empty)
      renderReviewDetailPage()
      await approve()

      expect((await screen.findByTestId('approve-dialog-error')).textContent).toBe('Missing.')
      expect(screen.queryByTestId('guardrail-dialog')).toBeNull()
    })

    it('a new approval attempt clears the previous summary', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(missingRequest)
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(missingView())
      vi.mocked(reviewApi.approve).mockRejectedValueOnce(refusal).mockReturnValue(pendingPromise())
      renderReviewDetailPage()
      await readySelect('classification-c1-account')
      await approve()
      await screen.findByTestId('classification-missing-summary')

      fireEvent.click(screen.getByTestId('review-detail-approve'))
      fireEvent.click(screen.getByTestId('approve-dialog-confirm'))
      await waitFor(() => expect(screen.queryByTestId('classification-missing-summary')).toBeNull())
    })
  })

  describe('after approval and payment (F6)', () => {
    const approved = (status: 'approved' | 'paid') =>
      withCh({
        status,
        decidedAt: '2026-07-05T00:00:00.000Z',
        decidedBy: { email: 'x@y.z' },
        paidAt: status === 'paid' ? '2026-07-16T00:00:00.000Z' : null,
        paidBy: status === 'paid' ? 'p@q.r' : null,
        lines: [chLine('c1', { approvedTotalCents: 1000, receiptNumber: 'MC26/014' })],
      })

    it('an approved request is editable with request:reclassify and shows the receipt number (AC-3.6, AC-3.10)', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(approved('approved'))
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')], 'post_approval', 'approved'))
      renderReviewDetailPage()

      expect(await screen.findByTestId('classification-c1-account')).not.toBeNull()
      expect(screen.getByTestId('expense-line-row-c1').textContent).toContain('MC26/014')
      expect(screen.getByTestId('classification-c1').textContent).not.toContain(
        'Amounts follow the approved total as it stands now.',
      )
    })

    it('without request:reclassify the panel is read-only text and the options are never loaded', async () => {
      usePermissionsMock.mockReturnValue(permissionsWith([{ resource: 'request', action: 'set-approved-total' }]))
      vi.mocked(requestsApi.get).mockResolvedValue(approved('approved'))
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')], 'post_approval', 'approved'))
      renderReviewDetailPage()

      await screen.findByTestId('classification-c1')
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.getByTestId('classification-c1-why').textContent).toBe(
        'You can view the classification but not change it.',
      )
      expect(accountingApi.getAccountingOptions).not.toHaveBeenCalled()
    })

    it('a paid request is locked, whatever the capability', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(approved('paid'))
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')], 'locked', 'paid'))
      renderReviewDetailPage()

      await screen.findByTestId('classification-c1')
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.getByTestId('classification-c1-why').textContent).toBe('Locked: its batch has been paid.')
      expect(accountingApi.getAccountingOptions).not.toHaveBeenCalled()
    })

    it('a submitted request without set-approved-total cannot change it either', async () => {
      usePermissionsMock.mockReturnValue(permissionsWith([]))
      vi.mocked(requestsApi.get).mockResolvedValue(withCh())
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')]))
      renderReviewDetailPage()

      await screen.findByTestId('classification-c1')
      expect(screen.queryByRole('combobox')).toBeNull()
    })

    it('a rejected request shows no panels and never loads the accounting view', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(withCh({ status: 'rejected', rejectionMotivation: 'No.' }))
      renderReviewDetailPage()

      await screen.findByTestId('review-detail-rejected')
      expect(accountingApi.getRequestAccounting).not.toHaveBeenCalled()
      expect(panel('c1')).toBeNull()
    })
  })

  // Plan.md "Security review sync" SR-1 and SR-2: the server marks what the caller may not see or change.
  describe('segregation of duties and entity scope', () => {
    const SELF_NOTE = "You can't classify your own request. Someone else has to do it."
    const OUT_NOTE = 'Not shown: this line is outside your entity scope. Ask a colleague with WellD CH access.'
    const outOfScopeLine = (lineId: string) =>
      accLine(lineId, { inScope: false, classification: null, chf: null, vatAmountCents: null })

    it('selfRestricted: every panel is read-only with the note, whatever the capability, and the options are never loaded (AC-3.6)', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(withCh({ lines: [chLine('c1'), chLine('c2')] }))
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(
        view([accLine('c1'), accLine('c2')], 'review', 'submitted', true),
      )
      renderReviewDetailPage()

      await screen.findByTestId('classification-c1')
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.getByTestId('classification-c1-why').textContent).toBe(SELF_NOTE)
      expect(screen.getByTestId('classification-c2-why').textContent).toBe(SELF_NOTE)
      expect(screen.getByTestId('classification-c1-values').textContent).toContain('5901')
      expect(accountingApi.getAccountingOptions).not.toHaveBeenCalled()
    })

    it('selfRestricted after approval is read-only too', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(
        withCh({ status: 'approved', lines: [chLine('c1', { approvedTotalCents: 1000 })] }),
      )
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(
        view([accLine('c1')], 'post_approval', 'approved', true),
      )
      renderReviewDetailPage()

      await screen.findByTestId('classification-c1')
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.getByTestId('classification-c1-why').textContent).toBe(SELF_NOTE)
    })

    it('a line out of scope shows the note and no figure or control, while an in-scope line of the same request stays editable (AC-3.3)', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(withCh({ lines: [chLine('c1'), chLine('c2')] }))
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1'), outOfScopeLine('c2')]))
      renderReviewDetailPage()

      await readySelect('classification-c1-account')
      const row = screen.getByTestId('expense-line-row-c2')
      expect(screen.getByTestId('classification-c2-out-of-scope').textContent).toBe(OUT_NOTE)
      expect(row.contains(screen.getByTestId('classification-c2-out-of-scope'))).toBe(true)
      expect(panel('c2')).toBeNull()
      expect(row.querySelector('select')).toBeNull()
      expect(screen.queryByTestId('classification-c2-chf')).toBeNull()
      expect(screen.queryByTestId('classification-c2-vat-amount')).toBeNull()
      expect(row.textContent).not.toMatch(/5901|NOVAT|CHF \d/)
    })

    it('a 403 self_approval_forbidden on a save reverts, turns all panels read-only with the note, and keeps them so after the view reloads', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(withCh({ lines: [chLine('c1'), chLine('c2')] }))
      // The reloaded view still says selfRestricted: false (a stale cache, or a backend a step behind).
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1'), accLine('c2')]))
      vi.mocked(accountingApi.classifyLine).mockRejectedValue(problem(403, 'self_approval_forbidden'))
      renderReviewDetailPage()

      const select = await readySelect('classification-c1-account')
      fireEvent.change(select, { target: { value: 'acc-hotel' } })

      await waitFor(() => expect(screen.getByTestId('classification-c1-why').textContent).toBe(SELF_NOTE))
      expect(screen.getByTestId('classification-c2-why').textContent).toBe(SELF_NOTE)
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      await waitFor(() => expect(accountingApi.getRequestAccounting).toHaveBeenCalledTimes(2))
      expect(screen.getByTestId('classification-c1-why').textContent).toBe(SELF_NOTE)
      expect(screen.getByTestId('classification-c1-values').textContent).not.toContain('5902')
    })

    it('a 404 on a save says the line is outside the entity scope and loads the view again', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(withCh({ lines: [chLine('c1'), chLine('c2')] }))
      vi.mocked(accountingApi.getRequestAccounting)
        .mockResolvedValueOnce(view([accLine('c1'), accLine('c2')]))
        .mockResolvedValue(view([outOfScopeLine('c1'), accLine('c2')]))
      vi.mocked(accountingApi.classifyLine).mockRejectedValue(problem(404, 'not_found'))
      renderReviewDetailPage()

      fireEvent.change(await readySelect('classification-c1-account'), { target: { value: 'acc-hotel' } })

      await waitFor(() => expect(accountingApi.getRequestAccounting).toHaveBeenCalledTimes(2))
      expect(await screen.findByTestId('classification-c1-out-of-scope')).not.toBeNull()
      expect(panel('c1')).toBeNull()
    })

    it('a 403 accounting_out_of_scope on the options leaves the panels read-only, with no error banner', async () => {
      vi.mocked(requestsApi.get).mockResolvedValue(withCh())
      vi.mocked(accountingApi.getRequestAccounting).mockResolvedValue(view([accLine('c1')]))
      vi.mocked(accountingApi.getAccountingOptions).mockRejectedValue(problem(403, 'accounting_out_of_scope'))
      renderReviewDetailPage()

      await screen.findByTestId('classification-c1')
      await waitFor(() => expect(accountingApi.getAccountingOptions).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
      expect(screen.getByTestId('classification-c1-why').textContent).toBe(
        'You can view the classification but not change it.',
      )
      expect(screen.queryByText('Could not load the classification.')).toBeNull()
    })
  })
})
