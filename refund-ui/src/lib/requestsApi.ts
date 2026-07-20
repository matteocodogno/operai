/**
 * requestsApi — typed employee-facing operations against `refund-api`'s
 * request/line/lifecycle endpoints (T16, specs/007-refund-service/tasks.md),
 * built on `./refundApi.ts`'s generic `getJson`/`sendJson`/`deleteJson`
 * plumbing exactly as that file's own doc comment anticipates ("T16's
 * requests/lines … will build its typed operations on top of").
 *
 * Shapes below are transcribed verbatim from plan.md's "## API contracts"
 * (`## Shared shapes`, `### Employee endpoints`) — `refund-api` does not
 * exist yet (T7/T8/T10 are unimplemented as of this task, tasks.md), so this
 * is the CONTRACT this module targets, not a shape observed from a running
 * service. Attachment upload/download endpoints are intentionally NOT wired
 * here — that's T17 (deps: T16, T9); `RefundLine.attachments` is still
 * modeled below (it's part of the read shape every line carries) so
 * `ExpenseLineRow` has a typed seam to render an `AttachmentList` placeholder
 * against without inventing a shape T17 would have to change.
 */

import { apiFetch } from 'shell/session'
import type { Entity } from '../components/EntityBadge'
import type { RequestStatus } from '../components/RequestStatusBadge'
import type { ExpenseType } from './expenseTypes'
import type { Currency } from './money'
import type { Subtotal } from './subtotals'
import { ApiError, deleteJson, getJson, refundApiBase, sendJson } from './refundApi'
import type { ApiProblem } from './refundApi'

// ---------------------------------------------------------------------------
// Shapes (plan.md "## API contracts")
// ---------------------------------------------------------------------------

export type Attachment = {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
}

/**
 * `RefundLine.mileage` — present only for `travel_km` lines, `null`
 * otherwise (specs/009-mileage-rate/plan.md "## API contracts": "the single
 * carrier for AC-1.8 breakdown, AC-2.2 block, AC-6.4 review display, and
 * AC-3.x freeze state"). `appliedRate` is the LIVE effective rate while the
 * line is still draft (`snapshotted: false`) and the FROZEN rate captured at
 * submit once `snapshotted: true`; it is `null` when `!rateInEffect` (AC-2.2
 * — no rate configured for this line's entity/date) or for a legacy
 * pre-feature line that was already submitted before this feature shipped
 * (AC-1.7 — its stored amount/currency are never touched, and it never
 * gained a snapshot to report).
 */
export type MileageInfo = {
  km: number
  rateInEffect: boolean
  appliedRate: { ratePerKmMicros: number; ratePerKm: string; validFrom: string; currency: Currency } | null
  computedAmountCents: number | null
  snapshotted: boolean
}

export type RefundLine = {
  id: string
  date: string
  type: ExpenseType
  motivo: string
  entity: Entity
  currency: Currency
  requestedAmountCents: number
  km: number | null
  approvedTotalCents: number | null
  attachments: Attachment[]
  /**
   * Optional (not just nullable) on this TYPE so existing test fixtures
   * across the app that predate specs/009-mileage-rate keep compiling
   * without every one of them being touched — treat a missing key exactly
   * like `null` (no mileage data) at every read site. The real wire
   * contract always sends the key (plan.md), null for non-travel_km.
   */
  mileage?: MileageInfo | null
}

export type RequestListItem = {
  id: string
  status: RequestStatus
  updatedAt: string
  subtotals: Subtotal[]
}

export type RefundRequestDetail = {
  id: string
  status: RequestStatus
  /**
   * `owner.name` is `string | null` (QE-verified defect, specs/007-refund-
   * service): `refund-api` never populates it — the JWT carries no `name`
   * claim, only `sub`/`email` — so `POST /requests` always stores `null`.
   * Never read `owner.name` directly for display; use `strings.ts`'s
   * `ownerDisplay(owner)` instead.
   */
  owner: { userId: string; email: string; name: string | null }
  submittedAt: string | null
  decidedAt: string | null
  decidedBy: { email: string } | null
  rejectionMotivation: string | null
  /**
   * Set only once `status==='paid'` (specs/008-refund-monthly-processing,
   * T13, design.md F4/F5 — the SAME `GET /requests/:id` route both the
   * employee and accounting sides use, plan.md line 80: "sees `paid` +
   * `paidAt`"). `paidBy` is rendered only on the accounting-facing
   * `ReviewDetailPage` ("Paid on `<date>` by `<email>`") — the employee-facing
   * `RequestDetailPage` shows the date alone, never who processed it. Not
   * shown explicitly in specs/008 plan.md's own shape table (drift note: this
   * task's own report flags the exact field names as an assumption pending
   * backend confirmation, the same posture this file's own doc comment
   * already takes for the rest of this contract).
   */
  paidAt: string | null
  paidBy: string | null
  lines: RefundLine[]
  subtotals: Subtotal[]
  createdAt: string
  updatedAt: string
}

