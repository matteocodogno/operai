/**
 * QE pass 2 — the fix round's regressions, driven in a REAL browser against the real stack
 * (specs/20261116-record-hours-in-place, qe-report.md D1, D2, D3).
 *
 * Why an e2e on top of the unit tests: the focus tests of hours-ui rely on `test-support/focusFixup.ts`, an emulation of
 * the browser's focus fixup rule (a control that becomes `disabled` loses focus; the document's focus falls to `<body>`).
 * jsdom has no such rule, so a unit test cannot tell the fix from its absence on its own account. Chromium does the real
 * thing, so `toBeFocused()` here is the proof that a person who pressed Save (or Confirm) keeps the keyboard.
 *
 *  R1  D1, D2 — a task row whose task was deleted since the page was drawn: the refusal is shown (the alert says the
 *      activity does not belong to the project / the deal), the dialog stays, the values are kept, and focus is on Save
 *      (Enter retries). Real activities-api and hours-api, nothing stubbed. Project Tasks card row and CRM deal timeline row.
 *  R2  D2 — a refusal that has no field (`host_unavailable`, a 500, a dropped connection) leaves focus on Save: the widget's
 *      dialog from the project page's header, and My hours' own dialog.
 *  R3  D2 — a delete that fails leaves focus on Confirm, from My hours' List and from the Week's cell dialog; a Week read that
 *      fails again puts focus on the new Retry, and one that works on the card's heading.
 *  R4  D3 — a success message shown in a task row stays when the list is re-read after a write on another row: a row marked
 *      done above it, a row deleted above it and a row inserted above it, in the project's Tasks card and in the CRM's deal
 *      timeline (the two lists use the library's `ListRows`, which must key a row by its record).
 *
 * R2 and R3 stub the answer of hours-api in the browser (the harness never breaks the service other journeys share); the focus
 * they assert is the real browser's.
 *
 * Run it like hours-in-place.spec.ts (see its header for the dev-stack ports). The people are per-run `hip-*@operai.test`;
 * everything they record is deleted afterwards, and so are the tasks the journeys made.
 */
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import {
  cleanupPeople,
  createEntryViaApi,
  deleteOwnEntriesQuietly,
  HOURS_API_URL,
  hoursAdmin,
  newRunId,
  personContext,
  pickCategories,
  seedHoursPerson,
  todayZurich,
  type CategoryRow,
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
import { ACTIVITIES_API_URL, apiCall, findCompanyActivityId, findProjectTaskId } from './helpers/activitiesFixtures'
import type { SeededSession } from './helpers/adminSession'

const runId = newRunId()
const today = todayZurich()
const PREFIX = 'hip' as const
const SALES = ['employee', 'sales']
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const addDays = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
const cleanupFrom = addDays(today, -45)

/** The entry dialog the widget opened. */
const hoursDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Record hours' })
const pageRecordHours = (page: Page): Locator => page.getByRole('button', { name: 'Record hours', exact: true })

/** Which way hours-api's answer is broken in the browser. */
type Break = 'host_unavailable' | 'internal' | 'network'

/**
 * Answers `method` requests matching `url` with a broken answer, after 300 ms: a save takes as long as a request does, so the
 * control that was pressed is disabled across at least one rendering, which is when a real browser lets go of its focus.
 */
async function breakRequests(page: Page, url: string | RegExp, method: string, how: Break): Promise<void> {
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method) return route.continue()
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (how === 'network') return route.abort('connectionrefused')
    const status = how === 'host_unavailable' ? 503 : 500
    return route.fulfill({
      status,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: how === 'host_unavailable' ? 'Service Unavailable' : 'Internal Server Error',
        status,
        ...(how === 'host_unavailable' ? { code: 'host_unavailable' } : {}),
      }),
    })
  })
}

