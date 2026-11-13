/**
 * timeListsApi — typed API client for hours-api's time lists: the categories and the two work-type
 * lists (project, deal) people pick from when they record hours (T31, specs/029-time-tracking,
 * refs AC-3.3, AC-5.5; plan.md § Lists).
 *
 * Same conventions as `./ratesApi.ts` (ADR-0023): one function per operation, an `ApiError` built
 * from RFC 7807 Problem JSON, and a base URL that comes from the SHELL — `getHoursApiBaseUrl()` from
 * `shell/session` — never from admin-ui's own env (a remote ships no `VITE_HOURS_API_URL`; reading
 * it yields `undefined` and every request collapses to a broken relative URL). `apiFetch` already
 * treats hours-api as a trusted origin (T21) and attaches the Bearer JWT.
 *
 * The one difference from `ratesApi`: hours-api's Problem JSON carries a machine-readable `code`
 * (`time_list_manage_required`, `authz_unavailable`, `name_taken`, `not_found`, …) and a screen has
 * to tell a 503 `authz_unavailable` ("could not check your permission, try again") from any other
 * failure, so `ApiError.code` is kept.
 *
 * There is NO delete operation: no route exists (AC-3.2). An item is retired and restored with the
 * same `PATCH { retired }`, both idempotent (AC-3.1 as amended, plan.md D38). `list` is fixed at
 * creation and is not a member of either update input — the server refuses it as an unknown key.
 * Names are passed and returned exactly as typed (AC-3.8).
 */

import { apiFetch, getHoursApiBaseUrl } from 'shell/session'

// ---------------------------------------------------------------------------
// Shared shapes (plan.md § Lists)
// ---------------------------------------------------------------------------

/** What an entry on no entity is about (glossary: Category, time tracking). */
export type TimeCategory = {
  id: string
  name: string
  /** An entry in this category must carry a note. */
  requiresNote: boolean
  /** Retired items are not offered for new entries; entries that have one keep it. */
  retired: boolean
}

/** The two work-type lists: one for entries on a project, one for entries on a deal. */
export type WorkTypeList = 'project' | 'deal'

/** The optional kind of work of an entry on a project or a deal. */
export type WorkType = {
  id: string
  list: WorkTypeList
  name: string
  retired: boolean
}

/** `GET /time-lists` — every list, retired items included when asked. */
export type TimeLists = {
  categories: TimeCategory[]
  workTypes: { project: WorkType[]; deal: WorkType[] }
}

/** `POST /time-categories` body. */
export type CreateCategoryInput = { name: string; requiresNote?: boolean }

/** `PATCH /time-categories/{id}` body: at least one member. */
export type UpdateCategoryInput = { name?: string; requiresNote?: boolean; retired?: boolean }

/** `POST /work-types` body. */
export type CreateWorkTypeInput = { list: WorkTypeList; name: string }

/** `PATCH /work-types/{id}` body: at least one member; never `list`. */
export type UpdateWorkTypeInput = { name?: string; retired?: boolean }

/** RFC 7807 Problem JSON as hours-api returns it, `code` being its extension member. */
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
 * Thrown by every function here on a non-2xx answer (and on a 2xx whose body is not the shape
 * plan.md defines). Callers branch on `status` and `code`:
 *   • 403 `time_list_manage_required` — the permission is not held (any more);
 *   • 503 `authz_unavailable` — `auth` did not answer; nothing changed, retrying is safe;
 *   • 409 `name_taken` — a create or rename collided with an existing name (retired ones count);
 *   • 404 `not_found` — the item no longer exists;
 *   • 400 `invalid_request` — a schema violation the form should have caught.
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** hours-api's origin, from the shell — never hardcoded, never admin-ui's own env. */
const hoursApiBase = (): string => getHoursApiBaseUrl()

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * Parses a non-2xx Response as an RFC 7807 Problem and throws an `ApiError`; a body that is not
 * Problem JSON becomes a synthetic Problem from the HTTP status (as `ratesApi.ts` does).
 */
const throwFromResponse = async (response: Response): Promise<never> => {
  let problem: ApiProblem
  try {
    const body = (await response.json()) as Record<string, unknown>
    problem = {
      type: optionalString(body.type) ?? `https://httpstatuses.com/${response.status}`,
      title: optionalString(body.title) ?? response.statusText,
      status: typeof body.status === 'number' ? body.status : response.status,
      detail: optionalString(body.detail),
      instance: optionalString(body.instance),
      code: optionalString(body.code),
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

const isArray = (value: unknown): value is unknown[] => Array.isArray(value)

/**
 * The top-level shape of `GET /time-lists`. A body that lacks a list would otherwise crash the page
 * on first access; refused here, it is an ordinary load failure and the drift is visible.
 */
const isTimeLists = (body: unknown): body is TimeLists => {
  if (typeof body !== 'object' || body === null) return false
  const { categories, workTypes } = body as Record<string, unknown>
  if (!isArray(categories) || typeof workTypes !== 'object' || workTypes === null) return false
  const { project, deal } = workTypes as Record<string, unknown>
  return isArray(project) && isArray(deal)
}

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await apiFetch(`${hoursApiBase()}${path}`, init)
  if (!response.ok) {
    return throwFromResponse(response)
  }
  return response
}

const sendJson = async <T>(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> => {
  const response = await request(path, { method, headers: jsonHeaders, body: JSON.stringify(body) })
  return response.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Time lists
// ---------------------------------------------------------------------------

/**
 * GET /time-lists?includeRetired=true
 * Every category and both work-type lists, retired items included: the screen lists them so they
 * can be restored. Reading needs only a JWT (plan.md § Lists); managing is `time-list:manage`.
 */
export const listTimeLists = async (): Promise<TimeLists> => {
  const response = await request('/time-lists?includeRetired=true')
  const body: unknown = await response.json()
  if (!isTimeLists(body)) {
    throw new ApiError({
      type: 'about:blank',
      title: 'Unexpected response',
      status: response.status,
      detail: 'The time lists answer does not have the shape plan.md defines.',
    })
  }
  return body
}

/** POST /time-categories → 201. 409 `name_taken` when the name exists (retired included). */
export const createCategory = async (input: CreateCategoryInput): Promise<TimeCategory> =>
  sendJson<TimeCategory>('/time-categories', 'POST', input)

/**
 * PATCH /time-categories/{id} → 200. Rename, change "needs a note", retire (`retired: true`) or
 * restore (`retired: false`); retire and restore are idempotent, so repeating one is harmless.
 */
export const updateCategory = async (id: string, input: UpdateCategoryInput): Promise<TimeCategory> =>
  sendJson<TimeCategory>(`/time-categories/${encodeURIComponent(id)}`, 'PATCH', input)

/** POST /work-types → 201. 409 `name_taken` when the name exists in that list (retired included). */
export const createWorkType = async (input: CreateWorkTypeInput): Promise<WorkType> =>
  sendJson<WorkType>('/work-types', 'POST', input)

/** PATCH /work-types/{id} → 200. Rename, retire or restore; the list cannot change. */
export const updateWorkType = async (id: string, input: UpdateWorkTypeInput): Promise<WorkType> =>
  sendJson<WorkType>(`/work-types/${encodeURIComponent(id)}`, 'PATCH', input)
