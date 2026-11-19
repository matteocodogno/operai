import { useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { ReactNode, Ref } from 'react'
import {
  Badge,
  Button,
  Card,
  DataTable,
  SkeletonRows,
  StatePanel,
  VisuallyHidden,
  formatDate,
  formatDuration,
} from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import type { TableGrid, TableGridRow } from '../lib/tableGrid'
import { periodKey } from '../lib/tablePeriod'
import type { TablePeriod, TablePeriodKind } from '../lib/tablePeriod'
import { strings } from '../strings'
import type { PeriodWords } from '../strings/table'
import ErrorBanner from './ErrorBanner'
import PeriodDateField from './PeriodDateField'
import PeriodNavigator from './PeriodNavigator'
import PeriodSwitch from './PeriodSwitch'
import { dayHeaderName, dayNumber, longDay, periodLabel, rowLabel, rowPhrase, shortDay } from './TableViewModel'

export type TableViewState =
  /** The period is being read (or read again after a write): nothing of any other period is shown. */
  | { status: 'loading' }
  /** The grid of the period the page asked for (`tableGrid(entries, daysOf(period))`); no rows is an empty period. */
  | { status: 'loaded'; grid: TableGrid }
  /** The read failed, in whole or in part; `message` is the sentence in the person's language. No partial grid. */
  | { status: 'error'; message: string }
  /** The page's own state in place of the grid (the deal filter that cannot be answered, time-tracking AC-4.11). */
  | { status: 'replaced'; content: ReactNode }

/** What the page can ask of the card (design S7 "Focus after a write"): where keyboard focus goes once the week is read again. */
export type TableViewHandle = {
  /**
   * Moves focus to the card's heading, which is focusable but never a tab stop: the landing place when the cell that was
   * acted on is gone or is no longer a control (the grid is replaced while it is read again, so the control that had
   * focus before the write no longer exists).
   */
  focusHeading: () => void
  /** Moves focus to the button of the cell `<row key>:<day>`; `false`, and focus stays where it is, when the grid has none. */
  focusCell: (cell: string) => boolean
  /**
   * Moves focus to the Retry button of the failed read; `false`, and focus stays where it is, when the card shows none.
   * The button that was pressed is replaced by a new one while the week is read again, so a Retry that fails again
   * would otherwise leave the keyboard on <body>.
   */
  focusRetry: () => boolean
}

export type TableViewProps = {
  /** The period asked for: the heading, the Period switch and the navigator. A loaded `grid` is the grid of this period. */
  period: TablePeriod
  /** Today as hours-api counts it (`todayZurich()`): marks its column and decides which way the navigator can move (AC-5.28). */
  today: string
  /** A filter the table applies is set: an empty period then says no entry matches, and offers Clear filters. */
  filtered: boolean
  state: TableViewState
  /** The period the navigator or the date field asks for: the one before, the one after, the one holding today, or the one holding a day picked. */
  onPeriodChange: (period: TablePeriod) => void
  /** The kind the Period switch asks for (never the one shown); the page decides which period that is (`switchTo`, AC-5.26, AC-5.27). */
  onKindChange: (kind: TablePeriodKind) => void
  /** Retry after a failed read. */
  onRetry: () => void
  /** Clear filters, from the empty-and-filtered state. */
  onClearFilters: () => void
  /** A cell that holds hours was chosen (AC-5.15): the page opens the cell's entries. An empty cell is not a control (AC-5.32). */
  onOpenCell?: (row: TableGridRow, day: string) => void
  ref?: Ref<TableViewHandle>
}

/** A row of the table: one of the grid's, or the last, the totals of the days. */
type TableRow = { type: 'row'; row: TableGridRow } | { type: 'total' }

const short = (minutes: number) => formatDuration(minutes * 60_000, { style: 'short' })

/** A day's column header: the weekday of its date (never of its place among the columns, R17) and the date. */
function DayHeader({ day, today }: { day: string; today: string }) {
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-1">
        {shortDay(day)}
        {day === today && <Badge tone="accent">{strings.table.today}</Badge>}
      </span>{' '}
      <span>{formatDate(day)}</span>
    </span>
  )
}

/**
 * A day's column header in a month (design S7 "Columns", decision 4): the short weekday of its date with the Today badge
 * beside it, and the day's number below, "Sun 1" — compact, because a month has 28 to 31 of them. It is `aria-hidden`, and
 * followed by the long date for a reader, "Thursday 19 November 2026, today", so a column is heard as a date and not as "Sun
 * 1". The week keeps `DayHeader`: a week can cross a month, so a bare number would be ambiguous there; a month never does.
 */
