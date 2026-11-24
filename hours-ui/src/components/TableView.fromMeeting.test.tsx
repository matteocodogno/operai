/**
 * @vitest-environment jsdom
 *
 * An automatic entry in My hours (specs/20261112-meeting-hours T10; AC-2.1, AC-2.3, AC-2.2 on screen; design F1, S1 "The table grid is
 * not marked"): the entry Operai recorded from a meeting is an ordinary entry of the table view and the List. In the table view
 * its minutes are in the cell, the row, the day and the period like any other, and the grid draws no mark: a cell is a sum, and
 * one cell can hold an automatic entry and a hand-made one on the same meeting and day. The mark is one click in, on the entries
 * of the cell's dialog, and on the rows of the List. Nothing here sums: the figures are the grid's, and the grid is the pure fold.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { tableGrid } from '../lib/tableGrid'
import type { TableGrid, TableGridRow } from '../lib/tableGrid'
import { daysOf, holding } from '../lib/tablePeriod'
import { meetingOn, projectOn, timeEntryView } from '../test-support/fakeApi'
import EntryDayList from './EntryDayList'
import TableCellDialog from './TableCellDialog'
import TableView from './TableView'

afterEach(() => cleanup())

const MARK = 'From meeting'
const MONDAY = '2026-11-16'
const TUESDAY = '2026-11-17'
const TODAY = '2026-11-19'
const DAYS = daysOf(holding('week', MONDAY))

const SYNC = meetingOn('m1', 'Weekly sync')

/** What Operai recorded for the person: an hour on the meeting, on Monday. */
const AUTOMATIC = timeEntryView({ id: 'auto', day: MONDAY, minutes: 60, origin: 'meeting', on: SYNC })
/** What the person typed on the same meeting and day: half an hour more, the cell holds both. */
const HAND_MADE = timeEntryView({ id: 'hand', day: MONDAY, minutes: 30, on: SYNC })
const PROJECT = timeEntryView({ id: 'proj', day: TUESDAY, minutes: 120, on: projectOn('p1', 'Alpenstrom') })

/** The same entries with no `origin` at all: what the screen drew before the field existed. */
const withoutOrigin = (entries: readonly TimeEntryView[]) =>
  entries.map((entry) => {
    const plain = { ...entry }
    delete plain.origin
    return plain
  })

const ENTRIES = [AUTOMATIC, HAND_MADE, PROJECT]

/** React's `useId` ids (`_r_f_`) differ from one render to the next: two draws of the same screen are compared without them. */
const withoutGeneratedIds = (html: string) => html.replace(/_r_[0-9a-z]+_/g, '_id_')

const renderTable = (grid: TableGrid, onOpenCell = vi.fn()) =>
  render(
    <TableView
      period={{ kind: 'week', monday: MONDAY }}
      today={TODAY}
      filtered={false}
      state={{ status: 'loaded', grid }}
      onPeriodChange={vi.fn()}
      onKindChange={vi.fn()}
      onRetry={vi.fn()}
      onClearFilters={vi.fn()}
      onOpenCell={onOpenCell}
    />,
  )

const meetingRow = (grid: TableGrid): TableGridRow => grid.rows.find((row) => row.key === 'meeting:m1')!

