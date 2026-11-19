/**
 * @vitest-environment jsdom
 *
 * TableView — the table card of My hours, for a week and for a month: a table of what the person worked on, row by row and
 * day by day, with its totals, its states, its toolbar (the Period switch and the navigator) and, for a month, its pinned
 * columns and compact day header (specs/20261116-record-hours-in-place T9, T22; design S7; AC-5.3, AC-5.5, AC-5.9–AC-5.11,
 * AC-5.14, AC-5.23–AC-5.28, AC-5.32, AC-5.34, AC-4.6). Presentational: it is handed a `TableGrid` (the pure fold of one
 * complete read, T8) and what the page knows, and it computes nothing — every figure is one the grid states. A cell that
 * holds hours is a button that calls back; an empty cell is not a control.
 *
 * The suites that are the same for both periods run twice (`describe.each` over `CASES`, plan Test strategy 2026-11-19):
 * the fixture's entries are on the same seven dates (Monday 16 – Sunday 22 November 2026) whichever period holds them, so
 * the month's grid is the week's with 23 more days, and only the words, the header and the width differ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDate } from '@operai/ui'
import { strings } from '../strings'
import type { PeriodWords } from '../strings/table'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { rowName } from '../lib/names'
import { tableGrid } from '../lib/tableGrid'
import type { TableGrid } from '../lib/tableGrid'
import { daysOf, holding } from '../lib/tablePeriod'
import type { TablePeriod } from '../lib/tablePeriod'
import { dealOn, meetingOn, otherWorkOn, projectOn, timeEntryView } from '../test-support/fakeApi'
import TableView from './TableView'
import type { TableViewProps } from './TableView'

afterEach(() => cleanup())

const w = strings.table

const week = (monday: string): TablePeriod => ({ kind: 'week', monday })
const month = (key: string): TablePeriod => ({ kind: 'month', month: key })

// The week of Monday 16 to Sunday 22 November 2026, and today is its Thursday: Monday to Thursday are today or
// earlier, Friday to Sunday have not come. The month is November 2026, which begins on a Sunday and has 30 days.
const MONDAY = '2026-11-16'
const TODAY = '2026-11-19'
const SEVEN = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']
const [MON, TUE, WED, THU, FRI, , SUN] = SEVEN as [string, string, string, string, string, string, string]

type Case = {
  kind: 'week' | 'month'
  words: PeriodWords
  period: TablePeriod
  /** The period's days: what the grid is folded over. */
  days: string[]
  /** What `periodLabel` says of it. */
  label: string
  /** The period before it, with its label, and the one before that: what the navigator is asked from. */
  before: { period: TablePeriod; label: string }
  older: TablePeriod
  /** How many entries a cell of the AC-5.11 grids holds, how long each is, and the total each makes. */
  eleven: { perCell: number; big: number; small: number; bigTotal: string; smallTotal: string }
}

const CASES: Case[] = [
  {
    kind: 'week',
    words: w.week,
    period: week(MONDAY),
    days: SEVEN,
    label: '16.11.2026 – 22.11.2026',
    before: { period: week('2026-11-09'), label: '09.11.2026 – 15.11.2026' },
    older: week('2026-11-02'),
    eleven: { perCell: 1, big: 630, small: 15, bigTotal: '42 h', smallTotal: '1 h' },
  },
  {
    kind: 'month',
    words: w.month,
    period: month('2026-11'),
    days: daysOf(month('2026-11')),
    label: 'November 2026',
    before: { period: month('2026-10'), label: 'October 2026' },
    older: month('2026-08'),
    eleven: { perCell: 4, big: 600, small: 15, bigTotal: '160 h', smallTotal: '4 h' },
  },
]

let sequence = 0
const entry = (day: string, minutes: number, on: TimeEntryView['on']): TimeEntryView =>
  timeEntryView({ id: `e${++sequence}`, day, minutes, on })

/** What the design draws: two projects, a deal, a meeting, other work and a project the person may not read. */
const ENTRIES = [
  entry(MON, 240, projectOn('p1', 'Alpenstrom')),
  entry(TUE, 300, projectOn('p1', 'Alpenstrom')),
  entry(TUE, 60, projectOn('p2', 'Operai')),
  entry(WED, 150, projectOn('p2', 'Operai')),
  entry(WED, 60, dealOn('d1', 'Brera')),
  entry(MON, 60, meetingOn('m1', 'Retrospective')),
  entry(THU, 120, otherWorkOn('Training', 'c-training')),
  entry(TUE, 120, projectOn('p3', 'Secret', 'hidden')),
]

const table = () => screen.getByRole('table')
const row = (key: string) => screen.getByTestId(`hours-table-row-${key}`)

