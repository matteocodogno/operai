/**
 * T89 — Capture robustness (specs/021-meetings: AC-2.8, AC-2.9, AC-2.10, AC-4.11, AC-13.3).
 *
 * The in-browser recorder runs for real (MediaRecorder -> presigned chunk uploads to MinIO ->
 * meetings-api) against the REAL assembled shell + meetings-ui. The microphone is the harness's
 * WebAudio tone (see installFakeMicrophone); the transcript is meetings-api's fake transcriber.
 * Tab audio cannot be captured headless, so every journey here is the microphone-only path.
 *
 *  1. Offline 40 s then back (AC-2.9, AC-4.11): the indicator says audio is not yet saved and
 *     survives only while the tab stays open; nothing lands in browser storage while offline;
 *     on reconnection every chunk is saved (no loss reported) and the meeting is processed.
 *  2. Close the page mid-recording (AC-2.8, AC-4.11): after 2 minutes of silence the meeting
 *     reads `interrupted`, with the saved duration within 20 s of what was recorded; Discard
 *     returns it to draft and leaves the browser storage as it was.
 *  3. Sidebar click while recording (AC-2.10): the shell asks first; staying keeps recording,
 *     leaving stops and saves.
 *  4. After Stop the browser storage is empty of any recording (AC-4.11).
 *  5. Keyboard only (AC-13.3): Start, Pause, Resume and Stop are reachable with Tab and
 *     operated with Enter/Space, and every change is announced in the live region.
 *  6. An axe pass (WCAG 2 A/AA) over the capture page, a ready meeting page and the list.
 */
import { expect, type Page } from '@playwright/test'
import {
  axeViolations,
  cleanupPeople,
  createMeetingViaApi,
  deleteMeetingQuietly,
  meetingsCall,
  newRunId,
  personContext,
  seedPerson,
  seedReadyMeeting,
  test,
  type Person,
} from './helpers/meetingsFixtures'

const runId = newRunId()
const CONSENT_NOTICE_VERSION = '2026-11-01' // meetings-ui/src/strings/consent.ts

interface MeetingView {
  status: string
  recording: { live: boolean; durationMs: number; lostMs: number | null } | null
}