function MonthDayHeader({ day, today }: { day: string; today: string }) {
  return (
    <>
      <span className="inline-flex flex-col items-end gap-0.5" aria-hidden="true">
        <span className="inline-flex items-center gap-1">
          {shortDay(day)}
          {day === today && <Badge tone="accent">{strings.table.today}</Badge>}
        </span>
        <span>{dayNumber(day)}</span>
      </span>
      <VisuallyHidden>{dayHeaderName(day, today)}</VisuallyHidden>
    </>
  )
}

function RowLabel({ row }: { row: TableGridRow }) {
  return (
    // The floor is 7 rem: it decides whether a day figure is on a phone's first screen and whether the grid fits at 1024 px
    // (design S7 "Columns"); a wider one left a phone with a column of names only, and a laptop with 10 px of scroll.
    //
    // The name is written by whoever owns the record (a project's, a deal's or a meeting's title, up to 200 characters, a
    // pasted link with no space in it), and the pinned, opaque label column takes the width of its longest unbreakable run.
    // `max-w-64` (16 rem, about 35 characters of this text) caps that run: it clamps the label's min-content width, which
    // `break-words` alone does not lower, so a 200-character name no longer widens the column past the scroll region and
    // hides the month's days behind it (owasp-report L1, AC-5.34). Under the cap `break-words` keeps every ordinary word
    // whole and breaks only a run wider than the cap; `wrap-anywhere` would also cap the column, but at a character, so the
    // column would sit on its floor and "Internationalisation" would break mid-word. The week, which does not pin, wraps the same way.
    <span className="flex min-w-28 flex-wrap items-center gap-x-3 gap-y-1">
      <Badge>{strings.entries.type[row.kind]}</Badge> <span className="max-w-64 break-words">{rowLabel(row)}</span>
    </span>
  )
}

/**
 * One cell of a row (design S7 "Cells"). A cell that holds hours shows the total and, when the page can open it, is the
 * button that does, named for its row and its day since it can be reached out of the table. An empty cell is nothing: a
 * blank `td` with no button, no `data-cell`, no tab stop and no handler, on any day, any row and any state of the row
 * (AC-5.14, AC-5.24, AC-5.32) — hours are recorded with Record hours, or with Add hours in the list of a cell that holds
 * some, never from an empty cell.
 */
function Cell({ row, day, onOpenCell }: Pick<TableViewProps, 'onOpenCell'> & { row: TableGridRow; day: string }) {
  const cell = row.cells[day]
  if (!cell) return null
  const figure = short(cell.minutes)
  if (!onOpenCell) return figure
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-haspopup="dialog"
      aria-label={strings.table.cell.open(figure, rowPhrase(row), longDay(day), cell.entries.length)}
      onClick={() => onOpenCell(row, day)}
      data-cell={`${row.key}:${day}`}
    >
      <span className="font-mono">{figure}</span>
    </Button>
  )
}

function GridTable({
  grid,
  label,
  kind,
  today,
  onOpenCell,
}: Pick<TableViewProps, 'onOpenCell'> & { grid: TableGrid; label: string; kind: TablePeriodKind; today: string }) {
  // The month always scrolls sideways (design decision 7), so its row-label and Total columns stay in view (decision 6, D27):
  // the library's `pin`, which a shell that predates it ignores, so the month then shows unpinned. The week does not pin.
  const month = kind === 'month'
  const columns: DataTableColumn<TableRow>[] = [
    {
      id: 'on',
      header: strings.filters.recordedOn.label,
      rowHeader: true,
      ...(month ? { pin: 'start' as const } : {}),
      render: (item) =>
        item.type === 'total' ? (
          <span className="font-medium">{strings.table.grid.total}</span>
        ) : (
          <RowLabel row={item.row} />
        ),
    },
    ...grid.days.map((day, index): DataTableColumn<TableRow> => ({
      id: day,
      header: month ? <MonthDayHeader day={day} today={today} /> : <DayHeader day={day} today={today} />,
      numeric: true,
      render: (item) =>
        item.type === 'total' ? (
          grid.dayMinutes[index] === 0 ? (
            strings.common.none
          ) : (
            short(grid.dayMinutes[index]!)
          )
        ) : (
          <Cell row={item.row} day={day} onOpenCell={onOpenCell} />
        ),
    })),
    {
      id: 'total',
      header: strings.table.grid.total,
      numeric: true,
      ...(month ? { pin: 'end' as const } : {}),
      render: (item) => (
        <span className="font-medium">{short(item.type === 'total' ? grid.totalMinutes : item.row.minutes)}</span>
      ),
    },
  ]
  const rows: TableRow[] = [...grid.rows.map((row): TableRow => ({ type: 'row', row })), { type: 'total' }]
  return (
    <DataTable
      caption={strings.table.grid.caption(label)}
      columns={columns}
      rows={rows}
      getRowKey={(item) => (item.type === 'total' ? 'total' : item.row.key)}
      rowTestIdPrefix="hours-table-row"
      testId="hours-table-table"
    />
  )
}

