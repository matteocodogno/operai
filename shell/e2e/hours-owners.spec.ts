/**
 * T36 — Booking checked by the real owners, a meeting's hours under its deal, the export summed by deal
 * (specs/20261112-time-tracking: AC-2.2, AC-2.3, AC-2.6, AC-4.6; also AC-4.5, AC-4.9 and AC-4.11's "route up" half).
 *
 * Nothing is stubbed: hours-api asks projects-api, crm-api and meetings-api as the caller, and reads a meeting's
 * deal from meetings-api's `GET /system/meetings/hosts` with its own service credential (helpers/hoursOwnersFixtures
 * builds the real records). Needs the stack up (`mise run dev`) with auth's `SERVICE_CLIENTS` entry `hours-api`
 * (scope `meetings.hosts.read`) and `SERVICE_AUDIENCE` on meetings-api and hours-api, otherwise a meeting's deal
 * reads as unavailable and the meeting journey cannot pass. How to point Playwright at the dev stack: see the
 * header of hours.spec.ts.
 *
 *  1. A project team member records on the project; a salesperson who can SEE the project but is not on it picks it
 *     and gets the `not_on_project` message on the picker, and nothing is saved (AC-2.2).
 *  2. A deal's owner records on the deal; a CRM reader who is not involved gets the `not_involved_in_deal` message
 *     (AC-2.3).
 *  3. An entry on a meeting linked to a CRM deal is counted under that deal with Group by Deal (AC-2.6, AC-4.5).
 *  4. The downloaded export, its Hours summed by Counts for deal, equals the Group by Deal rows on screen (AC-4.6).
 *  5. Everyone's hours as an admin, filtered to the deal: the meeting's hours are in the list, the totals and the
 *     export (AC-4.11 with the system route up).
 *  6. A person involved only through an activity of the deal (the assignee of one of its tasks) records on it
 *     (AC-2.3): crm-api does not name them, activities-api does.
 *  7. R2 early check (plan R2): over a recorded quarter (about 300 entries, 9 meetings linked to one deal) the p95 of
 *     a POST on a deal (as owner, and as task assignee), a month of everyone, a year by deal and a quarter walked
 *     and exported is logged; above 800 ms is reported, never failed.
 *
 * The people are per-run (`hrs-*@operai.test`, an admin included: auth rate-limits a person's name lookup per caller);
 * the entries and the meetings a journey makes are deleted at the end. Companies, deals and projects cannot be
 * deleted from here (the owners keep them, like the other specs).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  cleanupPeople,
  createEntryViaApi,
  deleteOwnEntriesQuietly,
  hoursAdmin,
  hoursCall,
  minutesOfShort,
  monthOf,
  newRunId,
  ownEntriesViaApi,
  personContext,
  pickCategories,
  seedHoursPerson,
  todayZurich,
  type HoursPerson,
} from './helpers/hoursFixtures'
import {
  createCompanyViaApi,
  createDealOwnedBy,
  createMeetingViaApi,
  createProjectViaApi,
  createTaskViaApi,
  deleteMeetingQuietly,
  measure,
  minutesByDeal,
  readHoursExport,
  setTeamViaApi,
  walkAllEntries,
  type CompanyRow,
  type DealRow,
  type Latency,
  type ProjectRow,
} from './helpers/hoursOwnersFixtures'
import type { SeededSession } from './helpers/adminSession'

const runId = newRunId()
const today = todayZurich()
const { from: monthStart, to: monthEnd } = monthOf(today)
const year = today.slice(0, 4)
const quarterFirstMonth = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1
const quarterStart = `${year}-${String(quarterFirstMonth).padStart(2, '0')}-01`
const quarterEnd = monthOf(`${year}-${String(quarterFirstMonth + 2).padStart(2, '0')}-01`).to

const NOT_ON_PROJECT = 'You are not the project manager or on the team of this project.'
const NOT_INVOLVED = 'You are not the owner or technical contact of this deal, and not on one of its activities.'
const NOT_ON_A_DEAL = 'Not on a deal'

const SALES = ['employee', 'sales']

/** Opens My hours and its entry dialog, with what the hours were on chosen and its record found by search. */
async function openDialogOn(
  page: Page,
  kind: 'project' | 'deal' | 'meeting',
  target: { id: string; text: string },
  minutes: number,
): Promise<Locator> {
  await page.goto('/hours')
  await expect(page.getByTestId('hours-my-page')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('hours-record').click()
  const dialog = page.getByRole('dialog', { name: 'Record hours' })
  await dialog.waitFor()
  // The Duration is typed (T45, D53): decimal hours read as the person would write them, 90 minutes as 1.5.
  await dialog.getByTestId('hours-entry-duration').fill(String(minutes / 60))
  await dialog.getByTestId(`hours-entry-on-${kind}`).check()
  // The picker searches the owner's own list as the person; the one record whose name holds the run id is picked.
  await dialog.getByTestId(`hours-entry-${kind}-input`).fill(target.text)
  await page.getByTestId(`hours-entry-${kind}-input-option-${target.id}`).click()
  return dialog
}

/** Records on a project, deal or meeting through the dialog and waits for the saved confirmation. */
async function recordOn(
  page: Page,
  kind: 'project' | 'deal' | 'meeting',
  target: { id: string; text: string },
  minutes: number,
): Promise<void> {
  const dialog = await openDialogOn(page, kind, target, minutes)
  await dialog.getByTestId('hours-entry-dialog-submit').click()
  await dialog.waitFor({ state: 'detached' })
  await expect(page.getByTestId('hours-entry-saved')).toContainText('Entry saved.')
}

/** The totals table as rows: the group's name and its minutes, as the screen words them. */
async function totalsOnScreen(page: Page): Promise<Map<string, number>> {
  const rows = page.getByTestId('hours-totals-table').locator('tbody tr')
  const shown = new Map<string, number>()
  for (const row of await rows.all()) {
    const cells = row.getByRole('cell')
    const header = row.getByRole('rowheader')
    const name = (await header.count()) > 0 ? await header.innerText() : await cells.first().innerText()
    shown.set(name.trim(), minutesOfShort(await cells.last().innerText()))
  }
  return shown
}

test.describe('specs/20261112-time-tracking T36: booking checked by the real owners', () => {
  test.describe.configure({ mode: 'serial' })

  let admin: SeededSession
  let member: HoursPerson
  let outsider: HoursPerson
  let owner: HoursPerson
  let project: ProjectRow
  let deal: DealRow
  let company: CompanyRow
  let secondDeal: DealRow
  let meeting: { id: string; title: string }
  let trainingId: string
  // Meetings the R2 check adds to give the deal grouping something to ask meetings-api about; removed with the rest.
  const extraMeetings: { by: HoursPerson; id: string }[] = []
  // People the R2 check adds (auth rate-limits a name lookup per caller, so one person cannot record the whole dataset).
  const bulkPeople: HoursPerson[] = []

  test.beforeAll(async () => {
    admin = await hoursAdmin(runId)
    member = await seedHoursPerson('member', SALES, runId)
    outsider = await seedHoursPerson('outsider', SALES, runId)
    owner = await seedHoursPerson('owner', SALES, runId)
    trainingId = (await pickCategories(admin))[0].id

    // The real records, in their real owners: a project with a team, two deals owned by the owner, and a
    // meeting the owner made and linked to the first deal.
    company = await createCompanyViaApi(admin, `Hours QE company ${runId}`)
    const made = await createProjectViaApi(admin, `Hours QE project ${runId}`)
    project = await setTeamViaApi(admin, made, [member.userId])
    deal = await createDealOwnedBy(admin, company.id, `Hours QE deal ${runId}`, owner.userId)
    secondDeal = await createDealOwnedBy(admin, company.id, `Hours QE second deal ${runId}`, owner.userId)
    meeting = await createMeetingViaApi(owner, {
      title: `Hours QE meeting ${runId}`,
      source: 'text',
      host: { app: 'crm', entityType: 'deal', entityId: deal.id },
    })
  })

  test.afterAll(async () => {
    // From the quarter's start: the R2 check records across the quarter (and removes its own, this is the safety net).
    for (const person of [member, outsider, owner, ...bulkPeople]) await deleteOwnEntriesQuietly(person, quarterStart)
    for (const { by, id } of extraMeetings) await deleteMeetingQuietly(by, id)
    if (meeting) await deleteMeetingQuietly(owner, meeting.id)
    await cleanupPeople(runId)
  })

  test('a project team member records on the project; a non-member picking it gets the not_on_project message on the picker (AC-2.2)', async ({
    browser,
  }) => {
    const target = { id: project.id, text: project.name }

    const memberCtx = await personContext(browser, member)
    const memberPage = await memberCtx.newPage()
    await recordOn(memberPage, 'project', target, 150)
    // The entry is on the screen, named for its project and its duration, in the day list.
    const row = memberPage.getByTestId(`hours-day-${today}`)
    await expect(row).toContainText(project.name, { timeout: 30_000 })
    await expect(memberPage.getByTestId(`hours-day-total-${today}`)).toContainText('2 h 30')
    // Out of band, as the member: one entry, on that project (the owner said yes).
    const mine = await ownEntriesViaApi(member, monthStart, monthEnd)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.minutes).toBe(150)
    expect(mine[0]!.on).toMatchObject({ type: 'project', id: project.id })
    await memberCtx.close()

    // A salesperson who can open the project (reads are open to every projects:access holder) but is not on it:
    // the picker offers it, hours-api asks projects-api as the caller and refuses.
    const outsiderCtx = await personContext(browser, outsider)
    const page = await outsiderCtx.newPage()
    const dialog = await openDialogOn(page, 'project', target, 90)
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await expect(dialog.getByTestId('hours-entry-project')).toContainText(NOT_ON_PROJECT, { timeout: 20_000 })
    // Nothing was saved: the dialog is still open with what the person chose, and the API holds nothing.
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('hours-entry-project-input')).toHaveValue(project.name)
    expect(await ownEntriesViaApi(outsider, monthStart, monthEnd)).toHaveLength(0)
    await outsiderCtx.close()
  })

  test("a deal's owner records on the deal; a CRM reader who is not involved gets the not_involved_in_deal message (AC-2.3)", async ({
    browser,
  }) => {
    const target = { id: deal.id, text: deal.title }

    const ownerCtx = await personContext(browser, owner)
    const ownerPage = await ownerCtx.newPage()
    await recordOn(ownerPage, 'deal', target, 120)
    await expect(ownerPage.getByTestId(`hours-day-${today}`)).toContainText(deal.title, { timeout: 30_000 })
    const mine = await ownEntriesViaApi(owner, monthStart, monthEnd)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.on).toMatchObject({ type: 'deal', id: deal.id })
    await ownerCtx.close()

    const outsiderCtx = await personContext(browser, outsider)
    const page = await outsiderCtx.newPage()
    const dialog = await openDialogOn(page, 'deal', target, 90)
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await expect(dialog.getByTestId('hours-entry-deal')).toContainText(NOT_INVOLVED, { timeout: 20_000 })
    await expect(dialog).toBeVisible()
    expect(await ownEntriesViaApi(outsider, monthStart, monthEnd)).toHaveLength(0)
    await outsiderCtx.close()
  })

  test('an entry on a meeting linked to a CRM deal is counted under that deal with Group by Deal (AC-2.6, AC-4.5)', async ({
    browser,
  }) => {
    const ownerCtx = await personContext(browser, owner)
    const page = await ownerCtx.newPage()
    // The meeting is the owner's own (created, so bookable); its hour and a half is recorded in the dialog.
    await recordOn(page, 'meeting', { id: meeting.id, text: meeting.title }, 90)

    // Two more entries, so the grouping has more than one deal and hours that count for none: an hour on the
    // second deal and an hour of Other work (recorded through the API: the journey is about the grouping).
    await createEntryViaApi(owner, { day: today, minutes: 60, on: { type: 'deal', id: secondDeal.id } })
    await createEntryViaApi(owner, { day: today, minutes: 60, on: { type: 'none', categoryId: trainingId } })

    await page.goto('/hours')
    await expect(page.getByTestId(`hours-day-total-${today}`)).toContainText('5 h 30', { timeout: 30_000 })
    // The meeting's row says which deal its hours count for.
    await expect(page.getByTestId(`hours-day-${today}`)).toContainText(`Counts for deal ${deal.title}`)

    await page.getByTestId('hours-totals-group').selectOption('deal')
    await expect(page.getByTestId('hours-totals-table')).toContainText(deal.title, { timeout: 30_000 })
    const shown = await totalsOnScreen(page)
    // The deal holds its own 2 h AND the meeting's 1 h 30 (3 h 30); the other deal its hour; the Other work no deal.
    expect(shown.get(deal.title), 'the meeting counts under its deal').toBe(210)
    expect(shown.get(secondDeal.title)).toBe(60)
    expect(shown.get(NOT_ON_A_DEAL)).toBe(60)
    expect([...shown.values()].reduce((sum, minutes) => sum + minutes, 0)).toBe(330)
    await expect(page.getByTestId('hours-totals-total')).toContainText('5 h 30')
    // The meeting is not a row of its own under "Deal": a meeting is counted where its deal is.
    expect(shown.has(meeting.title)).toBe(false)

    // The server's own answer agrees (out of band, as the person).
    const totals = await hoursCall<{ totalMinutes: number; groups: { kind: string; key?: string; minutes: number }[] }>(
      owner,
      'GET',
      `/time-entries/totals?groupBy=deal&whose=mine&from=${monthStart}&to=${monthEnd}`,
    )
    expect(totals.status).toBe(200)
    expect(totals.body.groups.find((group) => group.key === deal.id)?.minutes).toBe(210)
    expect(totals.body.groups.reduce((sum, group) => sum + group.minutes, 0)).toBe(totals.body.totalMinutes)
    await ownerCtx.close()
  })

  test('the downloaded export, summed by its Counts for deal column, equals the Group by Deal rows on screen (AC-4.6, AC-4.9)', async ({
    browser,
  }) => {
    const ownerCtx = await personContext(browser, owner)
    const page = await ownerCtx.newPage()
    await page.goto('/hours')
    await expect(page.getByTestId(`hours-day-total-${today}`)).toContainText('5 h 30', { timeout: 30_000 })
    await page.getByTestId('hours-totals-group').selectOption('deal')
    await expect(page.getByTestId('hours-totals-table')).toContainText(deal.title, { timeout: 30_000 })
    const onScreen = await totalsOnScreen(page)

    const download = page.waitForEvent('download')
    await page.getByTestId('hours-export').click()
    const file = await download
    // Named from the period, never from a person (design F5).
    expect(file.suggestedFilename()).toMatch(/^hours-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/)
    await expect(page.getByTestId('hours-export-status')).toContainText('File ready')
    const saved = path.join(mkdtempSync(path.join(tmpdir(), 'hours-e2e-')), 'hours.xlsx')
    await file.saveAs(saved)
    const sheet = await readHoursExport(saved)

    // The nine columns, one row per entry (four), the Hours a NUMBER of hours (AC-4.9: "2 h 30" is the screen's).
    expect(sheet.header).toEqual([
      'Day',
      'Person',
      'Hours',
      'On',
      'Name',
      'Counts for deal',
      'Category or work type',
      'Activity',
      'Note',
    ])
    expect(sheet.rows).toHaveLength(4)
    for (const row of sheet.rows) {
      expect(typeof row.hours).toBe('number')
      expect(row.person).toBe(owner.name)
    }
    expect(sheet.rows.map((row) => row.hours).sort()).toEqual([1, 1, 1.5, 2])

    // Summed by "Counts for deal" the file says what the screen says, row for row: the meeting's hours sit
    // under its deal in the file too, and the hours that count for no deal have an empty cell.
    const inFile = minutesByDeal(sheet)
    const meetingRow = sheet.rows.find((row) => row.on === 'Meeting')
    expect(meetingRow, 'the meeting is a row of the file').toBeDefined()
    expect(meetingRow!.name).toBe(meeting.title)
    expect(meetingRow!.countsForDeal).toBe(deal.title)
    const expected = new Map(
      [...onScreen].map(([label, minutes]): [string, number] => [label === NOT_ON_A_DEAL ? '' : label, minutes]),
    )
    expect(Object.fromEntries(inFile)).toEqual(Object.fromEntries(expected))
    expect(inFile.get(deal.title)).toBe(210)
    await ownerCtx.close()
  })

  test("Everyone's hours as an admin, filtered to the deal: the meeting's hours are in the list, the totals and the export (AC-4.11 route up, AC-4.6)", async ({
    browser,
  }) => {
    const adminCtx = await personContext(browser, admin)
    const page = await adminCtx.newPage()
    await page.goto('/hours/all')
    await expect(page.getByTestId('hours-entries-table')).toBeVisible({ timeout: 30_000 })

    // The deal filter asks meetings-api (system route) which meetings are linked to the deal: up, so none is missed.
    await page.getByTestId('hours-filter-deal-input').fill(deal.title)
    await page.getByTestId(`hours-filter-deal-input-option-${deal.id}`).click()
    const table = page.getByTestId('hours-entries-table')
    await expect(table.getByRole('row').filter({ hasText: owner.name })).toHaveCount(2, { timeout: 30_000 })
    await expect(page.getByTestId('hours-banner-unavailable')).toHaveCount(0)
    await expect(page.getByTestId('hours-entries-error')).toHaveCount(0)
    // The meeting is the owner's, not the admin's: its title is withheld ("Not visible to you", AC-4.10), yet its
    // deal is named, because the admin may read the deal (the fact reaches a viewer with their own right to it).
    const meetingRow = table.getByRole('row').filter({ hasText: 'Meeting' }).filter({ hasText: owner.name })
    await expect(meetingRow).toContainText('Not visible to you')
    await expect(meetingRow).toContainText(`Counts for deal ${deal.title}`)
    await expect(table).not.toContainText(meeting.title)
    // The other deal's hour and the Other work are not on this deal.
    await expect(table).not.toContainText(secondDeal.title)

    await page.getByTestId('hours-totals-group').selectOption('deal')
    await expect(page.getByTestId('hours-totals-table')).toContainText(deal.title, { timeout: 30_000 })
    const onScreen = await totalsOnScreen(page)
    expect(Object.fromEntries(onScreen)).toEqual({ [deal.title]: 210 })

    const download = page.waitForEvent('download')
    await page.getByTestId('hours-export').click()
    const saved = path.join(mkdtempSync(path.join(tmpdir(), 'hours-e2e-')), 'everyone.xlsx')
    await (await download).saveAs(saved)
    const sheet = await readHoursExport(saved)
    expect(sheet.rows).toHaveLength(2)
    expect(Object.fromEntries(minutesByDeal(sheet))).toEqual({ [deal.title]: 210 })
    // The file carries only what the admin may read: the meeting's name is the placeholder, never the title.
    const inFileMeeting = sheet.rows.find((row) => row.on === 'Meeting')
    expect(inFileMeeting?.name).toBe('Not visible to you')
    expect(inFileMeeting?.countsForDeal).toBe(deal.title)
    expect(sheet.rows.map((row) => row.name)).not.toContain(meeting.title)
    await adminCtx.close()
  })

  test('a person involved only through an activity of the deal, its task assignee, records on it (AC-2.3)', async ({
    browser,
  }) => {
    // crm-api's own answer does not name this person (not the owner, not the technical contact); activities-api's
    // does: a task of the deal assigned to them. hours-api asks both as the caller, in that order.
    await createTaskViaApi(owner, {
      subject: `Hours QE task ${runId}`,
      companyId: company.id,
      dealId: deal.id,
      assigneeUserId: outsider.userId,
    })
    const ctx = await personContext(browser, outsider)
    const page = await ctx.newPage()
    await recordOn(page, 'deal', { id: deal.id, text: deal.title }, 60)
    await expect(page.getByTestId(`hours-day-${today}`)).toContainText(deal.title, { timeout: 30_000 })
    const mine = await ownEntriesViaApi(outsider, monthStart, monthEnd)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.on).toMatchObject({ type: 'deal', id: deal.id })
    await ctx.close()
  })

  test('R2 early check: the p95 of a POST on a deal, a month of everyone, a year by deal and a quarter exported (plan R2: above 800 ms is reported, not failed)', async ({
    browser,
  }) => {
    test.setTimeout(300_000)

    // The stack's own data is a handful of entries, which says nothing about a list, a total or an export, so a
    // realistic quarter is recorded first, spread over the quarter's days so far: 50 entries of the owner on the two
    // deals and 240 by eight other salespeople, each on a meeting of their own linked to the deal (what `groupBy=deal`
    // must ask meetings-api about). One person each, because auth rate-limits a person's name lookup (120 per 10
    // minutes) and a recording person is looked up on every write. All removed after.
    const quarterDays: string[] = []
    for (let day = new Date(`${quarterStart}T12:00:00Z`); day.toISOString().slice(0, 10) <= today; ) {
      quarterDays.push(day.toISOString().slice(0, 10))
      day = new Date(day.getTime() + 86_400_000)
    }
    const bulk: { by: HoursPerson; id: string }[] = []
    const record = async (who: HoursPerson, index: number, on: unknown): Promise<void> => {
      const entry = await createEntryViaApi(who, { day: quarterDays[index % quarterDays.length]!, minutes: 30, on })
      bulk.push({ by: who, id: entry.id })
    }
    try {
      for (let index = 0; index < 50; index += 1) {
        await record(owner, index, { type: 'deal', id: index % 2 === 0 ? deal.id : secondDeal.id })
      }
      for (let n = 0; n < 8; n += 1) {
        const person = await seedHoursPerson(`bulk-${String.fromCharCode(97 + n)}`, SALES, runId)
        bulkPeople.push(person)
        const linked = await createMeetingViaApi(person, {
          title: `Hours QE R2 meeting ${n} ${runId}`,
          source: 'text',
          host: { app: 'crm', entityType: 'deal', entityId: deal.id },
        })
        extraMeetings.push({ by: person, id: linked.id })
        for (let k = 0; k < 30; k += 1) await record(person, n * 30 + k, { type: 'meeting', id: linked.id })
      }

      // A POST on a deal as the OWNER (crm-api answers; no activities-api scan), then as someone involved only
      // through an activity (the heaviest path: crm-api, then activities-api's pages). Each entry is removed.
      const days = quarterDays.slice(-20)
      const posts: Latency[] = []
      const postOn = async (who: HoursPerson): Promise<void> => {
        let next = 0
        const made: string[] = []
        const label =
          who === owner
            ? 'POST /time-entries on a deal (owner)'
            : 'POST /time-entries on a deal (task assignee: crm-api, then activities-api)'
        const latency = await measure(label, days.length, async () => {
          const entry = await createEntryViaApi(who, {
            day: days[next++]!,
            minutes: 30,
            on: { type: 'deal', id: deal.id },
          })
          made.push(entry.id)
        })
        for (const id of made) await hoursCall(who, 'DELETE', `/time-entries/${encodeURIComponent(id)}`)
        posts.push(latency)
      }
      await postOn(owner)
      await postOn(outsider)

      const month = await measure(`GET /time-entries whose=all (${monthStart}..${monthEnd})`, 20, async () => {
        const result = await hoursCall<{ items: unknown[] }>(
          admin,
          'GET',
          `/time-entries?whose=all&from=${monthStart}&to=${monthEnd}&limit=100`,
        )
        expect(result.status).toBe(200)
        expect(result.body.items.length).toBeGreaterThan(0)
      })
      const yearByDeal = await measure(`GET /time-entries/totals groupBy=deal whose=all (${year})`, 20, async () => {
        const result = await hoursCall<{
          totalMinutes: number
          groups: { kind: string; key?: string }[]
          unavailable: string[]
        }>(admin, 'GET', `/time-entries/totals?groupBy=deal&whose=all&from=${year}-01-01&to=${year}-12-31`)
        expect(result.status).toBe(200)
        // A real answer, not a fast empty one: it counts what was recorded and the meetings' deals were read (the
        // system route answered, so no meeting fell into the "deal unknown" group).
        expect(result.body.totalMinutes).toBeGreaterThanOrEqual(bulk.length * 30)
        expect(result.body.unavailable).not.toContain('meeting-deals')
        expect(result.body.groups.some((group) => group.kind === 'deal-unknown')).toBe(false)
      })
      let walked = { entries: 0, pages: 0 }
      const quarter = await measure(
        `export walk, every page (limit 500) of whose=all (${quarterStart}..${quarterEnd})`,
        10,
        async () => {
          walked = await walkAllEntries(admin, quarterStart, quarterEnd)
        },
      )

      // The same quarter exported from the screen, click to file: every page read with the filters, then the workbook
      // built in the browser. Three exports, so its "p95" is the slowest of three.
      const adminCtx = await personContext(browser, admin)
      const adminPage = await adminCtx.newPage()
      await adminPage.goto(`/hours/all?period=custom&from=${quarterStart}&to=${quarterEnd}`)
      await expect(adminPage.getByTestId('hours-entries-table')).toBeVisible({ timeout: 30_000 })
      const exportQuarter = await measure(
        `export in the browser, click to file (Everyone's hours, ${quarterStart}..${quarterEnd})`,
        3,
        async () => {
          const download = adminPage.waitForEvent('download')
          await adminPage.getByTestId('hours-export').click()
          await download
          await expect(adminPage.getByTestId('hours-export-status')).toContainText('File ready')
        },
      )
      await adminCtx.close()

      const rows: Latency[] = [...posts, month, yearByDeal, quarter, exportQuarter]
      const note = `dataset: the quarter holds ${walked.entries} entries (${walked.pages} page(s) of 500), 9 meetings linked to one deal`
      console.log(
        [
          'R2 early check (plan R2, threshold 800 ms, reported not failed)',
          ...rows.map(
            (row) =>
              `${row.label}: n=${row.samples} p50=${row.p50.toFixed(0)} ms p95=${row.p95.toFixed(0)} ms max=${row.max.toFixed(0)} ms`,
          ),
          note,
        ].join('\n  '),
      )
      for (const row of rows) {
        test.info().annotations.push({
          type: row.p95 > 800 ? 'R2 ABOVE 800 ms' : 'R2',
          description: `${row.label}: p95 ${row.p95.toFixed(0)} ms (n=${row.samples}); ${note}`,
        })
      }
      // The hard assertions: the calls worked (each `measure` task asserted its answer) and the walk saw what was
      // recorded. The 800 ms threshold is reported to the main loop, never a failure.
      expect(walked.entries).toBeGreaterThanOrEqual(bulk.length)
    } finally {
      for (const { by, id } of bulk) await hoursCall(by, 'DELETE', `/time-entries/${encodeURIComponent(id)}`)
    }
  })
})
