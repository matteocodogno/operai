import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  Banner,
  Button,
  Card,
  LoadMore,
  PageHeader,
  SkeletonRows,
  StatePanel,
  VisuallyHidden,
  formatDate,
} from '@operai/ui'
import DealFilterUnavailable from '../components/DealFilterUnavailable'
import DeleteEntryDialog from '../components/DeleteEntryDialog'
import EntryDayList from '../components/EntryDayList'
import EntryDialog from '../components/EntryDialog'
import { entryIsGone } from '../components/EntryDialogModel'
import ErrorBanner from '../components/ErrorBanner'
import HoursBanners from '../components/HoursBanners'
import type { HoursBannersProps } from '../components/HoursBanners'
import HoursFilters from '../components/HoursFilters'
import type { ListsView } from '../components/HoursFilters'
import { applyFilterPatch, clearFilterSearch, isFiltered, parseFilterSearch } from '../components/HoursFiltersState'
import type { FilterPatch } from '../components/HoursFiltersState'
import SuccessBanner from '../components/SuccessBanner'
import TotalsCard from '../components/TotalsCard'
import type { TotalsCardHandle, TotalsView } from '../components/TotalsCard'
import { isCode, statusOf } from '../lib/errors'
import { createEntry, deleteEntry, getTimeLists, getTotals, listEntries, updateEntry } from '../lib/hoursApi'
import type { EntryFilters } from '../lib/hoursApi'
import type { EntriesPage, EntryInput, EntryPatch, TimeEntryView, TotalsAnswer } from '../lib/hoursApi.types'
import { hasHiddenName, unavailableSources } from '../lib/names'
import { rangeOf } from '../lib/period'
import type { DealChoice, ProjectChoice } from '../lib/searchers'
import { todayZurich } from '../lib/todayZurich'
import { useHoursPages, useHoursQuery } from '../lib/useHoursQuery'
import type { HoursQueryState } from '../lib/useHoursQuery'
import { strings } from '../strings'

type Search = Record<string, unknown>

/** The words for a failed totals read, in the person's language (never the server's English `detail`). */
const totalsFailure = (error: unknown): string =>
  statusOf(error) === null ? strings.common.networkError : strings.totals.error.body

/** The words for a failed read of the entries, likewise. */
const entriesFailure = (error: unknown): string =>
  statusOf(error) === null ? strings.common.networkError : strings.entries.error.body

const NO_BANNERS: HoursBannersProps = { sources: [], dealGroupingUnavailable: false, hiddenNames: false }

const sameBanners = (a: HoursBannersProps, b: HoursBannersProps): boolean =>
  a.sources.join() === b.sources.join() &&
  a.dealGroupingUnavailable === b.dealGroupingUnavailable &&
  a.hiddenNames === b.hiddenNames

/** Meetings cannot say which meetings belong to the deal: the refusal AC-4.11 turns into one state. */
const refusedDealRead = (state: HoursQueryState<unknown>): boolean =>
  state.status === 'error' && isCode(state.error, 'host_unavailable')

/** The `groupBy=day` answer as day → minutes: the figure beside each day's heading, never a client sum. */
const dayTotalsOf = (answer: TotalsAnswer): ReadonlyMap<string, number> =>
  new Map(answer.groups.flatMap((group) => (group.kind === 'keyed' ? [[group.key, group.minutes] as const] : [])))

