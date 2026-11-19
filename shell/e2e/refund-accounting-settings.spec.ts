/**
 * Refund accounting settings journey (specs/20261118-refund-accounting-export, T31, adapted by specs/20261119-accounting, T42).
 * Drives the REAL assembled shell host + refund-ui remote (ADR 20260709-suite-frontend-module-federation) against the REAL
 * refund-api, accounting-api and auth services, no mocking, like this suite's other refund journeys (refund-settings.spec.ts,
 * mileage-rate.spec.ts). The ledger accounts, VAT codes and exchange rates are Accounting's now: Refund's Settings keeps only the
 * defaults and the designation, which choose AMONG Accounting's entries by number and code.
 *
 * Journey (a Refund administrator WITHOUT an Accounting capability: the `refund-admin` role holds `settings:read` and
 * `settings:manage` and nothing of Accounting, AC-3.7):
 *   - the Settings tabs are General and Default classification: no "Accounts and VAT" and no "Exchange rates" view, and the old
 *     `?section=exchange-rates` address shows General (AC-4.6);
 *   - the Default classification view opens with the note that Accounting keeps the entries, without a link for this person
 *     (AC-4.6, UX-17);
 *   - the account and the VAT code (made in Accounting by an administrator, helpers/accountingFixtures.ts) are offered in the
 *     choosers, become the default of an expense type, with its history (AC-4.4), and the VAT code is designated for
 *     foreign-currency lines, with its history (AC-4.4, AC-4.5);
 *   - the account is DEACTIVATED in Accounting: the default shows "Deactivated in Accounting", counts as a default that needs a
 *     new choice, and its dialog starts on "Choose…" (AC-4.5); Accounting is then reactivated;
 *   - Accounting CANNOT BE READ (the one answer of the defaults list says so; a real outage cannot be made on this stack): one
 *     warning banner, Change disabled, History still working (AC-6.9);
 *   - an administrator, who holds Accounting, sees the same note with a link to /accounting (AC-4.6).
 * `axeViolations` is 0 on the Default classification view with a deactivated default and in the unavailable state (design
 * § Accessibility layer 2), in the browser's real contrast.
 *
 * Fixtures and state:
 *   - the accounting release marker comes from global-setup.ts: without it nothing here would fail, but every journey that
 *     approves a request would (409 `accounting_release_pending`);
 *   - the account and the VAT code are new on every run (random number and code: both stay taken once added, AC-1.3);
 *   - what is in effect afterwards is what was before: the default of the expense type and the foreign-currency VAT code are put
 *     back through the API in `finally` (their history rows stay, they are append-only), and the deactivated account is
 *     reactivated.
 *
 * Needs the stack in playwright.config.ts's header (auth with ENABLE_TEST_AUTH=true, refund-api on :8082, accounting-api on :8089).
 *
 * This file is the e2e level of AC-3.7, AC-4.4, AC-4.5, AC-4.6, AC-6.9 (and AC-1.1/AC-1.9, which moved to accounting.spec.ts).
 */
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie } from './helpers/adminSession'
import { grantRole } from './helpers/inviteFixtures'
import {
  accountingCall,
  createLedgerAccount,
  createVatCode,
  deactivateLedgerAccount,
  reactivateLedgerAccount,
  uniqueAccountNumber,
  uniqueVatCode,
} from './helpers/accountingFixtures'
import { axeViolations } from './helpers/meetingsFixtures'
import { freshToken, setExpenseTypeDefault, setForeignCurrencyVatCode, snapshotAccountingDefaults } from './helpers/refundFixtures'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** The expense type whose default this journey changes (and restores): one no other journey of this suite reads. */
const DEFAULT_TYPE = 'telephone'

/** Picks the option of a select whose text names `text` (the number of an account, the code of a VAT code). */
async function chooseByText(select: Locator, text: string): Promise<void> {
  await expect(select).toBeEnabled({ timeout: 15_000 })
  const option = select.locator('option', { hasText: text })
  await expect(option).toHaveCount(1, { timeout: 15_000 })
  const value = await option.getAttribute('value')
  if (!value) throw new Error(`[refund-accounting-settings] the option for ${text} has no value`)
  await select.selectOption(value)
}

/** Opens Refund's Settings on the Default classification view (a direct address: the view is `?section=defaults`). */
async function openDefaultsView(page: Page): Promise<void> {
  await page.goto('/refund/settings?section=defaults')
  await expect(page.getByTestId('refund-settings-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('refund-settings-view-defaults')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('settings-defaults-table')).toBeVisible({ timeout: 20_000 })
}

/** Zero axe violations in the page's `main`, once transitions have ended. */
async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))))
  const violations = await axeViolations(page, 'main')
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

