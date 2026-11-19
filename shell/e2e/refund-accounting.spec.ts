/**
 * T32 — Refund accounting journey (specs/20261118-refund-accounting-export, QE e2e; plan § Test strategy "e2e journey").
 * Drives the REAL assembled shell host + refund-ui remote (ADR 20260709-suite-frontend-module-federation) against the REAL
 * refund-api/auth services — no mocking — like this suite's other refund journeys (refund-headline.spec.ts,
 * refund-batches-headline.spec.ts).
 *
 * Journey:
 *   1. an employee submits one WellD CH line in CHF and one in EUR (no receipt number exists yet);
 *   2. accounting opens the request: the panel shows the type's DEFAULT account and VAT code on the CHF line, and, on the EUR
 *      line, the type's account with the foreign-currency VAT code (the type's own default VAT code is NOT used) next to the
 *      rate 0.9246 and the CHF amount 9.62 (AC-3.1, AC-3.2, AC-3.8);
 *   3. accounting changes the CHF line's VAT code by hand: the marker flips and the VAT amount reads 1.56 (AC-3.3, AC-6.4);
 *   4. accounting approves; the employee sees the receipt numbers, the EUR line (earlier expense date) first (AC-4.4, AC-4.9);
 *   5. a second employee's request, whose type has no default, is REFUSED on approval: the dialog closes, an ErrorSummary
 *      lists what is missing, focus lands on the first missing select, nothing is numbered (AC-3.4, AC-4.3); once both
 *      values are chosen it approves and gets number 001;
 *   6. accounting compiles a batch, the export card says "3 rows", the CSV is downloaded and PARSED: 16 columns, the amounts
 *      9.62 (EUR 10.40 at 0.9246) and 1.56 (VAT of CHF 20.80 at 8.1 %), the receipt numbers, the batch id (AC-6.1 to AC-6.4).
 *
 * Fixtures (written through refund-api's admin routes as a real admin, see helpers/refundFixtures.ts) so the journey does not
 * depend on what accounting's seed (T39) says: a ledger account, a 0 % and an 8.1 % VAT code, the defaults of three expense
 * types, the foreign-currency VAT code and the EUR rate of 2026-03 (a month that is past whatever today is). The defaults it
 * changes are put back in `finally`; the new catalog entries stay (they are append-only and named "E2E").
 *
 * The accounting release marker comes from global-setup.ts (T12); without it every approval answers 409
 * `accounting_release_pending` (E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 skips that step). The stack runs with
 * `REFUND_FX_SOURCE=off` (rates are typed by hand): with `bazg` the journey also passes, because the rate is set explicitly.
 * A compile claims EVERY approved request, so the backlog other journeys leave is paid out first (drainApprovedBacklog).
 *
 * AC proof by level: see plan § Test strategy. This file is the e2e level of AC-3.1, AC-3.3, AC-3.4, AC-4.9, AC-6.1 to AC-6.4.
 */
import { readFile } from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie } from './helpers/adminSession'
import {
  ACCOUNTING_CSV_HEADER,
  createLedgerAccount,
  createVatCode,
  drainApprovedBacklog,
  freshToken,
  grantRefundAccounting,
  grantRefundEmployee,
  parseAccountingCsv,
  setExchangeRate,
  setExpenseTypeDefault,
  setForeignCurrencyVatCode,
  snapshotAccountingDefaults,
  uniqueAccountNumber,
  uniqueVatCode,
} from './helpers/refundFixtures'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** The month of the journey's expense dates and its EUR rate (the federal average the plan's vectors use). */
const RATE_MONTH = '2026-03'
const EUR_RATE = '0.9246'

/** Three expense types the journey owns for its duration: one with a default, one with a default used by a EUR line, one with none. */
const CHF_TYPE = 'stationery'
const EUR_TYPE = 'postal'
const NO_DEFAULT_TYPE = 'representation_gifts'

type LineInput = { date: string; type: string; motivo: string; amount: string; currency: 'CHF' | 'EUR' }

