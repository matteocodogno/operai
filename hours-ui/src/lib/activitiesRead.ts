/**
 * activitiesRead — the activities of one project or deal, read from activities-api AS THE PERSON
 * (specs/029-time-tracking, plan § Components `hours-ui` › Activity picker; design S2 § Activity field).
 *
 * The browser asks activities-api itself, `GET {getActivitiesApiBaseUrl()}/activities?projectId=<id>` or
 * `?dealId=<id>` with `pageSize=100` (activities-api's `MAX_PAGE_SIZE`), through `shell/session`'s
 * `apiFetch`, which sends the person's Bearer JWT: activities-api asks the owning host whether THIS caller
 * may read the project or deal, so what comes back is what the person can already see. Nothing goes through
 * hours-api (a second list contract for a read the person can already make, plan, rejected). One page, in
 * activities-api's own order (`occurredAt` newest first); `total` says when older ones are not here.
 *
 * What the list shows never decides a save: hours-api checks a chosen activity itself (422
 * `activity_not_allowed`, 503 `host_unavailable`, AC-2.7). So this module only has to say "here they are"
 * or "could not read them": it rejects on a non-2xx answer (the `HoursApiError` `errorFromResponse` makes of
 * the Problem, whose status the caller does not branch on: a 404 for a project or deal activities-api cannot
 * read, a 503 `host_unavailable` and a network failure are one state), on a body that is not a page, and
 * with `fetch`'s own rejection for a network failure, an abort included. A page that cannot be read is never
 * answered as an empty one.
 */
import { apiFetch, getActivitiesApiBaseUrl } from 'shell/session'
import { errorFromResponse } from './errors'

/** activities-api's `MAX_PAGE_SIZE`: the one page the field reads. */
export const ACTIVITIES_PAGE_SIZE = 100

/** The activity types activities-api has today (`ACTIVITY_TYPES`); the field words each one. */
export const ACTIVITY_TYPES = ['note', 'call', 'meeting', 'email', 'task'] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

/** The project or deal whose activities are read: the one filter activities-api is asked for. */
export type ActivityOwner = { type: 'project' | 'deal'; id: string }

/** What an option needs of an activity. `type` is `null` for a type this build does not know. */
export type ActivityOption = { id: string; type: ActivityType | null; subject: string }

export type ActivitiesPage = { items: ActivityOption[]; total: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isActivityType = (value: unknown): value is ActivityType =>
  typeof value === 'string' && (ACTIVITY_TYPES as readonly string[]).includes(value)

const optionOf = (item: unknown): ActivityOption | null => {
  if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['subject'] !== 'string') return null
  return { id: item['id'], type: isActivityType(item['type']) ? item['type'] : null, subject: item['subject'] }
}

export async function readActivities(
  owner: ActivityOwner,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ActivitiesPage> {
  // The id is a query VALUE, percent-encoded by URLSearchParams: it cannot add a filter of its own.
  const query = new URLSearchParams({
    [owner.type === 'project' ? 'projectId' : 'dealId']: owner.id,
    pageSize: String(ACTIVITIES_PAGE_SIZE),
  })
  const response = await apiFetch(`${getActivitiesApiBaseUrl()}/activities?${query}`, { signal })
  if (!response.ok) throw await errorFromResponse(response)

  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body['items']))
    throw new Error('activities-api answered something that is not a page')

  const items = body['items'].flatMap((item) => optionOf(item) ?? [])
  const total = typeof body['total'] === 'number' && Number.isFinite(body['total']) ? body['total'] : items.length
  return { items, total }
}