/** The one answer of the defaults list that says "Accounting cannot be read": every state unchecked, the values as recorded. */
async function answerUnavailable(route: Route): Promise<void> {
  if (route.request().method() !== 'GET') return route.fallback()
  const response = await route.fetch()
  const body = (await response.json()) as {
    accounting: string
    types: Array<{ account: { state: string } | null; vatCode: { state: string } | null }>
    foreignCurrencyVatCode: { state: string } | null
  }
  const unverified = <T extends { state: string } | null>(entry: T): T => (entry === null ? entry : { ...entry, state: 'unverified' })
  return route.fulfill({
    response,
    json: {
      ...body,
      accounting: 'unavailable',
      types: body.types.map((row) => ({ ...row, account: unverified(row.account), vatCode: unverified(row.vatCode) })),
      foreignCurrencyVatCode: unverified(body.foreignCurrencyVatCode),
    },
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/20261119-accounting T42: Refund settings among Accounting entries', () => {
  test('a Refund admin without Accounting sets a default and the designation among Accounting\'s entries, sees no Accounts/VAT or Rates view and the note; a deactivated default asks for a new choice; Accounting unreadable disables Change (AC-3.7/4.4/4.5/4.6/6.9)', async ({
    browser,
  }) => {
    // Two entries, a default, a designation, two histories and four states in one page: well beyond the 30 s default.
    test.setTimeout(240_000)
    const tag = uniqueSuffix()
    const refundAdminEmail = `e2e-acct-settings-refund-admin-${tag}@operai.test`
    const adminEmail = `e2e-acct-settings-admin-${tag}@operai.test`
    const accountNumber = uniqueAccountNumber()
    const accountName = `E2E account ${tag}`
    const vatCode = uniqueVatCode()
    const vatLabel = `E2E VAT ${tag}`

    // The Accounting administrator writes the entries (Accounting's own API: the `admin` role holds both of its capabilities).
    const adminSession = await seedAdminSession(adminEmail, 'E2E Accounting Settings Admin')
    const adminToken = await freshToken(adminSession.cookieHeader)
    await createLedgerAccount(adminToken, { number: accountNumber, name: accountName })
    await createVatCode(adminToken, { code: vatCode, label: vatLabel, ratePercent: '8.1' })

    // The Refund administrator: `refund-admin` holds Refund's settings and none of Accounting (AC-3.7).
    const refundAdminSession = await seedUserSession(refundAdminEmail, 'E2E Refund Settings Admin')
    grantRole(refundAdminEmail, 'refund-admin')
    const refundAdminToken = await freshToken(refundAdminSession.cookieHeader)
    const restoreDefaults = await snapshotAccountingDefaults(refundAdminToken, [DEFAULT_TYPE])

    const refundAdminContext = await browser.newContext()
    await applySessionCookie(refundAdminContext, refundAdminSession)
    const page = await refundAdminContext.newPage()
    const adminContext = await browser.newContext()
    await applySessionCookie(adminContext, adminSession)

    try {
      // ─── AC-4.6: two views only, the old addresses fall back to General, and the note (no link) ───────────────
      await page.goto('/refund/settings')
      await expect(page.getByTestId('refund-settings-page')).toBeVisible({ timeout: 20_000 })
      const tabs = page.getByTestId('refund-settings-tabs')
      await expect(tabs.getByRole('tab', { name: 'General' })).toBeVisible({ timeout: 20_000 })
      await expect(tabs.getByRole('tab', { name: 'Default classification' })).toBeVisible()
      await expect(tabs.getByRole('tab')).toHaveCount(2)
      await expect(tabs.getByRole('tab', { name: 'Accounts and VAT' })).toHaveCount(0)
      await expect(tabs.getByRole('tab', { name: 'Exchange rates' })).toHaveCount(0)
      for (const section of ['exchange-rates', 'accounting']) {
        await page.goto(`/refund/settings?section=${section}`)
        await expect(page.getByTestId('refund-settings-view-general')).toBeVisible({ timeout: 20_000 })
      }

      await openDefaultsView(page)
      const note = page.getByTestId('settings-accounting-link-note')
      await expect(note).toContainText('kept in the Accounting app by accounting managers')
      await expect(page.getByTestId('settings-accounting-link')).toHaveCount(0)
      // no catalog card of Refund's own, and none of the removed management controls
      await expect(page.locator('[data-testid^="settings-accounts-"], [data-testid^="settings-vat-codes-"], [data-testid^="settings-fx-"]')).toHaveCount(0)

      // ─── AC-4.4: Accounting's entries are offered, and the pair becomes the default of one expense type ───────
      await page.getByTestId(`settings-default-change-${DEFAULT_TYPE}`).click()
      await chooseByText(page.getByTestId('default-classification-account'), accountNumber)
      await chooseByText(page.getByTestId('default-classification-vat-code'), vatCode)
      await page.getByTestId('default-classification-submit').click()
      await expect(page.getByTestId('default-classification-submit')).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByTestId('settings-defaults-success')).toContainText('Default saved')
      const defaultRow = page.getByTestId('settings-defaults-table').getByRole('row').filter({ hasText: accountNumber })
      await expect(defaultRow).toContainText(vatCode)
      await expect(defaultRow).toContainText(refundAdminEmail)

      await page.getByTestId(`settings-default-history-${DEFAULT_TYPE}`).click()
      const defaultHistory = page.getByTestId('refund-history-table')
      await expect(defaultHistory).toBeVisible({ timeout: 10_000 })
      await expect(defaultHistory).toContainText(refundAdminEmail)
      await expect(defaultHistory).toContainText(accountNumber)
      await page.keyboard.press('Escape')
      await expect(defaultHistory).toHaveCount(0)

      // ─── AC-4.5: the VAT code for foreign-currency lines, with its history ─────────────────────────────────────
      await page.getByTestId('settings-foreign-vat-change').click()
      await chooseByText(page.getByTestId('foreign-currency-vat-select'), vatCode)
      await page.getByTestId('foreign-currency-vat-submit').click()
      await expect(page.getByTestId('foreign-currency-vat-submit')).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByTestId('settings-defaults-success')).toContainText('Foreign-currency VAT code saved')
      await expect(page.getByTestId('settings-foreign-vat-value')).toContainText(vatCode)

      await page.getByTestId('settings-foreign-vat-history').click()
      const foreignHistory = page.getByTestId('refund-history-table')
      await expect(foreignHistory).toBeVisible({ timeout: 10_000 })
      await expect(foreignHistory).toContainText(refundAdminEmail)
      await expect(foreignHistory).toContainText(vatCode)
      await page.keyboard.press('Escape')
      await expect(foreignHistory).toHaveCount(0)

      // ─── AC-4.5: the account is deactivated in ACCOUNTING; the default says so and asks for a new choice ───────
      // (only an Accounting manager can: the Refund administrator has no way to, which is AC-3.7's other half)
      expect((await accountingCall(refundAdminToken, 'POST', `/v1/entities/welld_ch/ledger-accounts/${accountNumber}/deactivate`)).status).toBe(403)
      await deactivateLedgerAccount(adminToken, accountNumber)

      await openDefaultsView(page)
      const deactivatedRow = page.getByTestId('settings-defaults-table').getByRole('row').filter({ hasText: accountNumber })
      await expect(deactivatedRow).toContainText('Deactivated in Accounting')
      await expect(page.getByTestId('settings-defaults-needs-choice')).toContainText(/needs? a new choice/)
      await expectNoAxeViolations(page, 'Default classification with a deactivated default')

      // the dialog starts on "Choose…" for that half, so saving can never silently clear a default
      await page.getByTestId(`settings-default-change-${DEFAULT_TYPE}`).click()
      await expect(page.getByTestId('default-classification-account')).toBeEnabled({ timeout: 15_000 })
      await expect(page.getByTestId('default-classification-account')).toHaveValue('')
      await expect(page.getByTestId('default-classification-inactive-note')).toBeVisible()
      await expect(page.getByTestId('default-classification-account').locator('option', { hasText: accountNumber })).toHaveCount(0)
      await page.getByTestId('default-classification-cancel').click()
      await expect(page.getByTestId('default-classification-cancel')).toHaveCount(0)

      // reactivated in Accounting: the default is usable again, with nothing to choose
      await reactivateLedgerAccount(adminToken, accountNumber)
      await openDefaultsView(page)
      await expect(page.getByTestId('settings-defaults-table').getByRole('row').filter({ hasText: accountNumber })).not.toContainText('Deactivated in Accounting')

      // ─── AC-6.9: Accounting cannot be read ───────────────────────────────────────────────────────────────────
      await page.route(/\/accounting\/expense-type-defaults$/, answerUnavailable)
      await openDefaultsView(page)
      const unavailable = page.getByTestId('settings-defaults-unavailable')
      await expect(unavailable).toBeVisible({ timeout: 20_000 })
      await expect(unavailable).toContainText('cannot be read')
      // the values as recorded, no state claimed, Change disabled with its reason, History still works (it reads Refund's own rows)
      await expect(page.getByTestId('settings-defaults-table').getByRole('row').filter({ hasText: accountNumber })).toContainText(vatCode)
      await expect(page.getByTestId('settings-defaults-table').getByRole('row').filter({ hasText: accountNumber })).not.toContainText('Deactivated in Accounting')
      await expect(page.getByTestId(`settings-default-change-${DEFAULT_TYPE}`)).toHaveAttribute('aria-disabled', 'true')
      // `aria-disabled`, not `disabled` (so it keeps its place in the tab order and says why): pressing it opens nothing
      await page.getByTestId(`settings-default-change-${DEFAULT_TYPE}`).click({ force: true })
      await expect(page.getByTestId('default-classification-account')).toHaveCount(0)
      await page.getByTestId(`settings-default-history-${DEFAULT_TYPE}`).click()
      await expect(page.getByTestId('refund-history-table')).toContainText(accountNumber, { timeout: 10_000 })
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('refund-history-table')).toHaveCount(0)
      await expectNoAxeViolations(page, 'Default classification with Accounting unreadable')
      await page.unroute(/\/accounting\/expense-type-defaults$/, answerUnavailable)

      // ─── AC-4.6: whoever holds Accounting gets a link in the note, to the Accounting app ─────────────────────
      const adminPage = await adminContext.newPage()
      await openDefaultsView(adminPage)
      const link = adminPage.getByTestId('settings-accounting-link')
      await expect(link).toBeVisible({ timeout: 20_000 })
      await expect(link).toHaveAttribute('href', '/accounting')
      await expect(adminPage.getByTestId('settings-accounting-link-note')).toContainText('kept in the Accounting app')
      await link.click()
      await expect(adminPage).toHaveURL(/\/accounting/, { timeout: 30_000 })
      await expect(adminPage.getByRole('heading', { name: 'Accounting', level: 1 })).toBeVisible({ timeout: 30_000 })
    } finally {
      await restoreDefaults()
      // a default put back to what it was may name an entry that is not active (a failed run): the foreign-currency code too
      try {
        await reactivateLedgerAccount(adminToken, accountNumber)
      } catch {
        // already active: nothing to put back
      }
      await Promise.all([refundAdminContext.close(), adminContext.close()])
    }
  })

  test('refund-api refuses a default or a designation naming an entry Accounting deactivated, or never had (AC-4.4, AC-4.5)', async () => {
    test.setTimeout(60_000)
    const tag = uniqueSuffix()
    const adminSession = await seedAdminSession(`e2e-acct-settings-race-admin-${tag}@operai.test`, 'E2E Accounting Settings Race Admin')
    const adminToken = await freshToken(adminSession.cookieHeader)
    const refundAdminEmail = `e2e-acct-settings-race-${tag}@operai.test`
    const refundAdminSession = await seedUserSession(refundAdminEmail, 'E2E Refund Settings Race Admin')
    grantRole(refundAdminEmail, 'refund-admin')
    const refundAdminToken = await freshToken(refundAdminSession.cookieHeader)
    const restoreDefaults = await snapshotAccountingDefaults(refundAdminToken, [DEFAULT_TYPE])

    const account = await createLedgerAccount(adminToken, { number: uniqueAccountNumber(), name: `E2E race account ${tag}` })
    const code = await createVatCode(adminToken, { code: uniqueVatCode(), label: `E2E race VAT ${tag}`, ratePercent: '2.6' })
    try {
      await deactivateLedgerAccount(adminToken, account.number)
      // the API behind the dialog refuses it, whatever a stale list offered (a number that is in Accounting, but inactive)
      await expect(setExpenseTypeDefault(refundAdminToken, DEFAULT_TYPE, account.number, code.code)).rejects.toThrow(/-> 422/)
      // and an entry Accounting never had
      await expect(setExpenseTypeDefault(refundAdminToken, DEFAULT_TYPE, '99999.999', code.code)).rejects.toThrow(/-> 422/)
      await expect(setForeignCurrencyVatCode(refundAdminToken, 'NO-SUCH-CODE')).rejects.toThrow(/-> 422/)
    } finally {
      await restoreDefaults()
    }
  })
})