test.describe("specs/20261116-record-hours-in-place QE pass 2: the fix round's regressions in a real browser", () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let admin: SeededSession
  let member: HoursPerson // on the project's team, assignee of the tasks of R1
  let training: CategoryRow
  let company: CompanyRow
  let project: ProjectRow
  let deal: DealRow
  const madeTasks: string[] = []

  /** A task made through the owners' APIs, remembered so the cleanup deletes it. */
  const rememberTask = (id: string): string => {
    madeTasks.push(id)
    return id
  }
  const deleteTask = (id: string): Promise<unknown> =>
    apiCall(ACTIVITIES_API_URL, admin, 'DELETE', `/activities/${encodeURIComponent(id)}`)

  test.beforeAll(async () => {
    admin = await hoursAdmin(runId, PREFIX)
    member = await seedHoursPerson('member', SALES, runId, PREFIX)
    ;[training] = await pickCategories(admin)
    company = await createCompanyViaApi(admin, `Hip R company ${runId}`)
    // The admin is on the team too: R4 records as the admin, the project's manager, on tasks assigned to them.
    project = await setTeamViaApi(admin, await createProjectViaApi(admin, `Hip R project ${runId}`), [
      member.userId,
      admin.userId,
    ])
    deal = await createDealOwnedBy(admin, company.id, `Hip R deal ${runId}`, admin.userId)
  })

  test.afterAll(async () => {
    for (const person of [member, admin]) if (person) await deleteOwnEntriesQuietly(person, cleanupFrom)
    for (const id of madeTasks) await deleteTask(id).catch(() => undefined)
    await cleanupPeople(runId)
  })

  // ─── R1 ───────────────────────────────────────────────────────────────────

  test('R1: a task deleted since the row was drawn: the refusal is shown on the project row and on the deal row, the keyboard stays on Save (D1, D2)', async ({
    browser,
  }) => {
    const projectSubject = `Hip R1 project task ${runId}`
    const dealSubject = `Hip R1 deal task ${runId}`
    await createTaskViaApi(admin, { subject: projectSubject, projectId: project.id, assigneeUserId: member.userId })
    await createTaskViaApi(admin, {
      subject: dealSubject,
      companyId: company.id,
      dealId: deal.id,
      assigneeUserId: member.userId,
    })
    // A second task of the member's on the deal stays: it is what keeps them "on one of its activities", so the refusal under
    // test is the deleted task's, not `not_involved_in_deal` (bookability is asked before the activity is).
    const anchorSubject = `Hip R1 deal anchor ${runId}`
    await createTaskViaApi(admin, {
      subject: anchorSubject,
      companyId: company.id,
      dealId: deal.id,
      assigneeUserId: member.userId,
    })
    rememberTask(await findCompanyActivityId(admin, company.id, anchorSubject))
    const projectTaskId = rememberTask(await findProjectTaskId(admin, project.id, projectSubject))
    const dealTaskId = rememberTask(await findCompanyActivityId(admin, company.id, dealSubject))

    const ctx = await personContext(browser, member)
    const page = await ctx.newPage()

    // The project's Tasks card.
    await page.goto(`/projects/${project.id}`)
    const projectRow = page.getByTestId(`project-task-${projectTaskId}`)
    await expect(projectRow).toBeVisible({ timeout: 30_000 })
    await projectRow.getByRole('button', { name: `Record hours on ${projectSubject}` }).click()
    let dialog = hoursDialog(page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByTestId('hours-entry-duration').fill('1')
    // Someone else did the task: it is gone from the owner, and the row on this page is still drawn.
    await deleteTask(projectTaskId)
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await expect(dialog.getByRole('alert')).toHaveText('This activity does not belong to the chosen project.', {
      timeout: 30_000,
    })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('hours-entry-duration')).toHaveValue('1')
    // D2 in the real browser: Save was disabled while the request ran, and the keyboard is back on it, not on <body>.
    await expect(dialog.getByTestId('hours-entry-dialog-submit')).toBeFocused({ timeout: 10_000 })
    // Enter is the retry: the same refusal, the same place.
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('alert')).toHaveText('This activity does not belong to the chosen project.')
    await expect(dialog.getByTestId('hours-entry-dialog-submit')).toBeFocused({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // The CRM deal's timeline.
    await page.goto(`/crm/deals/${deal.id}`)
    const dealRow = page.getByTestId(`crm-activity-${dealTaskId}`)
    await expect(dealRow).toBeVisible({ timeout: 30_000 })
    await dealRow.getByRole('button', { name: `Record hours on ${dealSubject}` }).click()
    dialog = hoursDialog(page)
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByTestId('hours-entry-duration').fill('1')
    await deleteTask(dealTaskId)
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await expect(dialog.getByRole('alert')).toHaveText('This activity does not belong to the chosen deal.', {
      timeout: 30_000,
    })
    await expect(dialog.getByTestId('hours-entry-duration')).toHaveValue('1')
    await expect(dialog.getByTestId('hours-entry-dialog-submit')).toBeFocused({ timeout: 10_000 })
    await ctx.close()
  })

  // ─── R2 ───────────────────────────────────────────────────────────────────

  test("R2: a refusal that has no field leaves the keyboard on Save: the project page's widget and My hours' own dialog (D2)", async ({
    browser,
  }) => {
    const ctx = await personContext(browser, member)
    const page = await ctx.newPage()
    const writes = `${HOURS_API_URL}/time-entries`

    // The widget's dialog, opened from the project page's header.
    await page.goto(`/projects/${project.id}`)
    await expect(pageRecordHours(page)).toBeVisible({ timeout: 30_000 })
    for (const how of ['host_unavailable', 'internal', 'network'] as const) {
      await breakRequests(page, writes, 'POST', how)
      await pageRecordHours(page).click()
      const dialog = hoursDialog(page)
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await dialog.getByTestId('hours-entry-duration').fill('1')
      await dialog.getByTestId('hours-entry-dialog-submit').click()
      await expect(dialog.getByRole('alert'), `${how}: the refusal is shown`).toBeVisible({ timeout: 30_000 })
      await expect(dialog.getByTestId('hours-entry-dialog-submit'), `${how}: focus is on Save`).toBeFocused({
        timeout: 10_000,
      })
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await page.unroute(writes)
    }

    // My hours' own dialog: no picker is involved, so the refusal is the dialog's one alert.
    await page.goto('/hours')
    await expect(page.getByTestId('hours-record')).toBeVisible({ timeout: 30_000 })
    for (const how of ['internal', 'network'] as const) {
      await breakRequests(page, writes, 'POST', how)
      await page.getByTestId('hours-record').click()
      const dialog = hoursDialog(page)
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await dialog.getByTestId('hours-entry-duration').fill('1')
      await dialog.getByTestId('hours-entry-on-none').check()
      await dialog.getByTestId('hours-entry-category').selectOption(training.id)
      await dialog.getByTestId('hours-entry-dialog-submit').click()
      await expect(dialog.getByRole('alert'), `My hours, ${how}: the refusal is shown`).toBeVisible({
        timeout: 30_000,
      })
      await expect(dialog.getByTestId('hours-entry-dialog-submit'), `My hours, ${how}: focus is on Save`).toBeFocused({
        timeout: 10_000,
      })
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await page.unroute(writes)
    }
    await ctx.close()
  })

  // ─── R3 ───────────────────────────────────────────────────────────────────

  test("R3: a delete that fails leaves the keyboard on Confirm, from the List and from the Week's cell dialog; a Week read that fails again focuses the new Retry, one that works the heading (D2)", async ({
    browser,
  }) => {
    const entry = await createEntryViaApi(member, {
      day: today,
      minutes: 60,
      on: { type: 'none', categoryId: training.id },
    })
    const ctx = await personContext(browser, member)
    const page = await ctx.newPage()
    const deletes = new RegExp(`^${escapeRegExp(HOURS_API_URL)}/time-entries/[^/?]+$`)
    const confirm = (): Locator => page.getByTestId('hours-entry-delete-dialog-confirm')

    // The List (`?view=list`: My hours opens on the table view since T19, AC-5.1 reversed).
    await page.goto('/hours?view=list')
    const deleteButton = page.getByTestId(`hours-entry-${entry.id}-delete`)
    await expect(deleteButton).toBeVisible({ timeout: 30_000 })
    await breakRequests(page, deletes, 'DELETE', 'internal')
    await deleteButton.click()
    await expect(confirm()).toBeVisible()
    await confirm().click()
    await expect(page.getByTestId('hours-entry-delete-dialog-error')).toBeVisible({ timeout: 30_000 })
    await expect(confirm()).toBeFocused({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(confirm()).toHaveCount(0)
    await page.unroute(deletes)

    // The Week's cell dialog: the Delete is confirmed over it. `?view=week` is the first contract's address, still read.
    await page.goto('/hours?view=week')
    const cell = page.locator(`[data-cell="category:${training.id}:${today}"]`)
    await expect(cell).toBeVisible({ timeout: 30_000 })
    await cell.click()
    await breakRequests(page, deletes, 'DELETE', 'network')
    await page.getByTestId(`hours-entry-${entry.id}-delete`).click()
    await expect(confirm()).toBeVisible()
    await confirm().click()
    await expect(page.getByTestId('hours-entry-delete-dialog-error')).toBeVisible({ timeout: 30_000 })
    await expect(confirm()).toBeFocused({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(confirm()).toHaveCount(0)
    await page.unroute(deletes)
    await page.keyboard.press('Escape') // the cell dialog
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // A Week read that fails: Retry fails again (focus on the NEW Retry), then works (focus on the card's heading).
    const reads = new RegExp(`^${escapeRegExp(HOURS_API_URL)}/time-entries\\?`)
    let failing = true
    await page.route(reads, async (route) => {
      if (route.request().method() !== 'GET' || !failing) return route.continue()
      await new Promise((resolve) => setTimeout(resolve, 300))
      return route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Internal Server Error', status: 500 }),
      })
    })
    await page.getByTestId('hours-period-previous').click()
    const retry = page.getByTestId('hours-table-error-retry')
    await expect(retry).toBeVisible({ timeout: 30_000 })
    await retry.focus()
    await page.keyboard.press('Enter') // still failing
    await expect(retry).toBeFocused({ timeout: 10_000 })
    failing = false
    await page.keyboard.press('Enter') // works
    await expect(page.getByTestId('hours-table-heading')).toBeFocused({ timeout: 30_000 })
    await expect(retry).toHaveCount(0)
    await page.unroute(reads)
    await ctx.close()
  })

  // ─── R4 ───────────────────────────────────────────────────────────────────

  test("R4: a success message in a task row survives the list's re-read after a row above it was marked done, deleted or inserted: the project's Tasks card and the CRM deal's timeline (D3)", async ({
    browser,
  }) => {
    const ctx = await personContext(browser, admin)
    const page = await ctx.newPage()
    const message = (row: Locator): Locator => row.getByTestId('hours-record-hours-message')

    /** Records 1 h from `row` and waits for the message in it. */
    const record = async (row: Locator, subject: string): Promise<void> => {
      await row.getByRole('button', { name: `Record hours on ${subject}` }).click()
      const dialog = hoursDialog(page)
      await expect(dialog).toBeVisible({ timeout: 30_000 })
      await dialog.getByTestId('hours-entry-duration').fill('1')
      await dialog.getByTestId('hours-entry-dialog-submit').click()
      await dialog.waitFor({ state: 'detached', timeout: 30_000 })
      await expect(message(row)).toHaveCount(1)
    }

    // ── The project's Tasks card: four tasks, the third (by due date) gets the message.
    const names = ['A', 'B', 'C', 'D'].map((n) => `Hip R4 task ${n} ${runId}`)
    for (const [index, subject] of names.entries()) {
      await createTaskViaApi(admin, {
        subject,
        projectId: project.id,
        assigneeUserId: admin.userId,
        dueDate: `2027-03-0${index + 1}`,
      })
    }
    const ids = await Promise.all(names.map((subject) => findProjectTaskId(admin, project.id, subject)))
    ids.forEach(rememberTask)
    const [idA, idB, idC, idD] = ids as [string, string, string, string]
    const taskRow = (id: string): Locator => page.getByTestId(`project-task-${id}`)

    await page.goto(`/projects/${project.id}`)
    await expect(taskRow(idC)).toBeVisible({ timeout: 30_000 })
    await record(taskRow(idC), names[2]!)

    // A task is made earlier than all the others (it lands first), then A is marked done: the re-read removes a row above C
    // and inserts one above it. Wait for the re-read to land before looking, or the check passes before anything changed.
    const earlySubject = `Hip R4 early ${runId}`
    await createTaskViaApi(admin, {
      subject: earlySubject,
      projectId: project.id,
      assigneeUserId: admin.userId,
      dueDate: '2027-01-01',
    })
    const earlyId = rememberTask(await findProjectTaskId(admin, project.id, earlySubject))
    await taskRow(idA).getByRole('button', { name: 'Mark done' }).click()
    await expect(taskRow(idA)).toHaveCount(0, { timeout: 30_000 })
    await expect(taskRow(earlyId)).toBeVisible({ timeout: 30_000 })
    await expect(message(taskRow(idC)), 'marked done above, and a row inserted above').toHaveCount(1)

    // B is deleted: a row removed above C.
    await taskRow(idB).getByTestId(`project-task-${idB}-delete`).click()
    await page.getByTestId('project-task-delete-confirm').click()
    await expect(taskRow(idB)).toHaveCount(0, { timeout: 30_000 })
    await expect(message(taskRow(idC)), 'deleted above').toHaveCount(1)
    await expect(taskRow(idD)).toBeVisible()

    // ── The CRM deal's timeline: three tasks (newest first); the last listed gets the message, those above it change.
    const crmSubjects = ['X', 'Y', 'Z'].map((n) => `Hip R4 deal ${n} ${runId}`)
    for (const subject of crmSubjects) {
      await createTaskViaApi(admin, {
        subject,
        companyId: company.id,
        dealId: deal.id,
        assigneeUserId: admin.userId,
      })
    }
    const crmIds = await Promise.all(crmSubjects.map((subject) => findCompanyActivityId(admin, company.id, subject)))
    crmIds.forEach(rememberTask)
    await page.goto(`/crm/deals/${deal.id}`)
    const rows = crmIds.map((id) => page.getByTestId(`crm-activity-${id}`))
    for (const row of rows) await expect(row).toBeVisible({ timeout: 30_000 })
    const order = await page
      .getByTestId('crm-activity-card')
      .locator('[data-testid^="crm-activity-"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')))
    const listed = crmIds
      .map((id, index) => ({ id, subject: crmSubjects[index]!, at: order.indexOf(`crm-activity-${id}`) }))
      .sort((a, b) => a.at - b.at)
    const [first, second, last] = listed as [(typeof listed)[number], (typeof listed)[number], (typeof listed)[number]]
    const crmRow = (id: string): Locator => page.getByTestId(`crm-activity-${id}`)
    await record(crmRow(last.id), last.subject)

    // An activity logged by someone else lands above everything on the next read; the first task is marked done (which
    // reads the list again) and the second deleted. Wait for each re-read to land before looking at the message.
    const callSubject = `Hip R4 call ${runId}`
    const call = await apiCall<{ id: string }>(ACTIVITIES_API_URL, admin, 'POST', '/activities', {
      type: 'call',
      subject: callSubject,
      companyId: company.id,
      dealId: deal.id,
    })
    expect(call.status, 'the call was logged').toBe(201)
    const callId = rememberTask(call.body.id)
    await crmRow(first.id).getByRole('button', { name: 'Mark done' }).click()
    await expect(crmRow(callId)).toBeVisible({ timeout: 30_000 })
    await expect(crmRow(first.id)).toContainText('Done', { timeout: 30_000 })
    await expect(message(crmRow(last.id)), 'marked done above, and a row inserted above').toHaveCount(1)
    await crmRow(second.id).getByRole('button', { name: 'Delete' }).click()
    await page.getByTestId('crm-activity-delete-confirm').click()
    await expect(crmRow(second.id)).toHaveCount(0, { timeout: 30_000 })
    await expect(message(crmRow(last.id)), 'deleted above').toHaveCount(1)
    await ctx.close()
  })
})
