/**
 * TableViewModel — what the Week view says about a week and about a row (specs/20261116-record-hours-in-place T9;
 * design S7; AC-5.5, AC-5.23). Pure: the week as two dates, a row's name and the phrase that names it in a button,
 * both worded by the List's own functions (`lib/names.ts`) so the two views never disagree about one entry.
 */
import { describe, expect, it } from 'vitest'
import { formatDate, formatDateLong, formatMonth } from '@operai/ui'
import { strings } from '../strings'
import type { EntryOn } from '../lib/hoursApi.types'
import { onPhrase, rowName } from '../lib/names'
import { tableGrid } from '../lib/tableGrid'
import type { TableGridRow } from '../lib/tableGrid'
import { daysOf, holding } from '../lib/tablePeriod'
import { dealOn, meetingOn, otherWorkOn, projectOn, timeEntryView } from '../test-support/fakeApi'
import {
  cellOf,
  dayHeaderName,
  dayNumber,
  longDay,
  periodLabel,
  rowLabel,
  rowPhrase,
  shortDay,
  weekRange,
} from './TableViewModel'

const MONDAY = '2026-11-16'
const DAYS = daysOf(holding('week', MONDAY))

/** The one row an entry on `on` makes in the week of `MONDAY`. */
const rowOf = (on: EntryOn): TableGridRow => {
  const [row] = tableGrid([timeEntryView({ id: 'e', day: MONDAY, minutes: 60, on })], DAYS).rows
  if (!row) throw new Error('no row')
  return row
}

describe('weekRange: the week as two formatDates with an en dash (AC-5.5)', () => {
  it('is the Monday and the Sunday of the week, each as the suite writes a date, with an en dash between', () => {
    expect(weekRange('2026-11-16')).toBe(`${formatDate('2026-11-16')} – ${formatDate('2026-11-22')}`)
    expect(weekRange('2026-11-16')).toBe('16.11.2026 – 22.11.2026')
  })

  it('runs over a month and over a year, because the Sunday is six days on, not a date built by hand', () => {
    expect(weekRange('2026-11-30')).toBe('30.11.2026 – 06.12.2026')
    expect(weekRange('2026-12-28')).toBe('28.12.2026 – 03.01.2027')
  })

  it('refuses a day that is not a Monday, as the week functions do: it would name another week', () => {
    expect(() => weekRange('2026-11-17')).toThrow(TypeError)
  })
})

describe('rowLabel: a row is named as the list names an entry (AC-5.23)', () => {
  it.each<[string, EntryOn]>([
    ['a project', projectOn('p1', 'Alpenstrom')],
    ['a deal', dealOn('d1', 'Brera')],
    ['a meeting', meetingOn('m1', 'Retrospective')],
    ['a project the viewer may not read', projectOn('p2', 'Secret', 'hidden')],
    ['a deal whose owner did not answer', dealOn('d2', 'Unseen', 'unavailable')],
    ['a meeting the viewer may not read', meetingOn('m2', 'Closed', { state: 'none' }, 'hidden')],
    ['a project that arrived visible with no label', projectOn('p3', null)],
  ])('says for %s what rowName says of the entry', (_name, on) => {
    expect(rowLabel(rowOf(on))).toBe(rowName(on)?.text)
  })

  it('shows the placeholders of the catalog, never a name, for the two reasons a name is withheld', () => {
    expect(rowLabel(rowOf(projectOn('p2', 'Secret', 'hidden')))).toBe(strings.names.hidden)
    expect(rowLabel(rowOf(dealOn('d2', 'Unseen', 'unavailable')))).toBe(strings.names.unavailable)
  })

  it('names other work by its category, and says so when the category is retired, as the list does', () => {
    expect(rowLabel(rowOf(otherWorkOn('Training', 'c1')))).toBe('Training')
    expect(rowLabel(rowOf(otherWorkOn('Old training', 'c2', true)))).toBe(strings.entries.retired('Old training'))
  })
})

describe('rowPhrase: how a row is named inside a button (AC-5.23)', () => {
  it.each<[string, EntryOn]>([
    ['a project', projectOn('p1', 'Alpenstrom')],
    ['a deal', dealOn('d1', 'Brera')],
    ['a meeting', meetingOn('m1', 'Retrospective')],
    ['a project the viewer may not read', projectOn('p2', 'Secret', 'hidden')],
    ['a deal whose owner did not answer', dealOn('d2', 'Unseen', 'unavailable')],
    ['a meeting the viewer may not read', meetingOn('m2', 'Closed', { state: 'none' }, 'hidden')],
    ['a meeting whose owner did not answer', meetingOn('m3', 'Silent', { state: 'none' }, 'unavailable')],
    ['other work', otherWorkOn('Training', 'c1')],
  ])('is for %s what onPhrase says of the entry', (_name, on) => {
    expect(rowPhrase(rowOf(on))).toBe(onPhrase(on))
  })

  it('never carries the name of a record the viewer may not read', () => {
    expect(rowPhrase(rowOf(projectOn('p2', 'Secret', 'hidden')))).not.toContain('Secret')
  })
})

