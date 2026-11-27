/**
 * T18, T25 — Project hours: what a project's terms sold, set against the hours recorded on it, the signals the block draws about
 * it, and who sees whose hours (specs/20261112-project-hours: AC-1.1, AC-1.2, AC-1.8, AC-2.1, AC-2.3, AC-2.5, AC-2.8, AC-4.1,
 * AC-4.3, AC-4.4 for journeys A–D; AC-5.1, AC-5.14–5.18, AC-5.21, AC-5.22, AC-5.26–5.28 for journeys E and F).
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
 *  E. (T25) On the same yearly package the block says the consumed percentage (4 h 30 of 100 h reads 4%), the state (on track)
 *     and a pace line whose time elapsed equals an oracle worked out HERE, by AC-5.20's rule, from the `asOf` and the
 *     `currentPeriod` projects-api sent with the very response the page drew; the bar is drawn where those figures put its
 *     parts; the PM and the other reader see the same signals and none names a person (AC-5.1, AC-5.14, AC-5.18, AC-5.27).
 *  C. The PM records 1 h with Record hours on the page: the consumption block, the total and the PM's row grow by exactly
 *     1 h, and the page is not reloaded (AC-2.8). (T25, E's second half) The percentage moves from 4% to 5% and the bar's fill
 *     grows; the time elapsed and the today mark stay where they were, which are the figures of the day the page read the
 *     project on (AC-5.28).
 *  D. The READER's My hours (the List), filtered by P, lists the entry on the meeting linked to it, saying which project it
 *     counts for, and not their Other work (AC-4.4).
 *  F. (T25) A hand-made, active fixed price (max effort 1.0 man-day, estimate 0.9, 9 h recorded; terms from 60 days before the
 *     Zurich day to the day before it; deadline 10 days after it) reads over the limit, 112%, 0.1 man-days over, an end-date
 *     line that has passed by a day and a deadline line that is near, every day count computed from the API's `asOf` and never
 *     the runner's clock (AC-5.9, AC-5.12, AC-5.17, AC-5.18, AC-5.21, AC-5.22). In the browser the computed styles that only the
 *     bar's own utilities give are read (the track row 10 px high, the beyond part's striped `background-image` and its
 *     `6px 100%` `background-size`, the estimate diamond 8 px wide with a ring): the shell's one Tailwind sheet must have
 *     generated them (plan R13, AC-5.15). Then the project is closed through the API and the page reloaded: no state and no date
 *     line, the percentage and the bar stay (AC-5.26).
 *
 * Needs the stack up (`mise run dev`) with the specs/20261112-time-tracking and specs/20261112-meeting-hours wiring (see the
 * headers of hours-owners.spec.ts and meeting-hours.spec.ts): `auth` with ENABLE_TEST_AUTH, projects-api (with `asOf`, T22),
 * crm-api, meetings-api, activities-api and hours-api, every database migrated, and `auth`'s SERVICE_CLIENTS entry `hours-api`
 * (scope `meetings.hosts.read`). Against the dev stack Playwright reuses the servers when each remote's port is pointed at it:
 *   E2E_ESTIMAI_REMOTE_PORT=5174 E2E_REFUND_REMOTE_PORT=5175 E2E_NOTIFY_REMOTE_PORT=5176 \
 *   E2E_ADMIN_REMOTE_PORT=5177 E2E_INVENTORY_REMOTE_PORT=5178 E2E_CRM_REMOTE_PORT=5179 \
 *   E2E_MEETINGS_REMOTE_PORT=5180 E2E_PROJECTS_REMOTE_PORT=5181 E2E_LETTERHEADS_REMOTE_PORT=5182 \
 *   E2E_ACCOUNTING_REMOTE_PORT=5183 E2E_HOURS_REMOTE_PORT=5184 \
 *   pnpm e2e project-hours.spec.ts
 * and, on a machine with no accounting-api (nothing here reads Accounting, the registry or an offer), add
 * `E2E_SKIP_ACCOUNTING_SEED=1 E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 E2E_SKIP_LEGAL_ENTITIES_SETUP=1`.
 *
 * Journey F's R13 reads are only as good as the shell the run reuses: `mise run dev`'s shell (vite dev) builds its sheet from the
 * same `@source`s a `build` does, so a utility the sheet does not generate fails there too; a run that lets Playwright build and
 * preview the shell reads the production sheet.
 *
 * The people are per-run (`php-*@operai.test`, an admin included); every entry they hold and the meeting are removed
 * afterwards (a person deletes their OWN entries only). The company and the projects cannot be deleted from here (their owners
 * keep them, like the other specs); the fixed price of journey F ends closed, and one a failed run left open is cancelled.
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
  createFixedPriceProjectViaApi,
  createMeetingViaApi,
  createYearlyPackageProjectViaApi,
  daysBetween,
  deleteMeetingQuietly,
  elapsedPercentOracle,
  projectSummaryViaApi,
  retireProjectQuietly,
  transitionProjectViaApi,
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

// ─── The signals (T25, journeys E and F) ────────────────────────────────────

/** The terms of a project as projects-api answered the page's own read: what the page drew its signals from. */
interface TermsRead {
  startDate: string
  endDate: string | null
  /** The Europe/Zurich business day the server derived the view for (T22): the one day every signal reads. */
  asOf: string
  terms: {
    deadline?: string
    hourPackage?: { currentPeriod: { from: string; to: string; ended: boolean } | null }
  }
}

