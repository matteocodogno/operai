/**
 * T35 — My own hours, the time lists and everyone's hours (specs/20261112-time-tracking: AC-1.1, AC-3.1, AC-4.1,
 * AC-4.3, AC-5.1; also AC-3.3, AC-3.4 and AC-5.5's "no tab without the permission" at the browser level).
 * hours-ui is mounted by the shell at the ungated `/hours/$` (no tool grant, not a TOOLS entry); hours-api is
 * called directly through `shell/session`.
 *
 *  1. A user holding only `employee` (no tool grant) opens My hours from the user menu (no access redirect, no
 *     tabs), sees the empty state, records two Other work entries on one day, and the day heading shows their sum.
 *  2. An admin adds a category in Hours -> Settings; it is offered in the entry dialog; once retired it is not, and
 *     once restored it is again (retired and restored, never deleted).
 *  3. A non-holder has no Everyone's hours tab and no Settings tab (and a typed address is refused), while the
 *     admin sees both people's entries in Everyone's hours.
 *
 * Needs the stack up (`mise run dev`): auth (ENABLE_TEST_AUTH=true), hours-api with its own .env, the shell and
 * hours-ui. Against the dev stack Playwright reuses the servers when each remote's port is pointed at it:
 *   E2E_ESTIMAI_REMOTE_PORT=5174 E2E_REFUND_REMOTE_PORT=5175 E2E_NOTIFY_REMOTE_PORT=5176 \
 *   E2E_ADMIN_REMOTE_PORT=5177 E2E_INVENTORY_REMOTE_PORT=5178 E2E_CRM_REMOTE_PORT=5179 \
 *   E2E_MEETINGS_REMOTE_PORT=5180 E2E_PROJECTS_REMOTE_PORT=5181 E2E_HOURS_REMOTE_PORT=5184 pnpm e2e hours.spec.ts
 * The people are per-run (`hrs-*@operai.test`) and the entries they record are deleted afterwards; the category a
 * journey adds cannot be deleted by design, so it is retired.
 */
import { expect, test } from '@playwright/test'
import {
  cleanupPeople,
  createEntryViaApi,
  deleteOwnEntriesQuietly,
  hoursAdmin,
  minutesOfShort,
  newRunId,
  openMyHoursFromMenu,
  ownEntriesViaApi,
  personContext,
  pickCategories,
  recordOtherWork,
  retireCategoryQuietly,
  seedHoursPerson,
  timeListsViaApi,
  todayZurich,
  monthOf,
  type CategoryRow,
  type HoursPerson,
} from './helpers/hoursFixtures'
import type { SeededSession } from './helpers/adminSession'

const runId = newRunId()
const today = todayZurich()
const { from: monthStart, to: monthEnd } = monthOf(today)

