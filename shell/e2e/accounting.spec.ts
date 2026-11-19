/**
 * e2e of the Accounting tool: the manager's journeys (specs/20261119-accounting, T41; plan § Local development and e2e;
 * design § Accessibility layer 2).
 *
 * The REAL stack, nothing stubbed: auth (ENABLE_TEST_AUTH), accounting-api and accounting-ui behind the shell, a signed-in
 * administrator whose grants were written through auth's admin API (helpers/accountingFixtures.ts `setUpAccountingPeople`).
 * accounting-api runs with `ACCOUNTING_FX_SOURCE=off` (header of playwright.config.ts, item 11): no rate comes from the federal
 * source, a month's rate is typed by hand. The one place a response is altered is the failed-fetch banner's axe pass (a failed
 * fetch cannot be made to happen on that stack): `page.route` rewrites `lastFetch` of one GET, nothing else.
 *
 *   AC-1.1  an administrator opens Accounting from the menu, adds a ledger account and a VAT code, and each is listed, active, and
 *           read back from the API
 *   AC-1.3  adding the number of an existing account is refused with a message naming it, in the dialog
 *   AC-1.9  a deactivated account is reactivated and is listed active again with the same number and name
 *   AC-2.4  a manager corrects a month's rate: the cell shows the new value with the origin "Corrected"
 *   AC-8.2  the switcher of a person with two entities changes the list, every title names its entity, and the address follows
 *   AC-8.3  WellD Italia, with nothing entered, shows "Nothing entered yet" (a state, not an error) in both lists, and no source
 *           for its rates (AC-2.11)
 *   AC-8.4  the whole add path with the keyboard alone; a refused value is announced and takes the focus; every word exists in
 *           Italian; `axeViolations` is 0 in light and dark, English and Italian, on the lists, the add dialog with a refused field,
 *           the rates with a Missing cell and the failed-fetch banner, and WellD Italia's empty and no-source states
 *
 * Reader, CH-only manager, person without a grant and the direct-API refusals are accounting-access.spec.ts.
 *
 * State is shared and append-only (a number or code stays taken after it is deactivated): every journey writes keys of its own
 * (`uniqueAccountNumber`, `uniqueVatCode`) and never assumes what else is listed. The rate journey corrects USD, so the EUR months
 * Refund's pending-rate journey needs are left alone; the month it corrects is used up (`unusedPastMonth`), one per run.
 * WellD Italia is assumed to hold no entry (the seed is WellD CH's, and no journey writes to Italia).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { applySessionCookie } from './helpers/adminSession'
import {
  accountingCall,
  createLedgerAccount,
  setUpAccountingPeople,
  uniqueAccountNumber,
  uniqueVatCode,
  unusedPastMonth,
  type AccountingPeople,
  type LedgerAccount,
  type MonthRow,
  type SeededSession,
  type VatCode,
} from './helpers/accountingFixtures'
import { tabTo, typeIntoFocused } from './fixtures/letterheads'
import { axeViolations } from './helpers/meetingsFixtures'

test.describe.configure({ mode: 'serial' })

const RUN = Date.now().toString(36)

let people: AccountingPeople

test.beforeAll(async () => {
  test.setTimeout(180_000)
  people = await setUpAccountingPeople()
})

const toolNav = (page: Page) => page.getByRole('navigation', { name: 'Tool navigation' })

/** A browser context signed in as `session`, in the language asked (Accounting follows the browser's). */
async function signedIn(
  browser: Browser,
  session: SeededSession,
  locale = 'en-US',
  colorScheme: 'light' | 'dark' = 'light',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale, viewport: { width: 1440, height: 1000 } })
  await applySessionCookie(context, session)
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme })
  return { context, page }
}

/** Zero axe violations under `include`, once transitions have ended (a half-faded control would be measured mid-fade). */
async function expectNoAxeViolations(page: Page, label: string, include = 'main'): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))))
  const violations = await axeViolations(page, include)
  expect(
    violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.nodes
          .map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)} ${String((n as { failureSummary?: string }).failureSummary ?? '').replace(/\s+/g, ' ')}`)
          .join(' | ')}`,
    ),
    `axe violations on ${label}`,
  ).toEqual([])
}