/**
 * Opens a project's page like `openProject` and returns the terms in the response the page read the project with, so an oracle
 * is worked out from the very `asOf` and `currentPeriod` the page drew its time elapsed and its dates from, never from the
 * runner's clock (a run that straddles Zurich midnight still agrees with itself).
 */
function nextTermsRead(page: Page, project: ProjectRow): Promise<TermsRead> {
  return page
    .waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().startsWith(PROJECTS_API_URL) &&
        new URL(response.url()).pathname === `/projects/${project.id}`,
      { timeout: 30_000 },
    )
    .then(async (response) => {
      const body = (await response.json()) as { terms: TermsRead | null }
      expect(body.terms, 'the project came with its terms').not.toBeNull()
      expect(body.terms!.asOf, 'projects-api states the day it derived the terms for').toMatch(/^\d{4}-\d{2}-\d{2}$/)
      return body.terms!
    })
}

async function openProjectReadingTerms(page: Page, project: ProjectRow): Promise<TermsRead> {
  const [terms] = await Promise.all([nextTermsRead(page, project), openProject(page, project)])
  return terms
}

/** The consumed percentage the block shows, state words, pace line, and the parts of its bar, by test id. */
const percentOf = (card: Locator): Locator => card.getByTestId('project-hours-consumption-percent')
const stateOf = (card: Locator): Locator => card.getByTestId('project-hours-consumption-state')
const paceOf = (card: Locator): Locator => card.getByTestId('project-hours-consumption-pace')
const barPart = (card: Locator, part: 'track' | 'fill' | 'beyond' | 'today' | 'estimate'): Locator =>
  card.getByTestId(`project-hours-consumption-bar-${part}`)
const barTicks = (card: Locator): Locator => card.getByTestId('project-hours-consumption-bar-tick')

/** `floor(100 × used / reference)` of whole minutes: the consumed percentage, worked out here from the fixture's minutes. */
const percentOfMinutes = (used: number, reference: number): number => Math.floor((100 * used) / reference)

/** A number the screen wrote as a percentage ("4%", "112%"). */
const percentText = (percent: number): string => `${percent}%`

/** The pace line of the yearly package, as the screen words it. */
const yearlyPace = (used: number, elapsed: number): string =>
  `Used ${percentText(used)} of the hours with ${percentText(elapsed)} of the period elapsed`

/** Where a mark's centre sits on the track, as a percentage of the track's length (the bar's own unit). */
async function centreOnTrack(card: Locator, mark: Locator): Promise<number> {
  const track = (await barPart(card, 'track').boundingBox())!
  const box = (await mark.boundingBox())!
  return ((box.x + box.width / 2 - track.x) / track.width) * 100
}

/** How much of the track's length a part covers, as a percentage of it. */
async function lengthOnTrack(card: Locator, part: Locator): Promise<number> {
  const track = (await barPart(card, 'track').boundingBox())!
  return ((await part.boundingBox())!.width / track.width) * 100
}

