/**
 * T88 — The deal journey (specs/021-meetings: AC-1.1, AC-2.2, AC-11.2, AC-11.3, AC-14.1,
 * AC-14.4, AC-5.6). crm-ui hosts the Meetings card (`./HostMeetings` through the shell's
 * HostExtension); meetings-api resolves the deal as the caller and tells crm-api in a notice.
 *
 *  1. From a deal (sales, with the grant): Start meeting -> the form is prefilled "Deal · title"
 *     and the title -> consent -> record with the fake microphone -> Stop -> processing -> ready
 *     (meetings-api's fake transcriber) -> the meeting is in the deal's Meetings card and in My
 *     meetings, and the deal timeline shows the meeting activity with an Open meeting link and
 *     nothing of the content.
 *  2. Link an existing standalone meeting from the card; it appears there and on the timeline.
 *  3. A CRM reader without access (crm-technical) sees the activity, follows its link and lands
 *     on "Meeting not found" (the same words as a meeting that does not exist).
 *  4. Host-visible (AC-5.6): once the creator allows it, a reader who may open the deal AND holds
 *     what the host demands (sales: deal:financials) can open the meeting; crm-technical, who may
 *     open the deal but lacks that, still cannot.
 */
import { expect } from '@playwright/test'
import {
  cleanupPeople,
  createDealViaApi,
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

const runId = newRunId()
const SECRET = 'The merger codename is Bluebird.'

test.describe('specs/021 T88: deal journey', () => {
  let sales: Person
  let reader: Person // a second salesperson: deal:financials, not a participant
  let technical: Person
  let dealId = ''
  let dealTitle = ''
  const created: string[] = []

  test.beforeAll(async () => {
    sales = await seedPerson('deal-sales', 'sales', runId)
    reader = await seedPerson('deal-reader', 'sales', runId)
    technical = await seedPerson('deal-tech', 'crm-technical', runId)
    dealTitle = `Meeting deal ${runId}`
    dealId = (await createDealViaApi(await meetingsAdmin(), dealTitle)).id
  })

  test.afterAll(async () => {
    for (const id of created) await deleteMeetingQuietly(sales, id)
    await cleanupPeople(runId)
  })

  test('start from a deal, consent, record, stop, ready; it is on the deal and in My meetings (AC-1.1, AC-2.2, AC-11.2, AC-11.3, AC-14.1)', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    const ctx = await personContext(browser, sales)
    const page = await ctx.newPage()
    await page.goto(`/crm/deals/${dealId}`)
    await expect(page.getByRole('heading', { name: 'Meetings', exact: true })).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('meetings-host-start').first().click()

    // Prefilled from the deal (resolved as the caller).
    await expect(page).toHaveURL(/\/meetings\/new\?hostApp=crm&hostType=deal&hostId=/)
    await expect(page.getByText(`Deal · ${dealTitle}`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByLabel('Title')).toHaveValue(dealTitle)
    await page.getByLabel('Title').fill(`${dealTitle} kickoff`)
    await page.getByRole('radio', { name: /Record in the browser/ }).check()
    await page.getByRole('button', { name: 'Create meeting' }).click()
    await expect(page).toHaveURL(/\/meetings\/m\/[^/?]+/, { timeout: 30_000 })
    const meetingId = /\/meetings\/m\/([^/?]+)/.exec(page.url())![1]!
    created.push(meetingId)

    // Consent first: no capture control exists before it (AC-2.1).
    await expect(page.getByTestId('meetings-consent-card')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('meetings-recording-start')).toHaveCount(0)
    await page.getByRole('checkbox', { name: /I have read this notice/ }).check()
    await page.getByRole('button', { name: 'Continue' }).click()

    // Record with the (fake) microphone, then stop.
    await expect(page.getByTestId('meetings-recording-options')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('meetings-recording-start').click()
    await expect(page.getByTestId('meetings-recording-indicator')).toContainText('Recording', { timeout: 20_000 })
    await page.waitForTimeout(14_000)
    await page.getByTestId('meetings-recording-stop').click()
    await expect(page.getByTestId('meetings-processing-panel')).toBeVisible({ timeout: 90_000 })

    // The fake transcriber and the fake model finish the job: ready, with a transcript.
    await expect
      .poll(async () => (await meetingsCall<{ status: string }>(sales, 'GET', `/meetings/${meetingId}`)).body.status, {
        timeout: 120_000,
        intervals: [3_000],
      })
      .toBe('ready')

    // In the deal's Meetings card...
    await page.goto(`/crm/deals/${dealId}`)
    await expect(page.getByRole('link', { name: `${dealTitle} kickoff` }).first()).toBeVisible({ timeout: 30_000 })
    // ...in the deal's timeline, as an activity that is a link and nothing else (AC-14.1/14.2)...
    await expect(page.getByRole('link', { name: 'Open meeting' }).first()).toBeVisible()
    // ...and in My meetings.
    await page.goto('/my-meetings')
    await expect(page.getByRole('row').filter({ hasText: `${dealTitle} kickoff` })).toBeVisible({ timeout: 30_000 })
    await ctx.close()
  })

  test('link an existing meeting from the deal panel (AC-14.1)', async ({ browser }) => {
    const standalone = await createMeetingViaApi(sales, { title: `Standalone ${runId}`, source: 'text' })
    created.push(standalone.id)
    const ctx = await personContext(browser, sales)
    const page = await ctx.newPage()
    await page.goto(`/crm/deals/${dealId}`)
    await page.getByRole('button', { name: 'Link an existing meeting' }).click()
    const dialog = page.getByRole('dialog', { name: 'Link an existing meeting' })
    await dialog.getByRole('radio', { name: new RegExp(standalone.title) }).check()
    await dialog.getByRole('button', { name: 'Link meeting' }).click()
    await expect(page.getByText('Meeting linked.')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('link', { name: standalone.title }).first()).toBeVisible()
    await ctx.close()
  })

  test('a CRM reader without access follows the activity link to not found; host-visible opens it for the right readers only (AC-14.4, AC-5.6)', async ({
    browser,
  }) => {
    const secret = await createMeetingViaApi(sales, {
      title: `Private ${runId}`,
      source: 'text',
      host: { app: 'crm', entityType: 'deal', entityId: dealId },
    })
    created.push(secret.id)
    await meetingsCall(sales, 'PUT', `/meetings/${secret.id}/text`, { text: SECRET })

    // crm-technical sees the activity on the deal but the meeting itself is not theirs to open.
    const techCtx = await personContext(browser, technical)
    const tech = await techCtx.newPage()
    await tech.goto(`/crm/deals/${dealId}`)
    const open = tech.locator(`a[href="/my-meetings/m/${secret.id}"]`)
    await expect(open).toBeVisible({ timeout: 30_000 })
    await open.click()
    await expect(tech.getByText('Meeting not found')).toBeVisible({ timeout: 30_000 })
    await expect(tech.getByText(SECRET)).toHaveCount(0)

    // The creator allows people who can open the deal. A second salesperson (deal:financials) can
    // now open it; crm-technical (no financials) still cannot (AC-5.6).
    await meetingsCall(sales, 'PATCH', `/meetings/${secret.id}`, { hostVisible: true })
    await meetingsCall(reader, 'GET', `/meetings/${secret.id}`)
    await meetingsCall(technical, 'GET', `/meetings/${secret.id}`, undefined, [404])
    await tech.reload()
    await expect(tech.getByText('Meeting not found')).toBeVisible({ timeout: 30_000 })
    await techCtx.close()

    const readerCtx = await personContext(browser, reader)
    const rd = await readerCtx.newPage()
    await rd.goto(`/my-meetings/m/${secret.id}`)
    await expect(rd.getByRole('heading', { name: secret.title })).toBeVisible({ timeout: 30_000 })
    await expect(rd.getByText(SECRET)).toBeVisible()
    await readerCtx.close()
  })
})