describe('periodLabel: the period as the card heads it (AC-5.5)', () => {
  it('is, for a week, weekRange of its Monday: two dates with an en dash', () => {
    expect(periodLabel(holding('week', '2026-11-18'))).toBe('16.11.2026 – 22.11.2026')
    expect(periodLabel(holding('week', '2026-12-02'))).toBe(weekRange('2026-11-30'))
    expect(periodLabel(holding('week', '2026-12-02'))).toBe('30.11.2026 – 06.12.2026')
  })

  it('is, for a month, the month and the year in the person’s language, as formatMonth writes them (AC-5.25)', () => {
    expect(periodLabel(holding('month', '2026-11-19'))).toBe(formatMonth('2026-11'))
    expect(periodLabel(holding('month', '2026-11-19'))).toBe('November 2026')
    expect(periodLabel(holding('month', '2026-12-01'))).toBe('December 2026')
    expect(periodLabel(holding('month', '2028-02-29'))).toBe('February 2028')
  })
})

describe('dayNumber and dayHeaderName: the month\'s compact day header (design S7 "Columns", decision 4; R17)', () => {
  it('numbers a day by its day of the month, with no leading zero: 1 … 31', () => {
    expect(dayNumber('2026-11-01')).toBe('1')
    expect(dayNumber('2026-11-09')).toBe('9')
    expect(dayNumber('2026-11-30')).toBe('30')
    expect(dayNumber('2026-12-31')).toBe('31')
  })

  it('names a day for a reader as its long date: the weekday of the date and formatDateLong', () => {
    expect(dayHeaderName('2026-11-01', '2026-11-19')).toBe('Sunday 1 November 2026')
    expect(dayHeaderName('2026-11-18', '2026-11-19')).toBe('Wednesday 18 November 2026')
  })

  it('adds the word for today, in lower case, on today and on no other day', () => {
    expect(dayHeaderName('2026-11-19', '2026-11-19')).toBe(
      `Thursday 19 November 2026, ${strings.table.today.toLowerCase()}`,
    )
    expect(dayHeaderName('2026-11-19', '2026-11-19')).toBe('Thursday 19 November 2026, today')
    expect(dayHeaderName('2026-11-20', '2026-11-19')).not.toContain('today')
  })

  it('refuses text that is not a day: a caller bug', () => {
    expect(() => dayNumber('2026-02-30')).toThrow(TypeError)
    expect(() => dayHeaderName('', '2026-11-19')).toThrow(TypeError)
  })
})

describe("longDay and shortDay: the weekday comes from the date, never from a column's place (R17)", () => {
  it('names Sunday 1 November 2026 a Sunday: the first day of a month that does not begin on a Monday', () => {
    expect(longDay('2026-11-01')).toBe(`${strings.table.weekday.long[6]} ${formatDateLong('2026-11-01')}`)
    expect(longDay('2026-11-01')).toBe('Sunday 1 November 2026')
    expect(shortDay('2026-11-01')).toBe('Sun')
  })

  it('names Monday 30 November a Monday and the Sunday 6 December that ends its week a Sunday', () => {
    expect(longDay('2026-11-30')).toBe('Monday 30 November 2026')
    expect(longDay('2026-12-06')).toBe('Sunday 6 December 2026')
    expect(shortDay('2026-11-30')).toBe('Mon')
    expect(shortDay('2026-12-06')).toBe('Sun')
  })

  it('names Tuesday 1 September 2026 a Tuesday, and every day of a week as the catalog has it, Monday first', () => {
    expect(longDay('2026-09-01')).toBe('Tuesday 1 September 2026')
    expect(shortDay('2026-09-01')).toBe('Tue')
    expect(DAYS.map(shortDay)).toEqual([...strings.table.weekday.short])
    expect(DAYS.map((day) => longDay(day).split(' ')[0])).toEqual([...strings.table.weekday.long])
  })

  it('refuses text that is not a day: a caller bug, never a weekday', () => {
    expect(() => longDay('2026-02-30')).toThrow(TypeError)
    expect(() => shortDay('')).toThrow(TypeError)
  })
})

describe('cellOf: the cell a dialog was opened on, looked up by row key and day (AC-5.15)', () => {
  const grid = tableGrid(
    [
      timeEntryView({ id: 'a', day: '2026-11-18', minutes: 60, on: projectOn('p1', 'Alpenstrom') }),
      timeEntryView({ id: 'b', day: '2026-11-18', minutes: 30, on: projectOn('p1', 'Alpenstrom') }),
    ],
    DAYS,
  )

  it("is the row and the cell, and nothing about a column: the weekday is the date's", () => {
    const found = cellOf(grid, 'project:p1', '2026-11-18')
    expect(found).toEqual({ row: grid.rows[0], cell: grid.rows[0]!.cells['2026-11-18'] })
    expect(found?.cell.entries.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('is null for a day with no entry, a row the grid does not have, and a day outside the grid', () => {
    expect(cellOf(grid, 'project:p1', '2026-11-19')).toBeNull()
    expect(cellOf(grid, 'project:p2', '2026-11-18')).toBeNull()
    expect(cellOf(grid, 'project:p1', '2026-12-18')).toBeNull()
  })
})
