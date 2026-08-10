/**
 * collaboratorsApi — typed API client for estimai-api's five collaborator
 * endpoints (T15, specs/013-estimate-sharing/tasks.md; plan.md "### `estimai-api`
 * — new (all under the existing `estimatesRouter`…)"). Reuses `estimatesApi`'s
 * `ApiError`/`ApiProblem`/`EstimateIdentity` rather than redeclaring them —
 * both clients share one RFC 7807 Problem shape and one embedded-identity
 * vocabulary.
 *
 * All requests go through `apiFetch` (ADR-0001) — same interceptor, same
 * Bearer-JWT/401-retry contract as estimatesApi.ts. Never a second fetch path.
 *
 * Error-code discrimination:
 *   Every failure mode the contract table names a stable `code` for gets its
 *   own `ApiError` subclass (below), so a caller (T20's `CollaboratorsDialog`)
 *   can `instanceof`-branch onto a designed, reachable state — e.g. the
 *   generic 422 (`CollaboratorNotEligibleError`, AC-1.2's "no variant, ever"
 *   rejection) vs. the 409 "already a collaborator" (`AlreadyCollaboratorError`)
 *   — without parsing `detail` strings. A `code`-less non-2xx (the plain 404s
 *   the contract table leaves unnamed) throws the base `ApiError`.
 */

import { apiFetch } from './api'
import { ApiError } from './estimatesApi'
import type { ApiProblem, EstimateIdentity } from './estimatesApi'
import type { AccessLevel } from '../components/AccessLevelBadge'

// ---------------------------------------------------------------------------
// Shared shapes (mirrors the plan.md API contracts)
// ---------------------------------------------------------------------------

/**
 * One collaborator grant, as returned by all five endpoints. `id` is the
 * GRANT's id — never the collaborator's `sub` (plan.md: "user ids are not
 * put into URLs or list payloads").
 */
export type CollaboratorGrant = {
  id: string
  email: string
  accessLevel: AccessLevel
  createdAt: string
  identity: EstimateIdentity
}

/** Response body of `GET /estimates/:id/collaborators`. */
export type CollaboratorListResponse = {
  collaborators: CollaboratorGrant[]
}

/** Request body of `POST /estimates/:id/collaborators`. */
export type AddCollaboratorRequest = {
  email: string
  accessLevel: AccessLevel
}

/** Request body of `PATCH /estimates/:id/collaborators/:collaboratorId`. */
export type UpdateCollaboratorLevelRequest = {
  accessLevel: AccessLevel
}

// ---------------------------------------------------------------------------
// Typed error classes — one per named `code` in the contract table
// ---------------------------------------------------------------------------

/**
 * 403, `code: "owner_only"` — the caller is a collaborator, not the owner.
 * Thrown by all four owner-only routes (list, add, update level, remove).
 */
export class OwnerOnlyError extends ApiError {
  constructor(problem: ApiProblem) {
    super(problem)
    this.name = 'OwnerOnlyError'
  }
}

/** 400, `code: "invalid_input"` — malformed email or `accessLevel` (`POST`). */
export class InvalidInputError extends ApiError {
  constructor(problem: ApiProblem) {
    super(problem)
    this.name = 'InvalidInputError'
  }
}

/**
 * 409, `code: "already_collaborator"` (AC-1.3) — `detail` names the existing
 * level and points at `PATCH` instead.
 */
export class AlreadyCollaboratorError extends ApiError {
  constructor(problem: ApiProblem) {
    super(problem)
    this.name = 'AlreadyCollaboratorError'
  }
}

/** 422, `code: "cannot_share_with_self"` (AC-1.4) — owner tried to add themselves. */
export class CannotShareWithSelfError extends ApiError {
  constructor(problem: ApiProblem) {
    super(problem)
    this.name = 'CannotShareWithSelfError'
  }
}

/**
 * 422, `code: "collaborator_not_eligible"` — THE generic rejection (AC-1.2).
 * One fixed status/code/detail for both "no such user" and "user lacks
 * EstimAI access" — never a variant. Callers must render `detail` verbatim
 * (`strings.sharing.errors.notEligible`), never paraphrase it.
 */
export class CollaboratorNotEligibleError extends ApiError {
  constructor(problem: ApiProblem) {
    super(problem)
    this.name = 'CollaboratorNotEligibleError'
  }
}

/**
 * 429, `code: "rate_limited"` (`POST` only — the handler's rate limiter
 * "counts EVERY attempt"). Carries `retryAfterSeconds`, parsed from the
 * response's `Retry-After` header when present and numeric.
 */
export class RateLimitedError extends ApiError {
  readonly retryAfterSeconds: number | undefined

