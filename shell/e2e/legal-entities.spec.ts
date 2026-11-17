/**
 * specs/20261117-legal-entities T42 — the Legal entities page, end to end, through the REAL shell, admin-ui and `auth`
 * (nothing is stubbed: what each person may do is written the way an administrator writes it, helpers/legalEntitiesFixtures.ts,
 * and the global setup, e2e/global-setup.ts, leaves the registry seeded by the import and complete).
 *
 *   AC-1.1  the page shows exactly the two entities as tabs, with every value of each, the address as lines
 *   AC-1.2  a refused save names the value that is missing, next to it, and saves nothing (1.3 and 1.4: too long, check digits)
 *   AC-1.5  a saved version is what the registry reads from then on
 *   AC-2.1  a save that changes something is the next version (the button says which), by whom, when; none changes nothing
 *   AC-2.2  the history lists every version, newest first, who, when, what changed
 *   AC-2.3  an old version is opened read-only
 *   AC-2.4  an old version is restored as a NEW version equal to it; the versions in between stay; the current one is not offered
 *   AC-2.6  two people editing: the second is told a newer version exists and keeps what they typed (owner decision Q3=B: reapply
 *           onto the newer version with "Use theirs" for a value both changed, or discard and load it)
 *   AC-4.2  a person who may not change an entity cannot restore its versions (read-only history)
 *   AC-8.1  `axeViolations` is 0 on each screen (editable, read-only, refused, conflict, review, history, version, dialogs), in light
 *           and dark; every control has a visible label; refused values are announced and focus moves to the first one; the whole
 *           path is usable with the keyboard alone (the design's keyboard-only path, end to end)
 *   AC-8.2  every word exists in Italian: the page in the browser's language, once
 *
 * The capability journeys (who sees Admin and what, the role editor) are legal-entities-access.spec.ts.
 *
 * Registry state is shared and never reset (versions are append-only, AC-2.7): every journey reads the version it starts from and
 * never assumes a number, and every value it saves carries this run's tag so a save always changes something.
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { authCall, contextFor, tabTo, typeIntoFocused } from './fixtures/letterheads'
import { axeViolations } from './helpers/meetingsFixtures'
import {
  getRegistryEntity,
  setUpLegalEntityPeople,
  type EntityId,
  type LegalDetails,
  type LegalEntityPeople,
  type RegistryEntity,
  type SeededSession,
} from './helpers/legalEntitiesFixtures'

test.describe.configure({ mode: 'serial' })

const RUN = Date.now().toString(36)
const ADMIN_NAME = 'Legal Entities E2E Admin'
const CH_MANAGER_NAME = 'Legal Entities E2E CH Manager'
const LABEL: Record<EntityId, string> = { welld_it: 'WellD Italia', welld_ch: 'WellD CH' }

let people: LegalEntityPeople

test.beforeAll(async () => {
  test.setTimeout(180_000)
  people = await setUpLegalEntityPeople()
})

// ─── The registry, read and written as an API client ─────────────────────────────────────────────────────────────────

interface HistoryItem {
  version: number
  createdBy: { name: string } | null
  action: string
  restoredFrom: number | null
  changedFields: string[]
  restorable: boolean
}

const detailsOf = (read: RegistryEntity): LegalDetails => ({
  legalName: read.legalName,
  address: { it: [...read.address.it], en: [...read.address.en] },
  vatNumber: read.vatNumber,
  iban: read.iban,
  contacts: { ...read.contacts },
})

async function historyOf(session: SeededSession, entity: EntityId): Promise<HistoryItem[]> {
  const result = await authCall<{ items: HistoryItem[] }>(session, 'GET', `/legal-entities/${entity}/versions`)
  expect(result.status).toBe(200)
  return result.body.items
}

async function versionOf(session: SeededSession, entity: EntityId, n: number): Promise<RegistryEntity> {
  const result = await authCall<RegistryEntity>(session, 'GET', `/legal-entities/${entity}/versions/${n}`)
  expect(result.status).toBe(200)
  return result.body
}

/** A save by API as `session`: the next version, with `edit` applied to what is current. Returns the new version number. */
async function saveViaApi(session: SeededSession, entity: EntityId, edit: (details: LegalDetails) => void): Promise<number> {
  const read = await getRegistryEntity(session, entity)
  const details = detailsOf(read)
  edit(details)
  const saved = await authCall<{ version: number; created: boolean }>(session, 'POST', `/legal-entities/${entity}/versions`, {
    baseVersion: read.version,
    details,
  })
  expect(saved.status, JSON.stringify(saved.body)).toBe(201)
  expect(saved.body.version).toBe(read.version + 1)
  return saved.body.version
}

// ─── The page ────────────────────────────────────────────────────────────────────────────────────────────────────────

const toolNav = (page: Page) => page.getByRole('navigation', { name: 'Tool navigation' })
const adminSections = (page: Page) => page.getByRole('navigation', { name: 'Admin sections' })
const entityTab = (page: Page, entity: EntityId) =>
  page.getByRole('tablist', { name: 'Legal entities' }).getByRole('tab', { name: new RegExp(`^${LABEL[entity]},`) })
const viewTab = (page: Page, entity: EntityId, view: 'Details' | 'History') =>
  page.getByRole('tablist', { name: `Views of ${LABEL[entity]}` }).getByRole('tab', { name: view, exact: true })
const input = (page: Page, field: 'legalName' | 'vatNumber' | 'iban' | 'contacts.it' | 'contacts.en') =>
  page.getByTestId(`admin-legal-input-${field}`)
const line = (page: Page, language: 'it' | 'en', index: number) => page.getByTestId(`admin-legal-address-${language}-${index}`)
const saveButton = (page: Page) => page.getByTestId('admin-legal-save')
const savedNote = (page: Page) => page.getByTestId('admin-legal-saved')
const rowButton = (page: Page, n: number, what: 'open' | 'restore') => page.getByTestId(`admin-legal-version-row-${n}-${what}`)
const entityHeading = (page: Page) => page.getByTestId('admin-legal-entity-heading')

