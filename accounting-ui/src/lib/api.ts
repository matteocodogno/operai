/**
 * api — the one place accounting-ui talks HTTP (specs/20261119-accounting). Copied from letterheads-ui's `lib/api.ts`
 * (commit a8448b6f), minus the letterhead-only version-conflict helper.
 *
 * Every authenticated call goes through `shell/session`'s `apiFetch`
 * (ADR 20260607-jwt-in-memory-never-web-storage/ADR 20260709-suite-frontend-module-federation): it attaches the Bearer JWT to trusted origins only and
 * handles the 401 refresh-retry-redirect. accounting-api's base URL comes from the
 * shell (`getAccountingApiBaseUrl()`, which reads `VITE_ACCOUNTING_API_URL`).
 *
 * Non-2xx responses are RFC 7807 Problem JSON and become an `ApiError`:
 * `{status, code, detail, extras}`; `code` is the discriminator the UI switches
 * on where one status has several meanings, never `detail` (`accounting_forbidden`, `accounting_manage_required`, `not_found`,
 * `ledger_account_duplicate`, `invalid_vat_code`, `no_rate_source`, …) and `extras` holds its extension members
 * (`fields`, `reactivate`, `number`, `vatCode`, …). A network
 * failure is not an ApiError: `fetch`'s rejection propagates.
 */

import { apiFetch, getAccountingApiBaseUrl } from 'shell/session'

/** Members of a Problem JSON body that `ApiError` models as named fields, not as extras. */
const STANDARD_MEMBERS = new Set(['type', 'title', 'status', 'detail', 'instance', 'code'])

export class ApiError extends Error {
  readonly status: number
  readonly title: string
  readonly code: string | undefined
  readonly detail: string | undefined
  /** Extension members of the Problem body, e.g. `{ fields }` for `invalid_ledger_account`. */
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

/** GET against accounting-api. `init` is forwarded verbatim (e.g. an `AbortSignal`). */
export const getJson = <T>(path: string, init?: RequestInit): Promise<T> =>
  requestJson<T>(getAccountingApiBaseUrl(), path, init)

/** POST (or another method) with a JSON body against accounting-api. Omit `body` for a body-less route. */
export const sendJson = <T>(path: string, method: string, body?: unknown, init?: RequestInit): Promise<T> => {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return requestJson<T>(getAccountingApiBaseUrl(), path, {
    ...init,
    method,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