describe.each(CASES)('the $kind: the grid, its figures, its cells and its rows', (c) => {
  const { days: DAYS } = c
  const GRID: TableGrid = tableGrid(ENTRIES, DAYS)

  const renderTable = (props: Partial<TableViewProps> = {}) =>
    render(
      <TableView
        period={c.period}
        today={TODAY}
        filtered={false}
        state={{ status: 'loaded', grid: GRID }}
        onPeriodChange={vi.fn()}
        onKindChange={vi.fn()}
        onRetry={vi.fn()}
        onClearFilters={vi.fn()}
        {...props}
      />,
    )

  /** The `td` of a row on a day: the period's day cells come first, the row total last. */
  const dayCell = (key: string, day: string) => within(row(key)).getAllByRole('cell')[DAYS.indexOf(day)]!

  describe('the grid is a table with every day of the period (AC-5.3, AC-5.25)', () => {
    it('is a table with table semantics, named for the period, and not an ARIA grid', () => {
      renderTable()
      expect(screen.getByRole('table', { name: w.grid.caption(c.label) })).not.toBeNull()
      expect(screen.queryByRole('grid')).toBeNull()
    })

    it('has "Recorded on", one column for each day of the period, first to last, and "Total", as column headers, in that order', () => {
      renderTable()
      const headers = within(table()).getAllByRole('columnheader')
      expect(headers).toHaveLength(DAYS.length + 2)
      expect(headers[0]?.textContent).toBe(strings.filters.recordedOn.label)
      expect(headers.at(-1)?.textContent).toBe(w.grid.total)
      expect(headers.slice(1, -1).map((header) => header.getAttribute('scope'))).toEqual(Array(DAYS.length).fill('col'))
    })

    it('marks today, and only today, in the header of its column, with a word and not only a colour', () => {
      renderTable()
      const headers = within(table()).getAllByRole('columnheader').slice(1, -1)
      const marked = headers.filter((header) => header.textContent?.includes(w.today))
      expect(marked).toHaveLength(1)
      expect(marked[0]).toBe(headers[DAYS.indexOf(THU)])
    })

    it('marks no day in a period that does not hold today', () => {
      renderTable({ today: '2026-12-25' })
      expect(within(table()).queryByText(w.today)).toBeNull()
    })

    it('draws a row header for each row, scoped to the row, and no row the grid does not have', () => {
      renderTable()
      const headers = within(table()).getAllByRole('rowheader')
      // six rows and the totals row
      expect(headers).toHaveLength(GRID.rows.length + 1)
      expect(headers.map((header) => header.getAttribute('scope'))).toEqual(Array(headers.length).fill('row'))
    })
  })

  describe('the figures: a cell, a row, a day and the period, each as the grid states it (AC-5.9, AC-5.10)', () => {
    it('shows in a cell the total of its row and day as hours and minutes, and nothing where the grid has no cell', () => {
      renderTable()
      expect(dayCell('project:p1', MON).textContent).toBe('4 h')
      expect(dayCell('project:p1', TUE).textContent).toBe('5 h')
      expect(dayCell('project:p2', WED).textContent).toBe('2 h 30')
      expect(dayCell('deal:d1', WED).textContent).toBe('1 h')
      expect(dayCell('meeting:m1', MON).textContent).toBe('1 h')
      expect(dayCell('category:c-training', THU).textContent).toBe('2 h')
      // no cell in the grid, so nothing is drawn, never a "0 min"
      expect(dayCell('project:p1', WED).textContent).toBe('')
      expect(dayCell('project:p1', FRI).textContent).toBe('')
    })

    it('writes a duration as the suite does: 30 min, 2 h 30, and hours that are never capped', () => {
      const grid = tableGrid(
        [
          entry(MON, 30, projectOn('p1', 'A')),
          entry(TUE, 150, projectOn('p1', 'A')),
          entry(WED, 1440, projectOn('p1', 'A')),
        ],
        DAYS,
      )
      renderTable({ state: { status: 'loaded', grid } })
      expect(dayCell('project:p1', MON).textContent).toBe('30 min')
      expect(dayCell('project:p1', TUE).textContent).toBe('2 h 30')
      expect(dayCell('project:p1', WED).textContent).toBe('24 h')
    })

    it('gives each row its total in the last column', () => {
      renderTable()
      const total = (key: string) => within(row(key)).getAllByRole('cell')[DAYS.length]?.textContent
      expect(total('project:p1')).toBe('9 h')
      expect(total('project:p2')).toBe('3 h 30')
      expect(total('deal:d1')).toBe('1 h')
      expect(total('meeting:m1')).toBe('1 h')
      expect(total('category:c-training')).toBe('2 h')
      expect(total('project:p3')).toBe('2 h')
    })

    it('ends with a row of day totals, "Total" as its header, and the period total in its last cell', () => {
      renderTable()
      const totals = row('total')
      expect(within(totals).getByRole('rowheader').textContent).toBe(w.grid.total)
      const none = strings.common.none
      const byDay: Record<string, string> = { [MON]: '5 h', [TUE]: '8 h', [WED]: '3 h 30', [THU]: '2 h' }
      expect(
        within(totals)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ).toEqual([...DAYS.map((day) => byDay[day] ?? none), '18 h 30'])
      expect(within(table()).getAllByRole('row').at(-1)).toBe(totals)
    })

    it('says a day with nothing with the catalog dash, never "0" and never a blank cell that could read as missing', () => {
      renderTable()
      for (const day of [FRI, SUN]) {
        const text = within(row('total')).getAllByRole('cell')[DAYS.indexOf(day)]?.textContent
        expect(text).toBe(strings.common.none)
        expect(text).not.toMatch(/\d/)
      }
    })

    it('shows the grid figures and sums nothing itself: a total the rows do not add up to is shown as given', () => {
      // A grid no fold would make: every total differs from the sum of what it covers.
      const grid: TableGrid = {
        ...GRID,
        dayMinutes: DAYS.map((_, index) => (index === 0 ? 600 : 0)),
        totalMinutes: 1200,
        rows: GRID.rows.map((gridRow) => ({ ...gridRow, minutes: 30 })),
      }
      renderTable({ state: { status: 'loaded', grid } })
      const cells = within(row('total'))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
      expect(cells[0]).toBe('10 h')
      expect(cells[1]).toBe(strings.common.none)
      expect(cells[DAYS.length]).toBe('20 h')
      expect(within(row('project:p1')).getAllByRole('cell')[DAYS.length]?.textContent).toBe('30 min')
    })
  })

  describe('a cell that holds hours is the only control: an empty cell is a blank td (AC-5.14, AC-5.15, AC-5.24, AC-5.32)', () => {
    const rowOfKey = (key: string) => GRID.rows.find((gridRow) => gridRow.key === key)!
    const handlers = () => ({ onOpenCell: vi.fn() })
    const buttonIn = (key: string, day: string) => within(dayCell(key, day)).queryByRole('button')
    const recordButtons = () => screen.queryAllByRole('button', { name: /^Record hours on / })
    /** Every cell of the grid that holds no hours, with the row and the day it is on. */
    const emptyCells = (grid: TableGrid) =>
      grid.rows.flatMap((gridRow) => grid.days.filter((day) => !gridRow.cells[day]).map((day) => ({ gridRow, day })))
    /** What Tab reaches inside the table: a control, a link, a field, or anything with a tabindex that is not -1 (a row header's is, for focus by script). */
    const tabStopsIn = (container: HTMLElement) => [
      ...container.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
      ),
    ]

    it('draws an empty cell as nothing: no text, no element in it, no name, on every row and every day', () => {
      renderTable(handlers())
      const empties = emptyCells(GRID)
      // Six rows of every day, less the cells that hold hours: the test has a body to look at.
      expect(empties.length).toBeGreaterThan(20)
      for (const { gridRow, day } of empties) {
        const cell = dayCell(gridRow.key, day)
        expect(cell.tagName, `${gridRow.key} ${day}`).toBe('TD')
        expect(cell.textContent, `${gridRow.key} ${day}`).toBe('')
        expect(cell.children, `${gridRow.key} ${day}`).toHaveLength(0)
        expect(cell.hasAttribute('data-cell'), `${gridRow.key} ${day}`).toBe(false)
        expect(cell.hasAttribute('tabindex'), `${gridRow.key} ${day}`).toBe(false)
        expect(cell.hasAttribute('aria-label'), `${gridRow.key} ${day}`).toBe(false)
      }
    })

    it('is blank on a day after today, on today and on an earlier day, on a row with a name (AC-5.14, AC-5.32)', () => {
      renderTable(handlers())
      // Alpenstrom holds hours on Monday and Tuesday only: Wednesday (earlier), Thursday (today) and Friday (after) are empty.
      for (const day of [WED, THU, FRI, SEVEN[5]!, SUN]) {
        expect(dayCell('project:p1', day).textContent).toBe('')
        expect(buttonIn('project:p1', day)).toBeNull()
      }
      expect(buttonIn('project:p1', MON)).not.toBeNull()
    })

    it('is blank on every day of the period after today, the last one included: a future cell is never a control', () => {
      renderTable(handlers())
      const future = DAYS.filter((day) => day > TODAY)
      expect(future.length).toBeGreaterThan(0)
      for (const day of future) {
        for (const gridRow of GRID.rows) {
          expect(dayCell(gridRow.key, day).querySelector('button'), `${gridRow.key} ${day}`).toBeNull()
        }
      }
    })

    it('is blank on a row whose name the person cannot read and on a retired category: the same cell as any other (AC-5.24)', () => {
      const grid = tableGrid(
        [
          entry(TUE, 60, otherWorkOn('Old training', 'c-old', true)),
          entry(MON, 60, projectOn('p3', 'Secret', 'hidden')),
        ],
        DAYS,
      )
      renderTable({ ...handlers(), state: { status: 'loaded', grid }, today: '2026-11-30' })
      for (const key of ['category:c-old', 'project:p3']) {
        const blank = DAYS.filter((day) => dayCell(key, day).querySelector('[data-cell]') === null)
        expect(blank, key).toHaveLength(DAYS.length - 1)
        for (const day of blank) {
          expect(dayCell(key, day).children, `${key} ${day}`).toHaveLength(0)
          expect(dayCell(key, day).textContent, `${key} ${day}`).toBe('')
        }
      }
      expect(recordButtons()).toHaveLength(0)
    })

    it('offers no "Record hours on" button anywhere, in a period long past, in the current one or in one that has not come', () => {
      for (const today of ['2026-11-30', TODAY, '2026-11-09']) {
        renderTable({ ...handlers(), today })
        expect(recordButtons(), today).toHaveLength(0)
        cleanup()
      }
    })

    it('has no tab stop but the cells that hold hours: a keyboard reaches only the figures', () => {
      renderTable(handlers())
      const withHours = GRID.rows.flatMap((gridRow) => Object.keys(gridRow.cells).map((day) => `${gridRow.key}:${day}`))
      const stops = tabStopsIn(table())
      expect(stops).toHaveLength(withHours.length)
      expect(stops.map((stop) => stop.getAttribute('data-cell')).sort()).toEqual([...withHours].sort())
    })

    it('does nothing when an empty cell is pressed: no callback, and no cell button takes the focus', async () => {
      const { onOpenCell } = handlers()
      renderTable({ onOpenCell })
      for (const [key, day] of [
        ['project:p1', WED],
        ['project:p2', MON],
        ['deal:d1', THU],
        ['project:p3', FRI],
      ] as const) {
        await userEvent.click(dayCell(key, day))
        // The click may land in the table's scroll region, which is focusable as a whole; it never lands on a cell.
        expect(document.activeElement?.hasAttribute('data-cell'), `${key} ${day}`).toBe(false)
      }
      expect(onOpenCell).not.toHaveBeenCalled()
    })

    it('makes a cell that holds hours a button with the figure and a name with the figure, the row, the day and the entries (AC-5.15)', () => {
      const grid = tableGrid(
        [
          entry(WED, 60, projectOn('p1', 'Alpenstrom')),
          entry(WED, 90, projectOn('p1', 'Alpenstrom')),
          entry(MON, 240, projectOn('p1', 'Alpenstrom')),
        ],
        DAYS,
      )
      renderTable({ ...handlers(), state: { status: 'loaded', grid } })
      const two = within(dayCell('project:p1', WED)).getByRole('button', {
        name: '2 h 30 on Alpenstrom, Wednesday 18 November 2026, 2 entries',
      })
      expect(two.textContent).toBe('2 h 30')
      expect(two.getAttribute('aria-haspopup')).toBe('dialog')
      expect(buttonIn('project:p1', MON)?.getAttribute('aria-label')).toBe(
        '4 h on Alpenstrom, Monday 16 November 2026, 1 entry',
      )
    })

    it('calls back with the row and the day when a cell with hours is pressed (AC-5.15)', async () => {
      const { onOpenCell } = handlers()
      renderTable({ onOpenCell })
      await userEvent.click(buttonIn('project:p1', TUE)!)
      expect(onOpenCell).toHaveBeenCalledExactlyOnceWith(rowOfKey('project:p1'), TUE)
    })

    it('opens a cell from the keyboard too, with Enter on the focused figure', async () => {
      const { onOpenCell } = handlers()
      renderTable({ onOpenCell })
      buttonIn('deal:d1', WED)!.focus()
      await userEvent.keyboard('{Enter}')
      expect(onOpenCell).toHaveBeenCalledExactlyOnceWith(rowOfKey('deal:d1'), WED)
    })

    it('still opens the hours of a row with no name, named as the List names it, so they can be changed and deleted (AC-5.24)', () => {
      renderTable(handlers())
      expect(buttonIn('project:p3', TUE)?.getAttribute('aria-label')).toBe(
        '2 h on a project not visible to you, Tuesday 17 November 2026, 1 entry',
      )
      expect(JSON.stringify(document.body.innerHTML)).not.toContain('Secret')
    })

    it('still opens the hours of a retired category (AC-5.24)', () => {
      const grid = tableGrid([entry(TUE, 60, otherWorkOn('Old training', 'c-old', true))], DAYS)
      renderTable({ ...handlers(), state: { status: 'loaded', grid } })
      expect(buttonIn('category:c-old', TUE)?.getAttribute('aria-label')).toBe(
        '1 h on other work (Old training), Tuesday 17 November 2026, 1 entry',
      )
    })

    it('gives every cell button its row and day for the page to find it again after the period is read anew', () => {
      renderTable(handlers())
      expect(buttonIn('project:p1', TUE)?.getAttribute('data-cell')).toBe(`project:p1:${TUE}`)
      expect(buttonIn('project:p2', WED)?.getAttribute('data-cell')).toBe(`project:p2:${WED}`)
    })

    it('offers no button where the page gave no handler: the grid is read-only and still shows every figure', () => {
      renderTable()
      expect(within(table()).queryAllByRole('button')).toHaveLength(0)
      expect(dayCell('project:p1', MON).textContent).toBe('4 h')
    })
  })

  describe('a row is named as the List names an entry (AC-5.8, AC-5.23)', () => {
    const header = (key: string) => within(row(key)).getByRole('rowheader')

    it('has the kind badge the List has, then the name, with no link and no id', () => {
      renderTable()
      expect(within(header('project:p1')).getByText(strings.entries.type.project)).not.toBeNull()
      expect(within(header('project:p1')).getByText('Alpenstrom')).not.toBeNull()
      expect(within(header('deal:d1')).getByText(strings.entries.type.deal)).not.toBeNull()
      expect(within(header('meeting:m1')).getByText(strings.entries.type.meeting)).not.toBeNull()
      expect(within(header('category:c-training')).getByText(strings.entries.type.none)).not.toBeNull()
      expect(within(header('category:c-training')).getByText('Training')).not.toBeNull()
      expect(within(table()).queryAllByRole('link')).toHaveLength(0)
      // no id is shown, in the text or in a name (the row keys are attributes, never read out)
      const labels = [...table().querySelectorAll('[aria-label]')].map((element) => element.getAttribute('aria-label'))
      expect(`${table().textContent} ${labels.join(' ')}`).not.toMatch(/\bp[1-4]\b|\bd1\b|\bm1\b|c-training/)
    })

    it('says of a project the person may not read what the List says of its entry, and never its name', () => {
      const hidden = ENTRIES.find(
        (candidate) => candidate.on.type === 'project' && candidate.on.visibility === 'hidden',
      )!
      renderTable()
      expect(within(header('project:p3')).getByText(rowName(hidden.on)!.text)).not.toBeNull()
      expect(within(header('project:p3')).getByText(strings.names.hidden)).not.toBeNull()
      // the kind stays, so the row still says what sort of work it was
      expect(within(header('project:p3')).getByText(strings.entries.type.project)).not.toBeNull()
      expect(document.body.textContent).not.toContain('Secret')
    })

    it('says "Name unavailable" for a deal whose owner did not answer, and for a visible one that arrived without a label', () => {
      const grid = tableGrid(
        [entry(MON, 60, dealOn('d2', 'Unseen', 'unavailable')), entry(TUE, 60, projectOn('p4', null))],
        DAYS,
      )
      renderTable({ state: { status: 'loaded', grid } })
      expect(within(header('deal:d2')).getByText(strings.names.unavailable)).not.toBeNull()
      expect(within(header('project:p4')).getByText(strings.names.unavailable)).not.toBeNull()
    })

    it('tells a retired category as the List does', () => {
      const grid = tableGrid([entry(TUE, 60, otherWorkOn('Old training', 'c-old', true))], DAYS)
      renderTable({ state: { status: 'loaded', grid } })
      expect(within(header('category:c-old')).getByText(strings.entries.retired('Old training'))).not.toBeNull()
    })

    it('draws the rows in the order the grid gives, projects, deals, meetings, other work, and the totals last', () => {
      renderTable()
      const keys = [...table().querySelectorAll('tbody tr')].map((tr) => tr.getAttribute('data-row-key'))
      expect(keys).toEqual([...GRID.rows.map((gridRow) => gridRow.key), 'total'])
      expect(GRID.rows.map((gridRow) => gridRow.kind)).toEqual([
        'project',
        'project',
        'project',
        'deal',
        'meeting',
        'none',
      ])
    })
  })

  describe(`the same markup for a big ${c.kind} and a small one, and nothing compares a day with a target (AC-5.11)`, () => {
    // Four cells in two rows, the same in both: only the durations differ.
    const periodOf = (minutesEach: number) => {
      const { perCell } = c.eleven
      const on = (day: string, target: TimeEntryView['on']) =>
        Array.from({ length: perCell }, () => entry(day, minutesEach, target))
      return tableGrid(
        [
          ...on(MON, projectOn('p1', 'Alpenstrom')),
          ...on(TUE, projectOn('p1', 'Alpenstrom')),
          ...on(WED, dealOn('d1', 'Brera')),
          ...on(THU, dealOn('d1', 'Brera')),
        ],
        DAYS,
      )
    }
    const BIG = periodOf(c.eleven.big)
    const SMALL = periodOf(c.eleven.small)

    /** The page with every figure (a duration, short or spoken) replaced by one word: what is left is the markup. */
    const markup = (html: string) =>
      html
        .replace(/_r_[0-9a-z]+_/g, 'ID') // React's generated ids differ from one render to the next
        .replace(/\d+ hours?(, \d+ minutes?)?|\d+ minutes?/g, 'D')
        .replace(/\d+ h( \d+)?|\d+ min/g, 'D')

    const renderBigOrSmall = (grid: TableGrid) => {
      const { container, unmount } = renderTable({
        state: { status: 'loaded', grid },
        onOpenCell: vi.fn(),
      })
      const html = container.innerHTML
      const text = container.textContent ?? ''
      const roles = screen.queryAllByRole('progressbar').length + screen.queryAllByRole('meter').length
      unmount()
      return { html, text, roles }
    }

    it('states the two periods as the totals they are, so the comparison below is between two different figures', () => {
      expect(BIG.totalMinutes).toBeGreaterThan(SMALL.totalMinutes)
      renderTable({ state: { status: 'loaded', grid: BIG } })
      expect(within(row('total')).getAllByRole('cell').at(-1)?.textContent).toBe(c.eleven.bigTotal)
      cleanup()
      renderTable({ state: { status: 'loaded', grid: SMALL } })
      expect(within(row('total')).getAllByRole('cell').at(-1)?.textContent).toBe(c.eleven.smallTotal)
    })

    it('renders the two as one markup, figures aside: no class, mark or element depends on how much was worked', () => {
      const big = renderBigOrSmall(BIG)
      const small = renderBigOrSmall(SMALL)
      expect(big.html).not.toBe(small.html)
      expect(markup(big.html)).toBe(markup(small.html))
    })

    it('says nothing of a target, a completeness or a comparison, for either', () => {
      for (const grid of [BIG, SMALL]) {
        const { text, roles } = renderBigOrSmall(grid)
        expect(text).not.toMatch(
          /target|incomplete|complete|missing|remaining|overtime|contract|short of|of 42|\/ ?42|%/i,
        )
        expect(roles).toBe(0)
      }
    })
  })

  describe('the card: the period is its heading, and the heading and the toolbar are there in every state (AC-5.5, G17)', () => {
    const heading = () => screen.getByRole('heading', { level: 3 })
    const EMPTY: TableGrid = tableGrid([], DAYS)
    const navigator = () => screen.getByRole('group', { name: c.words.nav.label })

    it('is headed with the period’s label', () => {
      renderTable()
      expect(heading().textContent).toBe(c.words.title(c.label))
      expect(screen.getByRole('region', { name: c.words.title(c.label) })).toBe(screen.getByTestId('hours-table'))
    })

    it('names the period it is told, not the one the figures belong to, so a period that is still loading has its own heading', () => {
      renderTable({ period: c.before.period, state: { status: 'loading' } })
      expect(heading().textContent).toBe(c.words.title(c.before.label))
    })

    it('has the navigator, which asks for the period before the one shown, the one after it and this one', async () => {
      const onPeriodChange = vi.fn()
      renderTable({ period: c.before.period, onPeriodChange })
      await userEvent.click(within(navigator()).getByRole('button', { name: c.words.nav.next }))
      expect(onPeriodChange).toHaveBeenLastCalledWith(c.period)
      await userEvent.click(within(navigator()).getByRole('button', { name: c.words.nav.previous }))
      expect(onPeriodChange).toHaveBeenLastCalledWith(c.kind === 'week' ? week('2026-11-02') : month('2026-09'))
      expect(
        within(navigator()).getByRole('button', { name: c.words.nav.current }).getAttribute('aria-disabled'),
      ).toBeNull()
    })

    it('has Next and the return unavailable on the current period, and a press of Next asks for nothing (AC-5.28)', async () => {
      const onPeriodChange = vi.fn()
      renderTable({ onPeriodChange })
      const next = within(navigator()).getByRole('button', { name: c.words.nav.next })
      expect(next.getAttribute('aria-disabled')).toBe('true')
      expect(within(navigator()).getByRole('button', { name: c.words.nav.current }).getAttribute('aria-disabled')).toBe(
        'true',
      )
      await userEvent.click(next)
      expect(onPeriodChange).not.toHaveBeenCalled()
    })

    it('asks for the current period from another one: the one that holds today', async () => {
      const onPeriodChange = vi.fn()
      renderTable({ period: c.older, onPeriodChange })
      await userEvent.click(screen.getByRole('button', { name: c.words.nav.current }))
      expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(c.period)
    })

    it('keeps the navigator in the toolbar under the heading and not in the card’s header, where it left the heading three lines tall at 375 px (G17)', () => {
      renderTable()
      const toolbar = screen.getByTestId('hours-table-toolbar')
      expect(toolbar.contains(navigator())).toBe(true)
      expect(heading().parentElement?.contains(navigator())).toBe(false)
      expect(heading().compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it.each<[string, Partial<TableViewProps>]>([
      ['loading', { state: { status: 'loading' } }],
      ['loaded', { state: { status: 'loaded', grid: GRID } }],
      ['an empty period', { state: { status: 'loaded', grid: EMPTY } }],
      ['an error', { state: { status: 'error', message: 'nope' } }],
      ['a state the page supplies', { state: { status: 'replaced', content: <p>the page says so</p> } }],
    ])('keeps the heading, the Period switch and the navigator in %s', (_name, props) => {
      renderTable(props)
      expect(heading().textContent).toBe(c.words.title(c.label))
      expect(navigator()).not.toBeNull()
      expect(screen.getByRole('radiogroup', { name: w.period.label })).not.toBeNull()
      expect(screen.getByLabelText(c.words.pick.label)).not.toBeNull()
    })
  })

  describe('the Period switch in the toolbar (AC-5.26, AC-5.27, design S7 "Toolbar")', () => {
    it('has Week and Month, the shown kind selected, in front of the navigator', () => {
      renderTable()
      const toolbar = screen.getByTestId('hours-table-toolbar')
      const group = within(toolbar).getByRole('radiogroup', { name: w.period.label })
      expect((within(group).getByRole('radio', { name: w.period[c.kind] }) as HTMLInputElement).checked).toBe(true)
      const navigator = within(toolbar).getByRole('group', { name: c.words.nav.label })
      expect(group.compareDocumentPosition(navigator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('reports the other kind when it is chosen, and nothing for the kind shown', async () => {
      const onKindChange = vi.fn()
      renderTable({ onKindChange })
      const other = c.kind === 'week' ? 'month' : 'week'
      await userEvent.click(screen.getByRole('radio', { name: w.period[c.kind] }))
      expect(onKindChange).not.toHaveBeenCalled()
      await userEvent.click(screen.getByRole('radio', { name: w.period[other] }))
      expect(onKindChange).toHaveBeenCalledExactlyOnceWith(other)
    })
  })

  describe('the date field in the toolbar (AC-5.30, AC-5.31, design S7 "Toolbar", F7)', () => {
    const dateField = () => screen.getByLabelText(c.words.pick.label) as HTMLInputElement
    const EMPTY: TableGrid = tableGrid([], DAYS)
    const pick = (value: string) => fireEvent.change(dateField(), { target: { value } })
    /** A day in another period, and the period that holds it. */
    const ELSEWHERE = c.kind === 'week' ? '2026-10-14' : '2026-09-03'

    it('is the last of the toolbar: after the Period switch and the navigator, which the keyboard reaches first', () => {
      renderTable()
      const toolbar = screen.getByTestId('hours-table-toolbar')
      expect(toolbar.contains(dateField())).toBe(true)
      const switchGroup = within(toolbar).getByRole('radiogroup', { name: w.period.label })
      const navigator = within(toolbar).getByRole('group', { name: c.words.nav.label })
      const field = screen.getByTestId('hours-period-pick')
      expect(switchGroup.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(navigator.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(toolbar.lastElementChild).toBe(field)
    })

    it('shows today on the current period and the period’s first day on another, offering no day after today', () => {
      const { rerender } = renderTable()
      expect(dateField().value).toBe(TODAY)
      expect(dateField().max).toBe(TODAY)
      rerender(
        <TableView
          period={c.before.period}
          today={TODAY}
          filtered={false}
          state={{ status: 'loaded', grid: GRID }}
          onPeriodChange={vi.fn()}
          onKindChange={vi.fn()}
          onRetry={vi.fn()}
          onClearFilters={vi.fn()}
        />,
      )
      expect(dateField().value).toBe(c.kind === 'week' ? '2026-11-09' : '2026-10-01')
    })

    it('asks for the period holding a day picked in another period, in the same kind, and for nothing else', () => {
      const onPeriodChange = vi.fn()
      renderTable({ onPeriodChange })
      pick(ELSEWHERE)
      expect(onPeriodChange).toHaveBeenCalledExactlyOnceWith(holding(c.kind, ELSEWHERE))
      onPeriodChange.mockClear()
      // A day of the period shown, a day after today and an emptied value ask for nothing.
      pick(c.kind === 'week' ? '2026-11-18' : '2026-11-02')
      pick('2026-11-20')
      pick('')
      expect(onPeriodChange).not.toHaveBeenCalled()
    })

    it.each<[string, () => Partial<TableViewProps>]>([
      ['loading', () => ({ state: { status: 'loading' } })],
      ['loaded', () => ({ state: { status: 'loaded', grid: GRID } })],
      ['an empty period', () => ({ state: { status: 'loaded', grid: EMPTY } })],
      ['an error', () => ({ state: { status: 'error', message: 'nope' } })],
      ['a state the page supplies', () => ({ state: { status: 'replaced', content: <p>the page says so</p> } })],
    ])('is the same input, with the same text, through a read that ends in %s', (_name, next) => {
      const { rerender } = renderTable({ state: { status: 'loading' } })
      const before = dateField()
      act(() => before.focus())
      pick('')
      const props: TableViewProps = {
        period: c.period,
        today: TODAY,
        filtered: false,
        state: { status: 'loading' },
        onPeriodChange: vi.fn(),
        onKindChange: vi.fn(),
        onRetry: vi.fn(),
        onClearFilters: vi.fn(),
        ...next(),
      }
      rerender(<TableView {...props} />)
      expect(dateField()).toBe(before)
      expect(document.activeElement).toBe(before)
      // The half-typed (here: emptied) text survives the read, and is given back to the reference day on blur.
      expect(before.value).toBe('')
      act(() => before.blur())
      expect(before.value).toBe(TODAY)
    })

    it('stays the same input from one state to the next, so focus and typing are never lost to a read', () => {
      const { rerender } = renderTable({ state: { status: 'loading' } })
      const before = dateField()
      const states: TableViewProps['state'][] = [
        { status: 'loaded', grid: GRID },
        { status: 'loading' },
        { status: 'error', message: 'nope' },
        { status: 'loading' },
        { status: 'loaded', grid: EMPTY },
        { status: 'replaced', content: <p>the page says so</p> },
        { status: 'loaded', grid: GRID },
      ]
      for (const state of states) {
        rerender(
          <TableView
            period={c.period}
            today={TODAY}
            filtered={false}
            state={state}
            onPeriodChange={vi.fn()}
            onKindChange={vi.fn()}
            onRetry={vi.fn()}
            onClearFilters={vi.fn()}
          />,
        )
        expect(dateField()).toBe(before)
      }
    })
  })

  describe('the label floor and the scroll hint (design S7 "Columns", "Scroll hint"; QE observation, G10)', () => {
    const hint = () => screen.queryByText(c.words.scrollHint)

    it('floors a row label at 7 rem (min-w-28), not the 11 rem that left a phone with a column of names and a laptop 10 px of scroll', () => {
      renderTable()
      const labels = GRID.rows.map((r) => within(row(r.key)).getByRole('rowheader').firstElementChild as HTMLElement)
      expect(labels).toHaveLength(GRID.rows.length)
      for (const label of labels) {
        expect(label.classList.contains('min-w-28')).toBe(true)
        expect(label.classList.contains('min-w-44')).toBe(false)
      }
      expect(table().querySelector('.min-w-44')).toBeNull()
    })

    it('says under the heading that the grid scrolls sideways, in the period’s words, as a line for the eye', () => {
      renderTable()
      const line = hint()!
      expect(line).not.toBeNull()
      expect(line.tagName).toBe('P')
      // a cue for the eye: the region is already a labelled, focusable scroll region and a screen reader moves by cell
      expect(line.getAttribute('aria-hidden')).toBe('true')
      expect(within(line).queryByRole('button')).toBeNull()
      // between the card's heading and the grid, in that order
      const heading = screen.getByRole('heading', { level: 3 })
      expect(heading.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(line.compareDocumentPosition(table()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it(
      c.kind === 'week'
        ? 'is seen only below 1024 px, where the week stops fitting (lg:hidden)'
        : 'is seen at every width: the month scrolls on every ordinary window, so no breakpoint hides it (AC-5.34, design decision 7)',
      () => {
        renderTable()
        const classes = [...hint()!.classList]
        if (c.kind === 'week') expect(classes).toContain('lg:hidden')
        else expect(classes.filter((name) => /hidden|sr-only|\bsm:|\bmd:|\blg:|\bxl:/.test(name))).toEqual([])
      },
    )

    it('is on a grid only: not while the period loads, on an empty period, on an error nor on a state the page supplies', () => {
      const EMPTY = tableGrid([], DAYS)
      const without: [string, Partial<TableViewProps>][] = [
        ['loading', { state: { status: 'loading' } }],
        ['an empty period', { state: { status: 'loaded', grid: EMPTY } }],
        ['an empty filtered period', { filtered: true, state: { status: 'loaded', grid: EMPTY } }],
        ['an error', { state: { status: 'error', message: 'nope' } }],
        ['a state the page supplies', { state: { status: 'replaced', content: <p>the page says so</p> } }],
      ]
      for (const [name, props] of without) {
        renderTable(props)
        expect(hint(), name).toBeNull()
        cleanup()
      }
      renderTable()
      expect(hint()).not.toBeNull()
    })
  })

  describe('loading: a skeleton, one polite line, and no figure of another period (design S7 States)', () => {
    it('shows the skeleton hidden from assistive technology and says the period’s "Loading your …" once, politely', () => {
      renderTable({ state: { status: 'loading' } })
      expect(screen.getByTestId('hours-table-skeleton').getAttribute('aria-hidden')).toBe('true')
      const live = screen.getByTestId('hours-table-live')
      expect(live.textContent).toBe(c.words.loading)
      expect(live.getAttribute('aria-live')).toBe('polite')
      expect(screen.queryByRole('table')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('takes the previous figures off the screen the moment the period is asked for again', () => {
      const { rerender } = renderTable()
      expect(screen.getByRole('table')).not.toBeNull()
      rerender(
        <TableView
          period={c.before.period}
          today={TODAY}
          filtered={false}
          state={{ status: 'loading' }}
          onPeriodChange={vi.fn()}
          onKindChange={vi.fn()}
          onRetry={vi.fn()}
          onClearFilters={vi.fn()}
        />,
      )
      expect(screen.queryByRole('table')).toBeNull()
      expect(screen.queryByText('Alpenstrom')).toBeNull()
      expect(screen.getByTestId('hours-table-skeleton')).not.toBeNull()
    })
  })

  describe('a period with no entries (design S7 States; AC-5.14)', () => {
    const EMPTY = tableGrid([], DAYS)
    const empty = (props: Partial<TableViewProps> = {}) =>
      renderTable({ state: { status: 'loaded', grid: EMPTY }, ...props })

    it('says there are no hours in the period, in a state panel under the card heading, with no action and no table', () => {
      empty()
      const panel = screen.getByTestId('hours-table-empty')
      expect(within(panel).getByRole('heading', { level: 4, name: c.words.empty.title })).not.toBeNull()
      expect(panel.textContent).toContain(w.empty.body)
      expect(within(panel).queryByRole('button')).toBeNull()
      expect(screen.queryByRole('table')).toBeNull()
    })

    it('has no "not started" state: whatever day today is, an empty period says the same, and a filter offers Clear filters (AC-5.28, AC-5.29)', () => {
      // No period after today is ever shown, so one that begins after it needs no sentence of its own.
      for (const today of [MONDAY, '2026-11-09', '2026-11-30']) {
        empty({ today })
        expect(screen.getByRole('heading', { level: 4, name: c.words.empty.title }), today).not.toBeNull()
        expect(screen.getByTestId('hours-table-empty').textContent).not.toMatch(/not started|has not come/i)
        cleanup()
      }
      empty({ period: c.before.period, filtered: true })
      expect(screen.getByRole('heading', { level: 4, name: strings.entries.emptyFiltered.title })).not.toBeNull()
      expect(screen.getByRole('button', { name: strings.filters.clear })).not.toBeNull()
    })

    it('says no entry matches the filters, as the List does, and offers Clear filters, which asks the page to clear them', async () => {
      const onClearFilters = vi.fn()
      empty({ filtered: true, onClearFilters })
      const panel = screen.getByTestId('hours-table-empty')
      expect(within(panel).getByRole('heading', { level: 4, name: strings.entries.emptyFiltered.title })).not.toBeNull()
      expect(panel.textContent).toContain(strings.entries.emptyFiltered.body)
      await userEvent.click(within(panel).getByRole('button', { name: strings.filters.clear }))
      expect(onClearFilters).toHaveBeenCalledOnce()
    })

    it('offers Clear filters only when a filter is set', () => {
      empty({ filtered: false })
      expect(screen.queryByRole('button', { name: strings.filters.clear })).toBeNull()
    })
  })

  describe('a failed read: one error with Retry and no grid, never a partial one (design S7 States)', () => {
    it("shows the warning with the List's title, the message, and a Retry that asks the page to read again", async () => {
      const onRetry = vi.fn()
      renderTable({ state: { status: 'error', message: 'Try again in a moment.' }, onRetry })
      const banner = screen.getByTestId('hours-table-error')
      expect(banner.getAttribute('role')).toBe('alert')
      expect(within(banner).getByText(strings.entries.error.title)).not.toBeNull()
      expect(banner.textContent).toContain('Try again in a moment.')
      await userEvent.click(within(banner).getByRole('button', { name: strings.common.retry }))
      expect(onRetry).toHaveBeenCalledOnce()
      expect(screen.queryByRole('table')).toBeNull()
      expect(screen.queryByTestId('hours-table-empty')).toBeNull()
    })
  })

  describe('a state the page supplies in place of the grid, such as the deal filter that cannot be answered', () => {
    it('shows what the page gives, under the heading and the toolbar, and draws no grid', () => {
      renderTable({ state: { status: 'replaced', content: <p data-testid="from-the-page">Nothing is shown.</p> } })
      expect(screen.getByTestId('from-the-page')).not.toBeNull()
      expect(screen.queryByRole('table')).toBeNull()
      expect(screen.queryByTestId('hours-table-empty')).toBeNull()
    })
  })

  describe('what a screen reader is told when a period arrives (design S7 "Announcements")', () => {
    const live = () => screen.getByTestId('hours-table-live')
    const draw = (state: TableViewProps['state']) => (
      <TableView
        period={c.period}
        today={TODAY}
        filtered={false}
        state={state}
        onPeriodChange={vi.fn()}
        onKindChange={vi.fn()}
        onRetry={vi.fn()}
        onClearFilters={vi.fn()}
      />
    )

    it('hears the period and its total, spoken, once it has loaded, and the live region is polite', () => {
      renderTable()
      expect(live().textContent).toBe(w.announce(c.label, '18 hours, 30 minutes'))
      expect(live().getAttribute('aria-live')).toBe('polite')
    })

    it('hears that nothing was recorded in a period with no entries', () => {
      renderTable({ state: { status: 'loaded', grid: tableGrid([], DAYS) } })
      expect(live().textContent).toBe(w.announceEmpty(c.label))
    })

    it('hears nothing of its own on an error, which is an alert already, and keeps one region across the states', () => {
      const { rerender } = renderTable({ state: { status: 'loading' } })
      const region = live()
      rerender(draw({ status: 'loaded', grid: GRID }))
      // the same element changed its text: that is what a live region needs to be read
      expect(live()).toBe(region)
      expect(region.textContent).toContain('18 hours, 30 minutes')
      rerender(draw({ status: 'error', message: 'nope' }))
      expect(live().textContent).toBe('')
    })
  })
})

describe('the week’s column header: the weekday of its date and the date (AC-5.3; R17)', () => {
  const days = SEVEN
  const GRID = tableGrid(ENTRIES, days)
  const renderWeek = (props: Partial<TableViewProps> = {}) =>
    render(
      <TableView
        period={week(MONDAY)}
        today={TODAY}
        filtered={false}
        state={{ status: 'loaded', grid: GRID }}
        onPeriodChange={vi.fn()}
        onKindChange={vi.fn()}
        onRetry={vi.fn()}
        onClearFilters={vi.fn()}
        {...props}
      />,
    )

  it('heads the seven days Monday to Sunday, each with its weekday and its date, in that order', () => {
    renderWeek()
    const headers = within(table()).getAllByRole('columnheader')
    days.forEach((day, index) => {
      const text = headers[index + 1]?.textContent ?? ''
      expect(text).toContain(w.weekday.short[index])
      expect(text).toContain(formatDate(day))
      expect(text.indexOf(w.weekday.short[index]!)).toBeLessThan(text.indexOf(formatDate(day)))
    })
  })

  it('marks today with a badge on the line of the weekday, and the date below', () => {
    renderWeek()
    const marked = within(table())
      .getAllByRole('columnheader')
      .filter((header) => header.textContent?.includes(w.today))
    expect(marked).toHaveLength(1)
    expect(marked[0]?.textContent).toContain(formatDate(THU))
  })

  it('is not pinned: the week fits from about 980 px and keeps its phone behaviour (design S7 "Pinned columns, month only")', () => {
    renderWeek()
    expect(table().querySelector('.is-pinned-start, .is-pinned-end')).toBeNull()
  })

  // Sunday 1 November 2026 begins a run of days that is not Monday-first: Sunday, Monday, Tuesday. The week's header is drawn by
  // the same code for any run of days, so the first column must read "Sun", not "Mon".
  const RUN = ['2026-11-01', '2026-11-02', '2026-11-03']

  it('heads each column with the weekday of its date, not of its place among the columns', () => {
    const grid = tableGrid([entry(RUN[0]!, 60, projectOn('p1', 'Alpenstrom'))], RUN)
    renderWeek({ state: { status: 'loaded', grid } })
    const headers = within(table()).getAllByRole('columnheader').slice(1, 4)
    RUN.forEach((day, index) => {
      const text = headers[index]?.textContent ?? ''
      expect(text).toContain(['Sun', 'Mon', 'Tue'][index])
      expect(text).toContain(formatDate(day))
    })
    // The first column of a Monday-first week would say "Mon": the weekday does not come from the column's place.
    expect(headers[0]?.textContent).not.toContain('Mon')
  })

  it('names a cell button with the weekday of its date: 1 November 2026 is a Sunday', () => {
    const grid = tableGrid([entry(RUN[0]!, 60, projectOn('p1', 'Alpenstrom'))], RUN)
    renderWeek({ state: { status: 'loaded', grid }, onOpenCell: vi.fn() })
    const button = within(screen.getByTestId('hours-table-row-project:p1')).getByRole('button')
    expect(button.getAttribute('aria-label')).toBe(w.cell.open('1 h', 'Alpenstrom', 'Sunday 1 November 2026', 1))
    expect(button.getAttribute('aria-label')).toContain('Sunday 1 November 2026')
  })
})

describe('the month: its day columns, its compact header, its pinned columns and its width (AC-5.25, AC-5.34; design S7)', () => {
  const NOVEMBER = daysOf(month('2026-11'))
  const GRID = tableGrid(ENTRIES, NOVEMBER)
  const renderMonth = (props: Partial<TableViewProps> = {}) =>
    render(
      <TableView
        period={month('2026-11')}
        today={TODAY}
        filtered={false}
        state={{ status: 'loaded', grid: GRID }}
        onPeriodChange={vi.fn()}
        onKindChange={vi.fn()}
        onRetry={vi.fn()}
        onClearFilters={vi.fn()}
        {...props}
      />,
    )
  const headerOf = (day: string) => within(table()).getAllByRole('columnheader')[NOVEMBER.indexOf(day) + 1]!

  it('is headed with the month and the year, "November 2026"', () => {
    renderMonth()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('November 2026')
  })

  it('has a column for each of the 30 days of November, the 1st to the 30th, weekends included, between the label and Total', () => {
    renderMonth()
    const headers = within(table()).getAllByRole('columnheader')
    expect(headers).toHaveLength(32)
    expect(headers[0]?.textContent).toBe(strings.filters.recordedOn.label)
    expect(headers[31]?.textContent).toBe(w.grid.total)
    // the day number is the second line of each header, aria-hidden, in order 1 … 30
    const numbers = headers
      .slice(1, 31)
      .map((header) => header.querySelector('[aria-hidden="true"]')?.lastElementChild?.textContent)
    expect(numbers).toEqual(Array.from({ length: 30 }, (_, index) => String(index + 1)))
  })

  it('has as many columns as the month has days, in a 28-day month and a 31-day one', () => {
    for (const [key, count] of [
      ['2026-02', 28],
      ['2026-12', 31],
    ] as const) {
      const days = daysOf(month(key))
      const grid = tableGrid([entry(days[0]!, 60, projectOn('p1', 'Alpenstrom'))], days)
      renderMonth({ period: month(key), state: { status: 'loaded', grid } })
      expect(within(table()).getAllByRole('columnheader')).toHaveLength(count + 2)
      cleanup()
    }
  })

  it('heads each column compactly: the short weekday of its date and the day number, and not the long date to the eye', () => {
    renderMonth()
    // 1 November 2026 is a Sunday, so the first column reads "Sun" and not "Mon" (R17).
    const first = headerOf('2026-11-01')
    const visible = first.querySelector('[aria-hidden="true"]')!
    expect(visible.textContent).toBe('Sun1')
    expect(headerOf('2026-11-02').querySelector('[aria-hidden="true"]')?.textContent).toBe('Mon2')
    expect(headerOf('2026-11-30').querySelector('[aria-hidden="true"]')?.textContent).toBe('Mon30')
    expect(visible.textContent).not.toContain(formatDate('2026-11-01'))
  })

  it('names each column header for a reader as its long date, "Sunday 1 November 2026", the compact form being aria-hidden', () => {
    renderMonth()
    expect(within(table()).getByRole('columnheader', { name: 'Sunday 1 November 2026' })).toBe(headerOf('2026-11-01'))
    expect(within(table()).getByRole('columnheader', { name: 'Monday 30 November 2026' })).toBe(headerOf('2026-11-30'))
    // the hidden long date is in the header, not a second element in the page
    expect(headerOf('2026-11-01').querySelectorAll('.visually-hidden')).toHaveLength(1)
  })

  it('marks today with the badge beside the weekday and the word for it in the reader’s name, on today and on no other day', () => {
    renderMonth()
    const today = headerOf(TODAY)
    expect(within(today).getByText(w.today).closest('[aria-hidden="true"]')).not.toBeNull()
    expect(within(table()).getByRole('columnheader', { name: 'Thursday 19 November 2026, today' })).toBe(today)
    const marked = within(table())
      .getAllByRole('columnheader')
      .filter((header) => header.textContent?.includes(w.today))
    expect(marked).toEqual([today])
    expect(headerOf('2026-11-20').textContent).not.toContain('today')
  })

  it('pins the label column to the start and Total to the end, and no day column (design S7 "Pinned columns, month only")', () => {
    renderMonth()
    const headers = within(table()).getAllByRole('columnheader')
    expect(headers[0]?.classList.contains('is-pinned-start')).toBe(true)
    expect(headers.at(-1)?.classList.contains('is-pinned-end')).toBe(true)
    expect(headers.slice(1, -1).some((header) => /is-pinned/.test(header.className))).toBe(false)
    // the rows' own cells follow their header: the row's name and the row's total stay in view with it
    const projectRow = row('project:p1')
    expect(within(projectRow).getByRole('rowheader').classList.contains('is-pinned-start')).toBe(true)
    expect(within(projectRow).getAllByRole('cell').at(-1)?.classList.contains('is-pinned-end')).toBe(true)
    expect(within(row('total')).getByRole('rowheader').classList.contains('is-pinned-start')).toBe(true)
  })

  it('keeps the table inside DataTable’s focusable, labelled scroll region, so the page’s own width does not change (AC-5.34)', () => {
    renderMonth()
    const region = screen.getByRole('region', { name: w.grid.caption('November 2026') })
    expect(region.contains(table())).toBe(true)
    expect(region.getAttribute('tabindex')).toBe('0')
  })

  it('names a cell button with the weekday of its date, in a month that begins on a Sunday', () => {
    const grid = tableGrid([entry('2026-11-01', 60, projectOn('p1', 'Alpenstrom'))], NOVEMBER)
    renderMonth({ state: { status: 'loaded', grid }, onOpenCell: vi.fn() })
    const button = within(screen.getByTestId('hours-table-row-project:p1')).getByRole('button')
    expect(button.getAttribute('aria-label')).toBe(w.cell.open('1 h', 'Alpenstrom', 'Sunday 1 November 2026', 1))
  })
})

describe('the sideways scroll position survives a read of the same period (design G18, F5)', () => {
  const NOVEMBER = daysOf(month('2026-11'))
  const GRID = tableGrid(ENTRIES, NOVEMBER)
  const OCTOBER = daysOf(month('2026-10'))
  const props = (period: TablePeriod, state: TableViewProps['state']): TableViewProps => ({
    period,
    today: TODAY,
    filtered: false,
    state,
    onPeriodChange: vi.fn(),
    onKindChange: vi.fn(),
    onRetry: vi.fn(),
    onClearFilters: vi.fn(),
  })
  const loaded = (grid: TableGrid): TableViewProps['state'] => ({ status: 'loaded', grid })
  const region = () => screen.getByRole('region', { name: w.grid.caption('November 2026') })

  // jsdom has no layout: an element's `scrollLeft` is a plain number the test can read back, as a browser holds it.
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')
  beforeEach(() => {
    const held = new WeakMap<Element, number>()
    Object.defineProperty(Element.prototype, 'scrollLeft', {
      configurable: true,
      get(this: Element) {
        return held.get(this) ?? 0
      },
      set(this: Element, value: number) {
        held.set(this, value)
      },
    })
  })
  afterEach(() => {
    if (original) Object.defineProperty(Element.prototype, 'scrollLeft', original)
    else Reflect.deleteProperty(Element.prototype, 'scrollLeft')
  })

  const scrollTo = (left: number) => {
    region().scrollLeft = left
    fireEvent.scroll(region())
  }

  it('puts the region back where it was once the same month’s grid returns after a skeleton', () => {
    const { rerender } = render(<TableView {...props(month('2026-11'), loaded(GRID))} />)
    scrollTo(640)
    rerender(<TableView {...props(month('2026-11'), { status: 'loading' })} />)
    expect(screen.queryByRole('region', { name: w.grid.caption('November 2026') })).toBeNull()
    rerender(<TableView {...props(month('2026-11'), loaded(tableGrid(ENTRIES, NOVEMBER)))} />)
    expect(region().scrollLeft).toBe(640)
  })

  it('does so in a week too: the memory is the card’s, not the month’s', () => {
    const days = SEVEN
    const caption = w.grid.caption('16.11.2026 – 22.11.2026')
    const { rerender } = render(<TableView {...props(week(MONDAY), loaded(tableGrid(ENTRIES, days)))} />)
    screen.getByRole('region', { name: caption }).scrollLeft = 120
    fireEvent.scroll(screen.getByRole('region', { name: caption }))
    rerender(<TableView {...props(week(MONDAY), { status: 'loading' })} />)
    rerender(<TableView {...props(week(MONDAY), loaded(tableGrid(ENTRIES, days)))} />)
    expect(screen.getByRole('region', { name: caption }).scrollLeft).toBe(120)
  })

  it('remembers the last position the person scrolled to, not the first', () => {
    const { rerender } = render(<TableView {...props(month('2026-11'), loaded(GRID))} />)
    scrollTo(300)
    scrollTo(900)
    rerender(<TableView {...props(month('2026-11'), { status: 'loading' })} />)
    rerender(<TableView {...props(month('2026-11'), loaded(tableGrid(ENTRIES, NOVEMBER)))} />)
    expect(region().scrollLeft).toBe(900)
  })

  it('starts at the left in another period: a change of period is a new place', () => {
    const { rerender } = render(<TableView {...props(month('2026-11'), loaded(GRID))} />)
    scrollTo(640)
    rerender(<TableView {...props(month('2026-10'), { status: 'loading' })} />)
    const october = tableGrid([entry('2026-10-05', 60, projectOn('p1', 'Alpenstrom'))], OCTOBER)
    rerender(<TableView {...props(month('2026-10'), loaded(october))} />)
    expect(screen.getByRole('region', { name: w.grid.caption('October 2026') }).scrollLeft).toBe(0)
  })

  it('does not bring an earlier period’s place back when the person returns to it without having scrolled the other', () => {
    const { rerender } = render(<TableView {...props(month('2026-11'), loaded(GRID))} />)
    scrollTo(640)
    rerender(<TableView {...props(month('2026-10'), { status: 'loading' })} />)
    rerender(<TableView {...props(month('2026-11'), { status: 'loading' })} />)
    rerender(<TableView {...props(month('2026-11'), loaded(tableGrid(ENTRIES, NOVEMBER)))} />)
    expect(region().scrollLeft).toBe(0)
  })

  it('restores nothing, and fails nothing, where the new state has no grid to put it on', () => {
    const { rerender } = render(<TableView {...props(month('2026-11'), loaded(GRID))} />)
    scrollTo(640)
    rerender(<TableView {...props(month('2026-11'), loaded(tableGrid([], NOVEMBER)))} />)
    expect(screen.queryByRole('region', { name: w.grid.caption('November 2026') })).toBeNull()
    expect(screen.getByTestId('hours-table-empty')).not.toBeNull()
  })

  it('puts it back before anything asks for focus: the heading is focused after the scroll is restored', () => {
    const ref = { current: null as import('./TableView').TableViewHandle | null }
    const { rerender } = render(<TableView {...props(month('2026-11'), loaded(GRID))} ref={ref} />)
    scrollTo(500)
    rerender(<TableView {...props(month('2026-11'), { status: 'loading' })} ref={ref} />)
    rerender(<TableView {...props(month('2026-11'), loaded(tableGrid(ENTRIES, NOVEMBER)))} ref={ref} />)
    ref.current?.focusHeading()
    expect(region().scrollLeft).toBe(500)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3 }))
  })
})
