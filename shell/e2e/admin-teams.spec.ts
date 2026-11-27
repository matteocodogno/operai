/**
 * Admin → Teams: end-to-end (specs/20261126-teams, T6). Refs AC-1.1, AC-2.1, AC-3.1.
 *
 * Drives the REAL assembled shell + admin-ui + auth:
 *   AC-1.1  an administrator creates a team from Admin → Teams (name + description) and lands on its page;
 *   AC-2.1  they add an active user (found by name through the picker) and the member is listed, then read back
 *           through the API; archiving and restoring the team keeps the member (AC-1.5/1.6 as seen from the UI);
 *   AC-3.1  a signed-in user who is not an administrator has no Admin entry, no Teams tab, and the direct
 *           `/admin/teams` address does not show the screen; the API refuses every Teams route for them.
 *
 * People are made with auth's test-session mint (`seedUserSession`); the admin role is granted through the one direct
 * database access the suite has (`seedAdminSession`). Every team and person carries the run tag; teardown deletes them
 * (helpers/teamsFixtures.ts `cleanupTeams`, then `cleanupFixtures`).
 */
import { test, expect, type Page } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie, type SeededSession } from './helpers/adminSession'
import { cleanupFixtures } from './helpers/inviteFixtures'
import { authCall } from './fixtures/letterheads'
import { addMember, cleanupTeams, countTeams, createTeam, getTeam, listTeams, teamName } from './helpers/teamsFixtures'

test.describe.configure({ mode: 'serial' })

const RUN = `t6${Date.now().toString(36)}`
const ADMIN_EMAIL = `teams-admin-${RUN}@operai.test`
const MEMBER_EMAIL = `teams-member-${RUN}@operai.test`
const MEMBER_NAME = `Teams Member ${RUN}`
const PLAIN_EMAIL = `teams-plain-${RUN}@operai.test`

const toolNav = (page: Page) => page.getByRole('navigation', { name: 'Tool navigation' })
const adminSections = (page: Page) => page.getByRole('navigation', { name: 'Admin sections' })

let admin: SeededSession
let member: SeededSession

test.beforeAll(async () => {
  test.setTimeout(120_000)
  admin = await seedAdminSession(ADMIN_EMAIL, `Teams Admin ${RUN}`)
  member = await seedUserSession(MEMBER_EMAIL, MEMBER_NAME)
})

test.afterAll(() => {
  // Teams first: team_member.teamId is RESTRICT. Then the people (their audit rows and sessions).
  cleanupTeams(RUN)
  cleanupFixtures(RUN)
})

