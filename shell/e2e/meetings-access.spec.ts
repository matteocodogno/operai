/**
 * T87 — Meetings access journeys (specs/021-meetings: AC-10.1, AC-10.4, AC-10.5, AC-1.4).
 *
 * Drives the REAL assembled shell + meetings-ui + crm-ui remotes against the real
 * auth / meetings-api / crm-api. Access to a meeting is decided by the RECORD
 * (creator / participant / host reader); `meetings:access` is only the capability
 * to create and to use the AI actions.
 *
 *  1. A user with NO grant (employee role removed): reaches My meetings from the
 *     user menu, sees only the meetings they created or take part in (not another
 *     person's), has no Meetings entry in the sidebar, no New meeting, and on a
 *     meeting they were added to reads transcript but sees none of the creator /
 *     capability controls (absent, not disabled). /meetings is not reachable.
 *     (AC-10.1, AC-10.4, AC-10.5)
 *  2. A holder: Meetings in the sidebar, the tool lists New meeting and Templates,
 *     and no Erase tab (admin only). On the same meeting a participant WITH the
 *     grant does get Generate summary (the contrast that proves journey 1's
 *     absence is the grant, not a missing feature).  (AC-10.5, AC-10.2)
 *  3. A deal: a salesperson with the grant sees Start meeting and Link an existing
 *     meeting; a crm-technical user (crm:access, no meetings:access) sees the same
 *     deal and its Meetings card but neither control.  (AC-1.4)
 */
import { expect } from '@playwright/test'
import {
  cleanupPeople,
  createDealViaApi,
  deleteMeetingQuietly,
  meetingsAdmin,
  newRunId,
  openMyMeetingsFromMenu,
  personContext,
  seedPerson,
  seedReadyMeeting,
  setParticipants,
  setRoles,
  test,
  type Person,
} from './helpers/meetingsFixtures'

const runId = newRunId()

test.describe.configure({ mode: 'serial' })

