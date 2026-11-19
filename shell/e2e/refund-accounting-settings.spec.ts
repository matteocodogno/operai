/**
 * T31 — Refund accounting settings journey (specs/20261118-refund-accounting-export, QE e2e).
 * Drives the REAL assembled shell host + refund-ui remote (ADR 20260709-suite-frontend-module-federation) against the REAL
 * refund-api/auth services — no mocking — like this suite's other refund journeys (refund-settings.spec.ts,
 * mileage-rate.spec.ts).
 *
 * Journey (an administrator on Settings, with no other actor): adds a ledger account with the KEYBOARD (Enter in the last
 * field of the dialog, AC-1.1; ADR 20261118 dialog-beside-form: a dialog that renders its own `<form>` is never inside
 * another form, and its confirming control is proved in a real browser) → adds a VAT code → sets them as the default of an
 * expense type (AC-2.1, with its history) → deactivates the account with the keyboard-pressed Confirm and reactivates it
 * (AC-1.9: it leaves and returns to the lists a default may be chosen from) → designates the VAT code for foreign-currency
 * lines (AC-2.5, with its history) → corrects one monthly exchange rate twice by hand (AC-5.2 the "Corrected" origin,
 * AC-5.3 the earlier value stays in the history).
 *
 * Fixtures and state:
 *   - the accounting release marker comes from global-setup.ts (T12): without it nothing here would fail, but every
 *     journey that approves a request would (409 `accounting_release_pending`);
 *   - rates are TYPED BY HAND. The stack is expected to run with `REFUND_FX_SOURCE=off` (no outbound call, every fetch is
 *     recorded as `disabled`); with the default `bazg` the journey still passes, because it corrects a rate and never reads
 *     one a fetch would have recorded. The month is a past one (2026-02), whatever today is;
 *   - the account and the VAT code are new on every run (random number and code: both stay taken once added, AC-1.2, AC-1.4);
 *   - what is in effect afterwards is what was before: the default of the expense type and the foreign-currency VAT code
 *     are put back through the API in `finally` (their history rows stay, they are append-only). A rate correction is
 *     append-only too and stays in effect for GBP 2026-02, a month no other journey reads.
 *
 * Needs the stack in playwright.config.ts's header (auth with ENABLE_TEST_AUTH=true, refund-api on :8082) and the refund
 * database migrated (`bun run db:deploy` in refund-api).
 *
 * AC proof by level: see specs/20261118-refund-accounting-export/plan.md § Test strategy. This file is the e2e level of
 * AC-1.1, AC-1.9, AC-2.1, AC-2.5, AC-5.2, AC-5.3.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { seedAdminSession, applySessionCookie } from './helpers/adminSession'
import { freshToken, snapshotAccountingDefaults, uniqueAccountNumber, uniqueVatCode } from './helpers/refundFixtures'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** The expense type whose default this journey changes (and restores): one no other journey of this suite reads. */
const DEFAULT_TYPE = 'telephone'

/** The month and currency whose rate this journey corrects: past, completed, and read by no other journey. */
const RATE_MONTH = '2026-02'
const RATE_CURRENCY = 'GBP'

/** A rate with six decimals whose last digit is not zero, so the screen shows it exactly as typed. */
const uniqueRate = (): string => {
  const digits = Array.from({ length: 5 }, () => Math.floor(Math.random() * 10)).join('')
  return `1.${digits}${1 + Math.floor(Math.random() * 9)}`
}

/** Picks the option of a catalog select whose text names `text` (the number of an account, the code of a VAT code). */
async function chooseByText(select: Locator, text: string): Promise<void> {
  await expect(select).toBeEnabled({ timeout: 15_000 })
  const option = select.locator('option', { hasText: text })
  await expect(option).toHaveCount(1, { timeout: 15_000 })
  const value = await option.getAttribute('value')
  if (!value) throw new Error(`[refund-accounting-settings] the option for ${text} has no value`)
  await select.selectOption(value)
}

async function openSettingsView(page: Page, tabName: string, viewTestId: string): Promise<void> {
  await page.goto('/refund/settings')
  await expect(page.getByTestId('refund-settings-page')).toBeVisible({ timeout: 20_000 })
  // The tabs of the accounting views appear when the session's permissions have resolved (they fail closed until then).
  await page.getByTestId('refund-settings-tabs').getByRole('tab', { name: tabName }).click({ timeout: 20_000 })
  await expect(page.getByTestId(viewTestId)).toBeVisible({ timeout: 20_000 })
}

