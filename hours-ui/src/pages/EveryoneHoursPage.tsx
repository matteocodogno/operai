import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Banner, Button, Card, LoadMore, PageHeader, SkeletonRows, StatePanel, VisuallyHidden } from '@operai/ui'
import DealFilterUnavailable from '../components/DealFilterUnavailable'
import EntriesTable from '../components/EntriesTable'
import ErrorBanner from '../components/ErrorBanner'
import HoursBanners from '../components/HoursBanners'
import type { HoursBannersProps } from '../components/HoursBanners'
import HoursFilters from '../components/HoursFilters'
import type { ListsView } from '../components/HoursFilters'
import { applyFilterPatch, clearFilterSearch, isFiltered, parseFilterSearch } from '../components/HoursFiltersState'
import type { FilterPatch } from '../components/HoursFiltersState'
import PermissionDenied from '../components/PermissionDenied'
import type { PeopleView } from '../components/PersonFilter'
import { personOptions } from '../components/PersonFilterOptions'
import TotalsCard from '../components/TotalsCard'
import type { TotalsCardHandle, TotalsView } from '../components/TotalsCard'
import { EVERYONE_GROUP_CHOICES } from '../components/TotalsCardRows'
import { isCode, statusOf } from '../lib/errors'
import type { HoursErrorCode } from '../lib/errors'
import { getTimeLists, getTotals, listEntries } from '../lib/hoursApi'
import type { EntryFilters } from '../lib/hoursApi'
import type { EntriesPage, TimeEntryView } from '../lib/hoursApi.types'
import { hasHiddenName, unavailableSources } from '../lib/names'
import { rangeOf } from '../lib/period'
import { useHoursAccess } from '../lib/permissions'
import type { DealChoice, ProjectChoice } from '../lib/searchers'
import { todayZurich } from '../lib/todayZurich'
import { useHoursPages, useHoursQuery } from '../lib/useHoursQuery'
import type { HoursQueryState } from '../lib/useHoursQuery'
import { strings } from '../strings'

type Search = Record<string, unknown>

/**
 * How long the page waits for the person's permissions before it stops waiting. `usePermissions()` has no
 * "loaded" flag, and an answer that is empty in every field (a person with no grants at all, or an
 * `/authz/me` that failed) cannot be told from one that has not come yet (`lib/permissions`), so a page that
 * waited on it alone would wait for ever. Past this, a person whose permissions did not say they may is
 * treated as one who may not: the denial, and nothing asked.
 */
const PERMISSIONS_WAIT_MS = 3000

/** True once `waiting` has held for `PERMISSIONS_WAIT_MS` without a break; it stays true after that. */
const useWaitedOut = (waiting: boolean): boolean => {
  const [waitedOut, setWaitedOut] = useState(false)
  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setWaitedOut(true), PERMISSIONS_WAIT_MS)
    return () => clearTimeout(timer)
  }, [waiting])
  return waitedOut
}

/** The words for a failed totals read, in the person's language (never the server's English `detail`). */
const totalsFailure = (error: unknown): string =>
  statusOf(error) === null ? strings.common.networkError : strings.totals.error.body

/** The words for a failed read of the entries, likewise. */
const entriesFailure = (error: unknown): string =>
  statusOf(error) === null ? strings.common.networkError : strings.everyone.entries.error.body

const NO_BANNERS: HoursBannersProps = { sources: [], dealGroupingUnavailable: false, hiddenNames: false }

const sameBanners = (a: HoursBannersProps, b: HoursBannersProps): boolean =>
  a.sources.join() === b.sources.join() &&
  a.dealGroupingUnavailable === b.dealGroupingUnavailable &&
  a.hiddenNames === b.hiddenNames

/** A read that came back with one of these refusals of hours-api. */
const failedWith = (state: HoursQueryState<unknown>, ...codes: HoursErrorCode[]): boolean =>
  state.status === 'error' && isCode(state.error, ...codes)

/** Back to My hours, which does not depend on what failed here (ADR-0088): a text link, as the not-found panel has. */
function MyHoursLink({ label }: { label: string }) {
  return (
    <Link to="/" className="link">
      {label}
    </Link>
  )
}

/** The denial: a person who may not see everyone's hours (a typed address, a grant withdrawn meanwhile; AC-4.2). */
function Denied() {
  const t = strings.everyone.denied
  return <PermissionDenied title={t.title} message={t.body} headingLevel={3} action={<MyHoursLink label={t.back} />} />
}

