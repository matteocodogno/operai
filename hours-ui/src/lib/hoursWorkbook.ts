/**
 * hoursWorkbook — the XLSX of the entries a view shows (specs/029-time-tracking T30; plan § Export file;
 * design F5; AC-4.6, AC-4.9, AC-4.10; D39, D40), built in the browser with `exceljs` (the inventory-ui
 * `yearWorkbook.ts` pattern, not copied code). This module statically imports `exceljs`, so it is only ever
 * loaded through a dynamic `import()` from `HoursExport`'s `build` — the heavy dependency stays in a lazy
 * chunk, never in the page's.
 *
 * One sheet, a header row, then one row per entry in the order given (the list's), nine columns: Day (a date
 * cell), Person, Hours (a NUMBER, `minutes / 60`, so the column sums — AC-4.9's "2 h 30" is the screen, D39),
 * On (the kind of work), Name, Counts for deal (the deal the hours count for, D40, so Hours summed by it equals
 * the by-deal totals), Category or work type, Activity and Note.
 *
 * The file carries no id, and no name the viewer may not read: a name is written only for `visibility:
 * "visible"`, and anything else is a word of the catalog — the same words as on screen (AC-4.10). Every cell of
 * text is a plain string cell, so a note that starts with `=` is text in the spreadsheet, never a formula.
 *
 * `buildHoursWorkbook` is pure: entries and the words in, a workbook out. Nothing is summed, sorted or
 * rounded here beyond the one division; the figures are the server's.
 */
import ExcelJS from 'exceljs'
import type { en } from '../strings'
import type { EntryOn, MeetingDeal, Person, TimeEntryView, Visibility } from './hoursApi.types'

/** Every word the file needs, in the viewer's language: the headers and the placeholders. */
export type HoursWorkbookCopy = {
  sheetName: string
  columns: {
    day: string
    person: string
    hours: string
    on: string
    name: string
    countsForDeal: string
    categoryOrWorkType: string
    activity: string
    note: string
  }
  /** The kind of work: Project, Deal, Meeting, Other work. */
  on: Record<EntryOn['type'], string>
  person: { unknown: string; deactivated: (name: string) => string }
  /** In place of a name the viewer may not read. */
  hidden: string
  /** In place of a name whose owner did not answer. */
  unavailable: string
  /** In place of the deal a meeting counts for, when that could not be asked. */
  unknown: string
}

/** The words of the file from a language's catalog: the export's headers and the screen's own placeholders. */
export const workbookCopyOf = (catalog: typeof en): HoursWorkbookCopy => ({
  sheetName: catalog.export.workbook.sheetName,
  columns: catalog.export.workbook.columns,
  on: catalog.entries.type,
  person: catalog.everyone.person,
  hidden: catalog.names.hidden,
  unavailable: catalog.names.unavailable,
  unknown: catalog.names.unknown,
})

const DATE_FORMAT = 'dd.mm.yyyy'
const HOURS_FORMAT = '0.0'
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The columns' widths, in characters, in the order of the sheet. */
const WIDTHS = [12, 24, 8, 12, 30, 30, 26, 30, 50] as const

/** A `YYYY-MM-DD` as a UTC-midnight `Date`, so every time zone writes the same calendar day; anything else stays text. */
const dayCell = (day: string): Date | string => {
  const match = DATE_ONLY.exec(day)
  if (match === null) return day
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
}

/**
 * A name as the file may write it (the rule of `lib/names`, with the words handed in): the label when the viewer
 * may read it, "Not visible to you" when they may not, "Name unavailable" when its owner did not answer or a
 * readable one arrived without a label. An id is never the fallback.
 */
const nameOf = (visibility: Visibility, label: string | null | undefined, copy: HoursWorkbookCopy): string => {
  if (visibility === 'hidden') return copy.hidden
  if (visibility === 'unavailable' || typeof label !== 'string') return copy.unavailable
  return label
}

/** The person as the screen names them: the resolved name, else "Unknown user"; "(deactivated)" for a closed account. */
const personOf = (person: Person, copy: HoursWorkbookCopy): string => {
  const known = person.name !== null && person.name.trim() !== '' ? person.name : copy.person.unknown
  return person.status === 'deleted' ? copy.person.deactivated(known) : known
}

