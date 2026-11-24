/**
 * T11 — A recorded meeting gives both people a marked entry (specs/20261112-meeting-hours: AC-1.1, AC-2.1, AC-2.3, and
 * AC-2.7 and AC-2.5's reload on the way; plan § Test strategy, row AC-1.1 level E).
 *
 * Nothing is stubbed. A creator records a short meeting with the in-browser recorder (the WebAudio microphone of
 * meetings-capture.spec.ts: MediaRecorder -> presigned chunk uploads -> meetings-api) with one Operai participant and presses
 * Stop. meetings-api writes a `hours_notice` in the stop's own transaction and its job runner sends it to hours-api's
 * `POST /system/meeting-hours/v1/notices` as `system:meetings-api` (scope `meeting-hours-notices.send`); hours-api applies it:
 * one automatic entry for the creator and one for the participant, on the meeting's Europe/Zurich day, 30 minutes (a recording of a few
 * seconds rounds up to the first half hour, A36). Everything the journey asserts about what a person SEES goes through the
 * browser; hours-api's REST is used for SETUP, for the entry ids the screens are checked against and for naming what is wrong when
 * nothing arrives.
 *
 *  A. After Stop, once the notice is delivered, each person's My hours (the table view, the current week) shows 30 min on the
 *     meeting's row for its day, with no mark on the grid itself (AC-1.1, AC-2.1; design S1: a cell is a sum and is never marked).
 *     Arrival is NEVER awaited as a live update (design G5): the page is navigated to again until the entry is in the read.
 *     When it never comes, the spec FAILS, saying that the scope `meeting-hours-notices.send` of meetings-api's entry in auth's
 *     `SERVICE_CLIENTS` and meetings-api's `HOURS_API_URL` are the first things to check. It is never skipped.
 *  B. In the List and in the entries a table cell opens, each person's row for the meeting is marked "From meeting"; an entry the creator
 *     typed by hand the same day is not (so the mark tells the two apart), and the API says the entry is `origin: meeting` (AC-2.1, AC-2.3).
 *  C. Deleting it asks, and the confirmation carries the second paragraph (AC-2.7). The creator deletes from the List, the participant from
 *     the cell's entries; each row stays gone after the next reload, in both views and in hours-api, and the creator's delete leaves the
 *     participant's entry alone (AC-2.5, the screen side).
 *
 * Needs the stack up (`mise run dev`): auth with ENABLE_TEST_AUTH, hours-api and meetings-api (fake AI provider), their databases
 * migrated with this feature's migrations, MinIO for the audio chunks, and the `meetings-api` entry of auth's `SERVICE_CLIENTS`
 * carrying `meeting-hours-notices.send` (`notifications.push host-notices.send meeting-hours-notices.send`). notify-api is NOT needed.
 * Against the dev stack Playwright reuses the servers when each remote's port is pointed at it:
 *   E2E_ESTIMAI_REMOTE_PORT=5174 E2E_REFUND_REMOTE_PORT=5175 E2E_NOTIFY_REMOTE_PORT=5176 \
 *   E2E_ADMIN_REMOTE_PORT=5177 E2E_INVENTORY_REMOTE_PORT=5178 E2E_CRM_REMOTE_PORT=5179 \
 *   E2E_MEETINGS_REMOTE_PORT=5180 E2E_PROJECTS_REMOTE_PORT=5181 E2E_LETTERHEADS_REMOTE_PORT=5182 \
 *   E2E_ACCOUNTING_REMOTE_PORT=5183 E2E_HOURS_REMOTE_PORT=5184 \
 *   pnpm e2e meeting-hours.spec.ts
 * and, on a machine with no accounting-api (nothing here reads Accounting, the registry or an offer), add
 * `E2E_SKIP_ACCOUNTING_SEED=1 E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 E2E_SKIP_LEGAL_ENTITIES_SETUP=1`.
 *
 * The people are per-run (`mtg-mh-*@operai.test`); the entries they still hold, the meeting and the people are removed afterwards (a
 * person deletes their OWN entries only). The meeting's day is read from the meeting itself (its `startsAt` in Europe/Zurich, the day
 * hours-api records on), which is today except for a run that crosses Zurich midnight.
 */
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
  setParticipants,
  test,
  type Person,
} from './helpers/meetingsFixtures'
import {
  createEntryViaApi,
  deleteOwnEntriesQuietly,
  ownEntriesViaApi,
  pickCategories,
  todayZurich,
  type EntryRow,
} from './helpers/hoursFixtures'

