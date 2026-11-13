/**
 * hoursApi — the one place hours-ui talks to hours-api (specs/029-time-tracking, plan § API
 * contracts › Entries, Totals, Lists).
 *
 * Every call goes through `shell/session`'s `apiFetch` (ADR-0001/ADR-0006): it attaches the Bearer
 * JWT to trusted origins only (hours-api's, since T21) and handles the 401 refresh-retry-redirect.
 * The origin is `getHoursApiBaseUrl()`, read at call time. A non-2xx answer is RFC 7807 Problem JSON
 * and becomes an `HoursApiError` with a typed `code` (`./errors`); a network failure is not an
 * answer, so `fetch`'s rejection propagates untouched.
 *
 * There is no `If-Match` anywhere: an entry has one writer, its person, so last write wins
 * (plan § Decisions, ADR-0088).
 *
 * The queries are built from an allow-list of the plan's names, so a stray property on a filters
 * object (a cursor, a limit, an unknown key) cannot reach the URL, and a filter that is unset or
 * empty is left out. The owners' searches (projects, deals, meetings, activities) are not here:
 * they go to other services, as the person (plan § Components `hours-ui`).
 */
import { apiFetch, getHoursApiBaseUrl } from 'shell/session'
import { errorFromResponse } from './errors'
import type {
  EntriesPage,
  EntryFilters,
  EntryInput,
  EntryPatch,
  GroupBy,
  TimeEntryView,
  TimeListsView,
  TotalsAnswer,
} from './hoursApi.types'

export type { EntryFilters }

type Init = { signal?: AbortSignal }

/** The filter names of plan § Entries / § Totals, in the order they are written. */
const FILTER_KEYS = [
  'whose',
  'from',
  'to',
  'userId',
  'target',
  'projectId',
  'dealId',
  'meetingId',
  'categoryId',
  'workTypeId',
] as const satisfies readonly (keyof EntryFilters)[]

type Param = string | number | boolean | undefined | null

/** `?a=1&b=x` from the defined, non-empty values, or '' when there are none. */
const queryString = (params: [string, Param][]): string => {
  const search = new URLSearchParams()
  for (const [key, value] of params) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

const filterParams = (filters: EntryFilters, withoutUser = false): [string, Param][] =>
  FILTER_KEYS.filter((key) => !(withoutUser && key === 'userId')).map((key) => [key, filters[key]])

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await apiFetch(`${getHoursApiBaseUrl()}${path}`, init)
  if (!response.ok) throw await errorFromResponse(response)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const entryPath = (id: string) => `/time-entries/${encodeURIComponent(id)}`

/** One page of entries, newest day first. `nextCursor` null is the last page. */
export const listEntries = (
  filters: EntryFilters,
  { cursor, limit, signal }: Init & { cursor?: string; limit?: number } = {},
): Promise<EntriesPage> =>
  request<EntriesPage>(
    `/time-entries${queryString([...filterParams(filters), ['cursor', cursor], ['limit', limit]])}`,
    {
      signal,
    },
  )

/**
 * The totals for the same filters, grouped (never paged: the answer is complete, plan § Totals).
 * `withoutUser` drops `userId`: the Everyone's hours Person options are the `person` groups of the
 * view's OTHER filters, so they list everyone and not only the person chosen (design gap 2).
 */
export const getTotals = (
  groupBy: GroupBy,
  filters: EntryFilters,
  { signal, withoutUser = false }: Init & { withoutUser?: boolean } = {},
): Promise<TotalsAnswer> =>
  request<TotalsAnswer>(
    `/time-entries/totals${queryString([['groupBy', groupBy], ...filterParams(filters, withoutUser)])}`,
    { signal },
  )

/** The categories and the two work-type lists; `includeRetired` adds the retired ones (marked `retired`). */
export const getTimeLists = ({ includeRetired, signal }: Init & { includeRetired: boolean }): Promise<TimeListsView> =>
  request<TimeListsView>(`/time-lists${queryString([['includeRetired', includeRetired]])}`, { signal })

export const createEntry = (input: EntryInput): Promise<TimeEntryView> =>
  request<TimeEntryView>('/time-entries', jsonInit('POST', input))

/** Sends only the members the person changed (AC-2.12): the server checks bookability only when `on` moves. */
export const updateEntry = (id: string, patch: EntryPatch): Promise<TimeEntryView> =>
  request<TimeEntryView>(entryPath(id), jsonInit('PATCH', patch))

export const deleteEntry = (id: string): Promise<void> => request<void>(entryPath(id), { method: 'DELETE' })
