/**
 * T18 — Project hours: what a project's terms sold, set against the hours recorded on it, and who sees whose hours
 * (specs/20261112-project-hours: AC-1.1, AC-1.2, AC-1.8, AC-2.1, AC-2.3, AC-2.5, AC-2.8, AC-4.1, AC-4.3, AC-4.4).
 *
 * Nothing is stubbed. The project page is projects-ui, its ONE "Hours" card holds projects-ui's consumption block and
 * hours-ui's `./HostHours` panel (loaded through the shell's `hours.hostHours` extension); both read hours-api's
 * `GET /time-entries/summary`, which asks projects-api (the project's manager and who may read it) and meetings-api (the
 * meetings linked to the project, with hours-api's own service credential) live. The records are made through their owners'
 * REST APIs by an admin, exactly as hours-owners.spec.ts and hours-in-place.spec.ts do (helpers/hoursOwnersFixtures.ts):
 *
 *   company C, project P  maintenance, yearly hour package of 100 h, project manager = PM, NO team (made by the admin)
 *   package               starts the first of the month fourteen months back, so today is two months into the SECOND period
 *                         (helpers/hoursOwnersFixtures `yearlyPackageAround`, worked out from the spec's rule, not read back)
 *   hours                 PM: 2 h on a day of the FIRST period (a hour that counts for no period), 3 h with a work type on the
 *                         first day of the CURRENT period; READER (neither PM nor on the team) records 1 h 30 on a text meeting
 *                         linked to P, today (AC-4.1: a linked meeting counts whoever recorded it and whether or not they are
 *                         on the team), and 30 min of Other work (which counts for no project)
 *   total 6 h 30, used in the current period 4 h 30, left 95 h 30
 *
 *  A. The PM opens P: the Hours card shows the package, its current period, hours used and hours left, and the total recorded,
 *     all WITHOUT opening the breakdown, which is closed (AC-1.1, AC-1.2, AC-1.8, AC-2.1).
 *  B. The PM opens the breakdown (no new request is made) and sees By work type and By person, the READER, who is not on the
 *     project, among the people; another `projects:access` reader on the same page sees the same figures and the work types
 *     but no By person, and no placeholder for it (AC-2.1, AC-2.3, AC-2.5, AC-4.1, AC-4.3).
 *  C. The PM records 1 h with Record hours on the page: the consumption block, the total and the PM's row grow by exactly
 *     1 h, and the page is not reloaded (AC-2.8).
 *  D. The READER's My hours (the List), filtered by P, lists the entry on the meeting linked to it, saying which project it
 *     counts for, and not their Other work (AC-4.4).
 *
 * Needs the stack up (`mise run dev`) with the specs/20261112-time-tracking and specs/20261112-meeting-hours wiring (see the
 * headers of hours-owners.spec.ts and meeting-hours.spec.ts): `auth` with ENABLE_TEST_AUTH, projects-api, crm-api, meetings-api,
 * activities-api and hours-api, every database migrated, and `auth`'s SERVICE_CLIENTS entry `hours-api` (scope
 * `meetings.hosts.read`). Against the dev stack Playwright reuses the servers when each remote's port is pointed at it:
 *   E2E_ESTIMAI_REMOTE_PORT=5174 E2E_REFUND_REMOTE_PORT=5175 E2E_NOTIFY_REMOTE_PORT=5176 \
 *   E2E_ADMIN_REMOTE_PORT=5177 E2E_INVENTORY_REMOTE_PORT=5178 E2E_CRM_REMOTE_PORT=5179 \
 *   E2E_MEETINGS_REMOTE_PORT=5180 E2E_PROJECTS_REMOTE_PORT=5181 E2E_LETTERHEADS_REMOTE_PORT=5182 \
 *   E2E_ACCOUNTING_REMOTE_PORT=5183 E2E_HOURS_REMOTE_PORT=5184 \
 *   pnpm e2e project-hours.spec.ts
 * and, on a machine with no accounting-api (nothing here reads Accounting, the registry or an offer), add
 * `E2E_SKIP_ACCOUNTING_SEED=1 E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 E2E_SKIP_LEGAL_ENTITIES_SETUP=1`.
 *
 * The people are per-run (`php-*@operai.test`, an admin included); every entry they hold and the meeting are removed
 * afterwards (a person deletes their OWN entries only). The company and the project cannot be deleted from here (their owners
 * keep them, like the other specs).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  cleanupPeople,
  createEntryViaApi,
  deleteOwnEntriesQuietly,
  hoursAdmin,
  hoursCall,
  HOURS_API_URL,
  minutesOfShort,
  newRunId,
  ownEntriesViaApi,
  personContext,
  pickCategories,
  seedHoursPerson,
  timeListsViaApi,
  todayZurich,
  type CategoryRow,
  type HoursPerson,
} from './helpers/hoursFixtures'
import {
  addDaysTo,
  createCompanyViaApi,
  createMeetingViaApi,
  createYearlyPackageProjectViaApi,
  deleteMeetingQuietly,
  projectSummaryViaApi,
  yearlyPackageAround,
  type CompanyRow,
  type ProjectRow,
} from './helpers/hoursOwnersFixtures'
import { apiCall, PROJECTS_API_URL } from './helpers/activitiesFixtures'
import type { SeededSession } from './helpers/adminSession'

const runId = newRunId()
const today = todayZurich()
const PREFIX = 'php' as const
const SALES = ['employee', 'sales']

const PACKAGE_HOURS = 100
const { start: packageStart, earlierPeriodDay, period } = yearlyPackageAround(today)

/** `dd.mm.yyyy`, as the suite writes a date. */
const dmy = (iso: string): string => iso.split('-').reverse().join('.')