  constructor(problem: ApiProblem, retryAfterSeconds: number | undefined) {
    super(problem)
    this.name = 'RateLimitedError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * 503, `code: "authorization_service_unavailable"` — `auth`'s eligibility
 * check was unreachable; the request fails closed rather than guessing.
 */
export class AuthorizationServiceUnavailableError extends ApiError {
  constructor(problem: ApiProblem) {
    super(problem)
    this.name = 'AuthorizationServiceUnavailableError'
  }
}

/**
 * 404, `code: "not_a_collaborator"` — `DELETE …/collaborators/me` only.
 * Distinct from the other, code-less 404s ("no relationship at all"): this
 * one means a relationship exists but it's ownership, not a grant (AC-6.2 —
 * an owner has no grant to leave).
 */
export class NotACollaboratorError extends ApiError {
  constructor(problem: ApiProblem) {
    super(problem)
    this.name = 'NotACollaboratorError'
  }
}

/** Maps a Problem's `code` to its typed `ApiError` subclass constructor. */
const ERROR_CLASS_BY_CODE: Record<string, new (problem: ApiProblem) => ApiError> = {
  owner_only: OwnerOnlyError,
  invalid_input: InvalidInputError,
  already_collaborator: AlreadyCollaboratorError,
  cannot_share_with_self: CannotShareWithSelfError,
  collaborator_not_eligible: CollaboratorNotEligibleError,
  authorization_service_unavailable: AuthorizationServiceUnavailableError,
  not_a_collaborator: NotACollaboratorError,
}

/** Parses the `Retry-After` header (seconds, per RFC 7231) — `undefined` if absent/non-numeric. */
const parseRetryAfterSeconds = (response: Response): number | undefined => {
  const header = response.headers.get('Retry-After')
  if (header === null) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) ? seconds : undefined
}

/**
 * Parses a non-2xx Response as an RFC 7807 Problem and throws the `code`-
 * specific `ApiError` subclass (falling back to the base `ApiError` for a
 * `code`-less or unrecognized response) — mirrors `estimatesApi.ts`'s
 * `throwFromResponse`, extended with the code→class dispatch this module adds.
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

  if (problem.code === 'rate_limited') {
    throw new RateLimitedError(problem, parseRetryAfterSeconds(response))
  }
  const ErrorClass = problem.code !== undefined ? ERROR_CLASS_BY_CODE[problem.code] : undefined
  throw new (ErrorClass ?? ApiError)(problem)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the base URL for one estimate's collaborator endpoints — never hardcoded. */
const apiBase = (estimateId: string): string =>
  `${import.meta.env.VITE_API_URL as string}/estimates/${estimateId}/collaborators`

const jsonHeaders = { 'Content-Type': 'application/json' }

// ---------------------------------------------------------------------------
// API operations
// ---------------------------------------------------------------------------

/**
 * GET /estimates/:id/collaborators (owner only)
 * Returns the estimate's collaborator grants. Throws `OwnerOnlyError` (403)
 * or the base `ApiError` (404 — no relationship).
 */
export const list = async (estimateId: string): Promise<CollaboratorGrant[]> => {
  const response = await apiFetch(apiBase(estimateId))
  if (!response.ok) {
    return throwFromResponse(response)
  }
  const body = (await response.json()) as CollaboratorListResponse
  return body.collaborators
}

/**
 * POST /estimates/:id/collaborators (owner only, US-1)
 * Adds a collaborator by email + access level. Returns the created grant (201).
 * Throws `InvalidInputError` (400), `OwnerOnlyError` (403), `ApiError` (404),
 * `AlreadyCollaboratorError` (409), `CannotShareWithSelfError` /
 * `CollaboratorNotEligibleError` (422), `RateLimitedError` (429), or
 * `AuthorizationServiceUnavailableError` (503).
 */
export const add = async (estimateId: string, request: AddCollaboratorRequest): Promise<CollaboratorGrant> => {
  const response = await apiFetch(apiBase(estimateId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<CollaboratorGrant>
}

/**
 * PATCH /estimates/:id/collaborators/:collaboratorId (owner only, AC-5.1)
 * Changes a collaborator's access level. Returns the updated grant (200).
 * Throws `OwnerOnlyError` (403) or the base `ApiError` (404 — estimate or
 * grant not found). No notification is sent (AC-7.3) — nothing for the
 * client to do about that; it's a server-side fact.
 */
export const updateLevel = async (
  estimateId: string,
  collaboratorId: string,
  request: UpdateCollaboratorLevelRequest,
): Promise<CollaboratorGrant> => {
  const response = await apiFetch(`${apiBase(estimateId)}/${collaboratorId}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<CollaboratorGrant>
}

/**
 * DELETE /estimates/:id/collaborators/:collaboratorId (owner only, AC-5.2)
 * Removes a collaborator's grant (204). Throws `OwnerOnlyError` (403) or the
 * base `ApiError` (404 — estimate or grant not found).
 */
export const remove = async (estimateId: string, collaboratorId: string): Promise<void> => {
  const response = await apiFetch(`${apiBase(estimateId)}/${collaboratorId}`, {
    method: 'DELETE',
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
}

/**
 * DELETE /estimates/:id/collaborators/me (self, US-6)
 * Removes the caller's OWN grant (204) — no notification is sent (AC-7.2
 * excludes self-leave). Throws `NotACollaboratorError` (404 — includes the
 * owner, AC-6.2: an owner has no grant to leave).
 */
export const leave = async (estimateId: string): Promise<void> => {
  const response = await apiFetch(`${apiBase(estimateId)}/me`, {
    method: 'DELETE',
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
}
