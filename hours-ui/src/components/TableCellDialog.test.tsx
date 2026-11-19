/**
 * @vitest-environment jsdom
 *
 * TableCellDialog — the entries of one cell of the Week, one row on one day (specs/20261116-record-hours-in-place T12;
 * design S8; AC-5.15, AC-5.16, AC-5.17, AC-5.18, AC-5.24). Presentational: it is handed the row, the cell and what the
 * page can do (Edit, Delete, Add hours, Close); the stacked entry dialog and delete confirmation, the write and the
 * re-read are the page's, and are `MyHoursPage.cells.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatDateLong } from '@operai/ui'
import { strings } from '../strings'
import type { TimeEntryView } from '../lib/hoursApi.types'
import { tableGrid } from '../lib/tableGrid'
import type { TableGridRow } from '../lib/tableGrid'
import { daysOf, holding } from '../lib/tablePeriod'
import { dealOn, meetingOn, otherWorkOn, projectOn, timeEntryView } from '../test-support/fakeApi'
import EntryDayList from './EntryDayList'
import TableCellDialog from './TableCellDialog'
import type { TableCellDialogProps } from './TableCellDialog'

afterEach(() => cleanup())

const w = strings.table
const e = strings.entries

const MONDAY = '2026-11-16'
const WEDNESDAY = '2026-11-18'
const DAYS = daysOf(holding('week', MONDAY))

let sequence = 0
const entry = (overrides: Partial<TimeEntryView> & Pick<TimeEntryView, 'on'>): TimeEntryView =>
  timeEntryView({ id: `c${++sequence}`, day: WEDNESDAY, minutes: 60, ...overrides })

const rowOf = (entries: TimeEntryView[], key: string): TableGridRow => {
  const row = tableGrid(entries, DAYS).rows.find((candidate) => candidate.key === key)
  if (row === undefined) throw new Error(`no row ${key}`)
  return row
}

/** Two entries of Alpenstrom on Wednesday: 4 h with a work type, an activity and a note, and 2 h 30 with none. */
const KICKOFF = entry({
  minutes: 240,
  on: projectOn('p1', 'Alpenstrom — portale clienti'),
  workType: { id: 'wt-dev', name: 'Development', retired: false },
  activity: { id: 'a1', subject: 'Write the offer', visibility: 'visible' },
  note: 'Kick-off notes',
})
const SUPPORT = entry({ minutes: 150, on: projectOn('p1', 'Alpenstrom — portale clienti') })
const ALPENSTROM = rowOf([KICKOFF, SUPPORT], 'project:p1')

