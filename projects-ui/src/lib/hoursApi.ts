/**
 * hoursApi — the one read projects-ui makes of hours-api: `GET /time-entries/summary` for a project
 * (specs/20261112-project-hours T16; plan § API contracts, D-P3). The consumption block asks it for the figures a
 * comparison needs, and the hours of the page are hours-ui's own widget, which makes its own call; projects-ui reads
 * nothing else of hours-api and writes nothing to it (AC-3.1).
 *
 * Same transport as every other call of this tool: `requestJson` → `shell/session`'s `apiFetch`, which attaches the
 * Bearer JWT to trusted origins only (hours-api's, since the shell trusts `getHoursApiBaseUrl()`), handles the 401
 * refresh-retry-redirect and turns a non-2xx Problem into an `ApiError`. The origin is read at call time.
 *
 * What comes back is the two figures `lib/consumption.ts` reads (`SummaryFigures`), checked: a total that is not a
 * whole, non-negative number of minutes is a broken answer, and a broken answer is a rejection, never a figure drawn
 * from it ("could not find out" is not "zero hours", AC-4.9). The breakdowns the answer also carries (`byWorkType`,
 * `byPerson`) are deliberately not read: the block shows no work type and no person, so none of it crosses into this
 * remote's state (AC-2.5).
 */
import { getHoursApiBaseUrl } from 'shell/session'
import { query, requestJson } from './api'
import type { SummaryFigures, SummaryRequest } from './consumption'

type Init = { signal?: AbortSignal }

/** A whole, non-negative number of minutes: what a total of recorded hours is. */
const isMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * The summary of a project's hours (every person's, its linked meetings' included, AC-4.3): `totalMinutes` all time,
 * `windowMinutes` for the days in `window` (`null` without one, and then asked without it). A reader of the project
 * gets both whatever else they may see (AC-1.8); a record that is missing or unreadable is one 404, and Meetings or the
 * owner not answering is a 503: both reject, so the block says the figure is unavailable rather than show a lower one.
 */
export async function getHoursSummary(
  projectId: string,
  window: SummaryRequest['window'],
  init: Init = {},
): Promise<SummaryFigures> {
  const body: unknown = await requestJson<unknown>(
    getHoursApiBaseUrl(),
    `/time-entries/summary${query({ projectId, windowFrom: window?.from, windowTo: window?.to })}`,
    { signal: init.signal },
  )
  const answer =
    typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
  const totalMinutes = answer?.['totalMinutes']
  const windowMinutes = answer?.['windowMinutes']
  if (!isMinutes(totalMinutes) || !(windowMinutes === null || isMinutes(windowMinutes))) {
    throw new Error('hours-api answered a summary without whole-minute totals')
  }
  return { totalMinutes, windowMinutes }
}
