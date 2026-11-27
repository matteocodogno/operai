/**
 * Teams on a project: end-to-end (specs/20261126-teams, T17). Refs AC-1.3, AC-4.1, AC-4.3, AC-4.6, AC-5.1, AC-5.2, AC-5.6
 * (and AC-4.7, AC-4.8 as seen from the same screens).
 *
 * Drives the REAL assembled shell + projects-ui + projects-api + auth + hours-api + activities-api; nothing is stubbed.
 *
 *   AC-4.1  a project manager (system role `project-manager`, entity welld_ch) attaches a team from Edit teams: the
 *           project's version moves and the page shows it; a stale save is 409; a project of the OTHER entity is
 *           403 `out_of_scope` and nothing changes.
 *   AC-4.3  any `projects:access` holder (a plain viewer) reads the team card: the team by name with its members, a
 *           member without access to Projects marked as such (AC-4.7) and not counted; a viewer has no Edit teams.
 *   AC-5.1  the person who is on the project only through the team is offered Record hours, records (API, accepted
 *           as for a listed member), and the person without access to Projects records nothing.
 *   AC-5.2  the project manager gives the team-only person a task from the Add task form: they are offered as assignee.
 *   AC-1.3  an administrator renames the team and the next load of the project page shows the new name.
 *   AC-4.8  the projects list filtered by that team lists only the project it is attached to.
 *   AC-4.6  an administrator removes the person from the team: within 65 s hours-api refuses a new entry on the project
 *           (403 `not_on_project`), the entry already recorded and the task already given are untouched (AC-5.1, AC-5.2).
 *   AC-5.6  one dedicated person who opens project pages past the per-person limit (120 per 10 min) gets the page with
 *           the teams marked "could not be loaded" and the "Too many requests" banner; the other people's pages are whole
 *           and the team member's recording is not refused because of it.
 *
 * What is NOT here: "once back under the limit the next load shows the teams again" needs the 10-minute window to age
 * (the in-process limiter cannot be moved from outside, and a test-only route is not product code we add); that half of
 * AC-5.6 is the unit tests' (`projects-api` `rateLimiter` / `teams.routes` with `advanceTime`).
 *
 * Re-runs: every person, team and project carries the run id, and the over-limit person is made per run, so the
 * 10-minute window of an earlier run (it lives in the running projects-api process) never meets this one's persona.
 *
 * Cleanup: hours entries and tasks the run made are deleted through their APIs, the teams are detached from the
 * projects, then the teams (direct to auth's database, `cleanupTeams`) and the people go. projects-api has no delete
 * route, so the run-tagged projects stay, as the other projects journeys' do, without a team.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  ACTIVITIES_API_URL,
  PROJECTS_API_URL,
  activitiesAdmin,
  apiCall,
  cleanupPeople,
  createProjectViaApi,
  listProjectTasksViaApi,
  newRunId,
  personContext,
  seedPerson,
  type Person,
  type ProjectRow,
} from './helpers/activitiesFixtures'
import { seedUserSession, type SeededSession } from './helpers/adminSession'
import {
  createEntryViaApi,
  deleteOwnEntriesQuietly,
  hoursCall,
  ownEntriesViaApi,
  todayZurich,
} from './helpers/hoursFixtures'
import {
  addMember,
  cleanupTeams,
  countTeams,
  createTeam,
  detachTeamsQuietly,
  putProjectTeams,
  readProject,
  removeMember,
  renameTeam,
  seedProjectManager,
  teamName,
  type TeamDetailRow,
} from './helpers/teamsFixtures'

test.describe.configure({ mode: 'serial' })

const RUN = newRunId()

let admin: Person
let pm: SeededSession
let alice: Person // on the team, projects:access, on the project only through it
let bob: SeededSession // on the team, NO access to Projects
let viewer: Person // projects:access, not on the team nor on the project
let limited: Person // the dedicated over-limit person
let team: TeamDetailRow
let renamed: string
let p1: ProjectRow
let p2: ProjectRow // a project the team is never attached to (the filter's control)
let otherEntity: ProjectRow // a welld_it project: the PM of welld_ch may not manage it
let aliceTaskId: string

const teamLabel = teamName(RUN, 'Delivery')

/** Opens a project's page as `page`'s person and waits for the Team card. */
async function openProject(page: Page, id: string): Promise<void> {
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-team')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('project-attached-teams')).toBeVisible()
}

