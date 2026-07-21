/**
 * reviewApi — typed accounting-facing operations against `refund-api`'s
 * review/decision endpoints (T18, specs/007-refund-service/tasks.md; plan.md
 * "### Accounting endpoints"), built on `./refundApi.ts`'s generic
 * `getJson`/`sendJson` plumbing, mirroring `./requestsApi.ts`'s convention.
 *
 * `GET /requests/:id` for accounting's own detail view is deliberately NOT
 * re-declared here — it's the SAME route `./requestsApi.ts`'s `get(id)`
 * already calls (plan.md: "GET /requests/:id for accounting: full detail
 * incl. all lines"); `ReviewDetailPage` reuses `requestsApi.get` directly
 * rather than this file re-deriving an identical function.
 *
 * DRIFT NOTE (flagged in this task's implementation report): T11/T12
 * (`refund-api`'s `/review/*` routes) are NOT YET IMPLEMENTED as of this
 * task — tasks.md still lists them unchecked. This module targets the
 * CONTRACT plan.md's "### Accounting endpoints" table already specifies in
 * full (method, path, body, success/error shapes), the same "build against
 * the documented contract, not a running service" posture `requestsApi.ts`
 * itself used against T7/T8/T10 before those existed (see that file's own
 * doc comment) — every test here mocks `apiFetch`, none require a live
 * refund-api. `ReviewQueueItem`'s exact shape is this module's own
 * extrapolation (plan.md gives the shared `RefundRequest`/`RefundLine`
 * shapes and design.md F5 step 1 names the row content — "requesting
 * employee, submission date, a compact per-currency subtotal preview" — but
 * plan.md's contract table doesn't spell out `GET /review/requests`'s exact
 * JSON field names); confirm against the real T11 response once it ships.
 */

import type { RequestStatus } from '../components/RequestStatusBadge'
import type { RefundLine, RefundRequestDetail } from './requestsApi'
import type { Subtotal } from './subtotals'
import { getJson, sendJson } from './refundApi'

/**
 * One row of `GET /review/requests` — `status` is `'submitted'` (awaiting a
 * decision) or `'approved'` (decided but not yet compiled into a monthly
 * batch); the queue now mixes both and the UI badge distinguishes them.
 * `owner.name` is `string | null` (QE-verified
 * defect, specs/007-refund-service): `refund-api` never populates it — the
 * JWT carries no `name` claim, only `sub`/`email` — so it's `null` on every
 * real response. Never read `owner.name` directly for display; use
 * `strings.ts`'s `ownerDisplay(owner)` instead.
 */
export type ReviewQueueItem = {
  id: string
  status: RequestStatus
  owner: { email: string; name: string | null }
  submittedAt: string
  subtotals: Subtotal[]
}

/** `GET /review/requests` — (submitted ∨ approved-not-yet-batched) ∧ in entity scope (AC-5.1/5.5/5.6). 403 if `request:review` is entirely absent (AC-5.4). */
export const listQueue = (): Promise<ReviewQueueItem[]> => getJson<ReviewQueueItem[]>('/review/requests')

/**
 * `PUT /review/requests/:id/lines/:lineId/approved-total` — submitted-only,
 * entity-scoped (409 once decided, AC-7.4). Write-on-change-only is the
 * CALLER's responsibility (design.md F6 step 2) — this function has no
 * opinion on when it's invoked.
 */
export const setApprovedTotal = (id: string, lineId: string, approvedTotalCents: number): Promise<RefundLine> =>
  sendJson<RefundLine>(`/review/requests/${id}/lines/${lineId}/approved-total`, 'PUT', { approvedTotalCents })

/** `POST /review/requests/:id/approve` — whole-request, defaults untouched lines to their requested amount (AC-7.2). */
export const approve = (id: string): Promise<RefundRequestDetail> =>
  sendJson<RefundRequestDetail>(`/review/requests/${id}/approve`, 'POST', undefined)

/** `POST /review/requests/:id/reject` — requires non-empty `motivation` (422 if empty, AC-7.3; client disables until non-empty as defense-in-depth's first line). */
export const reject = (id: string, motivation: string): Promise<RefundRequestDetail> =>
  sendJson<RefundRequestDetail>(`/review/requests/${id}/reject`, 'POST', { motivation })