/** Opens a new draft, adds the lines (all WellD CH) and submits it; returns the request id. */
async function composeAndSubmit(page: Page, lines: LineInput[]): Promise<string> {
  await page.goto('/refund/requests')
  await expect(page.getByTestId('refund-my-requests-page')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('my-requests-new-button').click()
  await expect(page.getByTestId('refund-request-detail-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('request-detail-draft')).toBeVisible({ timeout: 20_000 })

  for (const line of lines) {
    const rowsBefore = await page.locator('[data-testid^="expense-line-row-"]').count()
    await page.getByTestId('composer-date').fill(line.date)
    await page.getByTestId('composer-type').selectOption(line.type)
    await page.getByTestId('composer-motivo').fill(line.motivo)
    await page.getByTestId('composer-amount').fill(line.amount)
    await page.getByTestId('composer-entity').selectOption('welld_ch')
    await page.getByTestId('composer-currency').selectOption(line.currency)
    await page.getByTestId('composer-add-button').click()
    await expect(page.locator('[data-testid^="expense-line-row-"]')).toHaveCount(rowsBefore + 1, { timeout: 10_000 })
  }

  await page.getByTestId('request-detail-submit').click()
  await expect(page.getByTestId('request-detail-submitted')).toBeVisible({ timeout: 20_000 })
  const requestId = await page.getByTestId('refund-request-detail-id').textContent()
  expect(requestId).toBeTruthy()
  return requestId as string
}

/** The row of a line (found by its reason) on a request page, and the line's id from the row's test id. */
async function lineOf(page: Page, motivo: string): Promise<{ row: Locator; lineId: string }> {
  const row = page.locator('[data-testid^="expense-line-row-"]').filter({ hasText: motivo })
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  const testId = await row.getAttribute('data-testid')
  if (!testId) throw new Error(`[refund-accounting] no row for ${motivo}`)
  return { row, lineId: testId.replace('expense-line-row-', '') }
}

/** Picks the option of a catalog select whose text names `text` (the number of an account, the code of a VAT code). */
async function chooseByText(select: Locator, text: string): Promise<void> {
  await expect(select).toBeEnabled({ timeout: 15_000 })
  const option = select.locator('option', { hasText: text })
  await expect(option).toHaveCount(1, { timeout: 15_000 })
  const value = await option.getAttribute('value')
  if (!value) throw new Error(`[refund-accounting] the option for ${text} has no value`)
  await select.selectOption(value)
}

async function openReview(page: Page, requestId: string): Promise<void> {
  await page.goto(`/refund/review/${requestId}`)
  await expect(page.getByTestId('refund-review-detail-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('review-detail-decidable')).toBeVisible({ timeout: 20_000 })
}

/** Presses Approve and confirms; what happens next (the queue, or a refusal) is the caller's to assert. */
async function pressApprove(page: Page): Promise<void> {
  await page.getByTestId('review-detail-approve').click()
  await expect(page.getByTestId('approve-dialog-confirm')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('approve-dialog-confirm').click()
}

/** The receipt number a line row shows (its visually hidden label dropped). */
async function shownReceiptNumber(row: Locator): Promise<string> {
  const text = (await row.getByTestId('receipt-number').textContent()) ?? ''
  const match = /[A-Z]{2}\d{2}\/\d{3,}/.exec(text)
  if (!match) throw new Error(`[refund-accounting] no receipt number in "${text}"`)
  return match[0]
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/20261118-refund-accounting-export T32: accounting journey', () => {
  test('CHF + EUR lines get defaults → a VAT code is changed → approval numbers them → a type without default is refused → compile → the CSV is downloaded and parsed (AC-3.1/3.2/3.3/3.4/4.9/6.1/6.2/6.3/6.4)', async ({
    browser,
  }) => {
    // Three actors, two requests, a compile and a download: well beyond the 30 s default of the shorter journeys.
    test.setTimeout(240_000)
    const tag = uniqueSuffix()
    const adminEmail = `e2e-acct-admin-${tag}@operai.test`
    const empAEmail = `e2e-acct-emp-a-${tag}@operai.test`
    const empBEmail = `e2e-acct-emp-b-${tag}@operai.test`
    const acctEmail = `e2e-acct-acct-${tag}@operai.test`
    const empAName = 'E2E Accounting Employee A'
    const empBName = 'E2E Accounting Employee B'

    // Reasons the journey finds its lines by (the CSV's "Reason" column carries them too).
    const motivoChf = `Notebooks ${tag}`
    const motivoEur = `Stamps ${tag}`
    const motivoNoDefault = `Gift ${tag}`

    const adminSession = await seedAdminSession(adminEmail, 'E2E Accounting Admin')
    const adminToken = await freshToken(adminSession.cookieHeader)
    const restoreDefaults = await snapshotAccountingDefaults(adminToken, [CHF_TYPE, EUR_TYPE, NO_DEFAULT_TYPE])

    const empASession = await seedUserSession(empAEmail, empAName)
    grantRefundEmployee(empAEmail)
    const empBSession = await seedUserSession(empBEmail, empBName)
    grantRefundEmployee(empBEmail)
    const acctSession = await seedUserSession(acctEmail, 'E2E Accounting Reviewer')
    grantRefundAccounting(acctEmail, 'global') // global: review + approve + set-approved-total, and a WellD CH scope for the export
    const acctToken = await freshToken(acctSession.cookieHeader)

    const newContext = async (session: typeof acctSession) => {
      const context = await browser.newContext()
      await applySessionCookie(context, session)
      return context
    }
    const empAContext = await newContext(empASession)
    const empBContext = await newContext(empBSession)
    const acctContext = await newContext(acctSession)
    const empA = await empAContext.newPage()
    const empB = await empBContext.newPage()
    const acct = await acctContext.newPage()

    try {
      // ─── Fixtures: a known catalog, defaults, designation and rate ─────────────────────────────────────────
      await setExchangeRate(adminToken, RATE_MONTH, 'EUR', EUR_RATE)
      const account = await createLedgerAccount(adminToken, {
        number: uniqueAccountNumber(),
        name: `E2E booking account ${tag}`,
      })
      const noVat = await createVatCode(adminToken, { code: uniqueVatCode(), label: `E2E no VAT ${tag}`, ratePercent: '0' })
      const vat81 = await createVatCode(adminToken, { code: uniqueVatCode(), label: `E2E VAT 8.1 ${tag}`, ratePercent: '8.1' })
      await setExpenseTypeDefault(adminToken, CHF_TYPE, account.id, noVat.id)
      // the EUR line's type has ANOTHER default VAT code: it must be ignored for a foreign currency (AC-3.2)
      await setExpenseTypeDefault(adminToken, EUR_TYPE, account.id, vat81.id)
      await setExpenseTypeDefault(adminToken, NO_DEFAULT_TYPE, null, null)
      await setForeignCurrencyVatCode(adminToken, noVat.id)

      await drainApprovedBacklog(acctToken)

      // ─── 1. The employees submit ──────────────────────────────────────────────────────────────────────────
      const requestA = await composeAndSubmit(empA, [
        { date: '2026-03-04', type: CHF_TYPE, motivo: motivoChf, amount: '20.80', currency: 'CHF' },
        { date: '2026-03-02', type: EUR_TYPE, motivo: motivoEur, amount: '10.40', currency: 'EUR' },
      ])
      // no number before the approval, and none shown to the employee as a placeholder
      await expect(empA.getByTestId('receipt-number')).toHaveCount(0)

      const requestB = await composeAndSubmit(empB, [
        { date: '2026-03-10', type: NO_DEFAULT_TYPE, motivo: motivoNoDefault, amount: '10.00', currency: 'CHF' },
      ])

      // ─── 2. Accounting sees the defaults (AC-3.1, AC-3.2) ────────────────────────────────────────────────
      await openReview(acct, requestA)
      const chf = await lineOf(acct, motivoChf)
      const eur = await lineOf(acct, motivoEur)
      const chfPanel = (suffix = '') => acct.getByTestId(`classification-${chf.lineId}${suffix}`)
      const eurPanel = (suffix = '') => acct.getByTestId(`classification-${eur.lineId}${suffix}`)

      await expect(chfPanel()).toBeVisible({ timeout: 20_000 })
      await expect(chfPanel('-account').locator('option:checked')).toContainText(account.number)
      await expect(chfPanel('-vat-code').locator('option:checked')).toContainText(noVat.code)
      await expect(chfPanel('-account-field')).toContainText('Default')
      await expect(chfPanel('-vat-code-field')).toContainText('Default')
      await expect(chfPanel('-vat-amount')).toContainText('0.00')

      await expect(eurPanel()).toBeVisible({ timeout: 20_000 })
      await expect(eurPanel('-account').locator('option:checked')).toContainText(account.number)
      // the designated foreign-currency code, not the type's own default (AC-3.2)
      await expect(eurPanel('-vat-code').locator('option:checked')).toContainText(noVat.code)
      await expect(eurPanel('-vat-code').locator('option:checked')).not.toContainText(vat81.code)
      await expect(eurPanel('-account-field')).toContainText('Default')
      await expect(eurPanel('-vat-code-field')).toContainText('Default')
      // the rate in effect and the CHF amount: EUR 10.40 at 0.9246 is CHF 9.62 (AC-6.3's figure, on the screen first)
      await expect(eurPanel('-rate')).toContainText(EUR_RATE)
      await expect(eurPanel('-chf')).toContainText('9.62')

      // ─── 3. Accounting changes one VAT code by hand (AC-3.3) ─────────────────────────────────────────────
      await chooseByText(chfPanel('-vat-code'), vat81.code)
      await expect(chfPanel('-saved')).toContainText(vat81.code, { timeout: 10_000 })
      await expect(chfPanel('-vat-code-field')).toContainText('Set by hand')
      await expect(chfPanel('-account-field')).toContainText('Default') // only the changed value is a hand value
      await expect(chfPanel('-vat-amount')).toContainText('1.56') // CHF 20.80 at 8.1 % (AC-6.4's figure)

      // ─── approve (the request carries both lines, classified) ──────────────────────────────────────────
      await pressApprove(acct)
      await expect(acct.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
      await expect(acct.getByTestId(`review-queue-row-${requestA}`)).toContainText(/approved/i, { timeout: 20_000 })

      // ─── 4. The employee sees the numbers (AC-4.9), the earlier expense date first in the sequence (AC-4.4) ──
      await empA.goto(`/refund/requests/${requestA}`)
      await expect(empA.getByTestId('request-detail-approved')).toBeVisible({ timeout: 20_000 })
      await expect(empA.getByTestId('receipt-number')).toHaveCount(2)
      const numberEur = await shownReceiptNumber((await lineOf(empA, motivoEur)).row)
      const numberChf = await shownReceiptNumber((await lineOf(empA, motivoChf)).row)
      expect(numberEur).toMatch(/^[A-Z]{2}26\/001$/)
      expect(numberChf).toMatch(/^[A-Z]{2}26\/002$/)

      // ─── 5. A type without a default: the approval is refused (AC-3.4) ───────────────────────────────────
      await openReview(acct, requestB)
      const gift = await lineOf(acct, motivoNoDefault)
      const giftPanel = (suffix = '') => acct.getByTestId(`classification-${gift.lineId}${suffix}`)
      await expect(giftPanel()).toBeVisible({ timeout: 20_000 })
      await expect(giftPanel('-account-field')).toContainText('Required to approve')

      await pressApprove(acct)
      const summary = acct.getByTestId('classification-missing-summary')
      await expect(summary).toBeVisible({ timeout: 15_000 })
      await expect(summary).toContainText('Nothing was approved')
      await expect(summary).toContainText('2 values need your attention')
      // the dialog is gone and the page is the same: the values to fix are on it, and focus is on the first of them
      await expect(acct.getByTestId('approve-dialog-confirm')).toHaveCount(0)
      await expect(acct.getByTestId('review-detail-decidable')).toBeVisible()
      await expect(giftPanel('-account')).toBeFocused({ timeout: 10_000 })
      await expect(giftPanel('-account-field').getByRole('alert')).toContainText('Choose an account')
      await expect(giftPanel('-vat-code-field').getByRole('alert')).toContainText('Choose a VAT code')

      // the summary shrinks as the values are chosen, and goes when none is missing
      await chooseByText(giftPanel('-account'), account.number)
      await expect(summary).toContainText('1 value needs your attention', { timeout: 10_000 })
      await chooseByText(giftPanel('-vat-code'), vat81.code)
      await expect(summary).not.toBeVisible({ timeout: 10_000 })
      await expect(giftPanel('-vat-amount')).toContainText('0.81') // CHF 10.00 at 8.1 %

      await pressApprove(acct)
      await expect(acct.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
      await expect(acct.getByTestId(`review-queue-row-${requestB}`)).toContainText(/approved/i, { timeout: 20_000 })

      // the refused attempt consumed no number: employee B's first request got 001 (AC-4.3)
      await empB.goto(`/refund/requests/${requestB}`)
      await expect(empB.getByTestId('request-detail-approved')).toBeVisible({ timeout: 20_000 })
      const numberGift = await shownReceiptNumber((await lineOf(empB, motivoNoDefault)).row)
      expect(numberGift).toMatch(/^[A-Z]{2}26\/001$/)

      // ─── 6. Compile, check the export card, download and parse the file (AC-6.1 to AC-6.4) ─────────────────
      await acct.goto('/refund/batches')
      await expect(acct.getByTestId('refund-batch-history-page')).toBeVisible({ timeout: 20_000 })
      await acct.getByTestId('batch-history-new-button').click()
      await expect(acct.getByTestId('refund-compile-batch-page')).toBeVisible({ timeout: 20_000 })
      await acct.getByTestId('compile-batch-preview-button').click()
      await expect(acct.getByTestId('compile-batch-preview')).toBeVisible({ timeout: 20_000 })
      await acct.getByTestId('compile-batch-compile-button').click()
      await expect(acct.getByTestId('compile-batch-confirm-modal')).toBeVisible({ timeout: 10_000 })
      await acct.getByTestId('compile-batch-confirm-confirm').click()

      await expect(acct.getByTestId('refund-batch-detail-page')).toBeVisible({ timeout: 20_000 })
      await expect(acct.getByTestId('batch-detail-loaded')).toBeVisible({ timeout: 20_000 })
      const batchId = (await acct.getByTestId('refund-batch-detail-id').textContent())?.trim()
      expect(batchId).toBeTruthy()

      // the numbers are on the batch page, in full (AC-4.9)
      await expect(
        acct.getByTestId(`batch-employee-group-${empASession.userId}-request-${requestA}-receipts`),
      ).toContainText(numberEur)
      await expect(
        acct.getByTestId(`batch-employee-group-${empASession.userId}-request-${requestA}-receipts`),
      ).toContainText(numberChf)
      await expect(
        acct.getByTestId(`batch-employee-group-${empBSession.userId}-request-${requestB}-receipts`),
      ).toContainText(numberGift)

      await expect(acct.getByTestId('accounting-export-card')).toBeVisible({ timeout: 20_000 })
      await expect(acct.getByTestId('accounting-export-ready')).toContainText('3 rows will be exported', {
        timeout: 30_000,
      })

      const [download] = await Promise.all([
        acct.waitForEvent('download'),
        acct.getByTestId('accounting-export-download').click(),
      ])
      const filename = download.suggestedFilename()
      expect(filename).toMatch(/^refund-accounting-\d{4}-\d{2}-\d{2}-/)
      expect(filename.endsWith(`-${batchId}.csv`)).toBe(true)
      await expect(acct.getByTestId('accounting-export-downloaded')).toContainText('Export downloaded: 3 rows')

      const filePath = await download.path()
      const text = await readFile(filePath, 'utf-8')
      expect(text.charCodeAt(0)).toBe(0xfeff) // the byte-order mark spreadsheets detect UTF-8 by
      expect(text.endsWith('\r\n')).toBe(true)

      const { header, rows } = parseAccountingCsv(text)
      expect(header).toEqual([...ACCOUNTING_CSV_HEADER])
      expect(rows).toHaveLength(3)
      // sorted by employee, then by the sequence of the number: A's EUR line (001), A's CHF line (002), B's line (001)
      expect(rows.map((row) => row['Receipt number'])).toEqual([numberEur, numberChf, numberGift])

      const csvEur = rows[0]!
      expect(csvEur).toMatchObject({
        Employee: empAName,
        'Expense date': '2026-03-02',
        'Expense type': 'Postal',
        Reason: motivoEur,
        Km: '',
        Currency: 'EUR',
        'Approved total': '10.40',
        'Exchange rate': EUR_RATE,
        'CHF amount': '9.62',
        'Account number': account.number,
        'Account name': account.name,
        'VAT code': noVat.code,
        'VAT rate (%)': '0.00',
        'VAT amount (CHF)': '0.00',
        Batch: batchId,
      })

      const csvChf = rows[1]!
      expect(csvChf).toMatchObject({
        Employee: empAName,
        'Expense date': '2026-03-04',
        'Expense type': 'Stationery',
        Reason: motivoChf,
        Currency: 'CHF',
        'Approved total': '20.80',
        'Exchange rate': '',
        'CHF amount': '20.80',
        'Account number': account.number,
        'VAT code': vat81.code,
        'VAT rate (%)': '8.10',
        'VAT amount (CHF)': '1.56',
        Batch: batchId,
      })

      const csvGift = rows[2]!
      expect(csvGift).toMatchObject({
        Employee: empBName,
        'Expense date': '2026-03-10',
        'Expense type': 'Representation — gifts',
        Reason: motivoNoDefault,
        Currency: 'CHF',
        'Approved total': '10.00',
        'CHF amount': '10.00',
        'Account number': account.number,
        'VAT code': vat81.code,
        'VAT rate (%)': '8.10',
        'VAT amount (CHF)': '0.81',
        Batch: batchId,
      })
    } finally {
      await restoreDefaults()
      await Promise.all([empAContext, empBContext, acctContext].map((context) => context.close()))
    }
  })
})