test.describe('specs/20261126-teams — Admin → Teams (T6)', () => {
  test('an administrator creates a team, adds a member, archives it and restores it (AC-1.1, AC-2.1)', async ({
    page,
    context,
  }) => {
    await applySessionCookie(context, admin)
    const name = teamName(RUN, 'Delivery')

    // The Teams tab is there for an administrator.
    await page.goto('/admin/roles')
    await expect(adminSections(page).getByRole('link', { name: 'Teams', exact: true })).toBeVisible({ timeout: 30_000 })
    await adminSections(page).getByRole('link', { name: 'Teams', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/teams$/)
    await expect(page.getByTestId('admin-teams-page')).toBeVisible({ timeout: 20_000 })

    // ── AC-1.1: create ──────────────────────────────────────────────────
    await page.getByTestId('new-team-button').click()
    await expect(page.getByTestId('create-team-dialog')).toBeVisible()
    await page.getByTestId('create-team-name-input').fill(name)
    await page.getByTestId('create-team-description-input').fill('Created by the Teams e2e')
    await page.getByTestId('create-team-submit').click()

    // Lands on the team's own page, which says it was created.
    await expect(page.getByTestId('team-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(page).toHaveURL(/\/admin\/teams\/[^/]+$/)
    await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
    await expect(page.getByTestId('team-members-count')).toContainText('0 of 100 members')
    const teamId = page.url().split('/').pop()!

    const created = await getTeam(admin, teamId)
    expect(created.name).toBe(name)
    expect(created.description).toBe('Created by the Teams e2e')
    expect(created.archived).toBe(false)
    expect(created.members).toEqual([])

    // ── AC-2.1: add a member found by name ─────────────────────────────
    const picker = page.getByTestId('team-member-picker-input')
    await picker.fill(MEMBER_NAME)
    await page.getByRole('option').filter({ hasText: MEMBER_NAME }).first().click()
    // A pick alone never writes.
    expect((await getTeam(admin, teamId)).members).toEqual([])
    await page.getByTestId('team-member-add').click()

    await expect(page.getByTestId(`team-member-remove-${member.userId}`)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('team-members-count')).toContainText('1 of 100 members')
    const row = page.locator('tr').filter({ hasText: MEMBER_EMAIL })
    await expect(row).toBeVisible()
    await expect(row).toContainText(MEMBER_NAME)
    const afterAdd = await getTeam(admin, teamId)
    expect(afterAdd.members.map((m) => m.id)).toEqual([member.userId])
    expect(afterAdd.activeMemberCount).toBe(1)

    // ── Archive: confirmed, the member stays ───────────────────────────
    await page.getByTestId('team-archive').click()
    await expect(page.getByTestId('archive-team-confirm')).toBeVisible()
    // Cancel is a true no-op.
    await page.getByTestId('archive-team-cancel').click()
    await expect(page.getByTestId('archive-team-confirm')).toBeHidden()
    expect((await getTeam(admin, teamId)).archived).toBe(false)

    await page.getByTestId('team-archive').click()
    await page.getByTestId('archive-team-confirm').click()
    await expect(page.getByTestId('team-archived-note')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('team-restore')).toBeVisible()
    await expect(page.getByTestId('team-archive')).toHaveCount(0)
    const archived = await getTeam(admin, teamId)
    expect(archived.archived).toBe(true)
    expect(archived.members.map((m) => m.id)).toEqual([member.userId])

    // The list hides it by default and shows it under Archived.
    await page.getByTestId('team-detail-back-link').click()
    await expect(page.getByTestId('admin-teams-page')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('teams-search').fill(RUN)
    await expect(page.getByTestId(`team-open-${teamId}`)).toHaveCount(0)
    await page.getByTestId('teams-show').selectOption('archived')
    await expect(page.getByTestId(`team-open-${teamId}`)).toBeVisible()
    await expect(page.getByTestId(`team-state-${teamId}`)).toContainText('Archived')

    // ── Restore ─────────────────────────────────────────────────────────
    await page.getByTestId(`team-open-${teamId}`).click()
    await expect(page.getByTestId('team-detail-page')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('team-restore').click()
    await page.getByTestId('restore-team-confirm').click()
    await expect(page.getByTestId('team-archive')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('team-archived-note')).toHaveCount(0)
    const restored = await getTeam(admin, teamId)
    expect(restored.archived).toBe(false)
    expect(restored.members.map((m) => m.id)).toEqual([member.userId])
    // Three state changes of the page's own (create excluded): archive, restore; version moved twice from 1.
    expect(restored.version).toBe(3)

    // The team is a name-clash for a second create, whatever its case (AC-1.2 as seen by the API).
    const clash = await authCall(admin, 'POST', '/admin/teams', { name: name.toUpperCase() })
    expect(clash.status).toBe(409)
  })

  test('a person who is not an administrator has no Teams entry and the direct address shows nothing (AC-3.1)', async ({
    page,
    context,
  }) => {
    const plain = await seedUserSession(PLAIN_EMAIL, `Teams Plain ${RUN}`)
    await applySessionCookie(context, plain)
    // A team exists, so an empty screen cannot be mistaken for "nothing to list".
    const team = await createTeam(admin, teamName(RUN, 'Hidden'))
    await addMember(admin, team.id, plain.userId)

    await page.goto('/')
    await expect(toolNav(page)).toBeVisible({ timeout: 30_000 })
    await expect(toolNav(page).getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0)

    for (const path of ['/admin/teams', `/admin/teams/${team.id}`]) {
      await page.goto(path)
      await expect(toolNav(page)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('admin-teams-page')).toHaveCount(0)
      await expect(page.getByTestId('team-detail-page')).toHaveCount(0)
      await expect(adminSections(page).getByRole('link', { name: 'Teams', exact: true })).toHaveCount(0)
      await expect(page.getByText(teamName(RUN, 'Hidden'))).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Teams', level: 2 })).toHaveCount(0)
    }

    // The server refuses too: every route, no read, no write (a UI that hides is a convenience, not a control).
    const asPlain = async (method: string, route: string, body?: unknown) =>
      (await authCall(plain, method, route, body)).status
    expect(await asPlain('GET', '/admin/teams')).toBe(403)
    expect(await asPlain('GET', `/admin/teams/${team.id}`)).toBe(403)
    expect(await asPlain('POST', '/admin/teams', { name: teamName(RUN, 'Nope') })).toBe(403)
    expect(await asPlain('POST', `/admin/teams/${team.id}/archive`, { baseVersion: 1 })).toBe(403)
    expect(await asPlain('POST', `/admin/teams/${team.id}/members`, { userId: plain.userId })).toBe(403)
    expect(await asPlain('DELETE', `/admin/teams/${team.id}/members/${plain.userId}`)).toBe(403)
    // Nothing changed behind the refusals.
    const after = await getTeam(admin, team.id)
    expect(after.version).toBe(1)
    expect(after.archived).toBe(false)
    expect((await listTeams(admin)).some((t) => t.name === teamName(RUN, 'Nope'))).toBe(false)
  })

  test('teardown removes every team of the run', async () => {
    expect(countTeams(RUN)).toBeGreaterThan(0)
    expect(cleanupTeams(RUN)).toBeGreaterThan(0)
    expect(countTeams(RUN)).toBe(0)
  })
})