test.describe('specs/021 T89: capture robustness', () => {
  let owner: Person
  const created: string[] = []

  test.beforeAll(async () => {
    owner = await seedPerson('cap-owner', 'holder', runId)
  })

  test.afterAll(async () => {
    for (const id of created) await deleteMeetingQuietly(owner, id)
    await cleanupPeople(runId)
  })

  /** A draft, recorded, in-person meeting whose creator has already given consent (setup via the API). */
  async function draftWithConsent(title: string): Promise<string> {
    const meeting = await createMeetingViaApi(owner, { title: `${title} ${runId}`, source: 'recorded' })
    await meetingsCall(owner, 'POST', `/meetings/${meeting.id}/consent`, { noticeVersion: CONSENT_NOTICE_VERSION })
    created.push(meeting.id)
    return meeting.id
  }

  const view = async (id: string): Promise<MeetingView> =>
    (await meetingsCall<MeetingView>(owner, 'GET', `/meetings/${id}`)).body

  /** Everything a page could use to keep audio on the device. */
  const storageSnapshot = (page: Page) =>
    page.evaluate(async () => ({
      local: Object.keys(localStorage).sort(),
      session: Object.keys(sessionStorage).sort(),
      indexedDb: ((await indexedDB.databases?.()) ?? []).map((d) => d.name).sort(),
      caches: await caches.keys(),
    }))

  async function startRecording(page: Page, id: string): Promise<void> {
    await page.goto(`/my-meetings/m/${id}`)
    await expect(page.getByTestId('meetings-recording-options')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('meetings-recording-start').click()
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording', { timeout: 20_000 })
  }

  test('offline 40 s then back: nothing is written to storage, every chunk is saved (AC-2.9, AC-4.11)', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    const id = await draftWithConsent('Offline capture')
    const ctx = await personContext(browser, owner)
    const page = await ctx.newPage()

    await page.goto(`/my-meetings/m/${id}`)
    await expect(page.getByTestId('meetings-recording-options')).toBeVisible({ timeout: 30_000 })
    const baseline = await storageSnapshot(page)
    await page.getByTestId('meetings-recording-start').click()
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording', { timeout: 20_000 })
    const startedAt = Date.now()

    await page.waitForTimeout(12_000) // a first chunk is saved while connected
    await expect(page.getByTestId('meetings-recording-save-status')).toContainText('All audio saved', {
      timeout: 20_000,
    })

    await ctx.setOffline(true)
    const offlineAt = Date.now()
    // The recording goes on, and the person is told the audio is not yet saved (AC-2.9).
    await expect(page.getByTestId('meetings-recording-offline')).toContainText(
      'Audio not yet saved. It survives only while this tab stays open.',
      { timeout: 45_000 },
    )
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording')
    await page.waitForTimeout(Math.max(0, 40_000 - (Date.now() - offlineAt)))
    // Audio that cannot be uploaded is NOT written to the device (AC-4.11).
    expect(await storageSnapshot(page)).toEqual(baseline)

    await ctx.setOffline(false)
    await expect(page.getByTestId('meetings-recording-announcements')).toContainText(
      'Connection restored. Saving audio.',
      {
        timeout: 30_000,
      },
    )
    await expect(page.getByTestId('meetings-recording-save-status')).toContainText('All audio saved', {
      timeout: 90_000,
    })

    await page.waitForTimeout(4_000)
    await page.getByTestId('meetings-recording-stop').click()
    const stoppedAt = Date.now()
    await expect(page.getByTestId('meetings-processing-panel')).toBeVisible({ timeout: 90_000 })

    // Every chunk reached the server: the saved duration covers the whole recording, nothing was lost.
    // (What processing then does with the audio is T88's concern, not this journey's.)
    await expect.poll(async () => (await view(id)).status, { timeout: 30_000 }).toMatch(/^(processing|ready)$/)
    const done = await view(id)
    const recordedMs = stoppedAt - startedAt
    expect(done.recording?.durationMs ?? 0).toBeGreaterThanOrEqual(recordedMs - 6_000)
    expect(done.recording?.lostMs ?? 0).toBe(0)

    // ...and afterwards nothing of the audio remains on the device (AC-4.11).
    expect(await storageSnapshot(page)).toEqual(baseline)
    await ctx.close()
  })

  test('closing the page mid-recording: interrupted, duration kept; Discard leaves the device clean (AC-2.8, AC-4.11)', async ({
    browser,
  }) => {
    test.setTimeout(300_000)
    const id = await draftWithConsent('Closed tab')
    const ctx = await personContext(browser, owner)
    const page = await ctx.newPage()
    await startRecording(page, id)
    const startedAt = Date.now()
    await page.waitForTimeout(35_000) // three full chunks are saved while connected
    await expect(page.getByTestId('meetings-recording-save-status')).toContainText('All audio saved', {
      timeout: 20_000,
    })
    const recordedMs = Date.now() - startedAt
    await page.close({ runBeforeUnload: false })

    // Within 2 minutes it still reads as recording; after 2 minutes without a sign it is interrupted.
    expect((await view(id)).status).toBe('recording')
    await expect.poll(async () => (await view(id)).status, { timeout: 180_000, intervals: [5_000] }).toBe('interrupted')
    const interrupted = await view(id)
    expect(interrupted.recording?.durationMs ?? 0).toBeGreaterThanOrEqual(recordedMs - 20_000)

    // The creator opens it again: Process what was captured / Discard, with the saved duration.
    const again = await ctx.newPage()
    await again.goto(`/my-meetings/m/${id}`)
    await expect(again.getByTestId('meetings-interrupted-banner')).toContainText('Recording interrupted', {
      timeout: 30_000,
    })
    await expect(again.getByTestId('meetings-interrupted-process')).toBeVisible()
    await expect(again.getByTestId('meetings-interrupted-discard')).toBeVisible()
    const baseline = await storageSnapshot(again)

    await again.getByTestId('meetings-interrupted-discard').click()
    await again.getByRole('button', { name: 'Discard audio' }).click()
    await expect(again.getByTestId('meetings-recording-options')).toBeVisible({ timeout: 30_000 }) // draft again
    expect((await view(id)).status).toBe('draft')
    expect(await storageSnapshot(again)).toEqual(baseline)
    expect(baseline).toEqual({ local: [], session: [], indexedDb: [], caches: [] })
    await ctx.close()
  })

  test('a sidebar click while recording asks first; staying keeps recording (AC-2.10)', async ({ browser }) => {
    test.setTimeout(150_000)
    const id = await draftWithConsent('Leave guard')
    const ctx = await personContext(browser, owner)
    const page = await ctx.newPage()
    await startRecording(page, id)

    await page.getByRole('navigation', { name: 'Tool navigation' }).getByRole('link', { name: 'Meetings' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Leave this page?' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog).toContainText('A recording is in progress or audio is not yet saved.')
    // Cancel: still on the meeting, still recording.
    await dialog.getByRole('button', { name: 'Stay' }).click()
    await expect(page).toHaveURL(new RegExp(`/my-meetings/m/${id}`))
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording')

    // Leave: the shell lets go; what was captured is saved by the page before it goes.
    await page.getByRole('navigation', { name: 'Tool navigation' }).getByRole('link', { name: 'Meetings' }).click()
    await page.getByRole('alertdialog', { name: 'Leave this page?' }).getByRole('button', { name: 'Leave' }).click()
    await expect(page).toHaveURL(/\/meetings(\/)?$/, { timeout: 30_000 })
    await ctx.close()
  })

  test('after Stop the browser storage is empty (AC-4.11)', async ({ browser }) => {
    test.setTimeout(180_000)
    const id = await draftWithConsent('Stop storage')
    const ctx = await personContext(browser, owner)
    const page = await ctx.newPage()
    await page.goto(`/my-meetings/m/${id}`)
    await expect(page.getByTestId('meetings-recording-options')).toBeVisible({ timeout: 30_000 })
    const baseline = await storageSnapshot(page)
    await page.getByTestId('meetings-recording-start').click()
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording', { timeout: 20_000 })
    await page.waitForTimeout(12_000)
    expect(await storageSnapshot(page)).toEqual(baseline) // not while recording either
    await page.getByTestId('meetings-recording-stop').click()
    await expect(page.getByTestId('meetings-processing-panel')).toBeVisible({ timeout: 90_000 })
    expect(await storageSnapshot(page)).toEqual(baseline)
    expect(baseline).toEqual({ local: [], session: [], indexedDb: [], caches: [] })
    await ctx.close()
  })

  test('start, pause, resume and stop work from the keyboard and are announced (AC-13.3)', async ({ browser }) => {
    test.setTimeout(150_000)
    const id = await draftWithConsent('Keyboard capture')
    const ctx = await personContext(browser, owner)
    const page = await ctx.newPage()
    await page.goto(`/my-meetings/m/${id}`)
    await expect(page.getByTestId('meetings-recording-options')).toBeVisible({ timeout: 30_000 })

    /** Tab until the element with this test id has focus: proves it is in the keyboard order. */
    const tabTo = async (testId: string) => {
      for (let i = 0; i < 120; i++) {
        const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '')
        if (focused === testId) return
        await page.keyboard.press('Tab')
      }
      throw new Error(`"${testId}" never received focus with Tab`)
    }
    const announcements = page.getByTestId('meetings-recording-announcements')

    await page.locator('body').click({ position: { x: 1, y: 1 } })
    await tabTo('meetings-recording-start')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording', { timeout: 20_000 })
    await expect(announcements).toContainText('Recording started')

    await tabTo('meetings-recording-pause')
    await page.keyboard.press('Space')
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Paused')
    await expect(announcements).toContainText('Recording paused')

    await expect(page.getByTestId('meetings-recording-pause')).toHaveText(/Resume/)
    await tabTo('meetings-recording-pause')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording')
    await expect(announcements).toContainText('Recording resumed')

    await page.waitForTimeout(6_000)
    await tabTo('meetings-recording-stop')
    await page.keyboard.press('Enter')
    await expect(announcements).toContainText('Recording stopped. Saving audio.')
    await expect(page.getByTestId('meetings-processing-panel')).toBeVisible({ timeout: 90_000 })
    await ctx.close()
  })

  test('axe: capture page, meeting page and list have no WCAG A/AA violations (AC-13.3)', async ({ browser }) => {
    test.setTimeout(120_000)
    const draftId = await draftWithConsent('Axe capture')
    const ready = await seedReadyMeeting(owner, `Axe ready ${runId}`)
    created.push(ready.id)
    const ctx = await personContext(browser, owner)
    const page = await ctx.newPage()
    const scan = async (label: string) => {
      // The page's content (the shell's `main`). The shell footer is not part of these screens; its
      // own contrast finding is reported separately.
      const violations = await axeViolations(page, 'main')
      expect(
        violations.map(
          (v) => `${label}: ${v.id} (${v.impact}) ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
        ),
        `${label} must have no axe violations`,
      ).toEqual([])
    }

    await page.goto(`/my-meetings/m/${draftId}`)
    await expect(page.getByTestId('meetings-recording-options')).toBeVisible({ timeout: 30_000 })
    await scan('capture page')

    await page.goto(`/my-meetings/m/${ready.id}`)
    await expect(page.getByRole('heading', { name: ready.title })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('meetings-content-tabs')).toBeVisible()
    await scan('meeting page')

    await page.goto('/my-meetings')
    await expect(page.getByRole('row').filter({ hasText: ready.title })).toBeVisible({ timeout: 30_000 })
    await scan('list')
    await ctx.close()
  })
})