/**
 * Body shared by `POST /requests/:id/lines` and `PUT /requests/:id/lines/:lineId`
 * (plan.md). `currency` (post-close change, specs/007): a separately-stored,
 * independently-selectable field — REQUIRED, independent of `entity` (any
 * combination is valid; refund-api no longer derives it from entity) — for
 * every type EXCEPT `travel_km`.
 *
 * `requestedAmountCents`/`currency` (specs/009-mileage-rate amendment,
 * AC-1.1/AC-1.6): for a `travel_km` line, both are server-derived —
 * `lineDraftToPayload` (`lib/lineDraft.ts`) omits them from the wire body
 * entirely rather than sending a client-guessed value, and refund-api
 * ignores either one if sent anyway (plan.md: "a client-sent
 * requestedAmountCents/currency on a travel_km line is ignored, not
 * honored"). Optional here (not required) to make that omission
 * representable — every OTHER type still always sends both.
 */
export type LinePayload = {
  date: string
  type: ExpenseType
  motivo: string
  requestedAmountCents?: number
  entity: Entity
  currency?: Currency
  /** Required (and `>0`) iff `type==='travel_km'`; must be absent for every other type. */
  km?: number
}

// ---------------------------------------------------------------------------
// Request-level operations
// ---------------------------------------------------------------------------

/** `GET /requests` — the caller's own requests only (plan.md). */
export const list = (): Promise<RequestListItem[]> => getJson<RequestListItem[]>('/requests')

/** `POST /requests` — no body; creates a new `draft` (design.md F1 step 1). */
export const create = (): Promise<RefundRequestDetail> =>
  sendJson<RefundRequestDetail>('/requests', 'POST', undefined)

/** `GET /requests/:id` — full detail. Throws `ApiError` with `status===404` if not owned/in-scope. */
export const get = (id: string): Promise<RefundRequestDetail> =>
  getJson<RefundRequestDetail>(`/requests/${id}`)

/** `DELETE /requests/:id` — 204 only when `status==='draft'`, else `ApiError` with `status===409`. */
export const remove = (id: string): Promise<void> => deleteJson(`/requests/${id}`)

// ---------------------------------------------------------------------------
// Line-level operations
// ---------------------------------------------------------------------------

export const addLine = (requestId: string, payload: LinePayload): Promise<RefundLine> =>
  sendJson<RefundLine>(`/requests/${requestId}/lines`, 'POST', payload)

export const updateLine = (requestId: string, lineId: string, payload: LinePayload): Promise<RefundLine> =>
  sendJson<RefundLine>(`/requests/${requestId}/lines/${lineId}`, 'PUT', payload)

export const removeLine = (requestId: string, lineId: string): Promise<void> =>
  deleteJson(`/requests/${requestId}/lines/${lineId}`)

// ---------------------------------------------------------------------------
// Lifecycle — submit / withdraw
// ---------------------------------------------------------------------------

/**
 * Thrown by `submit` on a `422` — carries the offending line ids the
 * response body names (plan.md: "body lists offending line ids", AC-1.6),
 * in addition to the base `ApiError` fields, so `SubmitValidationSummary`
 * can render a jump link per id. `refund-api` does not exist yet (drift
 * note: this task's implementation report flags the exact response field
 * name — `offendingLineIds` — as an assumption pending confirmation once
 * T10 ships).
 */
export class SubmitValidationApiError extends ApiError {
  readonly offendingLineIds: string[]

  constructor(problem: ApiProblem & { offendingLineIds?: string[] }) {
    super(problem)
    this.name = 'SubmitValidationApiError'
    this.offendingLineIds = problem.offendingLineIds ?? []
  }
}

/**
 * `POST /requests/:id/submit` — no body. On a `422` (0 lines, AC-1.5, or
 * incomplete lines, AC-1.6) throws `SubmitValidationApiError` instead of the
 * base `ApiError` so the caller can branch on `offendingLineIds` without a
 * second parse. Every other non-2xx throws the ordinary `ApiError` (mirrors
 * `sendJson`'s ordinary contract).
 */
export const submit = async (id: string): Promise<RefundRequestDetail> => {
  const response = await apiFetch(`${refundApiBase()}/requests/${id}/submit`, { method: 'POST' })

  if (response.status === 422) {
    let body: Partial<ApiProblem> & { offendingLineIds?: string[] } = {}
    try {
      body = await response.json()
    } catch {
      // Fall through with an empty body — the synthetic Problem below still carries the status.
    }
    throw new SubmitValidationApiError({
      type: body.type ?? 'https://httpstatuses.com/422',
      title: body.title ?? 'Unprocessable Entity',
      status: 422,
      detail: body.detail,
      instance: body.instance,
      offendingLineIds: body.offendingLineIds,
    })
  }

  if (!response.ok) {
    let body: Partial<ApiProblem> = {}
    try {
      body = await response.json()
    } catch {
      // synthesize below
    }
    throw new ApiError({
      type: body.type ?? `https://httpstatuses.com/${response.status}`,
      title: body.title ?? (response.statusText || String(response.status)),
      status: body.status ?? response.status,
      detail: body.detail,
      instance: body.instance,
    })
  }

  return response.json() as Promise<RefundRequestDetail>
}

/** `POST /requests/:id/withdraw` — no body. `409` (status≠submitted, AC-2.3) throws the ordinary `ApiError`. */
export const withdraw = (id: string): Promise<RefundRequestDetail> =>
  sendJson<RefundRequestDetail>(`/requests/${id}/withdraw`, 'POST', undefined)
