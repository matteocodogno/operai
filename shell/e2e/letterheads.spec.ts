/**
 * specs/20261116-letterhead-service T26 — the Letterheads configurator, through the REAL assembled shell and letterheads-ui,
 * against the REAL `auth` and the REAL letterhead-api (nothing is intercepted: see fixtures/letterheads.ts).
 *
 *   AC-8.3  every control of the form has a visible label and can be reached and used with the keyboard alone; a refused
 *           value is shown next to its control, named in the error and announced, and focus moves to the first one on a
 *           refused save
 *   AC-8.4  the preview of the sample document (at least three pages, every block type) is drawn by the service on the
 *           values in the form, saved or not, and follows an edit without a save, within 2 s of the last edit
 *   AC-8.5  (superseded by specs/20261117-legal-entities AC-5.4: the preview shows the REGISTRY's company details, not a
 *           sample; the journeys of that are the describe at the end of this file and the first journey's source line)
 *   AC-8.8  leaving with an unsaved change asks first; the screen is in the person's language (it/en)
 *
 * The access gating and the read-only modes (AC-8.1, 8.2, 8.9) are letterheads-access.spec.ts; the history, the version
 * view and the restore (AC-8.7) are letterheads-versions.spec.ts.
 *
 * ═══ PREREQUISITES (what must be running, with which env) ═══════════════════════════════════════════════════
 * The base of every shell journey (playwright.config.ts: Postgres, `auth` :3001 with ENABLE_TEST_AUTH=true and its seed
 * applied — `bun run db:release` — so the `admin` role holds the letterheads permissions), PLUS:
 *
 *  - letterhead-api running (`mise run dev:letterhead`, :8088, or a container: playwright.config.ts item 8) on its OWN
 *    database and bucket, reading THIS `auth`'s JWKS and `GET /authz/resolve`, with ALLOWED_ORIGINS holding the shell's
 *    origin. The shell is built with E2E_LETTERHEADS_API_URL (default http://localhost:8088) as its origin for it.
 *  - the spec process can run `auth/scripts/e2e-invite-fixtures.ts` (the first admin is made there, as every admin spec
 *    does): DATABASE_URL and the rest of `auth`'s env, or `direnv allow` in auth/.
 *
 * What a run leaves behind: versions of both entities in letterhead-api's database (they are never deleted: no route
 * deletes one, AC-4.3) and four @operai.test users with their e2e roles in `auth`. The journeys never assume a version
 * number: each reads the active version it starts from.
 *
 *  run:  cd shell && pnpm exec playwright test letterheads --trace off
 */
import { expect, test, type Page } from '@playwright/test'
import { getRegistryEntity, type LegalDetails } from './helpers/legalEntitiesFixtures'
import {
  ENTITY_NAME,
  activeVersion,
  authCall,
  groupIban,
  ibanWithCheckDigits,
  readOptionalDetails,
  restoreOptionalDetails,
  type OptionalDetails,
  contextFor,
  ensureLetterheads,
  footerLeftLine1Italian,
  history,
  marginInput,
  openConfigurator,
  pageImages,
  previewRegion,
  recordPreviewCalls,
  saveButton,
  setUpPeople,
  tabTo,
  typeIntoFocused,
  versionConfig,
  type People,
} from './fixtures/letterheads'

test.describe.configure({ mode: 'serial' })

let people: People

test.beforeAll(async () => {
  test.setTimeout(180_000)
  people = await setUpPeople()
  await ensureLetterheads(people.admin)
})

/** A margin value that is valid and is not `current`, so a save really changes something. */
const otherMargin = (current: unknown): number => (Number(current) === 31 ? 32 : 31)

const topOf = async (entity: 'welld_ch' | 'welld_it'): Promise<number> => {
  const n = (await activeVersion(people.admin, entity))!
  return ((await versionConfig(people.admin, entity, n)) as { margins: { top: number } }).margins.top
}

/** The page's own text for every page of the preview (each figure's caption), joined. */
const previewText = async (page: Page): Promise<string> => (await previewRegion(page).textContent()) ?? ''

