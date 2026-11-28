/**
 * QE — the "From meeting" mark follows what an automatic entry is recorded on (specs/20261112-meeting-hours: AC-2.3 as changed after
 * the security review, D67, A47; AC-2.7 and D70 for the delete sentence; design S1, S2, S4, F2, F3, F4).
 *
 * T16 could not render this in a browser, so this is the one real-browser proof of it. Nothing is stubbed: a creator records a short
 * meeting with the in-browser recorder (as meeting-hours.spec.ts), meetings-api announces it, hours-api writes the automatic entry,
 * and the journey then moves the entry between targets THROUGH THE ENTRY DIALOG and reads the screens each time with a fresh
 * navigation (the mark is decided by a read, never by what the dialog held, design F2):
 *
 *  A. After Stop the creator has an automatic entry on the meeting.
 *  B. The mark is on the List row and, one click in, on the row of the table view's cell; Everyone's hours (an admin, `time-entry:read-all`)
 *     marks the On cell too.
 *  C. The creator records it on Other work: the mark is gone from the List, from the cell's entries and from Everyone's hours (the
 *     review's I8 case), and hours-api still says `origin: meeting` (AC-2.7 and A47 read it).
 *  D. The creator records it on the meeting again: the mark returns in all three places.
 *  E. Moved to Other work once more, the delete confirmation still says Operai will not record it again (AC-2.7, D70) although the row
 *     has no mark; deleting it removes it for good.
 *
 * Needs the same stack as meeting-hours.spec.ts (`mise run dev`; the meetings-api entry of auth's SERVICE_CLIENTS carrying
 * `meeting-hours-notices.send`); the flags to reuse it are in that file's header. Screenshots go to E2E_MARK_SHOTS_DIR
 * (default `/tmp/qe-meeting-hours/shots`).
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import {
  cleanupPeople,
  createMeetingViaApi,
  deleteMeetingQuietly,
  meetingsAdmin,
  meetingsCall,
  newRunId,
  personContext,
  seedPerson,
  test,
  type Person,
} from './helpers/meetingsFixtures'
import {
  deleteOwnEntriesQuietly,
  ownEntriesViaApi,
  pickCategories,
  todayZurich,
  type CategoryRow,
  type EntryRow,
} from './helpers/hoursFixtures'

test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
})

const runId = newRunId()
const CONSENT_NOTICE_VERSION = '2026-11-05' // = meetings-ui/src/strings/consent.ts, as meetings-capture.spec.ts
const ARRIVAL_BUDGET_MS = 100_000
const POLL_EVERY_MS = 3_000
const SHOTS = process.env['E2E_MARK_SHOTS_DIR'] ?? '/tmp/qe-meeting-hours/shots'

const MARK = 'From meeting'
const DELETE_NOTE = "Operai won't record it again from its meeting. You can still record hours yourself."

type ApiEntry = EntryRow & { origin?: string }
interface MeetingView {
  startsAt: string
  status: string
  durationMs: number | null
}

const zurichDay = (instant: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant))

test.describe('specs/20261112-meeting-hours QE: the "From meeting" mark follows what the entry is recorded on (D67)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let creator: Person
  let title: string
  let meetingId: string
  let day: string
  let entryId = ''
  let category: CategoryRow

  test.beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true })
    creator = await seedPerson('mhq-creator', 'holder', runId)
    title = `Meeting hours mark ${runId}`
    const draft = await createMeetingViaApi(creator, { title, source: 'recorded' })
    meetingId = draft.id
    await meetingsCall(creator, 'POST', `/meetings/${meetingId}/consent`, { noticeVersion: CONSENT_NOTICE_VERSION })
    const admin = await meetingsAdmin()
    ;[category] = await pickCategories(admin)
  })

  test.afterAll(async () => {
    if (creator) await deleteOwnEntriesQuietly(creator, day ?? todayZurich())
    if (creator && meetingId) await deleteMeetingQuietly(creator, meetingId)
    await cleanupPeople(runId)
  })

  // ─── helpers ────────────────────────────────────────────────────────────────

  /** A screenshot of ONE element (the row, the card or the dialog under test): the viewport of these pages shows only filters. */
  const shot = async (target: Locator, name: string): Promise<void> => {
    await target.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  }

  async function apiEntry(): Promise<ApiEntry | undefined> {
    const entries = (await ownEntriesViaApi(creator, day, day)) as ApiEntry[]
    return entries.find((entry) => entry.id === entryId)
  }

  async function openList(page: Page): Promise<void> {
    await page.goto('/hours?view=list')
    await expect(page.getByTestId('hours-entries')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('hours-entries-skeleton')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('hours-entries-error')).toHaveCount(0)
  }

  async function openTable(page: Page): Promise<void> {
    await page.goto(day === todayZurich() ? '/hours' : `/hours?week=${day}`)
    await expect(page.getByTestId('hours-table-heading')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('hours-table-skeleton')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('hours-table-error')).toHaveCount(0)
  }

  /** Everyone's hours as the admin: the table has been read, and the creator's row of the day is the one asked for. */
  async function everyoneRow(page: Page): Promise<Locator> {
    await page.goto('/hours/all')
    await expect(page.getByTestId('hours-everyone-page')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('hours-entries-skeleton')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('hours-entries-error')).toHaveCount(0)
    const table = page.getByTestId('hours-entries-table')
    await expect(table).toBeVisible({ timeout: 30_000 })
    const row = table.getByRole('row').filter({ hasText: creator.name })
    await expect(row, "Everyone's hours lists the creator's entry of the day").toHaveCount(1, { timeout: 30_000 })
    return row
  }

  /** The entry dialog, opened from the List's Edit button. */
  async function openEdit(page: Page): Promise<Locator> {
    await openList(page)
    await page.getByTestId(`hours-entry-${entryId}-edit`).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    return dialog
  }

  async function recordOnOtherWork(page: Page): Promise<void> {
    const dialog = await openEdit(page)
    await dialog.getByTestId('hours-entry-on-none').check()
    await dialog.getByTestId('hours-entry-category').selectOption(category.id)
    if (category.requiresNote) await dialog.getByTestId('hours-entry-note').fill('moved by QE')
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await dialog.waitFor({ state: 'detached', timeout: 30_000 })
  }

  async function recordOnTheMeeting(page: Page): Promise<void> {
    const dialog = await openEdit(page)
    await dialog.getByTestId('hours-entry-on-meeting').check()
    await dialog.getByTestId('hours-entry-meeting-input').fill(title)
    await page.getByTestId(`hours-entry-meeting-input-option-${meetingId}`).click()
    await dialog.getByTestId('hours-entry-dialog-submit').click()
    await dialog.waitFor({ state: 'detached', timeout: 30_000 })
  }

  const mark = (scope: Page | Locator): Locator => scope.getByTestId(`hours-entry-${entryId}-from-meeting`)

  // ─── A ──────────────────────────────────────────────────────────────────────

  test('A: after Stop the creator has an automatic entry on the meeting', async ({ browser }) => {
    test.setTimeout(300_000)
    const ctx = await personContext(browser, creator)
    const page = await ctx.newPage()
    await page.goto(`/my-meetings/m/${meetingId}`)
    await expect(page.getByTestId('meetings-recording-options')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('meetings-recording-start').click()
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording', { timeout: 20_000 })
    await page.waitForTimeout(12_000)
    await expect(page.getByTestId('meetings-recording-save-status')).toContainText('All audio saved', {
      timeout: 20_000,
    })
    await page.getByTestId('meetings-recording-stop').click()
    const stoppedAt = Date.now()
    await expect(page.getByTestId('meetings-processing-panel')).toBeVisible({ timeout: 90_000 })

    const view = (await meetingsCall<MeetingView>(creator, 'GET', `/meetings/${meetingId}`)).body
    expect(view.durationMs ?? 0, 'the stored recording has a duration (else no entry is due, AC-1.3)').toBeGreaterThan(
      0,
    )
    day = zurichDay(view.startsAt)

    // Navigated to until the entry is in the read (never a live update, design G5).
    const deadline = Date.now() + ARRIVAL_BUDGET_MS
    for (;;) {
      const held = await apiEntry0()
      if (held) {
        entryId = held.id
        expect(held.origin).toBe('meeting')
        expect(held.on.type).toBe('meeting')
        expect(held.minutes).toBe(30)
        break
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `No automatic entry reached ${creator.email} ${Math.round((Date.now() - stoppedAt) / 1000)} s after Stop. Check first: the scope ` +
            "`meeting-hours-notices.send` on the `meetings-api` entry of auth's SERVICE_CLIENTS, then `HOURS_API_URL` of meetings-api, " +
            "then hours-api's SERVICE_AUDIENCE (see meeting-hours.spec.ts).",
        )
      }
      await page.waitForTimeout(POLL_EVERY_MS)
    }
    await ctx.close()
  })

  /** The creator's entry on the meeting, before its id is known. */
  async function apiEntry0(): Promise<ApiEntry | undefined> {
    const entries = (await ownEntriesViaApi(creator, day, day)) as ApiEntry[]
    return entries.find((entry) => entry.on.type === 'meeting' && entry.on.id === meetingId)
  }

  // ─── B ──────────────────────────────────────────────────────────────────────

  test("B: on its meeting the entry is marked in the List, in the cell's entries and in Everyone's hours", async ({
    browser,
  }) => {
    expect(entryId, 'A recorded the entry').not.toBe('')
    const ctx = await personContext(browser, creator)
    const page = await ctx.newPage()
    await openList(page)
    await expect(page.getByTestId(`hours-entry-${entryId}`)).toContainText(title)
    await expect(mark(page)).toHaveText(MARK)
    await shot(page.getByTestId(`hours-entry-${entryId}`), 'B1-list-on-meeting-marked')

    await openTable(page)
    await page.locator(`[data-cell="meeting:${meetingId}:${day}"]`).click()
    const dialog = page.getByRole('dialog', { name: `Meeting: ${title}` })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(mark(dialog)).toHaveText(MARK)
    await shot(dialog, 'B2-cell-dialog-on-meeting-marked')
    await ctx.close()

    const adminCtx = await personContext(browser, await meetingsAdmin())
    const adminPage = await adminCtx.newPage()
    const row = await everyoneRow(adminPage)
    await expect(row.getByText(MARK, { exact: true })).toHaveCount(1)
    await expect(row).toContainText('Meeting')
    await shot(row, 'B3-everyone-on-meeting-marked')
    await adminCtx.close()
  })

  // ─── C ──────────────────────────────────────────────────────────────────────

  test('C: recorded on Other work the entry loses the mark everywhere and still says origin: meeting (AC-2.3, D67, I8)', async ({
    browser,
  }) => {
    expect(entryId).not.toBe('')
    const ctx = await personContext(browser, creator)
    const page = await ctx.newPage()
    await recordOnOtherWork(page)

    // hours-api: the entry is on no entity now, and Operai's still (the delete sentence and A47 read origin).
    const moved = await apiEntry()
    expect(moved?.on.type, 'the person moved it to Other work').toBe('none')
    expect(moved?.origin, 'origin is never recomputed on a move (D70)').toBe('meeting')

    // The List, read afresh: the row is on Other work and carries no mark, and nothing else of the day does.
    await openList(page)
    const row = page.getByTestId(`hours-entry-${entryId}`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('Other work')
    await expect(row).not.toContainText(title)
    await expect(mark(page), 'List: no mark once recorded on other work').toHaveCount(0)
    await expect(page.getByText(MARK, { exact: true })).toHaveCount(0)
    await shot(row, 'C1-list-on-other-work-unmarked')

    // The table view: its cell is the category's now, and the entries it opens show no mark.
    await openTable(page)
    await expect(page.locator(`[data-cell="meeting:${meetingId}:${day}"]`)).toHaveCount(0)
    await page.locator(`[data-cell="category:${category.id}:${day}"]`).click()
    const dialog = page.getByRole('dialog').last()
    await expect(dialog.getByTestId(`hours-entry-${entryId}`)).toBeVisible({ timeout: 30_000 })
    await expect(mark(dialog), "the cell's entries: no mark").toHaveCount(0)
    await shot(dialog, 'C2-cell-dialog-on-other-work-unmarked')
    await ctx.close()

    // Everyone's hours: the review's I8 case. A holder no longer learns from the mark that the person attended a meeting.
    const adminCtx = await personContext(browser, await meetingsAdmin())
    const adminPage = await adminCtx.newPage()
    const everyone = await everyoneRow(adminPage)
    await expect(everyone.getByText(MARK, { exact: true }), "Everyone's hours: no mark").toHaveCount(0)
    await expect(everyone).toContainText('Other work')
    await shot(everyone, 'C3-everyone-on-other-work-unmarked')
    await adminCtx.close()
  })

  // ─── D ──────────────────────────────────────────────────────────────────────

  test('D: recorded on the meeting again, the mark returns in all three places (AC-2.3, A47)', async ({ browser }) => {
    const ctx = await personContext(browser, creator)
    const page = await ctx.newPage()
    await recordOnTheMeeting(page)
    const back = await apiEntry()
    expect(back?.on.type).toBe('meeting')
    expect(back?.origin).toBe('meeting')

    await openList(page)
    await expect(page.getByTestId(`hours-entry-${entryId}`)).toContainText(title, { timeout: 30_000 })
    await expect(mark(page), 'List: the mark is back').toHaveText(MARK)
    await shot(page.getByTestId(`hours-entry-${entryId}`), 'D1-list-back-on-meeting-marked')

    await openTable(page)
    await page.locator(`[data-cell="meeting:${meetingId}:${day}"]`).click()
    const dialog = page.getByRole('dialog', { name: `Meeting: ${title}` })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(mark(dialog), "the cell's entries: the mark is back").toHaveText(MARK)
    await ctx.close()

    const adminCtx = await personContext(browser, await meetingsAdmin())
    const adminPage = await adminCtx.newPage()
    const row = await everyoneRow(adminPage)
    await expect(row.getByText(MARK, { exact: true }), "Everyone's hours: the mark is back").toHaveCount(1)
    await shot(row, 'D2-everyone-back-on-meeting-marked')
    await adminCtx.close()
  })

  // ─── E ──────────────────────────────────────────────────────────────────────

  test('E: a moved entry has no mark but its delete confirmation still carries the second paragraph (AC-2.7, D70)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, creator)
    const page = await ctx.newPage()
    await recordOnOtherWork(page)
    await openList(page)
    await expect(page.getByTestId(`hours-entry-${entryId}`)).toBeVisible({ timeout: 30_000 })
    await expect(mark(page)).toHaveCount(0)

    await page.getByTestId(`hours-entry-${entryId}-delete`).click()
    const asked = page.getByRole('alertdialog', { name: 'Delete this entry?' })
    await expect(asked).toBeVisible()
    await expect(asked).toContainText("This can't be undone.")
    await expect(
      asked.locator('p').filter({ hasText: DELETE_NOTE }),
      'the second paragraph is there, once',
    ).toHaveCount(1)
    await expect(asked).toContainText(
      new RegExp(`This can't be undone\\.[\\s\\S]*${DELETE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
    // Design S4 (a11y): focus opens on Cancel, and a screen reader reads the second paragraph as part of the dialog's description.
    await expect(asked.getByRole('button', { name: 'Cancel' }), 'focus opens on Cancel').toBeFocused()
    await expect(asked, 'the second paragraph is part of the accessible description').toHaveAccessibleDescription(
      new RegExp(`This can't be undone\\.[\\s\\S]*${DELETE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
    await shot(asked, 'E1-delete-dialog-moved-entry')
    // Keyboard only: Tab from Cancel reaches Delete entry, and Enter on it confirms.
    await page.keyboard.press('Tab')
    await expect(asked.getByRole('button', { name: 'Delete entry' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('hours-entry-deleted')).toContainText('Entry deleted.', { timeout: 30_000 })
    await expect(page.getByTestId(`hours-entry-${entryId}`)).toHaveCount(0)

    await openList(page)
    await expect(page.getByTestId(`hours-entry-${entryId}`)).toHaveCount(0)
    expect(await apiEntry(), 'hours-api no longer holds the entry').toBeUndefined()
    await ctx.close()
  })
})