/**
 * My hours — `/hours`. The filters and the Totals card (T24), the entries by day with the server's day totals
 * and the banners (T25); the entry dialog (T27, T28) and the export (T30) join them.
 *
 * Filters are the URL's search params (`period`, `from`, `to`, `category`, `workType`, `group`), read with
 * `useSearch` and written by a replacing navigation, the inventory-ui way; the picked project and deal live
 * in memory, because a pick needs its label and the URL carries none (so a deal filter is never present on
 * a first load). Every change of a filter asks again, with the same filters, for the entries (first page),
 * the totals for the chosen "Group by" and the day totals (`groupBy=day`, the figure beside each day's
 * heading); a change of "Group by" alone asks only for the totals. An answer for filters that are no longer
 * the page's is discarded (`useHoursQuery`), and nothing is summed or sorted in the browser.
 *
 * What is applied is what the card shows: a category or work type in the URL that the lists do not hold (a
 * mangled link) is not sent, and while the lists are still loading a link that names one waits for them
 * rather than asking once without it. A Custom range that cannot be sent (To before From, over 366 days, a
 * missing date) asks nothing and the date fields say why.
 *
 * With a deal filter, a 503 `host_unavailable` on the first page, the totals or the day totals means
 * Meetings cannot say which meetings belong to the deal (AC-4.11): Totals and Entries are replaced by one
 * alert, and nothing is drawn until the link can be read. Retry re-asks all three reads; focus then goes to
 * the Totals heading if they worked and to the banner if they did not. A failed "Load more" is not that
 * state: the pages already shown were complete when read and stay, with the error below them (D48).
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

  // The three reads of a filter change: the entries (a cursor-paged list), the day totals that label them,
  // and the totals for the chosen "Group by".
  const entries = useHoursPages<EntriesPage>(filters && `entries:${filterKey}`, (cursor, signal) =>
    listEntries(filters!, { cursor, signal }),
  )
  const days = useHoursQuery(filters && `days:${filterKey}`, (signal) => getTotals('day', filters!, { signal }))
  const totals = useHoursQuery(filters && `totals:${state.group}:${filterKey}`, (signal) =>
    getTotals(state.group, filters!, { signal }),
  )

  const loadedDays = days.state.status === 'loaded' ? days.state.data : null
  const dayTotals = useMemo(() => (loadedDays ? dayTotalsOf(loadedDays) : null), [loadedDays])
  const loadedEntries: TimeEntryView[] =
    entries.first.status === 'loaded' ? [...entries.first.data.items, ...entries.more.flatMap((p) => p.items)] : []
  const loadedTotals = totals.state.status === 'loaded' ? totals.state.data : null

  const totalsView: TotalsView =
    range === null
      ? { status: 'invalid' }
      : totals.state.status === 'loaded'
        ? { status: 'loaded', answer: totals.state.data }
        : totals.state.status === 'error'
          ? { status: 'error', message: totalsFailure(totals.state.error) }
          : { status: 'loading' }

  // AC-4.11: with a deal filter, a refused first page, totals or day totals is ONE state for the whole view.
  const blocked =
    deal !== null && (refusedDealRead(entries.first) || refusedDealRead(totals.state) || refusedDealRead(days.state))

  const totalsCard = useRef<TotalsCardHandle>(null)
  const blocker = useRef<HTMLDivElement>(null)
  const retryFor = useRef<string | null>(null)
  const reading =
    entries.first.status === 'loading' || days.state.status === 'loading' || totals.state.status === 'loading'

  const retryAll = () => {
    retryFor.current = filterKey
    entries.reload()
    days.reload()
    totals.reload()
  }

  // After a Retry of the blocked state, once every read has settled: focus goes to the Totals heading when
  // they worked and back to the banner when they did not (the Retry button that had focus is gone).
  useEffect(() => {
    if (retryFor.current === null || reading) return
    const mine = retryFor.current === filterKey
    retryFor.current = null
    if (!mine) return
    if (blocked) blocker.current?.focus()
    else totalsCard.current?.focusHeading()
  }, [filterKey, reading, blocked])

  // The notes about names. They keep their last settled content while the next answers load, so the Filters
  // card below them does not jump under the pointer on every filter change; with no data (blocked) none.
  const live: HoursBannersProps = {
    sources: unavailableSources(
      entries.first.status === 'loaded' ? entries.first.data.unavailable : undefined,
      ...entries.more.map((entriesPage) => entriesPage.unavailable),
      loadedTotals?.unavailable,
      loadedDays?.unavailable,
    ),
    dealGroupingUnavailable: state.group === 'deal' && (loadedTotals?.unavailable.includes('meeting-deals') ?? false),
    hiddenNames: hasHiddenName(loadedEntries, loadedTotals),
  }
  const [banners, setBanners] = useState(live)
  if (!reading && !sameBanners(banners, live)) setBanners(live)

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

  const clearDeal = () => {
    setDeal(null)
    document.querySelector<HTMLElement>('[data-testid="hours-filter-deal-input"]')?.focus()
  }

  const filtered = isFiltered(state, { project, deal })

  // What the person did here, said where they did it: a save, a delete, or "it was already gone". Each is a new
  // banner (the `count` remounts it, so its 3 s timer starts over).
  const [notice, setNotice] = useState<{ kind: 'saved' | 'deleted' | 'gone'; message: string; count: number } | null>(
    null,
  )
  const say = (kind: 'saved' | 'deleted' | 'gone', message: string) =>
    setNotice((previous) => ({ kind, message, count: (previous?.count ?? 0) + 1 }))

  // Every write that changed what the list shows asks the three reads again with the same filters.
  const readAgain = () => {
    entries.reload()
    days.reload()
    totals.reload()
  }

  // Where focus goes once a write has taken the row it came from out of the page (the list is read again, so the
  // button that opened the dialog is gone): the heading after a delete, Record hours after an edit (design F1–F3).
  const heading = useRef<HTMLHeadingElement>(null)
  const recordButton = useRef<HTMLButtonElement>(null)
  const [focusRequest, setFocusRequest] = useState<{ on: 'heading' | 'record' } | null>(null)
  useEffect(() => {
    if (focusRequest === null) return
    ;(focusRequest.on === 'heading' ? heading : recordButton).current?.focus()
  }, [focusRequest])

  // Recording (T27). A save that worked closes the dialog (focus goes back to Record hours: the library gives
  // it to the button that opened the dialog), asks the three reads again with the same filters, and says so;
  // a save that was refused rejects into the dialog, which words it, and nothing here changes.
  const [recording, setRecording] = useState(false)
  const outsidePeriod = (day: string) => range !== null && (day < range.from || day > range.to)
  const savedMessage = (day: string | undefined) =>
    day !== undefined && outsidePeriod(day) ? strings.entry.savedOutsidePeriod(formatDate(day)) : strings.entry.saved
  const record = async (input: EntryInput) => {
    await createEntry(input)
    setRecording(false)
    say('saved', savedMessage(input.day))
    readAgain()
  }

  // Editing (T28; design F2). The dialog sends only the members the person changed; a save that worked closes it,
  // reads again and says so. When the entry itself is gone (`entryIsGone`: hours-api's 404 with no code, or any
  // 404 on a save that kept the target) the dialog says so and stays, and the list is read again when it closes;
  // a `not_found` after a move is the new target's, answered on the picker, and the list is not stale.
  const [editing, setEditing] = useState<TimeEntryView | null>(null)
  const listIsStale = useRef(false)
  const edit = async (entry: TimeEntryView, patch: EntryPatch) => {
    try {
      await updateEntry(entry.id, patch)
    } catch (error) {
      if (entryIsGone(error, patch.on !== undefined)) listIsStale.current = true
      throw error
    }
    listIsStale.current = false
    setEditing(null)
    say('saved', savedMessage(patch.day))
    readAgain()
    setFocusRequest({ on: 'record' })
  }
  const closeEdit = () => {
    setEditing(null)
    if (!listIsStale.current) return
    listIsStale.current = false
    readAgain()
    setFocusRequest({ on: 'heading' })
  }

  // Deleting (T28; design F3). A 404 is "already gone": it is what the person wanted, so it closes, reads again
  // and says so; any other failure rejects into the dialog, which stays open with the error.
  const [deleting, setDeleting] = useState<TimeEntryView | null>(null)
  const remove = async (entry: TimeEntryView) => {
    try {
      await deleteEntry(entry.id)
      say('deleted', strings.entry.delete.deleted)
    } catch (error) {
      if (statusOf(error) !== 404) throw error
      say('gone', strings.entry.delete.gone)
    }
    setDeleting(null)
    readAgain()
    setFocusRequest({ on: 'heading' })
  }

  return (
    <section aria-labelledby="hours-my-heading" data-testid="hours-my-page" className="flex flex-col gap-4">
      <PageHeader
        title={strings.myHours.heading}
        titleId="hours-my-heading"
        headingRef={heading}
        focusableHeading
        description={strings.myHours.description}
        actions={
          <Button
            ref={recordButton}
            variant="primary"
            aria-haspopup="dialog"
            onClick={() => setRecording(true)}
            data-testid="hours-record"
          >
            {strings.entry.record}
          </Button>
        }
      />

      {notice !== null &&
        (notice.kind === 'gone' ? (
          <Banner
            key={notice.count}
            tone="info"
            compact
            onDismiss={() => setNotice(null)}
            dismissLabel={strings.common.dismiss}
            dismissTestId="hours-entry-gone-dismiss"
            data-testid="hours-entry-gone"
          >
            {notice.message}
          </Banner>
        ) : (
          <SuccessBanner
            key={notice.count}
            message={notice.message}
            onDismiss={() => setNotice(null)}
            testId={`hours-entry-${notice.kind}`}
          />
        ))}

      <HoursBanners {...(blocked ? NO_BANNERS : banners)} />

      <HoursFilters
        state={state}
        rangeErrors={errors}
        project={project}
        deal={deal}
        lists={listsView}
        filtered={filtered}
        pickerKey={pickerKey}
        onChange={change}
        onProjectChange={setProject}
        onDealChange={setDeal}
        onClear={clear}
        onRetryLists={lists.reload}
      />

      {blocked ? (
        <DealFilterUnavailable ref={blocker} onRetry={retryAll} onClear={clearDeal} />
      ) : (
        <>
          <TotalsCard
            ref={totalsCard}
            view={totalsView}
            groupBy={state.group}
            onGroupByChange={(group) => change({ group })}
            onRetry={totals.reload}
          />

          <Card title={strings.entries.title} data-testid="hours-entries">
            {range === null ? (
              <p className="text-sm text-soft" data-testid="hours-entries-invalid">
                {strings.entries.invalidPeriod}
              </p>
            ) : entries.first.status === 'loaded' ? (
              entries.first.data.items.length === 0 ? (
                <StatePanel
                  headingLevel={4}
                  title={filtered ? strings.entries.emptyFiltered.title : strings.entries.empty.title}
                  action={
                    filtered ? (
                      <Button variant="ghost" onClick={clear} data-testid="hours-entries-clear">
                        {strings.filters.clear}
                      </Button>
                    ) : undefined
                  }
                  testId="hours-entries-empty"
                >
                  {filtered ? strings.entries.emptyFiltered.body : strings.entries.empty.body}
                </StatePanel>
              ) : (
                <div className="flex flex-col gap-4">
                  {days.state.status === 'error' && (
                    <Banner
                      tone="warning"
                      compact
                      onRetry={days.reload}
                      retryLabel={strings.common.retry}
                      retryTestId="hours-day-totals-error-retry"
                      data-testid="hours-day-totals-error"
                    >
                      {strings.entries.dayTotalsError}
                    </Banner>
                  )}
                  <EntryDayList
                    entries={loadedEntries}
                    dayTotals={dayTotals}
                    onEdit={setEditing}
                    onDelete={setDeleting}
                  />
                  {(entries.hasMore || entries.more.length > 0 || entries.moreFailed) && (
                    <LoadMore
                      hasMore={entries.hasMore}
                      loading={entries.loadingMore}
                      onLoadMore={entries.loadMore}
                      label={strings.entries.loadMore}
                      loadingLabel={strings.entries.loadingMore}
                      announcement={
                        entries.more.length > 0 && !entries.loadingMore && !entries.moreFailed
                          ? strings.entries.loadedMore(entries.more.at(-1)!.items.length, loadedEntries.length)
                          : ''
                      }
                      error={entries.moreFailed ? strings.entries.loadMoreError : null}
                      testId="hours-entries-load-more"
                    />
                  )}
                </div>
              )
            ) : entries.first.status === 'error' ? (
              <ErrorBanner
                title={strings.entries.error.title}
                message={entriesFailure(entries.first.error)}
                onRetry={entries.reload}
                testId="hours-entries-error"
              />
            ) : (
              <>
                <VisuallyHidden live>{strings.entries.loading}</VisuallyHidden>
                <SkeletonRows rows={4} testId="hours-entries-skeleton" />
              </>
            )}
          </Card>
        </>
      )}

      {recording && (
        <EntryDialog
          lists={listsView}
          onReloadLists={lists.reload}
          onSubmit={record}
          onCancel={() => setRecording(false)}
        />
      )}

      {editing !== null && (
        <EntryDialog
          entry={editing}
          lists={listsView}
          onReloadLists={lists.reload}
          onSubmit={(patch) => edit(editing, patch)}
          onCancel={closeEdit}
        />
      )}

      {deleting !== null && (
        <DeleteEntryDialog entry={deleting} onConfirm={() => remove(deleting)} onCancel={() => setDeleting(null)} />
      )}
    </section>
  )
}
