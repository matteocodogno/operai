/**
 * TableViewModel — what the table view says about a period and about a row (specs/20261116-record-hours-in-place T9,
 * T18; design S7; AC-5.5, AC-5.23). Pure functions, so the component stays markup.
 *
 * A row is named by the List's own functions (`lib/names.ts`: `rowName`, `onPhrase`), fed an `EntryOn` made from
 * the row, so a project the viewer may not read is "Not visible to you" here exactly as it is in the List and in the
 * export, and no second copy of that rule can drift. The row carries no link and no id (design G6).
 */
import { formatDate, formatDateLong, formatMonth, formatNumber } from '@operai/ui'
import type { EntryOn } from '../lib/hoursApi.types'
import { onPhrase, rowName } from '../lib/names'
import { monthOf } from '../lib/month'
import { mondayOf, weekDays } from '../lib/week'
import type { TableGridCell, TableGrid, TableGridRow } from '../lib/tableGrid'
import type { TablePeriod } from '../lib/tablePeriod'
import { strings } from '../strings'

/**
 * The week as two `formatDate`s with an en dash, "16.11.2026 – 22.11.2026" (AC-5.5): the card's heading, the
 * table's caption and the sentence read when a week arrives. The Sunday is the seventh day of the week, never a
 * date built by hand, so a week that crosses a month or a year reads right.
 */
export const weekRange = (monday: string): string => {
  const days = weekDays(monday)
  return `${formatDate(days[0]!)} – ${formatDate(days[6]!)}`
}

/**
 * The period as the card's heading, the table's caption and the sentence read when a period arrives name it (AC-5.5,
 * AC-5.25): for a week, `weekRange` of its Monday; for a month, `formatMonth` of it, "November 2026" / "novembre 2026".
 */
export const periodLabel = (period: TablePeriod): string =>
  period.kind === 'week' ? weekRange(period.monday) : formatMonth(period.month)

/**
 * A day's place in its own week, Monday 0, from the date alone (R17). Never a column's index: in a week the two
 * coincide, in a period that does not begin on a Monday (November 2026 begins on a Sunday) they do not.
 */
const weekdayOf = (day: string): number => weekDays(mondayOf(day)).indexOf(day)

/** A day's short weekday, "Mon": from the catalog by the date (the library has no weekday formatter). */
export const shortDay = (day: string): string => strings.table.weekday.short[weekdayOf(day)]!

/** A day as a button names it, "Thursday 19 November 2026": the long weekday by the date, then `formatDateLong`. */
export const longDay = (day: string): string => `${strings.table.weekday.long[weekdayOf(day)]} ${formatDateLong(day)}`

/**
 * A day's number in its month, "1" … "31": the second line of the month's compact column header (design S7, decision 4).
 * A week's header says `formatDate` instead, since a week can cross a month and a bare number would be ambiguous there; a
 * month never does.
 */
export const dayNumber = (day: string): string => {
  monthOf(day)
  return formatNumber(Number(day.slice(8)))
}

/**
 * What a reader is told a day's column is, where the compact header is `aria-hidden` (design S7, decision 4): the long date,
 * "Thursday 19 November 2026", with the word for today added on today's column. Made of existing words (`longDay`,
 * `table.today`), so it adds no key.
 */
export const dayHeaderName = (day: string, today: string): string =>
  day === today ? `${longDay(day)}, ${strings.table.today.toLowerCase()}` : longDay(day)

/** The row as the entry it holds would be for `rowName` and `onPhrase`: its kind, its name and why it may have none. */
const onOf = (row: TableGridRow): EntryOn => {
  if (row.kind === 'none')
    return { type: 'none', category: { id: row.key, name: row.name ?? '', retired: row.retired } }
  const named = { id: null, label: row.name, href: null, visibility: row.visibility }
  return row.kind === 'meeting' ? { type: 'meeting', ...named, deal: { state: 'none' } } : { type: row.kind, ...named }
}

/**
 * The row's name as the List writes it (AC-5.23): the label of a project, deal or meeting the viewer may read,
 * "Not visible to you" or "Name unavailable" for one they may not or whose owner did not answer, the category's name
 * for other work — and, for a retired category, "(retired)" after it, as the List writes that too.
 */
export const rowLabel = (row: TableGridRow): string => {
  if (row.kind === 'none') return row.retired ? strings.entries.retired(row.name ?? '') : (row.name ?? '')
  return rowName(onOf(row))?.text ?? ''
}

/**
 * How the row is named inside a cell button's accessible name ("2 h on <this>, Monday 16 November 2026, 1 entry"): the List's
 * `onPhrase`, so "a project not visible to you" and "other work (Training)" read the same in both views. Never the
 * name of a record the viewer may not read.
 */
export const rowPhrase = (row: TableGridRow): string => onPhrase(onOf(row))

/**
 * The cell of the grid a cell dialog was opened on (design S8): the row and the cell, looked up by the row's key and the
 * day because the grid itself is replaced every time the period is read again. `null` once the cell holds no entry —
 * the row is gone from the period, or this day of it is empty — which is the page's cue that the dialog has nothing
 * left to list. A day outside the grid's days has no cell, so it is `null` too.
 */
export const cellOf = (
  grid: TableGrid,
  rowKey: string,
  day: string,
): { row: TableGridRow; cell: TableGridCell } | null => {
  const row = grid.rows.find((candidate) => candidate.key === rowKey)
  const cell = row?.cells[day]
  return row !== undefined && cell !== undefined && cell.entries.length > 0 ? { row, cell } : null
}