describe('the table view counts an automatic entry and marks nothing (AC-2.1, AC-2.2, design S1)', () => {
  const grid = tableGrid(ENTRIES, DAYS)

  it('has the entry in the cell of its meeting and day: the cell, the row, the day and the period all include its hour', () => {
    renderTable(grid)
    const row = screen.getByTestId('hours-table-row-meeting:m1')
    const cells = within(row).getAllByRole('cell')
    // Monday's cell: the automatic hour and the hand-made half hour
    expect(cells[DAYS.indexOf(MONDAY)]!.textContent).toBe('1 h 30')
    // the row's total
    expect(cells[DAYS.length]!.textContent).toBe('1 h 30')
    // the day's and the period's totals, in the totals row
    const totals = within(screen.getByTestId('hours-table-row-total')).getAllByRole('cell')
    expect(totals[DAYS.indexOf(MONDAY)]!.textContent).toBe('1 h 30')
    expect(totals[DAYS.length]!.textContent).toBe('3 h 30')
  })

  it('offers the cell as a button that opens it, with the name it has for any entry (the mark is not in it)', () => {
    const onOpenCell = vi.fn()
    renderTable(grid, onOpenCell)
    const row = screen.getByTestId('hours-table-row-meeting:m1')
    const button = within(row).getByRole('button')
    expect(button.getAttribute('data-cell')).toBe(`meeting:m1:${MONDAY}`)
    expect(button.getAttribute('aria-label')).not.toContain(MARK)
    expect(button.getAttribute('aria-label')).toContain('2 entries')
  })

  it('draws no mark anywhere on the grid: not on a cell, a row, a day or a total', () => {
    const { container } = renderTable(grid)
    expect(container.textContent).not.toContain(MARK)
    expect(screen.queryByTestId('hours-entry-auto-from-meeting')).toBeNull()
  })

  it('draws the very same grid as for entries with no origin: the field changes nothing the table view shows', () => {
    const marked = renderTable(grid)
    const html = withoutGeneratedIds(marked.container.innerHTML)
    marked.unmount()
    const plain = renderTable(tableGrid(withoutOrigin(ENTRIES), DAYS))
    expect(withoutGeneratedIds(plain.container.innerHTML)).toBe(html)
  })
})

describe('the entries of the cell show the mark, one click in (AC-2.1, AC-2.3, design F1)', () => {
  const grid = tableGrid(ENTRIES, DAYS)
  const renderCell = (target: TableGrid) => {
    const row = meetingRow(target)
    return render(
      <TableCellDialog
        row={row}
        cell={row.cells[MONDAY]!}
        day={MONDAY}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    )
  }

  it('lists the automatic entry marked "From meeting" and the hand-made one beside it unmarked', () => {
    renderCell(grid)
    const dialog = within(screen.getByRole('dialog'))
    expect(within(dialog.getByTestId('hours-entry-auto')).getByText(MARK)).not.toBeNull()
    expect(within(dialog.getByTestId('hours-entry-hand')).queryByText(MARK)).toBeNull()
    expect(dialog.getAllByText(MARK)).toHaveLength(1)
  })

  it('titles and describes the dialog as it does for any cell: the mark is not in them', () => {
    renderCell(grid)
    const open = screen.getByRole('dialog')
    expect(open.getAttribute('aria-label') ?? '').not.toContain(MARK)
    expect(document.getElementById(open.getAttribute('aria-labelledby')!)!.textContent).toBe('Meeting: Weekly sync')
    expect(document.getElementById(open.getAttribute('aria-describedby')!)!.textContent).not.toContain(MARK)
  })
})

describe('the List shows the automatic entry as a row of its own (AC-2.1, AC-2.3)', () => {
  it('has a row for it, on its day, marked "From meeting", and a row for the hand-made one with no mark', () => {
    render(<EntryDayList entries={[AUTOMATIC, HAND_MADE, PROJECT]} dayTotals={new Map([[MONDAY, 90]])} />)

    const day = within(screen.getByTestId(`hours-day-${MONDAY}`))
    expect(day.getAllByRole('listitem')).toHaveLength(2)
    expect(within(day.getByTestId('hours-entry-auto')).getByText(MARK)).not.toBeNull()
    expect(within(day.getByTestId('hours-entry-hand')).queryByText(MARK)).toBeNull()
    // the project entry of another day is not marked
    expect(within(screen.getByTestId('hours-entry-proj')).queryByText(MARK)).toBeNull()
  })

  it('shows the day total the server stated, which includes the automatic entry, and sums nothing itself', () => {
    render(<EntryDayList entries={[AUTOMATIC, HAND_MADE]} dayTotals={new Map([[MONDAY, 90]])} />)
    expect(within(screen.getByTestId(`hours-day-total-${MONDAY}`)).getByText('1 h 30')).not.toBeNull()
  })
})
