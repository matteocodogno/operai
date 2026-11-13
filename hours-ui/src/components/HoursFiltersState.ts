/**
 * The filters of My hours and Everyone's hours as the URL's search params (specs/029-time-tracking T24, T29;
 * design § Frame of `hours-ui`): `period`, `from`, `to`, `person` (Everyone's hours only), `category`,
 * `workType` and `group`. The picked project and deal are NOT here: a pick needs its label, and the URL
 * carries none, so they live in memory.
 *
 * Read defensively and written minimally, the same rules as estimai-ui's list filters: a default is left
 * out of the URL, an unknown or malformed value falls back to the default (so garbage in a pasted link never
 * reaches the API), and writing one filter keeps every other key of the URL.
 *
 * TanStack Router parses a search value that looks like JSON, so `?workType=123` arrives as the number 123:
 * ids are read as text from a string or a number.
 */
import { DEFAULT_PERIOD, PERIODS } from '../lib/period'
import type { Period } from '../lib/period'
import { EVERYONE_GROUP_CHOICES, GROUP_CHOICES } from './TotalsCardRows'
import type { GroupChoice } from './TotalsCardRows'

/** Which screen the filters belong to: Person exists, and is the default Group by, only on Everyone's hours. */
export type FilterView = 'mine' | 'everyone'

export type HoursFilterState = {
  period: Period
  /** `YYYY-MM-DD` or '' — read only when `period` is `custom`. */
  from: string
  to: string
  /** The user id chosen in Everyone's hours; '' is everyone (and is always '' on My hours). */
  personId: string
  /** '' is "all". */
  categoryId: string
  workTypeId: string
  /** How the totals are grouped: a view choice, not a filter. */
  group: GroupChoice
}

/** What one change writes; a member that is absent is left as it is. */
export type FilterPatch = Partial<HoursFilterState>

/** The grouping a view opens on: By person for Everyone's hours, By project for My hours. */
export const defaultGroupOf = (view: FilterView): GroupChoice => (view === 'everyone' ? 'person' : 'project')

export const DEFAULT_GROUP: GroupChoice = defaultGroupOf('mine')

export const DEFAULT_FILTERS: HoursFilterState = {
  period: DEFAULT_PERIOD,
  from: '',
  to: '',
  personId: '',
  categoryId: '',
  workTypeId: '',
  group: DEFAULT_GROUP,
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  allowed.find((candidate) => candidate === value)

/**
 * A user id the API would take: 1..64 characters, no NUL, no comma, no space at either end (plan § Entries,
 * "the id rule"). One that is not never reaches the API, so a pasted link cannot make a 400.
 */
const isUserId = (value: string): boolean =>
  value.length >= 1 && value.length <= 64 && value.trim() === value && !value.includes('\u0000') && !value.includes(',')

export const parseFilterSearch = (search: Record<string, unknown>, view: FilterView = 'mine'): HoursFilterState => {
  const person = asText(search['person'])
  return {
    period: oneOf(search['period'], PERIODS) ?? DEFAULT_FILTERS.period,
    from: asText(search['from']),
    to: asText(search['to']),
    personId: view === 'everyone' && isUserId(person) ? person : '',
    categoryId: asText(search['category']),
    workTypeId: asText(search['workType']),
    group: oneOf(search['group'], view === 'everyone' ? EVERYONE_GROUP_CHOICES : GROUP_CHOICES) ?? defaultGroupOf(view),
  }
}

/** The URL's search after `patch`: defaults left out, dates only under Custom, every other key kept. */
export const applyFilterPatch = (
  previous: Record<string, unknown>,
  patch: FilterPatch,
  view: FilterView = 'mine',
): Record<string, unknown> => {
  const next = { ...previous }
  const set = (key: string, value: string, isDefault: boolean) => {
    if (isDefault) delete next[key]
    else next[key] = value
  }
  if (patch.period !== undefined) set('period', patch.period, patch.period === DEFAULT_FILTERS.period)
  if (patch.from !== undefined) next['from'] = patch.from
  if (patch.to !== undefined) next['to'] = patch.to
  if (patch.personId !== undefined) set('person', patch.personId, patch.personId === '')
  if (patch.categoryId !== undefined) set('category', patch.categoryId, patch.categoryId === '')
  if (patch.workTypeId !== undefined) set('workType', patch.workTypeId, patch.workTypeId === '')
  if (patch.group !== undefined) set('group', patch.group, patch.group === defaultGroupOf(view))
  // A preset has no dates of its own: leaving Custom takes them with it.
  if (next['period'] !== 'custom') {
    delete next['from']
    delete next['to']
  }
  return next
}

/** Clear filters: back to the defaults, keeping Group by (a view choice, not a filter) and any other key. */
export const clearFilterSearch = (previous: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...previous }
  for (const key of ['period', 'from', 'to', 'person', 'category', 'workType']) delete next[key]
  return next
}

/** Whether anything differs from the defaults — the only time "Clear filters" is offered. */
export const isFiltered = (
  state: HoursFilterState,
  picks: { project: { id: string } | null; deal: { id: string } | null },
): boolean =>
  state.period !== DEFAULT_FILTERS.period ||
  state.personId !== '' ||
  state.categoryId !== '' ||
  state.workTypeId !== '' ||
  picks.project !== null ||
  picks.deal !== null
