/**
 * Test-only fixture bridge for specs/20261112-time-tracking T36 (booking checked by the real owners).
 *
 * hours-api never decides from a copy who may record on what: it asks the OWNER as the caller, with the person's
 * own JWT (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route): projects-api for a project's
 * `assignees`, crm-api for a deal's `involved`, meetings-api for the caller's own meetings, and meetings-api's
 * `GET /system/meetings/hosts` (its own credential) for the deal a meeting is linked to. So this journey builds
 * REAL records in those owners, through their REST APIs as real, seeded people, and nothing is stubbed:
 *
 *   project P   made by an admin (project:manage everywhere), team = [member]
 *   deal D, D2  made by an admin with `ownerUserId` = the owner (a salesperson, crm:access)
 *   meeting M   made by the owner (a text meeting: no audio, no consent) and linked to D (host crm/deal)
 *
 * People are `employee` + `sales` (projects:access to read every project, crm:access to read every deal,
 * meetings:access by the baseline employee grant). A salesperson on the project's team or owning the deal may
 * record on it; a salesperson who is neither can SEE it in the picker (reads are open) and is refused by hours-api,
 * which is exactly the refusal under test.
 *
 * The export is read with exceljs, resolved from hours-ui's own devDependency (the same library that built the
 * file, so the shell needs no spreadsheet dependency); the file is read as a person would open it: header row,
 * then one row per entry.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SeededSession } from './adminSession'
import { apiCall, CRM_API_URL, PROJECTS_API_URL, type ProjectRow } from './activitiesFixtures'
import { hoursCall, HOURS_API_URL, minutesOfShort, type ApiResult } from './hoursFixtures'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export { createCompanyViaApi, createProjectViaApi, createTaskViaApi, setTeamViaApi } from './activitiesFixtures'
export type { CompanyRow, ProjectRow } from './activitiesFixtures'
export { createMeetingViaApi, deleteMeetingQuietly } from './meetingsFixtures'
export { minutesOfShort }

type Json = Record<string, unknown>

// ─── CRM: a deal with a chosen owner ────────────────────────────────────────

export interface DealRow {
  id: string
  title: string
}

/**
 * A deal on `welld_ch` owned by `ownerUserId` (the owner is checked by crm-api as a CRM user). Made by an admin,
 * who holds `deal:manage` everywhere; the owner is the person who may then record hours on it.
 */
export async function createDealOwnedBy(
  admin: SeededSession,
  companyId: string,
  title: string,
  ownerUserId: string,
): Promise<DealRow> {
  const result = await apiCall<DealRow & Json>(CRM_API_URL, admin, 'POST', '/deals', {
    companyId,
    title,
    currency: 'CHF',
    entity: 'welld_ch',
    ownerUserId,
  })
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(
      `[hoursOwnersFixtures] POST ${CRM_API_URL}/deals -> ${result.status}: ${JSON.stringify(result.body).slice(0, 400)}`,
    )
  }
  return result.body
}

// ─── Projects: a maintenance project with a yearly hour package (specs/20261112-project-hours T18) ──

/**
 * A `maintenance` project on `welld_ch` for `companyId`, managed by `projectManagerId` and made, in the same statement, with
 * terms that carry ONE yearly hour package of `hours` hours from `startDate` (the nested `POST /projects` shape of
 * projects-api, specs/20261103-projects-handoff AC-5.3). Made by an admin (`project:manage` everywhere); the project manager
 * is the person hours-api's resolve names as `projectManagerId` and who may record on it.
 */
