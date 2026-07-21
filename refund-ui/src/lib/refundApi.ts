/**
 * refundApi — thin, generic infrastructure for calling `refund-api` (T14,
 * specs/007-refund-service/tasks.md: "API client: a thin module using
 * shell/session's apiFetch … Base URL from env/runtime config per-env").
 *
 * This task ships the FOUNDATION only — no `refund-api` endpoint exists yet
 * (plan.md: "refund-api does not exist yet … this plan bootstraps it", T4).
 * So unlike `admin-ui/src/lib/adminApi.ts` / `estimai-ui/src/lib/estimatesApi.ts`
 * (typed functions per operation, `GET /admin/roles`, `POST /estimates`, …),
 * this file exposes only the reusable PLUMBING every later domain module
 * (T16's requests/lines, T17's attachments, T18's review/decide) will build
 * its typed operations on top of: the base URL, the RFC-7807 `ApiError`
 * shape (mirrors every other Operai service, plan.md "## API contracts": "All
 * errors are RFC-7807 Problem JSON"), and `getJson`/`sendJson`/`deleteJson`
 * helpers identical in contract to adminApi.ts's own (same non-2xx →
 * `ApiError` behavior), so T16–T18 add e.g. `src/lib/requestsApi.ts` with
 * `getJson<RefundRequest[]>('/requests')` rather than re-deriving this
 * plumbing three times.
 *
 * Base URL — own env, NOT the shell's `getAuthBaseUrl()`:
 *   `refund-api` is a sibling RESOURCE SERVER (like `estimai-api`), not the
 *   auth service — there is no federated `shell/session` getter for it (only
 *   `getAuthBaseUrl()` exists, for auth-service routes admin-ui calls). So
 *   this mirrors `estimai-ui/src/lib/estimatesApi.ts`'s own convention
 *   instead: read `import.meta.env.VITE_REFUND_API_URL` directly — refund-ui's
 *   OWN build-time env var (`.env.example`), never build-baked into a shared
 *   constant, never hardcoded (T14's own instruction: "Base URL from
 *   env/runtime config per-env").
 *
 * Auth — `apiFetch` from `shell/session` (ADR-0001/ADR-0006): attaches the
 * Bearer JWT and handles the 401 refresh-retry-redirect transparently, but
 * ONLY for requests targeting an origin the shell's own trusted-origins
 * allowlist recognizes (`shell/src/lib/session.ts`'s `getTrustedOrigins()`).
 *
 *   DRIFT (flagged in this task's implementation report, not fixed here —
 *   out of this task's `refund-ui/src/` touch scope): that allowlist today
 *   covers `VITE_AUTH_URL`/`VITE_API_URL`/`VITE_NOTIFY_API_URL` only — no
 *   refund-api entry exists. specs/005-notification-center added its own
 *   `VITE_NOTIFY_API_URL` origin via a DEDICATED shell task (its T10,
 *   "notification seam in shell/session"); specs/007's tasks.md has no
 *   equivalent task for refund-api's origin (T19 "devops" and T20
 *   "federation & routing" both come close but neither explicitly owns this).
 *   Until `shell/src/lib/session.ts` trusts `VITE_REFUND_API_URL`, `apiFetch`
 *   will silently send every refund-api request WITHOUT a Bearer header
 *   (unauthenticated pass-through — see that function's own "untrusted
 *   origin" branch), and refund-api will 401 everything. This file is
 *   correct and ready the moment that allowlist is updated; it cannot fix it
 *   itself without touching `shell/src`.
 */

import { apiFetch } from 'shell/session'

/** Returns refund-api's base URL — never hardcoded, never build-baked. */
export const refundApiBase = (): string => import.meta.env.VITE_REFUND_API_URL as string

/**
 * RFC 7807 Problem JSON shape — returned by refund-api for all non-2xx
 * responses (plan.md "## API contracts": "All errors are RFC-7807 Problem
 * JSON (type,title,status,detail,instance)"). Mirrors adminApi.ts/
 * estimatesApi.ts's `ApiProblem`, PLUS an optional `code` extension member
 * (specs/010-self-approval-control, plan.md D5 / ADR-0026): a stable,
 * i18n-safe discriminator some 403s carry (e.g. `"self_approval_forbidden"`)
 * to distinguish them from other same-status denials without parsing the
 * (localized/variable) `detail` string.
 */
export type ApiProblem = {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  code?: string
}

/**
 * Thrown by every refund-api call helper below on a non-2xx response.
 * Callers branch on `error.status` — refund-api's own contract table
 * (plan.md) names 401/403/404/409/422/503 across its various routes. `code`
 * is the optional stable discriminator some 403s carry (specs/010); absent
 * on most errors, including the pre-existing capability-absent 403.
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
 * Parses a non-2xx Response as an RFC 7807 Problem and throws an `ApiError`.
 * If the response body cannot be parsed as a Problem object, a synthetic
 * Problem is constructed from the HTTP status (mirrors adminApi.ts/
 * estimatesApi.ts's `throwFromResponse` verbatim).
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

const jsonHeaders = { 'Content-Type': 'application/json' }

/** GET helper — no body, throws ApiError on non-2xx. `path` is refund-api-root-relative (e.g. `/requests`). */
export const getJson = async <T>(path: string): Promise<T> => {
  const response = await apiFetch(`${refundApiBase()}${path}`)
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<T>
}

/** POST/PUT/PATCH helper — JSON body, throws ApiError on non-2xx. */
export const sendJson = async <T>(path: string, method: string, body: unknown): Promise<T> => {
  const response = await apiFetch(`${refundApiBase()}${path}`, {
    method,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<T>
}

/** DELETE helper — no request body. Resolves to `undefined` on a bodyless 204. Throws ApiError on non-2xx. */
export const deleteJson = async (path: string): Promise<void> => {
  const response = await apiFetch(`${refundApiBase()}${path}`, { method: 'DELETE' })
  if (!response.ok) {
    return throwFromResponse(response)
  }
}