/** The header's Record hours (a task row's button is named "Record hours on <task>"). */
const pageRecordHours = (page: Page) => page.getByRole('button', { name: 'Record hours', exact: true })

/** See hours-in-place.spec.ts `recordHoursSettled`: a "not offered" assertion means something only after the seam had its chance. */
async function recordHoursSettled(page: Page): Promise<void> {
  await expect(page.getByTestId('user-menu-trigger')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  admin = await activitiesAdmin()
  pm = await seedProjectManager(admin, `act-tm-pm-${RUN}@operai.test`, `Act tm-pm ${RUN}`, 'welld_ch')
  alice = await seedPerson('tm-alice', 'accounting', RUN)
  viewer = await seedPerson('tm-viewer', 'accounting', RUN)
  limited = await seedPerson('tm-limited', 'accounting', RUN)
  // A person with no role: signed in, active, no access to Projects.
  bob = await seedUserSession(`act-tm-bob-${RUN}@operai.test`, `Act tm-bob ${RUN}`)

  team = await createTeam(admin, teamLabel, 'Created by the projects-teams e2e')
  await addMember(admin, team.id, alice.userId)
  await addMember(admin, team.id, bob.userId)

  p1 = await createProjectViaApi(admin, `Teams P1 ${RUN}`)
  p2 = await createProjectViaApi(admin, `Teams P2 ${RUN}`)
  const made = await apiCall<ProjectRow>(PROJECTS_API_URL, admin, 'POST', '/projects', {
    name: `Teams IT ${RUN}`,
    type: 'internal',
    entity: 'welld_it',
  })
  expect(made.status).toBe(201)
  otherEntity = made.body
})

test.afterAll(async () => {
  test.setTimeout(120_000)
  // Entries and tasks first (their owners may no longer be on the project once the team is gone), then the teams.
  await deleteOwnEntriesQuietly(alice, '2020-01-01')
  try {
    const open = await listProjectTasksViaApi(admin, p1.id, 'open')
    for (const task of open.items) await apiCall(ACTIVITIES_API_URL, admin, 'DELETE', `/activities/${task.id}`)
    const done = await listProjectTasksViaApi(admin, p1.id, 'done')
    for (const task of done.items) await apiCall(ACTIVITIES_API_URL, admin, 'DELETE', `/activities/${task.id}`)
  } catch {
    // cleanup must never fail a run
  }
  for (const project of [p1, p2, otherEntity]) if (project) await detachTeamsQuietly(admin, project.id)
  cleanupTeams(RUN)
  await cleanupPeople(RUN)
})

