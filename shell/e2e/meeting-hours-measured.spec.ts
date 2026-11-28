/**
 * QE — a duration the audio contradicts is replaced by the measured one, and the entry follows (specs/20261112-meeting-hours:
 * AC-3.8, AC-3.9; A43 and design F5 / S5 / G7 for what Meetings shows; plan § The measured duration; row AC-3.8 level I-M, here in the
 * real stack).
 *
 * A fake microphone can never make the recorded pieces and the decoded audio differ by more than the 30-second floor, so this drives
 * the recording API directly with an honest-looking but inflated claim: a REAL 12 s audio file, cut into byte slices that are
 * uploaded as consecutive pieces, each CONFIRMED as 15 s. The meeting then holds 240 x 15 s = 1 h (what the creator's browser
 * "reported"), while ffmpeg decodes 12 s. `prepare_audio` must replace the held 1 h with the measured ~12 s (the difference is far
 * beyond max(30 s, 10 %)), and hours-api must follow: the untouched entry built from the first notice (60 min) becomes 30 min.
 *
 * What it asserts, each against the running services:
 *  1. the meeting's `durationMs` ends at the measured length (within 2 s of ffprobe) and not at the held hour (AC-3.8);
 *  2. the recorder's own figure, `recording.durationMs`, still says the sum of the stored pieces (A43: "the recorder's saved time ... do not change");
 *  3. the creator's automatic entry is 30 minutes in the end (AC-3.9: an untouched entry takes the measured duration, rounded);
 *  4. the Details card's Duration line shows the measured clock value, not the held hour (design S5).
 * It also RECORDS (without asserting, the fake AI provider is fast) the sequence of (status, durationMs) the meeting went through, so
 * the report can say whether the corrected duration was seen while the meeting was still `processing` (design G7); the I-M test
 * `prepareAudio.measured.test.ts` is what pins that ordering.
 *
 * Needs the stack and flags of meeting-hours.spec.ts, plus `ffmpeg` and `ffprobe` on the PATH of the machine that runs Playwright.
 *
 * IT ONLY MEANS SOMETHING AGAINST A meetings-api THAT RUNS THE COMMIT UNDER TEST. A `bun --hot` dev process does not always: a hot
 * reload starts another job runner (a second LISTEN connection) while the runners already started keep the code they were built with,
 * so a `prepare_audio` job can be run by one that predates the change, and the meeting keeps its held hour. When this spec fails with
 * "the meeting ended with 3600000 ms", restart the dev meetings-api (or the whole `mise run dev`) and run it again before reading it as
 * a defect. To test a commit without restarting the stack, start a meetings-api on its own against a `*_test` database (explicit
 * DATABASE_URL, PORT=8185, `MEETINGS_AI_PROVIDER=fake`, the dev MinIO and the dev auth's JWKS/issuer/audience as in
 * `meetings-api/src/test-support/testEnv.ts`) and run this with `E2E_MEETINGS_API_URL=http://localhost:8185`: the browser step then
 * reroutes the shell's meetings-api calls to it.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import {
  MEETINGS_API_URL,
  cleanupPeople,
  createMeetingViaApi,
  deleteMeetingQuietly,
  meetingsCall,
  newRunId,
  personContext,
  seedPerson,
  test,
  type Person,
} from './helpers/meetingsFixtures'
import { deleteOwnEntriesQuietly, ownEntriesViaApi, todayZurich, type EntryRow } from './helpers/hoursFixtures'

const runId = newRunId()
const CONSENT_NOTICE_VERSION = '2026-11-05' // = meetings-ui/src/strings/consent.ts, as meetings-capture.spec.ts
const PIECES = 240
const CLAIM_PER_PIECE_MS = 15_000 // MAX_CHUNK_MS: the most one piece may claim
const HELD_MS = PIECES * CLAIM_PER_PIECE_MS // 1 h
const ARRIVAL_BUDGET_MS = 100_000
/**
 * The meetings-api origin the SHELL's pages call (its `VITE_MEETINGS_API_URL`). When `E2E_MEETINGS_API_URL` names another meetings-api
 * (one started on its own, to test a commit the dev stack's process is not running), the browser step below reroutes the page's calls
 * to it, so the Details card is read from the same backend the checks above used.
 */
