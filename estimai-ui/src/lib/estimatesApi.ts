/**
 * estimatesApi — typed API client for the estimai-api /estimates endpoints.
 *
 * All requests are routed through `apiFetch`, which:
 *   • Attaches `Authorization: Bearer <jwt>` to requests targeting VITE_API_URL
 *     (a trusted origin per ADR-0001 — no change to api.ts required).
 *   • Handles 401 token-refresh-retry-redirect transparently.
 *
 * Error handling:
 *   Non-2xx responses are parsed as RFC 7807 Problem JSON (if the Content-Type
 *   is `application/problem+json` or the body is a JSON object with `status`).
 *   An `ApiError` is thrown in every non-2xx case so callers can distinguish
 *   error types (e.g. 413 size rejection from AC-1.4 vs. generic failures).
 *
 * Base URL:
 *   Always read from `import.meta.env.VITE_API_URL` — never hardcoded.
 *
 * Optimistic concurrency (T15, specs/013-estimate-sharing/tasks.md; plan.md
 * "### Optimistic concurrency (US-4)", ADR-0038): `PUT /estimates/:id`
 * REQUIRES an `If-Match: "<version>"` precondition — an absent/malformed one
 * is a 428, never a silent last-write-wins fallback. `update()` therefore
 * takes the caller's currently-known `version` as a required parameter and
 * always sends it; there is no 2-arg overload. Both 409 (version mismatch)
 * and 428 (missing/malformed precondition) reject with the SAME `ConflictError`
 * subclass, per plan.md: "both 409 and 428 funnel to the same ConflictError
 * path" — one thing for callers (T16's autosave-suspension logic) to catch.
 * `currentVersion`/`lastModifiedBy` are populated by the server on 409; they
 * are `undefined` on 428, since there is nothing to compare against yet.
 */

import { apiFetch } from './api'
import type { Activity, Parameters, Release } from '../types'
import type { AccessLevel } from '../components/AccessLevelBadge'
import type { IdentityStatus } from './identity'

// ---------------------------------------------------------------------------
// Shared shapes (mirrors the plan.md API contracts)
// ---------------------------------------------------------------------------

/**
 * The stored estimate payload — verbatim JSONB content, mirrors UI ProjectData
 * minus id/name/author.
 */
export type EstimateContent = {
  params: Parameters
  releases: Release[]
  acts: Activity[]
}

/**
 * Request body for POST /estimates and PUT /estimates/:id.
 */
export type EstimateUpsert = {
  name: string
  author: string
  content: EstimateContent
}

/**
 * The caller's relationship to an estimate (plan.md "### `estimai-api` —
 * modified"). `AccessLevel` (viewer|editor) is the grant-level union already
 * established by T14's `AccessLevelBadge`; `owner` is not a grant, so it is
 * added on top here rather than folding it into that component's type.
 */
export type EstimateAccess = AccessLevel | 'owner'

/**
 * Id-less, already-resolved identity snapshot embedded inline on estimate/
 * collaborator responses (plan.md "### Display identity"): `owner` on
 * `EstimateListItem`/`EstimateFull` and `lastModifiedBy` on a 409 conflict.
 * Deliberately distinct from `Identity` (./identity.ts), which is keyed by
 * `id` for the batch `auth POST /authz/users/identities` lookup — these
 * embedded shapes never echo an id back. Reuses `IdentityStatus` so both
 * shapes share one tri-state vocabulary (T14's `formatIdentity` reads only
 * `.status`/`.name`, so it accepts this shape too despite the missing `id`).
 */
export type EstimateIdentity = {
  status: IdentityStatus
  name: string | null
}

/**
 * Shape returned by GET /estimates (list view — no content field).
 */
export type EstimateListItem = {
  id: string
  name: string
  author: string
  updatedAt: string
  access: EstimateAccess
  /** `null` when `access === 'owner'` — there is no "owner of your own estimate" to resolve. */
  owner: EstimateIdentity | null
}

/**
 * Shape returned by GET /estimates/:id, POST /estimates, and PUT /estimates/:id.
 */
