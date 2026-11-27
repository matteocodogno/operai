/**
 * QE exploratory pass for specs/20261126-teams, kept as a regression journey. What the authors' journeys (admin-teams,
 * projects-teams) do not drive in a REAL browser: the name clash (AC-1.2), a stale save (AC-1.8), the Remove confirm and
 * keyboard-only operation of Admin → Teams (ADR 20261118: a confirming control is proved in a real browser, keyboard
 * included), search and filter (AC-1.4), a deactivated member (AC-2.3), hostile text, a 360 px viewport, Italian
 * (AC-3.3) and the audit trail (AC-3.2). Every team and person carries the run tag; teardown removes them.
 */
import { test, expect, type Page } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie, type SeededSession } from './helpers/adminSession'
import { cleanupFixtures } from './helpers/inviteFixtures'
import { authCall } from './fixtures/letterheads'
import { addMember, cleanupTeams, createTeam, getTeam, renameTeam, teamName } from './helpers/teamsFixtures'

test.describe.configure({ mode: 'serial' })

const RUN = `qe${Date.now().toString(36)}`
const ADMIN_EMAIL = `qe-teams-admin-${RUN}@operai.test`
const M1_NAME = `QE Alpha ${RUN}`
const M2_NAME = `QE Bravo ${RUN}`
const M3_NAME = `QE Gone ${RUN}`

let admin: SeededSession
let m1: SeededSession
let m2: SeededSession
let m3: SeededSession

test.beforeAll(async () => {
  test.setTimeout(120_000)
  admin = await seedAdminSession(ADMIN_EMAIL, `QE Teams Admin ${RUN}`)
  m1 = await seedUserSession(`qe-teams-m1-${RUN}@operai.test`, M1_NAME)
  m2 = await seedUserSession(`qe-teams-m2-${RUN}@operai.test`, M2_NAME)
  m3 = await seedUserSession(`qe-teams-m3-${RUN}@operai.test`, M3_NAME)
})

test.afterAll(() => {
  cleanupTeams(RUN)
  cleanupFixtures(RUN)
})

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)