const TOKEN = (): string => people.admin.token

async function listAccounts(entity: string): Promise<LedgerAccount[]> {
  const read = await accountingCall<{ items: LedgerAccount[] }>(TOKEN(), 'GET', `/v1/entities/${entity}/ledger-accounts`)
  expect(read.status).toBe(200)
  return read.body.items
}

async function listVatCodes(entity: string): Promise<VatCode[]> {
  const read = await accountingCall<{ items: VatCode[] }>(TOKEN(), 'GET', `/v1/entities/${entity}/vat-codes`)
  expect(read.status).toBe(200)
  return read.body.items
}

/** Opens a view of one entity straight by address (the shell mounts the remote under `/accounting/$`). */
async function openView(page: Page, view: 'ledger-accounts' | 'vat-codes' | 'exchange-rates', entity: 'welld_ch' | 'welld_it'): Promise<void> {
  await page.goto(`/accounting/${view}?entity=${entity}`)
  await expect(page.getByTestId('accounting-shell')).toBeVisible({ timeout: 30_000 })
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261119-accounting T41: the manager journey (AC-1.1, 1.3, 1.9, 2.4, 8.4)', () => {
  test('an administrator opens Accounting from the menu, adds an account with the keyboard alone, is refused a duplicate, deactivates and reactivates it (AC-1.1, AC-1.3, AC-1.9, AC-8.4)', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    const number = uniqueAccountNumber()
    const name = `E2E keyboard account ${RUN}`
    const { context, page } = await signedIn(browser, people.admin)

    // From the menu: a real link of the tool navigation, to /accounting, which opens on the ledger accounts.
    await page.goto('/')
    await expect(toolNav(page)).toBeVisible({ timeout: 30_000 })
    await toolNav(page).getByRole('link', { name: 'Accounting', exact: true }).click({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/accounting\/ledger-accounts/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Accounting', level: 1 })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('navigation', { name: 'Accounting sections' })).toBeVisible()

    await openView(page, 'ledger-accounts', 'welld_ch')
    await expect(page.getByRole('heading', { name: 'Ledger accounts — WellD CH' })).toBeVisible({ timeout: 30_000 })
    const add = page.getByTestId('accounting-ledger-add')
    await expect(add).toBeVisible({ timeout: 30_000 })

    // Keyboard only: Tab to the button, Enter opens the dialog.
    await tabTo(page, add)
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Add ledger account — WellD CH' })
    await expect(dialog).toBeVisible()

    // A refused value is announced next to its field and takes the focus (AC-8.4).
    const numberInput = page.getByTestId('accounting-ledger-number')
    const nameInput = page.getByTestId('accounting-ledger-name')
    await tabTo(page, numberInput)
    await typeIntoFocused(page, 'abc')
    await tabTo(page, nameInput)
    await typeIntoFocused(page, name)
    await page.keyboard.press('Enter')
    const numberError = page.getByTestId('accounting-ledger-number-error')
    await expect(numberError).toHaveText('Use digits separated by single dots, such as 5905 or 2620.1.')
    await expect(page.getByRole('alert').filter({ has: numberError })).toBeVisible()
    await expect(numberInput).toBeFocused()
    await expectNoAxeViolations(page, 'the add dialog with a refused number', '[role="dialog"]')

    // The valid number, then the name already typed: Enter adds it. The dialog closes and the focus is back on Add.
    await typeIntoFocused(page, number)
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0, { timeout: 15_000 })
    await expect(add).toBeFocused()
    await expect(page.getByTestId('accounting-saved')).toContainText(`Account ${number} added`)
    const row = page.getByTestId(`accounting-ledger-row-${number}`)
    await expect(row).toContainText(name)
    await expect(row).toContainText('Active')
    // And the API says the same (the entity's list, which is what consumers read an option from).
    expect((await listAccounts('welld_ch')).find((item) => item.number === number)).toEqual({ number, name, active: true })

    // The same number again: refused in the dialog, naming it (AC-1.3).
    await add.click()
    await page.getByTestId('accounting-ledger-number').fill(number)
    await page.getByTestId('accounting-ledger-name').fill('Another name')
    await page.getByTestId('accounting-ledger-dialog-submit').click()
    await expect(page.getByTestId('accounting-ledger-number-error')).toHaveText(`Account ${number} already exists in WellD CH.`)
    await page.getByTestId('accounting-ledger-dialog-cancel').click()
    await expect(dialog).toHaveCount(0)

    // Deactivate after a confirmation, then reactivate at once (AC-1.9): same number and name.
    await page.getByTestId(`accounting-ledger-deactivate-${number}`).click()
    await expect(page.getByRole('alertdialog', { name: `Deactivate account ${number}?` })).toBeVisible()
    await page.getByTestId('accounting-ledger-deactivate-dialog-confirm').click()
    await expect(page.getByTestId('accounting-saved')).toContainText(`Account ${number} deactivated`)
    await expect(row).toContainText('Inactive')
    await page.getByTestId(`accounting-ledger-reactivate-${number}`).click()
    await expect(page.getByTestId('accounting-saved')).toContainText(`Account ${number} reactivated`)
    await expect(row).toContainText('Active')
    await expect(row).toContainText(name)
    expect((await listAccounts('welld_ch')).find((item) => item.number === number)).toEqual({ number, name, active: true })
    await context.close()
  })

  test('an administrator adds a VAT code with the rate fixed at creation (AC-1.1)', async ({ browser }) => {
    test.setTimeout(120_000)
    const code = uniqueVatCode()
    const label = `E2E VAT ${RUN}`
    const { context, page } = await signedIn(browser, people.admin)
    await openView(page, 'vat-codes', 'welld_ch')
    await expect(page.getByRole('heading', { name: 'VAT codes — WellD CH' })).toBeVisible({ timeout: 30_000 })

    await page.getByTestId('accounting-vat-add').click()
    await expect(page.getByRole('dialog', { name: 'Add VAT code — WellD CH' })).toBeVisible()
    await page.getByTestId('accounting-vat-code').fill(code.toLowerCase())
    await page.getByTestId('accounting-vat-label').fill(label)
    await page.getByTestId('accounting-vat-rate').fill('8.1')
    await page.getByTestId('accounting-vat-dialog-submit').click()

    // Saved in capitals, listed active with the rate it was given.
    await expect(page.getByTestId('accounting-saved')).toContainText(`VAT code ${code} added`, { timeout: 15_000 })
    const row = page.getByTestId(`accounting-vat-row-${code}`)
    await expect(row).toContainText(label)
    await expect(row).toContainText('8.1')
    await expect(row).toContainText('Active')
    expect((await listVatCodes('welld_ch')).find((item) => item.code === code)).toMatchObject({
      code,
      label,
      ratePercent: '8.1',
      rateBasisPoints: 810,
      active: true,
    })

    // Deactivate and reactivate keep code, label and rate (AC-1.10).
    await page.getByTestId(`accounting-vat-deactivate-${code}`).click()
    await page.getByTestId('accounting-vat-deactivate-dialog-confirm').click()
    await expect(page.getByTestId('accounting-saved')).toContainText(`VAT code ${code} deactivated`)
    await page.getByTestId(`accounting-vat-reactivate-${code}`).click()
    await expect(page.getByTestId('accounting-saved')).toContainText(`VAT code ${code} reactivated`)
    await expect(row).toContainText('8.1')
    await context.close()
  })

  test('a manager corrects a month\'s rate and sees the origin badge (AC-2.4)', async ({ browser }) => {
    test.setTimeout(120_000)
    // USD, so the EUR months the pending-rate journey of Refund needs are not used up; a month with no USD rate, newest first.
    const month = await unusedPastMonth(TOKEN(), { currency: 'USD' })
    const { context, page } = await signedIn(browser, people.admin)
    await openView(page, 'exchange-rates', 'welld_ch')
    await expect(page.getByRole('heading', { name: 'Exchange rates — WellD CH' })).toBeVisible({ timeout: 30_000 })

    const cell = page.getByTestId(`accounting-fx-cell-${month}-USD`)
    await expect(cell).toBeVisible({ timeout: 30_000 })
    await expect(cell).toContainText('Missing')

    await page.getByTestId(`accounting-fx-correct-${month}-USD`).click()
    await expect(page.getByRole('dialog', { name: /^Correct rate — USD · / })).toBeVisible()
    await page.getByTestId('accounting-fx-correction-value').fill('0.8800')
    await page.getByTestId('accounting-fx-correction-submit').click()

    await expect(page.getByTestId('accounting-saved')).toContainText('USD rate for', { timeout: 15_000 })
    await expect(cell).toContainText('Corrected')
    await expect(cell).toContainText(/0\.88/)
    // The API holds it as the rate in effect.
    const read = await accountingCall<{ months: MonthRow[] }>(TOKEN(), 'GET', '/v1/entities/welld_ch/exchange-rates')
    const row = read.body.months.find((item) => item.month === month)
    expect(row?.rates['USD']).toMatchObject({ status: 'corrected', rate: expect.stringMatching(/^0\.88/) })
    await context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261119-accounting T41: two entities and WellD Italia (AC-8.2, 8.3, 2.11)', () => {
  test('the switcher changes the entity of every view, the address follows, and WellD Italia shows empty states, not errors (AC-8.2, AC-8.3)', async ({
    browser,
  }) => {
    test.setTimeout(150_000)
    const { context, page } = await signedIn(browser, people.admin)
    await openView(page, 'ledger-accounts', 'welld_ch')
    const select = page.getByTestId('accounting-entity-select')
    await expect(select).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Ledger accounts — WellD CH' })).toBeVisible()

    await select.selectOption('welld_it')
    await expect(page).toHaveURL(/entity=welld_it/)
    await expect(page.getByRole('status').filter({ hasText: 'Showing WellD Italia' })).toBeAttached()
    await expect(page.getByRole('heading', { name: 'Ledger accounts — WellD Italia' })).toBeVisible({ timeout: 15_000 })
    // Nothing entered: a state with the entity's name, no error, and the write control is still offered to a manager.
    await expect(page.getByTestId('accounting-empty')).toContainText('Nothing entered yet for WellD Italia', { timeout: 15_000 })
    await expect(page.getByTestId('accounting-load-error')).toHaveCount(0)
    await expect(page.getByTestId('accounting-ledger-add')).toBeVisible()
    await expectNoAxeViolations(page, 'WellD Italia, ledger accounts (empty)')

    // The tabs carry the entity.
    await page.getByRole('navigation', { name: 'Accounting sections' }).getByRole('link', { name: 'VAT codes' }).click()
    await expect(page).toHaveURL(/\/accounting\/vat-codes\?.*entity=welld_it/)
    await expect(page.getByRole('heading', { name: 'VAT codes — WellD Italia' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('accounting-empty')).toContainText('Nothing entered yet for WellD Italia')
    await expectNoAxeViolations(page, 'WellD Italia, VAT codes (empty)')

    // Rates: WellD Italia has no official source (AC-2.11): not "nothing entered", and nothing to fetch or correct.
    await page.getByRole('navigation', { name: 'Accounting sections' }).getByRole('link', { name: 'Exchange rates' }).click()
    await expect(page.getByRole('heading', { name: 'Exchange rates — WellD Italia' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('accounting-fx-no-source')).toContainText('No official source for WellD Italia yet')
    await expect(page.getByTestId('accounting-fx-fetch-now')).toHaveCount(0)
    await expectNoAxeViolations(page, 'WellD Italia, exchange rates (no source)')

    // Back to WellD CH: every title names it again.
    await page.getByTestId('accounting-entity-select').selectOption('welld_ch')
    await expect(page).toHaveURL(/entity=welld_ch/)
    await expect(page.getByRole('heading', { name: 'Exchange rates — WellD CH' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('accounting-fx-no-source')).toHaveCount(0)
    await context.close()
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('specs/20261119-accounting T41: words and axe, light and dark, English and Italian (AC-8.4)', () => {
  const COMBOS = [
    { locale: 'en-US', scheme: 'light' },
    { locale: 'en-US', scheme: 'dark' },
    { locale: 'it-IT', scheme: 'light' },
    { locale: 'it-IT', scheme: 'dark' },
  ] as const

  for (const { locale, scheme } of COMBOS) {
    test(`the three views, the add dialog with a refused field and the failed-fetch banner: ${locale}, ${scheme} (AC-8.4)`, async ({
      browser,
    }) => {
      test.setTimeout(180_000)
      const it = locale === 'it-IT'
      const words = it
        ? {
            title: 'Contabilità',
            ledger: 'Conti contabili — WellD CH',
            vat: 'Codici IVA — WellD CH',
            fx: 'Tassi di cambio — WellD CH',
            add: 'Aggiungi conto',
            dialog: 'Aggiungi conto contabile — WellD CH',
            numberError: 'Usare cifre separate da un solo punto, come 5905 o 2620.1.',
            failed: "L’ultimo recupero non è riuscito",
            missing: 'Mancante',
          }
        : {
            title: 'Accounting',
            ledger: 'Ledger accounts — WellD CH',
            vat: 'VAT codes — WellD CH',
            fx: 'Exchange rates — WellD CH',
            add: 'Add account',
            dialog: 'Add ledger account — WellD CH',
            numberError: 'Use digits separated by single dots, such as 5905 or 2620.1.',
            failed: 'The last fetch failed',
            missing: 'Missing',
          }
      // A row to look at in each list, whatever the seed held.
      const number = uniqueAccountNumber()
      await createLedgerAccount(TOKEN(), { number, name: `E2E axe account ${RUN}` })

      const { context, page } = await signedIn(browser, people.admin, locale, scheme)
      await openView(page, 'ledger-accounts', 'welld_ch')
      await expect(page.getByRole('heading', { name: words.title, level: 1 })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole('heading', { name: words.ledger })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId(`accounting-ledger-row-${number}`)).toBeVisible()
      await expect(page.getByTestId('accounting-ledger-add')).toHaveText(words.add)
      await expectNoAxeViolations(page, `ledger accounts, manager, ${locale} ${scheme}`)

      // The add dialog with a refused field.
      await page.getByTestId('accounting-ledger-add').click()
      await expect(page.getByRole('dialog', { name: words.dialog })).toBeVisible()
      await page.getByTestId('accounting-ledger-number').fill('abc')
      await page.getByTestId('accounting-ledger-name').fill('x')
      await page.getByTestId('accounting-ledger-dialog-submit').click()
      await expect(page.getByTestId('accounting-ledger-number-error')).toHaveText(words.numberError)
      await expect(page.getByTestId('accounting-ledger-number')).toBeFocused()
      await expectNoAxeViolations(page, `add dialog with a refused number, ${locale} ${scheme}`, '[role="dialog"]')
      await page.getByTestId('accounting-ledger-dialog-cancel').click()

      await openView(page, 'vat-codes', 'welld_ch')
      await expect(page.getByRole('heading', { name: words.vat })).toBeVisible({ timeout: 30_000 })
      await expectNoAxeViolations(page, `VAT codes, manager, ${locale} ${scheme}`)

      // The failed-fetch banner cannot happen on a stack whose source is off: the one list answer says it did.
      await page.route(/\/v1\/entities\/welld_ch\/exchange-rates(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        const response = await route.fetch()
        const body = (await response.json()) as { months: MonthRow[]; lastFetch: unknown }
        return route.fulfill({
          response,
          json: { ...body, lastFetch: { at: new Date().toISOString(), outcome: 'failed', errorCode: 'timeout', month: body.months[0]?.month ?? '2026-01' } },
        })
      })
      await openView(page, 'exchange-rates', 'welld_ch')
      await expect(page.getByRole('heading', { name: words.fx })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('accounting-fx-failed')).toContainText(words.failed, { timeout: 15_000 })
      // A month with no rate shows its Missing cell (the newest EUR month without one, or any missing cell).
      await expect(page.getByTestId('accounting-fx-table')).toContainText(words.missing)
      await expectNoAxeViolations(page, `exchange rates with a Missing cell and the failed-fetch banner, ${locale} ${scheme}`)
      await context.close()
    })
  }
})