export type EstimateFull = {
  id: string
  name: string
  author: string
  content: EstimateContent
  createdAt: string
  updatedAt: string
  /** Optimistic-concurrency token (ADR-0038) — send back as `If-Match` on the next `update()`. */
  version: number
  access: EstimateAccess
  owner: EstimateIdentity | null
  /** Present only when `access === 'owner'` (plan.md). */
  collaboratorCount?: number
}

/**
 * One element in the POST /estimates/import request body.
 */
export type EstimateImportItem = {
  localId: string
} & EstimateUpsert

/**
 * Result for a single import element in the POST /estimates/import response.
 */
export type EstimateImportResult = {
  localId: string
  status: 'imported' | 'failed'
  id?: string
  error?: string
}

/**
 * RFC 7807 Problem JSON shape — returned by estimai-api for all non-2xx
 * responses. `code` is a stable, i18n-safe machine-readable discriminator
 * some errors carry on top of `status` (plan.md "## API contracts": "extended
 * with a stable machine-readable `code` on the new failure modes" — the same
 * precedent ADR-0026/0029 set in refund-api's `ApiProblem`), e.g.
 * `"estimate_version_conflict"`, `"precondition_required"`, `"owner_only"`.
 */
export type ApiProblem = {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  code?: string
}

// ---------------------------------------------------------------------------
// Typed error class
// ---------------------------------------------------------------------------

/**
 * Thrown by every estimatesApi function on a non-2xx response.
 *
 * Callers can check `error.status` to distinguish specific cases:
 *   • 413 — estimate content exceeds the size limit (AC-1.4)
 *   • 401 — unauthenticated (handled upstream by apiFetch, but included for
 *            completeness in case the redirect is suppressed in tests)
 *   • 404 — not found or not owned (AC-4.1)
 */
export class ApiError extends Error {
  readonly status: number
  readonly title: string
  readonly detail: string | undefined
  readonly instance: string | undefined
  readonly code: string | undefined

  constructor(problem: ApiProblem) {
    super(problem.title)
    this.name = 'ApiError'
    this.status = problem.status
    this.title = problem.title
    this.detail = problem.detail
    this.instance = problem.instance
    this.code = problem.code
  }
}

/**
 * Thrown by `update()` on 409 (`code: "estimate_version_conflict"` — a real
 * version mismatch, AC-4.1) and 428 (`code: "precondition_required"` — a
 * missing/malformed `If-Match`) — plan.md's deliberate design: "both 409 and
 * 428 funnel to the same ConflictError path" so callers (T16) have exactly
 * one thing to catch and one UX to show (ADR-0038: 428 maps to the same
 * "reload required" flow as 409). `currentVersion`/`updatedAt`/`lastModifiedBy`
 * are the server's best-effort context on a 409; they are `undefined` on 428
 * (there is nothing yet to compare against) — callers must not assume they
 * are defined.
 */
export class ConflictError extends ApiError {
  readonly currentVersion: number | undefined
  readonly updatedAt: string | undefined
  readonly lastModifiedBy: EstimateIdentity | undefined