/**
 * Everyone's hours — `/hours/all` (specs/029-time-tracking T29; design F6, S4; ADR-0075, ADR-0090): the same
 * view as My hours over every person's entries — the filters plus Person, the Totals card (by person unless
 * the holder chooses otherwise) and the entries as a flat READ-ONLY table — for holders of
 * `time-entry:read-all`.
 *
 * The permission gates what the page ASKS, as a convenience: the server is the gate, and answers `403
 * read_all_required` to anyone who lacks it, which this page shows as the same denial. The tab that leads
 * here exists only for a holder, but the address can be typed.
 *
 * - while the permissions have not arrived, nothing is asked: a loading line. It does not wait for ever
 *   (`PERMISSIONS_WAIT_MS`): permissions that never say the person may end in the denial;
 * - a person whose permissions say they may not hold it, or any read refused `403 read_all_required` → the
 *   denial, with a link to My hours, in place of everything below the header;
 * - `503 authz_unavailable` on the entries or the totals (`auth` could not say whether the person may,
 *   AC-5.4) → one warning in place of Totals and Entries, saying one's own hours are not affected, with
 *   Retry and a link to My hours; the Filters card stays.
 */
export default function EveryoneHoursPage() {
  const { resolved, canReadAll } = useHoursAccess()
  const waitedOut = useWaitedOut(!resolved && !canReadAll)

  return (
    <section aria-labelledby="hours-everyone-heading" data-testid="hours-everyone-page" className="flex flex-col gap-4">
      <PageHeader
        title={strings.everyone.heading}
        titleId="hours-everyone-heading"
        description={strings.everyone.description}
      />

      {canReadAll ? (
        <EveryoneHoursView />
      ) : resolved || waitedOut ? (
        <Denied />
      ) : (
        <>
          <VisuallyHidden live>{strings.everyone.loading}</VisuallyHidden>
          <SkeletonRows rows={4} testId="hours-everyone-gate-skeleton" />
        </>
      )}
    </section>
  )
}

/**
 * The view of a person who may ask (everything that reads is here, so nothing is read before the gate lets
 * it mount, and a withdrawn grant unmounts it, aborting what is in flight).
 *
 * Filters are the URL's search params (`period`, `from`, `to`, `person`, `category`, `workType`, `group`),
 * read with `useSearch` and written by a replacing navigation, as My hours does; the picked project and deal
 * live in memory. Every read carries `whose=all`. Three reads follow every change of a filter: the entries
 * (first page), the totals for the chosen "Group by", and the people — the `person` groups of the totals
 * under the OTHER filters, without `userId`, so the Person select lists everyone who has hours in the period
 * and choosing one does not narrow it (design gap 2); a change of "Group by" alone asks only for the totals,
 * and choosing a person does not ask for the people again. An answer for filters that are no longer the
 * page's is discarded (`useHoursQuery`), and nothing is summed or sorted in the browser.
 *
 * With a deal filter, a 503 `host_unavailable` on the first page, the totals or the people is the same
 * one state as on My hours (AC-4.11): Totals and Entries are replaced by one alert and nothing is drawn
 * until the link can be read; Retry re-asks all three reads, and focus follows design S1. The people failing
 * any other way is not a failure of the view: the Person select says so and the rest works.
 */