export async function createYearlyPackageProjectViaApi(
  admin: SeededSession,
  input: { name: string; companyId: string; projectManagerId: string; hours: number; startDate: string },
): Promise<ProjectRow> {
  const result = await apiCall<ProjectRow & Json>(PROJECTS_API_URL, admin, 'POST', '/projects', {
    name: input.name,
    type: 'maintenance',
    entity: 'welld_ch',
    companyId: input.companyId,
    projectManagerId: input.projectManagerId,
    terms: {
      startDate: input.startDate,
      terms: { hourPackage: { hours: input.hours, kind: 'yearly', startDate: input.startDate } },
    },
  })
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(
      `[hoursOwnersFixtures] POST ${PROJECTS_API_URL}/projects -> ${result.status}: ${JSON.stringify(result.body).slice(0, 400)}`,
    )
  }
  return result.body
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** The first day of the month that is `months` months from the month of `day` (a `YYYY-MM-DD`; negative = earlier). */
export function firstOfMonthShifted(day: string, months: number): string {
  const [year, month] = day.split('-').map(Number) as [number, number]
  const index = year * 12 + (month - 1) + months
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}-01`
}

/** `day` moved by `days` calendar days (UTC arithmetic on a date-only string, so no clock or zone is involved). */
export function addDaysTo(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * The days a yearly package is set up and expected from, worked out HERE from the spec's rule and not read back from
 * projects-api (AC-1.1, AC-1.2: each 12 months from the start date is a period of its own, the current one is the one holding
 * today), so the screen is checked against an independent oracle. The package starts on the first day of the month fourteen
 * months before today's: today is then two months into the SECOND period, so a day of the first period exists that must not
 * count, and the first day of the current period (on or before today, never in the future) is a day to record on.
 */
export function yearlyPackageAround(today: string): {
  start: string
  /** A day of the first period: its hours are in the project's total and in no period's figure. */
  earlierPeriodDay: string
  /** The current period, both days included. */
  period: { from: string; to: string }
} {
  const start = firstOfMonthShifted(today, -14)
  return {
    start,
    earlierPeriodDay: addDaysTo(start, 9),
    period: { from: firstOfMonthShifted(start, 12), to: addDaysTo(firstOfMonthShifted(start, 24), -1) },
  }
}

// ─── hours-api: a record's summary ──────────────────────────────────────────

/** One group of `GET /time-entries/summary` (`byWorkType`, `byPerson`): the server's own figure, never summed here. */
export interface SummaryGroup {
  kind: string
  key?: string
  label?: string | null
  minutes: number
}

export interface SummaryBody {
  on: { type: string; id: string }
  totalMinutes: number
  windowMinutes: number | null
  byWorkType: SummaryGroup[]
  byPerson: SummaryGroup[] | null
  unavailable: string[]
}

/** The summary of a project as `session` reads it (out-of-band verification of what the screen shows). */
export const projectSummaryViaApi = (
  session: SeededSession,
  projectId: string,
  window?: { from: string; to: string },
): Promise<ApiResult<SummaryBody>> =>
  hoursCall<SummaryBody>(
    session,
    'GET',
    `/time-entries/summary?projectId=${encodeURIComponent(projectId)}${
      window ? `&windowFrom=${window.from}&windowTo=${window.to}` : ''
    }`,
  )

// ─── The export file ────────────────────────────────────────────────────────

/**
 * The ten columns of the file, in order, as the spreadsheet has them (specs/20261112-time-tracking plan § Export file, widened by
 * specs/20261112-project-hours AC-4.6: Counts for project is the 7th, right after Counts for deal).
 */
export interface ExportRow {
  day: unknown
  person: string
  /** A NUMBER of hours (`minutes / 60`), never the screen's "2 h 30" (AC-4.9, D39). */
  hours: unknown
  on: string
  name: string
  countsForDeal: string
  countsForProject: string
  categoryOrWorkType: string
  activity: string
  note: string
}

export interface ExportSheet {
  header: string[]
  rows: ExportRow[]
}

interface ExcelCell {
  value: unknown
}
interface ExcelRow {
  getCell: (index: number) => ExcelCell
}
interface ExcelSheet {
  rowCount: number
  getRow: (index: number) => ExcelRow
}
interface ExcelWorkbook {
  xlsx: { readFile: (file: string) => Promise<unknown> }
  worksheets: ExcelSheet[]
}

/** An empty cell is '' (a number stays a number): what a person sees in a spreadsheet program. */
const textOf = (cell: ExcelCell): string => {
  const value = cell.value
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return String(value)
}

/** Reads the downloaded XLSX: its first sheet's header and one object per entry row. */
export async function readHoursExport(file: string): Promise<ExportSheet> {
  const require = createRequire(path.resolve(__dirname, '../../../hours-ui/package.json'))
  const ExcelJS = require('exceljs') as { Workbook: new () => ExcelWorkbook }
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('[hoursOwnersFixtures] the export has no sheet')
  const cellsOf = (index: number): ExcelCell[] =>
    Array.from({ length: 10 }, (_, column) => sheet.getRow(index).getCell(column + 1))
  const header = cellsOf(1).map(textOf)
  const rows: ExportRow[] = []
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const [day, person, hours, on, name, countsForDeal, countsForProject, categoryOrWorkType, activity, note] = cellsOf(index)
    rows.push({
      day: day!.value,
      person: textOf(person!),
      hours: hours!.value,
      on: textOf(on!),
      name: textOf(name!),
      countsForDeal: textOf(countsForDeal!),
      countsForProject: textOf(countsForProject!),
      categoryOrWorkType: textOf(categoryOrWorkType!),
      activity: textOf(activity!),
      note: textOf(note!),
    })
  }
  return { header, rows }
}

/**
 * The export's hours summed by its "Counts for deal" column, in minutes: the deal's name (an entry on a deal, or on a
 * meeting linked to it) or '' for hours that count for no deal. `Math.round` only undoes `minutes / 60`: every
 * entry is a whole number of minutes.
 */
export function minutesByDeal(sheet: ExportSheet): Map<string, number> {
  const sums = new Map<string, number>()
  for (const row of sheet.rows) {
    if (typeof row.hours !== 'number') {
      throw new Error(`[hoursOwnersFixtures] an Hours cell is not a number: ${JSON.stringify(row.hours)}`)
    }
    sums.set(row.countsForDeal, (sums.get(row.countsForDeal) ?? 0) + Math.round(row.hours * 60))
  }
  return sums
}

// ─── R2 early check: latency of the heaviest reads ──────────────────────────

/** The p95 of `samples` (nearest rank): the value 95% of them are at or under. */
export const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!
}

export interface Latency {
  label: string
  samples: number
  p50: number
  p95: number
  max: number
}

/** Runs `task` `count` times and reports its latency in ms (`task` throws on any answer that is not what it asked for). */
export async function measure(label: string, count: number, task: () => Promise<void>): Promise<Latency> {
  const taken: number[] = []
  for (let index = 0; index < count; index += 1) {
    const started = performance.now()
    await task()
    taken.push(performance.now() - started)
  }
  const sorted = [...taken].sort((a, b) => a - b)
  return {
    label,
    samples: count,
    p50: sorted[Math.floor(sorted.length / 2)]!,
    p95: p95(taken),
    max: sorted[sorted.length - 1]!,
  }
}

/** Every page of `GET /time-entries` for a span as one walk, the way hours-ui's export reads it (`limit=500`). */
export async function walkAllEntries(
  session: SeededSession,
  from: string,
  to: string,
): Promise<{ entries: number; pages: number }> {
  let entries = 0
  let pages = 0
  let cursor: string | null = null
  do {
    const query: string = `/time-entries?whose=all&from=${from}&to=${to}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const page: ApiResult<{ items: unknown[]; nextCursor: string | null }> = await hoursCall(session, 'GET', query)
    if (page.status !== 200) throw new Error(`[hoursOwnersFixtures] GET ${HOURS_API_URL}${query} -> ${page.status}`)
    entries += page.body.items.length
    pages += 1
    cursor = page.body.nextCursor
  } while (cursor)
  return { entries, pages }
}
