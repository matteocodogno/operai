/**
 * QE exploratory pass for specs/20261126-teams, Projects half, kept as a regression journey. What projects-teams.spec.ts does
 * not drive in a real browser: an archived team stays attached and is not offered (AC-4.2), the 10-team limit (AC-4.1),
 * a team-only person gains presence and never capability (AC-5.5), keyboard-only attach in the Edit teams dialog, and a long
 * team on a 360 px viewport. Run-tagged; teardown removes teams and people.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  PROJECTS_API_URL,
  activitiesAdmin,
  apiCall,
  cleanupPeople,
  createProjectViaApi,
  newRunId,
  personContext,
  seedPerson,
  type Person,
  type ProjectRow,
} from './helpers/activitiesFixtures'
import { seedUserSession, type SeededSession } from './helpers/adminSession'
import {
  addMember,
  archiveTeam,
  cleanupTeams,
  createTeam,
  detachTeamsQuietly,
  putProjectTeams,
  readProject,
  seedProjectManager,
  teamName,
} from './helpers/teamsFixtures'

test.describe.configure({ mode: 'serial' })

const RUN = newRunId()

let admin: Person
let pm: SeededSession
let viewer: Person
let alice: Person
let project: ProjectRow
const projectIds: string[] = []

async function openProject(page: Page, id: string): Promise<void> {
  await page.goto(`/projects/${id}`)
  await expect(page.getByTestId('project-team')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('project-attached-teams')).toBeVisible()
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  admin = await activitiesAdmin()
  pm = await seedProjectManager(admin, `act-qm-pm-${RUN}@operai.test`, `Act qm-pm ${RUN}`, 'welld_ch')
  viewer = await seedPerson('qm-viewer', 'accounting', RUN)
  alice = await seedPerson('qm-alice', 'accounting', RUN)
  project = await createProjectViaApi(admin, `QE Teams P ${RUN}`)
  projectIds.push(project.id)
})

test.afterAll(async () => {
  test.setTimeout(120_000)
  for (const id of projectIds) await detachTeamsQuietly(admin, id)
  cleanupTeams(RUN)
  await cleanupPeople(RUN)
})

test.describe('specs/20261126-teams — Projects QE exploratory', () => {
  test('an archived team stays attached and marked, is not offered, and cannot be attached again (AC-4.2)', async ({
    browser,
  }) => {
    const kept = await createTeam(admin, teamName(RUN, 'Kept then archived'))
    const fresh = await createTeam(admin, teamName(RUN, 'Archived never attached'))
    await addMember(admin, kept.id, alice.userId)
    const base = await readProject(admin, project.id)
    expect((await putProjectTeams(pm, project.id, base.body.version, [kept.id])).status).toBe(200)
    await archiveTeam(admin, kept.id)
    await archiveTeam(admin, fresh.id)

    const pmPage = await (await personContext(browser, pm)).newPage()
    await openProject(pmPage, project.id)
    await expect(pmPage.getByTestId(`project-attached-team-${kept.id}`)).toBeVisible()
    await expect(pmPage.getByTestId(`project-attached-team-archived-${kept.id}`)).toBeVisible()
    // Alice (team-only) is still counted on an archived team.
    const view = await readProject(admin, project.id)
    expect(view.body.onProject?.map((p) => p.id)).toContain(alice.userId)

    await pmPage.getByTestId('project-attached-teams-edit').click()
    const dialog = pmPage.getByRole('dialog', { name: 'Edit teams' })
    await dialog.getByTestId('project-attached-teams-add-input').fill(RUN)
    await expect(pmPage.getByTestId(`project-attached-teams-add-input-option-${fresh.id}`)).toHaveCount(0)
    await expect(pmPage.getByTestId(`project-attached-teams-add-input-option-${kept.id}`)).toHaveCount(0)
    await pmPage.getByTestId('project-attached-teams-dialog-cancel').click()

    // The server agrees: attaching an archived team is refused, the attached one stays.
    const again = await putProjectTeams(pm, project.id, view.body.version, [kept.id, fresh.id])
    expect(again.status).toBe(422)
    expect(again.body.code).toBe('team_archived')
    expect((await readProject(admin, project.id)).body.teams.map((t) => t.id)).toEqual([kept.id])
  })

  test('a team-only person is on the project but may not change it (AC-5.5)', async () => {
    const view = await readProject(admin, project.id)
    expect(view.body.onProject?.map((p) => p.id)).toContain(alice.userId)
    const res = await apiCall(
      PROJECTS_API_URL,
      alice,
      'PATCH',
      `/projects/${project.id}`,
      { name: `Hijack ${RUN}` },
      {
        'If-Match': String(view.body.version),
      },
    )
    expect(res.status).toBe(403)
    const put = await putProjectTeams(alice, project.id, view.body.version, [])
    expect(put.status).toBe(403)
    expect((await readProject(admin, project.id)).body.teams).toHaveLength(1)
  })

  test('the 10-team limit is enforced: 10 attach, an 11th is refused and nothing changes (AC-4.1)', async () => {
    const p = await createProjectViaApi(admin, `QE Teams Limit ${RUN}`)
    projectIds.push(p.id)
    const ids: string[] = []
    for (let i = 0; i < 11; i += 1) ids.push((await createTeam(admin, teamName(RUN, `Lim ${i}`))).id)
    const before = await readProject(admin, p.id)
    const eleven = await putProjectTeams(pm, p.id, before.body.version, ids)
    expect([400, 422]).toContain(eleven.status)
    expect((await readProject(admin, p.id)).body.teams).toHaveLength(0)
    const ten = await putProjectTeams(pm, p.id, before.body.version, ids.slice(0, 10))
    expect(ten.status).toBe(200)
    expect((await readProject(admin, p.id)).body.teams).toHaveLength(10)
  })

  test('keyboard only: attach a team in the dialog and save it (ADR 20261118, design a11y)', async ({
    browser,
  }) => {
    const p = await createProjectViaApi(admin, `QE Teams Keys ${RUN}`)
    projectIds.push(p.id)
    const team = await createTeam(admin, teamName(RUN, 'Keyboard team'))
    await addMember(admin, team.id, alice.userId)
    const pmPage = await (await personContext(browser, pm)).newPage()
    await openProject(pmPage, p.id)
    await pmPage.getByTestId('project-attached-teams-edit').focus()
    await pmPage.keyboard.press('Enter')
    const dialog = pmPage.getByRole('dialog', { name: 'Edit teams' })
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('project-attached-teams-add-input').focus()
    await pmPage.keyboard.type(teamName(RUN, 'Keyboard team'))
    await expect(pmPage.getByTestId(`project-attached-teams-add-input-option-${team.id}`)).toBeVisible({
      timeout: 10_000,
    })
    await pmPage.keyboard.press('ArrowDown')
    await pmPage.keyboard.press('Enter')
    await expect(dialog.getByTestId(`project-attached-teams-row-${team.id}`)).toBeVisible()
    // Submit by keyboard: Tab to the submit button and press Enter (never an unlabeled mouse path).
    const submit = pmPage.getByTestId('project-attached-teams-dialog-submit')
    for (let i = 0; i < 12 && !(await submit.evaluate((el) => el === document.activeElement)); i += 1)
      await pmPage.keyboard.press('Tab')
    await expect(submit).toBeFocused()
    await pmPage.keyboard.press('Enter')
    await expect(pmPage.getByText('Teams saved.')).toBeVisible({ timeout: 15_000 })
    expect((await readProject(admin, p.id)).body.teams.map((t) => t.id)).toEqual([team.id])
    // Focus is not lost to <body> once the dialog closed.
    expect(await pmPage.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
  })

  test('a team of 25 people on a 360 px viewport: no sideways page scroll, the list can be expanded (AC-4.3)', async ({
    browser,
  }) => {
    const p = await createProjectViaApi(admin, `QE Teams Wide ${RUN}`)
    projectIds.push(p.id)
    const team = await createTeam(admin, teamName(RUN, 'Wide team with a deliberately long name that wraps'))
    const people: SeededSession[] = []
    for (let i = 0; i < 25; i += 1)
      people.push(
        await seedUserSession(
          `act-qm-w${i}-${RUN}@operai.test`,
          `Act qm-wide ${i} ${RUN} with a rather long display name`,
        ),
      )
    for (const person of people) await addMember(admin, team.id, person.userId)
    const base = await readProject(admin, p.id)
    expect((await putProjectTeams(pm, p.id, base.body.version, [team.id])).status).toBe(200)

    const ctx = await personContext(browser, viewer)
    const page = await ctx.newPage()
    await page.setViewportSize({ width: 360, height: 740 })
    await openProject(page, p.id)
    await expect(page.getByTestId(`project-attached-team-${team.id}`)).toBeVisible()
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)
    expect(await fits()).toBe(true)
    const more = page.getByTestId(`project-attached-team-more-${team.id}`)
    await expect(more).toBeVisible()
    await more.click()
    await expect(page.getByTestId(`project-attached-team-member-${team.id}-${people[24]!.userId}`)).toBeVisible()
    expect(await fits()).toBe(true)
  })
})
