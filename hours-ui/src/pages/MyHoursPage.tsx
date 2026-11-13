import { useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { PageHeader } from '@operai/ui'
import HoursFilters from '../components/HoursFilters'
import type { ListsView } from '../components/HoursFilters'
import { applyFilterPatch, clearFilterSearch, isFiltered, parseFilterSearch } from '../components/HoursFiltersState'
import type { FilterPatch } from '../components/HoursFiltersState'
import TotalsCard from '../components/TotalsCard'
import type { TotalsView } from '../components/TotalsCard'
import { statusOf } from '../lib/errors'
import { getTimeLists, getTotals, listEntries } from '../lib/hoursApi'
import type { EntryFilters } from '../lib/hoursApi'
import { rangeOf } from '../lib/period'
import type { DealChoice, ProjectChoice } from '../lib/searchers'
import { todayZurich } from '../lib/todayZurich'
import { useHoursQuery } from '../lib/useHoursQuery'
import { strings } from '../strings'

type Search = Record<string, unknown>

/** The words for a failed totals read, in the person's language (never the server's English `detail`). */
const totalsFailure = (error: unknown): string =>
  statusOf(error) === null ? strings.common.networkError : strings.totals.error.body

/**
 * My hours — `/hours`. T24 ships the filters and the Totals card; the entries by day (T25), the entry
 * dialog (T27, T28) and the export (T30) join them.
 *
 * Filters are the URL's search params (`period`, `from`, `to`, `category`, `workType`, `group`), read with
 * `useSearch` and written by a replacing navigation, the inventory-ui way; the picked project and deal live
 * in memory, because a pick needs its label and the URL carries none (so a deal filter is never present on
 * a first load). Every change of a filter asks again, with the same filters, for the entries (first page),
 * the totals for the chosen "Group by" and the day totals (`groupBy=day`, which T25 puts beside each day's
 * heading); a change of "Group by" alone asks only for the totals. An answer for filters that are no longer
 * the page's is discarded (`useHoursQuery`), and nothing is summed or sorted in the browser.
 *
 * What is applied is what the card shows: a category or work type in the URL that the lists do not hold (a
 * mangled link) is not sent, and while the lists are still loading a link that names one waits for them
 * rather than asking once without it. A Custom range that cannot be sent (To before From, over 366 days, a
 * missing date) asks nothing and the date fields say why.
 */
export default function MyHoursPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Search
  const requested = parseFilterSearch(search)
  const [project, setProject] = useState<ProjectChoice | null>(null)
  const [deal, setDeal] = useState<DealChoice | null>(null)
  const [pickerKey, setPickerKey] = useState(0)

  // The categories and the two work-type lists, once, retired ones included (AC-3.4).
  const lists = useHoursQuery('time-lists', (signal) => getTimeLists({ includeRetired: true, signal }))
  const loadedLists = lists.state.status === 'loaded' ? lists.state.data : null
  const listsView: ListsView = loadedLists
    ? { status: 'loaded', lists: loadedLists }
    : lists.state.status === 'error'
      ? { status: 'error' }
      : { status: 'loading' }

  // A choice only counts once the lists hold it.
  const state = {
    ...requested,
    categoryId: loadedLists?.categories.some((category) => category.id === requested.categoryId)
      ? requested.categoryId
      : '',
    workTypeId: [...(loadedLists?.workTypes.project ?? []), ...(loadedLists?.workTypes.deal ?? [])].some(
      (workType) => workType.id === requested.workTypeId,
    )
      ? requested.workTypeId
      : '',
  }
  const waitingForLists = (requested.categoryId !== '' || requested.workTypeId !== '') && listsView.status === 'loading'

  const { range, errors } = rangeOf(requested.period, requested.from, requested.to, todayZurich())
  const filters: EntryFilters | null =
    range === null || waitingForLists
      ? null
      : {
          whose: 'mine',
          from: range.from,
          to: range.to,
          projectId: project?.id,
          dealId: deal?.id,
          categoryId: state.categoryId || undefined,
          workTypeId: state.workTypeId || undefined,
        }
  const filterKey = JSON.stringify(filters)

  // The three reads of a filter change. The entries and the day totals are drawn by T25.
  useHoursQuery(filters && `entries:${filterKey}`, (signal) => listEntries(filters!, { signal }))
  useHoursQuery(filters && `days:${filterKey}`, (signal) => getTotals('day', filters!, { signal }))
  const totals = useHoursQuery(filters && `totals:${state.group}:${filterKey}`, (signal) =>
    getTotals(state.group, filters!, { signal }),
  )

  const totalsView: TotalsView =
    range === null
      ? { status: 'invalid' }
      : totals.state.status === 'loaded'
        ? { status: 'loaded', answer: totals.state.data }
        : totals.state.status === 'error'
          ? { status: 'error', message: totalsFailure(totals.state.error) }
          : { status: 'loading' }

  const writeSearch = (next: (previous: Search) => Search) => {
    void navigate({ search: next as never, replace: true })
  }

  const change = (patch: FilterPatch) => {
    // Custom opens on the range the person was looking at, not on two empty dates.
    const opening = patch.period === 'custom' && requested.period !== 'custom'
    const withRange = opening && range ? { from: range.from, to: range.to, ...patch } : patch
    writeSearch((previous) => applyFilterPatch(previous, withRange))
  }

  const clear = () => {
    writeSearch(clearFilterSearch)
    setProject(null)
    setDeal(null)
    setPickerKey((current) => current + 1)
  }

  return (
    <section aria-labelledby="hours-my-heading" data-testid="hours-my-page" className="flex flex-col gap-4">
      <PageHeader
        title={strings.myHours.heading}
        titleId="hours-my-heading"
        description={strings.myHours.description}
      />

      <HoursFilters
        state={state}
        rangeErrors={errors}
        project={project}
        deal={deal}
        lists={listsView}
        filtered={isFiltered(state, { project, deal })}
        pickerKey={pickerKey}
        onChange={change}
        onProjectChange={setProject}
        onDealChange={setDeal}
        onClear={clear}
        onRetryLists={lists.reload}
      />

      <TotalsCard
        view={totalsView}
        groupBy={state.group}
        onGroupByChange={(group) => change({ group })}
        onRetry={totals.reload}
      />
    </section>
  )
}