/** Where a part starts on the track, as a percentage of its length. */
async function startOnTrack(card: Locator, part: Locator): Promise<number> {
  const track = (await barPart(card, 'track').boundingBox())!
  return (((await part.boundingBox())!.x - track.x) / track.width) * 100
}

/** What the bar says, read where it is drawn: the numbers a reader sees and the positions of the parts that show them. */
async function barOf(
  card: Locator,
): Promise<{ percent: number; elapsed: number | null; fill: number; today: number | null }> {
  const percent = Number((await percentOf(card).innerText()).replace('%', ''))
  const pace = await paceOf(card).innerText()
  const elapsed = /with (\d+)% of the period elapsed/.exec(pace)
  const today = barPart(card, 'today')
  return {
    percent,
    elapsed: elapsed ? Number(elapsed[1]) : null,
    fill: await lengthOnTrack(card, barPart(card, 'fill')),
    today: (await today.count()) === 0 ? null : await centreOnTrack(card, today),
  }
}

/** A computed style of `part`, as the browser resolved it (a utility the shell's sheet lacks resolves to the browser's default). */
const computed = (part: Locator, property: string): Promise<string> =>
  part.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)

/**
 * The same property on a stripped copy of `part`: an element of the same tag, in the same parent, with NO class. What the browser
 * answers there is what it answers when the sheet has no rule for the utilities, so a read that differs from it was given by
 * those utilities (the control that makes the R13 reads assert something).
 */
const computedWithoutClasses = (part: Locator, property: string): Promise<string> =>
  part.evaluate((element, name) => {
    const bare = document.createElement(element.tagName)
    element.parentElement!.appendChild(bare)
    const value = getComputedStyle(bare).getPropertyValue(name)
    bare.remove()
    return value
  }, property)

