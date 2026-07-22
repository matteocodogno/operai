/**
 * settingsApi — typed API client for refund-api's refund-settings management
 * surface (T6, specs/011-refund-settings/tasks.md, plan.md "API contracts").
 *
 * Mirrors `./ratesApi.ts`'s conventions exactly (typed request/response
 * shapes, an `ApiError` built from RFC 7807 Problem JSON, one function per
 * operation, `getJson`/`sendJson` helpers) with the same base-URL sourcing:
 * the refund-api origin comes from `shell/session`'s `getRefundApiBaseUrl()`,
 * NOT admin-ui's own `import.meta.env` (a remote ships no such env var, so
 * reading it here yields `undefined` and the request collapses to a broken
 * relative URL). This is a NEW, independent module — not an extension of
 * `ratesApi.ts` — because the settings surface is a different resource, a
 * different capability (`settings:read`/`settings:manage`, ADR-0028), and a
 * different validation contract (plan.md D4).
 *
 * Error handling:
 *   Non-2xx responses are parsed as RFC 7807 Problem JSON (mirrors
 *   `ratesApi.ts`'s `throwFromResponse` verbatim) and thrown as `ApiError` so
 *   callers can branch on `error.status` — `403` without `settings:read`/
 *   `settings:manage`, `404` for an unknown key, `422` on a malformed email
 *   (AC-1.3).
 */

import { apiFetch, getRefundApiBaseUrl } from "shell/session";

// ---------------------------------------------------------------------------
// Shared shapes (mirrors plan.md's "API contracts" — Settings surface)
// ---------------------------------------------------------------------------

/** The only registered refund-setting key this feature introduces (D1/D3). */
export const ACCOUNTING_DISTRIBUTION_EMAIL_KEY =
  "accounting-distribution-email";

/** One entry in a setting's chronological change history (AC-5.3). */
export type SettingHistoryEntry = {
  value: string | null;
  changedAt: string;
  changedByEmail: string;
};

/** `GET /settings/:key` / `PUT /settings/:key` response shape (plan.md). */
export type SettingResult = {
  key: string;
  value: string | null;
  configured: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
  /** Chronological (plan.md's documented order, mirrors AC-5.3). */
  history: SettingHistoryEntry[];
};

/**
 * RFC 7807 Problem JSON shape — returned by refund-api for all non-2xx
 * responses (mirrors `ratesApi.ts`'s `ApiProblem` verbatim).
 */
export type ApiProblem = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
};

// ---------------------------------------------------------------------------
// Typed error class
// ---------------------------------------------------------------------------

/**
 * Thrown by every settingsApi function on a non-2xx response.
 *
 * Callers can check `error.status` to distinguish specific cases:
 *   • 401 — unauthenticated (handled upstream by apiFetch's refresh-retry, but
 *            included for completeness in case the redirect is suppressed)
 *   • 403 — authenticated but lacks `settings:read`/`settings:manage` (AC-3.1)
 *   • 404 — unknown setting key (plan.md's descriptor-registry seam)
 *   • 422 — value present but not a well-formed email (AC-1.3) — nothing
 *            persisted, no audit row
 */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly instance: string | undefined;

  constructor(problem: ApiProblem) {
    super(problem.title);
    this.name = "ApiError";
    this.status = problem.status;
    this.title = problem.title;
    this.detail = problem.detail;
    this.instance = problem.instance;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the base URL for refund-api — never hardcoded. */
// refund-api's base URL comes from the SHELL (shell/session), not admin-ui's
// own env: admin-ui ships no VITE_REFUND_API_URL, so reading
// import.meta.env here yields `undefined` and the request collapses to a
// broken relative URL. The shell owns the one configured origin — mirrors
// `ratesApi.ts`'s `refundApiBase()`.
const refundApiBase = (): string => getRefundApiBaseUrl();

/**
 * Parses a non-2xx Response as an RFC 7807 Problem and throws an `ApiError`.
 * If the response body cannot be parsed as a Problem object, a synthetic
 * Problem is constructed from the HTTP status (mirrors `ratesApi.ts`).
 */
const throwFromResponse = async (response: Response): Promise<never> => {
  let problem: ApiProblem;
  try {
    const body = (await response.json()) as Partial<ApiProblem>;
    problem = {
      type: body.type ?? `https://httpstatuses.com/${response.status}`,
      title: body.title ?? response.statusText,
      status: body.status ?? response.status,
      detail: body.detail,
      instance: body.instance,
    };
  } catch {
    problem = {
      type: `https://httpstatuses.com/${response.status}`,
      title: response.statusText || String(response.status),
      status: response.status,
    };
  }
  throw new ApiError(problem);
};

const jsonHeaders = { "Content-Type": "application/json" };

/** GET helper — no body, throws ApiError on non-2xx. */
const getJson = async <T>(path: string): Promise<T> => {
  const response = await apiFetch(`${refundApiBase()}${path}`);
  if (!response.ok) {
    return throwFromResponse(response);
  }
  return response.json() as Promise<T>;
};

/** PUT helper — JSON body, throws ApiError on non-2xx. */
const sendJson = async <T>(
  path: string,
  method: string,
  body: unknown,
): Promise<T> => {
  const response = await apiFetch(`${refundApiBase()}${path}`, {
    method,
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return throwFromResponse(response);
  }
  return response.json() as Promise<T>;
};

// ---------------------------------------------------------------------------
// Settings management
// ---------------------------------------------------------------------------

/**
 * GET /settings/{key}
 * Current value + `configured` flag + chronological change history (AC-1.1,
 * AC-5.3). Throws ApiError on 403 (missing `settings:read`), 404 (unknown
 * key), or 401.
 */
export const getSetting = async (key: string): Promise<SettingResult> =>
  getJson<SettingResult>(`/settings/${encodeURIComponent(key)}`);

/**
 * PUT /settings/{key}
 * Updates the setting's value; `null` (or `""`, normalized server-side)
 * clears it (AC-1.4). Returns the post-write state (200), same shape as GET.
 * Throws ApiError on 422 (malformed email, AC-1.3 — nothing persisted, no
 * audit row), 403 (missing `settings:manage`), 404 (unknown key), or 401.
 */
export const putSetting = async (
  key: string,
  value: string | null,
): Promise<SettingResult> =>
  sendJson<SettingResult>(`/settings/${encodeURIComponent(key)}`, "PUT", {
    value,
  });
