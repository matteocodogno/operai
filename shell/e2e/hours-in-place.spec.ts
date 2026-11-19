/**
 * T13, T24 — Record hours in place, from the project, the deal and the task, and the table view of My hours: a week or a
 * month (specs/20261116-record-hours-in-place: AC-1.1, AC-1.2, AC-2.1, AC-2.2, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-3.5, AC-4.1,
 * AC-4.3, AC-4.5, AC-5.1, AC-5.2, AC-5.5, AC-5.13, AC-5.14, AC-5.16–AC-5.20, AC-5.25–AC-5.34).
 *
 * Nothing is stubbed: the project and deal pages are projects-ui and crm-ui, the button is hours-ui's `./RecordHours`
 * loaded through the shell's `hours.recordHours` extension, the entry is written by hours-api, which asks projects-api,
 * crm-api and activities-api as the caller. The records (a company, a deal owned by a chosen person, projects with a
 * team, tasks assigned to chosen people) are made through the owners' REST APIs by an admin, exactly as
 * hours-owners.spec.ts does (helpers/hoursOwnersFixtures.ts, helpers/activitiesFixtures.ts).
 *
 *  A. A team member records 2 h 30 with a work type and a note from the project page; the message and its link open
 *     My hours, on the table view's current week, which shows the entry in today's cell; the List lists it with the
 *     same values; a salesperson who can read the project sees no button (AC-1.1, 1.2, 4.1, 4.3, 5.1), and nothing else
 *     on the page is read again (AC-4.3).
 *  B. The deal's owner records from the header; a person who is on the deal only through one of its tasks sees none
 *     there and one on their task's row, whose entry points at the task (AC-2.1, 2.2, 3.1, 3.3).
 *  C. A project task's assignee records from the Tasks card row; the entry points at the task (AC-3.1, 3.2).
 *  D. A CRM company task with no deal records other work with a category and no task (AC-3.4, 3.5).
 *  E. With hours-ui's `remoteEntry.js` aborted, the project page, the deal page and My tasks load and show the My
 *     hours link (AC-4.5, the remote-failure.spec.ts pattern).
 *  F. The table view, week (rewritten by T24). `/hours` opens on it, the List and back through the switch, Next
 *     unavailable on the current week and keeping the keyboard once it is reached from the week before; last week: the
 *     cells, rows, order and totals; an empty cell does nothing; Add hours in a cell's list records with day and row set
 *     and changeable, Edit changes, Delete asks first, a cell that empties is blank and the keyboard goes to the card's
 *     heading; Record hours in the header on something new to the week adds its row; the figures follow without a reload
 *     (AC-5.1, 5.2, 5.5, 5.13, 5.14, 5.16–5.20, 5.28, 5.32).
 *  G. (new, T24; its own describe and people.) One person with entries on two projects in last month and one today:
 *       G.1 the addresses, `?view=list`, `?view=week&week=<a past day>`, `?view=month&month=<last month>`, and the weeks and
 *           months after the current one, which open the current one (AC-5.2, 5.29);
 *       G.2 the current week → Month → Previous → Week, and past weeks → Month → Week, every expected period computed here
 *           with the rules of the spec (R21): the day columns, the cells, the totals, Next unavailable on the current
 *           month and keeping the keyboard, an empty cell inert (AC-5.25–5.28, 5.32); the month's first grid time is
 *           logged (R13);
 *       G.3 the date field in each period: `max` is today, a day after today is refused, a day of last month picked or
 *           typed key by key under a slow read lands on its period (AC-5.30, 5.31, R16);
 *       G.4 as an admin at 1440 px (and again at 1920 px, where the frame is wider than the default column, so a page that
 *           kept the cap would show), the tool container and each page's root have one width, the frame's, over the List,
 *           the week, the month, Everyone's hours and Settings (AC-5.33);
 *       G.5 at 1280 px the month scrolls inside its region and the page does not; a focused cell is never hidden under
 *           a pinned column (AC-5.34, R-D3);
 *       G.6 R13: a past month of 300 own entries, its first grid time logged (not asserted) and its figures checked;
 *       G.7 a project named with 200 unbroken characters (the bound of a name) does not hide the month's days behind the
 *           pinned label column: the first day's button is hit-testable and the last day's header clears the pins, by
 *           scrolling and by keyboard, and the week, which draws the same label, still fits its region (AC-5.34,
 *           owasp-report L1);
 *       G.8 the same name (200 unbroken characters, and an ordinary long one) in the cell dialog, the delete confirmation
 *           opened from it, the List's row, the Record hours dialog and the message that follows its save, on the page's
 *           header and on a task's row (whose subject is as long): it stays inside
 *           its box, every control (the ×, the buttons, the host's Record hours) is inside the window and on top, and an
 *           ordinary name keeps its words whole (QE pass 4, D1). G.3 also offers the date field next Monday and the 1st
 *           of next month, so a future day is refused whatever today is (QE pass 4, O3).
 *
 * Needs the stack up (`mise run dev`) with the specs/20261112-time-tracking and specs/20261110-activities wiring (see the
 * headers of hours-owners.spec.ts and activities-crm.spec.ts). Against the dev stack Playwright reuses the servers when
 * each remote's port is pointed at it:
 *   E2E_ESTIMAI_REMOTE_PORT=5174 E2E_REFUND_REMOTE_PORT=5175 E2E_NOTIFY_REMOTE_PORT=5176 \
 *   E2E_ADMIN_REMOTE_PORT=5177 E2E_INVENTORY_REMOTE_PORT=5178 E2E_CRM_REMOTE_PORT=5179 \
 *   E2E_MEETINGS_REMOTE_PORT=5180 E2E_PROJECTS_REMOTE_PORT=5181 E2E_HOURS_REMOTE_PORT=5184 \
 *   pnpm e2e hours-in-place.spec.ts
 *
 * The people are per-run (`hip-*@operai.test`, an admin included) and every entry they record is deleted afterwards;
 * companies, deals, projects and tasks cannot be deleted from here (their owners keep them, like the other specs).
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import {
  cleanupPeople,
  createEntryViaApi,
  deleteOwnEntriesQuietly,
  hoursAdmin,
  hoursCall,
  newRunId,
  ownEntriesViaApi,
  personContext,
  pickCategories,
  seedHoursPerson,
  signInContext,
  timeListsViaApi,
  todayZurich,
  type CategoryRow,
  type EntryRow,
  type HoursPerson,
} from './helpers/hoursFixtures'
import {
  createCompanyViaApi,
  createDealOwnedBy,
  createProjectViaApi,
  createTaskViaApi,
  setTeamViaApi,
  type CompanyRow,
  type DealRow,
  type ProjectRow,
} from './helpers/hoursOwnersFixtures'
import {
  apiCall,
  findCompanyActivityId,
  findProjectTaskId,
  ACTIVITIES_API_URL,
  PROJECTS_API_URL,
} from './helpers/activitiesFixtures'
import type { SeededSession } from './helpers/adminSession'

const runId = newRunId()
const today = todayZurich()
const PREFIX = 'hip' as const
const SALES = ['employee', 'sales']
const HOURS_REMOTE_ORIGIN = `http://localhost:${process.env['E2E_HOURS_REMOTE_PORT'] ?? '5185'}`

// ─── Days ───────────────────────────────────────────────────────────────────

const dayOf = (iso: string): Date => new Date(`${iso}T00:00:00Z`)
const addDays = (iso: string, days: number): string => {
  const date = dayOf(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
/** The Monday of the week holding `iso` (weeks run Monday to Sunday, WA1). */
const mondayOf = (iso: string): string => addDays(iso, -((dayOf(iso).getUTCDay() + 6) % 7))
/** `dd.mm.yyyy`, as the suite writes a date. */
const dmy = (iso: string): string => iso.split('-').reverse().join('.')
const weekLabel = (monday: string): string => `Week ${dmy(monday)} – ${dmy(addDays(monday, 6))}`

const currentMonday = mondayOf(today)
const lastMonday = addDays(currentMonday, -7)
/** The day the cleanup reads from: earlier than anything a journey records. */
const cleanupFrom = addDays(today, -45)

// ─── Small helpers ──────────────────────────────────────────────────────────

/** The text of a locator with its whitespace collapsed (a figure, a sentence). */
const textOf = async (locator: Locator): Promise<string> => (await locator.innerText()).replace(/\s+/g, ' ').trim()

