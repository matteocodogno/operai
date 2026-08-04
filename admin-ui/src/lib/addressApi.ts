/**
 * addressApi — typed API client for `auth`'s employee-address surface (T9,
 * specs/012-employee-address/tasks.md, refs AC-1.1, AC-1.2, AC-1.3, AC-5.3;
 * plan.md "API contracts").
 *
 * Mirrors `./adminApi.ts`/`./ratesApi.ts`'s conventions exactly (typed
 * request/response shapes, an `ApiError` built from RFC 7807 Problem JSON,
 * one function per operation, `getJson`/`sendJson` helpers) and is
 * self-contained the same way `ratesApi.ts` is — it does not extend
 * `adminApi.ts` even though both eventually call the `auth` origin, per this
 * repo's established "one file per domain" API-client convention.
 *
 * Base URL is the **auth service** origin (`/admin/users/{id}/address` and
 * `/admin/audit` are served there) — obtained from `shell/session`'s
 * `getAuthBaseUrl()`, exactly like `adminApi.ts`'s `authBase()`. Backend
 * counterpart (T3, T5, specs/012-employee-address/tasks.md) is being built
 * in parallel by another agent — this client is written strictly against
 * plan.md's documented contract, not against a live implementation.
 *
 * `422` error handling: `PUT /admin/users/:id/address` can fail AC-1.4's
 * four-field completeness check with `code: "address_incomplete"` and a
 * `missingFields: string[]` array (plan.md "Shared shapes" + "PUT
 * /admin/users/{id}/address"). `ApiError` carries both so
 * `AddressSection.tsx` (T11) can render a per-field error without
 * re-parsing the `detail` prose string.
 */

import { apiFetch, getAuthBaseUrl } from 'shell/session'

// ---------------------------------------------------------------------------
// Shared shapes (plan.md "API contracts → Shared shapes")
// ---------------------------------------------------------------------------

/** The request body shape for a set/replace `PUT` (plan.md `AddressInput`). */
export type AddressInput = {
  countryCode: string
  city: string
  street: string
  houseNumber: string
  postalCode?: string | null
  region?: string | null
  latitude?: number | null
  longitude?: number | null
}

/** `AddressInput` plus the two server-derived fields every read response carries. */
export type AddressView = AddressInput & {
  /** Derived server-side from the structured components — never composed client-side (plan.md "formatted is derived, never stored"). */
  formatted: string
  updatedAt: string
}

/** The admin surface additionally exposes who last changed it (never exposed on `/me/address` — plan.md "least exposure"). */
export type AdminAddressView = AddressView & { updatedByUserId: string | null }

/** `GET`/`PUT /admin/users/{id}/address` response envelope — `address: null` means "no address on file". */
export type AdminAddressResponse = {
  userId: string
  address: AdminAddressView | null
}

/** One entry of the address-change history (AC-5.3) — `GET /admin/audit` row shape, scoped by the T5 filter. */
export type AddressHistoryEntry = {
  id: string
  actorUserId: string | null
  action: string
  targetType: string
  targetId: string | null
  summary: string
  data: { before?: unknown; after?: unknown } | null
  createdAt: string
}

export type Paginated<T> = {
  items: T[]
  page: number
  pageSize: number
  total: number
}

export type PageParams = {
  page?: number
  pageSize?: number
}

/**
 * RFC 7807 Problem JSON shape, extended with the `code`/`missingFields`
 * extension members the `422 address_incomplete` response carries (plan.md
 * "API contracts" preamble: "a `code` extension member where a caller must
 * distinguish causes").
 */
export type ApiProblem = {
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  code?: string
  missingFields?: string[]
}

// ---------------------------------------------------------------------------
// Typed error class
// ---------------------------------------------------------------------------