/** The minutes each journey's setup records (see the header): every figure on screen is derived from these, never typed twice. */
const MINUTES = {
  earlierPeriod: 120, // the PM, a day of the first period
  currentPeriod: 180, // the PM, the first day of the current period, with a work type
  meeting: 90, // the READER, on the linked meeting, today
  otherWork: 30, // the READER, other work, today: counts for no project
  recordedInC: 60, // the PM records this from the page in journey C
} as const

/** The short duration ("6 h 30", "95 h", "30 min") the screen writes for `minutes`, as operai-ui's formatDuration does in English. */
const short = (minutes: number): string => {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest}`
}

const WITHOUT_WORK_TYPE = 'Without a work type'
const SHOW_BREAKDOWN = 'Show breakdown'

// ─── Locators ───────────────────────────────────────────────────────────────

/** Opens a project's page as `page`'s person and waits for its header and its Hours card. */
async function openProject(page: Page, project: ProjectRow): Promise<void> {
  await page.goto(`/projects/${project.id}`)
  await expect(page.getByTestId('project-detail-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('project-hours')).toBeVisible({ timeout: 30_000 })
}

/** The value of one fact of the consumption block ("Hours left"), found by its term. */
const fact = (card: Locator, term: string): Locator =>
  card
    .getByTestId('project-hours-consumption-facts')
    .locator('div')
    .filter({ has: card.page().locator('dt', { hasText: new RegExp(`^${term}$`) }) })
    .locator('dd')

/** The short duration a fact or the total shows: the part drawn for the eye (the spoken form sits beside it, clipped). */
const drawnDuration = (value: Locator): Locator => value.locator('[aria-hidden="true"]').first()

/** The panel's total recorded. */
const totalOf = (card: Locator): Locator => drawnDuration(card.getByTestId('hours-host-hours-total').locator('dd'))

/** The panel's rows as the screen words them: a group's name and its minutes (the server's figure, read back through its text). */
async function groupsOnScreen(table: Locator): Promise<Record<string, number>> {
  const shown: Record<string, number> = {}
  for (const row of await table.locator('tbody tr').all()) {
    const name = (await row.getByRole('rowheader').innerText()).trim()
    shown[name] = minutesOfShort(await row.getByRole('cell').last().locator('[aria-hidden="true"]').first().innerText())
  }
  return shown
}

const toggleOf = (card: Locator): Locator => card.getByTestId('hours-host-hours-toggle')

/** Opens the panel's breakdown and waits until its work-type table is shown. */
async function openBreakdown(card: Locator): Promise<void> {
  await expect(toggleOf(card)).toHaveAttribute('aria-expanded', 'false')
  await toggleOf(card).click()
  await expect(toggleOf(card)).toHaveAttribute('aria-expanded', 'true')
  await expect(card.getByTestId('hours-host-hours-work-types')).toBeVisible()
}

const pageRecordHours = (page: Page): Locator => page.getByRole('button', { name: 'Record hours', exact: true })

test.describe('specs/20261112-project-hours T18: consumption, the breakdown by person, Record hours, linked meetings', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let admin: SeededSession
  let pm: HoursPerson // the project's manager (not on a team: there is none)
  let reader: HoursPerson // can read the project, is neither its manager nor on its team; created the linked meeting
  let company: CompanyRow
  let project: ProjectRow
  let meeting: { id: string; title: string }
  let workType: { id: string; name: string }
  let training: CategoryRow
  /** The entries `beforeAll` recorded, by id: the first period's is older than a read's span, so a sweep by day would miss it. */
  const recorded: { by: HoursPerson; id: string }[] = []

  const totalMinutes = MINUTES.earlierPeriod + MINUTES.currentPeriod + MINUTES.meeting
  const usedMinutes = MINUTES.currentPeriod + MINUTES.meeting

  test.beforeAll(async () => {
    admin = await hoursAdmin(runId, PREFIX)
    pm = await seedHoursPerson('pm', SALES, runId, PREFIX)
    reader = await seedHoursPerson('reader', SALES, runId, PREFIX)
    ;[training] = await pickCategories(admin)
    const lists = await timeListsViaApi(admin)
    const active = lists.workTypes.project.find((candidate) => !(candidate as { retired: boolean }).retired) as
      { id: string; name: string } | undefined
    expect(active, 'an active project work type to record with').toBeDefined()
    workType = active!

    // The real records, in their real owners: a maintenance project with a yearly package and a project manager, and a
    // text meeting (no audio, no consent) made by the reader and linked to the project.
    company = await createCompanyViaApi(admin, `Php company ${runId}`)
    project = await createYearlyPackageProjectViaApi(admin, {
      name: `Php project ${runId}`,
      companyId: company.id,
      projectManagerId: pm.userId,
      hours: PACKAGE_HOURS,
      startDate: packageStart,
    })
    meeting = await createMeetingViaApi(reader, {
      title: `Php meeting ${runId}`,
      source: 'text',
      host: { app: 'projects', entityType: 'project', entityId: project.id },
    })

    const record = async (by: HoursPerson, input: unknown): Promise<void> => {
      recorded.push({ by, id: (await createEntryViaApi(by, input)).id })
    }
    const onProject = { type: 'project', id: project.id }
    await record(pm, { day: earlierPeriodDay, minutes: MINUTES.earlierPeriod, on: onProject })
    await record(pm, { day: period.from, minutes: MINUTES.currentPeriod, on: onProject, workTypeId: workType.id })
    await record(reader, { day: today, minutes: MINUTES.meeting, on: { type: 'meeting', id: meeting.id } })
    await record(reader, { day: today, minutes: MINUTES.otherWork, on: { type: 'none', categoryId: training.id } })
  })

  test.afterAll(async () => {
    // What the journeys recorded (journey C) is in the current period, inside one read's span; the setup's entries go by id.
    for (const person of [pm, reader]) if (person) await deleteOwnEntriesQuietly(person, period.from)
    for (const { by, id } of recorded) await hoursCall(by, 'DELETE', `/time-entries/${encodeURIComponent(id)}`)
    if (meeting) await deleteMeetingQuietly(reader, meeting.id)
    await cleanupPeople(runId)
  })

  test('the setup is what the journeys assume: the server counts the linked meeting for the project and windows the period (AC-1.2, AC-4.1, AC-4.3)', async () => {
    // Out of band, as the PM: all time = the PM's two entries + the reader's meeting; the current period leaves the first one out.
    const summary = await projectSummaryViaApi(pm, project.id, period)
    expect(summary.status).toBe(200)
    expect(summary.body.totalMinutes).toBe(totalMinutes)
    expect(summary.body.windowMinutes).toBe(usedMinutes)
    expect(summary.body.unavailable).toEqual([])
    // The project page's own terms carry the period this spec worked out from the rule (the figures below depend on it).
    const projectView = await apiCall<{
      terms: { terms: { hourPackage: { currentPeriod: { from: string; to: string; ended: boolean } } } }
    }>(PROJECTS_API_URL, pm, 'GET', `/projects/${project.id}`)
    expect(projectView.status).toBe(200)
    expect(projectView.body.terms.terms.hourPackage.currentPeriod).toEqual({ ...period, ended: false })
  })

  test('A: a project with a yearly package and entries shows used and left without opening the breakdown (AC-1.1, AC-1.2, AC-1.8, AC-2.1)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, pm)
    const page = await ctx.newPage()
    await openProject(page, project)
    const card = page.getByTestId('project-hours')

    // The consumption block: the package, its current period (its own: the first period's hours are not in it), used and left.
    await expect(fact(card, 'Yearly package')).toBeVisible({ timeout: 30_000 })
    await expect(drawnDuration(fact(card, 'Yearly package'))).toHaveText(short(PACKAGE_HOURS * 60))
    await expect(fact(card, 'Current period')).toContainText(`${dmy(period.from)} – ${dmy(period.to)}`)
    await expect(drawnDuration(fact(card, 'Hours used in this period'))).toHaveText(short(usedMinutes))
    await expect(drawnDuration(fact(card, 'Hours left'))).toHaveText(short(PACKAGE_HOURS * 60 - usedMinutes))
    await expect(card.getByText('Hours left in a period do not carry over to the next one.')).toBeVisible()
    await expect(card.getByTestId('project-hours-consumption-expired')).toHaveCount(0)
    await expect(card.getByTestId('project-hours-consumption-unavailable')).toHaveCount(0)

    // The panel: the total recorded is ALL time (the first period's 2 h included), and the line says the meetings count in it.
    await expect(totalOf(card)).toHaveText(short(totalMinutes), { timeout: 30_000 })
    await expect(card.getByText('Includes the hours recorded on meetings linked to this project.')).toBeVisible()

    // The breakdown is closed: the button says so, the region is hidden and holds nothing a person could read yet.
    await expect(toggleOf(card)).toHaveText(SHOW_BREAKDOWN)
    await expect(toggleOf(card)).toHaveAttribute('aria-expanded', 'false')
    await expect(card.getByTestId('hours-host-hours-breakdown')).toBeHidden()
    await expect(card.getByTestId('hours-host-hours-work-types')).toBeHidden()
    await expect(card.getByTestId('hours-host-hours-people')).toBeHidden()

    // AC-1.8: no amount, price or rate anywhere in the card.
    expect(await card.innerText()).not.toMatch(/CHF|EUR|USD|€|\$|£/)
    await ctx.close()
  })

  test('B: the PM opens the breakdown and sees By person, with no new request; another projects:access reader does not (AC-2.1, AC-2.3, AC-2.5, AC-4.1, AC-4.3)', async ({
    browser,
  }) => {
    const pmCtx = await personContext(browser, pm)
    const page = await pmCtx.newPage()
    const summaryReads: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().startsWith(`${HOURS_API_URL}/time-entries/summary`)) {
        summaryReads.push(request.url())
      }
    })
    await openProject(page, project)
    const card = page.getByTestId('project-hours')
    await expect(totalOf(card)).toHaveText(short(totalMinutes), { timeout: 30_000 })
    await expect(fact(card, 'Hours left')).toBeVisible()
    // The instrument is proved before it is trusted: the page's own reads (the block's and the panel's) were seen by the listener.
    expect(summaryReads.length, 'the listener saw the page read the summary').toBeGreaterThan(0)
    const readsBefore = summaryReads.length

    await openBreakdown(card)
    // Opening is a disclosure, not a read: the one answer already carried both tables (a short grace for a request that would come).
    await page.waitForTimeout(1_000)
    expect(summaryReads.length, 'opening the breakdown made no request').toBe(readsBefore)

    // By work type: the work type the PM recorded with; every hour without one (the first period's, and the MEETING's) in one group.
    await expect(card.getByRole('heading', { name: 'By work type' })).toBeVisible()
    await expect(card.getByTestId('hours-host-hours-work-types').locator('tbody tr')).toHaveCount(2)
    expect(await groupsOnScreen(card.getByTestId('hours-host-hours-work-types'))).toEqual({
      [workType.name]: MINUTES.currentPeriod,
      [WITHOUT_WORK_TYPE]: MINUTES.earlierPeriod + MINUTES.meeting,
    })

    // By person (AC-2.3): the PM sees each person's hours, the reader's meeting hours among them although the reader is not on the project (A49).
    await expect(card.getByRole('heading', { name: 'By person' })).toBeVisible()
    await expect(card.getByTestId('hours-host-hours-people').locator('tbody tr')).toHaveCount(2)
    expect(await groupsOnScreen(card.getByTestId('hours-host-hours-people'))).toEqual({
      [pm.name]: MINUTES.earlierPeriod + MINUTES.currentPeriod,
      [reader.name]: MINUTES.meeting,
    })
    await expect(card.getByTestId('hours-host-hours-people-unavailable')).toHaveCount(0)
    await pmCtx.close()

    // Another person who can read the project: the same figures, the work types, and NO By person and no placeholder for it (AC-2.5).
    const readerCtx = await personContext(browser, reader)
    const readerPage = await readerCtx.newPage()
    await openProject(readerPage, project)
    const readerCard = readerPage.getByTestId('project-hours')
    await expect(drawnDuration(fact(readerCard, 'Hours used in this period'))).toHaveText(short(usedMinutes), {
      timeout: 30_000,
    })
    await expect(drawnDuration(fact(readerCard, 'Hours left'))).toHaveText(short(PACKAGE_HOURS * 60 - usedMinutes))
    await expect(totalOf(readerCard)).toHaveText(short(totalMinutes), { timeout: 30_000 })
    // The panel has answered (its total is on screen), so what is missing below is missing from the answer, not still on its way.
    await openBreakdown(readerCard)
    expect(await groupsOnScreen(readerCard.getByTestId('hours-host-hours-work-types'))).toEqual({
      [workType.name]: MINUTES.currentPeriod,
      [WITHOUT_WORK_TYPE]: MINUTES.earlierPeriod + MINUTES.meeting,
    })
    await expect(readerCard.getByRole('heading', { name: 'By person' })).toHaveCount(0)
    await expect(readerCard.getByTestId('hours-host-hours-people')).toHaveCount(0)
    await expect(readerCard.getByTestId('hours-host-hours-people-unavailable')).toHaveCount(0)
    // The server's own answer agrees: the PM gets the people, the reader gets none (not an empty list: no member at all).
    const asPm = await projectSummaryViaApi(pm, project.id)
    expect(asPm.body.byPerson?.map((group) => group.minutes).sort((a, b) => a - b)).toEqual(
      [MINUTES.meeting, MINUTES.earlierPeriod + MINUTES.currentPeriod].sort((a, b) => a - b),
    )
    const asReader = await projectSummaryViaApi(reader, project.id)
    expect(asReader.status).toBe(200)
    expect(asReader.body.byPerson).toBeNull()
    await readerCtx.close()
  })

  test('C: recording 1 h with Record hours on the page grows the card by 1 h without a reload (AC-2.8)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, pm)
    const page = await ctx.newPage()
    await openProject(page, project)
    const card = page.getByTestId('project-hours')
    await expect(totalOf(card)).toHaveText(short(totalMinutes), { timeout: 30_000 })
    await expect(drawnDuration(fact(card, 'Hours used in this period'))).toHaveText(short(usedMinutes))
    await openBreakdown(card)
    expect(await groupsOnScreen(card.getByTestId('hours-host-hours-people'))).toEqual({
      [pm.name]: MINUTES.earlierPeriod + MINUTES.currentPeriod,
      [reader.name]: MINUTES.meeting,
    })

    // The page is this document: a marker on `window` survives only while nothing reloads it.
    await page.evaluate(() => {
      ;(window as unknown as { __phSameDocument: boolean }).__phSameDocument = true
    })

    // The project manager is offered Record hours first in the page's header (hours-in-place AC-1.1); 1 h, today, no work type.
    const button = pageRecordHours(page)
    await expect(button).toBeVisible({ timeout: 30_000 })
    await button.click()
    const dialog = page.getByRole('dialog', { name: 'Record hours' })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByTestId('hours-entry-day')).toHaveValue(today)
    await dialog.getByTestId('hours-entry-duration').fill(String(MINUTES.recordedInC / 60))
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await dialog.waitFor({ state: 'detached', timeout: 30_000 })
    await expect(page.getByTestId('hours-record-hours-recorded')).toHaveText(
      `${short(MINUTES.recordedInC)} recorded on ${project.name}.`,
    )

    // The figures follow, with no reload: the block's used and left, the panel's total, the PM's row and the untyped group.
    const usedAfter = usedMinutes + MINUTES.recordedInC
    await expect(drawnDuration(fact(card, 'Hours used in this period'))).toHaveText(short(usedAfter), {
      timeout: 30_000,
    })
    await expect(drawnDuration(fact(card, 'Hours left'))).toHaveText(short(PACKAGE_HOURS * 60 - usedAfter))
    await expect(totalOf(card)).toHaveText(short(totalMinutes + MINUTES.recordedInC), { timeout: 30_000 })
    await expect
      .poll(() => groupsOnScreen(card.getByTestId('hours-host-hours-people')), { timeout: 30_000 })
      .toEqual({
        [pm.name]: MINUTES.earlierPeriod + MINUTES.currentPeriod + MINUTES.recordedInC,
        [reader.name]: MINUTES.meeting,
      })
    expect(await groupsOnScreen(card.getByTestId('hours-host-hours-work-types'))).toEqual({
      [workType.name]: MINUTES.currentPeriod,
      [WITHOUT_WORK_TYPE]: MINUTES.earlierPeriod + MINUTES.meeting + MINUTES.recordedInC,
    })
    // The breakdown stayed open and no failure replaced a figure while it was read again.
    await expect(toggleOf(card)).toHaveAttribute('aria-expanded', 'true')
    await expect(card.getByTestId('project-hours-consumption-unavailable')).toHaveCount(0)
    await expect(card.getByTestId('hours-host-hours-error')).toHaveCount(0)
    expect(
      await page.evaluate(() => (window as unknown as { __phSameDocument?: boolean }).__phSameDocument),
      'the page was not reloaded',
    ).toBe(true)

    // Out of band: the entry is the PM's, on the project, and the server's figures are the ones the page now shows.
    const mine = (await ownEntriesViaApi(pm, today, today)).filter((entry) => entry.day === today)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.minutes).toBe(MINUTES.recordedInC)
    expect(mine[0]!.on).toMatchObject({ type: 'project', id: project.id })
    const summary = await projectSummaryViaApi(pm, project.id, period)
    expect(summary.body.totalMinutes).toBe(totalMinutes + MINUTES.recordedInC)
    expect(summary.body.windowMinutes).toBe(usedAfter)
    await ctx.close()
  })

  test('D: My hours filtered by the project lists the entry on a meeting linked to it, and not other work (AC-4.4)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, reader)
    const page = await ctx.newPage()
    // The List (`?view=list`): My hours opens on the table view since specs/20261116-record-hours-in-place, and this journey reads
    // the List's day heading and its entries.
    await page.goto('/hours?view=list')
    await expect(page.getByTestId('hours-my-page')).toBeVisible({ timeout: 30_000 })
    const day = page.getByTestId(`hours-day-${today}`)
    // Unfiltered, both of the reader's entries are there: the filter below is what removes the second one.
    await expect(day).toContainText(meeting.title, { timeout: 30_000 })
    await expect(day).toContainText(training.name)
    await expect(page.getByTestId(`hours-day-total-${today}`)).toContainText(short(MINUTES.meeting + MINUTES.otherWork))

    await page.getByTestId('hours-filter-project-input').fill(project.name)
    await page.getByTestId(`hours-filter-project-input-option-${project.id}`).click()

    // The meeting's entry stays, with the project it counts for named on its row (AC-4.4, AC-4.7 for a project the reader may read) …
    await expect(day).not.toContainText(training.name, { timeout: 30_000 })
    await expect(day).toContainText(meeting.title)
    await expect(day).toContainText(`Counts for project ${project.name}`)
    await expect(page.getByTestId(`hours-day-total-${today}`)).toContainText(short(MINUTES.meeting))
    // … and Meetings could say which meetings are linked, so nothing is refused or partial.
    await expect(page.getByTestId('hours-banner-unavailable')).toHaveCount(0)
    await expect(page.getByTestId('hours-entries-error')).toHaveCount(0)

    // The server's own answer, out of band, as the reader: the one entry, on the meeting, which counts for the project.
    const listed = await hoursCall<{
      items: { minutes: number; on: { type: string; id: string; project: { state: string; id?: string } } }[]
      unavailable: string[]
    }>(
      reader,
      'GET',
      `/time-entries?whose=mine&projectId=${encodeURIComponent(project.id)}&from=${addDaysTo(today, -30)}&to=${today}`,
    )
    expect(listed.status).toBe(200)
    expect(listed.body.unavailable).toEqual([])
    expect(listed.body.items).toHaveLength(1)
    expect(listed.body.items[0]!.minutes).toBe(MINUTES.meeting)
    expect(listed.body.items[0]!.on).toMatchObject({
      type: 'meeting',
      id: meeting.id,
      project: { state: 'linked', id: project.id },
    })
    await ctx.close()
  })
})