/**
 * A period with no entries (design S7 States): the List's own sentence for "a filter is set" with Clear filters, or the
 * plain one — the page header has the Record hours action, so the panel has none. There is no "not started" state: no
 * period after today is ever shown (AC-5.28, AC-5.29).
 */
function EmptyPeriod({
  filtered,
  onClearFilters,
  words,
}: Pick<TableViewProps, 'filtered' | 'onClearFilters'> & { words: PeriodWords }) {
  if (filtered) {
    return (
      <StatePanel
        headingLevel={4}
        title={strings.entries.emptyFiltered.title}
        action={
          <Button variant="ghost" onClick={onClearFilters} data-testid="hours-table-clear">
            {strings.filters.clear}
          </Button>
        }
        testId="hours-table-empty"
      >
        {strings.entries.emptyFiltered.body}
      </StatePanel>
    )
  }
  return (
    <StatePanel headingLevel={4} title={words.empty.title} testId="hours-table-empty">
      {strings.table.empty.body}
    </StatePanel>
  )
}

/**
 * What the one polite live region says: the wait, then the period that arrived with its total (spoken, as a sentence is,
 * and as the Totals card says its figure). Nothing on an error — its banner is an alert — and nothing on a state the page
 * supplies, which words itself.
 */
const announcement = (state: TableViewState, label: string, words: PeriodWords): string => {
  if (state.status === 'loading') return words.loading
  if (state.status !== 'loaded') return ''
  return state.grid.rows.length === 0
    ? strings.table.announceEmpty(label)
    : strings.table.announce(label, formatDuration(state.grid.totalMinutes * 60_000, { style: 'spoken' }))
}

/**
 * What the hint above the grid says and shows, by period (design S7 "Scroll hint"): the week's hides from 1024 px, where a
 * week fits; the month's has no breakpoint, since a month is 2,000 to 2,800 px wide and scrolls on every ordinary window
 * (decision 7). Complete class strings, as the one styling dialect has it.
 */
const HINT_CLASS: Record<TablePeriodKind, string> = {
  week: 'mb-3 text-xs text-soft lg:hidden',
  month: 'mb-3 text-xs text-soft',
}

/**
 * TableView — the table card of My hours, drawn for a `TablePeriod`, a week or a month (specs/20261116-record-hours-in-place
 * T9, T18, T20, T22, T23; design S7; AC-5.3, AC-5.5, AC-5.9–AC-5.11, AC-5.14, AC-5.23–AC-5.28, AC-5.30–AC-5.32, AC-5.34).
 *
 * Presentational. It is handed `period` (the period asked for), `today` (`todayZurich()`), the `state` of the one read
 * of that period and, when loaded, the `TableGrid` the pure fold of T8 made of it. It sums nothing and compares nothing:
 * every figure is one the grid states, and the same markup draws a 1 h week and a 42 h week (AC-5.11). A day is named by
 * its date — the weekday in a column header and in a cell's name — never by the column's place (R17).
 *
 * The card's heading is the period's label, and under it, in every state, the toolbar: the Period switch, the navigator and
 * the date field (G17: not the card's action, where the longer buttons of the month and the two controls more would not fit
 * at 375 px), so the period can be changed out of an error or an empty one and the controls keep focus — and the date field a
 * half-typed date — across every read. The body is exactly one of: a skeleton while the period is read (so the previous period's
 * figures are never on screen under the new span), the table, the empty period, one error with Retry (the read is all or
 * nothing: never a partial grid), or whatever the page supplies in place of the grid (`replaced`: the deal filter that
 * cannot be answered).
 *
 * A cell that holds hours is a button that gives the row and the day to the page, which lists the cell's entries; a grid
 * given no handler is read-only. An empty cell is not a control (AC-5.32). Every cell button carries
 * `data-cell="<row key>:<day>"` so the page can put focus back on it once the period has been read again; an empty cell
 * has none, so a cell that has run out of entries is found by no one and focus goes to the card's heading.
 *
 * The grid is replaced by a skeleton while it is read again, which unmounts the scroll region: it would come back at the
 * left edge, and in a month that is a loss of place. So the card remembers the region's `scrollLeft` for the period shown
 * and puts it back when that period's grid returns, before anything asks for focus (design G18); a change of period starts
 * at the left.
 */
