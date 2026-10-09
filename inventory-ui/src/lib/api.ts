/**
 * api — the one place inventory-ui talks HTTP (T24, specs/015-hardware-inventory).
 *
 * Every authenticated call goes through `shell/session`'s `apiFetch`
 * (ADR-0001/ADR-0006): it attaches the Bearer JWT to trusted origins only and
 * handles the 401 refresh-retry-redirect, so nothing here touches a token. The
 * base URL is never hardcoded or baked into this build: inventory-api's comes
 * from the shell's `getInventoryApiBaseUrl()` (T41), and the one call this app
 * makes to `auth` (the assign picker's directory, plan.md R4) passes
 * `getAuthBaseUrl()` to `requestJson` itself.
 *
 * Non-2xx responses are RFC 7807 Problem JSON (plan.md § API contracts) and
 * become an `ApiError`: `{status, code, detail, extras}` plus the `title` and,
 * for a 429, `retryAfterSeconds`. `code` is the stable discriminator the error
 * catalogue keys on (`serial_conflict`, `fiscal_year_closed`, …); `extras`
 * holds the extension members a code documents (`serialNumber`, `assetId`,
 * `year`, `from`, `field`, …), so a caller never re-parses the body. A network
 * failure is NOT an ApiError: `fetch`'s own rejection propagates and callers
 * show the generic retry banner.
 */

import { apiFetch, getInventoryApiBaseUrl } from 'shell/session'

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

/** GET against inventory-api. `init` is forwarded verbatim (e.g. an `AbortSignal`). */
export const getJson = <T>(path: string, init?: RequestInit): Promise<T> =>
  requestJson<T>(getInventoryApiBaseUrl(), path, init)

/** POST/PUT/PATCH against inventory-api. Omit `body` for the body-less transition routes. */
export const sendJson = <T>(path: string, method: string, body?: unknown): Promise<T> =>
  requestJson<T>(
    getInventoryApiBaseUrl(),
    path,
    body === undefined
      ? { method }
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )

/** DELETE against inventory-api. */
export const deleteJson = (path: string): Promise<void> =>
  requestJson<void>(getInventoryApiBaseUrl(), path, { method: 'DELETE' })
