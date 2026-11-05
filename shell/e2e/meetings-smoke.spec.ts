/**
 * T86 — Meetings harness smoke (specs/021-meetings, AC-11.4 harness).
 *
 * Proves the e2e harness itself end to end, before the journeys build on it:
 * a person is seeded with a real session, a meeting is seeded through
 * meetings-api (a text meeting, so it is `ready` with no audio and no consent),
 * and the person finds it through the user menu -> My meetings -> the meeting
 * page, in the REAL assembled shell + meetings-ui remote.
 *
 * Also checks the harness's two other promises: the `meetings` Playwright
 * project hands the page a (fake) microphone, and the role helper really takes
 * `meetings:access` away (meetings-api answers 403 to the no-grant persona).
 */
import { expect } from '@playwright/test'
import {
  cleanupPeople,
  deleteMeetingQuietly,
  meetingsCall,
  newRunId,
  openMyMeetingsFromMenu,
  seedPerson,
  seedReadyMeeting,
  sharedSeedUserRoles,
  signInContext,
  test,
  type Person,
} from './helpers/meetingsFixtures'

const runId = newRunId()

test.describe('specs/021 T86: meetings harness smoke', () => {
  let holder: Person
  let noGrant: Person
  let sharedRolesBefore: string[] = []
  const meetingIds: string[] = []

  test.beforeAll(async () => {
    sharedRolesBefore = await sharedSeedUserRoles()
    holder = await seedPerson('smoke-holder', 'holder', runId)
    noGrant = await seedPerson('smoke-nogrant', 'no-grant', runId)
  })

  test.afterAll(async () => {
    for (const id of meetingIds) await deleteMeetingQuietly(holder, id)
    await cleanupPeople(runId)
    // Isolation: the suite's shared seed user is exactly as this spec found it.
    expect(await sharedSeedUserRoles()).toEqual(sharedRolesBefore)
  })

  test('a seeded meeting is found in My meetings and opens', async ({ context, page }) => {
    const title = `Smoke meeting ${runId}`
    const meeting = await seedReadyMeeting(holder, title)
    meetingIds.push(meeting.id)
    expect(meeting.status).toBe('ready')

    await signInContext(context, holder)
    await page.goto('/')
    await expect(page.getByRole('button', { name: holder.name })).toBeVisible({ timeout: 30_000 })
    await openMyMeetingsFromMenu(page, holder.name)

    await expect(page).toHaveURL(/\/my-meetings$/)
    await expect(page.getByRole('heading', { name: 'My meetings', level: 2 })).toBeVisible({ timeout: 20_000 })
    const row = page.getByRole('row').filter({ hasText: title })
    await expect(row).toBeVisible({ timeout: 20_000 })

    await row.getByRole('link', { name: title }).click()
    await expect(page).toHaveURL(new RegExp(`/my-meetings/m/${meeting.id}`))
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('We agree to ship the pilot in March.')).toBeVisible({ timeout: 20_000 })
  })

  test('the role helper really removes meetings:access (API answers 403)', async () => {
    const res = await meetingsCall(noGrant, 'POST', '/meetings', { title: 'x', format: 'in_person', language: 'en', source: 'text' }, [403])
    expect(res.status).toBe(403)
    const ok = await meetingsCall(holder, 'GET', '/meetings')
    expect(ok.status).toBe(200)
  })

  test('the meetings project provides a fake microphone', async ({ context, page }) => {
    await signInContext(context, holder)
    await page.goto('/my-meetings')
    await expect(page.getByRole('heading', { name: 'My meetings', level: 2 })).toBeVisible({ timeout: 30_000 })
    const devices = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const tracks = stream.getAudioTracks().length
      stream.getTracks().forEach((t) => t.stop())
      return tracks
    })
    expect(devices).toBe(1)
  })
})
