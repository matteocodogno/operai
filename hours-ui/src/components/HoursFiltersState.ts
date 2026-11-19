/**
 * The filters of My hours and Everyone's hours as the URL's search params (specs/20261112-time-tracking T24, T29;
 * design § Frame of `hours-ui`): `period`, `from`, `to`, `person` (Everyone's hours only), `target` (Recorded on,
 * T44), `category`, `workType` and `group`. The picked project and deal are NOT here: a pick needs its label, and the URL
 * carries none, so they live in memory.
 *
 * Read defensively and written minimally, the same rules as estimai-ui's list filters: a default is left
 * out of the URL, an unknown or malformed value falls back to the default (so garbage in a pasted link never
 * reaches the API), and writing one filter keeps every other key of the URL.
 *
 * TanStack Router parses a search value that looks like JSON, so `?workType=123` arrives as the number 123:
 * ids are read as text from a string or a number.
 */
import type { EntryTargetType } from '../lib/hoursApi.types'
import { monthOf, parseMonth, readMonthParam } from '../lib/month'
import { DEFAULT_PERIOD, PERIODS } from '../lib/period'
import type { Period } from '../lib/period'
import { holding, isCurrent } from '../lib/tablePeriod'
import type { TablePeriod } from '../lib/tablePeriod'
import { readWeekParam } from '../lib/week'
import { EVERYONE_GROUP_CHOICES, GROUP_CHOICES } from './TotalsCardRows'
import type { GroupChoice } from './TotalsCardRows'

/**
 * The view of My hours (specs/20261116-record-hours-in-place T10, T19; plan § The address of My hours, decisions 5 and
 * 10): the table view (`/hours`, the default, left out of the address) or the List (`?view=list`). A view of the same
 * page, not a filter: the filters below apply to both, and `period`, `from`, `to` and `group` are read by the List only.
 */
export type MyHoursView = 'table' | 'list'

/** What an address of My hours says to show: the List, or the table view at a period, a week or a month. */
export type MyHoursAddress = { view: 'list' } | { view: 'table'; period: TablePeriod }

/** Which screen the filters belong to: Person exists, and is the default Group by, only on Everyone's hours. */
export type FilterView = 'mine' | 'everyone'

/**
 * What an entry is recorded on, as hours-api's `target` takes it (plan § Entries): a project, a deal, a meeting or
 * no entity at all ("Other work"). The select offers them in this order, after "All".
 */
export const TARGETS = ['project', 'deal', 'meeting', 'none'] as const satisfies readonly EntryTargetType[]

/** Recorded on: one of the four kinds, or '' for "All" (the default, never sent). */
export type TargetFilter = (typeof TARGETS)[number] | ''

export type HoursFilterState = {
  period: Period
  /** `YYYY-MM-DD` or '' — read only when `period` is `custom`. */
  from: string
  to: string
  /** The user id chosen in Everyone's hours; '' is everyone (and is always '' on My hours). */
  personId: string
  /** Recorded on: '' is "All". Combines with every other filter by AND; nothing here hides or clears another. */
  target: TargetFilter
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
  target: '',
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
    target: oneOf(search['target'], TARGETS) ?? DEFAULT_FILTERS.target,
    categoryId: asText(search['category']),
    workTypeId: asText(search['workType']),
    group: oneOf(search['group'], view === 'everyone' ? EVERYONE_GROUP_CHOICES : GROUP_CHOICES) ?? defaultGroupOf(view),
  }
}

/**
 * What the address names (plan § The address of My hours): the List for `view=list`; the month for `view=month`, the month
 * `month` names (`readMonthParam`: a strict `YYYY-MM`, else the current month, and never one after it); anything else —
 * absent, `week`, garbage, a number — is the table view's week, the week `week` names (`readWeekParam`: any day of it, else
 * the current week), so a pasted link always lands somewhere real, now on the default view. `week` is read in the week
 * only and `month` in the month only: the other's key is held in the address untouched, for the way back. Nothing here
 * writes: an address that was clamped or ignored is not rewritten, the period shown is derived from it and the next write
 * puts it there. `today` is a `YYYY-MM-DD` (hours-ui passes `todayZurich()`).
 */