function EveryoneHoursView() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as Search
  const requested = parseFilterSearch(search, 'everyone')
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
          whose: 'all',
          from: range.from,
          to: range.to,
          userId: state.personId || undefined,
          projectId: project?.id,
          dealId: deal?.id,
          categoryId: state.categoryId || undefined,
          workTypeId: state.workTypeId || undefined,
        }
  const filterKey = JSON.stringify(filters)
  // The people are asked under every filter but the person, so their key leaves it out.
  const peopleFilters: EntryFilters | null = filters && { ...filters, userId: undefined }
  const peopleKey = JSON.stringify(peopleFilters)

  const entries = useHoursPages<EntriesPage>(filters && `entries:${filterKey}`, (cursor, signal) =>
    listEntries(filters!, { cursor, signal }),
  )
  const totals = useHoursQuery(filters && `totals:${state.group}:${filterKey}`, (signal) =>
    getTotals(state.group, filters!, { signal }),
  )
  const people = useHoursQuery(peopleFilters && `people:${peopleKey}`, (signal) =>
    getTotals('person', peopleFilters!, { signal, withoutUser: true }),
  )

  const loadedEntries: TimeEntryView[] =
    entries.first.status === 'loaded' ? [...entries.first.data.items, ...entries.more.flatMap((p) => p.items)] : []
  const loadedTotals = totals.state.status === 'loaded' ? totals.state.data : null
  const loadedPeople = people.state.status === 'loaded' ? people.state.data : null

  const totalsView: TotalsView =
    range === null
      ? { status: 'invalid' }
      : totals.state.status === 'loaded'
        ? { status: 'loaded', answer: totals.state.data }
        : totals.state.status === 'error'
          ? { status: 'error', message: totalsFailure(totals.state.error) }
          : { status: 'loading' }

  // Nothing is asked for a range that cannot be sent (and the people then have nothing to wait for).
  const peopleView: PeopleView =
    people.state.status === 'loaded'
      ? { status: 'loaded', options: personOptions(people.state.data) }
      : people.state.status === 'error'
        ? { status: 'error' }
        : range === null
          ? { status: 'loaded', options: [] }
          : { status: 'loading' }

  // What the server says about the person: refused (a grant the page did not know was gone), unable to
  // check (`auth` is down), or — with a deal filter — unable to say which meetings belong to the deal.
  const reads = [entries.first, totals.state, people.state]
  const refused = reads.some((read) => failedWith(read, 'read_all_required'))
  const authzDown = !refused && [entries.first, totals.state].some((read) => failedWith(read, 'authz_unavailable'))
  const blocked = !refused && !authzDown && deal !== null && reads.some((read) => failedWith(read, 'host_unavailable'))

  const totalsCard = useRef<TotalsCardHandle>(null)
  const blocker = useRef<HTMLDivElement>(null)
  const retryFor = useRef<string | null>(null)
  const reading =
    entries.first.status === 'loading' || totals.state.status === 'loading' || people.state.status === 'loading'

  const retryAll = () => {
    retryFor.current = filterKey
    entries.reload()
    totals.reload()
    people.reload()
  }

  // After a Retry of an outage or of the deal-filter state, once every read has settled: focus goes to the
  // Totals heading when they worked and back to the banner when they did not (the Retry that had focus is gone).
  const replaced = authzDown || blocked
  useEffect(() => {
    if (retryFor.current === null || reading) return
    const mine = retryFor.current === filterKey
    retryFor.current = null
    if (!mine) return
    if (replaced) blocker.current?.focus()
    else totalsCard.current?.focusHeading()
  }, [filterKey, reading, replaced])

  // The notes about names. They keep their last settled content while the next answers load, so the Filters
  // card below them does not jump under the pointer on every filter change; with no data (a banner in place
  // of the view) none.
  const live: HoursBannersProps = {
    sources: unavailableSources(
      entries.first.status === 'loaded' ? entries.first.data.unavailable : undefined,
      ...entries.more.map((entriesPage) => entriesPage.unavailable),
      loadedTotals?.unavailable,
      loadedPeople?.unavailable,
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
    writeSearch((previous) => applyFilterPatch(previous, withRange, 'everyone'))
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
  const t = strings.everyone

  if (refused) return <Denied />

  return (
    <>
      <HoursBanners {...(replaced ? NO_BANNERS : banners)} hiddenCopy={t.entries.hidden} />

      <HoursFilters
        state={state}
        rangeErrors={errors}
        project={project}
        deal={deal}
        lists={listsView}
        people={peopleView}
        filtered={filtered}
        pickerKey={pickerKey}
        onChange={change}
        onProjectChange={setProject}
        onDealChange={setDeal}
        onClear={clear}
        onRetryLists={lists.reload}
      />

      {authzDown ? (
        <Banner
          ref={blocker}
          tabIndex={-1}
          tone="warning"
          title={t.authUnavailable.title}
          onRetry={retryAll}
          retryLabel={strings.common.retry}
          retryTestId="hours-authz-unavailable-retry"
          actions={<MyHoursLink label={t.authUnavailable.back} />}
          data-testid="hours-authz-unavailable"
        >
          {t.authUnavailable.body}
        </Banner>
      ) : blocked ? (
        <DealFilterUnavailable ref={blocker} onRetry={retryAll} onClear={clearDeal} />
      ) : (
        <>
          <TotalsCard
            ref={totalsCard}
            view={totalsView}
            groupBy={state.group}
            choices={EVERYONE_GROUP_CHOICES}
            onGroupByChange={(group) => change({ group })}
            onRetry={totals.reload}
          />

          <Card title={strings.entries.title} data-testid="hours-entries">
            {range === null ? (
              <p className="text-sm text-soft" data-testid="hours-entries-invalid">
                {t.entries.invalidPeriod}
              </p>
            ) : entries.first.status === 'loaded' ? (
              entries.first.data.items.length === 0 ? (
                <StatePanel
                  headingLevel={4}
                  title={filtered ? strings.entries.emptyFiltered.title : t.entries.empty.title}
                  action={
                    filtered ? (
                      <Button variant="ghost" onClick={clear} data-testid="hours-entries-clear">
                        {strings.filters.clear}
                      </Button>
                    ) : undefined
                  }
                  testId="hours-entries-empty"
                >
                  {filtered ? strings.entries.emptyFiltered.body : t.entries.empty.body}
                </StatePanel>
              ) : (
                <div className="flex flex-col gap-4">
                  <EntriesTable entries={loadedEntries} />
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
                title={t.entries.error.title}
                message={entriesFailure(entries.first.error)}
                onRetry={entries.reload}
                testId="hours-entries-error"
              />
            ) : (
              <>
                <VisuallyHidden live>{t.entries.loading}</VisuallyHidden>
                <SkeletonRows rows={4} testId="hours-entries-skeleton" />
              </>
            )}
          </Card>
        </>
      )}
    </>
  )
}
