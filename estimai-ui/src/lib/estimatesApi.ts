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
 */

import { apiFetch } from './api'
import type { Activity, Parameters, Release } from '../types'

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
 * Shape returned by GET /estimates (list view — no content field).
 */
export type EstimateListItem = {
  id: string
  name: string
  author: string
  updatedAt: string
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
 * responses.
 */
export type ApiProblem = {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
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

  constructor(problem: ApiProblem) {
    super(problem.title)
    this.name = 'ApiError'
    this.status = problem.status
    this.title = problem.title
    this.detail = problem.detail
    this.instance = problem.instance
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
 * Updates an estimate in place (last-write-wins). Returns the updated full
 * estimate. Throws ApiError on 404, 413 (size), or 401.
 */
export const update = async (id: string, body: EstimateUpsert): Promise<EstimateFull> => {
  const response = await apiFetch(`${apiBase()}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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