  constructor(
    problem: ApiProblem & {
      currentVersion?: number
      updatedAt?: string
      lastModifiedBy?: EstimateIdentity
    },
  ) {
    super(problem)
    this.name = 'ConflictError'
    this.currentVersion = problem.currentVersion
    this.updatedAt = problem.updatedAt
    this.lastModifiedBy = problem.lastModifiedBy
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the base URL for all estimate endpoints — never hardcoded. */
const apiBase = (): string => `${import.meta.env.VITE_API_URL as string}/estimates`

/**
 * Parses a non-2xx Response as an RFC 7807 Problem and throws an `ApiError`.
 * If the response body cannot be parsed as a Problem object, a synthetic
 * Problem is constructed from the HTTP status.
 */
const throwFromResponse = async (response: Response): Promise<never> => {
  let problem: ApiProblem
  try {
    const body = (await response.json()) as Partial<ApiProblem>
    problem = {
      type: body.type ?? `https://httpstatuses.com/${response.status}`,
      title: body.title ?? response.statusText,
      status: body.status ?? response.status,
      detail: body.detail,
      instance: body.instance,
      code: body.code,
    }
  } catch {
    problem = {
      type: `https://httpstatuses.com/${response.status}`,
      title: response.statusText || String(response.status),
      status: response.status,
    }
  }
  throw new ApiError(problem)
}

/**
 * Parses a 409/428 response and throws `ConflictError` (never the base
 * `ApiError`) — see `ConflictError`'s doc comment for why both statuses
 * share one path. Mirrors `throwFromResponse`'s malformed-body fallback.
 */
const throwConflictFromResponse = async (response: Response): Promise<never> => {
  type ConflictBody = Partial<ApiProblem> & {
    currentVersion?: number
    updatedAt?: string
    lastModifiedBy?: EstimateIdentity
  }
  let body: ConflictBody = {}
  try {
    body = (await response.json()) as ConflictBody
  } catch {
    // Fall through with an empty body — the synthetic Problem below still carries the status.
  }
  throw new ConflictError({
    type: body.type ?? `https://httpstatuses.com/${response.status}`,
    title: body.title ?? response.statusText,
    status: response.status,
    detail: body.detail,
    instance: body.instance,
    code: body.code,
    currentVersion: body.currentVersion,
    updatedAt: body.updatedAt,
    lastModifiedBy: body.lastModifiedBy,
  })
}

// ---------------------------------------------------------------------------
// API operations
// ---------------------------------------------------------------------------

/**
 * POST /estimates
 * Creates a new estimate. Returns the full created estimate (201).
 * Throws ApiError on 400 (validation), 413 (size), or 401.
 */
export const create = async (body: EstimateUpsert): Promise<EstimateFull> => {
  const response = await apiFetch(apiBase(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<EstimateFull>
}

/**
 * GET /estimates
 * Returns the current user's estimates (list view, no content field).
 * Returns [] when the user has no estimates (AC-2.3). Throws ApiError on 401.
 */
export const list = async (): Promise<EstimateListItem[]> => {
  const response = await apiFetch(apiBase())
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<EstimateListItem[]>
}

/**
 * GET /estimates/:id
 * Returns the full estimate. Throws ApiError on 404 (not found / not owned)
 * or 401.
 */
export const get = async (id: string): Promise<EstimateFull> => {
  const response = await apiFetch(`${apiBase()}/${id}`)
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<EstimateFull>
}

/**
 * PUT /estimates/:id
 * Updates an estimate in place, guarded by optimistic concurrency (ADR-0038,
 * US-4). `version` is REQUIRED — it is the caller's last-known
 * `EstimateFull.version`/the version this `update()` adopted last time — and
 * is always sent as `If-Match: "<version>"`; there is no way to call this
 * without it, matching the server's "absent precondition → 428" contract
 * (an omitted argument would be exactly the silent last-write-wins fallback
 * the API deliberately refuses to offer).
 *
 * Returns the updated full estimate (its `.version` is the new version to
 * adopt for the next call). Throws:
 *   • `ConflictError` on 409 (a real version mismatch) or 428 (missing/
 *     malformed precondition) — see `ConflictError`'s doc comment.
 *   • `ApiError` on 404 (no relationship), 403 (`code: "insufficient_access"`
 *     — viewer, AC-3.1), 413 (size), 400 (validation), or 401.
 */
export const update = async (
  id: string,
  body: EstimateUpsert,
  version: number,
): Promise<EstimateFull> => {
  const response = await apiFetch(`${apiBase()}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': `"${version}"` },
    body: JSON.stringify(body),
  })
  if (response.status === 409 || response.status === 428) {
    return throwConflictFromResponse(response)
  }
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<EstimateFull>
}

/**
 * DELETE /estimates/:id
 * Deletes the estimate (204). Throws ApiError on 404 or 401.
 */
export const remove = async (id: string): Promise<void> => {
  const response = await apiFetch(`${apiBase()}/${id}`, {
    method: 'DELETE',
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
}

/**
 * POST /estimates/import
 * Bulk-imports legacy localStorage estimates. Each element is imported in its
 * own transaction; per-element failures do not abort the batch. The endpoint
 * always returns 200 for a well-formed request; per-estimate outcomes are in
 * `results`.
 *
 * Throws ApiError only on a malformed request (400) or 401.
 */
export const importEstimates = async (
  estimates: EstimateImportItem[],
): Promise<{ results: EstimateImportResult[] }> => {
  const response = await apiFetch(`${apiBase()}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estimates }),
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<{ results: EstimateImportResult[] }>
}