export default function TableView({
  period,
  today,
  filtered,
  state,
  onPeriodChange,
  onKindChange,
  onRetry,
  onClearFilters,
  onOpenCell,
  ref,
}: TableViewProps) {
  const root = useRef<HTMLDivElement>(null)
  const label = periodLabel(period)
  const words = strings.table[period.kind]

  // The sideways scroll position of the period shown. A scroll event does not bubble, but React's capture phase sees it.
  const scrolled = useRef<{ period: string; left: number } | null>(null)
  const shown = periodKey(period)
  const grid = state.status === 'loaded' ? state.grid : null
  useLayoutEffect(() => {
    if (scrolled.current !== null && scrolled.current.period !== shown) scrolled.current = null
    const left = scrolled.current?.left
    const region = left === undefined ? null : root.current?.querySelector<HTMLElement>('.table-region')
    if (region) region.scrollLeft = left!
  }, [shown, grid])

  // `Card` has no focusable heading yet, so the heading is found through the card's own `aria-labelledby` (the way
  // `TotalsCard` does it) and made a programmatic focus target; a cell is found by the `data-cell` it carries.
  useImperativeHandle(ref, () => ({
    focusHeading: () => {
      const labelledBy = root.current?.querySelector('section')?.getAttribute('aria-labelledby')
      const heading = labelledBy ? document.getElementById(labelledBy) : null
      if (heading === null) return
      heading.tabIndex = -1
      heading.focus()
    },
    focusCell: (cell) => {
      const button = [...(root.current?.querySelectorAll<HTMLElement>('[data-cell]') ?? [])].find(
        (candidate) => candidate.dataset['cell'] === cell,
      )
      if (button === undefined) return false
      button.focus()
      return true
    },
    focusRetry: () => {
      // The failed read's banner is the only alert of the card, and Retry its only button.
      const retry = root.current?.querySelector<HTMLElement>('[role="alert"] button')
      if (retry === null || retry === undefined) return false
      retry.focus()
      return true
    },
  }))

  return (
    <div
      ref={root}
      className="contents"
      onScrollCapture={(event) => {
        const target = event.target as HTMLElement
        if (target.classList?.contains('table-region')) scrolled.current = { period: shown, left: target.scrollLeft }
      }}
    >
      <Card title={words.title(label)} titleTestId="hours-table-heading" data-testid="hours-table">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3" data-testid="hours-table-toolbar">
          <PeriodSwitch value={period.kind} onChange={onKindChange} />
          <PeriodNavigator period={period} today={today} onPeriodChange={onPeriodChange} />
          <PeriodDateField period={period} today={today} onPeriodChange={onPeriodChange} />
        </div>

        <VisuallyHidden live data-testid="hours-table-live">
          {announcement(state, label, words)}
        </VisuallyHidden>

        {state.status === 'loading' && <SkeletonRows rows={4} actions={0} testId="hours-table-skeleton" />}

        {state.status === 'loaded' &&
          (state.grid.rows.length === 0 ? (
            <EmptyPeriod filtered={filtered} onClearFilters={onClearFilters} words={words} />
          ) : (
            <>
              {/* The grid scrolls inside the card and nothing else says so: below 1024 px for a week, at every width for a month. */}
              <p className={HINT_CLASS[period.kind]} aria-hidden="true">
                {words.scrollHint}
              </p>
              <GridTable grid={state.grid} label={label} kind={period.kind} today={today} onOpenCell={onOpenCell} />
            </>
          ))}

        {state.status === 'error' && (
          <ErrorBanner
            title={strings.entries.error.title}
            message={state.message}
            onRetry={onRetry}
            testId="hours-table-error"
          />
        )}

        {state.status === 'replaced' && state.content}
      </Card>
    </div>
  )
}