test.describe('specs/20261116-letterhead-service T26: the Letterheads configurator through the shell', () => {
  test('the preview is the service\'s sample document: three or more pages, every block type, marked as a sample (AC-8.4, AC-8.5)', async ({
    browser,
  }) => {
    const context = await contextFor(browser, people.admin)
    const page = await context.newPage()
    const calls = recordPreviewCalls(page)

    await openConfigurator(page, 'welld_ch')

    // The pages: one image per page, each with the "Page N of M" text alternative, at least three of them.
    const count = await pageImages(page).count()
    expect(count).toBeGreaterThanOrEqual(3)
    for (let n = 1; n <= count; n += 1) {
      await expect(previewRegion(page).getByRole('img', { name: `Page ${n} of ${count}` })).toBeVisible()
    }
    await expect(previewRegion(page)).toContainText(`${count} pages`)

    // Every block type of the sample is on some page: headings, the text styles (including the missing one), both lists,
    // a table that runs over a page break, an image. The first page, a page in between and the last page are different.
    const text = await previewText(page)
    for (const block of [
      'Headings and paragraphs',
      'Title style',
      'Small style',
      'Muted style',
      'Right style',
      'Centered style',
      'Missing style',
      'First point of the list',
      'First numbered step',
      'Table',
      'Sample item 01',
      'Figure: a sample image',
      'End of the document',
    ]) {
      expect(text, `the sample document has "${block}"`).toContain(block)
    }
    await expect(pageImages(page).first()).toBeVisible()
    await expect(page.getByRole('figure').first()).toContainText('Sample document')
    await expect(page.getByRole('figure').last()).toContainText('End of the document')

    // The company details are NOT a sample any more (specs/20261117-legal-entities AC-5.4, supersedes AC-8.5): the pages hold
    // the registry's, the page says where they come from (the source line, with its link for a person who may manage the
    // entity) and shows the legend of the missing look, and the intro no longer calls the details placeholders (FU-9).
    expect(text).not.toContain('(SAMPLE)')
    const words = text.replace(/\s+/g, ' ')
    expect(words).not.toMatch(/placeholders|segnaposto/i)
    expect(words).toContain("The company's details in it are the real ones; a detail that is not filled in yet is marked.")
    const registry = await getRegistryEntity(people.admin, 'welld_ch')
    expect(words).toContain(registry.legalName)
    expect(words).toContain(registry.address.en.join(', '))
    await expect(page.getByTestId('letterheads-preview-sample')).toHaveCount(0)
    await expect(page.getByTestId('letterheads-preview-source')).toContainText(
      'The company details (name, address, VAT number, IBAN, contacts) are the real ones from Legal entities, in the preview language. The body of the page is sample text.',
    )
    await expect(page.getByTestId('letterheads-preview-source-link')).toHaveAttribute(
      'href',
      '/admin/legal-entities?entity=welld_ch',
    )
    await expect(page.getByTestId('letterheads-preview-legend')).toContainText('⟦Label⟧')
    await expect(page.getByTestId('letterheads-preview-legend')).toContainText('A detail that is not filled in yet.')

    // It is the unsaved form that is drawn (the request carries the configuration, not a version), in the person's language.
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.language).toBe('en')
    expect(calls[0]!.config).toHaveProperty('margins')
    await context.close()
  })

  test('keyboard only: edit a value, the preview follows within 2 s, switch its language, save as the next version (AC-8.3, AC-8.4)', async ({
    browser,
  }) => {
    const before = (await activeVersion(people.admin, 'welld_ch'))!
    const topBefore = await topOf('welld_ch')

    const context = await contextFor(browser, people.admin)
    const page = await context.newPage()
    const calls = recordPreviewCalls(page)
    await openConfigurator(page, 'welld_ch')
    await expect(page.getByText('No unsaved changes')).toBeVisible()
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')
    const firstPageBefore = await pageImages(page).first().getAttribute('src')

    // To the Top margin with Tab alone (nothing here uses the pointer), then a series of edits typed one after the other.
    // Each is a new unsaved value of the form; the preview of each must be on the screen within 2 s of the last key.
    await tabTo(page, marginInput(page, 'Top'))
    const edits = ['26', '27.5', '29', '30', String(otherMargin(topBefore))]
    const waits: number[] = []
    for (const value of edits) {
      const asked = calls.length
      await typeIntoFocused(page, value)
      const lastKey = Date.now()
      await expect.poll(() => calls.slice(asked).some((call) => call.config.margins.top === Number(value)), {
        message: `a preview was asked for top = ${value}`,
        timeout: 5_000,
      }).toBe(true)
      const call = calls.slice(asked).find((c) => c.config.margins.top === Number(value))!
      expect((await call.response).status).toBe(200)
      waits.push(Date.now() - lastKey)
      // The pane is drawn again with that answer: not busy any more, the same number of pages, a different first page.
      await expect(previewRegion(page)).not.toHaveAttribute('aria-busy', 'true')
    }
    // AC-8.4: within 2 s of the last edit in 95 % of edits. Five edits: the 95th percentile is the slowest one.
    test.info().annotations.push({ type: 'preview latency (ms, last key to full answer)', description: waits.join(', ') })
    expect(Math.max(...waits), `last key to the answer, ms: ${waits.join(', ')}`).toBeLessThanOrEqual(2000)
    await expect.poll(async () => pageImages(page).first().getAttribute('src')).not.toBe(firstPageBefore)
    expect(await pageImages(page).count()).toBeGreaterThanOrEqual(3)

    // The change is unsaved, and the preview ran on it before any save: the saved version is still the old value.
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    expect(await topOf('welld_ch')).toBe(topBefore)
    expect(await activeVersion(people.admin, 'welld_ch')).toBe(before)

    // Preview language: the radio group, by arrow keys (Tab lands on the checked one: English; Left selects Italian).
    const english = page.getByRole('radio', { name: 'English' })
    await tabTo(page, english)
    const askedBeforeLanguage = calls.length
    const englishText = await page.getByRole('figure').first().textContent()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('radio', { name: 'Italian' })).toBeChecked()
    await expect.poll(() => calls.slice(askedBeforeLanguage).some((c) => c.language === 'it')).toBe(true)
    await expect.poll(async () => page.getByRole('figure').first().textContent()).not.toBe(englishText)
    // A viewing choice: the form is untouched by it.
    await expect(marginInput(page, 'Top')).toHaveValue(String(otherMargin(topBefore)))

    // Save, by keyboard: the bar is above the preview in the tab order, so back with Shift+Tab, then Enter.
    await tabTo(page, saveButton(page), { reverse: true })
    await expect(saveButton(page)).toHaveText(`Save as version ${before + 1}`)
    await expect(saveButton(page)).not.toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Enter')

    await expect(page.getByTestId('letterheads-saved')).toContainText(`Version ${before + 1} saved`)
    await expect(page.getByText('No unsaved changes')).toBeVisible()
    await expect(page.getByText(`Active version ${before + 1}`)).toBeVisible()
    // Focus stays on the Save button (now not offering anything to save).
    await expect(saveButton(page)).toBeFocused()
    await expect(saveButton(page)).toHaveAttribute('aria-disabled', 'true')

    // What the service now holds: the next version, with the typed value, made by this person, naming what changed.
    expect(await activeVersion(people.admin, 'welld_ch')).toBe(before + 1)
    expect(await topOf('welld_ch')).toBe(otherMargin(topBefore))
    const newest = (await history(people.admin, 'welld_ch'))[0]!
    expect(newest.version).toBe(before + 1)
    expect(newest.createdBy.name).toBe('Letterheads E2E Admin')
    expect(newest.changedSettings).toEqual(['margins'])
    expect(newest.restoredFrom).toBeNull()
    await context.close()
  })

  test('every control has a visible label and a name, and is reached by Tab (AC-8.3)', async ({ browser }) => {
    const context = await contextFor(browser, people.admin)
    const page = await context.newPage()
    await openConfigurator(page, 'welld_ch')

    // Give each visible, enabled control of the form an index, so the walk can say which ones it met.
    const form = page.getByTestId('letterheads-form')
    const controls = form.locator('input:not([type="hidden"]), select, textarea, button, summary')
    const total = await controls.count()
    expect(total).toBeGreaterThan(40) // margins, fonts, look, two zones of lines, logo, background, variants...
    const indexed = await controls.evaluateAll((elements) => {
      const out: { index: number; tag: string; type: string; label: string; name: string }[] = []
      elements.forEach((element, index) => {
        const el = element as HTMLInputElement
        const style = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        if (style.visibility === 'hidden' || style.display === 'none' || rect.width === 0 || rect.height === 0) return
        if (el.disabled) return
        // The file input is the picker's own (visually hidden) part: the person's control is its "Choose file" button.
        if (el.type === 'file') return
        el.setAttribute('data-e2e-index', String(index))
        const labelled = Array.from(el.labels ?? [])
          .map((l) => (l as HTMLElement).innerText.trim())
          .join(' ')
        const byId = (el.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText.trim() ?? '')
          .join(' ')
          .trim()
        out.push({
          index,
          tag: el.tagName.toLowerCase(),
          type: el.type ?? '',
          label: labelled || byId,
          name: (el.getAttribute('aria-label') ?? '') || labelled || byId || el.innerText.trim(),
        })
      })
      return out
    })
    expect(indexed.length).toBeGreaterThan(40)

    // A visible label for every field (the label element, or the text it is labelled by); a name for every control.
    const unlabelled = indexed.filter((c) => c.tag !== 'button' && c.tag !== 'summary' && c.label === '')
    expect(unlabelled, `fields without a visible label: ${JSON.stringify(unlabelled)}`).toEqual([])
    const unnamed = indexed.filter((c) => c.name === '')
    expect(unnamed, `controls without a name: ${JSON.stringify(unnamed)}`).toEqual([])

    // Walk the page with Tab and record every indexed control that takes the focus. (A radio group is one stop: its
    // arrow keys move inside it, so a radio that is not the checked one is met by arrow, not by Tab, and is not counted.)
    const reached = new Set<number>()
    for (let press = 0; press < indexed.length + 80; press += 1) {
      await page.keyboard.press('Tab')
      const index = await page.evaluate(() => document.activeElement?.getAttribute('data-e2e-index') ?? null)
      if (index !== null) reached.add(Number(index))
    }
    const radios = new Set(indexed.filter((c) => c.type === 'radio').map((c) => c.index))
    const unreached = indexed.filter((c) => !reached.has(c.index) && !radios.has(c.index))
    expect(unreached, `controls Tab never reached: ${JSON.stringify(unreached)}`).toEqual([])
    await context.close()
  })

  test('a refused save names each refused value next to its control and puts the focus on the first one (AC-8.3)', async ({
    browser,
  }) => {
    const before = (await activeVersion(people.admin, 'welld_ch'))!
    const topBefore = await topOf('welld_ch')

    const context = await contextFor(browser, people.admin)
    const page = await context.newPage()
    const calls = recordPreviewCalls(page)
    await openConfigurator(page, 'welld_ch')
    const pagesBefore = await pageImages(page).count()

    // Two refused values, the later one typed first: a margin out of its bounds, and a footer text with a name that is not
    // a placeholder. Page order puts the margin first, whatever the order they were typed in.
    await tabTo(page, footerLeftLine1Italian(page))
    await typeIntoFocused(page, '{nope}')
    await tabTo(page, marginInput(page, 'Top'), { reverse: true })
    await typeIntoFocused(page, '500')

    // The preview is the service's too: it refuses the same values, says so in a polite note, keeps the last valid pages,
    // moves no focus and does not block the form (design S4: no summary and nothing assertive while typing).
    await expect(page.getByTestId('letterheads-preview-refused')).toContainText('The preview shows the last valid form')
    await expect(page.getByText('2 values are refused')).toBeVisible()
    expect(await pageImages(page).count()).toBe(pagesBefore)
    await expect(marginInput(page, 'Top')).toBeFocused()
    await expect(page.getByTestId('letterheads-summary')).toHaveCount(0)
    const refusedPreview = calls.filter((c) => c.config.margins.top === 500)
    expect(refusedPreview.length).toBeGreaterThan(0)
    expect((await refusedPreview.at(-1)!.response).status).toBe(422)

    // Each value is refused next to its own control: invalid, and described by a sentence that names it.
    await expect(marginInput(page, 'Top')).toHaveAttribute('aria-invalid', 'true')
    await expect(marginInput(page, 'Top')).toHaveAccessibleDescription(/^Top margin: use a number between 5 and 100 mm\./i)
    await expect(footerLeftLine1Italian(page)).toHaveAttribute('aria-invalid', 'true')
    await expect(footerLeftLine1Italian(page)).toHaveAccessibleDescription(/Footer.*left zone.*line 1.*Italian text.*\{nope\}.*not a placeholder/i)

    // Save: refused, nothing written. Move the focus away first so the move to the first refused value is the save's.
    await tabTo(page, saveButton(page))
    await expect(saveButton(page)).toBeFocused()
    await page.keyboard.press('Enter')

    const summary = page.getByTestId('letterheads-summary')
    await expect(summary).toBeVisible()
    await expect(summary).toHaveAttribute('role', 'alert')
    await expect(summary).toContainText('Nothing was saved: 2 values were refused')
    await expect(marginInput(page, 'Top')).toBeFocused()
    expect(await activeVersion(people.admin, 'welld_ch')).toBe(before)

    // The summary is a second way in: its second item names the footer text, and Enter on it focuses that control.
    const items = page.getByTestId('letterheads-summary-item')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('Top margin')
    await expect(items.nth(1)).toContainText(/footer, left zone, line 1, Italian text/i)
    await tabTo(page, items.nth(1), { reverse: true })
    await page.keyboard.press('Enter')
    await expect(footerLeftLine1Italian(page)).toBeFocused()

    // Correct both and save: a different valid margin and the original footer text. Saved as the next version.
    const good = otherMargin(topBefore)
    await typeIntoFocused(page, '{legal_name}')
    await tabTo(page, marginInput(page, 'Top'), { reverse: true })
    await typeIntoFocused(page, String(good))
    await expect(summary).toHaveCount(0)
    await expect(marginInput(page, 'Top')).not.toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('letterheads-preview-refused')).toHaveCount(0)
    await tabTo(page, saveButton(page))
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('letterheads-saved')).toContainText(`Version ${before + 1} saved`)
    expect(await topOf('welld_ch')).toBe(good)
    await context.close()
  })

  test('leaving with an unsaved change asks first; keeping the edit and discarding it both work (AC-8.8)', async ({ browser }) => {
    const topSaved = await topOf('welld_ch')
    const edited = otherMargin(topSaved)

    const context = await contextFor(browser, people.admin)
    const page = await context.newPage()
    await openConfigurator(page, 'welld_ch')
    await tabTo(page, marginInput(page, 'Top'))
    await typeIntoFocused(page, String(edited))
    await expect(page.getByText('Unsaved changes')).toBeVisible()

    // The other entity's tab: a dialog first, with the safe answer focused.
    await page.getByRole('tab', { name: ENTITY_NAME.welld_it }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Leave without saving?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('You have unsaved changes to the letterhead of wellD CH. If you continue, they are lost.')
    await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused()

    // Keep editing (Enter on the default): still on wellD CH, with the edit.
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('tab', { name: ENTITY_NAME.welld_ch })).toHaveAttribute('aria-selected', 'true')
    await expect(marginInput(page, 'Top')).toHaveValue(String(edited))

    // Switch and discard: wellD IT is shown, and wellD CH, opened again, holds the saved value, not the edit.
    await page.getByRole('tab', { name: ENTITY_NAME.welld_it }).click()
    await page.getByRole('alertdialog', { name: 'Leave without saving?' }).getByRole('button', { name: 'Switch and discard' }).click()
    await expect(page.getByRole('tab', { name: ENTITY_NAME.welld_it })).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/entity=welld_it/)
    await expect(page.getByRole('heading', { name: ENTITY_NAME.welld_it, level: 2 })).toBeVisible()
    await page.getByRole('tab', { name: ENTITY_NAME.welld_ch }).click()
    await expect(page.getByRole('heading', { name: ENTITY_NAME.welld_ch, level: 2 })).toBeVisible()
    await expect(marginInput(page, 'Top')).toHaveValue(String(topSaved))
    await expect(page.getByText('No unsaved changes')).toBeVisible()
    await context.close()
  })

  test('the screen is in the person\'s language: Italian when the browser asks for it (AC-8.8)', async ({ browser }) => {
    const context = await contextFor(browser, people.admin, 'it-IT')
    const page = await context.newPage()
    const calls = recordPreviewCalls(page)
    await page.goto('/letterheads?entity=welld_ch')
    await expect(page.getByRole('heading', { name: 'Carte intestate', level: 1 })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('tab', { name: 'Impostazioni' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Cronologia' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Salva come versione \d+$/ })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Margini (mm)' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Anteprima del documento di esempio' })).toBeVisible()
    // The sample document follows the person's language too.
    await expect.poll(() => calls.length).toBeGreaterThan(0)
    expect(calls[0]!.language).toBe('it')
    await context.close()
  })
})

// ─── specs/20261117-legal-entities T43: the preview shows the REGISTRY's company details (AC-5.4) ─────────────────────

/** The second line of the default page's footer, left zone (`{address}` in the default configuration), in one language. */
const footerLeftLine2 = (page: Page, language: 'Italian' | 'English') =>
  page
    .getByRole('region', { name: 'Default page' })
    .getByRole('group', { name: 'Footer', exact: true })
    .getByRole('group', { name: 'Left zone' })
    .getByRole('group', { name: 'Line 2' })
    .getByRole('textbox', { name: `Text, ${language}` })

const MARK = /⟦[^⟧]+⟧/

test.describe('specs/20261117-legal-entities T43: the configurator preview shows the registry\'s details (AC-5.4, FU-9)', () => {
  const run = Date.now().toString().slice(-6)
  let optional: OptionalDetails | null = null

  test.beforeAll(async () => {
    optional = await readOptionalDetails(people.admin, 'welld_ch')
  })

  // The IBAN and the contacts lines this journey sets are given back (the Legal entities journeys assume none is there to find).
  test.afterAll(async () => {
    if (optional !== null) await restoreOptionalDetails(people.admin, 'welld_ch', optional)
  })

  const details = (contacts: { it: string; en: string }): LegalDetails => ({
    legalName: `wellD SA Preview ${run}`,
    address: { it: [`Via Anteprima ${run}`, '6900 Lugano'], en: [`Preview Street ${run}`, '6900 Lugano (CH)'] },
    vatNumber: `CHE-${run.slice(0, 3)}.${run.slice(3)}.001 MWST`,
    iban: ibanWithCheckDigits('CH', `00762${'0201164'}${run.slice(0, 5)}`),
    contacts,
  })

  async function saveRegistry(next: LegalDetails): Promise<void> {
    const read = await getRegistryEntity(people.admin, 'welld_ch')
    const saved = await authCall(people.admin, 'POST', '/legal-entities/welld_ch/versions', { baseVersion: read.version, details: next })
    expect([200, 201], JSON.stringify(saved.body).slice(0, 300)).toContain(saved.status)
  }

  const isPreviewCall = (response: { url: () => string; request: () => { method: () => string } }): boolean =>
    response.request().method() === 'POST' && /\/v1\/letterheads\/[a-z_]+\/preview/.test(response.url())

  /** Chooses a preview language and waits for the pages the service draws for it. */
  async function chooseLanguage(page: Page, language: 'Italian' | 'English'): Promise<void> {
    if (await page.getByRole('radio', { name: language }).isChecked()) return
    const drawn = page.waitForResponse(isPreviewCall, { timeout: 20_000 })
    await page.getByRole('radio', { name: language }).check()
    await drawn
    await expect(previewRegion(page)).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 })
  }

  /**
   * Draws the preview in `language` again and again (away and back: two new requests each time) until its text holds `expected`:
   * the service reads the registry within AC-3.3's 60 s of a save. Returns the text, white space collapsed.
   */
  async function waitForPreview(page: Page, language: 'Italian' | 'English', expected: RegExp | string): Promise<string> {
    const other = language === 'Italian' ? 'English' : 'Italian'
    let text = ''
    await expect
      .poll(
        async () => {
          await chooseLanguage(page, other)
          await chooseLanguage(page, language)
          text = (await previewText(page)).replace(/\s+/g, ' ')
          return typeof expected === 'string' ? text.includes(expected) : expected.test(text)
        },
        { message: `the preview shows ${String(expected)}`, timeout: 90_000, intervals: [2_000] },
      )
      .toBe(true)
    return text
  }

  test('the pages hold the saved name, the address of the preview language and the grouped IBAN; an empty contacts line shows its label in the missing look, and filled it does not (AC-5.4)', async ({
    browser,
  }) => {
    test.setTimeout(240_000)
    const empty = details({ it: '', en: '' })
    await saveRegistry(empty)

    const context = await contextFor(browser, people.admin)
    const page = await context.newPage()
    await openConfigurator(page, 'welld_ch')

    // The default footer, untouched: the name and the address, in the preview language (English first, then Italian).
    const english = await waitForPreview(page, 'English', empty.legalName)
    expect(english).toContain(empty.address.en.join(', '))
    expect(english).not.toContain(empty.address.it[0]!)
    const italian = await waitForPreview(page, 'Italian', empty.address.it.join(', '))
    expect(italian).toContain(empty.legalName)
    expect(italian).not.toContain(empty.address.en[0]!)

    // Unsaved edit 1: the footer's second line asks for the IBAN. It prints in groups of four, never in its electronic form.
    const setLine2 = async (text: string): Promise<void> => {
      for (const language of ['Italian', 'English'] as const) {
        await tabTo(page, footerLeftLine2(page, language))
        await typeIntoFocused(page, text)
      }
    }
    await setLine2('{iban}')
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    const iban = await waitForPreview(page, 'English', groupIban(empty.iban))
    expect(iban).not.toContain(empty.iban)
    expect(iban).not.toMatch(MARK)

    // Unsaved edit 2: the contacts line, which has no value. Its label is drawn in the missing look (the label, in the preview's
    // language), nothing else; the text alternative of the page marks it with ⟦ ⟧.
    await setLine2('{contacts}')
    const englishMark = (await waitForPreview(page, 'English', MARK)).match(MARK)![0]
    const italianMark = (await waitForPreview(page, 'Italian', MARK)).match(MARK)![0]
    expect(englishMark, 'the label follows the preview language').not.toBe(italianMark)

    // The same value filled in the registry: the line prints it, and the label is gone.
    const filled = details({ it: `Tel. +41 91 ${run}`, en: `Phone +41 91 ${run}` })
    await saveRegistry(filled)
    const printed = await waitForPreview(page, 'English', filled.contacts.en)
    expect(printed).not.toMatch(MARK)
    const printedIt = await waitForPreview(page, 'Italian', filled.contacts.it)
    expect(printedIt).not.toMatch(MARK)
    // Nothing of this was saved in the letterhead: the edit is still unsaved, the active version is the one it started from.
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    await context.close()
  })

  test('the source line links to Legal entities for a manager and names who keeps them for anyone else (AC-5.4, AC-6.1)', async ({ browser }) => {
    const manager = await contextFor(browser, people.admin)
    const managerPage = await manager.newPage()
    await openConfigurator(managerPage, 'welld_ch')
    await expect(managerPage.getByTestId('letterheads-preview-source-link')).toHaveAttribute('href', '/admin/legal-entities?entity=welld_ch')
    await manager.close()

    const reader = await contextFor(browser, people.viewer)
    const readerPage = await reader.newPage()
    await readerPage.goto('/letterheads?entity=welld_ch')
    await expect(readerPage.getByTestId('letterheads-preview-source')).toContainText('An administrator keeps them in Legal entities.', { timeout: 30_000 })
    await expect(readerPage.getByTestId('letterheads-preview-source-link')).toHaveCount(0)
    await reader.close()
  })

  test('a missing label that wraps onto a second line keeps its brackets in English too (AC-5.4)', async ({ browser }) => {
    // KNOWN DEFECT D-T43-1 (letterhead-api engine, `output/text.rs` `page_text_marking`): with the footer's second line
    // `{iban} {contacts}`, an empty contacts line and the preview in English, the page text reads `... 5295 7 Contacts` / `line` with
    // NO ⟦ ⟧ (Italian, `⟦Riga` / `contatti⟧`, and a line with the label alone keep them). The drawing is right; the text alternative is not.
    test.setTimeout(240_000)
    await saveRegistry(details({ it: '', en: '' }))
    const context = await contextFor(browser, people.admin)
    const page = await context.newPage()
    await openConfigurator(page, 'welld_ch')
    for (const language of ['Italian', 'English'] as const) {
      await tabTo(page, footerLeftLine2(page, language))
      await typeIntoFocused(page, '{iban} {contacts}')
    }
    await expect(page.getByText('Unsaved changes')).toBeVisible()
    const words = await waitForPreview(page, 'English', /Contacts( line)?/)
    expect(words, 'the English label, in brackets').toContain('⟦Contacts line⟧')
    await context.close()
  })
})