test.describe('specs/20261112-project-hours T18, T25: consumption and its signals, the breakdown by person, Record hours, linked meetings', () => {
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
  /** The fixed price journey F makes (a project cannot be deleted: it ends closed, or cancelled when F did not get that far). */
  let fixedPrice: ProjectRow | undefined
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
    if (fixedPrice && admin) await retireProjectQuietly(admin, fixedPrice.id)
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
      terms: { asOf: string; terms: { hourPackage: { currentPeriod: { from: string; to: string; ended: boolean } } } }
    }>(PROJECTS_API_URL, pm, 'GET', `/projects/${project.id}`)
    expect(projectView.status).toBe(200)
    expect(projectView.body.terms.terms.hourPackage.currentPeriod).toEqual({ ...period, ended: false })
    // US-5 (T22): the same answer states the Europe/Zurich day it was derived for, the day every signal reads (journeys E and F
    // work their oracles out from it). It is the runner's Zurich day, or the next one if the run crossed midnight between two lines.
    const { asOf } = projectView.body.terms
    expect([today, todayZurich()], 'asOf is the Zurich business day').toContain(asOf)
    // The oracle is not degenerate for this fixture: today is two months into the second period, so neither 0 nor 100 could be
    // returned by a figure that ignored the day (journey E compares the screen with this number).
    const elapsed = elapsedPercentOracle(period, asOf)
    expect(elapsed).toBeGreaterThan(5)
    expect(elapsed).toBeLessThan(95)
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

  test("E: the signals on the yearly package follow the fixture's minutes and the server's day, and every reader sees the same (AC-5.1, AC-5.14, AC-5.18, AC-5.27)", async ({
    browser,
  }) => {
    const reference = PACKAGE_HOURS * 60
    // Worked out here, from the minutes this spec recorded and the rules of the spec: 270 min of 6 000 is 4.5%, which reads 4%, and
    // 4% is below 80%, so the project is on track.
    const percent = percentOfMinutes(usedMinutes, reference)
    expect(100 * usedMinutes < 80 * reference, 'the fixture is on track').toBe(true)

    const pmCtx = await personContext(browser, pm)
    const page = await pmCtx.newPage()
    const terms = await openProjectReadingTerms(page, project)
    const card = page.getByTestId('project-hours')
    // The oracle: the period and the day are the ones the page drew from; the rule is AC-5.20's, written in the helper.
    const currentPeriod = terms.terms.hourPackage!.currentPeriod!
    expect(currentPeriod).toEqual({ ...period, ended: false })
    const elapsed = elapsedPercentOracle(currentPeriod, terms.asOf)
    expect(elapsed, 'a time elapsed that is neither the start nor the end of the period').toBeGreaterThan(5)
    expect(elapsed).toBeLessThan(95)

    await expect(percentOf(card)).toHaveText(percentText(percent), { timeout: 30_000 })
    await expect(stateOf(card)).toHaveText('On track')
    await expect(paceOf(card)).toHaveText(yearlyPace(percent, elapsed))
    // No excess, no stripes, no estimate: a yearly package within its hours.
    await expect(card.getByTestId('project-hours-consumption-bar')).toHaveAttribute('aria-hidden', 'true')
    await expect(barPart(card, 'beyond')).toHaveCount(0)
    await expect(barPart(card, 'estimate')).toHaveCount(0)
    await expect(card.getByTestId('project-hours-consumption-date-deadline')).toHaveCount(0)
    await expect(card.getByTestId('project-hours-consumption-date-end-date')).toHaveCount(0)

    // The bar is drawn where those figures put its parts (AC-5.14, AC-5.18): the fill is 80% of the track for 100% of the
    // hours, the today mark is at 0.8 times the time elapsed, and the ticks are at 80%, 100% and 125% of the hours. The card is
    // read once the panel under the block has answered too, so no later layout move can fall between two measurements.
    await expect(totalOf(card)).toHaveText(short(totalMinutes), { timeout: 30_000 })
    await expect(barPart(card, 'fill')).toBeVisible()
    const drawn = await barOf(card)
    expect(drawn.percent).toBe(percent)
    expect(drawn.fill).toBeCloseTo((80 * usedMinutes) / reference, 1)
    expect(drawn.today).toBeCloseTo((80 * elapsed) / 100, 1)
    await expect(barTicks(card)).toHaveCount(3)
    const ticks = await Promise.all([0, 1, 2].map((index) => centreOnTrack(card, barTicks(card).nth(index))))
    expect(ticks[0]).toBeCloseTo(64, 1)
    expect(ticks[1]).toBeCloseTo(80, 1)
    expect(ticks[2]).toBeCloseTo(100, 1)

    // Nothing in the block names a person or an amount (AC-5.27, AC-1.8).
    const blockText = await card.getByTestId('project-hours-consumption').innerText()
    expect(blockText).not.toContain(pm.name)
    expect(blockText).not.toContain(reader.name)
    expect(blockText).not.toMatch(/CHF|EUR|USD|€|\$|£/)
    const pmSees = { percent: await percentOf(card).innerText(), state: await stateOf(card).innerText() }
    await pmCtx.close()

    // Another person who can read the project, neither its manager nor on its team: the same signals (AC-5.27).
    const readerCtx = await personContext(browser, reader)
    const readerPage = await readerCtx.newPage()
    const readerTerms = await openProjectReadingTerms(readerPage, project)
    const readerCard = readerPage.getByTestId('project-hours')
    await expect(percentOf(readerCard)).toHaveText(pmSees.percent, { timeout: 30_000 })
    await expect(stateOf(readerCard)).toHaveText(pmSees.state)
    await expect(paceOf(readerCard)).toHaveText(
      yearlyPace(percent, elapsedPercentOracle(readerTerms.terms.hourPackage!.currentPeriod!, readerTerms.asOf)),
    )
    await readerCtx.close()
  })

  test('C: recording 1 h with Record hours on the page grows the card by 1 h without a reload, and the percentage moves while the time elapsed does not (AC-2.8, AC-5.28)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, pm)
    const page = await ctx.newPage()
    const terms = await openProjectReadingTerms(page, project)
    const card = page.getByTestId('project-hours')
    await expect(totalOf(card)).toHaveText(short(totalMinutes), { timeout: 30_000 })
    await expect(drawnDuration(fact(card, 'Hours used in this period'))).toHaveText(short(usedMinutes))
    // E's second half (AC-5.28), the baseline: what the bar says before the save, read where it is drawn. The time elapsed is the
    // day the page read the project on, worked out here from that same read.
    const reference = PACKAGE_HOURS * 60
    const elapsed = elapsedPercentOracle(terms.terms.hourPackage!.currentPeriod!, terms.asOf)
    const percentBefore = percentOfMinutes(usedMinutes, reference)
    await expect(percentOf(card)).toHaveText(percentText(percentBefore))
    const before = await barOf(card)
    expect(before.elapsed).toBe(elapsed)
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
    // E's second half (AC-5.28): the hour moved the percentage and the bar's fill, and nothing that reads the day. The percentage
    // is awaited first, so the figures below are read AFTER the page drew the new answer, not before it came (a time elapsed that
    // had not moved yet would pass for one that does not move).
    const percentAfter = percentOfMinutes(usedAfter, reference)
    expect(percentAfter, "the fixture's hour moves the floored percentage").toBeGreaterThan(percentBefore)
    await expect(percentOf(card)).toHaveText(percentText(percentAfter), { timeout: 30_000 })
    await expect(stateOf(card)).toHaveText('On track')
    const after = await barOf(card)
    expect(after.percent).toBe(percentAfter)
    expect(after.fill, 'the fill follows the new hours').toBeCloseTo((80 * usedAfter) / reference, 1)
    expect(after.fill).toBeGreaterThan(before.fill)
    expect(
      after.elapsed,
      'the time elapsed is that of the day the page read the project on: a save does not move it',
    ).toBe(elapsed)
    expect(after.today, 'nor does the today mark').toBeCloseTo(before.today!, 1)
    await expect(paceOf(card)).toHaveText(yearlyPace(percentAfter, elapsed))
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

  test("F: a hand-made fixed price over its max effort reads over, 112%, 0.1 man-days over, a passed end date and a near deadline, drawn by the shell's own sheet; closed, it says no state and no date (AC-5.9, AC-5.12, AC-5.15, AC-5.17, AC-5.18, AC-5.21, AC-5.22, AC-5.26)", async ({
    browser,
  }) => {
    // The fixture, in the spec's own numbers: 9 h (540 min) against a max effort of 1.0 man-day (480 min, a man-day is 8 hours) and
    // an estimate of 0.9; terms from 60 days before the Zurich day to the day before it, the work due 10 days after it.
    const F = {
      startDate: addDaysTo(today, -60),
      endDate: addDaysTo(today, -1),
      deadline: addDaysTo(today, 10),
      estimatedManDays: 0.9,
      maxEffortManDays: 1.0,
      minutes: 540,
    }
    const MAN_DAY = 480
    const referenceMinutes = F.maxEffortManDays * MAN_DAY
    const percent = percentOfMinutes(F.minutes, referenceMinutes) // 112.5 reads 112
    // Whole tenths of a man-day, half up (AC-1.6, AC-5.12): 11.25 tenths used, 1.25 over.
    const usedTenths = Math.round((F.minutes * 10) / MAN_DAY)
    const excessTenths = Math.round(((F.minutes - referenceMinutes) * 10) / MAN_DAY)
    const manDays = (tenths: number): string => `${(tenths / 10).toFixed(1)} man-days`
    const days = (count: number): string => `${count} ${count === 1 ? 'day' : 'days'}`
    expect(F.minutes, 'the fixture is over its max effort').toBeGreaterThan(referenceMinutes)
    expect(excessTenths, 'by one tenth, not by less than one').toBe(1)

    // The real records: a fixed price made by an admin with its terms, made active, and the project manager's 9 h on it.
    const made = await createFixedPriceProjectViaApi(admin, {
      name: `Php fixed price ${runId}`,
      companyId: company.id,
      projectManagerId: pm.userId,
      startDate: F.startDate,
      endDate: F.endDate,
      deadline: F.deadline,
      estimatedManDays: F.estimatedManDays,
      maxEffortManDays: F.maxEffortManDays,
    })
    fixedPrice = made
    expect(made.state).toBe('planned')
    fixedPrice = await transitionProjectViaApi(admin, made, 'active')
    expect(fixedPrice.state).toBe('active')
    recorded.push({
      by: pm,
      id: (await createEntryViaApi(pm, { day: today, minutes: F.minutes, on: { type: 'project', id: fixedPrice.id } }))
        .id,
    })
    // Out of band, as the PM: a fixed price compares ALL the hours (no window), and they are these.
    const summary = await projectSummaryViaApi(pm, fixedPrice.id)
    expect(summary.status).toBe(200)
    expect(summary.body.totalMinutes).toBe(F.minutes)
    expect(summary.body.windowMinutes).toBeNull()

    const ctx = await personContext(browser, pm)
    const page = await ctx.newPage()
    const terms = await openProjectReadingTerms(page, fixedPrice)
    const card = page.getByTestId('project-hours')
    // The terms are what this journey made, so the oracles below are about this fixture. Every day count is taken from the day the
    // server stated with them (`asOf`), never from the runner's clock: the end date has passed by `asOf − endDate` days (1 on the
    // Zurich day the fixture was made on, 2 if the run crossed midnight), the deadline is `deadline − asOf` days away.
    expect(terms).toMatchObject({ startDate: F.startDate, endDate: F.endDate, terms: { deadline: F.deadline } })
    const passedDays = daysBetween(F.endDate, terms.asOf)
    const nearDays = daysBetween(terms.asOf, F.deadline)
    expect(passedDays, 'the end date has passed').toBeGreaterThanOrEqual(1)
    expect(nearDays, 'the deadline is near, and not today').toBeGreaterThan(0)
    expect(nearDays).toBeLessThanOrEqual(30)
    const elapsed = elapsedPercentOracle({ from: F.startDate, to: F.deadline }, terms.asOf)
    expect(elapsed, 'a time elapsed that is neither the start nor the end of the span').toBeGreaterThan(5)
    expect(elapsed).toBeLessThan(95)

    // The facts: man-days used, the estimate, the max effort, and the excess (a last fact, "Over by", the AC-1.6 rule applied to it).
    await expect(fact(card, 'Man-days used')).toHaveText(manDays(usedTenths), { timeout: 30_000 })
    await expect(fact(card, 'Estimated man-days')).toHaveText(manDays(Math.round(F.estimatedManDays * 10)))
    await expect(fact(card, 'Max effort')).toHaveText(manDays(Math.round(F.maxEffortManDays * 10)))
    await expect(fact(card, 'Over by')).toHaveText(manDays(excessTenths))
    await expect(totalOf(card)).toHaveText(short(F.minutes), { timeout: 30_000 })

    // The state, the percentage and the pace line. 112.5% is over the limit by an hour, so "Over the limit" (not "Limit reached"),
    // and the percentage reads 112 (rounded down).
    await expect(stateOf(card)).toHaveText('Over the limit')
    await expect(percentOf(card)).toHaveText(percentText(percent))
    await expect(paceOf(card)).toHaveText(
      `Used ${percentText(percent)} of the max effort with ${percentText(elapsed)} of the time to the deadline elapsed`,
    )

    // The date lines: the deadline first, then the terms' end date (AC-5.23), each with its date; one has passed (the graver
    // level), one is near (the milder), and the two are told apart by their icon as well as their words (AC-5.10).
    const deadlineLine = card.getByTestId('project-hours-consumption-date-deadline')
    const endDateLine = card.getByTestId('project-hours-consumption-date-end-date')
    await expect(deadlineLine).toContainText(`Deadline in ${days(nearDays)}`)
    await expect(deadlineLine.locator(`time[datetime="${F.deadline}"]`)).toHaveText(dmy(F.deadline))
    await expect(endDateLine).toContainText(`End date passed ${days(passedDays)} ago`)
    await expect(endDateLine.locator(`time[datetime="${F.endDate}"]`)).toHaveText(dmy(F.endDate))
    expect(
      await card
        .locator('[data-testid^="project-hours-consumption-date-"]')
        .evaluateAll((lines) => lines.map((line) => line.getAttribute('data-testid'))),
      'the deadline comes first',
    ).toEqual(['project-hours-consumption-date-deadline', 'project-hours-consumption-date-end-date'])
    expect(await deadlineLine.locator('svg').first().innerHTML()).not.toBe(
      await endDateLine.locator('svg').first().innerHTML(),
    )

    // The bar, where the figures put its parts (AC-5.14, AC-5.15, AC-5.17, AC-5.18): the fill ends at the 100% mark (80% of the
    // track), the part beyond it is its own element from there, 80 × (540 − 480) / 480 = 10% of the track long, the estimate's
    // diamond sits at 80 × 0.9 / 1.0 = 72%, and the today mark at 0.8 times the time elapsed.
    await expect(barPart(card, 'beyond')).toBeVisible()
    await expect(barPart(card, 'estimate')).toBeVisible()
    const fill = barPart(card, 'fill')
    const beyond = barPart(card, 'beyond')
    const estimate = barPart(card, 'estimate')
    expect(await lengthOnTrack(card, fill)).toBeCloseTo(80, 1)
    expect(await startOnTrack(card, beyond)).toBeCloseTo(80, 1)
    expect(await lengthOnTrack(card, beyond)).toBeCloseTo((80 * (F.minutes - referenceMinutes)) / referenceMinutes, 1)
    expect(await centreOnTrack(card, estimate)).toBeCloseTo((80 * F.estimatedManDays) / F.maxEffortManDays, 1)
    expect(await centreOnTrack(card, barPart(card, 'today'))).toBeCloseTo((80 * elapsed) / 100, 1)

    // R13 — what only the bar's own utilities give, read as the browser resolved it (a component test applies no stylesheet): the
    // shell's one Tailwind sheet must have generated them. The track row is 10 px high; the part beyond the 100% mark is stripes,
    // a `linear-gradient` repeated every 6 px; the estimate's diamond is 8 px wide and has a ring (a `box-shadow`). A stripped copy
    // of each element is the control: what the browser answers when the sheet has no rule, which these reads must differ from.
    const track = barPart(card, 'track')
    expect(await computed(track, 'height')).toBe('10px')
    expect(await computed(beyond, 'background-image')).toContain('linear-gradient')
    expect(await computed(beyond, 'background-size')).toBe('6px 100%')
    expect(await computed(estimate, 'width')).toBe('8px')
    expect(await computed(estimate, 'box-shadow')).not.toBe('none')
    expect(await computedWithoutClasses(track, 'height')).not.toBe('10px')
    expect(await computedWithoutClasses(beyond, 'background-image')).toBe('none')
    expect(await computedWithoutClasses(beyond, 'background-size')).not.toBe('6px 100%')
    expect(await computedWithoutClasses(estimate, 'width')).not.toBe('8px')
    expect(await computedWithoutClasses(estimate, 'box-shadow')).toBe('none')
    // The over fill's colour, to tell it from the neutral one once no state is said.
    const overFill = await computed(fill, 'background-color')
    await ctx.close()

    // AC-5.26: closed through the API, and the page read again.
    const closed = await transitionProjectViaApi(admin, fixedPrice, 'closed')
    fixedPrice = closed
    expect(closed.state).toBe('closed')
    const closedCtx = await personContext(browser, pm)
    const closedPage = await closedCtx.newPage()
    const closedTerms = await openProjectReadingTerms(closedPage, closed)
    const closedCard = closedPage.getByTestId('project-hours')
    const closedElapsed = elapsedPercentOracle({ from: F.startDate, to: F.deadline }, closedTerms.asOf)
    // The figures, the bar and the time elapsed read as for any other project …
    await expect(percentOf(closedCard)).toHaveText(percentText(percent), { timeout: 30_000 })
    await expect(fact(closedCard, 'Over by')).toHaveText(manDays(excessTenths))
    await expect(paceOf(closedCard)).toHaveText(
      `Used ${percentText(percent)} of the max effort with ${percentText(closedElapsed)} of the time to the deadline elapsed`,
    )
    await expect(barPart(closedCard, 'beyond')).toBeVisible()
    await expect(barPart(closedCard, 'estimate')).toBeVisible()
    await expect(barPart(closedCard, 'today')).toBeVisible()
    // … but it says no state, and no date has passed or is near for a project that is closed.
    await expect(stateOf(closedCard)).toHaveCount(0)
    await expect(closedCard).not.toContainText('Over the limit')
    await expect(closedCard.getByTestId('project-hours-consumption-date-deadline')).toHaveCount(0)
    await expect(closedCard.getByTestId('project-hours-consumption-date-end-date')).toHaveCount(0)
    // The bar is neutral, not in the over tone: a tone without its words would be colour alone.
    expect(await computed(barPart(closedCard, 'fill'), 'background-color')).not.toBe(overFill)
    await closedCtx.close()
  })
})