/** Opens a project's page as `page`'s person and waits for its header. */
async function openProject(page: Page, project: ProjectRow): Promise<void> {
  await page.goto(`/projects/${project.id}`)
  await expect(page.getByTestId('project-detail-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('project-tasks')).toBeVisible({ timeout: 30_000 })
}

/** Opens a deal's page and waits for its header and its activity card. */
async function openDeal(page: Page, deal: DealRow): Promise<void> {
  await page.goto(`/crm/deals/${deal.id}`)
  await expect(page.getByTestId('crm-deal-page')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: deal.title, exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('crm-activity-card')).toBeVisible({ timeout: 30_000 })
}

/**
 * Waits until a "this person is offered no Record hours" assertion (A and B) can mean something. Not
 * `waitForLoadState('networkidle')`: the shell's notification stream (the SSE from notify-api) keeps a request open for
 * the whole session, so the network never goes idle (estimai-import.spec.ts and its siblings say the same). Two things
 * must hold, and neither is the network:
 *  - the session has answered. A host offers the button only to a person it can name (`mayRecordOnProject`,
 *    `mayRecordOnDeal` and `mayRecordOnTask` are all false while `useSession()` holds no id), so until then a count of 0
 *    would be true for anybody. The shell's header draws the person's menu from that same session store, and only
 *    once it holds the person: the menu is the proof.
 *  - the seam has had its chance. The button is hours-ui's widget, reached through `shell/extensions` and a federated
 *    remote after the page has drawn, so one that wrongly appeared would come some time after the page did. A negative
 *    cannot wait for the thing it expects never to happen, so a fixed grace bounds that.
 */
async function recordHoursSettled(page: Page): Promise<void> {
  await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
}

/** The header's Record hours (a task row's button is named "Record hours on <task>", so the exact name is the page's). */
const pageRecordHours = (page: Page): Locator => page.getByRole('button', { name: 'Record hours', exact: true })

/** The entry dialog the widget opened. */
const hoursDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Record hours' })

/** The entries a person holds on one day, from hours-api (out-of-band verification). */
async function entriesOn(person: HoursPerson, day: string): Promise<EntryRow[]> {
  return (await ownEntriesViaApi(person, day, day)).filter((entry) => entry.day === day)
}

/** The members of an entry the API holds that the specs reads: its activity pointer and work type. */
interface EntryDetail extends EntryRow {
  activity: { id: string | null; subject: string | null } | null
  workType: { id: string; name: string } | null
}
const detailOf = (entry: EntryRow): EntryDetail => entry as EntryDetail

test.describe('specs/20261116-record-hours-in-place T13: record hours in place, and the Week', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let admin: SeededSession
  let member: HoursPerson // on the project's team, assignee of the project task
  let reader: HoursPerson // can read the project, the deal and every task, is on none of them
  let owner: HoursPerson // owns the deal
  let assignee: HoursPerson // assignee of the deal's task and of the company's task: neither owner nor technical contact
  let weeker: HoursPerson // the Week's person
  let training: CategoryRow
  let administration: CategoryRow

  let company: CompanyRow
  let project: ProjectRow
  let deal: DealRow
  let projectTaskSubject: string
  let projectTaskId: string
  let dealTaskSubject: string
  let dealTaskId: string
  let companyTaskSubject: string
  let companyTaskId: string

  const everyone = (): HoursPerson[] => [member, reader, owner, assignee, weeker].filter(Boolean)

  test.beforeAll(async () => {
    admin = await hoursAdmin(runId, PREFIX)
    member = await seedHoursPerson('member', SALES, runId, PREFIX)
    reader = await seedHoursPerson('reader', SALES, runId, PREFIX)
    owner = await seedHoursPerson('owner', SALES, runId, PREFIX)
    assignee = await seedHoursPerson('assignee', SALES, runId, PREFIX)
    weeker = await seedHoursPerson('weeker', SALES, runId, PREFIX)
    ;[training, administration] = await pickCategories(admin)

    // The real records, in their real owners.
    company = await createCompanyViaApi(admin, `Hip company ${runId}`)
    project = await setTeamViaApi(admin, await createProjectViaApi(admin, `Hip project ${runId}`), [member.userId])
    deal = await createDealOwnedBy(admin, company.id, `Hip deal ${runId}`, owner.userId)

    projectTaskSubject = `Hip project task ${runId}`
    dealTaskSubject = `Hip deal task ${runId}`
    companyTaskSubject = `Hip company task ${runId}`
    await createTaskViaApi(admin, { subject: projectTaskSubject, projectId: project.id, assigneeUserId: member.userId })
    await createTaskViaApi(admin, {
      subject: dealTaskSubject,
      companyId: company.id,
      dealId: deal.id,
      assigneeUserId: assignee.userId,
    })
    await createTaskViaApi(admin, {
      subject: companyTaskSubject,
      companyId: company.id,
      assigneeUserId: assignee.userId,
    })
    projectTaskId = await findProjectTaskId(admin, project.id, projectTaskSubject)
    dealTaskId = await findCompanyActivityId(admin, company.id, dealTaskSubject)
    companyTaskId = await findCompanyActivityId(admin, company.id, companyTaskSubject)
  })

  test.afterAll(async () => {
    for (const person of everyone()) await deleteOwnEntriesQuietly(person, cleanupFrom)
    // The tasks the journeys made go too (their admin may delete them); the company, the deal and the projects cannot be
    // deleted from here, as in the other specs.
    for (const id of [projectTaskId, dealTaskId, companyTaskId]) {
      if (admin && id)
        await apiCall(ACTIVITIES_API_URL, admin, 'DELETE', `/activities/${encodeURIComponent(id)}`).catch(
          () => undefined,
        )
    }
    await cleanupPeople(runId)
  })

  // ─── A ────────────────────────────────────────────────────────────────────

  test('A: a team member records 2 h 30 with a work type and a note from the project page; a reader sees no button (AC-1.1, 1.2, 4.1, 4.3)', async ({
    browser,
  }) => {
    const lists = await timeListsViaApi(admin)
    const workType = lists.workTypes.project.find((candidate) => !(candidate as { retired: boolean }).retired) as
      { id: string; name: string } | undefined
    expect(workType, 'a project work type to pick').toBeDefined()
    const note = `Hip A note ${runId}`

    const memberCtx = await personContext(browser, member)
    const page = await memberCtx.newPage()
    await openProject(page, project)

    // AC-1.1: the project's team member is offered Record hours, first in the header.
    const button = pageRecordHours(page)
    await expect(button).toBeVisible({ timeout: 30_000 })
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog')

    // The page as it is before the save: what AC-4.3 says must not change.
    const factsBefore = await textOf(page.getByTestId('project-facts'))
    const tasksBefore = await textOf(page.getByTestId('project-tasks'))

    await button.click()
    const dialog = hoursDialog(page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    // AC-1.3 as the person meets it: the project is text (no radio, no picker), the day is today, the keyboard is on Duration.
    await expect(dialog).toContainText(`Recording hours on the project ${project.name}.`)
    await expect(dialog.getByTestId('hours-entry-on-project')).toHaveCount(0)
    await expect(dialog.getByTestId('hours-entry-project-input')).toHaveCount(0)
    await expect(dialog.getByTestId('hours-entry-day')).toHaveValue(today)
    await expect(dialog.getByTestId('hours-entry-duration')).toBeFocused()

    await dialog.getByTestId('hours-entry-duration').fill('2.5')
    await dialog.getByTestId('hours-entry-work-type').selectOption(workType!.id)
    await dialog.getByTestId('hours-entry-note').fill(note)

    // AC-4.3: after the save the page asks nothing of the projects it showed (a request the page makes now would be a re-read).
    const hostReads: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (url.startsWith(PROJECTS_API_URL) || url.startsWith(ACTIVITIES_API_URL))
        hostReads.push(`${request.method()} ${url}`)
    })
    // The instrument is proved before it is trusted: a request to the host's origin is seen by the listener.
    await page.evaluate((url) => fetch(`${url}/health`).catch(() => undefined), PROJECTS_API_URL)
    await expect.poll(() => hostReads.length).toBe(1)
    hostReads.length = 0
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await dialog.waitFor({ state: 'detached', timeout: 30_000 })

    const message = page.getByTestId('hours-record-hours-message')
    await expect(message).toBeVisible()
    await expect(message).toHaveAttribute('role', 'status')
    await expect(page.getByTestId('hours-record-hours-recorded')).toHaveText(`2 h 30 recorded on ${project.name}.`)
    // Focus returns to the button the person pressed (the library gives it back).
    await expect(button).toBeFocused()
    // No timer (G1): still there after the time the old message would have lasted.
    await page.waitForTimeout(4_000)
    await expect(message).toBeVisible()

    expect(await textOf(page.getByTestId('project-facts'))).toBe(factsBefore)
    expect(await textOf(page.getByTestId('project-tasks'))).toBe(tasksBefore)
    expect(hostReads, 'no host read after the widget saved').toEqual([])

    // AC-4.1: the entry is the one hours-api holds, with the values the dialog was given.
    const saved = (await entriesOn(member, today)).map(detailOf)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.minutes).toBe(150)
    expect(saved[0]!.on).toMatchObject({ type: 'project', id: project.id })
    expect(saved[0]!.workType?.id).toBe(workType!.id)
    expect(saved[0]!.note).toBe(note)
    expect(saved[0]!.activity).toBeNull()

    // AC-4.3: the link opens My hours (a shell transition: the page is not reloaded), which lists the entry.
    await page.evaluate(() => {
      ;(window as unknown as { __hipSameDocument: boolean }).__hipSameDocument = true
    })
    await page.getByTestId('hours-record-hours-link').click()
    await expect(page).toHaveURL(/\/hours$/)
    await expect(page.getByTestId('hours-my-page')).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => (window as unknown as { __hipSameDocument?: boolean }).__hipSameDocument)).toBe(
      true,
    )
    // My hours opens on the table view (AC-5.1 reversed 2026-11-19): the Table tab is the selected one, the List is not
    // drawn, and the current week shows the entry's 2 h 30 in today's cell, on the project's row …
    await expect(page.getByTestId('hours-view-switch').getByRole('tab', { name: 'Table' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByTestId('hours-entries')).toHaveCount(0)
    await expect(page.getByTestId('hours-table-heading')).toHaveText(weekLabel(currentMonday), { timeout: 30_000 })
    await expect(page.locator(`[data-cell="project:${project.id}:${today}"]`)).toHaveText('2 h 30', {
      timeout: 30_000,
    })
    // … and the List, the other view of the same page, lists the entry with the same values.
    await page.getByRole('tab', { name: 'List' }).click()
    const row = page.getByTestId(`hours-entry-${saved[0]!.id}`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText(project.name)
    await expect(row).toContainText(workType!.name)
    await expect(row).toContainText(note)
    await expect(row).toContainText('2 h 30')
    await memberCtx.close()

    // AC-1.2: a salesperson who can read the project (and is not on its team) is offered nothing.
    const readerCtx = await personContext(browser, reader)
    const readerPage = await readerCtx.newPage()
    await openProject(readerPage, project)
    // The task row is on the page before the grace starts, so a button that wrongly came in it has as long as one in the header.
    await expect(readerPage.getByTestId(`project-task-${projectTaskId}`)).toBeVisible({ timeout: 30_000 })
    await recordHoursSettled(readerPage) // the seam loads after the page: a missing button must stay missing
    await expect(pageRecordHours(readerPage)).toHaveCount(0)
    await expect(readerPage.getByTestId('record-hours-fallback')).toHaveCount(0)
    // …and no task row of the Tasks card offers it to them either (the task is the member's).
    await expect(readerPage.getByTestId(`project-task-${projectTaskId}`).getByTestId('hours-record-hours')).toHaveCount(
      0,
    )
    await readerCtx.close()
  })

  // ─── B ────────────────────────────────────────────────────────────────────

  test("B: the deal's owner records from the header; the assignee of its task sees none there and one on the task's row (AC-2.1, 2.2, 3.1, 3.3)", async ({
    browser,
  }) => {
    const ownerCtx = await personContext(browser, owner)
    const ownerPage = await ownerCtx.newPage()
    await openDeal(ownerPage, deal)

    // AC-2.1: the owner is offered it in the header.
    const button = pageRecordHours(ownerPage)
    await expect(button).toBeVisible({ timeout: 30_000 })
    // The owner is not assigned to the deal's task, so its row offers them nothing (AC-3.1).
    await expect(ownerPage.getByTestId(`crm-activity-${dealTaskId}`)).toBeVisible()
    await expect(ownerPage.getByTestId(`crm-activity-${dealTaskId}`).getByTestId('hours-record-hours')).toHaveCount(0)

    await button.click()
    const dialog = hoursDialog(ownerPage)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog).toContainText(`Recording hours on the deal ${deal.title}.`)
    await expect(dialog.getByTestId('hours-entry-on-deal')).toHaveCount(0)
    await expect(dialog.getByTestId('hours-entry-day')).toHaveValue(today)
    await expect(dialog.getByTestId('hours-entry-duration')).toBeFocused()
    await dialog.getByTestId('hours-entry-duration').fill('1')
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await dialog.waitFor({ state: 'detached', timeout: 30_000 })
    await expect(ownerPage.getByTestId('hours-record-hours-recorded')).toHaveText(`1 h recorded on ${deal.title}.`)
    const ownerEntries = await entriesOn(owner, today)
    expect(ownerEntries).toHaveLength(1)
    expect(ownerEntries[0]!.on).toMatchObject({ type: 'deal', id: deal.id })
    expect(detailOf(ownerEntries[0]!).activity).toBeNull()
    await ownerCtx.close()

    // AC-2.2: on the deal only through one of its tasks, the assignee gets nothing in the header…
    const assigneeCtx = await personContext(browser, assignee)
    const page = await assigneeCtx.newPage()
    await openDeal(page, deal)
    const row = page.getByTestId(`crm-activity-${dealTaskId}`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    // …and one on the task's row (AC-3.1), the positive control for the absence below.
    const rowButton = row.getByRole('button', { name: `Record hours on ${dealTaskSubject}` })
    await expect(rowButton).toBeVisible({ timeout: 30_000 })
    await expect(pageRecordHours(page)).toHaveCount(0)
    await expect(page.getByTestId('crm-record-hours-fallback')).toHaveCount(0)

    // AC-3.3: from the row the deal and the task are chosen and not changeable.
    await rowButton.click()
    const rowDialog = hoursDialog(page)
    await expect(rowDialog).toBeVisible({ timeout: 30_000 })
    await expect(rowDialog).toContainText(`Recording hours on the deal ${deal.title}.`)
    await expect(rowDialog).toContainText(dealTaskSubject)
    await expect(rowDialog).toContainText('Hours are recorded on this task.')
    await expect(rowDialog.getByTestId('hours-activity-select')).toHaveCount(0)
    await expect(rowDialog.getByTestId('hours-entry-on-deal')).toHaveCount(0)
    await expect(rowDialog.getByTestId('hours-entry-duration')).toBeFocused()
    await rowDialog.getByTestId('hours-entry-duration').fill('0.5')
    await rowDialog.getByTestId('hours-entry-dialog-submit').click()
    await rowDialog.waitFor({ state: 'detached', timeout: 30_000 })
    // The message is in the row, on its own line, after the buttons (design S3).
    const message = row.getByTestId('hours-record-hours-message')
    await expect(message).toBeVisible()
    await expect(message).toContainText(`30 min recorded on ${deal.title}.`)
    const assigneeEntries = (await entriesOn(assignee, today)).map(detailOf)
    expect(assigneeEntries).toHaveLength(1)
    expect(assigneeEntries[0]!.minutes).toBe(30)
    expect(assigneeEntries[0]!.on).toMatchObject({ type: 'deal', id: deal.id })
    expect(assigneeEntries[0]!.activity?.id).toBe(dealTaskId)
    await assigneeCtx.close()

    // AC-2.2 / AC-3.1: a reader who is neither the owner nor on any task is offered nothing, header or row.
    const readerCtx = await personContext(browser, reader)
    const readerPage = await readerCtx.newPage()
    await openDeal(readerPage, deal)
    await expect(readerPage.getByTestId(`crm-activity-${dealTaskId}`)).toBeVisible({ timeout: 30_000 })
    await recordHoursSettled(readerPage)
    await expect(pageRecordHours(readerPage)).toHaveCount(0)
    await expect(readerPage.getByTestId('hours-record-hours')).toHaveCount(0)
    await readerCtx.close()
  })

  // ─── C ────────────────────────────────────────────────────────────────────

  test("C: a project task's assignee records from the Tasks card row and the entry points at the task (AC-3.1, 3.2)", async ({
    browser,
  }) => {
    const ctx = await personContext(browser, member)
    const page = await ctx.newPage()
    await openProject(page, project)
    const row = page.getByTestId(`project-task-${projectTaskId}`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    const button = row.getByRole('button', { name: `Record hours on ${projectTaskSubject}` })
    await expect(button).toBeVisible({ timeout: 30_000 })

    const started = Date.now()
    await button.click()
    const dialog = hoursDialog(page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    console.log(`[T13] C: Record hours on a task row opened its dialog in ${Date.now() - started} ms`)
    // AC-3.2: the project and the task are chosen and not changeable.
    await expect(dialog).toContainText(`Recording hours on the project ${project.name}.`)
    await expect(dialog).toContainText(projectTaskSubject)
    await expect(dialog).toContainText("Hours are recorded on this task. It can't be changed here.")
    await expect(dialog.getByTestId('hours-activity-select')).toHaveCount(0)
    await expect(dialog.getByTestId('hours-entry-on-project')).toHaveCount(0)
    await expect(dialog.getByTestId('hours-entry-duration')).toBeFocused()
    await dialog.getByTestId('hours-entry-duration').fill('1')
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await dialog.waitFor({ state: 'detached', timeout: 30_000 })

    const message = row.getByTestId('hours-record-hours-message')
    await expect(message).toContainText(`1 h recorded on ${project.name}.`)
    await expect(button).toBeFocused()
    // × dismisses and gives the focus back to the row's button (design S3).
    await row.getByTestId('hours-record-hours-dismiss').click()
    await expect(message).toHaveCount(0)
    await expect(button).toBeFocused()

    const taskEntries = (await entriesOn(member, today))
      .map(detailOf)
      .filter((entry) => entry.activity?.id === projectTaskId)
    expect(taskEntries).toHaveLength(1)
    expect(taskEntries[0]!.minutes).toBe(60)
    expect(taskEntries[0]!.on).toMatchObject({ type: 'project', id: project.id })
    await ctx.close()
  })

  // ─── D ────────────────────────────────────────────────────────────────────

  test('D: a CRM company task with no deal records other work with a category and no task (AC-3.4, 3.5)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, assignee)
    const page = await ctx.newPage()
    await page.goto(`/crm/companies/${company.id}`)
    const row = page.getByTestId(`crm-activity-${companyTaskId}`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    const button = row.getByRole('button', { name: `Record hours on ${companyTaskSubject}` })
    await expect(button).toBeVisible({ timeout: 30_000 })

    await button.click()
    const dialog = hoursDialog(page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    // AC-3.4: other work, no category chosen (A3), no way to change what it is on, no task.
    await expect(dialog).toContainText(
      'This task is about a company, not a deal, so its hours are recorded as other work.',
    )
    await expect(dialog.getByTestId('hours-entry-on-none')).toHaveCount(0)
    await expect(dialog.getByTestId('hours-activity-select')).toHaveCount(0)
    await expect(dialog.getByTestId('hours-entry-category')).toHaveValue('')
    await expect(dialog.getByTestId('hours-entry-duration')).toBeFocused()

    // Saving with no category is refused on the field, and nothing is saved.
    await dialog.getByTestId('hours-entry-duration').fill('1.5')
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Choose a category.')
    // (the assignee holds journey B's deal entry today: only other work is looked at here)
    const otherWork = async () => (await entriesOn(assignee, today)).filter((entry) => entry.on.type === 'none')
    expect(await otherWork()).toHaveLength(0)

    await dialog.getByTestId('hours-entry-category').selectOption(administration.id)
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await dialog.waitFor({ state: 'detached', timeout: 30_000 })
    await expect(row.getByTestId('hours-record-hours-recorded')).toHaveText(
      `1 h 30 recorded on other work: ${administration.name}.`,
    )

    // AC-3.5: other work with the category the person picked, and no link to the company or the task.
    const saved = (await otherWork()).map(detailOf)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.minutes).toBe(90)
    expect(saved[0]!.on).toMatchObject({ type: 'none', category: { id: administration.id } })
    expect(saved[0]!.activity).toBeNull()
    expect(JSON.stringify(saved[0])).not.toContain(company.id)
    expect(JSON.stringify(saved[0])).not.toContain(companyTaskId)
    await ctx.close()
  })

  // ─── E ────────────────────────────────────────────────────────────────────

  test("E: with hours-ui's remoteEntry.js aborted, the project page, the deal page and My tasks load and show the My hours link (AC-4.5)", async ({
    browser,
  }) => {
    // The remote-failure.spec.ts pattern: every request to the hours remote's origin fails at the network.
    const aborted: string[] = []
    const failOnHours = async (page: Page): Promise<void> => {
      await page.route(`${HOURS_REMOTE_ORIGIN}/**`, (route) => {
        aborted.push(route.request().url())
        return route.abort('failed')
      })
    }

    // The project page, as a team member.
    const memberCtx = await personContext(browser, member)
    const projectPage = await memberCtx.newPage()
    await failOnHours(projectPage)
    await openProject(projectPage, project)
    const projectLink = projectPage.getByTestId('record-hours-fallback').first()
    await expect(projectLink).toBeVisible({ timeout: 30_000 })
    await expect(projectLink).toHaveAttribute('href', '/hours')
    await expect(projectLink).toHaveText('Record hours in My hours')
    await expect(pageRecordHours(projectPage)).toHaveCount(0)
    // The page works as before: the facts, the Tasks card with its row, and the row's own link.
    await expect(projectPage.getByTestId('project-facts')).toBeVisible()
    const taskRow = projectPage.getByTestId(`project-task-${projectTaskId}`)
    await expect(taskRow).toContainText(projectTaskSubject)
    await expect(taskRow.getByTestId('record-hours-fallback')).toBeVisible()
    expect(aborted.length, 'the failure was injected at the hours remote').toBeGreaterThan(0)

    // My tasks: the assignee's row carries the link; the list works.
    const tasksPage = await memberCtx.newPage()
    await failOnHours(tasksPage)
    await tasksPage.goto('/projects/tasks')
    await expect(tasksPage.getByTestId('my-tasks-page')).toBeVisible({ timeout: 30_000 })
    const myRow = tasksPage.getByTestId(`my-task-${projectTaskId}`)
    await expect(myRow).toBeVisible({ timeout: 30_000 })
    await expect(myRow.getByTestId('record-hours-fallback')).toBeVisible({ timeout: 30_000 })
    await expect(myRow.getByTestId('record-hours-fallback')).toHaveAttribute('href', '/hours')
    await memberCtx.close()

    // The deal page, as the deal's owner.
    const ownerCtx = await personContext(browser, owner)
    const dealPage = await ownerCtx.newPage()
    await failOnHours(dealPage)
    await openDeal(dealPage, deal)
    const dealLink = dealPage.getByTestId('crm-record-hours-fallback')
    await expect(dealLink).toBeVisible({ timeout: 30_000 })
    await expect(dealLink).toHaveAttribute('href', '/hours')
    await expect(dealPage.getByTestId('crm-deal-facts')).toBeVisible()
    await expect(pageRecordHours(dealPage)).toHaveCount(0)
    await ownerCtx.close()
  })

  // ─── F ────────────────────────────────────────────────────────────────────

  test('F: the table view, week: the List and back, Next unavailable, two projects over three days; an empty cell does nothing, Add hours in a cell records, Edit changes, Delete asks first, and the figures follow without a reload (AC-5.1, 5.2, 5.5, 5.13, 5.14, 5.16–5.20, 5.28, 5.32)', async ({
    browser,
  }) => {
    // Three projects, the person on each team; named so that alpha, beta, gamma sort in that order.
    const made = async (label: string): Promise<ProjectRow> =>
      setTeamViaApi(admin, await createProjectViaApi(admin, `Hip F ${label} ${runId}`), [weeker.userId])
    const alpha = await made('alpha')
    const beta = await made('beta')
    const gamma = await made('gamma')
    const days = Array.from({ length: 7 }, (_, index) => addDays(lastMonday, index))
    const [mon, tue, wed, thu, fri] = days as [string, string, string, string, string, string, string]

    // The week is last week, so all seven days are in the past whatever day today is. Two projects over three days…
    await createEntryViaApi(weeker, { day: mon, minutes: 120, on: { type: 'project', id: alpha.id } })
    // …two of them on alpha's Monday, so that one cell holds two entries (its figure is their sum, AC-5.9, AC-5.15).
    await createEntryViaApi(weeker, {
      day: mon,
      minutes: 60,
      on: { type: 'project', id: alpha.id },
      note: `Hip F second ${runId}`,
    })
    const alphaWed = await createEntryViaApi(weeker, {
      day: wed,
      minutes: 180,
      on: { type: 'project', id: alpha.id },
    })
    const betaTue = await createEntryViaApi(weeker, {
      day: tue,
      minutes: 90,
      on: { type: 'project', id: beta.id },
    })
    await createEntryViaApi(weeker, { day: wed, minutes: 120, on: { type: 'project', id: beta.id } })
    // …and one other-work entry, to see the order of the kinds (projects first).
    await createEntryViaApi(weeker, { day: fri, minutes: 60, on: { type: 'none', categoryId: training.id } })
    // …and this week's own: one entry today on alpha, so the current week has a row to read the future days against.
    await createEntryViaApi(weeker, { day: today, minutes: 30, on: { type: 'project', id: alpha.id } })

    const ctx = await personContext(browser, weeker)
    const page = await ctx.newPage()
    const cell = (key: string, day: string): Locator => page.locator(`[data-cell="${key}:${day}"]`)
    const rowOf = (key: string): Locator => page.getByTestId(`hours-table-row-${key}`)
    const lastCell = (row: Locator): Locator => row.getByRole('cell').last()
    const dayTotals = (): Locator => page.getByTestId('hours-table-row-total')
    const alphaKey = `project:${alpha.id}`
    const betaKey = `project:${beta.id}`
    const gammaKey = `project:${gamma.id}`
    const otherKey = `category:${training.id}`

    // AC-5.1 (reversed 2026-11-19): My hours opens on the table view, this week, with a Table | List switch.
    await page.goto('/hours')
    await expect(page.getByTestId('hours-my-page')).toBeVisible({ timeout: 30_000 })
    const switcher = page.getByTestId('hours-view-switch')
    await expect(switcher.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true')
    await expect(switcher.getByRole('tab', { name: 'List' })).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByTestId('hours-table-heading')).toHaveText(weekLabel(currentMonday), { timeout: 30_000 })
    await expect(page.getByTestId('hours-entries')).toHaveCount(0)

    // AC-5.2 and AC-5.4: the first contract's address of the week (`?view=week`) still opens this week.
    await page.goto('/hours?view=week')
    await expect(page.getByTestId('hours-table')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('hours-table-heading')).toHaveText(weekLabel(currentMonday))
    await expect(page.getByTestId('hours-period-current')).toHaveAttribute('aria-disabled', 'true')
    // AC-5.28: the future is not browsed, so Next is unavailable on the current week, and pressing it does nothing (a
    // forced click: Playwright will not click what is `aria-disabled`, and the point is what the page does when it is).
    const next = page.getByTestId('hours-period-next')
    await expect(next).toHaveAttribute('aria-disabled', 'true')
    const urlOnTheCurrentWeek = page.url()
    await next.click({ force: true })
    await page.waitForTimeout(400)
    expect(page.url()).toBe(urlOnTheCurrentWeek)
    await expect(page.getByTestId('hours-table-heading')).toHaveText(weekLabel(currentMonday))
    // Seven days, Monday to Sunday (AC-5.3), today marked.
    await expect(page.getByTestId('hours-table-table').locator('thead th')).toHaveCount(9)
    await expect(page.getByTestId('hours-table-table').locator('thead')).toContainText('Today')
    // AC-5.14, AC-5.32: a day after today offers no recording (when the week has one: it has not on a Sunday).
    if (today < addDays(currentMonday, 6)) {
      await expect(cell(alphaKey, addDays(today, 1))).toHaveCount(0)
      await expect(cell(alphaKey, addDays(currentMonday, 6))).toHaveCount(0)
    }
    await expect(cell(alphaKey, today)).toHaveText('30 min')

    // The List through the switch and back (AC-5.1, 5.2): the List has its own address (`view=list`), the table is not
    // drawn under it, and the Table tab takes `view` out again and returns to this week.
    await switcher.getByRole('tab', { name: 'List' }).click()
    await expect(page).toHaveURL(/view=list/)
    await expect(switcher.getByRole('tab', { name: 'List' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('hours-entries')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('hours-table')).toHaveCount(0)
    await switcher.getByRole('tab', { name: 'Table' }).click()
    await expect(page).not.toHaveURL(/view=/)
    await expect(page.getByTestId('hours-table-heading')).toHaveText(weekLabel(currentMonday), { timeout: 30_000 })

    // AC-5.5, AC-5.28 (R18): Previous goes to last week and Next comes back to this one, which makes Next unavailable under
    // the very press that reached it: the keyboard stays on it (a real browser drops the focus of a control that becomes
    // `disabled`, which jsdom does not show; `aria-disabled` keeps it). Then Previous again, for the figures.
    await page.getByTestId('hours-period-previous').click()
    await expect(page).toHaveURL(new RegExp(`week=${lastMonday}`))
    await expect(page.getByTestId('hours-table-heading')).toHaveText(weekLabel(lastMonday), { timeout: 30_000 })
    await expect(page.getByTestId('hours-period-previous')).toBeFocused()
    await expect(next).not.toHaveAttribute('aria-disabled', 'true')
    await next.click()
    await expect(page.getByTestId('hours-table-heading')).toHaveText(weekLabel(currentMonday), { timeout: 30_000 })
    await expect(next).toHaveAttribute('aria-disabled', 'true')
    await expect(next).toBeFocused()
    await page.getByTestId('hours-period-previous').click()
    await expect(page).toHaveURL(new RegExp(`week=${lastMonday}`))

    // Last week: the figures. Rows in order (projects by name, then other work), a total row last.
    await expect(page.getByTestId('hours-table-heading')).toHaveText(weekLabel(lastMonday), { timeout: 30_000 })
    await expect(page.getByTestId('hours-period-current')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(next).not.toHaveAttribute('aria-disabled', 'true')
    await expect(cell(alphaKey, mon)).toHaveText('3 h', { timeout: 30_000 })
    await expect(cell(alphaKey, wed)).toHaveText('3 h')
    await expect(cell(betaKey, tue)).toHaveText('1 h 30')
    await expect(cell(betaKey, wed)).toHaveText('2 h')
    await expect(cell(otherKey, fri)).toHaveText('1 h')
    const bodyRows = page.getByTestId('hours-table-table').locator('tbody tr')
    await expect(bodyRows).toHaveCount(4)
    await expect(bodyRows.nth(0)).toContainText(alpha.name)
    await expect(bodyRows.nth(1)).toContainText(beta.name)
    await expect(bodyRows.nth(2)).toContainText(training.name)
    await expect(bodyRows.nth(3)).toContainText('Total')
    await expect(lastCell(rowOf(alphaKey))).toHaveText('6 h')
    await expect(lastCell(rowOf(betaKey))).toHaveText('3 h 30')
    await expect(lastCell(rowOf(otherKey))).toHaveText('1 h')
    await expect(lastCell(dayTotals())).toHaveText('10 h 30')
    // Day totals (the cells after the row header): Mon 3 h, Tue 1 h 30, Wed 5 h, Thu —, Fri 1 h, Sat —, Sun —, then the week.
    const totals = (await dayTotals().getByRole('cell').allInnerTexts()).map((text) => text.trim())
    expect(totals).toEqual(['3 h', '1 h 30', '5 h', '—', '1 h', '—', '—', '10 h 30'])

    // AC-5.32 (AC-5.12 withdrawn): an empty cell is not a control, on a past day too; a click on it opens nothing.
    await page.evaluate(() => {
      ;(window as unknown as { __hipSameDocument: boolean }).__hipSameDocument = true
    })
    await expect(cell(alphaKey, thu)).toHaveCount(0)
    const alphaThuTd = rowOf(alphaKey).getByRole('cell').nth(3)
    await expect(alphaThuTd).toHaveText('')
    await alphaThuTd.click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // AC-5.15: a cell of two entries lists both, as the List does; its figure is their sum.
    await cell(alphaKey, mon).click()
    const monDialog = page.getByRole('dialog', { name: `Project: ${alpha.name}` })
    await expect(monDialog).toBeVisible()
    await expect(monDialog).toContainText('Monday')
    await expect(monDialog).toContainText('2 entries, 3 h')
    await expect(monDialog).toContainText(`Hip F second ${runId}`)
    await expect(monDialog.getByRole('button', { name: /^Edit/ })).toHaveCount(2)

    // AC-5.13 / AC-5.18 / AC-5.20: Add hours in the cell's list records, with the cell's day and row set and still
    // changeable, and the figures follow without a reload.
    await monDialog.getByTestId('hours-table-cell-add').click()
    const record = hoursDialog(page)
    await expect(record).toBeVisible({ timeout: 30_000 })
    await expect(record.getByTestId('hours-entry-day')).toHaveValue(mon)
    await expect(record.getByTestId('hours-entry-day')).toBeEnabled()
    // The row's project is chosen, and still a choice (My hours' own dialog, not a fixed one).
    await expect(record.getByTestId('hours-entry-on-project')).toBeChecked()
    await expect(record.getByTestId('hours-entry-project-input')).toHaveValue(alpha.name)
    await expect(record.getByTestId('hours-entry-duration')).toBeFocused()
    await record.getByTestId('hours-entry-day').fill(thu)
    await record.getByTestId('hours-entry-duration').fill('1')
    await record.getByTestId('hours-entry-dialog-submit').click()
    await record.waitFor({ state: 'detached', timeout: 30_000 })
    await expect(cell(alphaKey, thu)).toHaveText('1 h', { timeout: 30_000 })
    await expect(lastCell(rowOf(alphaKey))).toHaveText('7 h')
    await expect(lastCell(dayTotals())).toHaveText('11 h 30')
    expect((await dayTotals().getByRole('cell').allInnerTexts())[3]!.trim()).toBe('1 h')
    expect(await page.evaluate(() => (window as unknown as { __hipSameDocument?: boolean }).__hipSameDocument)).toBe(
      true,
    )
    expect((await entriesOn(weeker, thu)).filter((entry) => entry.on.id === alpha.id)).toHaveLength(1)
    // The cell dialog is still open on Monday, which the new entry did not change, and the keyboard is back on Add hours.
    await expect(monDialog).toBeVisible()
    await expect(monDialog).toContainText('2 entries, 3 h')
    await expect(monDialog.getByTestId('hours-table-cell-add')).toBeFocused()
    await monDialog.getByTestId('hours-table-cell-done').click()
    await expect(monDialog).toHaveCount(0)
    await expect(cell(alphaKey, mon)).toBeFocused() // Escape or Close: back on the cell that opened it

    // AC-5.16: a cell's Edit changes one entry (PATCH), and the cell dialog stays on it.
    await cell(alphaKey, wed).click()
    const cellDialog = page.getByRole('dialog', { name: `Project: ${alpha.name}` })
    await expect(cellDialog).toBeVisible()
    await expect(cellDialog).toContainText('3 h')
    await cellDialog.getByTestId(`hours-entry-${alphaWed.id}-edit`).click()
    await expect(page.getByTestId('hours-entry-duration')).toBeVisible()
    await page.getByTestId('hours-entry-duration').fill('3.5')
    await page.getByTestId('hours-entry-dialog-submit').click()
    await expect(page.getByTestId('hours-entry-duration')).toHaveCount(0, { timeout: 30_000 })
    await expect(cellDialog).toBeVisible()
    await expect(cellDialog).toContainText('3 h 30')
    await expect(cellDialog.getByTestId(`hours-entry-${alphaWed.id}-edit`)).toBeFocused()
    await cellDialog.getByTestId('hours-table-cell-done').click()
    await expect(cellDialog).toHaveCount(0)
    await expect(cell(alphaKey, wed)).toHaveText('3 h 30', { timeout: 30_000 })
    await expect(lastCell(rowOf(alphaKey))).toHaveText('7 h 30')
    await expect(lastCell(dayTotals())).toHaveText('12 h')
    expect((await ownEntriesViaApi(weeker, wed, wed)).find((entry) => entry.id === alphaWed.id)?.minutes).toBe(210)

    // AC-5.17: Delete asks first. Cancel sends nothing; Confirm deletes, the cell empties and the dialog closes.
    await cell(betaKey, tue).click()
    const betaDialog = page.getByRole('dialog', { name: `Project: ${beta.name}` })
    await expect(betaDialog).toBeVisible()
    await betaDialog.getByTestId(`hours-entry-${betaTue.id}-delete`).click()
    const confirm = page.getByTestId('hours-entry-delete-dialog-confirm')
    await expect(confirm).toBeVisible()
    await page.getByTestId('hours-entry-delete-dialog-cancel').click()
    await expect(confirm).toHaveCount(0)
    expect((await ownEntriesViaApi(weeker, tue, tue)).some((entry) => entry.id === betaTue.id)).toBe(true)
    await betaDialog.getByTestId(`hours-entry-${betaTue.id}-delete`).click()
    await confirm.click()
    await expect(betaDialog).toHaveCount(0, { timeout: 30_000 })
    // The cell is blank now (no control), and the keyboard is on the card's heading, never on <body> (AC-5.32).
    await expect(cell(betaKey, tue)).toHaveCount(0, { timeout: 30_000 })
    await expect(rowOf(betaKey).getByRole('cell').nth(1)).toHaveText('')
    await expect(page.getByTestId('hours-table-heading')).toBeFocused()
    await expect(lastCell(rowOf(betaKey))).toHaveText('2 h')
    await expect(lastCell(dayTotals())).toHaveText('10 h 30')
    expect((await ownEntriesViaApi(weeker, tue, tue)).some((entry) => entry.id === betaTue.id)).toBe(false)

    // AC-5.19: recording on something with no hours that week, with the page's Record hours, adds its row.
    await expect(rowOf(gammaKey)).toHaveCount(0)
    await page.getByTestId('hours-record').click()
    const header = hoursDialog(page)
    await expect(header).toBeVisible({ timeout: 30_000 })
    await header.getByTestId('hours-entry-day').fill(fri)
    await header.getByTestId('hours-entry-duration').fill('1')
    await header.getByTestId('hours-entry-on-project').check()
    await header.getByTestId('hours-entry-project-input').fill(gamma.name)
    await page.getByTestId(`hours-entry-project-input-option-${gamma.id}`).click()
    await header.getByTestId('hours-entry-dialog-submit').click()
    await header.waitFor({ state: 'detached', timeout: 30_000 })
    await expect(rowOf(gammaKey)).toBeVisible({ timeout: 30_000 })
    await expect(cell(gammaKey, fri)).toHaveText('1 h')
    await expect(page.getByTestId('hours-table-table').locator('tbody tr').nth(2)).toContainText(gamma.name) // after beta, before other work
    await expect(lastCell(dayTotals())).toHaveText('11 h 30')
    expect(await page.evaluate(() => (window as unknown as { __hipSameDocument?: boolean }).__hipSameDocument)).toBe(
      true,
    )

    // A save on a day outside the week shown says so (design S7), and the week itself is not changed by it.
    await page.getByTestId('hours-record').click()
    const outside = hoursDialog(page)
    await expect(outside).toBeVisible({ timeout: 30_000 })
    await outside.getByTestId('hours-entry-duration').fill('0.5')
    await outside.getByTestId('hours-entry-on-project').check()
    await outside.getByTestId('hours-entry-project-input').fill(gamma.name)
    await page.getByTestId(`hours-entry-project-input-option-${gamma.id}`).click()
    await outside.getByTestId('hours-entry-dialog-submit').click()
    await outside.waitFor({ state: 'detached', timeout: 30_000 })
    await expect(page.getByTestId('hours-entry-saved')).toContainText(
      `${dmy(today)} is outside the week you are viewing.`,
    )
    await expect(lastCell(dayTotals())).toHaveText('11 h 30')

    await expect(page.getByTestId('hours-table-heading')).toHaveText(weekLabel(lastMonday))
    await ctx.close()

    // Out-of-band: the person's own hours of last week are exactly what the grid said.
    const mine = await ownEntriesViaApi(weeker, lastMonday, addDays(lastMonday, 6))
    expect(mine.reduce((sum, entry) => sum + entry.minutes, 0)).toBe(690)
  })
})

// ═══ G (T24): the table view's addresses, the month, the date field and the widths ═══════════════════════════════════════
//
// A describe of its own, with its own run id and people: the first describe's `afterAll` removes every person of ITS run.

// ─── The spec's rules for a period, written here again (R21): hours-ui is not imported ───────────────────────────────

type Period = { kind: 'week'; monday: string } | { kind: 'month'; month: string }
const weekOf = (monday: string): Period => ({ kind: 'week', monday })
const monthPeriod = (month: string): Period => ({ kind: 'month', month })

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** `YYYY-MM` of a day. */
const monthKey = (day: string): string => day.slice(0, 7)
/** The month `by` months from `month`, by the calendar (January − 1 is the December before). */
const shiftMonth = (month: string, by: number): string => {
  const [year, number] = month.split('-').map(Number) as [number, number]
  const index = year * 12 + (number - 1) + by
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}
const lengthOfMonth = (month: string): number => {
  const [year, number] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(year, number, 0)).getUTCDate()
}
const daysOfMonth = (month: string): string[] =>
  Array.from({ length: lengthOfMonth(month) }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`)
const daysOfWeek = (monday: string): string[] => Array.from({ length: 7 }, (_, index) => addDays(monday, index))
const daysOfPeriod = (period: Period): string[] =>
  period.kind === 'week' ? daysOfWeek(period.monday) : daysOfMonth(period.month)
/** The place of a day in its own week, Monday 0: from the date, never from a column. */
const weekdayIndex = (day: string): number => (dayOf(day).getUTCDay() + 6) % 7
/** The card's heading for a period: "Week 16.11.2026 – 22.11.2026", "November 2026". */
const periodHeading = (period: Period): string =>
  period.kind === 'week'
    ? weekLabel(period.monday)
    : `${MONTH_NAMES[Number(period.month.slice(5)) - 1]} ${period.month.slice(0, 4)}`
/** "Thursday 1 October 2026": what a cell button and a month's column header call a day. */
const longDate = (day: string): string =>
  `${WEEKDAYS[weekdayIndex(day)]} ${Number(day.slice(8))} ${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`

/**
 * AC-5.26 (D25): Month from a week shows the month holding today when the week is the current one, else the month holding
 * the week's Monday. A current week that straddles two months (Mon 30 Nov – Sun 6 Dec, today 2 December) shows December.
 */
const monthForWeek = (monday: string): string => monthKey(monday === currentMonday ? today : monday)

/**
 * AC-5.27 (D26): Week from a month shows the week the month was reached from (`left`: the address's week, the current one
 * when it names none) when any of its seven days is in the month; else the current week when any of its days is in the
 * month; else the first week whose Monday is in the month (November 2026, which begins on a Sunday: Monday 2 November).
 */
const weekForMonth = (month: string, left: string): string => {
  const holds = (monday: string): boolean => daysOfWeek(monday).some((day) => monthKey(day) === month)
  if (holds(left)) return left
  if (holds(currentMonday)) return currentMonday
  const first = `${month}-01`
  return addDays(first, (7 - weekdayIndex(first)) % 7)
}

/** The screen's short duration for a number of minutes ("2 h", "1 h 30", "30 min"). */
const shortDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours === 0 ? `${rest} min` : rest === 0 ? `${hours} h` : `${hours} h ${rest}`
}

// ─── What a grid must say, folded from what the journey recorded ─────────────────────────────────────────────────────

/** One entry a journey recorded: its row (`project:<id>`, `category:<id>`), its day and its minutes. */
interface Seeded {
  row: string
  day: string
  minutes: number
}

/** What the grid says, by the figures it holds (a cell is `<row>:<day>=<figure>`), as `snapshotOf` reads it from the page. */
interface GridSnapshot {
  /** Column headers: the row label, one per day and Total. */
  columns: number
  cells: string[]
  rowTotals: string[]
  /** One per day, "—" for none, then the period's total in `total`. */
  dayTotals: string[]
  total: string
}

/** The grid the person's entries make over `days` (AC-5.6, 5.9, 5.10 by hand), or `null` when none falls on them: the empty period. */
function expectedSnapshot(seeded: readonly Seeded[], days: readonly string[]): GridSnapshot | null {
  const inside = seeded.filter((entry) => days.includes(entry.day))
  if (inside.length === 0) return null
  const sums = (key: (entry: Seeded) => string): Map<string, number> => {
    const map = new Map<string, number>()
    for (const entry of inside) map.set(key(entry), (map.get(key(entry)) ?? 0) + entry.minutes)
    return map
  }
  const byCell = sums((entry) => `${entry.row}:${entry.day}`)
  const byRow = sums((entry) => entry.row)
  const byDay = sums((entry) => entry.day)
  return {
    columns: days.length + 2,
    cells: [...byCell].map(([key, minutes]) => `${key}=${shortDuration(minutes)}`).sort(),
    rowTotals: [...byRow].map(([key, minutes]) => `${key}=${shortDuration(minutes)}`).sort(),
    dayTotals: days.map((day) => (byDay.has(day) ? shortDuration(byDay.get(day)!) : '—')),
    total: shortDuration(inside.reduce((sum, entry) => sum + entry.minutes, 0)),
  }
}

/** The grid as the page draws it, or `null` while there is none (loading, empty, error). */
async function snapshotOf(page: Page): Promise<GridSnapshot | null> {
  const table = page.getByTestId('hours-table-table')
  try {
    if ((await table.count()) === 0) return null
    return await table.evaluate((element) => {
      const text = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
      const total = element.querySelector('tbody tr[data-testid="hours-table-row-total"]')
      const dataRows = Array.from(element.querySelectorAll('tbody tr')).filter((row) => row !== total)
      const lastTd = (row: Element): Element | undefined => Array.from(row.querySelectorAll('td')).at(-1)
      const totalCells = Array.from(total?.querySelectorAll('td') ?? []).map((node) => text(node))
      return {
        columns: element.querySelectorAll('thead th').length,
        cells: Array.from(element.querySelectorAll('[data-cell]'))
          .map((node) => `${(node as HTMLElement).dataset['cell']}=${text(node)}`)
          .sort(),
        rowTotals: dataRows
          .map((row) => `${row.getAttribute('data-testid')!.replace('hours-table-row-', '')}=${text(lastTd(row))}`)
          .sort(),
        dayTotals: totalCells.slice(0, -1),
        total: totalCells.at(-1) ?? '',
      }
    })
  } catch {
    return null // the table went away between the count and the read: a read in progress
  }
}

/**
 * The card shows `period`: its heading, and either its grid with every figure the journey's entries make (one comparison of
 * the whole snapshot: columns, cells, row totals, day totals, grand total) or, when none falls in it, the empty state. A
 * grid that is shown must carry no error banner.
 */
async function expectPeriodShown(page: Page, period: Period, seeded: readonly Seeded[]): Promise<void> {
  await expect(page.getByTestId('hours-table-heading')).toHaveText(periodHeading(period), { timeout: 30_000 })
  const expected = expectedSnapshot(seeded, daysOfPeriod(period))
  if (expected === null) {
    await expect(page.getByTestId('hours-table-empty')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('hours-table-table')).toHaveCount(0)
  } else {
    await expect
      .poll(() => snapshotOf(page), { timeout: 30_000, message: `the grid of ${periodHeading(period)}` })
      .toEqual(expected)
  }
  await expect(page.getByTestId('hours-table-error')).toHaveCount(0)
}

/** Widths in px of the tool's own frame and a page's root: what AC-5.33 says must not change. */
interface Widths {
  shell: number
  main: number
  root: number
}
async function widthsOf(page: Page, rootTestId: string): Promise<Widths> {
  return page.evaluate((root) => {
    const width = (node: Element | null): number => (node ? node.getBoundingClientRect().width : Number.NaN)
    const shell = document.querySelector('[data-testid="hours-shell"]')
    return {
      shell: width(shell),
      main: width(shell?.querySelector('.tool-main') ?? null),
      root: width(document.querySelector(`[data-testid="${root}"]`)),
    }
  }, rootTestId)
}

/** The box of a locator, or a failure that says which one had none (a hidden or detached element). */
async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error(`no box for ${String(locator)}`)
  return box
}

/** A context signed in as `session`, in en-GB (the date field reads dd/mm/yyyy whatever the machine's own locale is). */
async function gContext(
  browser: Browser,
  session: SeededSession,
  viewport?: { width: number; height: number },
): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: 'en-GB', ...(viewport ? { viewport } : {}) })
  await signInContext(context, session)
  return context
}

/** Everything `session` recorded since `from`, deleted in parallel batches (a person deletes their OWN entries only). */
async function deleteAllQuietly(session: SeededSession, from: string): Promise<void> {
  try {
    const entries = await ownEntriesViaApi(session, from, todayZurich())
    for (let start = 0; start < entries.length; start += 10) {
      await Promise.all(
        entries
          .slice(start, start + 10)
          .map((entry) => hoursCall(session, 'DELETE', `/time-entries/${encodeURIComponent(entry.id)}`)),
      )
    }
  } catch {
    // cleanup must never fail a run
  }
}

// ─── A name that does not fit (QE pass 4, D1) ────────────────────────────────

/**
 * What leaves `container`'s box sideways: the elements whose rectangle does, and the ones whose own text runs past their right
 * edge (a block holding a run of text with no break in it is as wide as the run, which its `scrollWidth` says and its rectangle
 * does not). Visually hidden text (a 1 px clip) is not drawn and is not counted. An empty list is the answer.
 */
async function spillsOf(container: Locator): Promise<string[]> {
  return container.evaluate((root) => {
    const frame = root.getBoundingClientRect()
    const found: string[] = []
    if (root.scrollWidth > root.clientWidth + 1)
      found.push(`the box itself holds ${root.scrollWidth} px of content in ${root.clientWidth} px`)
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      const box = element.getBoundingClientRect()
      if (box.width <= 1 && box.height <= 1) continue
      const what = `${element.tagName.toLowerCase()}${element.dataset['testid'] ? `[${element.dataset['testid']}]` : ''}`
      if (box.left < frame.left - 1 || box.right > frame.right + 1)
        found.push(
          `${what} spans ${Math.round(box.left)}–${Math.round(box.right)} px, outside ${Math.round(frame.left)}–${Math.round(frame.right)} px`,
        )
      else if (element.clientWidth > 1 && element.scrollWidth > element.clientWidth + 1)
        found.push(`${what} holds ${element.scrollWidth} px of text in ${element.clientWidth} px`)
    }
    return found
  })
}

/**
 * The words of the text inside `locator` that a line break falls inside. A word is a run of characters with no space and no
 * hyphen (a hyphen is a place a line may end); a word shown whole is one rectangle, a word broken across lines is two. An
 * ordinary name must come out empty: only a run wider than its box may be broken.
 */
async function brokenWordsOf(locator: Locator): Promise<string[]> {
  return locator.evaluate((root) => {
    const broken: string[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const word of (node.textContent ?? '').matchAll(/[^\s-]+/g)) {
        const range = document.createRange()
        range.setStart(node, word.index)
        range.setEnd(node, word.index + word[0].length)
        if (range.getClientRects().length > 1) broken.push(word[0])
      }
    }
    return broken
  })
}

/**
 * What stops each control from being used, by name: not inside the window sideways, or covered at its centre (the element on
 * top there is not the control or something inside it). Empty when every control can be pressed. The ancestors that scroll
 * vertically are moved to the control's row first, and only those: `scrollIntoView` would also scroll a box sideways, which
 * is exactly what a control pushed out of the window needs, and would hide the defect (G.7's hit test does the same).
 */
async function unreachableOf(controls: Record<string, Locator>): Promise<string[]> {
  const problems: string[] = []
  for (const [name, control] of Object.entries(controls)) {
    const problem = await control.evaluate((element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (node.scrollHeight <= node.clientHeight || !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) continue
        const frame = node.getBoundingClientRect()
        const at = element.getBoundingClientRect()
        node.scrollTop += at.top + at.height / 2 - (frame.top + node.clientHeight / 2)
      }
      // A link that wraps onto two lines is two boxes, and the centre of the one rectangle around both can be blank: each
      // fragment is held to the window, and the first one is what is pressed.
      const boxes = Array.from(element.getClientRects())
      const outside = boxes.find((box) => box.left < 0 || box.right > window.innerWidth)
      if (outside !== undefined)
        return `is at ${Math.round(outside.left)}–${Math.round(outside.right)} px in a ${window.innerWidth} px window`
      const box = boxes[0] ?? element.getBoundingClientRect()
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return top !== null && (top === element || element.contains(top))
        ? null
        : `is covered at its centre by ${top === null ? 'nothing' : top.tagName.toLowerCase()}`
    })
    if (problem !== null) problems.push(`${name} ${problem}`)
  }
  return problems
}

const gRunId = newRunId()
/** This month, and last month: the one the journey's entries are in. */
const thisMonth = monthKey(today)
const lastMonth = shiftMonth(thisMonth, -1)
/** A day in the middle of last month, its first and its last day. */
const midLastMonth = `${lastMonth}-15`
const firstOfLastMonth = `${lastMonth}-01`
const lastOfLastMonth = `${lastMonth}-${String(lengthOfMonth(lastMonth)).padStart(2, '0')}`
const tomorrow = addDays(today, 1)
/**
 * The days after today that G.3 offers the date field. Tomorrow is inside the period being shown on most days (a Thursday's
 * tomorrow is in the same week and the same month), so a field that accepted it would navigate nowhere and tomorrow alone
 * could not fail on those days (QE pass 4, O3). Next Monday is always in another week and the 1st of next month always in
 * another month, whatever today is: in either period one of them is outside it, so a field that took a future day would
 * show or ask for another period on any day the suite runs.
 */
const futureDays = [...new Set([tomorrow, addDays(currentMonday, 7), `${shiftMonth(thisMonth, 1)}-01`])]

test.describe('specs/20261116-record-hours-in-place T24: the table view — addresses, week and month, the date field, widths', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let gAdmin: SeededSession
  let gper: HoursPerson // the person with entries on two projects in last month and one today
  let heavy: HoursPerson // R13: 300 entries in last month
  let wide: HoursPerson // G.7: hours on a project whose name is 200 unbroken characters
  let training: CategoryRow
  let administration: CategoryRow
  let alpha: ProjectRow
  let beta: ProjectRow
  /** Everything `gper` recorded, as the grid must say it. */
  let gSeeded: Seeded[]
  /** G.8's task (its subject is a 200-character name): deleted afterwards, as the first describe's tasks are. */
  let g8TaskId: string | undefined

  const alphaKey = (): string => `project:${alpha.id}`
  const betaKey = (): string => `project:${beta.id}`
  const cell = (page: Page, key: string, day: string): Locator => page.locator(`[data-cell="${key}:${day}"]`)

  test.beforeAll(async () => {
    gAdmin = await hoursAdmin(gRunId, PREFIX)
    gper = await seedHoursPerson('gper', SALES, gRunId, PREFIX)
    heavy = await seedHoursPerson('heavy', SALES, gRunId, PREFIX)
    wide = await seedHoursPerson('wide', SALES, gRunId, PREFIX)
    ;[training, administration] = await pickCategories(gAdmin)
    const team = [gper.userId, heavy.userId]
    alpha = await setTeamViaApi(gAdmin, await createProjectViaApi(gAdmin, `Hip G alpha ${gRunId}`), team)
    beta = await setTeamViaApi(gAdmin, await createProjectViaApi(gAdmin, `Hip G beta ${gRunId}`), team)

    // Two projects on a day of last month (the 15th), the first and the last day of last month on alpha (both ends of the
    // month's columns), and one today.
    gSeeded = [
      { row: alphaKey(), day: midLastMonth, minutes: 120 },
      { row: betaKey(), day: midLastMonth, minutes: 90 },
      { row: alphaKey(), day: firstOfLastMonth, minutes: 60 },
      { row: alphaKey(), day: lastOfLastMonth, minutes: 30 },
      { row: alphaKey(), day: today, minutes: 60 },
    ]
    for (const entry of gSeeded) {
      await createEntryViaApi(gper, {
        day: entry.day,
        minutes: entry.minutes,
        on: { type: 'project', id: entry.row.slice('project:'.length) },
      })
    }
    // The admin's own hours, so that the pages measured at AC-5.33 hold a grid: one hour of Training today.
    await createEntryViaApi(gAdmin, { day: today, minutes: 60, on: { type: 'none', categoryId: training.id } })
  })

  test.afterAll(async () => {
    if (gAdmin && g8TaskId)
      await apiCall(ACTIVITIES_API_URL, gAdmin, 'DELETE', `/activities/${encodeURIComponent(g8TaskId)}`).catch(
        () => undefined,
      )
    for (const person of [gper, heavy, wide, gAdmin]) if (person) await deleteAllQuietly(person, firstOfLastMonth)
    await cleanupPeople(gRunId)
  })

  // ─── G.1 ──────────────────────────────────────────────────────────────────

  test('G.1: the addresses open the view and the period they name; a week or a month after the current one opens the current one (AC-5.2, 5.29)', async ({
    browser,
  }) => {
    const ctx = await gContext(browser, gper)
    const page = await ctx.newPage()
    const switcher = page.getByTestId('hours-view-switch')
    const next = page.getByTestId('hours-period-next')

    // The List has an address of its own.
    await page.goto('/hours?view=list')
    await expect(page.getByTestId('hours-my-page')).toBeVisible({ timeout: 30_000 })
    await expect(switcher.getByRole('tab', { name: 'List' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('hours-entries')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('hours-table')).toHaveCount(0)

    // A week by a day in it (the first contract's `?view=week&week=`, any day of the week): the week holding it, whose
    // Monday is not the day named, with the two entries of that day in their cells.
    const pastWeek = addDays(midLastMonth, -weekdayIndex(midLastMonth))
    await page.goto(`/hours?view=week&week=${midLastMonth}`)
    await expect(switcher.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('hours-period-switch-week')).toBeChecked()
    await expectPeriodShown(page, weekOf(pastWeek), gSeeded)
    await expect(cell(page, alphaKey(), midLastMonth)).toHaveText('2 h')
    await expect(cell(page, betaKey(), midLastMonth)).toHaveText('1 h 30')
    // A past week offers its way back to the present.
    await expect(next).not.toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('hours-period-current')).not.toHaveAttribute('aria-disabled', 'true')

    // A month by its key: seven or more weeks of columns, the same two entries, and the other entries of that month.
    await page.goto(`/hours?view=month&month=${lastMonth}`)
    await expect(page.getByTestId('hours-period-switch-month')).toBeChecked()
    await expectPeriodShown(page, monthPeriod(lastMonth), gSeeded)
    await expect(cell(page, alphaKey(), midLastMonth)).toHaveText('2 h')
    await expect(cell(page, betaKey(), midLastMonth)).toHaveText('1 h 30')

    // AC-5.29: an address naming a week or a month after the current one opens the current one, Next unavailable.
    const nextMonday = addDays(currentMonday, 7)
    for (const address of [
      `/hours?week=${nextMonday}`,
      `/hours?week=${addDays(nextMonday, 3)}`,
      '/hours?week=2999-12-31',
    ]) {
      await page.goto(address)
      await expectPeriodShown(page, weekOf(currentMonday), gSeeded)
      await expect(next).toHaveAttribute('aria-disabled', 'true')
      await expect(page.getByTestId('hours-period-current')).toHaveAttribute('aria-disabled', 'true')
    }
    for (const address of [`/hours?view=month&month=${shiftMonth(thisMonth, 1)}`, '/hours?view=month&month=2999-01']) {
      await page.goto(address)
      await expect(page.getByTestId('hours-period-switch-month')).toBeChecked()
      await expectPeriodShown(page, monthPeriod(thisMonth), gSeeded)
      await expect(next).toHaveAttribute('aria-disabled', 'true')
      await expect(page.getByTestId('hours-period-current')).toHaveAttribute('aria-disabled', 'true')
    }
    await ctx.close()
  })

  // ─── G.2 ──────────────────────────────────────────────────────────────────

  test('G.2: Month from the current week, Previous, Week; Month and Week again from past weeks; every day a column, Next unavailable on the current month, an empty cell does nothing (AC-5.25–5.28, 5.32; R13 first grid logged)', async ({
    browser,
  }) => {
    const ctx = await gContext(browser, gper)
    const page = await ctx.newPage()
    const heading = page.getByTestId('hours-table-heading')
    const next = page.getByTestId('hours-period-next')
    const previous = page.getByTestId('hours-period-previous')
    const monthRadio = page.getByTestId('hours-period-switch-month')
    const weekRadio = page.getByTestId('hours-period-switch-week')

    // The current week, Week selected.
    await page.goto('/hours')
    await expect(weekRadio).toBeChecked({ timeout: 30_000 })
    await expectPeriodShown(page, weekOf(currentMonday), gSeeded)
    await expect(cell(page, alphaKey(), today)).toHaveText('1 h')

    // AC-5.26: Month shows the month of the current week by the rule (the month holding today). The radio keeps the focus
    // (design S7), the address says the month, and the first grid of a month is timed (R13: logged, never asserted).
    const startedMonth = performance.now()
    await monthRadio.check()
    const thisMonthPeriod = monthPeriod(monthForWeek(currentMonday))
    await expect(page.getByTestId('hours-table-table').locator('thead th')).toHaveCount(lengthOfMonth(thisMonth) + 2, {
      timeout: 30_000,
    })
    console.log(
      `[T24] G.2 R13: the month's first grid (${periodHeading(thisMonthPeriod)}, ${gSeeded.length} entries held) ` +
        `${Math.round(performance.now() - startedMonth)} ms from the press of Month to the grid drawn`,
    )
    await expect(monthRadio).toBeFocused()
    await expectPeriodShown(page, thisMonthPeriod, gSeeded)
    // AC-5.25: every day of the month is a column (a header per day, the row label and Total besides), today marked.
    await expect(page.getByTestId('hours-table-table').locator('thead th')).toHaveCount(lengthOfMonth(thisMonth) + 2)
    await expect(page.getByTestId('hours-table-table').locator('thead')).toContainText('Today')
    // AC-5.28 in the month: the current month has no Next, the return is as unavailable, and a press changes nothing.
    await expect(next).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByTestId('hours-period-current')).toHaveAttribute('aria-disabled', 'true')
    const urlOnTheCurrentMonth = page.url()
    await next.click({ force: true })
    await page.waitForTimeout(400)
    expect(page.url()).toBe(urlOnTheCurrentMonth)
    await expect(heading).toHaveText(periodHeading(thisMonthPeriod))

    // Previous: last month, with its entries on both ends of the month and in its middle, and their totals by hand.
    await previous.click()
    await expect(previous).toBeFocused()
    await expectPeriodShown(page, monthPeriod(lastMonth), gSeeded)
    expect(new URL(page.url()).searchParams.get('view')).toBe('month')
    expect(new URL(page.url()).searchParams.get('month')).toBe(lastMonth)
    await expect(cell(page, alphaKey(), midLastMonth)).toHaveText('2 h')
    await expect(cell(page, betaKey(), midLastMonth)).toHaveText('1 h 30')
    await expect(cell(page, alphaKey(), firstOfLastMonth)).toHaveText('1 h')
    await expect(cell(page, alphaKey(), lastOfLastMonth)).toHaveText('30 min')
    const lastTd = (row: Locator): Locator => row.getByRole('cell').last()
    await expect(lastTd(page.getByTestId(`hours-table-row-${alphaKey()}`))).toHaveText('3 h 30')
    await expect(lastTd(page.getByTestId(`hours-table-row-${betaKey()}`))).toHaveText('1 h 30')
    await expect(lastTd(page.getByTestId('hours-table-row-total'))).toHaveText('5 h')
    // A day is named by its date, never by its column (R17): the month's first day is a weekday of its own, whatever
    // weekday the first column would be.
    await expect(cell(page, alphaKey(), firstOfLastMonth)).toHaveAttribute(
      'aria-label',
      new RegExp(`, ${longDate(firstOfLastMonth)}, 1 entry$`),
    )
    await expect(page.getByTestId('hours-table-table').locator('thead th').nth(1)).toContainText(
      longDate(firstOfLastMonth),
    )
    await expect(page.getByTestId('hours-table-table').locator('thead th').nth(lengthOfMonth(lastMonth))).toContainText(
      longDate(lastOfLastMonth),
    )

    // AC-5.32: an empty cell is plain text in a `td`, on a past day too: no control, no tab stop, and a click opens nothing.
    const emptyDay = `${lastMonth}-02`
    expect(emptyDay === firstOfLastMonth || emptyDay === midLastMonth || emptyDay === lastOfLastMonth).toBe(false)
    const alphaRow = page.getByTestId(`hours-table-row-${alphaKey()}`)
    const emptyTd = alphaRow.getByRole('cell').nth(1) // the second day of the month
    await expect(emptyTd).toHaveText('')
    await expect(cell(page, alphaKey(), emptyDay)).toHaveCount(0)
    await expect(emptyTd.locator('button, a, input, [tabindex]')).toHaveCount(0)
    expect(await emptyTd.evaluate((td) => (td as HTMLElement).tabIndex)).toBe(-1)
    await emptyTd.click()
    await page.waitForTimeout(300)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // AC-5.28 / R18 once more, in the month: Next reaches the current month and keeps the keyboard, unavailable.
    await next.click()
    await expectPeriodShown(page, monthPeriod(thisMonth), gSeeded)
    await expect(next).toHaveAttribute('aria-disabled', 'true')
    await expect(next).toBeFocused()
    await previous.click()
    await expectPeriodShown(page, monthPeriod(lastMonth), gSeeded)

    // AC-5.27: Week shows the week the month was reached from when it has a day in the month; else the current week when it
    // has; else the first week whose Monday is in the month. Here the month was reached from the current week.
    await weekRadio.check()
    const afterMonth = weekForMonth(lastMonth, currentMonday)
    await expectPeriodShown(page, weekOf(afterMonth), gSeeded)
    await expect(weekRadio).toBeFocused()

    // Past weeks, week → Month → Week (AC-5.26, AC-5.27): the week holding the 15th, and the week holding the 1st (whose
    // Monday may be in the month before). Month is the month of the Monday; Week comes back to the week it left, past
    // weeks included.
    for (const day of [midLastMonth, firstOfLastMonth]) {
      const left = addDays(day, -weekdayIndex(day))
      await page.goto(`/hours?week=${left}`)
      await expectPeriodShown(page, weekOf(left), gSeeded)
      await page.getByTestId('hours-period-switch-month').check()
      const month = monthForWeek(left)
      await expectPeriodShown(page, monthPeriod(month), gSeeded)
      await page.getByTestId('hours-period-switch-week').check()
      await expectPeriodShown(page, weekOf(weekForMonth(month, left)), gSeeded)
      expect(weekForMonth(month, left)).toBe(left) // the rule's own answer: the week left has a day in the month
    }
    await ctx.close()
  })

  // ─── G.3 ──────────────────────────────────────────────────────────────────

  for (const kind of ['week', 'month'] as const) {
    test(`G.3 (${kind}): the date field offers no day after today, refuses one, and a day of last month picked or typed key by key shows its ${kind} (AC-5.30, 5.31, R16)`, async ({
      browser,
    }) => {
      const ctx = await gContext(browser, gper)
      const page = await ctx.newPage()
      const field = page.getByTestId('hours-period-date')
      const heading = page.getByTestId('hours-table-heading')
      const holding = (day: string): Period =>
        kind === 'week' ? weekOf(addDays(day, -weekdayIndex(day))) : monthPeriod(monthKey(day))
      const current = holding(today)
      const last = holding(midLastMonth)
      const open = async (): Promise<void> => {
        await page.goto(kind === 'week' ? '/hours' : '/hours?view=month')
        await expectPeriodShown(page, current, gSeeded)
      }
      const tableReads: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'GET' && /\/time-entries\?/.test(request.url())) tableReads.push(request.url())
      })

      await open()
      // AC-5.31: the field offers no day after today, in either period; it opens on today, the current period's day.
      await expect(field).toHaveAttribute('max', today)
      await expect(field).toHaveValue(today)

      // AC-5.31: a day after today, however it got there, shows nothing new and reads nothing; the field gives the period's
      // own day back once it loses the keyboard. Tomorrow, next Monday and the 1st of next month: at least one of them is in
      // another period than the one shown, on any day (QE pass 4, O3), so the step fails for a field that accepts a day
      // after today whatever today is, and the address is asked about as well as the heading and the reads.
      const shownAt = page.url()
      for (const future of futureDays) {
        tableReads.length = 0
        await field.fill(future)
        await page.waitForTimeout(500)
        expect(tableReads, `${future}, a day after today, asks nothing of hours-api`).toEqual([])
        await expect(heading, `${future}, a day after today, shows the period it was on`).toHaveText(
          periodHeading(current),
        )
        expect(page.url(), `${future}, a day after today, leaves the address as it was`).toBe(shownAt)
        await field.blur()
        await expect(field).toHaveValue(today)
      }

      // AC-5.30: a day of last month, picked (the value the native picker writes), shows the period holding it, at once.
      await field.fill(midLastMonth)
      await expectPeriodShown(page, last, gSeeded)
      await expect(cell(page, alphaKey(), midLastMonth)).toHaveText('2 h')
      await expect(cell(page, betaKey(), midLastMonth)).toHaveText('1 h 30')
      await expect(field).toBeFocused() // the keyboard stays where the person was (design F7)
      await expect(field).toHaveAttribute('max', today)

      // AC-5.30, R16: the same day typed key by key, in a fresh page. The days the field passes through on its way (the day 15
      // over today's period, then the month, then the year 0002, 0020, 0202, 2026) are complete days or days no one can show:
      // those in range navigate and the next aborts them, those out of range do nothing, and what has been typed is never
      // written over. Two ways round, both in a real Chromium: (1) fast keys over SLOW reads, so every read is in flight while
      // the person goes on typing; (2) slow keys over fast reads, so a read lands and the page re-renders under a half-typed
      // date. Only the final period is asserted, never how many reads it took (they are logged).
      const [year, month, day] = midLastMonth.split('-') as [string, string, string]
      for (const { keyDelay, readDelay } of [
        { keyDelay: 60, readDelay: 700 },
        { keyDelay: 250, readDelay: 0 },
      ]) {
        await open()
        await page.route(/\/time-entries\?/, async (route) => {
          if (readDelay > 0) await new Promise((resolve) => setTimeout(resolve, readDelay))
          await route.continue().catch(() => undefined)
        })
        tableReads.length = 0
        await field.click({ position: { x: 8, y: 12 } }) // the first segment: dd (en-GB: dd/mm/yyyy)
        await page.keyboard.type(`${day}${month}${year}`, { delay: keyDelay })
        // The typed value is there still: it was not written over by the navigations and reads the typing caused.
        await expect(field).toHaveValue(midLastMonth)
        await expectPeriodShown(page, last, gSeeded)
        await expect(field).toHaveValue(midLastMonth)
        await expect(page.getByTestId('hours-table-error')).toHaveCount(0)
        console.log(
          `[T24] G.3 (${kind}) typed ${day}${month}${year} at ${keyDelay} ms a key over ${readDelay} ms reads: ` +
            `${tableReads.length} read(s) asked for ${tableReads.map((url) => new URL(url).searchParams.get('from')).join(', ')}`,
        )
        await page.unroute(/\/time-entries\?/)
      }

      // The field loses the keyboard: it says the period it is on again (its first day: the Monday of the week, the 1st of the month).
      await field.blur()
      await expect(field).toHaveValue(
        kind === 'week' ? addDays(midLastMonth, -weekdayIndex(midLastMonth)) : firstOfLastMonth,
      )
      await expect(heading).toHaveText(periodHeading(last))
      await ctx.close()
    })
  }

  // ─── G.4 ──────────────────────────────────────────────────────────────────

  test("G.4: as an admin at 1440 and 1920 px, the tool container and each page's root are full width and one width over the List, the week, the month, Everyone's hours and Settings (AC-5.33)", async ({
    browser,
  }) => {
    const ctx = await gContext(browser, gAdmin, { width: 1440, height: 900 })
    const page = await ctx.newPage()
    const settled = {
      list: async () => {
        await expect(page.getByTestId('hours-entries')).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId('hours-entries-skeleton')).toHaveCount(0)
      },
      table: async () => {
        await expect(page.getByTestId('hours-table-table')).toBeVisible({ timeout: 30_000 })
      },
      everyone: async () => {
        await expect(page.getByTestId('hours-everyone-gate-skeleton')).toHaveCount(0, { timeout: 30_000 })
        await expect(page.getByTestId('hours-entries')).toBeVisible({ timeout: 30_000 })
        await expect(page.getByTestId('hours-entries-skeleton')).toHaveCount(0, { timeout: 30_000 })
      },
      settings: async () => {
        await expect(page.getByTestId('time-lists-loaded')).toBeVisible({ timeout: 30_000 })
      },
    }
    const pages: Array<{ name: string; url: string; root: string; settle: () => Promise<void> }> = [
      { name: 'List', url: '/hours?view=list', root: 'hours-my-page', settle: settled.list },
      { name: 'the week', url: '/hours', root: 'hours-my-page', settle: settled.table },
      { name: 'the month', url: '/hours?view=month', root: 'hours-my-page', settle: settled.table },
      { name: "Everyone's hours", url: '/hours/all', root: 'hours-everyone-page', settle: settled.everyone },
      { name: 'Settings', url: '/hours/settings', root: 'time-lists-page', settle: settled.settings },
    ]
    // 1440 px is the width the AC is measured at. There the shell leaves the tool a frame of about 1210 px, narrower than the
    // default column's 80 rem (1280 px), so one width at 1440 would hold for the default column too: the same pages are measured
    // again at 1920 px, where the frame is wider than that cap and a page that kept it would measure narrower than its frame.
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport)
      const measured: Array<Widths & { name: string }> = []
      for (const target of pages) {
        await page.goto(target.url)
        await expect(page.getByTestId(target.root)).toBeVisible({ timeout: 30_000 })
        await target.settle()
        measured.push({ name: target.name, ...(await widthsOf(page, target.root)) })
      }
      console.log(
        `[T24] G.4 widths at ${viewport.width} px (shell frame / tool container / page root): ` +
          measured.map((entry) => `${entry.name} ${entry.shell}/${entry.main}/${entry.root}`).join(', '),
      )
      for (const entry of measured) {
        const at = `${entry.name} at ${viewport.width} px`
        if (viewport.width === 1920) {
          // The instrument is proved before it is trusted: this window leaves the tool more than the default column.
          expect(entry.shell, `${at}: the tool's frame is wider than the default column`).toBeGreaterThan(1280)
        }
        // Full width: the container takes everything its frame has, as EstimAI's workspace does (C1) …
        expect(entry.main, `${at}: the tool container is as wide as its frame`).toBeCloseTo(entry.shell, 0)
        // … and a page's root fills the container's own content box (its gutter is 24 px a side).
        expect(entry.root, `${at}: the page fills the container`).toBeCloseTo(entry.main - 48, 0)
      }
      // One width: switching view, period or tab changes neither the container nor the page.
      const mains = measured.map((entry) => entry.main)
      const roots = measured.map((entry) => entry.root)
      expect(
        Math.max(...mains) - Math.min(...mains),
        `tool container widths at ${viewport.width} px: ${mains}`,
      ).toBeLessThanOrEqual(1)
      expect(
        Math.max(...roots) - Math.min(...roots),
        `page root widths at ${viewport.width} px: ${roots}`,
      ).toBeLessThanOrEqual(1)
    }

    // The same without a reload: through the tabs and the switches the tool's own frame is the one it was.
    await page.goto('/hours')
    await expect(page.getByTestId('hours-table-table')).toBeVisible({ timeout: 30_000 })
    const before = await widthsOf(page, 'hours-my-page')
    await page.getByTestId('hours-period-switch-month').check()
    await expect(page.getByTestId('hours-table-table').locator('thead th')).toHaveCount(lengthOfMonth(thisMonth) + 2, {
      timeout: 30_000,
    })
    await page.getByRole('tab', { name: 'List' }).click()
    await expect(page.getByTestId('hours-entries')).toBeVisible({ timeout: 30_000 })
    const after = await widthsOf(page, 'hours-my-page')
    expect(Math.abs(after.main - before.main)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.root - before.root)).toBeLessThanOrEqual(1)
    await ctx.close()
  })

  // ─── G.5 ──────────────────────────────────────────────────────────────────

  test('G.5: at 1280 px the month scrolls inside its region and the page does not; every day is reachable; a focused cell is never hidden under a pinned column (AC-5.34, R-D3)', async ({
    browser,
  }) => {
    const ctx = await gContext(browser, gper, { width: 1280, height: 800 })
    const page = await ctx.newPage()
    const regionOf = (): Locator => page.getByTestId('hours-table').locator('.table-region')
    const headers = (): Locator => page.getByTestId('hours-table-table').locator('thead th')
    const days = lengthOfMonth(lastMonth)

    // The week first: its tool container is the reference the month must keep.
    await page.goto('/hours')
    await expect(page.getByTestId('hours-table-table')).toBeVisible({ timeout: 30_000 })
    const week = await widthsOf(page, 'hours-my-page')

    await page.goto(`/hours?view=month&month=${lastMonth}`)
    await expectPeriodShown(page, monthPeriod(lastMonth), gSeeded)
    const region = regionOf()
    await expect(region).toHaveCount(1)
    const month = await widthsOf(page, 'hours-my-page')
    // The page's own width does not change with the month, and nothing scrolls the page sideways …
    expect(month.main, 'the tool container of the month is the one of the week').toBeCloseTo(week.main, 0)
    expect(month.root, 'the page root of the month is the one of the week').toBeCloseTo(week.root, 0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    // … the table scrolls inside its own, focusable and labelled, region.
    const metrics = await region.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      tabIndex: (element as HTMLElement).tabIndex,
      role: element.getAttribute('role'),
      label: element.getAttribute('aria-label'),
    }))
    console.log(
      `[T24] G.5 the month's region at 1280 px: scrollWidth ${metrics.scrollWidth}, clientWidth ${metrics.clientWidth}`,
    )
    expect(metrics.scrollWidth, 'the month is wider than its region').toBeGreaterThan(metrics.clientWidth)
    expect(metrics.role).toBe('region')
    expect(metrics.tabIndex).toBe(0)
    expect(metrics.label).toContain(periodHeading(monthPeriod(lastMonth)))

    // Every day can be reached: at the start the first day's header sits clear of the pinned label column, at the end the last
    // day's header sits clear of the pinned Total, and neither is outside the region.
    const label = headers().first()
    const total = headers().last()
    const clearOfPins = async (header: Locator): Promise<void> => {
      const box = await boxOf(header)
      const labelBox = await boxOf(label)
      const totalBox = await boxOf(total)
      const regionBox = await boxOf(region)
      expect(box.x, 'not under the pinned label').toBeGreaterThanOrEqual(labelBox.x + labelBox.width - 1)
      expect(box.x + box.width, 'not under the pinned Total').toBeLessThanOrEqual(totalBox.x + 1)
      expect(box.x + box.width, 'inside the region').toBeLessThanOrEqual(regionBox.x + regionBox.width + 1)
    }
    await region.evaluate((element) => (element.scrollLeft = 0))
    await clearOfPins(headers().nth(1))
    await region.evaluate((element) => (element.scrollLeft = element.scrollWidth))
    await clearOfPins(headers().nth(days))
    await expect(headers().nth(days)).toContainText(longDate(lastOfLastMonth))
    // The pins hold: the label and Total columns did not move while the days scrolled under them.
    expect((await boxOf(label)).x).toBeCloseTo((await boxOf(region)).x, 0)

    // R-D3 / WCAG 2.4.11: a focused cell is never hidden under a pinned column. The region is at its end; focusing the
    // first day's cell scrolls it back into the clear, and Tab and Shift+Tab along the row keep every cell clear of both.
    const alphaCell = (day: string): Locator => cell(page, alphaKey(), day)
    const slack: string[] = []
    const clearOfPinnedColumns = async (target: Locator): Promise<void> => {
      await expect(target).toBeFocused()
      const name = (await target.getAttribute('data-cell'))!.split(':').slice(-1)[0]!
      const row = target.locator('xpath=ancestor::tr')
      const box = await boxOf(target)
      const labelBox = await boxOf(row.locator('th').first())
      const totalBox = await boxOf(row.getByRole('cell').last())
      const left = box.x - (labelBox.x + labelBox.width) // the room between the pinned label and the cell
      const right = totalBox.x - (box.x + box.width) // and between the cell and the pinned Total
      slack.push(`${name}: ${Math.round(left)} px / ${Math.round(right)} px`)
      expect(left, `${name}: the cell is not under the pinned label`).toBeGreaterThanOrEqual(-1)
      expect(right, `${name}: the cell is not under the pinned Total`).toBeGreaterThanOrEqual(-1)
    }
    await region.evaluate((element) => (element.scrollLeft = element.scrollWidth))
    const scrolledToTheEnd = await region.evaluate((element) => element.scrollLeft)
    expect(scrolledToTheEnd, 'the region is scrolled away from its start').toBeGreaterThan(0)
    await alphaCell(firstOfLastMonth).focus()
    // The browser had to scroll the first day's cell back into view, and it did so clear of the pinned label.
    expect(await region.evaluate((element) => element.scrollLeft)).toBeLessThan(scrolledToTheEnd)
    await clearOfPinnedColumns(alphaCell(firstOfLastMonth))
    await page.keyboard.press('Tab')
    await clearOfPinnedColumns(alphaCell(midLastMonth))
    await page.keyboard.press('Tab')
    await clearOfPinnedColumns(alphaCell(lastOfLastMonth))
    await page.keyboard.press('Shift+Tab')
    await clearOfPinnedColumns(alphaCell(midLastMonth))
    await page.keyboard.press('Shift+Tab')
    await clearOfPinnedColumns(alphaCell(firstOfLastMonth))
    console.log(`[T24] G.5 room between a focused cell and the pinned columns (label / Total): ${slack.join(', ')}`)
    await ctx.close()
  })

  // ─── G.6 ──────────────────────────────────────────────────────────────────

  test('G.6 (R13): a past month of 300 own entries: its first grid time is logged, and its figures are the entries’ sums', async ({
    browser,
  }) => {
    test.setTimeout(300_000)
    // 300 entries over last month on four rows (two projects, two kinds of other work), scattered over its days and rows.
    const rows: Array<{ row: string; on: unknown }> = [
      { row: alphaKey(), on: { type: 'project', id: alpha.id } },
      { row: betaKey(), on: { type: 'project', id: beta.id } },
      { row: `category:${training.id}`, on: { type: 'none', categoryId: training.id } },
      { row: `category:${administration.id}`, on: { type: 'none', categoryId: administration.id } },
    ]
    const monthDays = daysOfMonth(lastMonth)
    const seeded: Seeded[] = []
    const bodies: unknown[] = []
    for (let index = 0; index < 300; index += 1) {
      const target = rows[(index + Math.floor(index / monthDays.length)) % rows.length]!
      const day = monthDays[index % monthDays.length]!
      const minutes = 30 * (1 + (index % 3))
      seeded.push({ row: target.row, day, minutes })
      bodies.push({ day, minutes, on: target.on })
    }
    const seeding = performance.now()
    for (let start = 0; start < bodies.length; start += 10) {
      await Promise.all(bodies.slice(start, start + 10).map((body) => createEntryViaApi(heavy, body)))
    }
    console.log(`[T24] G.6 R13: 300 entries recorded through the API in ${Math.round(performance.now() - seeding)} ms`)
    expect(await ownEntriesViaApi(heavy, firstOfLastMonth, lastOfLastMonth)).toHaveLength(300)

    const ctx = await gContext(browser, heavy)
    const page = await ctx.newPage()
    // The current month first (the person has nothing in it), so that Previous is a month read, as a person does it.
    await page.goto('/hours?view=month')
    await expect(page.getByTestId('hours-table-empty')).toBeVisible({ timeout: 30_000 })
    const started = performance.now()
    await page.getByTestId('hours-period-previous').click()
    await expect(page.getByTestId('hours-table-table').locator('thead th')).toHaveCount(monthDays.length + 2, {
      timeout: 60_000,
    })
    const firstGrid = Math.round(performance.now() - started)
    console.log(
      `[T24] G.6 R13: first grid of ${periodHeading(monthPeriod(lastMonth))} with 300 entries, ${monthDays.length} days, ` +
        `${rows.length} rows: ${firstGrid} ms from Previous to the grid drawn` +
        (firstGrid > 800 ? ' (above the 800 ms that R13 reports; not a failure)' : ''),
    )
    // The figures are the entries' sums (AC-5.9, 5.10): every cell, every row, every day and the month.
    await expectPeriodShown(page, monthPeriod(lastMonth), seeded)
    await ctx.close()
  })

  // ─── G.7 ──────────────────────────────────────────────────────────────────

  test('G.7: a project named with 200 unbroken characters does not hide the month’s days behind the pinned label column (AC-5.34, owasp-report L1)', async ({
    browser,
  }) => {
    // A name is bounded at 200 characters (projects-api), and it is written by whoever manages the project, not by the person
    // who reads their hours: 200 characters with no space, no hyphen and no slash, so the browser has nowhere to break it.
    const digits = gRunId.replace(/\D/g, '')
    const longName = `HipLong${digits}`.padEnd(200, 'W')
    expect(longName).toHaveLength(200)
    expect(longName).toMatch(/^[A-Za-z0-9]{200}$/)
    const longProject = await setTeamViaApi(gAdmin, await createProjectViaApi(gAdmin, longName), [wide.userId])
    const longKey = `project:${longProject.id}`
    // A first, a middle and a last day: both ends of the month's columns, and the one between.
    const longDays = [firstOfLastMonth, midLastMonth, lastOfLastMonth]
    for (const day of longDays) {
      await createEntryViaApi(wide, { day, minutes: 60, on: { type: 'project', id: longProject.id } })
    }

    const ctx = await gContext(browser, wide, { width: 1280, height: 800 })
    const page = await ctx.newPage()
    const longCell = (day: string): Locator => cell(page, longKey, day)
    await page.goto(`/hours?view=month&month=${lastMonth}`)
    await expect(page.getByTestId('hours-table-table')).toBeVisible({ timeout: 30_000 })
    await expect(longCell(firstOfLastMonth)).toBeVisible({ timeout: 30_000 })
    // The row is named in full: a long name wraps, it is never cut (the label is the only place the name is read).
    await expect(page.getByTestId('hours-table-table').locator('tbody th').first()).toContainText(longName)

    const region = page.getByTestId('hours-table').locator('.table-region')
    const headers = page.getByTestId('hours-table-table').locator('thead th')
    const days = lengthOfMonth(lastMonth)
    const label = headers.first()
    const total = headers.last()

    const pinned = await boxOf(label)
    const regionBox = await boxOf(region)
    const firstButton = await boxOf(longCell(firstOfLastMonth))
    console.log(
      `[L1] G.7 at 1280 px, a 200-character row label: the pinned label column is ${Math.round(pinned.width)} px, ` +
        `the region ${Math.round(regionBox.width)} px (the first day's button at x = ${Math.round(firstButton.x)}, ` +
        `the region's right edge at x = ${Math.round(regionBox.x + regionBox.width)})`,
    )
    // The pinned column is a small part of the region, never the whole of it (a month's 31 day columns need the rest).
    expect.soft(pinned.width, 'the pinned label column leaves room for the days').toBeLessThan(regionBox.width / 3)

    // Hit-testable: the element on top at a cell's centre is that cell's own button — not the pinned label, not nothing (a point
    // outside the window has no element).
    const hitBy = async (target: Locator): Promise<string | null> => {
      // A long name wraps into a tall row, below the window's bottom edge: the ancestors that scroll vertically (the shell's
      // `<main>`, not the window) are moved to the button's row, and only those. The region's own `scrollLeft`, which is what
      // is under test, is never touched (`scrollIntoView` would move it).
      await target.evaluate((element) => {
        for (let node = element.parentElement; node; node = node.parentElement) {
          if (node.scrollHeight <= node.clientHeight || !/(auto|scroll)/.test(getComputedStyle(node).overflowY))
            continue
          const frame = node.getBoundingClientRect()
          const box = element.getBoundingClientRect()
          node.scrollTop += box.top + box.height / 2 - (frame.top + node.clientHeight / 2)
        }
      })
      const box = await boxOf(target)
      return page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-cell]')?.dataset['cell'] ?? null,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      )
    }
    await region.evaluate((element) => (element.scrollLeft = 0))
    expect
      .soft(await hitBy(longCell(firstOfLastMonth)), "the first day's button is on top at its centre")
      .toBe(`${longKey}:${firstOfLastMonth}`)

    // Every day can be reached: the last day's header clears the pinned Total, inside the region, and its button is on top.
    await region.evaluate((element) => (element.scrollLeft = element.scrollWidth))
    const lastHeader = await boxOf(headers.nth(days))
    const totalBox = await boxOf(total)
    const regionNow = await boxOf(region)
    expect
      .soft(lastHeader.x + lastHeader.width, 'the last day is not under the pinned Total')
      .toBeLessThanOrEqual(totalBox.x + 1)
    expect
      .soft(lastHeader.x + lastHeader.width, 'the last day is inside the region')
      .toBeLessThanOrEqual(regionNow.x + regionNow.width + 1)
    expect
      .soft(lastHeader.x, 'the last day is not under the pinned label')
      .toBeGreaterThanOrEqual((await boxOf(label)).x + (await boxOf(label)).width - 1)
    expect
      .soft(await hitBy(longCell(lastOfLastMonth)), "the last day's button is on top at its centre")
      .toBe(`${longKey}:${lastOfLastMonth}`)

    // By keyboard, too: focus the first day's button from the end of the region; the browser scrolls it into the clear.
    const scrolledToTheEnd = await region.evaluate((element) => element.scrollLeft)
    await longCell(firstOfLastMonth).focus()
    await expect(longCell(firstOfLastMonth)).toBeFocused()
    expect(await region.evaluate((element) => element.scrollLeft)).toBeLessThan(scrolledToTheEnd)
    expect
      .soft(await hitBy(longCell(firstOfLastMonth)), 'focused, the first day’s button is on top at its centre')
      .toBe(`${longKey}:${firstOfLastMonth}`)
    await page.keyboard.press('Tab')
    await expect(longCell(midLastMonth)).toBeFocused()
    expect
      .soft(await hitBy(longCell(midLastMonth)), "focused, the middle day's button is on top at its centre")
      .toBe(`${longKey}:${midLastMonth}`)

    // The week (not pinned) draws the same label: it wraps too, so the week still fits its region at 1280 px, where it has
    // no scroll hint (design S7), instead of scrolling past a name 2,600 px wide to reach its days.
    await page.goto(`/hours?view=week&week=${mondayOf(midLastMonth)}`)
    await expect(longCell(midLastMonth)).toBeVisible({ timeout: 30_000 })
    const weekMetrics = await region.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    const weekLabel = await boxOf(headers.first())
    console.log(
      `[L1] G.7 the week, same label: the label column is ${Math.round(weekLabel.width)} px, the region scrollWidth ` +
        `${weekMetrics.scrollWidth} px for ${weekMetrics.clientWidth} px`,
    )
    expect
      .soft(weekMetrics.scrollWidth, 'the week fits its region at 1280 px')
      .toBeLessThanOrEqual(weekMetrics.clientWidth + 1)
    expect
      .soft(await hitBy(longCell(midLastMonth)), "the week's cell is on top at its centre")
      .toBe(`${longKey}:${midLastMonth}`)
    await ctx.close()
  })

  // ─── G.8 ──────────────────────────────────────────────────────────────────

  test('G.8: a 200-character name stays inside the cell dialog, the delete confirmation, the Record hours dialog and its message, with every control on screen; an ordinary name keeps its words whole (QE pass 4, D1)', async ({
    browser,
  }) => {
    // The same input as G.7 and the same bound: a name written by the record's owner, up to 200 characters, with no space, no
    // hyphen and no slash. It is printed in the Week's and the Month's cell dialog (the title, the entry's link), in the
    // delete confirmation opened from it, in the description of the Record hours dialog and in the message that follows its
    // save, which sits in the host page's header. Each of them sizes to its content unless told otherwise, so an unwrapped
    // name pushed the cell dialog's × to x = 3,760 px of a 1,280 px window, and the message past a phone's edge and across the
    // Record hours button it answers. A name that does fit is the other half: the fix must not break an ordinary word.
    const digits = gRunId.replace(/\D/g, '')
    const longName = `HipDlg${digits}`.padEnd(200, 'W')
    expect(longName).toMatch(/^[A-Za-z0-9]{200}$/)
    const ordinaryName = `Hip Internationalisation roadmap for the regional wholesale distribution platform ${gRunId}`
    // The entry the long name's cell holds points at a task named the same way: the task's subject is printed on the entry's
    // own line (the cell dialog, the List), written by whoever made the task, up to the same bound.
    const taskSubject = `HipTask${digits}`.padEnd(200, 'T')
    const made = async (name: string, subject?: string): Promise<{ project: ProjectRow; taskId?: string }> => {
      const project = await setTeamViaApi(gAdmin, await createProjectViaApi(gAdmin, name), [wide.userId])
      let taskId: string | undefined
      if (subject !== undefined) {
        await createTaskViaApi(gAdmin, { subject, projectId: project.id, assigneeUserId: wide.userId })
        taskId = await findProjectTaskId(gAdmin, project.id, subject)
      }
      await createEntryViaApi(wide, {
        day: today,
        minutes: 60,
        on: { type: 'project', id: project.id },
        ...(taskId === undefined ? {} : { activityId: taskId }),
      })
      return { project, ...(taskId === undefined ? {} : { taskId }) }
    }
    const { project: longProject, taskId: longTaskId } = await made(longName, taskSubject)
    g8TaskId = longTaskId
    const { project: ordinaryProject } = await made(ordinaryName)

    // The Week at 1280 px, the Month at 375 px (the shell's rail collapsed: on a phone it does not collapse by itself, which is the
    // shell's own matter, so a 98 px card says nothing about these dialogs), and an ordinary name at 375 px, where it wraps.
    const runs = [
      {
        label: 'a 200-character name, 1280 px, week',
        name: longName,
        project: longProject,
        view: 'week',
        width: 1280,
        height: 800,
      },
      {
        label: 'a 200-character name, 375 px, month',
        name: longName,
        project: longProject,
        view: 'month',
        width: 375,
        height: 812,
      },
      {
        label: 'an ordinary name, 375 px, week',
        name: ordinaryName,
        project: ordinaryProject,
        view: 'week',
        width: 375,
        height: 812,
      },
    ] as const

    for (const run of runs) {
      const ctx = await gContext(browser, wide, { width: run.width, height: run.height })
      if (run.width < 768) await ctx.addInitScript(() => localStorage.setItem('operai_sidebar_collapsed', 'true'))
      const page = await ctx.newPage()
      const ordinary = run.name === ordinaryName
      // No spill, and every control usable, in one place for each placement, all reported at once (soft).
      const fits = async (placement: string, box: Locator): Promise<void> => {
        expect.soft(await spillsOf(box), `${run.label}: ${placement} stays inside its box`).toEqual([])
        if (ordinary)
          expect.soft(await brokenWordsOf(box), `${run.label}: ${placement} breaks no ordinary word`).toEqual([])
      }
      const usable = async (placement: string, controls: Record<string, Locator>): Promise<void> => {
        expect
          .soft(await unreachableOf(controls), `${run.label}: ${placement}, every control can be pressed`)
          .toEqual([])
      }

      // 1. The cell dialog, from today's cell (the keyboard opens it, as G.7's cells are reached): its title, the entry's link,
      //    Edit, Delete, Close and Add hours.
      await page.goto(run.view === 'week' ? '/hours' : '/hours?view=month')
      await expect(page.getByTestId('hours-table-table')).toBeVisible({ timeout: 30_000 })
      const todayCell = cell(page, `project:${run.project.id}`, today)
      await expect(todayCell).toBeVisible({ timeout: 30_000 })
      await todayCell.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      // The name is printed in full, wrapped and never cut.
      await expect(dialog.locator('.dialog-title')).toContainText(run.name)
      if (!ordinary) await expect(dialog).toContainText(taskSubject)
      // (A second run on the same project finds the entry its first run recorded: every entry has the link.)
      await expect(dialog.getByRole('link', { name: run.name }).first()).toBeVisible()
      const closeBox = await boxOf(dialog.getByTestId('hours-table-cell-close'))
      const titleBox = await boxOf(dialog.locator('.dialog-title'))
      console.log(
        `[D1] G.8 ${run.label}: the cell dialog's title is ${Math.round(titleBox.width)} px wide and its × at x = ${Math.round(closeBox.x)} ` +
          `in a ${run.width} px window`,
      )
      await fits('the cell dialog', dialog)
      await usable('the cell dialog', {
        'the ×': dialog.getByTestId('hours-table-cell-close'),
        'the entry link': dialog.getByRole('link', { name: run.name }).first(),
        Edit: dialog.getByRole('button', { name: /^Edit / }).first(),
        Delete: dialog.getByRole('button', { name: /^Delete / }).first(),
        Close: dialog.getByTestId('hours-table-cell-done'),
        'Add hours': dialog.getByTestId('hours-table-cell-add'),
      })

      // 2. The delete confirmation opened from the cell: the sentence, and its three controls.
      await dialog
        .getByRole('button', { name: /^Delete / })
        .first()
        .click()
      const confirmation = page.getByRole('alertdialog')
      await expect(confirmation).toBeVisible()
      await expect(confirmation).toContainText(run.name)
      await fits('the delete confirmation', confirmation)
      await usable('the delete confirmation', {
        'the ×': confirmation.getByRole('button', { name: 'Close' }),
        Cancel: confirmation.getByRole('button', { name: 'Cancel' }),
        'Delete entry': confirmation.getByRole('button', { name: 'Delete entry' }),
      })
      await confirmation.getByRole('button', { name: 'Cancel' }).click()
      await expect(confirmation).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      // 3. The List shows the same entry with the same row: the name, and for the long name the task's subject.
      await page.goto('/hours?view=list')
      const entries = page.getByTestId('hours-entries')
      await expect(entries.getByRole('link', { name: run.name }).first()).toBeVisible({ timeout: 30_000 })
      if (!ordinary) await expect(entries).toContainText(taskSubject)
      // The List holds all of the person's entries of the day, the long name's rows included: an ordinary name is judged on its
      // own row (a 200-character run is one "word", and it is meant to be broken).
      await fits('the List', ordinary ? entries.getByRole('listitem').filter({ hasText: run.name }) : entries)

      // 4. The Record hours dialog from the project's page: its description, and its three controls.
      await openProject(page, run.project)
      await pageRecordHours(page).click()
      const widget = hoursDialog(page)
      await expect(widget).toBeVisible({ timeout: 30_000 })
      await expect(widget).toContainText(`Recording hours on the project ${run.name}.`)
      await fits('the Record hours dialog', widget)
      await usable('the Record hours dialog', {
        'the ×': widget.getByRole('button', { name: 'Close' }),
        Cancel: widget.getByRole('button', { name: 'Cancel' }),
        'Save entry': widget.getByRole('button', { name: 'Save entry' }),
      })

      // 5. The message after the save, in the host's header, and the host's own Record hours button beside it.
      await widget.getByTestId('hours-entry-duration').fill('1')
      await widget.getByTestId('hours-entry-dialog-submit').click()
      await widget.waitFor({ state: 'detached', timeout: 30_000 })
      const message = page.getByTestId('hours-record-hours-message')
      await expect(message).toContainText(`1 h recorded on ${run.name}.`)
      const messageBox = await boxOf(message)
      console.log(
        `[D1] G.8 ${run.label}: the message is at x = ${Math.round(messageBox.x)}–${Math.round(messageBox.x + messageBox.width)} ` +
          `in a ${run.width} px window`,
      )
      await fits('the success message', message)
      await usable('the success message', {
        'the message': message,
        'See in My hours': message.getByRole('link'),
        'the message’s ×': page.getByTestId('hours-record-hours-dismiss'),
        'the host’s Record hours': pageRecordHours(page),
      })

      // 6. The same widget on the task's row (the long name's project has a task named the same way): its dialog shows the task's
      //    subject as a fact, and its message goes in the row, which the host sizes, not in the page's header.
      if (!ordinary) {
        const taskRow = page.getByTestId(`project-task-${longTaskId}`)
        const rowRecord = taskRow.getByRole('button', { name: /^Record hours on / })
        await rowRecord.click()
        const taskWidget = hoursDialog(page)
        await expect(taskWidget).toBeVisible({ timeout: 30_000 })
        await expect(taskWidget).toContainText(taskSubject)
        await fits('the Record hours dialog from a task row', taskWidget)
        await usable('the Record hours dialog from a task row', {
          'the ×': taskWidget.getByRole('button', { name: 'Close' }),
          Cancel: taskWidget.getByRole('button', { name: 'Cancel' }),
          'Save entry': taskWidget.getByRole('button', { name: 'Save entry' }),
        })
        await taskWidget.getByTestId('hours-entry-duration').fill('1')
        await taskWidget.getByTestId('hours-entry-dialog-submit').click()
        await taskWidget.waitFor({ state: 'detached', timeout: 30_000 })
        const rowMessage = taskRow.getByTestId('hours-record-hours-message')
        await expect(rowMessage).toContainText(`1 h recorded on ${run.name}.`)
        const rowBox = await boxOf(taskRow)
        const rowMessageBox = await boxOf(rowMessage)
        console.log(
          `[D1] G.8 ${run.label}: the task row's message is at x = ${Math.round(rowMessageBox.x)}–${Math.round(rowMessageBox.x + rowMessageBox.width)}, ` +
            `the row at ${Math.round(rowBox.x)}–${Math.round(rowBox.x + rowBox.width)}`,
        )
        // Inside the row the host drew (the row's own text is the host's, and is not judged here).
        expect
          .soft(rowMessageBox.x + rowMessageBox.width, `${run.label}: the task row's message ends inside its row`)
          .toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
        await fits("the task row's success message", rowMessage)
        await usable("the task row's success message", {
          'the message': rowMessage,
          'See in My hours': rowMessage.getByRole('link'),
          'the message’s ×': taskRow.getByTestId('hours-record-hours-dismiss'),
          'the row’s Record hours': rowRecord,
        })
      }
      await ctx.close()
    }
  })
})