// The `chromium` project runs this file (the `meetings` project takes only `meetings-*.spec.ts`), so the permission and the flags
// of that project are repeated here: the WebAudio microphone of `installFakeMicrophone` does not need them, they are belt and braces.
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
const CONSENT_NOTICE_VERSION = '2026-11-05' // meetings-ui/src/strings/consent.ts = meetings-api CONSENT_NOTICE_VERSION (as meetings-capture.spec.ts)

/** How long the notice may take, from Stop to an entry in the read: its sender retries after 30 s, so one retry fits and a second does not. */
const ARRIVAL_BUDGET_MS = 100_000
/** Between two reads of My hours (the page is navigated to again each time; nothing waits for a live update, design G5). */
const POLL_EVERY_MS = 3_000

const MARK = 'From meeting'
const DELETE_NOTE = "Operai won't record it again from its meeting. You can still record hours yourself."

interface MeetingView {
  startsAt: string
  status: string
  durationMs: number | null
}

/** hours-api's entry as it is returned, with the member the mark rests on (`EntryRow` of the fixtures does not list it). */
type ApiEntry = EntryRow & { origin?: string }

/** `YYYY-MM-DD` in Europe/Zurich, the day hours-api records an automatic entry on. */
const zurichDay = (instant: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant))
const dmy = (day: string): string => day.split('-').reverse().join('.')
/** A text as a regular expression that matches it literally. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Why nothing arrived: the first things to check, in the order the notice travels. Never a skip. */
const NOTICE_HINT =
  "Check first: (1) the scope `meeting-hours-notices.send` on the `meetings-api` entry of auth's SERVICE_CLIENTS " +
  "(`notifications.push host-notices.send meeting-hours-notices.send`; without it every notice is a 401 and waits in meetings-api's outbox); " +
  '(2) `HOURS_API_URL` of meetings-api (default http://localhost:8090, required in production: it must name the running hours-api); ' +
  "then (3) hours-api's own SERVICE_AUDIENCE (it must equal auth's), (4) meetings-api's `hours_notice` rows for the meeting and its " +
  '`meeting_hours.notice_*` log lines (a failed notice retries after 30 s, 2 min, 10 min, then every 30 min).'

