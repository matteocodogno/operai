/**
 * searchers — what the Project and Deal filters of My hours search, as the person (specs/029-time-tracking
 * T24; plan § Components `hours-ui` "Target pickers").
 *
 * The browser asks the owning service directly, with the person's own JWT through `apiFetch`
 * (`getProjectsApiBaseUrl`, `getCrmApiBaseUrl`): projects-api `GET /projects?q=` and crm-api
 * `GET /deals?q=` list what the person may already open, so the picker offers nothing they could not
 * find there (hours-api decides the rest). Each answer is mapped to what `SearchPicker` takes
 * (`SearchResult`): a 403 is `forbidden` — this person may not search that kind of record, which the
 * picker says in words — and a 503, any other refusal, a network failure or an answer that is not a
 * page is `unavailable`. An unreachable service is never "no match".
 *
 * A request the picker has outrun (the text changed, the list closed) rejects with the abort and is
 * left to the picker, which discards it: an abort is not "unavailable".
 */
import { apiFetch, getCrmApiBaseUrl, getProjectsApiBaseUrl } from 'shell/session'
import type { SearchResult } from '@operai/ui'

/** A project as the picker offers it and the filter keeps it in memory (the URL carries no label). */
export type ProjectChoice = { id: string; name: string; companyName: string | null }
/** A deal as the picker offers it. */
export type DealChoice = { id: string; title: string; companyName: string | null }

const asText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** The company's name, which is `null` when the CRM could not give it (ADR-0080). */
const companyNameOf = (company: unknown): string | null => asText(asRecord(company)?.['name'])

/** `?q=` for typed text; the list opening on an empty field asks with no `q`. */
const queryFor = (q: string): string => (q === '' ? '' : `?${new URLSearchParams({ q })}`)

/** One search: GET `url`, the page's rows through `pick` (a row `pick` cannot read is left out). */
const search = async <Choice>(
  url: string,
  signal: AbortSignal,
  pick: (row: Record<string, unknown>) => Choice | null,
): Promise<SearchResult<Choice>> => {
  try {
    const response = await apiFetch(url, { signal })
    if (response.status === 403) return { ok: false, reason: 'forbidden' }
    if (!response.ok) return { ok: false, reason: 'unavailable' }
    const rows = asRecord(await response.json())?.['items']
    if (!Array.isArray(rows)) return { ok: false, reason: 'unavailable' }
    const items = rows.flatMap((row) => {
      const record = asRecord(row)
      const choice = record === null ? null : pick(record)
      return choice === null ? [] : [choice]
    })
    return { ok: true, items }
  } catch (error) {
    if (signal.aborted) throw error
    return { ok: false, reason: 'unavailable' }
  }
}

export const searchProjects = (q: string, signal: AbortSignal): Promise<SearchResult<ProjectChoice>> =>
  search(`${getProjectsApiBaseUrl()}/projects${queryFor(q)}`, signal, (row) => {
    const id = asText(row['id'])
    const name = asText(row['name'])
    return id === null || name === null ? null : { id, name, companyName: companyNameOf(row['company']) }
  })

export const searchDeals = (q: string, signal: AbortSignal): Promise<SearchResult<DealChoice>> =>
  search(`${getCrmApiBaseUrl()}/deals${queryFor(q)}`, signal, (row) => {
    const id = asText(row['id'])
    const title = asText(row['title'])
    return id === null || title === null ? null : { id, title, companyName: companyNameOf(row['company']) }
  })