/**
 * Thrown by every addressApi function on a non-2xx response.
 *
 * Callers can check `error.status` to distinguish specific cases:
 *   • 401 — no session
 *   • 403 — authenticated but not an `admin` (`requireAdmin`, AC-4.1) —
 *            including against the caller's OWN id (plan.md's explicit
 *            "not yours = 404 does NOT apply here" posture)
 *   • 404 — target user unknown or soft-deleted
 *   • 422 — four-field completeness failed (AC-1.4); `error.code ===
 *            'address_incomplete'` and `error.missingFields` names exactly
 *            which of country/city/street/houseNumber are missing
 */
export class ApiError extends Error {
  readonly status: number
  readonly title: string
  readonly detail: string | undefined
  readonly instance: string | undefined
  readonly code: string | undefined
  readonly missingFields: string[] | undefined

  constructor(problem: ApiProblem) {
    super(problem.title)
    this.name = 'ApiError'
    this.status = problem.status
    this.title = problem.title
    this.detail = problem.detail
    this.instance = problem.instance
    this.code = problem.code
    this.missingFields = problem.missingFields
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the base URL for the auth service — never hardcoded (mirrors adminApi.ts's authBase()). */
const authBase = (): string => getAuthBaseUrl()

/** Builds a `?a=1&b=2` query string, omitting undefined/empty values. */
const buildQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Parses a non-2xx Response as an RFC 7807 Problem (including the
 * `code`/`missingFields` extension members) and throws an `ApiError`. If the
 * body cannot be parsed, a synthetic Problem is constructed from the HTTP
 * status (mirrors adminApi.ts's `throwFromResponse` verbatim).
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
      missingFields: body.missingFields,
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

/** GET helper — no body, throws ApiError on non-2xx. */
const getJson = async <T>(path: string): Promise<T> => {
  const response = await apiFetch(`${authBase()}${path}`)
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<T>
}

/** PUT helper — JSON body, throws ApiError on non-2xx. */
const sendJson = async <T>(path: string, method: string, body: unknown): Promise<T> => {
  const response = await apiFetch(`${authBase()}${path}`, {
    method,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Admin surface (plan.md "Admin surface")
// ---------------------------------------------------------------------------

/**
 * GET /admin/users/{id}/address
 * Returns the employee's currently-stored address, or `address: null` if
 * none has ever been set (AC-1.1). Throws ApiError on 401, 403 (not an
 * admin — including for the caller's own id), or 404 (unknown/soft-deleted
 * user).
 */
export const getAddress = async (userId: string): Promise<AdminAddressResponse> =>
  getJson<AdminAddressResponse>(`/admin/users/${userId}/address`)

/**
 * PUT /admin/users/{id}/address
 * One endpoint for BOTH set/replace (`address: AddressInput`) and
 * intentional clear (`address: null` — AC-1.3). Returns the same shape as
 * GET on success (200) — including on a no-op save (AC-5.4), which is
 * accepted but writes nothing server-side. Throws ApiError on 401, 403, 404,
 * or 422 (`code: "address_incomplete"` + `missingFields` — AC-1.4).
 */
export const putAddress = async (
  userId: string,
  address: AddressInput | null,
): Promise<AdminAddressResponse> =>
  sendJson<AdminAddressResponse>(`/admin/users/${userId}/address`, 'PUT', { address })

// ---------------------------------------------------------------------------
// Address change history (AC-5.3) — the additive T5 filter on the existing
// GET /admin/audit route.
// ---------------------------------------------------------------------------

export type AddressHistoryParams = PageParams

/**
 * GET /admin/audit?targetType=user&targetId={id}&action=user.address.set
 * The chronological (newest-first) change history for one employee's
 * address (AC-5.3) — a filtered view of the SAME audit route
 * `adminApi.listAudit` calls unfiltered, per plan.md's additive-only T5
 * change. Throws ApiError on 401 or 403 (not an admin).
 */
export const listAddressHistory = async (
  userId: string,
  params: AddressHistoryParams = {},
): Promise<Paginated<AddressHistoryEntry>> =>
  getJson<Paginated<AddressHistoryEntry>>(
    `/admin/audit${buildQuery({
      targetType: 'user',
      targetId: userId,
      action: 'user.address.set',
      page: params.page,
      pageSize: params.pageSize,
    })}`,
  )
