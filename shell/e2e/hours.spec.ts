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
 *  4. (QE) A role that holds only `time-list:manage` reaches Settings and not Everyone's hours; one that holds only
 *     `time-entry:read-all` the opposite: the permission alone is enough (AC-3.3 as amended by D51), in the tabs, at
 *     the typed address and in the API.
 *  5. (QE, second pass) The words of design.md § Date rules — copy and the name of every control in the hours dialogs,
 *     rendered, in English and in Italian: the Day and Custom period errors (D-2), and no two controls of one dialog
 *     with the same accessible name (D-3: the entry dialog, the delete confirmation and all six Settings dialogs).
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
  signInContext,
  deleteOwnEntriesQuietly,
  deleteRoleQuietly,
  ensureRole,
  hoursAdmin,
  hoursCall,
  minutesOfShort,
  mustHoursCall,
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
  const madeRoles: { id: string; holders: HoursPerson[] }[] = []

  test.beforeAll(async () => {
    admin = await hoursAdmin(runId)
    employee = await seedHoursPerson('emp', ['employee'], runId)
    colleague = await seedHoursPerson('col', ['employee'], runId)
    categories = await pickCategories(admin)
  })

  test.afterAll(async () => {
    await deleteOwnEntriesQuietly(employee, monthStart)
    await deleteOwnEntriesQuietly(colleague, monthStart)
    for (const id of madeCategories) await retireCategoryQuietly(admin, id)
    // Roles go before the people: the admin that deletes them is one of the run's people.
    for (const role of madeRoles) await deleteRoleQuietly(admin, role.id, role.holders)
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

    // My hours opens on the table view, at the current week (AC-5.1 reversed 2026-11-19, AC-5.4): a person who has
    // recorded nothing sees the week's designed empty state, with the List one tab away.
    await expect(page.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
    await expect(page.getByTestId('hours-table-empty')).toContainText('No hours recorded this week', {
      timeout: 30_000,
    })

    // The day headings and the Totals are the List's: switch to it, a view of the same page.
    await page.getByRole('tab', { name: 'List' }).click()
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

  test("a role that holds only time-list:manage reaches Settings and not Everyone's hours; one that holds only time-entry:read-all the opposite (AC-3.3 as amended by D51, AC-4.2, QE)", async ({
    browser,
  }) => {
    // Two roles of ONE permission each, made through the real admin API: neither has Admin access, neither has a tool
    // grant. The admin role cannot show this: it holds both permissions at once.
    const listsRoleName = `e2e-hours-lists-${runId}`
    const readAllRoleName = `e2e-hours-readall-${runId}`
    const listsRole = await ensureRole(admin, listsRoleName, [{ resource: 'time-list', action: 'manage' }])
    const readAllRole = await ensureRole(admin, readAllRoleName, [{ resource: 'time-entry', action: 'read-all' }])
    const listsOnly = await seedHoursPerson('lst', [listsRoleName], runId)
    const readAllOnly = await seedHoursPerson('rda', [readAllRoleName], runId)
    madeRoles.push({ id: listsRole, holders: [listsOnly] }, { id: readAllRole, holders: [readAllOnly] })

    // A category for the API half (an admin makes it; nobody deletes one, so it is retired afterwards).
    const made = await mustHoursCall<CategoryRow>(admin, 'POST', '/time-categories', {
      name: `E2E one-permission ${runId}`,
      requiresNote: false,
    })
    madeCategories.push(made.id)

    // ── The holder of time-list:manage alone ──
    const listsCtx = await personContext(browser, listsOnly)
    const lists = await listsCtx.newPage()
    const readAllCalls: string[] = []
    lists.on('request', (request) => {
      if (request.url().includes('whose=all')) readAllCalls.push(request.url())
    })
    await lists.goto('/hours')
    await expect(lists.getByTestId('hours-my-page')).toBeVisible({ timeout: 30_000 })
    const listsTabs = lists.getByRole('navigation', { name: 'Hours sections' })
    await expect(listsTabs.getByRole('link')).toHaveText(['My hours', 'Settings'])
    await listsTabs.getByRole('link', { name: 'Settings' }).click()
    await expect(lists).toHaveURL(/\/hours\/settings$/)
    await expect(lists.getByTestId('time-lists-card-categories')).toBeVisible({ timeout: 30_000 })
    await expect(lists.getByTestId('hours-permission-denied')).toHaveCount(0)
    // Everyone's hours is refused where it is reached, and nothing of everyone's is asked for.
    await lists.goto('/hours/all')
    await expect(lists.getByTestId('hours-permission-denied')).toBeVisible({ timeout: 30_000 })
    await expect(lists.getByTestId('hours-entries-table')).toHaveCount(0)
    expect(readAllCalls, 'a holder of time-list:manage alone never asks for everyone’s hours').toEqual([])
    await listsCtx.close()

    // The API agrees, for a person with no Admin access: the lists are theirs to manage, everyone's hours are not.
    const retire = await hoursCall(listsOnly, 'PATCH', `/time-categories/${made.id}`, { retired: true })
    expect(retire.status).toBe(200)
    const restore = await hoursCall(listsOnly, 'PATCH', `/time-categories/${made.id}`, { retired: false })
    expect(restore.status).toBe(200)
    const everyone = await hoursCall<{ code?: string }>(
      listsOnly,
      'GET',
      `/time-entries?whose=all&from=${monthStart}&to=${monthEnd}`,
    )
    expect(everyone.status).toBe(403)
    expect(everyone.body.code).toBe('read_all_required')

    // ── The holder of time-entry:read-all alone ──
    const allCtx = await personContext(browser, readAllOnly)
    const all = await allCtx.newPage()
    await all.goto('/hours')
    await expect(all.getByTestId('hours-my-page')).toBeVisible({ timeout: 30_000 })
    const allTabs = all.getByRole('navigation', { name: 'Hours sections' })
    await expect(allTabs.getByRole('link')).toHaveText(['My hours', "Everyone's hours"])
    await allTabs.getByRole('link', { name: "Everyone's hours" }).click()
    await expect(all.getByTestId('hours-everyone-page')).toBeVisible({ timeout: 30_000 })
    await expect(all.getByTestId('hours-permission-denied')).toHaveCount(0)
    await all.goto('/hours/settings')
    await expect(all.getByTestId('hours-permission-denied')).toBeVisible({ timeout: 30_000 })
    await expect(all.getByTestId('time-lists-card-categories')).toHaveCount(0)
    await allCtx.close()

    const refused = await hoursCall<{ code?: string }>(readAllOnly, 'PATCH', `/time-categories/${made.id}`, {
      retired: true,
    })
    expect(refused.status).toBe(403)
    expect(refused.body.code).toBe('time_list_manage_required')
    const after = (await timeListsViaApi(admin)).categories.find((category) => category.id === made.id)
    expect(after?.retired, 'a refused change leaves the category as it was').toBe(false)
  })

  test("the design's date copy and a distinct name on every control of the hours dialogs, in English and Italian (D-2, D-3, QE second pass)", async ({
    browser,
  }) => {
    // design.md § Date rules — copy, word for word (written out here, never read from the app's catalog: a test that
    // reads the catalog cannot tell a wrong sentence from the right one).
    const copy = {
      en: {
        locale: 'en-US',
        lang: 'en',
        dayInvalid: 'Choose a valid day.',
        dayFloor: 'The day cannot be before 01.01.2000.',
        from: 'The start date cannot be before 01.01.2000.',
        to: 'The end date cannot be before 01.01.2000.',
        close: 'Close',
        cancel: 'Cancel',
      },
      it: {
        locale: 'it-IT',
        lang: 'it',
        dayInvalid: 'Scegli un giorno valido.',
        dayFloor: 'Il giorno non può precedere il 01.01.2000.',
        from: 'La data di inizio non può precedere il 01.01.2000.',
        to: 'La data di fine non può precedere il 01.01.2000.',
        close: 'Chiudi',
        cancel: 'Annulla',
      },
    } as const

    /** The accessible name of every button in `dialog` (an aria-label wins over the text, as it does for a reader). */
    const buttonNames = (dialog: import('@playwright/test').Locator): Promise<string[]> =>
      dialog
        .getByRole('button')
        .evaluateAll((buttons) =>
          buttons.map((button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim()),
        )
    const duplicates = (names: string[]): string[] => names.filter((name, index) => names.indexOf(name) !== index)
    const alertsOf = (scope: import('@playwright/test').Locator): Promise<string[]> =>
      scope
        .locator('[role="alert"]')
        .allInnerTexts()
        .then((texts) => texts.map((text) => text.trim()).filter(Boolean))

    for (const words of [copy.en, copy.it]) {
      const label = words.lang
      // ── A person recording hours: the Day errors, the Custom period errors, the entry dialog's two ways out ──
      const personCtx = await browser.newContext({ locale: words.locale })
      await signInContext(personCtx, employee)
      const mine = await personCtx.newPage()
      // The Period and Custom range controls are the List's: `?view=list` (T19, AC-5.1 reversed).
      await mine.goto('/hours?view=list')
      await expect(mine.locator('html')).toHaveAttribute('lang', words.lang)
      await expect(mine.getByTestId('hours-my-page')).toBeVisible({ timeout: 30_000 })

      await mine.getByTestId('hours-record').click()
      const entry = mine.getByRole('dialog')
      await entry.waitFor()
      const day = entry.getByTestId('hours-entry-day')
      await day.fill('')
      await day.blur()
      expect(await alertsOf(entry), `${label}: an emptied Day`).toEqual([words.dayInvalid])
      await day.fill('1999-12-31')
      await day.blur()
      expect(await alertsOf(entry), `${label}: a Day before the floor`).toEqual([words.dayFloor])
      const entryNames = await buttonNames(entry)
      expect(entryNames, `${label}: the entry dialog's buttons`).toContain(words.close)
      expect(entryNames, `${label}: the entry dialog's buttons`).toContain(words.cancel)
      expect(duplicates(entryNames), `${label}: two buttons of the entry dialog with one name`).toEqual([])
      await mine.keyboard.press('Escape')
      await expect(entry).toHaveCount(0)

      await mine.getByTestId('hours-filter-period').selectOption('custom')
      await mine.getByTestId('hours-filter-from').fill('1999-12-30')
      await mine.getByTestId('hours-filter-from').blur()
      await mine.getByTestId('hours-filter-to').fill('1999-12-31')
      await mine.getByTestId('hours-filter-to').blur()
      expect(
        await alertsOf(mine.getByRole('search')),
        `${label}: My hours, both Custom dates before the floor`,
      ).toEqual([words.from, words.to])
      await mine.getByTestId('hours-filter-to').fill(today)
      await mine.getByTestId('hours-filter-to').blur()
      expect(await alertsOf(mine.getByRole('search')), `${label}: My hours, only From before the floor`).toEqual([
        words.from,
      ])
      await mine.getByTestId('hours-filter-from').fill(monthStart)
      await mine.getByTestId('hours-filter-to').fill('1999-12-31')
      await mine.getByTestId('hours-filter-to').blur()
      expect(
        (await alertsOf(mine.getByRole('search'))).filter((text) => text === words.to),
        `${label}: My hours, To before the floor`,
      ).toEqual([words.to])
      await personCtx.close()

      // ── An admin: the same Custom period in Everyone's hours, and every Settings dialog ──
      const adminCtx = await browser.newContext({ locale: words.locale })
      await signInContext(adminCtx, admin)
      const page = await adminCtx.newPage()
      await page.goto('/hours/all')
      await expect(page.getByTestId('hours-everyone-page')).toBeVisible({ timeout: 30_000 })
      await page.getByTestId('hours-filter-period').selectOption('custom')
      await page.getByTestId('hours-filter-from').fill('1999-12-30')
      await page.getByTestId('hours-filter-from').blur()
      await page.getByTestId('hours-filter-to').fill('1999-12-31')
      await page.getByTestId('hours-filter-to').blur()
      expect(
        await alertsOf(page.getByRole('search')),
        `${label}: Everyone's hours, both Custom dates before the floor`,
      ).toEqual([words.from, words.to])

      await page.goto('/hours/settings')
      await expect(page.getByTestId('time-lists-card-categories')).toBeVisible({ timeout: 30_000 })
      // Add and Rename of a category, a project work type and a deal work type: six dialogs of one component.
      for (const scope of ['categories', 'project', 'deal'] as const) {
        const card = page.getByTestId(`time-lists-card-${scope}`)
        for (const opener of [
          card.getByTestId(`time-lists-add-${scope}`),
          card.locator(`[data-testid^="time-lists-rename-${scope}-"]`).first(),
        ]) {
          await opener.click()
          const dialog = page.getByRole('dialog')
          await dialog.waitFor()
          const names = await buttonNames(dialog)
          expect(
            names.filter((name) => name === words.close),
            `${label}: ${scope}: one "${words.close}"`,
          ).toHaveLength(1)
          expect(
            names.filter((name) => name === words.cancel),
            `${label}: ${scope}: one "${words.cancel}"`,
          ).toHaveLength(1)
          expect(duplicates(names), `${label}: ${scope}: two buttons of one dialog with one name`).toEqual([])
          // The × leaves the form, as the footer button does.
          await dialog.getByRole('button', { name: words.close, exact: true }).click()
          await expect(dialog).toHaveCount(0)
        }
      }
      // The detector bites: the same check on a dialog whose × is renamed "Cancel" (the D-3 defect, made by hand in
      // the DOM) finds the duplicate, so the checks above would fail on that defect.
      await page.getByTestId('time-lists-add-categories').click()
      const broken = page.getByRole('dialog')
      await broken.waitFor()
      await broken
        .getByRole('button', { name: words.close, exact: true })
        .evaluate((button, name) => button.setAttribute('aria-label', name), words.cancel)
      expect(duplicates(await buttonNames(broken)), `${label}: the detector finds the D-3 defect`).toEqual([
        words.cancel,
      ])
      await broken.getByRole('button', { name: words.cancel }).last().click()
      await adminCtx.close()
    }
  })
})