test.describe('specs/20261126-teams — Teams on a project (T17)', () => {
  test('a project manager attaches a team; a viewer reads it with its members, one marked without access (AC-4.1, AC-4.3, AC-4.7)', async ({
    browser,
  }) => {
    const before = await readProject(admin, p1.id)
    expect(before.status).toBe(200)
    expect(before.body.teams).toEqual([])

    // ── the project manager attaches from the Edit teams dialog ──────────────────────────
    const pmPage = await (await personContext(browser, pm)).newPage()
    await openProject(pmPage, p1.id)
    await expect(pmPage.getByTestId('project-attached-teams-empty')).toBeVisible()
    await pmPage.getByTestId('project-attached-teams-edit').click()
    const dialog = pmPage.getByRole('dialog', { name: 'Edit teams' })
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('project-attached-teams-add-input').fill(teamLabel)
    await pmPage.getByTestId(`project-attached-teams-add-input-option-${team.id}`).click()
    // A pick alone writes nothing.
    expect((await readProject(admin, p1.id)).body.teams).toEqual([])
    await pmPage.getByTestId('project-attached-teams-dialog-submit').click()
    await expect(pmPage.getByText('Teams saved.')).toBeVisible({ timeout: 15_000 })
    await expect(pmPage.getByTestId(`project-attached-team-name-${team.id}`)).toHaveText(teamLabel)

    // The project's version moved, and the server's answer names the team with both members.
    const after = await readProject(admin, p1.id)
    expect(after.body.version).toBe(before.body.version + 1)
    expect(after.body.teams.map((t) => t.id)).toEqual([team.id])
    expect(after.body.teamsStatus).toBe('complete')
    const members = after.body.teams[0]!.members!
    expect(members.map((m) => m.id).sort()).toEqual([alice.userId, bob.userId].sort())

    // ── a stale save is refused; another entity's project is out of scope; nothing changes ───
    const stale = await putProjectTeams(pm, p1.id, before.body.version, [])
    expect(stale.status).toBe(409)
    const outOfScope = await putProjectTeams(pm, otherEntity.id, otherEntity.version, [team.id])
    expect(outOfScope.status).toBe(403)
    expect(outOfScope.body.code).toBe('out_of_scope')
    expect((await readProject(admin, otherEntity.id)).body.teams).toEqual([])
    expect((await readProject(admin, p1.id)).body.teams.map((t) => t.id)).toEqual([team.id])

    // ── any projects:access holder reads the card (AC-4.3, AC-4.7) ───────────────────────
    const viewerPage = await (await personContext(browser, viewer)).newPage()
    await openProject(viewerPage, p1.id)
    await expect(viewerPage.getByTestId('project-attached-teams-heading')).toBeVisible()
    await expect(viewerPage.getByTestId(`project-attached-team-name-${team.id}`)).toHaveText(teamLabel)
    await expect(viewerPage.getByTestId(`project-attached-team-member-${team.id}-${alice.userId}`)).toContainText(
      alice.name,
    )
    await expect(viewerPage.getByTestId(`project-attached-team-member-${team.id}-${bob.userId}`)).toContainText(
      `Act tm-bob ${RUN}`,
    )
    // Bob holds no access to Projects: marked, and not counted. Alice is neither.
    await expect(viewerPage.getByTestId(`project-attached-team-member-noaccess-${team.id}-${bob.userId}`)).toBeVisible()
    await expect(
      viewerPage.getByTestId(`project-attached-team-member-noaccess-${team.id}-${alice.userId}`),
    ).toHaveCount(0)
    await expect(viewerPage.getByTestId(`project-attached-team-count-${team.id}`)).toHaveText(
      '1 person counts on this project',
    )
    await expect(viewerPage.getByTestId('project-attached-teams-legend')).toBeVisible()
    // A viewer may read, not change: no Edit teams.
    await expect(viewerPage.getByTestId('project-attached-teams-edit')).toHaveCount(0)
    await expect(viewerPage.getByTestId('project-attached-teams-unavailable')).toHaveCount(0)
    await expect(viewerPage.getByTestId('project-attached-teams-rate-limited')).toHaveCount(0)
  })

  test('the team-only person is offered Record hours and records; the one without access records nothing; they are given a task (AC-5.1, AC-5.2)', async ({
    browser,
  }) => {
    const day = todayZurich()

    // ── Record hours is offered to alice (through the team) and not to the viewer ────────────
    const alicePage = await (await personContext(browser, alice)).newPage()
    await openProject(alicePage, p1.id)
    await expect(pageRecordHours(alicePage)).toBeVisible({ timeout: 30_000 })
    const viewerPage = await (await personContext(browser, viewer)).newPage()
    await openProject(viewerPage, p1.id)
    await recordHoursSettled(viewerPage)
    await expect(pageRecordHours(viewerPage)).toHaveCount(0)

    // ── hours-api accepts alice's entry exactly as for a listed member, and refuses bob's ────
    const entry = await createEntryViaApi(alice, { day, minutes: 90, on: { type: 'project', id: p1.id } })
    expect(entry.minutes).toBe(90)
    const refused = await hoursCall(bob, 'POST', '/time-entries', {
      day,
      minutes: 30,
      on: { type: 'project', id: p1.id },
    })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect((await ownEntriesViaApi(bob, day, day)).filter((e) => e.on.id === p1.id)).toEqual([])

    // ── the project manager gives alice a task: she is among the assignees, bob is not ───────
    const pmPage = await (await personContext(browser, pm)).newPage()
    await openProject(pmPage, p1.id)
    const title = `Prepare the demo ${RUN}`
    await pmPage.getByTestId('project-tasks-add').click()
    const form = pmPage.getByRole('dialog', { name: 'Add task' })
    await form.getByLabel('Title').fill(title)
    const assignees = form.getByLabel('Assignee')
    const offered = await assignees.locator('option').allTextContents()
    expect(offered.some((text) => text.includes(alice.name))).toBe(true)
    expect(offered.some((text) => text.includes(`Act tm-bob ${RUN}`))).toBe(false)
    await assignees.selectOption({ label: offered.find((text) => text.includes(alice.name))! })
    await pmPage.getByTestId('task-form-submit').click()
    await expect(pmPage.getByText('Task added.')).toBeVisible({ timeout: 15_000 })
    const tasks = await listProjectTasksViaApi(admin, p1.id)
    const task = tasks.items.find((t) => t.subject === title)
    expect(task, 'the task made through the form').toBeDefined()
    expect(task!.task.assignee?.id).toBe(alice.userId)
    aliceTaskId = task!.id
  })

  test('an administrator renames the team and the next load shows the new name; the list filters by team (AC-1.3, AC-4.8)', async ({
    browser,
  }) => {
    test.setTimeout(90_000)
    renamed = teamName(RUN, 'Delivery renamed')
    await renameTeam(admin, team.id, renamed)

    const viewerPage = await (await personContext(browser, viewer)).newPage()
    await openProject(viewerPage, p1.id)
    await expect(viewerPage.getByTestId(`project-attached-team-name-${team.id}`)).toHaveText(renamed)
    await expect(viewerPage.getByText(teamLabel, { exact: true })).toHaveCount(0)

    // The list: only the project the team is attached to, under the team's NEW name.
    await viewerPage.goto('/projects')
    await expect(viewerPage.getByTestId('projects-page')).toBeVisible({ timeout: 30_000 })
    await viewerPage.getByTestId('projects-search').getByRole('searchbox').fill(RUN)
    const table = viewerPage.getByTestId('projects-table')
    await expect(table.getByText(p1.name)).toBeVisible({ timeout: 20_000 })
    await expect(table.getByText(p2.name)).toBeVisible()
    await viewerPage.getByTestId('projects-team').getByRole('combobox').selectOption({ label: renamed })
    await expect(table.getByText(p2.name)).toHaveCount(0, { timeout: 20_000 })
    await expect(table.getByText(p1.name)).toBeVisible()
  })

  test('over the per-person limit one person sees the page with teams marked, the others are unaffected (AC-5.6)', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    // Open project pages through the API until the person's own window refuses the read. 120 are admitted per 10 min,
    // so the 121st says so; the bound below only keeps a broken limiter from looping.
    let reads = 0
    let status = 'complete'
    while (status === 'complete' && reads < 200) {
      const read = await readProject(limited, p1.id)
      expect(read.status).toBe(200)
      status = read.body.teamsStatus
      reads += 1
    }
    expect(status).toBe('rate_limited')
    expect(reads).toBeGreaterThan(100)
    expect(reads).toBeLessThanOrEqual(130)
    const refused = await readProject(limited, p1.id)
    expect(refused.body.teams.map((t) => t.id)).toEqual([team.id])
    expect(refused.body.teams[0]!.members).toBeNull()
    expect(refused.body.onProjectComplete).toBe(false)
    expect(refused.body.teamsRetryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(refused.body.teamsRetryAfterSeconds).toBeLessThanOrEqual(600)

    // ── the page still loads, the teams and their members say "could not be loaded", and it says why ──
    const limitedPage = await (await personContext(browser, limited)).newPage()
    await openProject(limitedPage, p1.id)
    await expect(limitedPage.getByTestId('project-attached-teams-rate-limited')).toBeVisible({ timeout: 20_000 })
    await expect(limitedPage.getByTestId('project-attached-teams-rate-limited-title')).toHaveText('Too many requests')
    await expect(limitedPage.getByTestId(`project-attached-team-members-unavailable-${team.id}`)).toHaveText(
      'Members could not be loaded',
    )
    await expect(limitedPage.getByTestId(`project-attached-team-name-${team.id}`)).toHaveText(
      'Team could not be loaded',
    )
    // The page itself is whole: the header and the other cards are there.
    await expect(limitedPage.getByRole('heading', { name: p1.name })).toBeVisible()
    await expect(limitedPage.getByTestId('project-tasks')).toBeVisible()
    // Retry inside the window checks again and says it is still limited, in place.
    await limitedPage.getByTestId('project-attached-teams-rate-limited-retry').click()
    await expect(limitedPage.getByTestId('project-attached-teams-retry-status')).toHaveText(
      'Checked again. Teams are still not shown.',
      { timeout: 20_000 },
    )
    await expect(limitedPage.getByTestId('project-attached-teams-rate-limited')).toBeVisible()

    // ── nobody else is touched: a viewer's page is whole, and the decisions are not refused ─────────
    const viewerPage = await (await personContext(browser, viewer)).newPage()
    await openProject(viewerPage, p1.id)
    await expect(viewerPage.getByTestId(`project-attached-team-name-${team.id}`)).toHaveText(renamed)
    await expect(viewerPage.getByTestId(`project-attached-team-member-${team.id}-${alice.userId}`)).toContainText(
      alice.name,
    )
    await expect(viewerPage.getByTestId('project-attached-teams-rate-limited')).toHaveCount(0)
    await expect(viewerPage.getByTestId('project-attached-teams-unavailable')).toHaveCount(0)
    const ok = await createEntryViaApi(alice, { day: todayZurich(), minutes: 30, on: { type: 'project', id: p1.id } })
    expect(ok.minutes).toBe(30)
    const aliceRead = await readProject(alice, p1.id)
    expect(aliceRead.body.teamsStatus).toBe('complete')
  })

  test('removed from the team, the person can no longer record on the project within 65 s; what was recorded and given stays (AC-4.6, AC-5.1, AC-5.2)', async ({
    browser,
  }) => {
    test.setTimeout(150_000)
    const day = todayZurich()
    const recorded = (await ownEntriesViaApi(alice, day, day)).filter((e) => e.on.id === p1.id)
    expect(recorded.length).toBeGreaterThanOrEqual(1)

    await removeMember(admin, team.id, alice.userId)
    const removedAt = Date.now()

    // The next ask is answered from the cache for up to 30 s (and 60 s at most): poll until hours-api refuses.
    let refusal: { status: number; code?: string } | null = null
    while (Date.now() - removedAt < 65_000) {
      const attempt = await hoursCall<{ code?: string }>(alice, 'POST', '/time-entries', {
        day,
        minutes: 30,
        on: { type: 'project', id: p1.id },
      })
      if (attempt.status >= 400) {
        refusal = { status: attempt.status, code: attempt.body.code }
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
    expect(refusal, 'hours-api must refuse a new entry within 65 s of the removal').not.toBeNull()
    expect(refusal!.status).toBe(403)
    expect(refusal!.code).toBe('not_on_project')

    // The entries already recorded are untouched (the ones the poll accepted before the cache aged out stay too).
    const afterEntries = (await ownEntriesViaApi(alice, day, day)).filter((e) => e.on.id === p1.id)
    for (const entry of recorded) expect(afterEntries.some((e) => e.id === entry.id)).toBe(true)

    // The task already given stays given (the same as removing an individual member).
    const tasks = await listProjectTasksViaApi(admin, p1.id)
    expect(tasks.items.find((t) => t.id === aliceTaskId)?.task.assignee?.id).toBe(alice.userId)

    // The project page no longer offers alice Record hours, and the team card no longer lists her.
    const alicePage = await (await personContext(browser, alice)).newPage()
    await openProject(alicePage, p1.id)
    await expect(alicePage.getByTestId(`project-attached-team-name-${team.id}`)).toHaveText(renamed)
    await expect(alicePage.getByTestId(`project-attached-team-member-${team.id}-${alice.userId}`)).toHaveCount(0)
    await recordHoursSettled(alicePage)
    await expect(pageRecordHours(alicePage)).toHaveCount(0)
  })

  test('teardown removes every team of the run', async () => {
    await deleteOwnEntriesQuietly(alice, '2020-01-01')
    expect(countTeams(RUN)).toBeGreaterThan(0)
    for (const project of [p1, p2, otherEntity]) await detachTeamsQuietly(admin, project.id)
    expect(cleanupTeams(RUN)).toBeGreaterThan(0)
    expect(countTeams(RUN)).toBe(0)
  })
})
