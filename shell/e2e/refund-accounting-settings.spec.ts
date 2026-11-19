/**
 * Refund accounting settings journey (specs/20261118-refund-accounting-export, T31, adapted by specs/20261119-accounting, T42 and, for
 * the 2026-11-19 accounting sign-off, T73). Drives the REAL assembled shell host + refund-ui remote (ADR
 * 20260709-suite-frontend-module-federation) against the REAL refund-api, accounting-api and auth services, no mocking, like this
 * suite's other refund journeys (refund-settings.spec.ts, mileage-rate.spec.ts). The ledger accounts, VAT codes and exchange rates
 * are Accounting's: Refund's Settings keeps only the DEFAULTS, which choose AMONG Accounting's accounts by number.
 *
 * Since the sign-off (20261118 SO-2, SO-16) a default is an ACCOUNT and nothing else: there is no default VAT code, no
 * foreign-currency VAT code to designate, and so no designation block in Settings, no VAT column and no VAT select in the dialog.
 *
 * Journey (a Refund administrator WITHOUT an Accounting capability: the `refund-admin` role holds `settings:read` and
 * `settings:manage` and nothing of Accounting, AC-3.7):
 *   - the Settings tabs are General and Default classification: no "Accounts and VAT" and no "Exchange rates" view, and the old
 *     `?section=exchange-rates` address shows General (AC-4.6);
 *   - the Default classification view opens with the note that Accounting keeps the entries, without a link for this person
 *     (AC-4.6, UX-17);
 *   - the table lists the FOURTEEN expense types, flight and taxi among them, with the columns type, account, last changed and
 *     actions, and nothing about VAT (AC-8.1 of 20261118, AC-4.6): no foreign-currency block, no VAT select in the dialog;
 *   - the account (made in Accounting by an administrator, helpers/accountingFixtures.ts) is offered in the chooser and becomes the
 *     default of an expense type, with its history (AC-4.4);
 *   - the account is DEACTIVATED in Accounting: the default shows "Deactivated in Accounting", counts as a default that needs a
 *     new choice, and its dialog starts on "Choose…" (AC-4.5); Accounting is then reactivated;
 *   - Accounting CANNOT BE READ (the one answer of the defaults list says so; a real outage cannot be made on this stack): one
 *     warning banner, Change disabled, History still working (AC-6.9);
 *   - an administrator, who holds Accounting, sees the same note with a link to /accounting (AC-4.6).
 * `axeViolations` is 0 on the Default classification view with a deactivated default and in the unavailable state (design
 * § Accessibility layer 2), in the browser's real contrast.
 *
 * A second journey is the API behind it: fourteen account-only rows with no VAT field, a default naming a deactivated or unknown
 * account refused (422), a body that still carries `vatCode` refused (422, nothing written), and the designation route gone (404
 * for a settings administrator and for nobody alike).
 *
 * Fixtures and state:
 *   - the accounting release marker comes from global-setup.ts: without it nothing here would fail, but every journey that
 *     approves a request would (409 `accounting_release_pending`);
 *   - the account is new on every run (random number: it stays taken once added, AC-1.3);
 *   - what is in effect afterwards is what was before: the default of the expense type is put back through the API in `finally`
 *     (its history rows stay, they are append-only), and the deactivated account is reactivated.
 *
 * Needs the stack in playwright.config.ts's header (auth with ENABLE_TEST_AUTH=true, refund-api on :8082, accounting-api on :8089).
 *
 * This file is the e2e level of AC-3.7, AC-4.4, AC-4.5, AC-4.6, AC-6.9 (and AC-1.1/AC-1.9, which moved to accounting.spec.ts) and of
 * 20261118's AC-2.1, AC-2.2, AC-8.1 as adjusted by the sign-off.
 */
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie } from './helpers/adminSession'
import { grantRole } from './helpers/inviteFixtures'
import {
  accountingCall,
  createLedgerAccount,
  deactivateLedgerAccount,
  reactivateLedgerAccount,
  uniqueAccountNumber,
} from './helpers/accountingFixtures'
import { axeViolations } from './helpers/meetingsFixtures'
import {
  freshToken,
  getExpenseTypeDefaults,
  refundCall,
  setExpenseTypeDefault,
  snapshotAccountingDefaults,
} from './helpers/refundFixtures'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** The expense type whose default this journey changes (and restores): one no other journey of this suite reads. */
const DEFAULT_TYPE = 'telephone'

