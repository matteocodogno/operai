/**
 * timeListsApi — hours-ui's client for the WRITES to hours-api's time lists (and the read the Settings
 * tab makes): the categories and the two work-type lists (project, deal) people pick from when they
 * record hours (specs/20261112-time-tracking, T31, T43; refs AC-3.1–3.4, AC-3.8; plan.md § Lists).
 * Moved here from admin-ui with the Settings tab (D51).
 *
 * Same conventions as `./hoursApi.ts`: every call goes through `shell/session`'s `apiFetch` (Bearer JWT,
 * trusted origin, the 401 refresh), the origin is `getHoursApiBaseUrl()` read at call time, and a non-2xx
 * answer becomes an `HoursApiError` with a typed `code` (`./errors`): `time_list_manage_required` (403, the
 * permission is not held any more), `authz_unavailable` (503, `auth` did not answer; nothing changed, so
 * retrying is safe), `name_taken` (409, a create or rename collided with an existing name, retired ones
 * count), `not_found` (404, the item no longer exists). A network failure is not an answer: `fetch`'s
 * rejection propagates untouched.
 *
 * `listTimeLists` is the one read of the Settings tab and asks for the retired items too, so they can be
 * restored; it refuses a body that lacks a list, so drift from plan.md is an ordinary load failure and not
 * a crash on first access. (The entry dialog and the filters read the same route through
 * `hoursApi.getTimeLists`, which is not guarded: they only offer what is there.)
 *
 * There is NO delete operation: no route exists (AC-3.2). An item is retired and restored with the same
 * `PATCH { retired }`, both idempotent (AC-3.1 as amended, plan.md D38). `list` is fixed at creation and is
 * not a member of either update input — the server refuses it as an unknown key. Names are passed and
 * returned exactly as typed (AC-3.8).
 */
import { apiFetch, getHoursApiBaseUrl } from 'shell/session'
import { HoursApiError, errorFromResponse } from './errors'
import type { CategoryView, TimeListsView, WorkTypeList, WorkTypeView } from './hoursApi.types'

/** `POST /time-categories` body. */
export type CreateCategoryInput = { name: string; requiresNote?: boolean }

/** `PATCH /time-categories/{id}` body: at least one member. */
export type UpdateCategoryInput = { name?: string; requiresNote?: boolean; retired?: boolean }

/** `POST /work-types` body. */
export type CreateWorkTypeInput = { list: WorkTypeList; name: string }

/** `PATCH /work-types/{id}` body: at least one member; never `list`. */
export type UpdateWorkTypeInput = { name?: string; retired?: boolean }

const isArray = (value: unknown): value is unknown[] => Array.isArray(value)

/** The top-level shape of `GET /time-lists`: both lists of work types and the categories are there. */
const isTimeLists = (body: unknown): body is TimeListsView => {
  if (typeof body !== 'object' || body === null) return false
  const { categories, workTypes } = body as Record<string, unknown>
  if (!isArray(categories) || typeof workTypes !== 'object' || workTypes === null) return false
  const { project, deal } = workTypes as Record<string, unknown>
  return isArray(project) && isArray(deal)
}

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await apiFetch(`${getHoursApiBaseUrl()}${path}`, init)
  if (!response.ok) throw await errorFromResponse(response)
  return response
}

const sendJson = async <T>(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> => {
  const response = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as T
}

/**
 * GET /time-lists?includeRetired=true
 * Every category and both work-type lists, retired items included: the screen lists them so they can be
 * restored. Reading needs only a JWT (plan.md § Lists); managing is `time-list:manage`.
 */
export const listTimeLists = async (): Promise<TimeListsView> => {
  const response = await request('/time-lists?includeRetired=true')
  const body: unknown = await response.json()
  if (!isTimeLists(body)) {
    throw new HoursApiError({
      status: response.status,
      title: 'Unexpected response',
      detail: 'The time lists answer does not have the shape plan.md defines.',
    })
  }
  return body
}

/** POST /time-categories → 201. 409 `name_taken` when the name exists (retired included). */
export const createCategory = (input: CreateCategoryInput): Promise<CategoryView> =>
  sendJson<CategoryView>('/time-categories', 'POST', input)

/**
 * PATCH /time-categories/{id} → 200. Rename, change "needs a note", retire (`retired: true`) or restore
 * (`retired: false`); retire and restore are idempotent, so repeating one is harmless.
 */
export const updateCategory = (id: string, input: UpdateCategoryInput): Promise<CategoryView> =>
  sendJson<CategoryView>(`/time-categories/${encodeURIComponent(id)}`, 'PATCH', input)

/** POST /work-types → 201. 409 `name_taken` when the name exists in that list (retired included). */
export const createWorkType = (input: CreateWorkTypeInput): Promise<WorkTypeView> =>
  sendJson<WorkTypeView>('/work-types', 'POST', input)

/** PATCH /work-types/{id} → 200. Rename, retire or restore; the list cannot change. */
export const updateWorkType = (id: string, input: UpdateWorkTypeInput): Promise<WorkTypeView> =>
  sendJson<WorkTypeView>(`/work-types/${encodeURIComponent(id)}`, 'PATCH', input)