test.describe("specs/20261112-time-tracking T35: my hours, the time lists, everyone's hours", () => {
  test.describe.configure({ mode: 'serial' })

  let admin: SeededSession
  let employee: HoursPerson
  let colleague: HoursPerson
  let categories: [CategoryRow, CategoryRow]
  const madeCategories: string[] = []

  test.beforeAll(async () => {
    admin = await hoursAdmin()
    employee = await seedHoursPerson('emp', ['employee'], runId)
    colleague = await seedHoursPerson('col', ['employee'], runId)
    categories = await pickCategories(admin)
  })

  test.afterAll(async () => {
    await deleteOwnEntriesQuietly(employee, monthStart)
    await deleteOwnEntriesQuietly(colleague, monthStart)
    for (const id of madeCategories) await retireCategoryQuietly(admin, id)
    await cleanupPeople(runId)
  })

  test('an employee with no tool grant opens My hours from the user menu and records two Other work entries; the day heading shows their sum (AC-5.1, AC-1.1, AC-4.1)', async ({
    browser,
  }) => {
    const ctx = await personContext(browser, employee)
    const page = await ctx.newPage()
    await page.goto('/')

    // From the header's user menu, like a person: no access redirect (the tool is not a grant).
    await openMyHoursFromMenu(page, employee.name)
    await expect(page).toHaveURL(/\/hours$/)
    await expect(page.getByTestId('hours-shell')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'My hours', level: 2 })).toBeVisible()
    // Only My hours: nothing to switch to, so no tab bar at all.
    await expect(page.getByRole('navigation', { name: 'Hours sections' })).toHaveCount(0)

    // The designed empty state of a person who has recorded nothing.
    await expect(page.getByTestId('hours-entries-empty')).toContainText('No hours recorded in this period', {
      timeout: 30_000,
    })

    // Two entries of Other work on one day (today, the dialog's default day): 2 h and 1 h 30.
    await recordOtherWork(page, { minutes: 120, categoryId: categories[0].id })
    await expect(page.getByTestId('hours-entry-saved')).toContainText('Entry saved.')
    await recordOtherWork(page, { minutes: 90, categoryId: categories[1].id, note: `Second block ${runId}` })

    // The day heading carries the day's total from the server: 2 h + 1 h 30 = 3 h 30.
    const dayTotal = page.getByTestId(`hours-day-total-${today}`)
    await expect(dayTotal).toContainText('3 h 30', { timeout: 30_000 })
    await expect(page.getByTestId(`hours-day-${today}`).getByRole('list', { name: /Entries on/ })).toBeVisible()
    await expect(page.getByTestId('hours-totals-total')).toContainText('3 h 30')
    await expect(page.getByText(`Second block ${runId}`)).toBeVisible()
    // Both rows are Other work, each with its own category.
    await expect(page.getByTestId(`hours-day-${today}`).getByText('Other work')).toHaveCount(2)
    await expect(page.getByTestId(`hours-day-${today}`)).toContainText(categories[0].name)
    await expect(page.getByTestId(`hours-day-${today}`)).toContainText(categories[1].name)

    // Out of band, as the person: exactly two entries, theirs, whole half-hours, no time of day (AC-1.1, AC-1.2).
    const stored = await ownEntriesViaApi(employee, monthStart, monthEnd)
    expect(stored.map((entry) => entry.minutes).sort((a, b) => a - b)).toEqual([90, 120])
    for (const entry of stored) {
      expect(entry.day).toBe(today)
      expect(entry.person.id).toBe(employee.userId)
      expect(entry.on.type).toBe('none')
      expect(Object.keys(entry)).not.toEqual(expect.arrayContaining(['start']))
      expect(Object.keys(entry)).not.toEqual(expect.arrayContaining(['end']))
    }
    await ctx.close()
  })

  test('an admin adds a category in Hours -> Settings: it is offered in the entry dialog, not once retired, again once restored (AC-3.1, AC-3.3, AC-3.4)', async ({
    browser,
  }) => {
    const name = `E2E category ${runId}`
    const ctx = await personContext(browser, admin)
    const page = await ctx.newPage()
    await page.goto('/hours')
    await expect(page.getByTestId('hours-shell')).toBeVisible({ timeout: 30_000 })

    // The holder of time-list:manage sees the Settings tab (and, as admin, Everyone's hours too).
    const tabs = page.getByRole('navigation', { name: 'Hours sections' })
    await expect(tabs.getByRole('link', { name: 'My hours' })).toBeVisible({ timeout: 30_000 })
    await expect(tabs.getByRole('link', { name: "Everyone's hours" })).toBeVisible()
    await tabs.getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/hours\/settings$/)
    await expect(page.getByRole('heading', { name: 'Time lists' })).toBeVisible()

    // Add a category (the dialog: a name, "needs a note" left off).
    await page.getByTestId('time-lists-add-categories').click()
    const dialog = page.getByRole('dialog', { name: 'Add category' })
    await dialog.getByTestId('time-lists-dialog-name').fill(name)
    await dialog.getByTestId('time-lists-dialog-submit').click()
    await expect(page.getByText(`Category “${name}” added.`)).toBeVisible({ timeout: 20_000 })
    const card = page.getByTestId('time-lists-card-categories')
    await expect(card).toContainText(name)

    // Its id, from the lists as hours-api holds them, for the row's controls and for the cleanup.
    const created = (await timeListsViaApi(admin)).categories.find((category) => category.name === name)
    expect(created, 'the category the dialog added is in hours-api').toBeDefined()
    const id = created!.id
    madeCategories.push(id)
    const row = page.getByTestId(`time-lists-row-categories-${id}`)
    await expect(row).toContainText('Active')

    // Offered in the entry dialog of My hours (Other work -> Category).
    const categoryOptions = async (): Promise<number> => {
      await page.goto('/hours')
      await page.getByTestId('hours-record').click()
      const entry = page.getByRole('dialog', { name: 'Record hours' })
      await entry.getByTestId('hours-entry-on-none').check()
      const options = entry.getByTestId('hours-entry-category').locator('option', { hasText: name })
      // The lists are read when My hours mounts; wait until the select holds them (the seeded rows are there).
      await expect(entry.getByTestId('hours-entry-category').locator('option')).not.toHaveCount(1, { timeout: 20_000 })
      const count = await options.count()
      await entry.getByTestId('hours-entry-dialog-cancel').click()
      await entry.waitFor({ state: 'detached' })
      return count
    }
    expect(await categoryOptions(), 'a new category is offered').toBe(1)

    // Retire it in Settings: the row says so and keeps its place; the entry dialog no longer offers it.
    await page.goto('/hours/settings')
    await expect(page.getByTestId(`time-lists-toggle-categories-${id}`)).toBeVisible({ timeout: 30_000 })
    await page.getByTestId(`time-lists-toggle-categories-${id}`).click()
    await expect(page.getByText(`“${name}” retired.`)).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText('Retired')
    expect(await categoryOptions(), 'a retired category is not offered').toBe(0)

    // Restore it: offered again.
    await page.goto('/hours/settings')
    await expect(page.getByTestId(`time-lists-toggle-categories-${id}`)).toBeVisible({ timeout: 30_000 })
    await page.getByTestId(`time-lists-toggle-categories-${id}`).click()
    await expect(page.getByText(`“${name}” restored.`)).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText('Active')
    expect(await categoryOptions(), 'a restored category is offered again').toBe(1)
    await ctx.close()
  })

  test("a non-holder has no Everyone's hours or Settings tab; the admin sees both people's entries in Everyone's hours (AC-4.3, AC-3.3, AC-5.1)", async ({
    browser,
  }) => {
    // The second person's hour, recorded through the API (the journey is about what the admin SEES of it).
    const theirs = await createEntryViaApi(colleague, {
      day: today,
      minutes: 60,
      on: { type: 'none', categoryId: categories[0].id },
    })
    const mine = await ownEntriesViaApi(employee, monthStart, monthEnd)
    expect(mine).toHaveLength(2)

    // A holder of neither permission: no tab bar, and a typed address is refused where it is reached.
    const plainCtx = await personContext(browser, employee)
    const plain = await plainCtx.newPage()
    await plain.goto('/hours')
    await expect(plain.getByTestId('hours-my-page')).toBeVisible({ timeout: 30_000 })
    await expect(plain.getByRole('link', { name: "Everyone's hours" })).toHaveCount(0)
    await expect(plain.getByRole('link', { name: 'Settings' })).toHaveCount(0)
    await expect(plain.getByRole('navigation', { name: 'Hours sections' })).toHaveCount(0)
    await plain.goto('/hours/all')
    await expect(plain.getByTestId('hours-permission-denied')).toBeVisible({ timeout: 30_000 })
    await expect(plain.getByTestId('hours-entries-table')).toHaveCount(0)
    await plain.goto('/hours/settings')
    await expect(plain.getByTestId('hours-permission-denied')).toBeVisible({ timeout: 30_000 })
    await expect(plain.getByTestId('time-lists-card-categories')).toHaveCount(0)
    await plainCtx.close()

    // The admin reaches Everyone's hours through the tab and sees both people's entries (AC-4.3).
    const adminCtx = await personContext(browser, admin)
    const page = await adminCtx.newPage()
    await page.goto('/hours')
    const tabs = page.getByRole('navigation', { name: 'Hours sections' })
    await tabs.getByRole('link', { name: "Everyone's hours" }).click()
    await expect(page).toHaveURL(/\/hours\/all/)
    await expect(page.getByTestId('hours-everyone-page')).toBeVisible()
    await expect(page.getByTestId('hours-entries-table')).toBeVisible({ timeout: 30_000 })

    const table = page.getByTestId('hours-entries-table')
    const theirRow = table.getByTestId(`hours-entry-${theirs.id}`)
    await expect(theirRow).toContainText(colleague.name)
    await expect(theirRow).toContainText('1 h')
    for (const entry of mine) {
      const row = table.getByTestId(`hours-entry-${entry.id}`)
      await expect(row).toContainText(employee.name)
      await expect(row).toContainText(entry.minutes === 120 ? '2 h' : '1 h 30')
    }
    // Read only: a holder changes nobody's hours, so no row carries an Edit or a Delete.
    await expect(table.getByRole('button', { name: /^(Edit|Delete)/ })).toHaveCount(0)

    // The default grouping is by person: each of the two has their own total, as the server states it.
    const totals = page.getByTestId('hours-totals-table')
    await expect(totals).toContainText(employee.name, { timeout: 30_000 })
    const minutesOf = async (name: string): Promise<number> =>
      minutesOfShort(await totals.getByRole('row').filter({ hasText: name }).getByRole('cell').last().innerText())
    expect(await minutesOf(employee.name)).toBe(210)
    expect(await minutesOf(colleague.name)).toBe(60)

    // Narrowing to one person shows that person's entries only.
    await page.getByTestId('hours-filter-person').selectOption({ label: colleague.name })
    await expect(table.getByTestId(`hours-entry-${theirs.id}`)).toBeVisible({ timeout: 30_000 })
    for (const entry of mine) await expect(table.getByTestId(`hours-entry-${entry.id}`)).toHaveCount(0)
    await adminCtx.close()
  })
})