/** The fourteen expense types, in enum order, with their English label (twelve of the paper form, then flight and taxi: AC-8.1). */
const EXPENSE_TYPES: readonly (readonly [id: string, label: string])[] = [
  ['travel_highway', 'Travel — highway'],
  ['travel_km', 'Travel — mileage (km)'],
  ['travel_parking', 'Travel — parking'],
  ['travel_train', 'Travel — train'],
  ['travel_other_public_transport', 'Travel — other public transport'],
  ['travel_flight', 'Travel — flight'],
  ['travel_taxi', 'Travel — taxi'],
  ['company_manuals', 'Company manuals'],
  ['stationery', 'Stationery'],
  ['representation_meals', 'Meals with clients'],
  ['representation_gifts', 'Representation — gifts'],
  ['office_material', 'Office material'],
  ['postal', 'Postal'],
  ['telephone', 'Telephone'],
]

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
    types: Array<{ account: { state: string } | null }>
  }
  const unverified = <T extends { state: string } | null>(entry: T): T => (entry === null ? entry : { ...entry, state: 'unverified' })
  return route.fulfill({
    response,
    json: {
      ...body,
      accounting: 'unavailable',
      types: body.types.map((row) => ({ ...row, account: unverified(row.account) })),
    },
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/20261119-accounting T73 (T42): Refund settings among Accounting entries', () => {
  test('a Refund admin without Accounting sees the fourteen account-only defaults (no VAT, no designation), sets one among Accounting\'s accounts, sees no Accounts/VAT or Rates view and the note; a deactivated default asks for a new choice; Accounting unreadable disables Change (AC-3.7/4.4/4.5/4.6/6.9)', async ({
    browser,
  }) => {
    // One account, a default, its history and four states in one page: well beyond the 30 s default.
    test.setTimeout(240_000)
    const tag = uniqueSuffix()
    const refundAdminEmail = `e2e-acct-settings-refund-admin-${tag}@operai.test`
    const adminEmail = `e2e-acct-settings-admin-${tag}@operai.test`
    const accountNumber = uniqueAccountNumber()
    const accountName = `E2E account ${tag}`

    // The Accounting administrator writes the entry (Accounting's own API: the `admin` role holds both of its capabilities).
    const adminSession = await seedAdminSession(adminEmail, 'E2E Accounting Settings Admin')
    const adminToken = await freshToken(adminSession.cookieHeader)
    await createLedgerAccount(adminToken, { number: accountNumber, name: accountName })

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

      // ─── 20261118 AC-2.1, AC-2.2, AC-8.1: fourteen types, an ACCOUNT each, and nothing about VAT ───────────────
      const table = page.getByTestId('settings-defaults-table')
      await expect(page.locator('[data-testid^="settings-default-row-"]')).toHaveCount(EXPENSE_TYPES.length)
      for (const [id, label] of EXPENSE_TYPES) {
        await expect(page.getByTestId(`settings-default-row-${id}`), `the row of ${id}`).toContainText(label)
      }
      // the four columns of an account-only default: type, account, last change, actions (no VAT column)
      await expect(table.getByRole('columnheader')).toHaveText(['Expense type', 'Default account', 'Last changed', 'Actions'])
      // no designation block, no foreign-currency VAT code, no VAT word anywhere on the card
      await expect(page.locator('[data-testid^="settings-foreign-vat-"], [data-testid^="foreign-currency-vat-"]')).toHaveCount(0)
      await expect(page.getByTestId('settings-defaults-card')).not.toContainText(/foreign.currency/i)
      await expect(page.getByTestId('settings-defaults-card').getByRole('columnheader', { name: /VAT/i })).toHaveCount(0)

      // ─── AC-4.4: Accounting's account is offered, and becomes the default of one expense type ────────────────
      await page.getByTestId(`settings-default-change-${DEFAULT_TYPE}`).click()
      await chooseByText(page.getByTestId('default-classification-account'), accountNumber)
      // the dialog has one select: the account (a default has no VAT half)
      await expect(page.getByRole('dialog').locator('select')).toHaveCount(1)
      await expect(page.getByTestId('default-classification-vat-code')).toHaveCount(0)
      await page.getByTestId('default-classification-submit').click()
      await expect(page.getByTestId('default-classification-submit')).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByTestId('settings-defaults-success')).toContainText('Default saved')
      const defaultRow = table.getByRole('row').filter({ hasText: accountNumber })
      await expect(defaultRow).toContainText(accountName)
      await expect(defaultRow).toContainText(refundAdminEmail)

      await page.getByTestId(`settings-default-history-${DEFAULT_TYPE}`).click()
      const defaultHistory = page.getByTestId('refund-history-table')
      await expect(defaultHistory).toBeVisible({ timeout: 10_000 })
      await expect(defaultHistory).toContainText(refundAdminEmail)
      await expect(defaultHistory).toContainText(accountNumber)
      await expect(defaultHistory.getByRole('columnheader', { name: /VAT/i })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(defaultHistory).toHaveCount(0)

      // ─── AC-4.5: the account is deactivated in ACCOUNTING; the default says so and asks for a new choice ───────
      // (only an Accounting manager can: the Refund administrator has no way to, which is AC-3.7's other half)
      expect((await accountingCall(refundAdminToken, 'POST', `/v1/entities/welld_ch/ledger-accounts/${accountNumber}/deactivate`)).status).toBe(403)
      await deactivateLedgerAccount(adminToken, accountNumber)

      await openDefaultsView(page)
      const deactivatedRow = table.getByRole('row').filter({ hasText: accountNumber })
      await expect(deactivatedRow).toContainText('Deactivated in Accounting')
      await expect(page.getByTestId('settings-defaults-needs-choice')).toContainText(/needs? a new choice/)
      await expectNoAxeViolations(page, 'Default classification with a deactivated default')

      // the dialog starts on "Choose…", so saving can never silently clear a default
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
      await expect(table.getByRole('row').filter({ hasText: accountNumber })).not.toContainText('Deactivated in Accounting')

      // ─── AC-6.9: Accounting cannot be read ───────────────────────────────────────────────────────────────────
      await page.route(/\/accounting\/expense-type-defaults$/, answerUnavailable)
      await openDefaultsView(page)
      const unavailable = page.getByTestId('settings-defaults-unavailable')
      await expect(unavailable).toBeVisible({ timeout: 20_000 })
      await expect(unavailable).toContainText('cannot be read')
      // the values as recorded, no state claimed, Change disabled with its reason, History still works (it reads Refund's own rows)
      await expect(table.getByRole('row').filter({ hasText: accountNumber })).not.toContainText('Deactivated in Accounting')
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
      // a default put back to what it was may name an account that is not active (a failed run): make this one active again
      try {
        await reactivateLedgerAccount(adminToken, accountNumber)
      } catch {
        // already active: nothing to put back
      }
      await Promise.all([refundAdminContext.close(), adminContext.close()])
    }
  })

  test('refund-api serves fourteen account-only defaults, refuses a default naming a deactivated or unknown account or still carrying a VAT code, and has no designation route (AC-4.4, 20261118 AC-2.1, AC-2.2, AC-3.13)', async () => {
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
    try {
      // the list: the fourteen types in enum order, each with an account or none, and no VAT half and no designation anywhere
      const defaults = await getExpenseTypeDefaults(refundAdminToken)
      expect(defaults.types.map((row) => row.type)).toEqual(EXPENSE_TYPES.map(([id]) => id))
      expect(defaults).not.toHaveProperty('foreignCurrencyVatCode')
      for (const row of defaults.types) {
        // by KEY, not by value: an account may be named anything. The row, its account and each history entry have no VAT member.
        const keys = [
          ...Object.keys(row),
          ...Object.keys(row.account ?? {}),
          ...row.history.flatMap((entry) => Object.keys(entry)),
        ]
        expect(keys.filter((key) => /vat/i.test(key)), `the VAT members of ${row.type}`).toEqual([])
      }

      // a body that still carries a VAT code is refused and writes nothing, with or without the account
      const before = JSON.stringify(await getExpenseTypeDefaults(refundAdminToken))
      for (const body of [{ accountNumber: account.number, vatCode: null }, { accountNumber: account.number, vatCode: 'IPM81' }, { vatCode: 'IPM81' }]) {
        const refused = await refundCall(refundAdminToken, 'PUT', `/accounting/expense-type-defaults/${DEFAULT_TYPE}`, body)
        expect([JSON.stringify(body), refused.status]).toEqual([JSON.stringify(body), 422])
      }
      expect(JSON.stringify(await getExpenseTypeDefaults(refundAdminToken))).toBe(before)

      // the foreign-currency designation of the first draft is not a route: 404 for a settings administrator, and without a token
      for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
        const body = method === 'PUT' ? { vatCode: null } : undefined
        expect([method, (await refundCall(refundAdminToken, method, '/accounting/foreign-currency-vat-code', body)).status]).toEqual([method, 404])
        expect([method, (await refundCall(null, method, '/accounting/foreign-currency-vat-code', body)).status]).toEqual([method, 404])
      }

      // an account Accounting deactivated: the API behind the dialog refuses it, whatever a stale list offered
      await deactivateLedgerAccount(adminToken, account.number)
      await expect(setExpenseTypeDefault(refundAdminToken, DEFAULT_TYPE, account.number)).rejects.toThrow(/-> 422/)
      // and an account Accounting never had
      await expect(setExpenseTypeDefault(refundAdminToken, DEFAULT_TYPE, '99999.999')).rejects.toThrow(/-> 422/)
    } finally {
      await restoreDefaults()
    }
  })
})