test.describe('specs/021 T87: access journeys', () => {
  let creator: Person // holder who creates meetings A and B
  let reader: Person // loses meetings:access after creating their own meeting; participant on A only
  let granted: Person // holder, participant on A
  let sales: Person
  let technical: Person
  const created: { owner: Person; id: string }[] = []
  let ownByReader: { id: string; title: string }
  let sharedA: { id: string; title: string }
  let privateB: { id: string; title: string }

  test.beforeAll(async () => {
    creator = await seedPerson('acc-creator', 'holder', runId)
    reader = await seedPerson('acc-reader', 'holder', runId)
    granted = await seedPerson('acc-granted', 'holder', runId)
    sales = await seedPerson('acc-sales', 'sales', runId)
    technical = await seedPerson('acc-tech', 'crm-technical', runId)

    // The reader first creates a meeting of their own (they still hold the grant), THEN lose it.
    const own = await seedReadyMeeting(reader, `Access own ${runId}`)
    ownByReader = { id: own.id, title: own.title }
    created.push({ owner: reader, id: own.id })
    await setRoles(reader.userId, [])

    const a = await seedReadyMeeting(
      creator,
      `Access shared ${runId}`,
      'Alice: the budget is approved.\nBob: ship in March.',
    )
    sharedA = { id: a.id, title: a.title }
    created.push({ owner: creator, id: a.id })
    await setParticipants(creator, a.id, [{ userId: reader.userId }, { userId: granted.userId }])

    const b = await seedReadyMeeting(creator, `Access private ${runId}`)
    privateB = { id: b.id, title: b.title }
    created.push({ owner: creator, id: b.id })
  })

  test.afterAll(async () => {
    for (const { owner, id } of created) await deleteMeetingQuietly(owner, id)
    await cleanupPeople(runId)
  })

  test('a user with no grant reaches My meetings, sees only their own, and has no controls (AC-10.1/10.4/10.5)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, reader)
    const page = await ctx.newPage()

    // No tool at all: the shell sends them to /no-access, and there is no Meetings entry.
    await page.goto('/')
    await expect(page).toHaveURL(/\/no-access$/, { timeout: 30_000 })
    await expect(
      page.getByRole('navigation', { name: 'Tool navigation' }).getByRole('link', { name: 'Meetings' }),
    ).toHaveCount(0)

    // ...but My meetings is one click away in the user menu (AC-10.1).
    await openMyMeetingsFromMenu(page, reader.name)
    await expect(page).toHaveURL(/\/my-meetings$/)
    await expect(page.getByRole('heading', { name: 'My meetings', level: 2 })).toBeVisible({ timeout: 30_000 })

    // Only their own: the one they created and the one they were added to; never B (AC-10.4).
    await expect(page.getByRole('row').filter({ hasText: ownByReader.title })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('row').filter({ hasText: sharedA.title })).toBeVisible()
    await expect(page.getByText(privateB.title)).toHaveCount(0)

    // No way to start a meeting without the grant (AC-10.5).
    await expect(page.getByRole('link', { name: 'New meeting' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New meeting' })).toHaveCount(0)

    // A meeting they were added to: readable, with no control of any kind.
    await page.getByRole('row').filter({ hasText: sharedA.title }).getByRole('link', { name: sharedA.title }).click()
    await expect(page.getByRole('heading', { name: sharedA.title })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('tab', { name: 'Passages' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('the budget is approved.')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('tab', { name: 'Ask the meeting' })).toHaveCount(0) // an AI action: needs the grant
    await page.getByRole('tab', { name: 'Summaries' }).click()
    for (const name of ['Edit details', 'Delete meeting', 'Edit participants', 'Generate summary']) {
      await expect(page.getByRole('button', { name }), `"${name}" must be absent, not disabled`).toHaveCount(0)
    }

    // The tool route itself is not reachable (AC-10.5).
    await page.goto('/meetings')
    await expect(page).toHaveURL(/\/no-access$/, { timeout: 30_000 })
    await ctx.close()
  })

  test('a holder sees Meetings with New meeting and Templates; a participant with the grant can summarise (AC-10.5/10.2)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, granted)
    const page = await ctx.newPage()
    await page.goto('/meetings')
    await expect(page.getByRole('heading', { name: 'Meetings', level: 2 })).toBeVisible({ timeout: 30_000 })
    await expect(
      page.getByRole('navigation', { name: 'Tool navigation' }).getByRole('link', { name: 'Meetings' }),
    ).toBeVisible()
    await expect(page.getByRole('link', { name: 'New meeting' })).toBeVisible()
    const sections = page.getByRole('navigation', { name: 'Meetings sections' })
    await expect(sections.getByRole('link', { name: 'Templates' })).toBeVisible()
    await expect(sections.getByRole('link', { name: 'Erase' })).toHaveCount(0) // admin only

    // They take part in A (not B): A is listed, B is not.
    await expect(page.getByRole('row').filter({ hasText: sharedA.title })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(privateB.title)).toHaveCount(0)

    // The contrast with journey 1: the same participant WITH the grant gets the AI action.
    await page.getByRole('row').filter({ hasText: sharedA.title }).getByRole('link', { name: sharedA.title }).click()
    await expect(page.getByRole('heading', { name: sharedA.title })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('tab', { name: 'Summaries' }).click()
    await expect(page.getByRole('button', { name: 'Generate summary' })).toBeVisible({ timeout: 20_000 })
    // ...but still none of the creator-only controls.
    await expect(page.getByRole('button', { name: 'Delete meeting' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Edit participants' })).toHaveCount(0)
    await ctx.close()
  })

  test('a user without the grant sees no Start meeting on a deal; a holder does (AC-1.4)', async ({ browser }) => {
    const admin = await meetingsAdmin()
    const deal = await createDealViaApi(admin, `Access deal ${runId}`)

    // crm:access but no meetings:access
    const techCtx = await personContext(browser, technical)
    const tech = await techCtx.newPage()
    await tech.goto(`/crm/deals/${deal.id}`)
    await expect(tech.getByRole('heading', { name: new RegExp(`Access deal ${runId}`) }).first()).toBeVisible({
      timeout: 30_000,
    })
    // The Meetings card is on the page (the deal is readable), loaded...
    await expect(tech.getByRole('heading', { name: 'Meetings', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(tech.getByText('No meetings yet')).toBeVisible({ timeout: 20_000 })
    // ...with no way to start or link one.
    await expect(tech.getByTestId('meetings-host-start')).toHaveCount(0)
    await expect(tech.getByRole('button', { name: 'Link an existing meeting' })).toHaveCount(0)
    await techCtx.close()

    // sales + the baseline employee role: has the grant
    const salesCtx = await personContext(browser, sales)
    const s = await salesCtx.newPage()
    await s.goto(`/crm/deals/${deal.id}`)
    await expect(s.getByRole('heading', { name: 'Meetings', exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(s.getByTestId('meetings-host-start').first()).toBeVisible({ timeout: 20_000 })
    await expect(s.getByRole('button', { name: 'Link an existing meeting' })).toBeVisible()
    await salesCtx.close()
  })
})
