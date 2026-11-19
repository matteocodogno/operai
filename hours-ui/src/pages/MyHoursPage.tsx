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
  tabPanelProps,
} from '@operai/ui'
import DealFilterUnavailable from '../components/DealFilterUnavailable'
import DeleteEntryDialog from '../components/DeleteEntryDialog'
import EntryDayList from '../components/EntryDayList'
import EntryDialog from '../components/EntryDialog'
import { entryIsGone } from '../components/EntryDialogModel'
import ErrorBanner from '../components/ErrorBanner'
import HoursBanners from '../components/HoursBanners'
import type { HoursBannersProps } from '../components/HoursBanners'
import HoursExport from '../components/HoursExport'
import HoursFilters from '../components/HoursFilters'
import type { ListsView } from '../components/HoursFilters'
import {
  applyFilterPatch,
  clearFilterSearch,
  isFiltered,
  parseFilterSearch,
  readMyHoursAddress,
  withList,
  withTable,
  withTablePeriod,
} from '../components/HoursFiltersState'
import type { FilterPatch, MyHoursView } from '../components/HoursFiltersState'
import SuccessBanner from '../components/SuccessBanner'
import TotalsCard from '../components/TotalsCard'
import type { TotalsCardHandle, TotalsView } from '../components/TotalsCard'
import ViewSwitch from '../components/ViewSwitch'
import TableCellDialog from '../components/TableCellDialog'
import TableView from '../components/TableView'
import type { TableViewHandle, TableViewState } from '../components/TableView'
import { cellOf } from '../components/TableViewModel'
import { isCode, statusOf } from '../lib/errors'
import { readAllEntries } from '../lib/exportPages'
import { createEntry, deleteEntry, getTimeLists, getTotals, listEntries, updateEntry } from '../lib/hoursApi'
import type { EntryFilters } from '../lib/hoursApi'
import type { EntriesPage, EntryInput, EntryPatch, TimeEntryView, TotalsAnswer } from '../lib/hoursApi.types'
import { hasHiddenName, unavailableSources } from '../lib/names'
import { rangeOf } from '../lib/period'
import type { DealChoice, ProjectChoice } from '../lib/searchers'
import { todayZurich } from '../lib/todayZurich'
import { useHoursPages, useHoursQuery } from '../lib/useHoursQuery'
import type { HoursQueryState } from '../lib/useHoursQuery'
import { tableGrid } from '../lib/tableGrid'
import type { TableGrid, TableGridRow } from '../lib/tableGrid'
import { daysOf, firstDayOf, lastDayOf, switchTo } from '../lib/tablePeriod'
import type { TablePeriod, TablePeriodKind } from '../lib/tablePeriod'
import { readWeekParam } from '../lib/week'
import { strings } from '../strings'

type Search = Record<string, unknown>

/** The words for a failed totals read, in the person's language (never the server's English `detail`). */
const totalsFailure = (error: unknown): string =>
  statusOf(error) === null ? strings.common.networkError : strings.totals.error.body

/** The words for a failed read of the entries, likewise. */
const entriesFailure = (error: unknown): string =>
  statusOf(error) === null ? strings.common.networkError : strings.entries.error.body

/**
 * The words for a failed read of the week: the network line for a request that never got an answer, the List's
 * "try again" for everything else — a refusal, and the fold refusing an entry that is not of the week asked for (a
 * server bug, `RangeError`), which is no fault of the connection.
 */
const tableFailure = (error: unknown): string =>
  statusOf(error) === null && !(error instanceof RangeError) ? strings.common.networkError : strings.entries.error.body

/**
 * The one read of a period: every entry of the period and filters, all or nothing (`readAllEntries`, plan Decision 1),
 * folded into the grid here, so an entry outside the period (a server bug) is a failed read with Retry rather than an
 * error thrown while the page draws.
 */
