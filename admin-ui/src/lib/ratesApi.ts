/**
 * ratesApi — typed API client for refund-api's mileage-rate management
 * surface (T10, specs/009-mileage-rate/tasks.md, plan.md "API contracts" /
 * "admin-ui → refund-api call path" decision).
 *
 * Mirrors `./adminApi.ts`'s conventions exactly (typed request/response
 * shapes, an `ApiError` built from RFC 7807 Problem JSON, one function per
 * operation, `getJson`/`sendJson` helpers) with the one difference the plan
 * calls out explicitly: the base URL is the **refund-api** origin, not the
 * auth service's — obtained from `shell/session`'s `getRefundApiBaseUrl()`
 * (T9), NOT admin-ui's own `import.meta.env.VITE_REFUND_API_URL` (a remote
 * ships no such env var, so reading it here yields `undefined` and the
 * request collapses to a broken relative URL). The shell owns the one
 * configured refund-api origin, exactly as it already does for auth
 * (`adminApi.ts`'s `authBase()`).
 *
 * Why admin-ui calls refund-api directly rather than proxying through auth:
 * plan.md's "admin-ui → refund-api call path" decision — the money domain
 * (rate persistence, resolution, computation) stays server-authoritative in
 * refund-api; hosting the *screen* in admin-ui makes admin-ui a cross-service
 * caller, gated by refund-api's own `authzMiddleware`/`hasCapability`
 * (`rate:read`/`rate:manage`) server-side, regardless of which UI calls it.
 * `apiFetch` (from `shell/session`) already treats refund-api as a trusted
 * origin (refund-ui's own calls establish that) and attaches the Bearer JWT +
 * handles the 401 refresh-retry-redirect transparently — no new trust
 * relationship is introduced here.
 *
 * Error handling:
 *   Non-2xx responses are parsed as RFC 7807 Problem JSON (mirrors
 *   `adminApi.ts`'s `throwFromResponse` verbatim) and thrown as `ApiError` so
 *   callers can branch on `error.status` — `403` without `rate:read`/
 *   `rate:manage`, `422` on a non-positive rate value or a missing/invalid
 *   `validFrom` (AC-4.5).
 */

import { apiFetch, getRefundApiBaseUrl } from 'shell/session'

// ---------------------------------------------------------------------------
// Shared shapes (mirrors plan.md's "API contracts" — Rate management section)
// ---------------------------------------------------------------------------

/** The two entities a mileage rate series can belong to (007's Entity enum). */
export type MileageRateEntity = 'welld_ch' | 'welld_it'

/** The entity-designated currency a rate series is denominated in (AC-1.6). */
export type MileageRateCurrency = 'CHF' | 'EUR'

/** One point in an entity's rate history (plan.md `MileageRate` — append-only). */
export type RateEntry = {
  id: string
  ratePerKmMicros: number
  /** Decimal string, for display only (e.g. "0.70") — plan.md's `GET /rates` shape. */
  ratePerKm: string
  /** ISO 8601 date-only (`YYYY-MM-DD`). */
  validFrom: string
  createdAt: string
  createdByEmail: string
  /** Whether this entry is the one in effect as of today (AC-4.3). */
  inEffectToday: boolean
}

/** One entity's full rate history (AC-4.1) — also the audit view (AC-5.3). */
export type EntityRates = {
  entity: MileageRateEntity
  currency: MileageRateCurrency
  /** The entry id in effect as of today, or null if none is (AC-4.3). */
  currentEntryId: string | null
  /** Chronological, oldest → newest (plan.md's documented `GET /rates` order). */
  entries: RateEntry[]
}

/** `GET /rates` response — full history for both entities. */
export type RatesResult = {
  entities: EntityRates[]
}

/** `POST /rates` request body — a positive per-km rate + a valid-from date (AC-4.2). */
export type AddRateInput = {
  entity: MileageRateEntity
  /** Decimal string (e.g. "0.72") — server derives `ratePerKmMicros` from this. */
  ratePerKm: string
  /** ISO 8601 date-only (`YYYY-MM-DD`); may be past, present, or future (AC-4.8/4.4). */
  validFrom: string
}

/**
 * RFC 7807 Problem JSON shape — returned by refund-api for all non-2xx
 * responses (mirrors `adminApi.ts`'s `ApiProblem` verbatim).
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
 * Thrown by every ratesApi function on a non-2xx response.
 *
 * Callers can check `error.status` to distinguish specific cases:
 *   • 401 — unauthenticated (handled upstream by apiFetch's refresh-retry, but
 *            included for completeness in case the redirect is suppressed)
 *   • 403 — authenticated but lacks `rate:read`/`rate:manage` (AC-4.6)
 *   • 422 — non-positive rate value or missing/invalid `validFrom` (AC-4.5)
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

/** Returns the base URL for refund-api — never hardcoded. */
// refund-api's base URL comes from the SHELL (shell/session), not admin-ui's
// own env: admin-ui ships no VITE_REFUND_API_URL, so reading
// import.meta.env here yields `undefined` and the request collapses to a
// broken relative URL (`.../rates/undefined/rates`). The shell owns the one
// configured origin — mirrors `adminApi.ts`'s `authBase()`.
const refundApiBase = (): string => getRefundApiBaseUrl()

/**
 * Parses a non-2xx Response as an RFC 7807 Problem and throws an `ApiError`.
 * If the response body cannot be parsed as a Problem object, a synthetic
 * Problem is constructed from the HTTP status (mirrors `adminApi.ts`).
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

const jsonHeaders = { 'Content-Type': 'application/json' }

/** GET helper — no body, throws ApiError on non-2xx. */
const getJson = async <T>(path: string): Promise<T> => {
  const response = await apiFetch(`${refundApiBase()}${path}`)
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response.json() as Promise<T>
}

/** POST helper — JSON body, throws ApiError on non-2xx. */
const sendJson = async <T>(path: string, method: string, body: unknown): Promise<T> => {
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

// ---------------------------------------------------------------------------
// Rate management
// ---------------------------------------------------------------------------

/**
 * GET /rates
 * Full per-entity rate history, current-in-effect flagged (AC-4.1/4.3; also
 * serves the audit view AC-5.3). Throws ApiError on 403 (missing `rate:read`)
 * or 401.
 */
export const listRates = async (): Promise<RatesResult> => getJson<RatesResult>('/rates')

/**
 * POST /rates
 * Appends one rate entry (AC-4.2). Returns the created entry (201). Throws
 * ApiError on 422 (non-positive value / bad `validFrom` — AC-4.5), 403
 * (missing `rate:manage`), or 401. There is no PUT/PATCH/DELETE — rate
 * entries are strictly append-only (AC-4.7).
 */
export const addRate = async (body: AddRateInput): Promise<RateEntry> =>
  sendJson<RateEntry>('/rates', 'POST', body)