/** The hours of an entry: whole minutes over sixty. Anything else would be a cell nobody can sum, so it throws. */
const hoursOf = (minutes: number): number => {
  if (!Number.isInteger(minutes)) throw new RangeError(`hoursOf: minutes must be a whole number, got ${minutes}`)
  return minutes / 60
}

const nameCell = (on: EntryOn, copy: HoursWorkbookCopy): string | null =>
  on.type === 'none' ? null : nameOf(on.visibility, on.label, copy)

/**
 * The deal a meeting's hours count for (AC-2.6): its name for a deal the viewer may read, a placeholder for one
 * they may not, one whose owner did not answer, or one that could not be asked; empty for a meeting linked to
 * none. The deal's visibility is the viewer's access to the DEAL, never to the meeting (ADR-0089): a hidden
 * meeting of a readable deal still names it. No id is ever read.
 */
const meetingDealCell = (deal: MeetingDeal, copy: HoursWorkbookCopy): string | null => {
  switch (deal.state) {
    case 'none':
      return null
    case 'unknown':
      return copy.unknown
    case 'linked':
      return deal.visibility === 'visible' ? nameOf('visible', deal.label, copy) : nameOf(deal.visibility, null, copy)
  }
}

/**
 * The work type of an entry on a project or a deal, or the category of other work — the name as typed (AC-3.8),
 * with no "(retired)" suffix: a column that is summed or filtered by name must not split one item in two.
 */
const categoryOrWorkTypeCell = (entry: TimeEntryView): string | null =>
  (entry.on.type === 'none' ? entry.on.category.name : entry.workType?.name) ?? null

/** The subject of the activity the entry points at, or why it is not named; empty when there is none (AC-2.9). */
const activityCell = (activity: TimeEntryView['activity'], copy: HoursWorkbookCopy): string | null =>
  activity === null ? null : nameOf(activity.visibility, activity.subject, copy)

/** The deal the hours count for (D40): an entry on a deal, that deal; on a meeting, its deal; anything else, none. */
const countsForDealCell = (on: EntryOn, copy: HoursWorkbookCopy): string | null => {
  switch (on.type) {
    case 'deal':
      return nameOf(on.visibility, on.label, copy)
    case 'meeting':
      return meetingDealCell(on.deal, copy)
    default:
      return null
  }
}

/**
 * `hours-<from>_<to>.xlsx`: named from the view's period (ISO days), never from a person (design F5). The days are
 * checked, because they become a file name: anything that is not `YYYY-MM-DD` throws and no file is made.
 */
export const hoursFileName = (from: string, to: string): string => {
  if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to))
    throw new TypeError(`hoursFileName: expected two YYYY-MM-DD days, got ${from}, ${to}`)
  return `hours-${from}_${to}.xlsx`
}

export const buildHoursWorkbook = (items: readonly TimeEntryView[], copy: HoursWorkbookCopy): ExcelJS.Workbook => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(copy.sheetName)

  const header = sheet.getRow(1)
  header.values = [
    copy.columns.day,
    copy.columns.person,
    copy.columns.hours,
    copy.columns.on,
    copy.columns.name,
    copy.columns.countsForDeal,
    copy.columns.categoryOrWorkType,
    copy.columns.activity,
    copy.columns.note,
  ]
  header.font = { bold: true }

  items.forEach((entry, index) => {
    const row = sheet.getRow(index + 2)
    row.getCell(1).value = dayCell(entry.day)
    row.getCell(1).numFmt = DATE_FORMAT
    row.getCell(2).value = personOf(entry.person, copy)
    row.getCell(3).value = hoursOf(entry.minutes)
    row.getCell(3).numFmt = HOURS_FORMAT
    row.getCell(4).value = copy.on[entry.on.type]
    row.getCell(5).value = nameCell(entry.on, copy)
    row.getCell(6).value = countsForDealCell(entry.on, copy)
    row.getCell(7).value = categoryOrWorkTypeCell(entry)
    row.getCell(8).value = activityCell(entry.activity, copy)
    // The full note; a break inside it shows as one (the cell wraps).
    if (entry.note !== null && entry.note !== '') {
      row.getCell(9).value = entry.note
      row.getCell(9).alignment = { wrapText: true, vertical: 'top' }
    }
  })

  WIDTHS.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width
  })
  sheet.views = [{ state: 'frozen', ySplit: 1 }]

  return workbook
}