async function openEntity(page: Page, entity: EntityId, query = ''): Promise<void> {
  await page.goto(`/admin/legal-entities?entity=${entity}${query}`)
  await expect(page.getByRole('heading', { name: /^(Legal entities|Società del gruppo)$/, level: 2 })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(`admin-legal-entity-panel-${entity}`)).toBeVisible({ timeout: 30_000 })
}

async function expectNoAxeViolations(page: Page, label: string, include = 'main'): Promise<void> {
  // Let CSS transitions end first (a button leaving its disabled look is half-faded for a moment: axe would measure that).
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))))
  const violations = await axeViolations(page, include)
  expect(
    violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)} ${String((n as { failureSummary?: string }).failureSummary ?? '').replace(/\s+/g, ' ')}`).join(' | ')}`),
    `axe violations on ${label}`,
  ).toEqual([])
}

/** The accessible description of a control, as a screen reader would read it after its name. */
const describedBy = (locator: Locator) => locator.evaluate((element) => {
  const ids = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  return ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ')
})

async function signedIn(browser: Browser, session: SeededSession, locale = 'en-US', colorScheme: 'light' | 'dark' = 'light'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await contextFor(browser, session, locale)
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme })
  return { context, page }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T42: reach, edit, refusal (AC-1.1 to 1.5, 2.1, 8.1)', () => {
  test('an administrator reaches the page from the Admin tool: both entities as tabs with every value, tabs replace the history entry (AC-1.1, AC-8.1)', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const { context, page } = await signedIn(browser, people.admin)
    await page.goto('/')
    await toolNav(page).getByRole('link', { name: 'Admin', exact: true }).click({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/admin\/roles/, { timeout: 30_000 })
    // The new section is in the strip, between Users and Audit, for an administrator too.
    await expect(adminSections(page).getByRole('link')).toHaveText(['Roles', 'Departments', 'Users', 'Legal entities', 'Audit'])
    await adminSections(page).getByRole('link', { name: 'Legal entities', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/legal-entities$/)
    await expect(page.getByRole('heading', { name: 'Legal entities', level: 2 })).toBeVisible({ timeout: 30_000 })

    // Exactly the two entities, fixed order, each with its status in its name; an administrator may change both (no Read-only mark).
    const tabs = page.getByRole('tablist', { name: 'Legal entities' }).getByRole('tab')
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(0)).toHaveAccessibleName(/^WellD Italia, (Complete|Incomplete|Needs correction)$/)
    await expect(tabs.nth(1)).toHaveAccessibleName(/^WellD CH, (Complete|Incomplete|Needs correction)$/)
    // The default is the first entity the person may change.
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')

    // Every value of the entity, both languages, the address as lines (Q2=B): the form's controls, each with its visible label.
    const itRegistry = await getRegistryEntity(people.admin, 'welld_it')
    await expect(page.getByRole('heading', { name: 'WellD Italia', level: 3 })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Legal name', exact: true })).toHaveValue(itRegistry.legalName)
    await expect(page.getByRole('textbox', { name: 'VAT number', exact: true })).toHaveValue(itRegistry.vatNumber)
    await expect(page.getByRole('textbox', { name: 'IBAN', exact: true })).toHaveValue(itRegistry.ibanPrint)
    for (const language of ['it', 'en'] as const) {
      const group = page.getByRole('group', { name: language === 'it' ? 'Address (Italian)' : 'Address (English)' })
      for (let index = 0; index < 4; index += 1) {
        await expect(group.getByRole('textbox', { name: `Line ${index + 1}`, exact: true })).toHaveValue(itRegistry.address[language][index] ?? '')
      }
    }
    await expect(page.getByRole('textbox', { name: 'Contacts line (Italian)' })).toHaveValue(itRegistry.contacts.it)
    await expect(page.getByRole('textbox', { name: 'Contacts line (English)' })).toHaveValue(itRegistry.contacts.en)
    await expectNoAxeViolations(page, 'the editable entity, light theme (S2)')

    // The other entity is one click away, with its own values; the tab REPLACES the history entry, so Back leaves the page.
    await entityTab(page, 'welld_ch').click()
    await expect(page).toHaveURL(/entity=welld_ch/)
    const chRegistry = await getRegistryEntity(people.admin, 'welld_ch')
    await expect(page.getByRole('heading', { name: 'WellD CH', level: 3 })).toBeVisible()
    await expect(input(page, 'legalName')).toHaveValue(chRegistry.legalName)
    await expect(line(page, 'it', 0)).toHaveValue(chRegistry.address.it[0] ?? '')
    await expect(page.getByTestId('admin-legal-entity-version-line')).toContainText(`Version ${chRegistry.version} · saved by`, { timeout: 15_000 })
    await page.goBack()
    await expect(page).toHaveURL(/\/admin\/roles/)
    await context.close()
  })

  test('a welld_ch manager edits welld_ch: the button names the next version, the IBAN is saved without spaces and shown in groups, nothing to save changes nothing (AC-1.4, AC-1.5, AC-2.1)', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const before = await getRegistryEntity(people.chManager, 'welld_ch')
    const next = before.version + 1
    const { context, page } = await signedIn(browser, people.chManager)
    await openEntity(page, 'welld_ch')

    // Nothing changed: Save is in the tab order but says why it does nothing, and a click makes no version.
    const save = saveButton(page)
    await expect(save).toHaveText(`Save as version ${next}`)
    await expect(save).toHaveAttribute('aria-disabled', 'true')
    await expect(save).toHaveAccessibleDescription('There is nothing to save.')
    await expect(page.getByTestId('admin-legal-status')).toHaveText('No changes')
    await save.click({ force: true })
    await expect(savedNote(page)).toHaveCount(0)
    expect((await getRegistryEntity(people.chManager, 'welld_ch')).version).toBe(before.version)

    // Edit what the registry holds nothing for: the contacts line in both languages, and an IBAN typed in lower case with spaces.
    await input(page, 'contacts.it').fill(`Tel. +41 91 000 00 00 · ${RUN}`)
    await input(page, 'contacts.en').fill(`Phone +41 91 000 00 00 · ${RUN}`)
    // (Two published example IBANs, alternated, so that a re-run on a registry already holding one still changes it.)
    const [typed, electronic, grouped] =
      before.iban === 'CH9300762011623852957'
        ? ['de89 3704 0044 0532 0130 00', 'DE89370400440532013000', 'DE89 3704 0044 0532 0130 00']
        : ['ch93 0076 2011 6238 5295 7', 'CH9300762011623852957', 'CH93 0076 2011 6238 5295 7']
    await input(page, 'iban').fill(typed!)
    await input(page, 'iban').blur()
    // Grouped on blur only, upper case: what a person reads back.
    await expect(input(page, 'iban')).toHaveValue(grouped!)
    await expect(page.getByTestId('admin-legal-status')).toContainText('Unsaved changes. Every tool uses a saved version within a minute.')
    await expect(entityTab(page, 'welld_ch')).toHaveAccessibleName(/Unsaved changes/)
    await expect(save).not.toHaveAttribute('aria-disabled', 'true')
    await expect(save).toHaveText(`Save as version ${next}`)

    await save.click()
    await expect(savedNote(page)).toHaveText(`Version ${next} saved. Every tool uses it within a minute.`)
    // Focus stays on Save (it is not disabled, never lost), the form is the version just saved.
    await expect(save).toBeFocused()
    await expect(page.getByTestId('admin-legal-status')).toHaveText('No changes')
    await expect(save).toHaveText(`Save as version ${next + 1}`)
    await expect(entityTab(page, 'welld_ch')).not.toHaveAccessibleName(/Unsaved changes/)
    await expect(page.getByTestId('admin-legal-entity-version-line')).toContainText(`Version ${next} · saved by ${CH_MANAGER_NAME}`)
    await expect(input(page, 'iban')).toHaveValue(grouped!)

    // What the registry now reads, for everybody (AC-1.5): the next version, the IBAN in its electronic form.
    const after = await getRegistryEntity(people.nobody, 'welld_ch')
    expect(after.version).toBe(next)
    expect(after.iban).toBe(electronic)
    expect(after.ibanPrint).toBe(grouped)
    expect(after.contacts).toEqual({ it: `Tel. +41 91 000 00 00 · ${RUN}`, en: `Phone +41 91 000 00 00 · ${RUN}` })
    expect(after.legalName).toBe(before.legalName)
    const [newest] = await historyOf(people.chManager, 'welld_ch')
    expect(newest).toMatchObject({ version: next, createdBy: { name: CH_MANAGER_NAME }, action: 'save' })
    expect(newest!.changedFields).toEqual(expect.arrayContaining(['contacts.it', 'contacts.en', 'iban']))

    // Saving what is already current makes no version (AC-2.1): the registry says so, 200 and `created: false`.
    const again = await authCall<{ created: boolean; version: number }>(people.chManager, 'POST', '/legal-entities/welld_ch/versions', {
      baseVersion: next,
      details: detailsOf(after),
    })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ created: false, version: next })
    expect((await historyOf(people.chManager, 'welld_ch'))[0]!.version).toBe(next)

    // And a reload shows the same: nothing was only in the browser.
    await openEntity(page, 'welld_ch')
    await expect(input(page, 'contacts.it')).toHaveValue(`Tel. +41 91 000 00 00 · ${RUN}`)
    await expect(input(page, 'iban')).toHaveValue(grouped!)
    await context.close()
  })

  test('a refused save names each value next to it, announces them, moves focus to the first, saves nothing; fixing them clears the notice (AC-1.2, AC-1.3, AC-1.4, AC-8.1)', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const before = await getRegistryEntity(people.admin, 'welld_it')
    const originalLine2 = before.address.it[1] ?? ''
    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page, 'welld_it')

    // Three things the registry refuses: an empty legal name, an IBAN whose check digits are wrong, an address line of 121 characters.
    await input(page, 'legalName').fill('   ')
    await input(page, 'iban').fill('CH9300762011623852958')
    await line(page, 'it', 1).fill('x'.repeat(121))
    await expect(page.getByTestId('admin-legal-address-it').getByText('121 / 120')).toBeVisible()
    await saveButton(page).click()

    // The summary is one assertive alert: how many values, then one button per value in page order, each naming the value.
    const summary = page.getByTestId('admin-legal-summary')
    await expect(summary).toBeVisible()
    await expect(summary).toHaveAttribute('role', 'alert')
    await expect(page.getByTestId('admin-legal-summary-title')).toHaveText('Nothing was saved. 3 values need your attention.')
    const items = page.getByTestId('admin-legal-summary-item')
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toContainText(/legal name/i)
    await expect(items.nth(1)).toContainText(/IBAN/)
    await expect(items.nth(2)).toContainText(/Line 2.*Italian/)

    // Focus is on the first refused control; every refused control says so and says why, in the same words as the summary.
    await expect(input(page, 'legalName')).toBeFocused()
    for (const [control, sentence] of [
      [input(page, 'legalName'), /Enter the .*legal name/i],
      [input(page, 'iban'), /check digits/i],
      [line(page, 'it', 1), /Too long: at most 120 characters, you have 121/],
    ] as const) {
      await expect(control).toHaveAttribute('aria-invalid', 'true')
      expect(await describedBy(control)).toMatch(sentence)
    }
    // The values the person typed are still there.
    await expect(input(page, 'iban')).toHaveValue('CH93 0076 2011 6238 5295 8')
    await expect(line(page, 'it', 1)).toHaveValue('x'.repeat(121))
    // Nothing was saved, nothing else changed.
    expect(await getRegistryEntity(people.admin, 'welld_it')).toEqual(before)
    await expectNoAxeViolations(page, 'a refused save (S3)')

    // The summary's buttons are the second way in: the third goes to the exact line.
    await items.nth(2).click()
    await expect(line(page, 'it', 1)).toBeFocused()

    // Fixing a value takes its notice away; the last one takes the summary.
    await input(page, 'legalName').fill(before.legalName)
    await expect(input(page, 'legalName')).not.toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('admin-legal-summary-title')).toHaveText('Nothing was saved. 2 values need your attention.')
    await input(page, 'iban').fill('')
    await expect(page.getByTestId('admin-legal-summary-title')).toHaveText('Nothing was saved. 1 value needs your attention.')
    await line(page, 'it', 1).fill(originalLine2)
    await expect(summary).toHaveCount(0)
    await expect(line(page, 'it', 1)).not.toHaveAttribute('aria-invalid', 'true')
    // Back to what the registry holds: nothing to save, and the registry is as it was.
    await expect(page.getByTestId('admin-legal-status')).toHaveText('No changes')
    expect(await getRegistryEntity(people.admin, 'welld_it')).toEqual(before)
    await context.close()
  })

  test('leaving the page with unsaved changes asks; switching tabs never does and loses nothing (S1, F11)', async ({ browser }) => {
    test.setTimeout(120_000)
    const before = await getRegistryEntity(people.admin, 'welld_it')
    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page, 'welld_it')
    await input(page, 'contacts.it').fill(`draft ${RUN}`)
    await expect(entityTab(page, 'welld_it')).toHaveAccessibleName(/Unsaved changes/)

    // Tabs and views are inside the page: no question, the draft is kept per entity.
    await entityTab(page, 'welld_ch').click()
    await expect(page).toHaveURL(/entity=welld_ch/)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await entityTab(page, 'welld_it').click()
    await viewTab(page, 'welld_it', 'History').click()
    await expect(page).toHaveURL(/view=history/)
    await viewTab(page, 'welld_it', 'Details').click()
    await expect(input(page, 'contacts.it')).toHaveValue(`draft ${RUN}`)

    // Leaving it asks, naming what would be lost; Cancel is where focus starts, Escape keeps editing.
    const roles = adminSections(page).getByRole('link', { name: 'Roles', exact: true })
    await roles.click()
    const dialog = page.getByRole('alertdialog', { name: 'Leave without saving?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Your changes to WellD Italia have not been saved and will be lost.')
    await expect(page.getByTestId('admin-legal-leave-cancel')).toBeFocused()
    await expectNoAxeViolations(page, 'the leave dialog', '[role="alertdialog"]')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/admin\/legal-entities/)
    await expect(input(page, 'contacts.it')).toHaveValue(`draft ${RUN}`)
    await expect(roles).toBeFocused()

    // Discard and go.
    await roles.click()
    await expect(dialog).toBeVisible()
    await page.getByTestId('admin-legal-leave-confirm').click()
    await expect(page).toHaveURL(/\/admin\/roles/)
    await expect(page.getByTestId('admin-roles-page')).toBeVisible({ timeout: 15_000 })
    expect(await getRegistryEntity(people.admin, 'welld_it')).toEqual(before)
    await context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T42: two people editing the same entity (AC-2.6, owner decision Q3=B)', () => {
  test('the second to save is told a newer version exists and keeps what they typed; they reapply onto it, with "Use theirs" for a value both changed', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    const before = await getRegistryEntity(people.admin, 'welld_ch')
    const v0 = before.version
    // Two sessions: an administrator and the welld_ch manager, both of whom may change welld_ch.
    const a = await signedIn(browser, people.admin)
    const b = await signedIn(browser, people.chManager)
    await openEntity(a.page, 'welld_ch')
    await openEntity(b.page, 'welld_ch')
    await expect(saveButton(b.page)).toHaveText(`Save as version ${v0 + 1}`)

    // A saves first: version v0+1.
    await input(a.page, 'contacts.it').fill(`A ${RUN}`)
    await saveButton(a.page).click()
    await expect(savedNote(a.page)).toHaveText(`Version ${v0 + 1} saved. Every tool uses it within a minute.`)

    // B, who loaded version v0, changes the same value and one A did not touch, and saves on a version that is no longer current.
    await input(b.page, 'contacts.it').fill(`B ${RUN}`)
    await input(b.page, 'contacts.en').fill(`B-en ${RUN}`)
    await saveButton(b.page).click()

    const conflict = b.page.getByTestId('admin-legal-conflict')
    await expect(conflict).toBeVisible({ timeout: 15_000 })
    await expect(conflict).toHaveAttribute('role', 'alert')
    await expect(conflict).toContainText('A newer version was saved')
    await expect(conflict).toContainText(`${ADMIN_NAME} saved version ${v0 + 1}`)
    await expect(conflict).toContainText('Contacts line (Italian)')
    await expect(conflict).toContainText('Your changes are still in this form but were not saved.')
    // The two ways forward, the first one focused (the choice is above the fields); Save waits.
    const reapply = b.page.getByTestId('admin-legal-reapply')
    await expect(reapply).toHaveText(`Reapply my changes to version ${v0 + 1}`)
    await expect(b.page.getByTestId('admin-legal-discard')).toHaveText(`Discard my changes and load version ${v0 + 1}`)
    await expect(reapply).toBeFocused()
    await expect(saveButton(b.page)).toHaveAttribute('aria-disabled', 'true')
    await expect(saveButton(b.page)).toHaveAccessibleDescription('A newer version exists. Choose how to continue.')
    // B keeps what they typed, and nothing of B's reached the registry.
    await expect(input(b.page, 'contacts.it')).toHaveValue(`B ${RUN}`)
    await expect(input(b.page, 'contacts.en')).toHaveValue(`B-en ${RUN}`)
    const mid = await getRegistryEntity(people.admin, 'welld_ch')
    expect(mid.version).toBe(v0 + 1)
    expect(mid.contacts.it).toBe(`A ${RUN}`)
    await expectNoAxeViolations(b.page, 'the conflict (S2)')

    // Reapply, by keyboard (it has focus): B's values go onto version v0+1; the one both changed is flagged and focused.
    await b.page.keyboard.press('Enter')
    await expect(conflict).toHaveCount(0)
    await expect(input(b.page, 'contacts.it')).toBeFocused()
    await expect(input(b.page, 'contacts.it')).toHaveValue(`B ${RUN}`)
    await expect(input(b.page, 'contacts.en')).toHaveValue(`B-en ${RUN}`)
    await expect(b.page.getByText(`Also changed in version ${v0 + 1} by ${ADMIN_NAME}: “A ${RUN}”. Yours is kept.`)).toBeVisible()
    const useTheirs = b.page.getByTestId('admin-legal-use-theirs-contacts.it')
    await expect(useTheirs).toHaveText('Use theirs')
    await expect(b.page.getByTestId('admin-legal-applied')).toHaveText(
      `Your changes were applied to version ${v0 + 1}. Contacts line (Italian) to review, then save as version ${v0 + 2}.`,
    )
    await expect(saveButton(b.page)).toHaveText(`Save as version ${v0 + 2}`)
    await expect(saveButton(b.page)).not.toHaveAttribute('aria-disabled', 'true')
    await expectNoAxeViolations(b.page, 'the values to review after Reapply (S2)')

    // "Use theirs" takes A's value for that one; the review is over.
    await useTheirs.click()
    await expect(input(b.page, 'contacts.it')).toHaveValue(`A ${RUN}`)
    await expect(input(b.page, 'contacts.it')).toBeFocused()
    await expect(b.page.getByTestId('admin-legal-applied')).toHaveCount(0)
    await expect(useTheirs).toHaveCount(0)

    // Save: version v0+2 holds A's contacts line (taken) and B's English one (B's own change, kept).
    await saveButton(b.page).click()
    await expect(savedNote(b.page)).toHaveText(`Version ${v0 + 2} saved. Every tool uses it within a minute.`)
    const merged = await getRegistryEntity(people.admin, 'welld_ch')
    expect(merged.version).toBe(v0 + 2)
    expect(merged.contacts).toEqual({ it: `A ${RUN}`, en: `B-en ${RUN}` })
    const [newest, previous] = await historyOf(people.admin, 'welld_ch')
    expect(newest).toMatchObject({ version: v0 + 2, createdBy: { name: CH_MANAGER_NAME } })
    expect(previous).toMatchObject({ version: v0 + 1, createdBy: { name: ADMIN_NAME } })

    // The second way: "Discard my changes and load version n". A saves again; B, a version behind, types and saves.
    await openEntity(a.page, 'welld_ch')
    await input(a.page, 'contacts.en').fill(`A2 ${RUN}`)
    await saveButton(a.page).click()
    await expect(savedNote(a.page)).toHaveText(`Version ${v0 + 3} saved. Every tool uses it within a minute.`)
    await input(b.page, 'contacts.it').fill(`B2 ${RUN}`)
    await saveButton(b.page).click()
    await expect(b.page.getByTestId('admin-legal-conflict')).toBeVisible({ timeout: 15_000 })
    await expect(b.page.getByTestId('admin-legal-discard')).toHaveText(`Discard my changes and load version ${v0 + 3}`)
    await b.page.getByTestId('admin-legal-discard').click()
    // B now sees version v0+3 as saved; what they typed is gone; nothing is waiting; Save has focus.
    await expect(b.page.getByTestId('admin-legal-conflict')).toHaveCount(0)
    await expect(input(b.page, 'contacts.it')).toHaveValue(`A ${RUN}`)
    await expect(input(b.page, 'contacts.en')).toHaveValue(`A2 ${RUN}`)
    await expect(saveButton(b.page)).toHaveText(`Save as version ${v0 + 4}`)
    await expect(saveButton(b.page)).toHaveAttribute('aria-disabled', 'true')
    await expect(saveButton(b.page)).toBeFocused()
    await expect(entityTab(b.page, 'welld_ch')).not.toHaveAccessibleName(/Unsaved changes/)
    await expect(b.page.getByTestId('admin-legal-entity-version-line')).toContainText(`Version ${v0 + 3} · saved by ${ADMIN_NAME}`)
    const final = await getRegistryEntity(people.admin, 'welld_ch')
    expect(final.version).toBe(v0 + 3)
    expect(final.contacts).toEqual({ it: `A ${RUN}`, en: `A2 ${RUN}` })
    await a.context.close()
    await b.context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T42: history, an old version, restore (AC-2.2, AC-2.3, AC-2.4, AC-4.2, AC-8.1)', () => {
  test('the history lists every version newest first; an old one opens read-only; restoring it makes a NEW version equal to it and keeps the rest', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    // A version to go back to, and a newer one that differs from it.
    const c = (await getRegistryEntity(people.admin, 'welld_it')).version
    const n = await saveViaApi(people.admin, 'welld_it', (details) => {
      details.contacts.it = `Hist ${RUN}`
    })
    expect(n).toBe(c + 1)
    const { context, page } = await signedIn(browser, people.admin)
    await openEntity(page, 'welld_it')
    await viewTab(page, 'welld_it', 'History').click()
    await expect(page).toHaveURL(/view=history/)

    // Every version, newest first (AC-2.2): who, when, what changed.
    const table = page.getByRole('table', { name: 'Versions of WellD Italia' })
    await expect(table).toBeVisible({ timeout: 15_000 })
    const listed = await historyOf(people.admin, 'welld_it')
    expect(listed.map((item) => item.version)).toEqual([...listed.map((item) => item.version)].sort((x, y) => y - x))
    const opens = await page.locator('[data-testid^="admin-legal-version-row-"][data-testid$="-open"]').evaluateAll((nodes) =>
      nodes.map((node) => Number((node as HTMLElement).dataset['testid']!.split('-')[4])),
    )
    expect(opens).toEqual(listed.map((item) => item.version))
    expect(opens[0]).toBe(n)
    const newestRow = table.getByRole('row').filter({ has: rowButton(page, n, 'open') })
    await expect(newestRow).toContainText('Current')
    await expect(newestRow).toContainText(ADMIN_NAME)
    await expect(newestRow).toContainText('Contacts line (Italian)')
    await expect(newestRow.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/)
    // The current version cannot be restored; every older one can.
    await expect(rowButton(page, n, 'restore')).toHaveCount(0)
    await expect(rowButton(page, c, 'restore')).toBeVisible()
    await expect(rowButton(page, c, 'open')).toHaveAccessibleName(`Open version ${c}`)
    await expect(rowButton(page, c, 'restore')).toHaveAccessibleName(`Restore version ${c}`)
    // The first version is the move from the CRM, by the system.
    const first = table.getByRole('row').filter({ has: rowButton(page, 1, 'open') })
    await expect(first).toContainText('Moved from the CRM')
    await expect(first).toContainText('System')
    await expectNoAxeViolations(page, 'the history (S5)')

    // Open an old version (AC-2.3): read-only, heading focused, all its details, no input, "Not current".
    await rowButton(page, c, 'open').click()
    await expect(page).toHaveURL(new RegExp(`view=history&version=${c}$`))
    const banner = page.getByTestId('admin-legal-version-banner')
    await expect(page.getByTestId('admin-legal-version-banner-heading')).toHaveText(`Viewing version ${c} (read-only)`)
    await expect(page.getByTestId('admin-legal-version-banner-heading')).toBeFocused()
    await expect(banner).toContainText('Not current')
    await expect(banner).toContainText(`The current version is ${n}.`)
    const old = await versionOf(people.admin, 'welld_it', c)
    await expect(page.getByTestId('admin-legal-version-facts').getByTestId('admin-legal-fact-legalName')).toHaveText(old.legalName)
    await expect(page.getByTestId('admin-legal-version-facts').getByTestId('admin-legal-fact-vatNumber')).toHaveText(old.vatNumber)
    await expect(page.getByTestId('admin-legal-entity-panel-welld_it').getByRole('textbox')).toHaveCount(0)
    await expectNoAxeViolations(page, 'an old version (S6)')

    // Back to the history returns to that row's Open button; so does the browser's Back from the version.
    await page.getByTestId('admin-legal-version-banner-back').click()
    await expect(table).toBeVisible()
    await expect(rowButton(page, c, 'open')).toBeFocused()
    await rowButton(page, c, 'open').click()
    await expect(banner).toBeVisible()
    await page.goBack()
    await expect(table).toBeVisible()
    await expect(rowButton(page, c, 'open')).toBeFocused()

    // Restore it from its own banner: the dialog says what will happen and which values change; Cancel has focus; Escape keeps it as it was.
    await rowButton(page, c, 'open').click()
    await page.getByTestId('admin-legal-version-banner-restore').click()
    const dialog = page.getByRole('alertdialog', { name: `Restore version ${c}?` })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`This creates version ${n + 1} with the same details as version ${c}`)
    await expect(page.getByTestId('admin-legal-restore-changes')).toContainText('Contacts line (Italian)')
    await expect(page.getByTestId('admin-legal-restore-cancel')).toBeFocused()
    await expectNoAxeViolations(page, 'the restore dialog (S7)', '[role="alertdialog"]')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('admin-legal-version-banner-restore')).toBeFocused()
    expect((await getRegistryEntity(people.admin, 'welld_it')).version).toBe(n)

    // Confirm: a new version equal to the old one, on Details, with the notice, focus on the entity's heading.
    await page.getByTestId('admin-legal-version-banner-restore').click()
    await expect(dialog).toBeVisible()
    await page.getByTestId('admin-legal-restore-confirm').click()
    await expect(page).toHaveURL(/\/admin\/legal-entities\?entity=welld_it$/)
    await expect(page.getByTestId('admin-legal-restored')).toHaveText(`Version ${n + 1} created from version ${c}`)
    await expect(entityHeading(page)).toBeFocused()
    await expect(input(page, 'contacts.it')).toHaveValue(old.contacts.it)

    const restored = await getRegistryEntity(people.admin, 'welld_it')
    expect(restored.version).toBe(n + 1)
    expect(detailsOf(restored)).toEqual(detailsOf(old))
    // The versions in between stay, unchanged (AC-2.4, AC-2.7); the new one says where it came from.
    const after = await historyOf(people.admin, 'welld_it')
    expect(after.map((item) => item.version)).toEqual([n + 1, ...listed.map((item) => item.version)])
    expect(after[0]).toMatchObject({ version: n + 1, action: 'restore', restoredFrom: c })
    expect((await versionOf(people.admin, 'welld_it', n)).contacts.it).toBe(`Hist ${RUN}`)
    await viewTab(page, 'welld_it', 'History').click()
    const restoredRow = page.getByRole('table', { name: 'Versions of WellD Italia' }).getByRole('row').filter({ has: rowButton(page, n + 1, 'open') })
    await expect(restoredRow).toContainText(`Same details as version ${c}`)
    await expect(restoredRow).toContainText('Current')
    await context.close()
  })

  test('a manager who may not change welld_it reads its history and its versions, and is offered no restore (AC-4.2)', async ({ browser }) => {
    test.setTimeout(120_000)
    const versions = (await historyOf(people.chManager, 'welld_it')).map((item) => item.version)
    expect(versions.length).toBeGreaterThan(2)
    const { context, page } = await signedIn(browser, people.chManager)
    await openEntity(page, 'welld_it', '&view=history')
    await expect(page.getByRole('table', { name: 'Versions of WellD Italia' })).toBeVisible({ timeout: 15_000 })
    for (const version of versions) {
      await expect(rowButton(page, version, 'open')).toBeVisible()
    }
    await expect(page.locator('[data-testid^="admin-legal-version-row-"][data-testid$="-restore"]')).toHaveCount(0)
    await expectNoAxeViolations(page, 'the read-only history (S5)')

    const old = versions[versions.length - 1]!
    await rowButton(page, old, 'open').click()
    await expect(page.getByTestId('admin-legal-version-banner-heading')).toHaveText(`Viewing version ${old} (read-only)`)
    await expect(page.getByTestId('admin-legal-version-banner-restore')).toHaveCount(0)
    await expect(page.getByTestId('admin-legal-version-facts')).toBeVisible()
    await context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T42: the keyboard-only path (AC-8.1)', () => {
  test('Admin tool, section link, entity tablist, view tablist, the form, a refusal, a save, History, a version, a restore: no pointer', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    const entity: EntityId = 'welld_it'
    const before = await getRegistryEntity(people.admin, entity)
    // A version older than the one this journey saves, differing from it (the journey restores it).
    const target = await saveViaApi(people.admin, entity, (details) => {
      details.contacts.en = `Kbd-old ${RUN}`
    })
    const { context, page } = await signedIn(browser, people.admin)
    await page.goto('/')
    await expect(toolNav(page)).toBeVisible({ timeout: 30_000 })

    // Admin tool → "Legal entities" section link (real links, each its own Tab stop, aria-current on the one open).
    await tabTo(page, toolNav(page).getByRole('link', { name: 'Admin', exact: true }))
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/admin\/roles/, { timeout: 30_000 })
    const section = adminSections(page).getByRole('link', { name: 'Legal entities', exact: true })
    await tabTo(page, section)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/admin\/legal-entities/)
    await expect(section).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId(`admin-legal-entity-panel-${entity}`)).toBeVisible({ timeout: 30_000 })

    // The entity tablist is ONE Tab stop (the selected tab); arrows move and activate; the other entity and back.
    await tabTo(page, entityTab(page, entity))
    await expect(entityTab(page, entity)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(entityTab(page, 'welld_ch')).toBeFocused()
    await expect(entityTab(page, 'welld_ch')).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/entity=welld_ch/)
    await page.keyboard.press('ArrowLeft')
    await expect(entityTab(page, entity)).toBeFocused()
    await expect(entityTab(page, entity)).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/entity=welld_it/)

    // The view tablist, then into the form; every control of the form in order, down to Save.
    await tabTo(page, viewTab(page, entity, 'Details'))
    await tabTo(page, input(page, 'legalName'))
    const order: string[] = []
    const stops = async () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? '')
    order.push(await stops())
    for (let presses = 0; presses < 40 && order[order.length - 1] !== 'admin-legal-save'; presses += 1) {
      if (presses === 0) {
        // The first control is the one we are on: empty it, as a person would, so that the save is refused.
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.press('Backspace')
      }
      await page.keyboard.press('Tab')
      order.push(await stops())
    }
    expect(order).toEqual([
      'admin-legal-input-legalName',
      'admin-legal-input-vatNumber',
      'admin-legal-input-iban',
      ...['it', 'en'].flatMap((language) => [0, 1, 2, 3].map((index) => `admin-legal-address-${language}-${index}`)),
      'admin-legal-input-contacts.it',
      'admin-legal-input-contacts.en',
      'admin-legal-save',
    ])

    // Save → refused: focus lands on the first refused control; the summary's buttons are the second way in.
    await expect(saveButton(page)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('admin-legal-summary-title')).toHaveText('Nothing was saved. 1 value needs your attention.')
    await expect(input(page, 'legalName')).toBeFocused()
    await expect(input(page, 'legalName')).toHaveAttribute('aria-invalid', 'true')
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByTestId('admin-legal-summary-item')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(input(page, 'legalName')).toBeFocused()

    // Correct it, change the contacts line, Save: the saved note is read, focus is still on Save.
    await typeIntoFocused(page, before.legalName)
    await expect(page.getByTestId('admin-legal-summary')).toHaveCount(0)
    await tabTo(page, input(page, 'contacts.it'))
    await typeIntoFocused(page, `Kbd ${RUN}`)
    await tabTo(page, saveButton(page))
    await expect(saveButton(page)).toHaveText(`Save as version ${target + 1}`)
    await page.keyboard.press('Enter')
    await expect(savedNote(page)).toHaveText(`Version ${target + 1} saved. Every tool uses it within a minute.`)
    await expect(saveButton(page)).toBeFocused()
    const saved = await getRegistryEntity(people.admin, entity)
    expect(saved.version).toBe(target + 1)
    expect(saved.legalName).toBe(before.legalName)
    expect(saved.contacts.it).toBe(`Kbd ${RUN}`)

    // View tablist (back with Shift+Tab), arrow to History, then the version the journey will restore: Open → heading focused.
    await tabTo(page, viewTab(page, entity, 'Details'), { reverse: true })
    await page.keyboard.press('ArrowRight')
    await expect(viewTab(page, entity, 'History')).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/view=history/)
    await tabTo(page, page.getByRole('button', { name: `Open version ${target}`, exact: true }))
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('admin-legal-version-banner-heading')).toHaveText(`Viewing version ${target} (read-only)`)
    await expect(page.getByTestId('admin-legal-version-banner-heading')).toBeFocused()

    // Restore this version → dialog: Cancel has focus, Tab stays inside, Escape closes and returns to the button.
    const restoreButton = page.getByRole('button', { name: 'Restore this version', exact: true })
    await tabTo(page, restoreButton)
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('alertdialog', { name: `Restore version ${target}?` })
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('admin-legal-restore-cancel')).toBeFocused()
    for (let presses = 0; presses < 5; presses += 1) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Tab ${presses + 1} stays in the dialog`).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(restoreButton).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await tabTo(page, page.getByTestId('admin-legal-restore-confirm'))
    await page.keyboard.press('Enter')

    // Confirmed: the entity's heading has focus (the button that had it is gone) and the success status is shown.
    await expect(page.getByTestId('admin-legal-restored')).toHaveText(`Version ${target + 2} created from version ${target}`)
    await expect(entityHeading(page)).toBeFocused()
    const final = await getRegistryEntity(people.admin, entity)
    expect(final.version).toBe(target + 2)
    expect(detailsOf(final)).toEqual(detailsOf(await versionOf(people.admin, entity, target)))
    expect(final.contacts.en).toBe(`Kbd-old ${RUN}`)
    await context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T42: both themes (AC-8.1)', () => {
  test('axeViolations is 0 on the editable form, the read-only facts, the history and a version in the dark theme too', async ({ browser }) => {
    test.setTimeout(150_000)
    const dark = await signedIn(browser, people.chManager, 'en-US', 'dark')
    await openEntity(dark.page, 'welld_ch')
    await expect(dark.page.locator('html')).toHaveCSS('color-scheme', /dark/)
    await expectNoAxeViolations(dark.page, 'the editable form, dark (S2)')
    await entityTab(dark.page, 'welld_it').click()
    await expect(dark.page.getByTestId('admin-legal-entity-facts')).toBeVisible()
    await expectNoAxeViolations(dark.page, 'the read-only facts, dark (S4)')
    await viewTab(dark.page, 'welld_it', 'History').click()
    await expect(dark.page.getByRole('table', { name: 'Versions of WellD Italia' })).toBeVisible({ timeout: 15_000 })
    await expectNoAxeViolations(dark.page, 'the history, dark (S5)')
    await dark.page.locator('[data-testid^="admin-legal-version-row-"][data-testid$="-open"]').last().click()
    await expect(dark.page.getByTestId('admin-legal-version-view')).toBeVisible()
    await expectNoAxeViolations(dark.page, 'a version, dark (S6)')
    await dark.context.close()

    // Light, the same screens for a person who may change welld_ch (the refusal and conflict are in the journeys above).
    const light = await signedIn(browser, people.chManager, 'en-US', 'light')
    await openEntity(light.page, 'welld_it')
    await expectNoAxeViolations(light.page, 'the read-only facts, light (S4)')
    await light.context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261117-legal-entities T42: Italian, once (AC-8.2)', () => {
  test('the page, the form, a refusal, a save and the history follow the browser\'s language', async ({ browser }) => {
    test.setTimeout(180_000)
    const before = await getRegistryEntity(people.chManager, 'welld_ch')
    const next = before.version + 1
    const { context, page } = await signedIn(browser, people.chManager, 'it-IT')
    await openEntity(page, 'welld_ch')

    await expect(page.getByRole('heading', { name: 'Società del gruppo', level: 2 })).toBeVisible()
    const tabs = page.getByRole('tablist', { name: 'Società del gruppo' })
    await expect(tabs.getByRole('tab', { name: /^WellD Italia, .*Sola lettura$/ })).toBeVisible()
    await expect(tabs.getByRole('tab', { name: /^WellD CH, Completa$/ })).toBeVisible()
    await expect(page.getByRole('tablist', { name: 'Viste di WellD CH' }).getByRole('tab', { name: 'Dati' })).toBeVisible()
    await expect(page.getByRole('tablist', { name: 'Viste di WellD CH' }).getByRole('tab', { name: 'Cronologia' })).toBeVisible()
    for (const label of ['Ragione sociale', 'Partita IVA', 'IBAN', 'Riga contatti (italiano)', 'Riga contatti (inglese)']) {
      await expect(page.getByRole('textbox', { name: label, exact: true })).toBeVisible()
    }
    await expect(page.getByRole('group', { name: 'Indirizzo (italiano)' }).getByRole('textbox', { name: 'Riga 1', exact: true })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Indirizzo (inglese)' }).getByRole('textbox', { name: 'Riga 4', exact: true })).toBeVisible()
    await expect(saveButton(page)).toHaveText(`Salva come versione ${next}`)
    await expect(page.getByTestId('admin-legal-status')).toHaveText('Nessuna modifica')
    await expectNoAxeViolations(page, 'the form in Italian (S2)')

    // The read-only entity, in Italian.
    await page.getByRole('tab', { name: /^WellD Italia,/ }).click()
    await expect(page.getByTestId('admin-legal-entity-readonly-note')).toContainText('Puoi leggere questi dati ma non modificarli')
    await expect(page.getByTestId('admin-legal-entity-facts').getByText('Ragione sociale')).toBeVisible()
    await expectNoAxeViolations(page, 'the read-only facts in Italian (S4)')
    await page.getByRole('tab', { name: /^WellD CH,/ }).click()

    // A refusal, in Italian: the title, the summary item and the control's own sentence.
    await input(page, 'legalName').fill('')
    await saveButton(page).click()
    await expect(page.getByTestId('admin-legal-summary-title')).toHaveText('Non è stato salvato nulla. 1 valore richiede la tua attenzione.')
    await expect(page.getByTestId('admin-legal-summary-item')).toContainText(/Ragione sociale/i)
    await expect(input(page, 'legalName')).toBeFocused()
    expect(await describedBy(input(page, 'legalName'))).toMatch(/Inserisci/)
    await expectNoAxeViolations(page, 'a refusal in Italian (S3)')

    // Correct and save: the saved note, in Italian.
    await input(page, 'legalName').fill(before.legalName)
    await input(page, 'contacts.it').fill(`Tel. it ${RUN}`)
    await saveButton(page).click()
    await expect(savedNote(page)).toHaveText(`Versione ${next} salvata. Ogni strumento la usa entro un minuto.`)
    await expect(page.getByTestId('admin-legal-entity-version-line')).toContainText(`Versione ${next} · salvata da ${CH_MANAGER_NAME}`)

    // The history, in Italian: caption, headers, badge, buttons named per row.
    await page.getByRole('tab', { name: 'Cronologia', exact: true }).click()
    const table = page.getByRole('table', { name: 'Versioni di WellD CH' })
    await expect(table).toBeVisible({ timeout: 15_000 })
    for (const header of ['Versione', 'Salvata da', 'Salvata il', 'Cosa è cambiato', 'Azioni']) {
      await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
    }
    await expect(table.getByText('Corrente', { exact: true })).toBeVisible()
    await expect(table.getByText('Portata dal CRM')).toBeVisible()
    await expect(table.getByText('Sistema', { exact: true })).toBeVisible()
    await expect(rowButton(page, before.version, 'open')).toHaveAccessibleName(`Apri la versione ${before.version}`)
    await expect(rowButton(page, before.version, 'restore')).toHaveAccessibleName(`Ripristina la versione ${before.version}`)
    await expectNoAxeViolations(page, 'the history in Italian (S5)')

    // A version and the restore dialog, in Italian (cancelled: the restore itself is in the journey above).
    await rowButton(page, before.version, 'open').click()
    await expect(page.getByTestId('admin-legal-version-banner-heading')).toHaveText(`Stai guardando la versione ${before.version} (sola lettura)`)
    await page.getByTestId('admin-legal-version-banner-restore').click()
    const dialog = page.getByRole('alertdialog', { name: `Ripristinare la versione ${before.version}?` })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`Questo crea la versione ${next + 1} con gli stessi dati della versione ${before.version}`)
    await expectNoAxeViolations(page, 'the restore dialog in Italian (S7)', '[role="alertdialog"]')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // No English left on the page's own words.
    const text = await page.getByTestId('admin-legal-entities-page').innerText()
    for (const english of ['Legal entities', 'Save as version', 'Read-only', 'History', 'Details', 'Back to history']) {
      expect(text, `"${english}" left in English`).not.toContain(english)
    }
    expect((await getRegistryEntity(people.chManager, 'welld_ch')).version).toBe(next)
    await context.close()
  })
})