test.describe('specs/20261126-teams — QE exploratory', () => {
  test('a name clash is refused on the field, naming the stored name, in a real browser (AC-1.2)', async ({
    page,
    context,
  }) => {
    await applySessionCookie(context, admin)
    const existing = await createTeam(admin, teamName(RUN, 'Backend'))
    await page.goto('/admin/teams')
    await page.getByTestId('teams-search').fill(RUN)
    await page.getByTestId('new-team-button').click()
    await page.getByTestId('create-team-name-input').fill(`  ${teamName(RUN, 'BACKEND')}  `)
    await page.getByTestId('create-team-submit').click()
    await expect(page.getByTestId('create-team-name-error')).toContainText(existing.name)
    await expect(page.getByTestId('create-team-dialog')).toBeVisible()
    expect(
      (await authCall<{ items: unknown[] }>(admin, 'GET', '/admin/teams')).body.items.filter(
        (t) => String((t as { name: string }).name).toLowerCase() === existing.name.toLowerCase(),
      ),
    ).toHaveLength(1)
  })

  test("a stale edit keeps the typed text and is refused; Reload shows the other admin's change (AC-1.8)", async ({
    page,
    context,
  }) => {
    await applySessionCookie(context, admin)
    const team = await createTeam(admin, teamName(RUN, 'Stale'))
    await page.goto(`/admin/teams/${team.id}`)
    await expect(page.getByTestId('team-detail-page')).toBeVisible({ timeout: 20_000 })
    // Another administrator renames it behind this page.
    await renameTeam(admin, team.id, teamName(RUN, 'Stale renamed elsewhere'))
    await page.getByTestId('team-edit-details').click()
    await page.getByTestId('edit-team-name-input').fill(teamName(RUN, 'My stale text'))
    await page.getByTestId('edit-team-submit').click()
    await expect(page.getByTestId('edit-team-error')).toBeVisible()
    await expect(page.getByTestId('edit-team-name-input')).toHaveValue(teamName(RUN, 'My stale text'))
    expect((await getTeam(admin, team.id)).name).toBe(teamName(RUN, 'Stale renamed elsewhere'))
    await page.getByTestId('edit-team-cancel').click()
    await expect(page.getByTestId('team-stale-banner')).toBeVisible()
    await page.getByTestId('team-stale-reload').click()
    await expect(page.getByTestId('team-stale-banner')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: teamName(RUN, 'Stale renamed elsewhere'), level: 2 })).toBeVisible()
  })

  test('keyboard only: open a team, add a member through the picker, remove them through the confirm (ADR 20261118)', async ({
    page,
    context,
  }) => {
    await applySessionCookie(context, admin)
    const team = await createTeam(admin, teamName(RUN, 'Keys'))
    await page.goto(`/admin/teams/${team.id}`)
    await expect(page.getByTestId('team-detail-page')).toBeVisible({ timeout: 20_000 })

    const picker = page.getByTestId('team-member-picker-input')
    await picker.focus()
    await page.keyboard.type(M1_NAME)
    await expect(page.getByRole('option').filter({ hasText: M1_NAME }).first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    // A pick alone never writes.
    expect((await getTeam(admin, team.id)).members).toEqual([])
    const add = page.getByTestId('team-member-add')
    for (let i = 0; i < 4 && !(await add.evaluate((el) => el === document.activeElement)); i += 1)
      await page.keyboard.press('Tab')
    await expect(add).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(`team-member-remove-${m1.userId}`)).toBeVisible({ timeout: 10_000 })

    const remove = page.getByTestId(`team-member-remove-${m1.userId}`)
    await remove.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('remove-team-member-confirm')).toBeVisible()
    // Initial focus is on Cancel (library default): Tab to Confirm and press it with the keyboard.
    await expect(page.getByTestId('remove-team-member-cancel')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('remove-team-member-confirm')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('remove-team-member-confirm')).toBeHidden({ timeout: 10_000 })
    await expect(page.getByTestId(`team-member-${m1.userId}`)).toHaveCount(0)
    expect((await getTeam(admin, team.id)).members).toEqual([])
    // Focus returned somewhere real (not lost to <body>) after the dialog closed.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
  })

  test('search is a case-insensitive substring and Active is the default; archived on request (AC-1.4)', async ({
    page,
    context,
  }) => {
    await applySessionCookie(context, admin)
    const a = await createTeam(admin, teamName(RUN, 'Searchable Zebra'))
    const b = await createTeam(admin, teamName(RUN, 'Archived Zebra'))
    await authCall(admin, 'POST', `/admin/teams/${b.id}/archive`, { baseVersion: b.version })
    await page.goto('/admin/teams')
    await page.getByTestId('teams-search').fill('sEaRcHaBlE zEbRa ' + RUN.toUpperCase())
    await expect(page.getByTestId(`team-open-${a.id}`)).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('teams-search').fill('ZEBRA')
    await expect(page.getByTestId(`team-open-${a.id}`)).toBeVisible()
    await expect(page.getByTestId(`team-open-${b.id}`)).toHaveCount(0)
    await page.getByTestId('teams-show').selectOption('archived')
    await expect(page.getByTestId(`team-open-${b.id}`)).toBeVisible()
    await page.getByTestId('teams-search').fill(`${RUN}-nothing-matches`)
    await expect(page.getByTestId('teams-no-match')).toBeVisible()
  })

  test('a deactivated member stays listed, marked, and is not counted as active (AC-2.3)', async ({
    page,
    context,
  }) => {
    await applySessionCookie(context, admin)
    const team = await createTeam(admin, teamName(RUN, 'Deact'))
    await addMember(admin, team.id, m2.userId)
    await addMember(admin, team.id, m3.userId)
    const del = await authCall(admin, 'DELETE', `/admin/users/${m3.userId}`)
    expect([200, 204]).toContain(del.status)
    await page.goto(`/admin/teams/${team.id}`)
    await expect(page.getByTestId(`team-member-deactivated-${m3.userId}`)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(`team-member-deactivated-${m2.userId}`)).toHaveCount(0)
    await expect(page.getByTestId('team-members-count')).toContainText('2 of 100')
    await expect(page.getByTestId('team-members-count')).toContainText('1 deactivated')
    const detail = await getTeam(admin, team.id)
    expect(detail.activeMemberCount).toBe(1)
    // A deactivated person cannot be added to another team.
    const other = await createTeam(admin, teamName(RUN, 'Deact other'))
    const refused = await authCall(admin, 'POST', `/admin/teams/${other.id}/members`, { userId: m3.userId })
    expect(refused.status).toBe(422)
  })

  test('hostile text renders as text; a long name and a 360 px viewport never scroll the page sideways', async ({
    page,
    context,
  }) => {
    await applySessionCookie(context, admin)
    const hostile = teamName(RUN, '<img src=x onerror="window.__pwned=1">')
    const long = `${'W'.repeat(80 - RUN.length - 1)} ${RUN}`.slice(0, 80)
    const t1 = await createTeam(admin, hostile, '<script>window.__pwned=1</script> '.repeat(5))
    const t2 = await createTeam(admin, long, 'x'.repeat(500))
    await page.setViewportSize({ width: 360, height: 740 })
    await page.goto('/admin/teams')
    await page.getByTestId('teams-search').fill(RUN)
    await expect(page.getByTestId(`team-open-${t1.id}`)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(`team-open-${t2.id}`)).toBeVisible()
    expect(await noHorizontalScroll(page)).toBe(true)
    await page.getByTestId(`team-open-${t1.id}`).click()
    await expect(page.getByTestId('team-detail-page')).toBeVisible()
    expect(await noHorizontalScroll(page)).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
    await addMember(admin, t2.id, m1.userId)
    await page.goto(`/admin/teams/${t2.id}`)
    await expect(page.getByTestId('team-detail-page')).toBeVisible()
    expect(await noHorizontalScroll(page)).toBe(true)
    await page.getByTestId('new-team-button').count() // not on this page; no-op
  })

  test('Italian: the Admin teams screen is Italian, with no English leftover in its chrome (AC-3.3)', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ locale: 'it-IT' })
    await applySessionCookie(ctx, admin)
    const page = await ctx.newPage()
    await page.goto('/admin/teams')
    await expect(page.getByTestId('admin-teams-page')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('html')).toHaveAttribute('lang', 'it')
    await expect(page.getByTestId('new-team-button')).toHaveText('Nuovo team')
    const body = await page.getByTestId('admin-teams-page').innerText()
    for (const english of ['New team', 'Show', 'Active teams', 'Loading teams', 'Name', 'Active members', 'State']) {
      expect(body).not.toContain(english)
    }
    await ctx.close()
  })

  test('a signed-in non-administrator who types /admin/teams is taken away from Admin, not left on a blank or denied screen (AC-3.1)', async ({ page, context }) => {
    const plain = await seedUserSession(`qe-teams-plain-${RUN}@operai.test`, `QE Plain ${RUN}`)
    await applySessionCookie(context, plain)
    await page.goto('/admin/teams')
    await expect(page.getByRole('navigation', { name: 'Tool navigation' })).toBeVisible({ timeout: 30_000 })
    await expect(page).not.toHaveURL(/\/admin\/teams/)
  })

  test('every change left one audit entry naming the actor and the team; a refusal left none (AC-3.2)', async () => {
    const team = await createTeam(admin, teamName(RUN, 'Audited'))
    await addMember(admin, team.id, m1.userId)
    const before = await authCall<{
      items: { action: string; targetId: string | null; summary: string; actorUserId: string | null }[]
    }>(admin, 'GET', '/admin/audit?pageSize=100')
    const mine = before.body.items.filter((e) => e.targetId === team.id)
    expect(mine.map((e) => e.action).sort()).toEqual(['team.create', 'team_member.add'].sort())
    for (const e of mine) expect(e.actorUserId).toBe(admin.userId)
    expect(mine.find((e) => e.action === 'team_member.add')!.summary).toContain(`qe-teams-m1-${RUN}@operai.test`)
    // A refused change (name clash) writes nothing.
    const clash = await authCall(admin, 'POST', '/admin/teams', { name: team.name.toUpperCase() })
    expect(clash.status).toBe(409)
    const after = await authCall<{ items: { targetId: string | null }[] }>(admin, 'GET', '/admin/audit?pageSize=100')
    expect(after.body.items.filter((e) => e.targetId === team.id)).toHaveLength(2)
  })
})