const SHELL_MEETINGS_API = process.env['E2E_SHELL_MEETINGS_API_URL'] ?? 'http://localhost:8085'

interface PresignedPost {
  url: string
  fields: Record<string, string>
}
interface MeetingView {
  startsAt: string
  status: string
  stage: string | null
  durationMs: number | null
  recording: { durationMs: number } | null
}

const zurichDay = (instant: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant))

/** POSTs one piece to its presigned policy: the fields first, then the file, as S3 requires. */
async function putPiece(post: PresignedPost, bytes: Uint8Array): Promise<void> {
  const form = new FormData()
  for (const [name, value] of Object.entries(post.fields)) form.append(name, value)
  form.append('Content-Type', 'audio/webm')
  form.append('file', new Blob([bytes as BlobPart], { type: 'audio/webm' }))
  const res = await fetch(post.url, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`piece upload refused: ${res.status} ${(await res.text()).slice(0, 200)}`)
}

test.describe('specs/20261112-meeting-hours QE: a duration the audio contradicts is replaced by the measured one (AC-3.8, AC-3.9)', () => {
  test.setTimeout(240_000)

  let creator: Person
  let meetingId: string
  let day = ''
  let workDir = ''

  test.beforeAll(async () => {
    creator = await seedPerson('mhm-creator', 'holder', runId)
    const draft = await createMeetingViaApi(creator, { title: `Meeting hours measured ${runId}`, source: 'recorded' })
    meetingId = draft.id
    await meetingsCall(creator, 'POST', `/meetings/${meetingId}/consent`, { noticeVersion: CONSENT_NOTICE_VERSION })
    workDir = mkdtempSync(path.join(tmpdir(), 'qe-mh-measured-'))
  })

  test.afterAll(async () => {
    if (creator) await deleteOwnEntriesQuietly(creator, day || todayZurich())
    if (creator && meetingId) await deleteMeetingQuietly(creator, meetingId)
    await cleanupPeople(runId)
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  test('one hour held, 12 s measured: the meeting, the recorder figure, the entry and the Duration line', async ({
    browser,
  }) => {
    // A real 12 s Opus-in-WebM file; its true length is what ffprobe says (the measured duration is the decoded, re-encoded one).
    const tone = path.join(workDir, 'tone.webm')
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=12',
      '-c:a',
      'libopus',
      '-b:a',
      '24k',
      '-f',
      'webm',
      tone,
    ])
    const probed = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tone],
      { encoding: 'utf-8' },
    ).trim()
    const trueMs = Math.round(Number(probed) * 1000)
    expect(trueMs, 'the file is about 12 s long').toBeGreaterThan(11_000)
    expect(trueMs).toBeLessThan(13_500)
    const bytes = readFileSync(tone)
    expect(bytes.length, 'every piece must hold at least one byte').toBeGreaterThan(PIECES)
    const size = Math.ceil(bytes.length / PIECES)

    // Start, upload and confirm every piece (each claiming 15 s), stop.
    const start = (
      await meetingsCall<{ sessionId: string; next: PresignedPost }>(
        creator,
        'POST',
        `/meetings/${meetingId}/recording/start`,
      )
    ).body
    let next = start.next
    for (let seq = 0; seq < PIECES; seq++) {
      const slice = bytes.subarray(seq * size, Math.min((seq + 1) * size, bytes.length))
      if (slice.length === 0) throw new Error(`piece ${seq} is empty: the file is too small for ${PIECES} pieces`)
      await putPiece(next, slice)
      const confirmed = await meetingsCall<{ storedChunks: number; durationMs: number; next: PresignedPost }>(
        creator,
        'POST',
        `/meetings/${meetingId}/recording/chunks/${seq}/confirm`,
        { sessionId: start.sessionId, durationMs: CLAIM_PER_PIECE_MS },
      )
      next = confirmed.body.next
      if (seq === PIECES - 1) expect(confirmed.body.durationMs, 'the stored pieces claim one hour').toBe(HELD_MS)
    }
    await meetingsCall(
      creator,
      'POST',
      `/meetings/${meetingId}/recording/stop`,
      { sessionId: start.sessionId, lastSeq: PIECES - 1 },
      [200, 202],
    )
    const stoppedAt = Date.now()

    // Poll the meeting and the entry fast, and keep the sequence of what the meeting held and when it left `processing`.
    const timeline: string[] = []
    const entryMinutes: string[] = []
    let finalView: MeetingView | undefined
    let entry: EntryRow | undefined
    const deadline = Date.now() + ARRIVAL_BUDGET_MS
    for (;;) {
      const view = (await meetingsCall<MeetingView>(creator, 'GET', `/meetings/${meetingId}`)).body
      const label = `${view.status}${view.stage ? `/${view.stage}` : ''} ${view.durationMs}`
      if (timeline[timeline.length - 1] !== label) timeline.push(`+${Date.now() - stoppedAt}ms ${label}`)
      if (view.durationMs !== null && day === '') day = zurichDay(view.startsAt)
      if (day !== '') {
        const entries = await ownEntriesViaApi(creator, day, day)
        entry = entries.find((candidate) => candidate.on.type === 'meeting' && candidate.on.id === meetingId)
        const m = entry ? String(entry.minutes) : 'none'
        if (entryMinutes[entryMinutes.length - 1]?.split(' ')[1] !== m)
          entryMinutes.push(`+${Date.now() - stoppedAt}ms ${m}`)
      }
      const settled = view.status !== 'processing' && view.durationMs !== null && view.durationMs !== HELD_MS
      if (settled && entry?.minutes === 30) {
        finalView = view
        break
      }
      if (Date.now() >= deadline) {
        finalView = view
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    console.log(`[QE measured] meeting timeline: ${timeline.join(' | ')}`)
    console.log(`[QE measured] entry minutes timeline: ${entryMinutes.join(' | ')}`)
    console.log(`[QE measured] ffprobe says the file is ${trueMs} ms; held (sum of pieces) is ${HELD_MS} ms`)
    expect(finalView, 'the meeting was read').toBeDefined()

    // 1. The meeting's duration is the measured one (AC-3.8), not the held hour.
    expect(
      finalView!.durationMs,
      `the meeting ended with ${finalView!.durationMs} ms; the timeline was ${timeline.join(' | ')}`,
    ).not.toBe(HELD_MS)
    expect(
      Math.abs((finalView!.durationMs ?? 0) - trueMs),
      'within 2 s of the audio ffprobe measures',
    ).toBeLessThanOrEqual(2_000)
    // 2. The recorder's own figure is the sum of the stored pieces and does not change (A43).
    expect(finalView!.recording?.durationMs, "the recorder's figure is the held sum").toBe(HELD_MS)
    // 3. The untouched entry took the measured duration, rounded: 12 s is the 30-minute floor (AC-3.9).
    expect(
      entry?.minutes,
      `the creator's entry is 30 min once corrected; minutes timeline: ${entryMinutes.join(' | ')}`,
    ).toBe(30)

    // 4. The Details card's Duration line shows the measured clock value (design S5), never the held hour.
    const ctx = await personContext(browser, creator)
    if (MEETINGS_API_URL !== SHELL_MEETINGS_API) {
      await ctx.route(`${SHELL_MEETINGS_API}/**`, async (route) => {
        const rerouted = route.request().url().replace(SHELL_MEETINGS_API, MEETINGS_API_URL)
        await route.fulfill({ response: await route.fetch({ url: rerouted }) })
      })
    }
    const page = await ctx.newPage()
    await page.goto(`/my-meetings/m/${meetingId}`)
    const duration = page.locator('dt', { hasText: /^Duration$/ }).locator('xpath=following-sibling::dd[1]')
    await expect(duration, 'the Details card has a Duration line').toBeVisible({ timeout: 30_000 })
    await expect(duration).toHaveText(/^00:00:1[0-4]$/)
    await expect(duration).not.toHaveText('01:00:00')
    await ctx.close()
  })
})