/** Corrects one rate through the dialog and waits until the cell shows it as corrected. */
async function correctRate(page: Page, rate: string): Promise<void> {
  await page.getByTestId(`settings-fx-correct-${RATE_MONTH}-${RATE_CURRENCY}`).click()
  const input = page.getByTestId('rate-correction-value')
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill(rate)
  await page.getByTestId('rate-correction-submit').click()
  await expect(page.getByTestId('rate-correction-submit')).toHaveCount(0, { timeout: 10_000 })
  const cell = page.getByTestId(`settings-fx-cell-${RATE_MONTH}-${RATE_CURRENCY}`)
  await expect(cell).toContainText(rate, { timeout: 10_000 })
  await expect(cell).toContainText('Corrected')
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/20261118-refund-accounting-export T31: settings journey', () => {
  test('admin adds an account and a VAT code, sets a default and the foreign-currency VAT code, deactivates and reactivates the account, corrects a rate (AC-1.1/1.9/2.1/2.5/5.2/5.3)', async ({
    browser,
  }) => {
    // Two catalogs, a default, a designation and two rate corrections in one page: well beyond the 30 s default.
    test.setTimeout(120_000)
    const tag = uniqueSuffix()
    const adminEmail = `e2e-acct-settings-admin-${tag}@operai.test`
    const accountNumber = uniqueAccountNumber()
    const accountName = `E2E account ${tag}`
    const vatCode = uniqueVatCode()
    const vatLabel = `E2E VAT ${tag}`

    const adminSession = await seedAdminSession(adminEmail, 'E2E Accounting Settings Admin')
    const adminToken = await freshToken(adminSession.cookieHeader)
    const restoreDefaults = await snapshotAccountingDefaults(adminToken, [DEFAULT_TYPE])

    const adminContext = await browser.newContext()
    await applySessionCookie(adminContext, adminSession)
    const page = await adminContext.newPage()

    try {
      // ─── AC-1.1: add a ledger account, keyboard only from the first field to the confirm ───────────────────
      await openSettingsView(page, 'Accounts and VAT', 'refund-settings-accounting')
      await expect(page.getByTestId('settings-accounts-card')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('settings-accounts-table')).toBeVisible({ timeout: 20_000 })

      await page.getByTestId('settings-accounts-add').click()
      const numberInput = page.getByTestId('add-ledger-account-number')
      await expect(numberInput).toBeFocused({ timeout: 10_000 })
      // ADR 20261118 dialog-beside-form: the dialog's own form is not inside another form.
      await expect(page.locator('form form')).toHaveCount(0)
      await numberInput.fill(accountNumber)
      const nameInput = page.getByTestId('add-ledger-account-name')
      await nameInput.fill(accountName)
      await nameInput.press('Enter')

      await expect(page.getByTestId('add-ledger-account-submit')).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByTestId('settings-accounts-success')).toContainText(accountNumber)
      await expect(page.getByTestId('settings-accounts-add')).toBeFocused()
      const accountRow = page.getByTestId('settings-accounts-table').getByRole('row').filter({ hasText: accountNumber })
      await expect(accountRow).toContainText(accountName)
      await expect(accountRow).toContainText('Active')
      await expect(accountRow).toContainText(adminEmail)

      // ─── a VAT code (no keyboard shortcut needed: the confirm was proved above) ─────────────────────────────
      await page.getByTestId('settings-vat-codes-add').click()
      await page.getByTestId('add-vat-code-code').fill(vatCode)
      await page.getByTestId('add-vat-code-label').fill(vatLabel)
      await page.getByTestId('add-vat-code-rate').fill('8.1')
      await page.getByTestId('add-vat-code-submit').click()
      await expect(page.getByTestId('add-vat-code-submit')).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByTestId('settings-vat-codes-success')).toContainText(vatCode)
      const vatRow = page.getByTestId('settings-vat-codes-table').getByRole('row').filter({ hasText: vatCode })
      await expect(vatRow).toContainText(vatLabel)
      await expect(vatRow).toContainText('Active')

      // ─── AC-2.1: the pair becomes the default of one expense type, and the history says who and what ────────
      await page.getByTestId(`settings-default-change-${DEFAULT_TYPE}`).click()
      await chooseByText(page.getByTestId('default-classification-account'), accountNumber)
      await chooseByText(page.getByTestId('default-classification-vat-code'), vatCode)
      await page.getByTestId('default-classification-submit').click()
      await expect(page.getByTestId('default-classification-submit')).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByTestId('settings-defaults-success')).toContainText('Default saved')
      const defaultRow = page.getByTestId('settings-defaults-table').getByRole('row').filter({ hasText: accountNumber })
      await expect(defaultRow).toContainText(vatCode)

      await page.getByTestId(`settings-default-history-${DEFAULT_TYPE}`).click()
      const defaultHistory = page.getByTestId('refund-history-table')
      await expect(defaultHistory).toBeVisible({ timeout: 10_000 })
      await expect(defaultHistory).toContainText(adminEmail)
      await expect(defaultHistory).toContainText(accountNumber)
      await page.keyboard.press('Escape')
      await expect(defaultHistory).toHaveCount(0)

      // ─── AC-1.9: deactivate (Confirm pressed with the keyboard), the account leaves the lists, then comes back ──
      await page.getByRole('button', { name: `Deactivate account ${accountNumber}` }).click()
      const confirmDeactivate = page.getByTestId('deactivate-ledger-account-confirm')
      await expect(confirmDeactivate).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('form form')).toHaveCount(0)
      await confirmDeactivate.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('deactivate-ledger-account-confirm')).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByTestId('settings-accounts-success')).toContainText('deactivated')
      await expect(accountRow).toContainText('Inactive')

      // a defaults dialog opened now no longer offers it (only active entries are listed, AC-2.4)
      await page.getByTestId(`settings-default-change-${DEFAULT_TYPE}`).click()
      const accountSelect = page.getByTestId('default-classification-account')
      await expect(accountSelect).toBeEnabled({ timeout: 15_000 })
      await expect(accountSelect.locator('option', { hasText: accountNumber })).toHaveCount(0)
      await page.getByTestId('default-classification-cancel').click()
      await expect(page.getByTestId('default-classification-cancel')).toHaveCount(0)

      await page.getByRole('button', { name: `Reactivate account ${accountNumber}` }).click()
      await expect(page.getByTestId('settings-accounts-success')).toContainText('reactivated', { timeout: 10_000 })
      await expect(accountRow).toContainText('Active')
      await expect(accountRow).toContainText(accountName) // the same number and name (AC-1.9)
      await expect(accountRow).not.toContainText('Inactive')

      // …and a defaults dialog opened now offers it again
      await page.getByTestId(`settings-default-change-${DEFAULT_TYPE}`).click()
      await expect(page.getByTestId('default-classification-account')).toBeEnabled({ timeout: 15_000 })
      await expect(
        page.getByTestId('default-classification-account').locator('option', { hasText: accountNumber }),
      ).toHaveCount(1)
      await page.getByTestId('default-classification-cancel').click()
      await expect(page.getByTestId('default-classification-cancel')).toHaveCount(0)

      // ─── AC-2.5: the VAT code for foreign-currency lines, with its history ──────────────────────────────────
      await page.getByTestId('settings-foreign-vat-change').click()
      await chooseByText(page.getByTestId('foreign-currency-vat-select'), vatCode)
      await page.getByTestId('foreign-currency-vat-submit').click()
      await expect(page.getByTestId('foreign-currency-vat-submit')).toHaveCount(0, { timeout: 10_000 })
      await expect(page.getByTestId('settings-defaults-success')).toContainText('Foreign-currency VAT code saved')
      await expect(page.getByTestId('settings-foreign-vat-value')).toContainText(vatCode)

      await page.getByTestId('settings-foreign-vat-history').click()
      const foreignHistory = page.getByTestId('refund-history-table')
      await expect(foreignHistory).toBeVisible({ timeout: 10_000 })
      await expect(foreignHistory).toContainText(adminEmail)
      await expect(foreignHistory).toContainText(vatCode)
      await page.keyboard.press('Escape')
      await expect(foreignHistory).toHaveCount(0)

      // ─── AC-5.2 / AC-5.3: a rate corrected by hand, twice; the first value stays in the history ─────────────
      await openSettingsView(page, 'Exchange rates', 'refund-settings-exchange-rates')
      await expect(page.getByTestId('settings-fx-card')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId(`settings-fx-cell-${RATE_MONTH}-${RATE_CURRENCY}`)).toBeVisible({ timeout: 20_000 })
      // a visit may start one automatic fetch (an attempt recorded as `disabled` with REFUND_FX_SOURCE=off): let it end first
      await expect(page.getByTestId('settings-fx-checking')).toHaveCount(0, { timeout: 30_000 })

      const firstRate = uniqueRate()
      const secondRate = uniqueRate()
      await correctRate(page, firstRate)
      await correctRate(page, secondRate)

      await page.getByTestId(`settings-fx-history-${RATE_MONTH}-${RATE_CURRENCY}`).click()
      const rateHistory = page.getByTestId('refund-history-table')
      await expect(rateHistory).toBeVisible({ timeout: 10_000 })
      await expect(rateHistory).toContainText(firstRate) // the value that was in effect before stays (AC-5.3)
      await expect(rateHistory).toContainText(secondRate)
      await expect(rateHistory).toContainText(adminEmail)
      await page.keyboard.press('Escape')
      await expect(rateHistory).toHaveCount(0)
    } finally {
      await restoreDefaults()
      await adminContext.close()
    }
  })
})