const renderDialog = (props: Partial<TableCellDialogProps> = {}) => {
  const row = props.row ?? ALPENSTROM
  const day = props.day ?? WEDNESDAY
  return render(
    <TableCellDialog
      row={row}
      cell={row.cells[day]!}
      day={day}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onAdd={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  )
}

const dialog = () => screen.getByRole('dialog')

describe('the title and the description name the row and the day (AC-5.15, design S8)', () => {
  it('is titled "<kind>: <name>" and described by the day, the number of entries and their total', () => {
    renderDialog()

    const open = screen.getByRole('dialog', { name: 'Project: Alpenstrom — portale clienti' })
    expect(open.getAttribute('aria-modal')).toBe('true')
    expect(open.getAttribute('aria-describedby')).not.toBeNull()
    expect(document.getElementById(open.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Wednesday 18 November 2026 · 2 entries, 6 h 30',
    )
    // Not a drawer, not a popover: the library's dialog, large.
    expect(open.className).toContain('dialog-lg')
  })

  it('says "1 entry" for one', () => {
    const only = rowOf([KICKOFF], 'project:p1')
    renderDialog({ row: only })
    const open = dialog()
    expect(document.getElementById(open.getAttribute('aria-describedby')!)!.textContent).toBe(
      'Wednesday 18 November 2026 · 1 entry, 4 h',
    )
  })

  it('names the weekday of the date, not of the column it was opened from (R17)', () => {
    const sunday = '2026-11-22'
    const onSunday = rowOf([entry({ day: sunday, minutes: 60, on: projectOn('p1', 'Alpenstrom') })], 'project:p1')
    renderDialog({ row: onSunday, day: sunday })
    expect(document.getElementById(dialog().getAttribute('aria-describedby')!)!.textContent).toBe(
      'Sunday 22 November 2026 · 1 entry, 1 h',
    )
    cleanup()

    // Sunday 1 November 2026 is the last day of a week that began in October.
    const first = '2026-11-01'
    const grid = tableGrid(
      [entry({ day: first, minutes: 30, on: projectOn('p1', 'Alpenstrom') })],
      daysOf(holding('week', first)),
    )
    const row = grid.rows[0]!
    renderDialog({ row, day: first })
    expect(document.getElementById(dialog().getAttribute('aria-describedby')!)!.textContent).toBe(
      'Sunday 1 November 2026 · 1 entry, 30 min',
    )
  })

  it.each([
    ['a deal', rowOf([entry({ on: dealOn('d1', 'Brera') })], 'deal:d1'), 'Deal: Brera'],
    ['a meeting', rowOf([entry({ on: meetingOn('m1', 'Retrospective') })], 'meeting:m1'), 'Meeting: Retrospective'],
    [
      'other work',
      rowOf([entry({ on: otherWorkOn('Training', 'tc-training') })], 'category:tc-training'),
      'Other work: Training',
    ],
    [
      'a retired category, as the List writes it',
      rowOf([entry({ on: otherWorkOn('Seminars', 'tc-seminars', true) })], 'category:tc-seminars'),
      'Other work: Seminars (retired)',
    ],
    [
      'a project the person may not read, in the List’s words and never by name',
      rowOf([entry({ on: projectOn('p9', 'Secret', 'hidden') })], 'project:p9'),
      `Project: ${strings.names.hidden}`,
    ],
  ])('names %s', (_what, row, title) => {
    renderDialog({ row })
    expect(screen.getByRole('dialog', { name: title })).not.toBeNull()
  })
})

describe('each entry is the List’s row, as the List writes it (AC-5.15)', () => {
  it('lists the entries of the cell in the order they came, in a list labelled "Entries on <date>"', () => {
    renderDialog()

    const list = within(dialog()).getByRole('list', { name: e.dayList(formatDateLong(WEDNESDAY)) })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(
      within(list)
        .getAllByTestId(/^hours-entry-c\d+$/)
        .map((row) => row.getAttribute('data-testid')),
    ).toEqual([`hours-entry-${KICKOFF.id}`, `hours-entry-${SUPPORT.id}`])
  })

  it('draws each row exactly as EntryDayList draws it: the same text, the same buttons with the same names', () => {
    const inList = render(
      <EntryDayList entries={[KICKOFF, SUPPORT]} dayTotals={null} onEdit={vi.fn()} onDelete={vi.fn()} />,
    )
    const listed = [KICKOFF, SUPPORT].map((item) => {
      const row = within(inList.container).getByTestId(`hours-entry-${item.id}`)
      return {
        text: row.textContent,
        buttons: within(row)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-label')),
      }
    })
    inList.unmount()

    renderDialog()

    const inDialog = [KICKOFF, SUPPORT].map((item) => {
      const row = within(dialog()).getByTestId(`hours-entry-${item.id}`)
      return {
        text: row.textContent,
        buttons: within(row)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-label')),
      }
    })
    expect(inDialog).toEqual(listed)
    // Spelled out, so the comparison cannot be two empty things: the work type, the activity, the note, the buttons.
    expect(inDialog[0]!.text).toContain('Development')
    expect(inDialog[0]!.text).toContain('Write the offer')
    expect(inDialog[0]!.text).toContain('Kick-off notes')
    expect(inDialog[0]!.buttons).toEqual([
      'Edit 4 h on Alpenstrom — portale clienti, 18.11.2026',
      'Delete 4 h on Alpenstrom — portale clienti, 18.11.2026',
    ])
  })
})

describe('Edit, Delete, Add hours and Close (AC-5.16, AC-5.17, AC-5.18)', () => {
  it('Edit and Delete hand the entry whose button was chosen to the page', async () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    renderDialog({ onEdit, onDelete })

    await userEvent.click(
      within(screen.getByTestId(`hours-entry-${SUPPORT.id}`)).getByRole('button', { name: /^Edit / }),
    )
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(SUPPORT)
    await userEvent.click(
      within(screen.getByTestId(`hours-entry-${KICKOFF.id}`)).getByRole('button', { name: /^Delete / }),
    )
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(KICKOFF)
  })

  it('Edit and Delete are on every entry, a row that cannot be recorded on included (AC-5.24)', () => {
    const secret = entry({ on: projectOn('p9', 'Secret', 'hidden') })
    renderDialog({ row: rowOf([secret], 'project:p9'), onAdd: undefined })

    const row = screen.getByTestId(`hours-entry-${secret.id}`)
    expect(within(row).getByRole('button', { name: /^Edit / })).not.toBeNull()
    expect(within(row).getByRole('button', { name: /^Delete / })).not.toBeNull()
  })

  it('Add hours is the dialog’s one primary action, after Close in the order of the page, and opens the page’s dialog', async () => {
    const onAdd = vi.fn()
    renderDialog({ onAdd })

    const add = within(dialog()).getByRole('button', { name: w.cellDialog.add })
    expect(add.getAttribute('aria-haspopup')).toBe('dialog')
    expect(add.className).toContain('btn-primary')
    const buttons = within(dialog()).getAllByRole('button')
    const labels = buttons.map((button) => button.textContent || button.getAttribute('aria-label'))
    expect(labels.indexOf(strings.common.close)).toBeLessThan(labels.indexOf(w.cellDialog.add))
    expect(
      within(dialog())
        .getAllByRole('button')
        .filter((b) => b.className.includes('btn-primary')),
    ).toEqual([add])

    await userEvent.click(add)
    expect(onAdd).toHaveBeenCalledOnce()
  })

  it('without an Add hours handler there is none: a row the person cannot record on', () => {
    renderDialog({ onAdd: undefined })
    expect(within(dialog()).queryByRole('button', { name: w.cellDialog.add })).toBeNull()
    expect(within(dialog()).getAllByRole('button', { name: /^Edit / })).toHaveLength(2)
  })

  it('Close, × and Escape each close it', async () => {
    const onClose = vi.fn()
    renderDialog({ onClose })

    // The footer's Close and the header's × are both named Close.
    const closers = within(dialog()).getAllByRole('button', { name: strings.common.close })
    expect(closers).toHaveLength(2)
    for (const closer of closers) await userEvent.click(closer)
    expect(onClose).toHaveBeenCalledTimes(2)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

describe('focus (design S8, a11y "The cell dialog")', () => {
  it('opens on the first entry’s Edit button', () => {
    renderDialog()
    expect(document.activeElement).toBe(screen.getByTestId(`hours-entry-${KICKOFF.id}-edit`))
  })

  it('the List never carries that mark: its Edit buttons are not autofocus targets', () => {
    render(<EntryDayList entries={[KICKOFF]} dayTotals={null} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(document.querySelector('[data-autofocus]')).toBeNull()
  })

  it('goes to the dialog’s heading when the entry whose button had it is gone, never to the page behind', () => {
    const view = renderDialog()
    // The person had pressed Delete on the first entry; the week was read again and the entry is no longer in the cell.
    screen.getByTestId(`hours-entry-${KICKOFF.id}-delete`).focus()
    const afterDelete = rowOf([SUPPORT], 'project:p1')

    view.rerender(
      <TableCellDialog
        row={afterDelete}
        cell={afterDelete.cells[WEDNESDAY]!}
        day={WEDNESDAY}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByTestId(`hours-entry-${KICKOFF.id}`)).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Project: Alpenstrom — portale clienti' }))
    expect(dialog().contains(document.activeElement)).toBe(true)
  })

  it('leaves focus where it is when the list changes but the button that had it is still there', () => {
    const view = renderDialog()
    const supportEdit = screen.getByTestId(`hours-entry-${SUPPORT.id}-edit`)
    supportEdit.focus()
    const third = entry({ minutes: 30, on: projectOn('p1', 'Alpenstrom — portale clienti') })
    const grown = rowOf([KICKOFF, SUPPORT, third], 'project:p1')

    view.rerender(
      <TableCellDialog
        row={grown}
        cell={grown.cells[WEDNESDAY]!}
        day={WEDNESDAY}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAdd={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByTestId(`hours-entry-${third.id}`)).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId(`hours-entry-${SUPPORT.id}-edit`))
  })
})
