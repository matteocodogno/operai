/**
 * batchesApi — typed accounting-facing operations against `refund-api`'s
 * monthly-processing batch endpoints (T9, specs/008-refund-monthly-
 * processing/tasks.md: "src/lib/batchesApi.ts: typed client functions for
 * the batch endpoints … against plan.md's contract, built on the existing
 * refundApi.ts helpers"), built on `./refundApi.ts`'s generic
 * `getJson`/`sendJson` plumbing exactly as `requestsApi.ts`/`reviewApi.ts`
 * already do.
 *
 * Shapes are transcribed verbatim from plan.md's "## API contracts" →
 * "### Shapes" (`CandidatePreview`/`BatchSummary`/`BatchDetail`) — `refund-api`
 * batch routes are NOT implemented yet as of this task (T1–T8 unchecked in
 * tasks.md), so this targets the DOCUMENTED contract, the same
 * "build-against-the-contract-not-a-running-service" posture `requestsApi.ts`/
 * `reviewApi.ts` themselves used against their own not-yet-built endpoints
 * (see those files' own doc comments) — every test mocks `apiFetch`.
 *
 * `BatchSubtotal` is deliberately a NEW, lighter type than `./subtotals.ts`'s
 * `Subtotal` — a batch/candidate subtotal on the wire is `{currency,
 * approvedCents}` only (plan.md's `CandidatePreview`/`BatchSummary`/
 * `BatchDetail` shapes), never `requestedCents`, because every request a
 * batch can contain is already `approved` — "requested" isn't a meaningful
 * second figure at the batch level (design.md's Component inventory,
 * `BatchSubtotalsPanel` entry, makes the identical observation for the T10
 * component this type feeds).
 */

import type { RequestStatus } from '../components/RequestStatusBadge'
import type { Currency } from './money'
import { getJson, sendJson } from './refundApi'

// ---------------------------------------------------------------------------
// Shapes (plan.md "## API contracts" → "### Shapes")
// ---------------------------------------------------------------------------

export type BatchStatus = 'compiled' | 'paid' | 'discarded'

/** A batch's email delivery status (plan.md `RefundBatch.emailStatus`) — `null` only pre-first-attempt. */
export type BatchEmailStatus = 'sent' | 'failed' | null

/** One currency's approved total for a batch/candidate set — never blended (plan.md "### Money"). */
export type BatchSubtotal = {
  currency: Currency
  approvedCents: number
}

export type BatchOwner = {
  userId: string
  email: string
  name: string | null
}

/** One employee's candidate group within a `CandidatePreview` (dry run — request ids only, nothing persisted yet to link to). */
export type CandidateEmployeeGroup = {
  owner: BatchOwner
  requestIds: string[]
  subtotals: BatchSubtotal[]
}

/** `GET /batches/candidates` response — a dry run, writes nothing (US-1/US-2 preview). */
export type CandidatePreview = {
  cutoff: string
  requestCount: number
  subtotals: BatchSubtotal[]
  employees: CandidateEmployeeGroup[]
}

/** One row of `GET /batches` (history, AC-8.1). */
export type BatchSummary = {
  id: string
  cutoff: string
  status: BatchStatus
  requestCount: number
  subtotals: BatchSubtotal[]
  emailStatus: BatchEmailStatus
  createdAt: string
}

/** One request row within a `BatchDetail` employee group — real, persisted requests (unlike `CandidateEmployeeGroup`'s bare ids). */
export type BatchRequestRow = {
  id: string
  status: RequestStatus
  subtotals: BatchSubtotal[]
}

export type BatchEmployeeGroup = {
  owner: BatchOwner
  requests: BatchRequestRow[]
}

/** `GET /batches/:id` (and the 200/201 body of compile/mark-paid/discard) — AC-2.1. */
export type BatchDetail = {
  id: string
  cutoff: string
  status: BatchStatus
  requestCount: number
  createdBy: { userId: string; email: string }
  createdAt: string
  subtotals: BatchSubtotal[]
  employees: BatchEmployeeGroup[]
  email: { status: BatchEmailStatus; lastAttemptAt: string | null }
  paidAt: string | null
  paidBy: string | null
  discardedAt: string | null
  discardedBy: string | null
  /** Minted post-authz, ~60s fresh — `BatchPdfLink` (T10) re-mints via `getPdfUrl` rather than trusting this on a long-lived screen. */
  pdf: { url: string; expiresAt: string }
}

export type PdfUrlResponse = { url: string; expiresAt: string }

export type SendEmailResponse = { emailStatus: BatchEmailStatus; emailDeliveryId?: string }

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** `GET /batches/candidates?cutoff=<ISO?>` — dry run, entity-scoped via `scopeForReviewAction` server-side (AC-1.2). `403` if `request:review` is entirely absent (AC-1.8). */
export const listCandidates = (cutoff?: string): Promise<CandidatePreview> =>
  getJson<CandidatePreview>(`/batches/candidates${cutoff ? `?cutoff=${encodeURIComponent(cutoff)}` : ''}`)

/** `POST /batches` — compile (atomic claim). `422` on an empty candidate set (AC-1.4); `403` without `request:review` (AC-1.8). */
export const compile = (cutoff?: string): Promise<BatchDetail> =>
  sendJson<BatchDetail>('/batches', 'POST', { cutoff })

/** `GET /batches` — history, every status (AC-8.2), NOT entity-scoped (plan.md Resolved decision D1). */
export const list = (): Promise<BatchSummary[]> => getJson<BatchSummary[]>('/batches')

/** `GET /batches/:id` — full detail incl. a fresh `pdf` link. `404` if the batch doesn't exist. */
export const get = (id: string): Promise<BatchDetail> => getJson<BatchDetail>(`/batches/${id}`)

/** `GET /batches/:id/pdf-url` — mints a short-lived (~60s) authz-gated presigned GET, accounting-only (AC-3.4). */
export const getPdfUrl = (id: string): Promise<PdfUrlResponse> => getJson<PdfUrlResponse>(`/batches/${id}/pdf-url`)

/** `POST /batches/:id/email` — send/resend, available regardless of the batch's status (AC-3.3). */
export const sendEmail = (id: string): Promise<SendEmailResponse> =>
  sendJson<SendEmailResponse>(`/batches/${id}/email`, 'POST', undefined)

/** `POST /batches/:id/mark-paid` — terminal CAS. `409` if not `compiled` (AC-4.3); `403` without `request:approve` specifically (AC-4.4). */
export const markPaid = (id: string): Promise<BatchDetail> =>
  sendJson<BatchDetail>(`/batches/${id}/mark-paid`, 'POST', undefined)

/** `POST /batches/:id/discard` — terminal CAS. `409` if not `compiled` (AC-6.2). */
export const discard = (id: string): Promise<BatchDetail> =>
  sendJson<BatchDetail>(`/batches/${id}/discard`, 'POST', undefined)
