/**
 * T90 — Failure and deletion (specs/021-meetings: AC-11.6, AC-4.6, AC-4.7).
 *
 *  1. meetings-api is down (AC-11.6): the deal page still loads and its Meetings card shows the
 *     "Meetings are unavailable right now" banner with Retry; the rest of the page is untouched.
 *     The real service is shared by every other journey and is never stopped from here: "down" is
 *     every browser request to its origin failing at the network layer (what the page sees when the
 *     process is gone), see `blockMeetingsApi`. Retry works once it is reachable again.
 *  2. The creator deletes a meeting (AC-4.6): the dialog says it cannot be undone and needs an
 *     acknowledgement; afterwards it is gone from the list and its link is "Meeting not found".
 *  3. An erase holder (AC-4.7): finds a meeting from Erase by title, sees title/date/creator and
 *     never the content, and deletes it through the same dialog; it is gone for its creator too.
 */
import { expect } from '@playwright/test'
import {
  blockMeetingsApi,
  cleanupPeople,
  createDealViaApi,
  deleteMeetingQuietly,
  meetingsAdmin,
  meetingsCall,
  newRunId,
  personContext,
  seedPerson,
  seedReadyMeeting,
  test,
  type Person,
} from './helpers/meetingsFixtures'

const runId = newRunId()
const SECRET = 'The merger codename is Bluebird.'

test.describe('specs/021 T90: failure and deletion', () => {
  let creator: Person
  let eraser: Person
  const leftovers: string[] = []

  test.beforeAll(async () => {
    creator = await seedPerson('fail-creator', 'holder', runId)
    eraser = await seedPerson('fail-eraser', 'admin', runId)
  })

  test.afterAll(async () => {
    for (const id of leftovers) await deleteMeetingQuietly(creator, id)
    await cleanupPeople(runId)
  })

  test('meetings-api down: the deal page loads with the Meetings-unavailable section (AC-11.6)', async ({
    browser,
  }) => {
    const admin = await meetingsAdmin()
    const deal = await createDealViaApi(admin, `Failure deal ${runId}`)
    const ctx = await personContext(browser, eraser) // an admin: crm:access and the grant
    const page = await ctx.newPage()
    await blockMeetingsApi(page)

    await page.goto(`/crm/deals/${deal.id}`)
    // The deal itself is untouched...
    await expect(page.getByRole('heading', { name: new RegExp(`Failure deal ${runId}`) }).first()).toBeVisible({
      timeout: 30_000,
    })
    // ...and the Meetings card keeps its title and says so, with a way to try again.
    await expect(page.getByRole('heading', { name: 'Meetings', exact: true })).toBeVisible()
    const unavailable = page.getByTestId('meetings-host-unavailable')
    await expect(unavailable).toContainText('Meetings are unavailable right now', { timeout: 30_000 })
    await expect(unavailable).toContainText('The rest of this page is not affected.')
    await expect(unavailable.getByRole('button', { name: 'Retry' })).toBeVisible()

    // Back up: Retry loads the card.
    await page.unroute(/localhost:8085/)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await unavailable.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByText('No meetings yet')).toBeVisible({ timeout: 20_000 })
    await ctx.close()
  })

  test('the creator deletes a meeting through the cannot-be-undone dialog (AC-4.6)', async ({ browser }) => {
    const meeting = await seedReadyMeeting(creator, `Delete me ${runId}`, SECRET)
    leftovers.push(meeting.id)
    const ctx = await personContext(browser, creator)
    const page = await ctx.newPage()
    await page.goto(`/my-meetings/m/${meeting.id}`)
    await expect(page.getByRole('heading', { name: meeting.title })).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: 'Delete meeting' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Delete this meeting?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText("This can't be undone.")
    await expect(dialog).toContainText(meeting.title)
    const confirm = dialog.getByRole('button', { name: 'Delete meeting' })
    // Nothing happens until the acknowledgement is ticked.
    await expect(confirm).toBeDisabled()
    await dialog.getByRole('checkbox').check()
    await expect(confirm).toBeEnabled()
    await confirm.click()

    // Back on the list, which no longer has it.
    await expect(page).toHaveURL(/\/my-meetings\/?$/, { timeout: 30_000 })
    // design.md F14: "navigate to the list with Saved 'Meeting deleted'" (soft: the rest still runs)
    await expect.soft(page.getByText('Meeting deleted'), 'DEFECT D5: no deletion confirmation on the list').toBeVisible()
    await expect(page.getByText(meeting.title)).toHaveCount(0)

    // The old link is "not found" (the same words as a meeting nobody can open), and so is the API.
    await page.goto(`/my-meetings/m/${meeting.id}`)
    await expect(page.getByText('Meeting not found')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(SECRET)).toHaveCount(0)
    await meetingsCall(creator, 'GET', `/meetings/${meeting.id}`, undefined, [404])
    await ctx.close()
  })

  test('an erase holder finds and deletes a meeting without seeing its content (AC-4.7)', async ({ browser }) => {
    const meeting = await seedReadyMeeting(creator, `Erase me ${runId}`, SECRET)
    leftovers.push(meeting.id)
    // The erase holder is neither creator nor participant: they cannot read it...
    await meetingsCall(eraser, 'GET', `/meetings/${meeting.id}`, undefined, [404])

    const ctx = await personContext(browser, eraser)
    const page = await ctx.newPage()
    await page.goto('/meetings')
    await page.getByRole('navigation', { name: 'Meetings sections' }).getByRole('link', { name: 'Erase' }).click()
    await expect(page.getByRole('heading', { name: 'Erase meetings', level: 2 })).toBeVisible({ timeout: 30_000 })

    await page.getByLabel('Title', { exact: true }).fill(meeting.title)
    await page.getByRole('button', { name: 'Search' }).click()
    const row = page.getByRole('row').filter({ hasText: meeting.title })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText(creator.name) // title, date, creator...
    await expect(page.getByText(SECRET)).toHaveCount(0) // ...never the content

    await row.getByRole('button', { name: `Delete meeting ${meeting.title}` }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Delete this meeting?' })
    await expect(dialog).toContainText(meeting.title)
    await expect(dialog).toContainText(`created by ${creator.name}`)
    await expect(dialog).not.toContainText(SECRET)
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: 'Delete meeting' }).click()

    await expect(page.getByText('Meeting deleted')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('row').filter({ hasText: meeting.title })).toHaveCount(0)
    // Gone for its creator as well.
    await meetingsCall(creator, 'GET', `/meetings/${meeting.id}`, undefined, [404])
    await ctx.close()
  })
})
