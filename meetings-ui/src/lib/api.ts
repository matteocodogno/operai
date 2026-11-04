/**
 * api — the one place meetings-ui talks HTTP (specs/021-meetings).
 *
 * Every authenticated call goes through `shell/session`'s `apiFetch`
 * (ADR-0001/ADR-0006): it attaches the Bearer JWT to trusted origins only and
 * handles the 401 refresh-retry-redirect. meetings-api's base URL comes from the
 * shell (`getMeetingsApiBaseUrl()`); the directory call to `auth` passes
 * `getAuthBaseUrl()` to `requestJson` itself.
 *
 * Non-2xx responses are RFC 7807 Problem JSON and become an `ApiError`:
 * `{status, code, detail, extras}`; `code` is the discriminator the UI switches
 * on (`version_conflict`, `chunks_missing`, `summary_limit`, …) and `extras`
 * holds its extension members (`missing`, `currentVersion`, `field`, `index`, …). A
 * network failure is not an ApiError: `fetch`'s rejection propagates.
 *
 * Optimistic concurrency (ADR-0038, plan.md § Concurrency): every mutation of
 * an existing template, transcript segment or summary carries `If-Match: "<version>"` —
 * `sendJson`'s `version` argument — and a 428/409 comes back as an ApiError the
 * page turns into the "reload" banner (`isStaleWrite`).
 */

import { apiFetch, getMeetingsApiBaseUrl } from 'shell/session'

/** Members of a Problem JSON body that `ApiError` models as named fields, not as extras. */
const STANDARD_MEMBERS = new Set(['type', 'title', 'status', 'detail', 'instance', 'code'])

export class ApiError extends Error {
  readonly status: number
  readonly title: string
  readonly code: string | undefined
  readonly detail: string | undefined
  /** Extension members of the Problem body, e.g. `{ serialNumber, assetId }` for `serial_conflict`. */
  readonly extras: Readonly<Record<string, unknown>>
  /** `Retry-After` in whole seconds, or null when absent or not an integer (HTTP-date form is not used). */
  readonly retryAfterSeconds: number | null

  constructor(init: {
    status: number
    title: string
    code?: string
    detail?: string
    extras?: Record<string, unknown>
    retryAfterSeconds?: number | null
  }) {
    super(init.title)
    this.name = 'ApiError'
    this.status = init.status
    this.title = init.title
    this.code = init.code
    this.detail = init.detail
    this.extras = init.extras ?? {}
    this.retryAfterSeconds = init.retryAfterSeconds ?? null
  }
}

const parseRetryAfter = (header: string | null): number | null =>
  header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** Builds the ApiError for a non-2xx response; an unparseable or non-object body falls back to the HTTP status. */
const toApiError = async (response: Response): Promise<ApiError> => {
  const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'))
  const fallbackTitle = response.statusText || String(response.status)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return new ApiError({ status: response.status, title: fallbackTitle, retryAfterSeconds })
  }
  if (!isRecord(body)) {
    return new ApiError({ status: response.status, title: fallbackTitle, retryAfterSeconds })
  }

  const extras = Object.fromEntries(Object.entries(body).filter(([key]) => !STANDARD_MEMBERS.has(key)))
  return new ApiError({
    status: typeof body.status === 'number' ? body.status : response.status,
    title: asString(body.title) ?? fallbackTitle,
    code: asString(body.code),
    detail: asString(body.detail),
    extras,
    retryAfterSeconds,
  })
}

/**
 * Calls `${baseUrl}${path}` through `apiFetch` and parses the JSON body.
 * Resolves `undefined` for a bodyless 204; throws `ApiError` on any non-2xx.
 */
export const requestJson = async <T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> => {
  const response = await apiFetch(`${baseUrl}${path}`, init)
  if (!response.ok) {
    throw await toApiError(response)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

/** GET against meetings-api. `init` is forwarded verbatim (e.g. an `AbortSignal`). */
export const getJson = <T>(path: string, init?: RequestInit): Promise<T> =>
  requestJson<T>(getMeetingsApiBaseUrl(), path, init)

/** The `If-Match` value for a record at `version` (a strong ETag, `"3"`). */
export const ifMatch = (version: number): string => `"${version}"`

/**
 * POST/PATCH/DELETE against meetings-api. Omit `body` for the body-less routes
 * (retry, discard); pass `version` for a mutation of a versioned record (a template,
 * a transcript segment, a summary), which then sends `If-Match` (plan G8, ADR-0038).
 */
export const sendJson = <T>(path: string, method: string, body?: unknown, version?: number): Promise<T> => {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (version !== undefined) headers['If-Match'] = ifMatch(version)
  return requestJson<T>(getMeetingsApiBaseUrl(), path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** A write refused because the record changed meanwhile (409 `version_conflict`) or carried no precondition (428). */
export const isStaleWrite = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.status === 428 || (error.status === 409 && error.code === 'version_conflict'))

/** Builds a query string from the defined, non-empty values (`?a=1&b=x`), or '' when there are none. */
export const query = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}