test.describe('specs/20261112-meeting-hours T11: a recorded meeting gives both people a marked entry', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  let creator: Person
  let guest: Person
  let title: string
  let meetingId: string
  let meetingView: MeetingView
  let day: string
  const entryOf: Record<'creator' | 'guest', string> = { creator: '', guest: '' }
  let controlId = ''

  test.beforeAll(async () => {
    creator = await seedPerson('mh-creator', 'holder', runId)
    guest = await seedPerson('mh-guest', 'holder', runId)
    title = `Meeting hours ${runId}`
    // A draft, recorded, in-person meeting whose creator has already given consent, with one Operai participant (setup via the API:
    // the participant is a hours fact the Stop will announce, AC-1.1; the recording itself is driven through the page).
    const draft = await createMeetingViaApi(creator, { title, source: 'recorded' })
    meetingId = draft.id
    await meetingsCall(creator, 'POST', `/meetings/${meetingId}/consent`, { noticeVersion: CONSENT_NOTICE_VERSION })
    await setParticipants(creator, meetingId, [{ userId: guest.userId }])
  })

  test.afterAll(async () => {
    // A person deletes their own entries; then the meeting (its `deleted` notice removes what is still untouched) and the people.
    const from = day ?? todayZurich()
    for (const person of [creator, guest]) if (person) await deleteOwnEntriesQuietly(person, from)
    if (creator && meetingId) await deleteMeetingQuietly(creator, meetingId)
    await cleanupPeople(runId)
  })

  // ─── Helpers over the page ──────────────────────────────────────────────────

  const meetingCell = (page: Page): Locator => page.locator(`[data-cell="meeting:${meetingId}:${day}"]`)
  const tableUrl = (): string => (day === todayZurich() ? '/hours' : `/hours?week=${day}`)

  /** My hours' table view, drawn: the period has been read (no skeleton) and the read did not fail. */
  async function openTable(page: Page): Promise<void> {
    await page.goto(tableUrl())
    await expect(page.getByTestId('hours-table-heading')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('hours-table-skeleton')).toHaveCount(0, { timeout: 30_000 })
    await expect(
      page.getByTestId('hours-table-error'),
      'My hours could not read the period (hours-api down or refusing?), which is not "no entry yet"',
    ).toHaveCount(0)
  }

  /** My hours' List, drawn: the read is over (no skeleton) and did not fail. */
  async function openList(page: Page): Promise<void> {
    await page.goto('/hours?view=list')
    await expect(page.getByTestId('hours-entries')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('hours-entries-skeleton')).toHaveCount(0, { timeout: 30_000 })
    await expect(
      page.getByTestId('hours-entries-error'),
      'My hours could not read the List (hours-api down or refusing?), which is not "no entry yet"',
    ).toHaveCount(0)
  }

  /** The entry hours-api holds for `person` on the meeting, or undefined: out-of-band, the screens are what is asserted. */
  async function apiEntry(person: Person): Promise<ApiEntry | undefined> {
    const entries = (await ownEntriesViaApi(person, day, day)) as ApiEntry[]
    return entries.find((entry) => entry.on.type === 'meeting' && entry.on.id === meetingId)
  }

  /** What to say when no entry reached the screen: whether hours-api has it tells the notice's fault from the screen's. */
  async function explainMissing(person: Person, waitedMs: number): Promise<string> {
    const waited = `${Math.round(waitedMs / 1000)} s`
    const view = (await meetingsCall<MeetingView>(creator, 'GET', `/meetings/${meetingId}`)).body
    const meeting = `meeting ${meetingId} (status ${view.status}, duration ${view.durationMs ?? 'unknown'} ms, starts ${view.startsAt})`
    let held: ApiEntry | undefined
    try {
      held = await apiEntry(person)
    } catch (error) {
      return (
        `No automatic entry reached ${person.email}'s My hours ${waited} after Stop, and hours-api could not be asked either ` +
        `(${error instanceof Error ? error.message : String(error)}). ${meeting}. ${NOTICE_HINT}`
      )
    }
    if (held) {
      return (
        `hours-api HOLDS the automatic entry ${held.id} of ${person.email} (${held.minutes} min on ${held.day}) but the table view of My hours ` +
        `did not show a cell for the meeting ${waited} after Stop: this is hours-ui or the table view, not the notice. ${meeting}.`
      )
    }
    const noDuration = (view.durationMs ?? 0) <= 0
    return (
      `No automatic entry reached ${person.email}'s My hours ${waited} after Stop, and hours-api holds none for the meeting either. ` +
      `${NOTICE_HINT} ${meeting}.${noDuration ? ' NOTE: the meeting has no duration, so no entry is due (AC-1.3): the recording saved no audio.' : ''}`
    )
  }

  /** Navigates to My hours' table until the meeting's cell is there; when the budget runs out the spec fails with `explainMissing`. */
  async function waitForArrival(page: Page, person: Person, budgetMs: number, since: number): Promise<void> {
    const deadline = Date.now() + budgetMs
    for (;;) {
      await openTable(page)
      if ((await meetingCell(page).count()) > 0) return
      if (Date.now() >= deadline) break
      await page.waitForTimeout(POLL_EVERY_MS)
    }
    throw new Error(await explainMissing(person, Date.now() - since))
  }

  // ─── A ──────────────────────────────────────────────────────────────────────

  test('A: after Stop, once the notice is delivered, both people see 30 min on the meeting in the table view (AC-1.1, AC-2.1)', async ({
    browser,
  }) => {
    // Stop may take up to 90 s to reach the processing panel, then the notice up to ARRIVAL_BUDGET_MS: the hint, not Playwright's
    // generic timeout, is what a failure must say.
    test.setTimeout(300_000)

    // The creator records for a few seconds with the fake microphone, then presses Stop.
    const creatorCtx = await personContext(browser, creator)
    const page = await creatorCtx.newPage()
    await page.goto(`/my-meetings/m/${meetingId}`)
    await expect(page.getByTestId('meetings-recording-options')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('meetings-recording-start').click()
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording', { timeout: 20_000 })
    await page.waitForTimeout(12_000) // a first chunk is saved while connected
    await expect(page.getByTestId('meetings-recording-save-status')).toContainText('All audio saved', {
      timeout: 20_000,
    })
    await page.getByTestId('meetings-recording-stop').click()
    const stoppedAt = Date.now()
    await expect(page.getByTestId('meetings-processing-panel')).toBeVisible({ timeout: 90_000 })

    // The duration is what the notice carries: the meeting holds the audio's length, and its day is the one the entry is recorded on.
    meetingView = (await meetingsCall<MeetingView>(creator, 'GET', `/meetings/${meetingId}`)).body
    expect(
      meetingView.durationMs ?? 0,
      'the stored recording has a duration (else no entry is due, AC-1.3)',
    ).toBeGreaterThan(0)
    day = zurichDay(meetingView.startsAt)

    // The creator's My hours, navigated to until the entry is in the read (never a live update, design G5), then the participant's.
    await waitForArrival(page, creator, ARRIVAL_BUDGET_MS, stoppedAt)
    const guestCtx = await personContext(browser, guest)
    const guestPage = await guestCtx.newPage()
    // One notice writes both entries in one transaction, so the participant's is there when the creator's is: a short poll covers reads only.
    await waitForArrival(guestPage, guest, 20_000, stoppedAt)

    for (const [who, person, view] of [
      ['creator', creator, page],
      ['guest', guest, guestPage],
    ] as const) {
      await openTable(view)
      const cell = meetingCell(view)
      await expect(cell, `${who}: 30 minutes in the meeting's cell for ${day}`).toHaveText('30 min')
      await expect(cell).toHaveAttribute('aria-label', /^30 min on .+, 1 entry$/)
      // The row is the meeting's, its Total is the cell's, and the grid itself carries no mark (design S1: a cell is a sum).
      const row = view.getByTestId(`hours-table-row-meeting:${meetingId}`)
      await expect(row).toContainText(title)
      await expect(row.getByRole('cell').last()).toHaveText('30 min')
      await expect(view.getByTestId('hours-table-table')).not.toContainText(MARK)

      // The entry hours-api holds: the person's own, on the meeting, one half hour, recorded by Operai (the fact the mark rests on).
      const held = await apiEntry(person)
      expect(held, `${who}: hours-api holds the entry the screen shows`).toBeDefined()
      expect(held!.minutes).toBe(30)
      expect(held!.day).toBe(day)
      expect(held!.person.id).toBe(person.userId)
      expect(held!.origin).toBe('meeting')
      entryOf[who] = held!.id
    }
    expect(entryOf.creator).not.toBe(entryOf.guest) // one entry each: the creator is not also listed as a participant (AC-1.2)

    await creatorCtx.close()
    await guestCtx.close()
  })

  // ─── B ──────────────────────────────────────────────────────────────────────

  test('B: the List and the cell\'s entries mark the row "From meeting"; an entry typed by hand has no mark (AC-2.1, AC-2.3)', async ({
    browser,
  }) => {
    expect(entryOf.creator, 'A recorded the entries').not.toBe('')

    // A control the mark must tell apart: the creator types 30 minutes of Other work on the same day.
    const admin = await meetingsAdmin()
    const [category] = await pickCategories(admin)
    const control = await createEntryViaApi(creator, {
      day,
      minutes: 30,
      on: { type: 'none', categoryId: category.id },
    })
    controlId = control.id

    for (const [who, person, id] of [
      ['creator', creator, entryOf.creator],
      ['guest', guest, entryOf.guest],
    ] as const) {
      const ctx = await personContext(browser, person)
      const page = await ctx.newPage()

      // The List: the meeting's row carries the mark and names the meeting; the typed entry's row does not.
      await openList(page)
      const row = page.getByTestId(`hours-entry-${id}`)
      await expect(row, `${who}: the meeting's row in the List`).toBeVisible({ timeout: 30_000 })
      await expect(row).toContainText(title)
      const mark = page.getByTestId(`hours-entry-${id}-from-meeting`)
      await expect(mark).toBeVisible()
      await expect(mark).toHaveText(MARK)
      await expect(row.getByTestId(`hours-entry-${id}-from-meeting`)).toHaveCount(1)
      if (who === 'creator') {
        await expect(page.getByTestId(`hours-entry-${controlId}`)).toBeVisible()
        await expect(page.getByTestId(`hours-entry-${controlId}-from-meeting`)).toHaveCount(0)
      }
      await expect(page.getByText(MARK, { exact: true })).toHaveCount(1) // exactly the meeting's row of this person

      // The table view: the cell opens the entries of the meeting for the day; there the same row carries the mark.
      await openTable(page)
      await meetingCell(page).click()
      const dialog = page.getByRole('dialog', { name: `Meeting: ${title}` })
      await expect(dialog, `${who}: the cell's entries`).toBeVisible({ timeout: 30_000 })
      await expect(dialog.getByTestId(`hours-entry-${id}`)).toBeVisible()
      await expect(dialog.getByTestId(`hours-entry-${id}-from-meeting`)).toHaveText(MARK)
      await expect(dialog.getByText(MARK, { exact: true })).toHaveCount(1)
      await dialog.getByTestId('hours-table-cell-done').click()
      await expect(dialog).toHaveCount(0)
      await ctx.close()
    }
  })

  // ─── C ──────────────────────────────────────────────────────────────────────

  test('C: deleting asks, with the second paragraph, and the row stays gone after a reload (AC-2.7, AC-2.5)', async ({
    browser,
  }) => {
    expect(entryOf.guest, 'A recorded the entries').not.toBe('')
    const confirmation = (page: Page): Locator => page.getByRole('alertdialog', { name: 'Delete this entry?' })
    const firstSentence = new RegExp(
      `30 min on ${escapeRegExp(title)}, ${escapeRegExp(dmy(day))}\\. This can't be undone\\.`,
    )
    const orderedSentences = new RegExp(`This can't be undone\\.[\\s\\S]*${escapeRegExp(DELETE_NOTE)}`)

    // The creator deletes from the List.
    const creatorCtx = await personContext(browser, creator)
    const page = await creatorCtx.newPage()
    await openList(page)
    await expect(page.getByTestId(`hours-entry-${entryOf.creator}`)).toBeVisible({ timeout: 30_000 })
    await page.getByTestId(`hours-entry-${entryOf.creator}-delete`).click()
    const asked = confirmation(page)
    await expect(asked).toBeVisible()
    await expect(asked).toContainText(firstSentence) // the sentence every entry's confirmation has
    await expect(asked).toContainText(DELETE_NOTE) // AC-2.7: the second paragraph, for an automatic entry
    await expect(asked.locator('p').filter({ hasText: DELETE_NOTE })).toHaveCount(1)
    await expect(asked).toContainText(orderedSentences) // after the first sentence, not before
    await page.getByTestId('hours-entry-delete-dialog-confirm').click()
    await expect(page.getByTestId('hours-entry-deleted')).toContainText('Entry deleted.', { timeout: 30_000 })
    await expect(page.getByTestId(`hours-entry-${entryOf.creator}`)).toHaveCount(0)

    // Gone for good: after the next reload, in the List and in the table view, and in hours-api; the typed entry is untouched.
    await openList(page)
    await expect(page.getByTestId(`hours-entry-${controlId}`)).toBeVisible() // the List has been read: the typed entry is in it
    await expect(page.getByTestId(`hours-entry-${entryOf.creator}`)).toHaveCount(0)
    await openTable(page)
    await expect(page.getByTestId('hours-table-table')).toBeVisible() // the table has been read: the typed entry's row is in it
    await expect(meetingCell(page)).toHaveCount(0)
    await expect(page.getByTestId(`hours-table-row-meeting:${meetingId}`)).toHaveCount(0)
    expect(await apiEntry(creator), "hours-api no longer holds the creator's entry").toBeUndefined()
    // ... and the creator's delete did not touch the participant's entry (each person's entry is their own).
    expect((await apiEntry(guest))?.id, 'the participant keeps theirs').toBe(entryOf.guest)
    await creatorCtx.close()

    // The participant deletes from the cell's entries in the table view.
    const guestCtx = await personContext(browser, guest)
    const guestPage = await guestCtx.newPage()
    await openTable(guestPage)
    await meetingCell(guestPage).click()
    const dialog = guestPage.getByRole('dialog', { name: `Meeting: ${title}` })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await dialog.getByTestId(`hours-entry-${entryOf.guest}-delete`).click()
    const guestAsked = confirmation(guestPage)
    await expect(guestAsked).toBeVisible()
    await expect(guestAsked).toContainText(firstSentence)
    await expect(guestAsked).toContainText(DELETE_NOTE)
    await expect(guestAsked).toContainText(orderedSentences)
    await guestPage.getByTestId('hours-entry-delete-dialog-confirm').click()
    // The cell is empty now: its dialog goes and the cell is blank (no control), as the page does for any entry.
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    await expect(meetingCell(guestPage)).toHaveCount(0, { timeout: 30_000 })

    await openTable(guestPage)
    await expect(guestPage.getByTestId('hours-table-empty')).toBeVisible() // the week has been read and holds nothing of theirs
    await expect(meetingCell(guestPage)).toHaveCount(0)
    await openList(guestPage)
    await expect(guestPage.getByTestId('hours-entries-empty')).toBeVisible() // the List has been read and is empty
    await expect(guestPage.getByTestId(`hours-entry-${entryOf.guest}`)).toHaveCount(0)
    expect(await apiEntry(guest), "hours-api no longer holds the participant's entry").toBeUndefined()
    await guestCtx.close()
  })
})