export const readMyHoursAddress = (search: Record<string, unknown>, today: string): MyHoursAddress => {
  if (search['view'] === 'list') return { view: 'list' }
  if (search['view'] === 'month')
    return { view: 'table', period: { kind: 'month', month: readMonthParam(search, today) } }
  return { view: 'table', period: holding('week', readWeekParam(search, today)) }
}

/**
 * The search after the table view moved to `period` — the navigator, the period switch and the date field. The week is the
 * default view, so a week leaves `view` out (and the first contract's `view=week`), is written as its Monday except the
 * current one, which is the default and is left out too, so a bookmark of "this week" keeps meaning the current week, and
 * takes `month` out. A month writes `view=month` and `month=<YYYY-MM>` (left out for the current month, the default month,
 * which is `view=month` alone) and keeps `week` as it was: the week the month was reached from, which Month → Week returns
 * to (AC-5.27, D26) and which only the week reads. Every other key is kept, the List's `period`, `from`, `to` and `group`
 * among them (design G5).
 */
export const withTablePeriod = (
  previous: Record<string, unknown>,
  period: TablePeriod,
  today: string,
): Record<string, unknown> => {
  const next = { ...previous }
  if (period.kind === 'month') {
    next['view'] = 'month'
    if (isCurrent(period, today)) delete next['month']
    else next['month'] = period.month
    return next
  }
  delete next['view']
  delete next['month']
  if (isCurrent(period, today)) delete next['week']
  else next['week'] = period.monday
  return next
}

/**
 * The search after the person chose the List, from the table view showing `shown`: `view=list`, every other key kept —
 * `week` too, so coming back lands on the week that was shown (or, after a month, the week it was reached from), as the
 * List's own `period` survives the other way. When the week was shown a `month` is taken out; when the month was shown it
 * is written, the current month included, so the table view finds it again (`withTable`).
 */
export const withList = (previous: Record<string, unknown>, shown: TablePeriod): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...previous, view: 'list' }
  if (shown.kind === 'month') next['month'] = shown.month
  else delete next['month']
  return next
}

/**
 * The search after the person chose the table view again: the month when the address holds one (`view=month`, the `month`
 * left out when it is the current month, the default), else the week — `view` left out, the week `week` names or the
 * current one. Every other key kept. A `month` that is not a `YYYY-MM` is no month to come back to and is left as it was.
 */
export const withTable = (previous: Record<string, unknown>, today: string): Record<string, unknown> => {
  const next = { ...previous }
  const held = parseMonth(previous['month'])
  if (held === null) {
    delete next['view']
    return next
  }
  next['view'] = 'month'
  if (held === monthOf(today)) delete next['month']
  return next
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
  if (patch.target !== undefined) set('target', patch.target, patch.target === '')
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

/**
 * Clear filters: back to the defaults, keeping Group by (a view choice, not a filter), `view`, `week`, `month` and any
 * other key. In the table view the controls it does not show — Period with its dates — are not reset either: the List
 * reads them again when the person goes back, and clearing a control nobody can see would be a surprise there
 * (design G5).
 */
export const clearFilterSearch = (
  previous: Record<string, unknown>,
  view: MyHoursView = 'list',
): Record<string, unknown> => {
  const next = { ...previous }
  const keys = ['person', 'target', 'category', 'workType']
  for (const key of view === 'table' ? keys : ['period', 'from', 'to', ...keys]) delete next[key]
  return next
}

/**
 * Whether anything differs from the defaults — the only time "Clear filters" is offered. In the table view the period is
 * not a filter: its control is not there, and a "Clear filters" that appears for a setting nobody can see would clear
 * nothing the person can see (design G5).
 */
export const isFiltered = (
  state: HoursFilterState,
  picks: { project: { id: string } | null; deal: { id: string } | null },
  view: MyHoursView = 'list',
): boolean =>
  (view === 'list' && state.period !== DEFAULT_FILTERS.period) ||
  state.personId !== '' ||
  state.target !== '' ||
  state.categoryId !== '' ||
  state.workTypeId !== '' ||
  picks.project !== null ||
  picks.deal !== null