const readTable = async (filters: EntryFilters, period: TablePeriod, signal: AbortSignal) => {
  const { items, unavailable } = await readAllEntries(filters, { signal })
  return { grid: tableGrid(items, daysOf(period)), items, unavailable }
}

/** Prefix of the ids the view switch's tabs and its panel point at each other with. */
const VIEW_ID = 'hours-view'

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
 * My hours — `/hours`, which opens on the table view of the current week (T19, AC-5.1 reversed: it opened on the List); the
 * List is `?view=list`, `?week=<day>` shows another week and `?view=month[&month=<YYYY-MM>]` a month (T22, AC-5.2;
 * `readMyHoursAddress`, plan § The address of My hours). The
 * filters and the Totals card (T24), the entries by day with the server's day totals and the banners (T25); the entry
 * dialog (T27, T28); the Export button of the Entries card (T30, `HoursExport`: every page of the same filters as one
 * XLSX) are the List's.
 *
 * Filters are the URL's search params (`period`, `from`, `to`, `target` (Recorded on), `category`, `workType`,
 * `group`), read with `useSearch` and written by a replacing navigation, the inventory-ui way; the picked project and deal live
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
 * state: the pages already shown were complete when read and stay, with the error below them (D48). The
 * export's walk (T30) can meet the same refusal: it tells the page, which shows the same alert (the Export
 * button is gone with the Entries card, so the alert takes focus) and nothing is downloaded.
 *
 * The table (specs/20261116-record-hours-in-place T10, T12, T20): one complete read of the period folded into a grid. An
 * empty cell is not a control and the page hears nothing of it (AC-5.32). Every write reads the period again (the grid is
 * replaced meanwhile, so the control that had focus is gone): focus then goes to the cell that was acted on or, when that
 * cell is blank now or is not a control, to the card's heading — never to the page body; a save on a day outside the
 * period says so.
 *
 * A cell that holds hours opens `TableCellDialog` (design F5, S8): its entries with the List's Edit and Delete, and Add
 * hours, which opens My hours' own entry dialog on that day and row, both still changeable (AC-5.13, AC-5.18). Edit,
 * Delete and Add hours open the same dialogs the List opens, over it. The dialog is drawn from the last grid that
 * loaded, so it keeps its entries while the period is read again after a write and updates in place when the new one
 * lands; it closes by itself when the cell holds no entry any more, and the focus is the dialog's to keep (the page's own
 * focus requests are for the List and for a write made with the dialog closed).
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

  // The view of the page (plan Decision 5, 10): the table view, at the period the address names — the current week unless
  // `?week` names another — or the List, at `?view=list`. One page, two reads; the other view's reads ask nothing (a null
  // key), so only what is on screen is asked.
  const today = todayZurich()
  const address = readMyHoursAddress(search, today)
  const view: MyHoursView = address.view
  const period: TablePeriod | null = address.view === 'table' ? address.period : null
  const tableShown = period !== null

  const { range, errors } = rangeOf(requested.period, requested.from, requested.to, today)
  const applied = {
    whose: 'mine' as const,
    target: state.target || undefined,
    projectId: project?.id,
    dealId: deal?.id,
    categoryId: state.categoryId || undefined,
    workTypeId: state.workTypeId || undefined,
  }
  const filters: EntryFilters | null =
    tableShown || range === null || waitingForLists ? null : { ...applied, from: range.from, to: range.to }
  const filterKey = JSON.stringify(filters)
  // The table: its period takes the place of the List's, every other filter applies (AC-5.21, WA5).
  const tableFilters: EntryFilters | null =
    period === null || waitingForLists ? null : { ...applied, from: firstDayOf(period), to: lastDayOf(period) }
  const tableKey = JSON.stringify(tableFilters)

  // The three reads of a filter change: the entries (a cursor-paged list), the day totals that label them,
  // and the totals for the chosen "Group by".
  const entries = useHoursPages<EntriesPage>(filters && `entries:${filterKey}`, (cursor, signal) =>
    listEntries(filters!, { cursor, signal }),
  )
  const days = useHoursQuery(filters && `days:${filterKey}`, (signal) => getTotals('day', filters!, { signal }))
  const totals = useHoursQuery(filters && `totals:${state.group}:${filterKey}`, (signal) =>
    getTotals(state.group, filters!, { signal }),
  )
  // The table's one read: every entry of the period, complete or failed, folded into the grid (plan Decision 1).
  const tableRead = useHoursQuery(tableFilters && `table:${tableKey}`, (signal) =>
    readTable(tableFilters!, period!, signal),
  )
  const loadedTable = tableRead.state.status === 'loaded' ? tableRead.state.data : null

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

  // AC-4.11: with a deal filter, a refused first page, totals or day totals is ONE state for the whole view — and
  // so is an export the same refusal stopped (T30). That one is remembered as the first page it was made over, so
  // it is gone the moment the view reads again (Retry, any change of a filter) and can never block a later view.
  const firstPage = entries.first.status === 'loaded' ? entries.first.data : null
  const [exportRefusedFor, setExportRefusedFor] = useState<EntriesPage | null>(null)
  const exportRefused = firstPage !== null && exportRefusedFor === firstPage
  const blocked =
    deal !== null &&
    (refusedDealRead(entries.first) ||
      refusedDealRead(totals.state) ||
      refusedDealRead(days.state) ||
      refusedDealRead(tableRead.state) ||
      exportRefused)

  const totalsCard = useRef<TotalsCardHandle>(null)
  const tableView = useRef<TableViewHandle>(null)
  const blocker = useRef<HTMLDivElement>(null)
  const retryFor = useRef<string | null>(null)
  const reading = tableShown
    ? tableRead.state.status === 'loading'
    : entries.first.status === 'loading' || days.state.status === 'loading' || totals.state.status === 'loading'
  // What the view reads is named by one key, so a Retry is remembered as the read it was made for.
  const readKey = tableShown ? tableKey : filterKey

  const retryAll = () => {
    retryFor.current = readKey
    if (tableShown) {
      tableRead.reload()
      return
    }
    entries.reload()
    days.reload()
    totals.reload()
  }

  // After a Retry of the blocked state, or of a period that could not be read, once every read has settled: focus goes
  // to the Totals heading (the table card's, in the table view) when they worked and back to the banner when they did not
  // (the Retry button that had focus is gone: in the blocked state the banner itself, in a failed period the new Retry).
  // A Retry whose view was left before it answered moves nothing.
  const tableFailed = tableRead.state.status === 'error'
  useEffect(() => {
    if (retryFor.current === null || reading) return
    const mine = retryFor.current === readKey
    retryFor.current = null
    if (!mine) return
    if (blocked) blocker.current?.focus()
    else if (tableShown && tableFailed) tableView.current?.focusRetry()
    else if (tableShown) tableView.current?.focusHeading()
    else totalsCard.current?.focusHeading()
  }, [readKey, reading, blocked, tableShown, tableFailed])

  // An export the refusal stopped: the Export button had focus and is gone with the Entries card, so the banner
  // takes it (design F5). A person who has gone on to another control keeps theirs.
  const exportBlocked = blocked && exportRefused
  useEffect(() => {
    if (!exportBlocked) return
    const active = document.activeElement
    if (active === null || active === document.body) blocker.current?.focus()
  }, [exportBlocked])

  // The notes about names. They keep their last settled content while the next answers load, so the Filters
  // card below them does not jump under the pointer on every filter change; with no data (blocked) none.
  // In the table view they are what the walk of the period found: the sources it could not ask, and names it may not show.
  const live: HoursBannersProps = tableShown
    ? {
        sources: loadedTable?.unavailable ?? [],
        dealGroupingUnavailable: false,
        hiddenNames: hasHiddenName(loadedTable?.items ?? []),
      }
    : {
        sources: unavailableSources(
          entries.first.status === 'loaded' ? entries.first.data.unavailable : undefined,
          ...entries.more.map((entriesPage) => entriesPage.unavailable),
          loadedTotals?.unavailable,
          loadedDays?.unavailable,
        ),
        dealGroupingUnavailable:
          state.group === 'deal' && (loadedTotals?.unavailable.includes('meeting-deals') ?? false),
        hiddenNames: hasHiddenName(loadedEntries, loadedTotals),
      }
  // The last settled notes, kept of the view they were read for: the other view's are not this view's.
  const [shownBanners, setBanners] = useState<{ view: MyHoursView; props: HoursBannersProps }>({ view, props: live })
  if (!reading && (shownBanners.view !== view || !sameBanners(shownBanners.props, live)))
    setBanners({ view, props: live })
  const banners = shownBanners.view === view ? shownBanners.props : NO_BANNERS

  const writeSearch = (next: (previous: Search) => Search) => {
    void navigate({ search: next as never, replace: true })
  }

  const change = (patch: FilterPatch) => {
    // Custom opens on the range the person was looking at, not on two empty dates.
    const opening = patch.period === 'custom' && requested.period !== 'custom'
    const withRange = opening && range ? { from: range.from, to: range.to, ...patch } : patch
    writeSearch((previous) => applyFilterPatch(previous, withRange))
  }

  // The view and the period are addresses of the page, not filters: they change nothing else in it (AC-5.22). Choosing the
  // view already shown writes nothing (a stray `month` in a week's address must not turn it into the month's).
  const switchView = (next: MyHoursView) => {
    if (next === view) return
    writeSearch((previous) => (period === null ? withTable(previous, today) : withList(previous, period)))
  }
  const changePeriod = (next: TablePeriod) => writeSearch((previous) => withTablePeriod(previous, next, today))
  // The Period switch (AC-5.26, AC-5.27): which period the other kind shows is `switchTo`'s, with the week the month was
  // reached from — the address's `week` — as the one Month → Week returns to.
  const changeKind = (kind: TablePeriodKind) => {
    if (period === null) return
    writeSearch((previous) =>
      withTablePeriod(previous, switchTo(period, kind, today, readWeekParam(previous, today)), today),
    )
  }

  const clear = () => {
    writeSearch((previous) => clearFilterSearch(previous, view))
    setProject(null)
    setDeal(null)
    setPickerKey((current) => current + 1)
  }

  const clearDeal = () => {
    setDeal(null)
    document.querySelector<HTMLElement>('[data-testid="hours-filter-deal-input"]')?.focus()
  }

  const filtered = isFiltered(state, { project, deal }, view)

  // What the person did here, said where they did it: a save, a delete, or "it was already gone". Each is a new
  // banner (the `count` remounts it, so its 3 s timer starts over).
  const [notice, setNotice] = useState<{ kind: 'saved' | 'deleted' | 'gone'; message: string; count: number } | null>(
    null,
  )
  const say = (kind: 'saved' | 'deleted' | 'gone', message: string) =>
    setNotice((previous) => ({ kind, message, count: (previous?.count ?? 0) + 1 }))

  // Every write that changed what the page shows asks again, with the same filters, for what is on screen: the
  // three reads of the List, or the table's one.
  const readAgain = () => {
    if (tableShown) {
      tableRead.reload()
      return
    }
    entries.reload()
    days.reload()
    totals.reload()
  }

  // The table is replaced by a skeleton while it is read again after a write, so the control that had focus is gone:
  // once the new grid is there, focus goes to the cell that was acted on if it is still a control, else to the card's
  // heading — never to the page body (design S7 "Focus after a write"). The request waits for the read to settle and is
  // dropped with the view. It is state, numbered, and the effect remembers the last one it has answered: so a request made when
  // nothing is being read (a dialog closed by hand) is looked at on the render that follows it, which a ref
  // read only when the status changed would never do.
  const [tableFocus, setTableFocus] = useState<{ id: number; cell: string | null } | null>(null)
  const handledFocus = useRef(0)
  const askTableFocus = (cell: string | null) => setTableFocus((previous) => ({ id: (previous?.id ?? 0) + 1, cell }))
  const tableStatus = tableRead.state.status
  useEffect(() => {
    if (tableFocus === null || tableFocus.id === handledFocus.current) return
    if (!tableShown) {
      handledFocus.current = tableFocus.id
      return
    }
    if (tableStatus === 'loading' || tableStatus === 'idle') return
    handledFocus.current = tableFocus.id
    if (tableStatus === 'loaded' && tableFocus.cell !== null && tableView.current?.focusCell(tableFocus.cell)) return
    tableView.current?.focusHeading()
  }, [tableFocus, tableShown, tableStatus])

  // The cell dialog (T12; design F5, S8). It is opened on a cell of the period and filters shown, and drawn from the last
  // grid that loaded — not from the read in flight, which is `loading` after every write — so its list does not blank
  // while the period is read again and then updates in place. It belongs to the table and to the period it was opened on:
  // leaving either closes it for good (coming back does not find it open), and so does its cell running out of entries
  // (deleted, or edited onto another day or row): the dialog closes once the new figures are there and focus goes to the
  // card's heading, since a blank cell is no control (T20, AC-5.32). An empty list in a dialog would be a dead end.
  const [openCell, setOpenCell] = useState<{ rowKey: string; day: string; tableKey: string } | null>(null)
  const [lastGrid, setLastGrid] = useState<{ tableKey: string; grid: TableGrid } | null>(null)
  if (loadedTable !== null && lastGrid?.grid !== loadedTable.grid) setLastGrid({ tableKey, grid: loadedTable.grid })
  const cellInGrid =
    openCell !== null && lastGrid !== null && lastGrid.tableKey === openCell.tableKey
      ? cellOf(lastGrid.grid, openCell.rowKey, openCell.day)
      : null
  if (openCell !== null && (!tableShown || openCell.tableKey !== tableKey)) {
    setOpenCell(null)
  } else if (openCell !== null && lastGrid?.tableKey === openCell.tableKey && cellInGrid === null) {
    setOpenCell(null)
    askTableFocus(null)
  }
  // Closing it by hand: the button it was opened from is still there unless a write has replaced the grid, so the
  // library's "focus goes back to the opener" is not enough on its own.
  const closeCell = () => {
    if (openCell !== null) askTableFocus(`${openCell.rowKey}:${openCell.day}`)
    setOpenCell(null)
  }
  // A write made from the dialog is made over it: the page's own focus after a write (the heading, Record hours) would
  // pull it from behind a modal. The library gives it back to the button that opened the dialog that wrote, and the
  // cell dialog keeps the rest.
  const fromCellDialog = cellInGrid !== null

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
  // A saved day the view does not show is said, or the entry looks lost: the List's is its period (hidden in the table,
  // so nothing is said about it there), the table's is the period it shows, first day to last (design F6, S7).
  const savedMessage = (day: string | undefined) => {
    if (day === undefined) return strings.entry.saved
    if (period !== null) {
      return day < firstDayOf(period) || day > lastDayOf(period)
        ? strings.table[period.kind].savedOutside(formatDate(day))
        : strings.entry.saved
    }
    return range !== null && (day < range.from || day > range.to)
      ? strings.entry.savedOutsidePeriod(formatDate(day))
      : strings.entry.saved
  }
  const record = async (input: EntryInput) => {
    await createEntry(input)
    setRecording(false)
    say('saved', savedMessage(input.day))
    readAgain()
  }

  // Add hours in a cell's list (T12; design F5, S9; AC-5.13, AC-5.18): My hours' own dialog, opened over the cell dialog on
  // the cell's day and the row's target, which can still be changed (`preset`, not `fixed`: WA6), with the keyboard on
  // Duration (`focus`, G7) because the choice of the cell already chose the day and the target. It is the only way into a
  // preset dialog: an empty cell records nothing (AC-5.32). The library gives focus back to Add hours, which is still
  // there, and the cell dialog lists the new entry once the table is read again — unless the person moved it elsewhere.
  const [recordingCell, setRecordingCell] = useState<{ row: TableGridRow; day: string } | null>(null)
  const recordInCell = async (input: EntryInput) => {
    await createEntry(input)
    setRecordingCell(null)
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
    if (!fromCellDialog) setFocusRequest({ on: 'record' })
  }
  const closeEdit = () => {
    setEditing(null)
    if (!listIsStale.current) return
    listIsStale.current = false
    readAgain()
    if (!fromCellDialog) setFocusRequest({ on: 'heading' })
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
    if (!fromCellDialog) setFocusRequest({ on: 'heading' })
  }

  // What the table view shows in place of the grid, or the grid: one state (design S7). The refusal that blocks the List
  // blocks the table as well, in the card, with its heading and toolbar kept.
  const tableState: TableViewState = blocked
    ? { status: 'replaced', content: <DealFilterUnavailable ref={blocker} onRetry={retryAll} onClear={clearDeal} /> }
    : tableRead.state.status === 'loaded'
      ? { status: 'loaded', grid: tableRead.state.data.grid }
      : tableRead.state.status === 'error'
        ? { status: 'error', message: tableFailure(tableRead.state.error) }
        : { status: 'loading' }

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

      <ViewSwitch value={view} idPrefix={VIEW_ID} onChange={switchView} />

      <div {...tabPanelProps(VIEW_ID, view)} className="flex flex-col gap-4">
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
          showPeriod={!tableShown}
          filtered={filtered}
          pickerKey={pickerKey}
          onChange={change}
          onProjectChange={setProject}
          onDealChange={setDeal}
          onClear={clear}
          onRetryLists={lists.reload}
        />

        {period !== null ? (
          <TableView
            ref={tableView}
            period={period}
            today={today}
            filtered={filtered}
            state={tableState}
            onPeriodChange={changePeriod}
            onKindChange={changeKind}
            onRetry={retryAll}
            onClearFilters={clear}
            onOpenCell={(row, day) => setOpenCell({ rowKey: row.key, day, tableKey })}
          />
        ) : blocked ? (
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

            <Card
              title={strings.entries.title}
              action={
                filters !== null && firstPage !== null && firstPage.items.length > 0 ? (
                  <HoursExport
                    filters={filters}
                    resetKey={filterKey}
                    onDealFilterUnavailable={() => setExportRefusedFor(firstPage)}
                  />
                ) : undefined
              }
              data-testid="hours-entries"
            >
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
      </div>

      {recording && (
        <EntryDialog
          lists={listsView}
          onReloadLists={lists.reload}
          onSubmit={record}
          onCancel={() => setRecording(false)}
        />
      )}

      {tableShown && openCell !== null && cellInGrid !== null && (
        <TableCellDialog
          row={cellInGrid.row}
          cell={cellInGrid.cell}
          day={openCell.day}
          onEdit={setEditing}
          onDelete={setDeleting}
          onAdd={
            cellInGrid.row.preset !== null && openCell.day <= today
              ? () => setRecordingCell({ row: cellInGrid.row, day: openCell.day })
              : undefined
          }
          onClose={closeCell}
        />
      )}

      {tableShown && recordingCell !== null && recordingCell.row.preset !== null && (
        <EntryDialog
          lists={listsView}
          onReloadLists={lists.reload}
          preset={{ day: recordingCell.day, on: recordingCell.row.preset }}
          focus="duration"
          onSubmit={recordInCell}
          onCancel={() => setRecordingCell(null)}
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
