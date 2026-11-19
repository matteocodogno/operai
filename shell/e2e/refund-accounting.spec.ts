/**
 * Refund accounting journey (specs/20261118-refund-accounting-export, T32, adapted by specs/20261119-accounting, T42 and, for the
 * 2026-11-19 accounting sign-off, T73; plan § Test strategy "e2e journey"; plan § Local development and e2e). Drives the REAL
 * assembled shell host + refund-ui remote (ADR 20260709-suite-frontend-module-federation) against the REAL refund-api,
 * accounting-api and auth services, no mocking, like this suite's other refund journeys (refund-headline.spec.ts,
 * refund-batches-headline.spec.ts).
 *
 * Journey:
 *   1. an employee submits three WellD CH lines: one in EUR, one in CHF, and a FLIGHT in CHF (no receipt number exists yet);
 *   2. accounting opens the request: each panel shows the type's DEFAULT ACCOUNT and, for the VAT code, "None": a VAT code is never
 *      pre-set, not for CHF and not for EUR (AC-3.1, AC-3.13), and a line without one shows no VAT amount (AC-3.8); the EUR line
 *      shows the rate 0.9246 and the CHF amount 9.62, all read from ACCOUNTING (AC-3.1);
 *   3. accounting sets a VAT code by hand on the CHF line (the amount reads 1.56), and then CLEARS it ("None" again); it sets
 *      one on the flight line and leaves it (AC-3.3, AC-3.11, AC-3.13);
 *   4. accounting approves: with an account on every line, two of the three lines carry no VAT code at all, and that is enough
 *      (AC-3.11); the employee sees the three receipt numbers, the earlier expense date first (AC-4.4, AC-4.9);
 *   5. a second employee's request, whose type has no default account, is REFUSED on approval: the dialog closes, an ErrorSummary
 *      names the one line that needs an ACCOUNT (and nothing about a VAT code), focus lands on its select, nothing is numbered
 *      (AC-3.4, AC-4.3); once the account is chosen it approves with no VAT code and gets number 001;
 *   6. a third request holds a EUR line in a past month where Accounting has NO rate: it is approved all the same, and shows
 *      "Rate pending" (AC-5.6);
 *   7. the March EUR rate is CORRECTED in Accounting to 0.9300: the lines already approved keep the rate they were booked with
 *      (the review page still reads 0.9246 and 9.62, AC-5.5);
 *   8. accounting compiles a batch: the export card is BLOCKED by the missing rate of the pending line (AC-5.6); it is the same
 *      card when Accounting cannot be read (the one answer says so, AC-6.6); a manager then enters the rate in Accounting, Check
 *      again says the export is ready, and the EXCEL FILE (`…/accounting-export/file`, an `.xlsx`) is downloaded and READ: sheet
 *      "Sheet 1", the eight columns `Date | Description | Debit | Credit | Amount | Currency | Tax | Note`, one row per line, the latest
 *      date first, the Description `<reason> [<receipt>] [EUR 10.40 = CHF 9.62] <name>` for a foreign line, the Amount `9.62` for EUR
 *      10.40 booked in March (AC-5.5) and `9.12` for the pending line that took the rate typed meanwhile (AC-5.6), the Debit the
 *      account, the Credit 5832, Tax and Note empty, and no formula anywhere (20261118 AC-6.2, AC-6.13 to AC-6.17). The old `…/csv`
 *      route answers 404.
 *
 * Fixtures (written through accounting-api and refund-api as a real admin, see helpers/accountingFixtures.ts and
 * helpers/refundFixtures.ts) so the journey does not depend on what the seeds say: a ledger account and an 8.1 % VAT code in
 * Accounting, the DEFAULT ACCOUNT of four expense types in Refund (by account number: a default has no VAT half and there is no
 * foreign-currency VAT code any more), and the EUR rate of 2026-03 (a month that is past whatever today is). The defaults it changes
 * are put back in `finally`; the new Accounting entries stay (they are append-only and named "E2E"). A rate typed for a month stays
 * in effect: the pending journey uses `unusedPastMonth` (a month with no EUR rate), which this run uses up, so a database supplies
 * about one such run per missing month (see accountingFixtures.ts).
 *
 * The accounting release marker comes from global-setup.ts (the seed of WellD CH's list, then `accounting:release --offsets` with a
 * header-only baseline file, so receipt numbers start at 001); without it every approval answers 409 `accounting_release_pending`
 * (E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 skips that step). The stack runs accounting-api with `ACCOUNTING_FX_SOURCE=off` (rates are
 * typed by hand): with `bazg` the journey also passes for March, because that rate is set explicitly, but a month the federal source
 * can answer would not stay "missing" for the pending line. A compile claims EVERY approved request, so the backlog other journeys
 * leave is paid out first (drainApprovedBacklog).
 *
 * AC proof by level: see plan § Test strategy. This file is the e2e level of AC-3.1, AC-3.3, AC-3.4, AC-3.11, AC-3.13, AC-4.9,
 * AC-5.5, AC-5.6, AC-6.1 to AC-6.4, AC-6.6, AC-6.13 to AC-6.17 of 20261118 and of 20261119's AC-5.5, AC-5.6 (and AC-8.1: the flight
 * is one of the fourteen types).
 */
import { readFile } from 'node:fs/promises'
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie } from './helpers/adminSession'
import {
  createLedgerAccount,
  createVatCode,
  setRate,
  uniqueCanonicalAccountNumber,
  uniqueVatCode,
  unusedPastMonth,
} from './helpers/accountingFixtures'
import { axeViolations } from './helpers/meetingsFixtures'
import {
  drainApprovedBacklog,
  freshToken,
  grantRefundAccounting,
  grantRefundEmployee,
  refundCall,
  setExpenseTypeDefault,
  snapshotAccountingDefaults,
} from './helpers/refundFixtures'
import {
  ACCOUNTING_SHEET_NAME,
  ACCOUNTING_XLSX_HEADER,
  isoDateOf,
  parseAccountingWorkbook,
  textOf,
  type AccountingRow,
} from './helpers/xlsxReader'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** The month of the journey's expense dates and its EUR rate (the federal average the plan's vectors use). */
const RATE_MONTH = '2026-03'
const EUR_RATE = '0.9246'
/** What accounting corrects the March rate to after the approvals: the approved lines keep EUR_RATE (AC-5.5). */
const CORRECTED_EUR_RATE = '0.9300'
/** What a manager types for the pending line's month once the export is blocked: EUR 10.00 at 0.9123 is CHF 9.12 (AC-5.6). */
const PENDING_RATE = '0.9123'

/** Four expense types the journey owns for its duration: three with a default account (one used by a EUR line, one the new flight), one with none. */
const CHF_TYPE = 'stationery'
const EUR_TYPE = 'postal'
const FLIGHT_TYPE = 'travel_flight'
const NO_DEFAULT_TYPE = 'representation_gifts'

/** What the journey's lines say in the file: the Credit of every row is "Rimborso spese effettive" (20261118 AC-6.2). */
const CREDIT_ACCOUNT = '5832'
/** The date format of the Date column and the format of the Amount column (20261118 SO-8). */
const DATE_FORMAT = 'yyyy\\-mm\\-dd;@'
const AMOUNT_FORMAT = '0.00'

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

/** Zero axe violations in the page's `main`, once transitions have ended (design § Accessibility layer 2). */
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

/**
 * Accounting cannot be read: a real outage cannot be made on this stack, so the one answer of a read says so, as refund-api
 * does when it cannot reach Accounting (AC-6.5, AC-6.6: the answer is still 200 and carries the state).
 */
const REVIEW_VIEW = /\/review\/requests\/[^/]+\/accounting$/
const EXPORT_SUMMARY = /\/batches\/[^/]+\/accounting-export$/

async function reviewViewUnavailable(route: Route): Promise<void> {
  if (route.request().method() !== 'GET') return route.fallback()
  const response = await route.fetch()
  const body = (await response.json()) as Record<string, unknown>
  return route.fulfill({ response, json: { ...body, accounting: 'unavailable' } })
}

async function exportSummaryUnavailable(route: Route): Promise<void> {
  if (route.request().method() !== 'GET') return route.fallback()
  const response = await route.fetch()
  const body = (await response.json()) as { blockers: Record<string, unknown> }
  return route.fulfill({
    response,
    json: { ...body, exportable: false, blockers: { ...body.blockers, missingRates: [], accountingUnavailable: true } },
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/20261119-accounting T73 (T32 of 20261118): accounting journey', () => {
  test('CHF, EUR and flight lines get a default account and no VAT code → a VAT code is set, cleared, set → approval numbers them → a type without a default account is refused → compile → the Excel file is downloaded and read + a rate-pending line, the March correction, export blocked then ready (AC-3.1/3.3/3.4/3.11/3.13/4.9/5.5/5.6/6.1/6.2/6.13/6.14/6.15/6.16/6.17)', async ({
    browser,
  }) => {
    // Three actors, three requests, a compile and a download: well beyond the 30 s default of the shorter journeys.
    test.setTimeout(240_000)
    const tag = uniqueSuffix()
    const adminEmail = `e2e-acct-admin-${tag}@operai.test`
    const empAEmail = `e2e-acct-emp-a-${tag}@operai.test`
    const empBEmail = `e2e-acct-emp-b-${tag}@operai.test`
    const acctEmail = `e2e-acct-acct-${tag}@operai.test`
    const empAName = 'E2E Accounting Employee A'
    const empBName = 'E2E Accounting Employee B'

    // Reasons the journey finds its lines by (the file's Description starts with them).
    const motivoChf = `Notebooks ${tag}`
    const motivoEur = `Stamps ${tag}`
    const motivoFlight = `Flight ${tag}`
    const motivoNoDefault = `Gift ${tag}`
    const motivoPending = `Courier ${tag}`

    const adminSession = await seedAdminSession(adminEmail, 'E2E Accounting Admin')
    const adminToken = await freshToken(adminSession.cookieHeader)
    const restoreDefaults = await snapshotAccountingDefaults(adminToken, [CHF_TYPE, EUR_TYPE, FLIGHT_TYPE, NO_DEFAULT_TYPE])

    const empASession = await seedUserSession(empAEmail, empAName)
    grantRefundEmployee(empAEmail)
    const empBSession = await seedUserSession(empBEmail, empBName)
    grantRefundEmployee(empBEmail)
    const acctSession = await seedUserSession(acctEmail, 'E2E Accounting Reviewer')
    grantRefundAccounting(acctEmail, 'global') // global: review + approve + set-approved-total, and a WellD CH scope for the export
    const acctToken = await freshToken(acctSession.cookieHeader)
    // A past month in which Accounting holds no EUR rate: a line dated in it is "rate pending" once approved (AC-5.6).
    const pendingMonth = await unusedPastMonth(adminToken, { currency: 'EUR', exclude: [RATE_MONTH] })

    const newContext = async (session: typeof acctSession) => {
      const context = await browser.newContext()
      await applySessionCookie(context, session)
      return context
    }
    const empAContext = await newContext(empASession)
    const empBContext = await newContext(empBSession)
    const acctContext = await newContext(acctSession)
    const adminContext = await newContext(adminSession)
    const empA = await empAContext.newPage()
    const empB = await empBContext.newPage()
    const acct = await acctContext.newPage()

    try {
      // ─── Fixtures: Accounting's entries and rate, Refund's default accounts by natural key ──────────────────
      await setRate(adminToken, RATE_MONTH, 'EUR', EUR_RATE)
      // a canonical number (no trailing zero), so the file writes the Debit as a number (20261118 AC-6.17)
      const account = await createLedgerAccount(adminToken, {
        number: uniqueCanonicalAccountNumber(),
        name: `E2E booking account ${tag}`,
      })
      const vat81 = await createVatCode(adminToken, { code: uniqueVatCode(), label: `E2E VAT 8.1 ${tag}`, ratePercent: '8.1' })
      for (const type of [CHF_TYPE, EUR_TYPE, FLIGHT_TYPE]) await setExpenseTypeDefault(adminToken, type, account.number)
      await setExpenseTypeDefault(adminToken, NO_DEFAULT_TYPE, null)

      await drainApprovedBacklog(acctToken)

      // ─── 1. The employees submit ──────────────────────────────────────────────────────────────────────────
      const requestA = await composeAndSubmit(empA, [
        { date: '2026-03-04', type: CHF_TYPE, motivo: motivoChf, amount: '20.80', currency: 'CHF' },
        { date: '2026-03-02', type: EUR_TYPE, motivo: motivoEur, amount: '10.40', currency: 'EUR' },
        { date: '2026-03-06', type: FLIGHT_TYPE, motivo: motivoFlight, amount: '20.80', currency: 'CHF' },
      ])
      // no number before the approval, and none shown to the employee as a placeholder
      await expect(empA.getByTestId('receipt-number')).toHaveCount(0)

      const requestB = await composeAndSubmit(empB, [
        { date: '2026-03-10', type: NO_DEFAULT_TYPE, motivo: motivoNoDefault, amount: '10.00', currency: 'CHF' },
      ])

      // ─── 2. Accounting sees the default account, and no VAT code on any line ─────────────────────────────
      await openReview(acct, requestA)
      const chf = await lineOf(acct, motivoChf)
      const eur = await lineOf(acct, motivoEur)
      const flight = await lineOf(acct, motivoFlight)
      const chfPanel = (suffix = '') => acct.getByTestId(`classification-${chf.lineId}${suffix}`)
      const eurPanel = (suffix = '') => acct.getByTestId(`classification-${eur.lineId}${suffix}`)
      const flightPanel = (suffix = '') => acct.getByTestId(`classification-${flight.lineId}${suffix}`)
      // the new type reads as itself on the line (AC-8.1 of 20261118)
      await expect(flight.row).toContainText('Travel — flight')

      for (const panel of [chfPanel, eurPanel, flightPanel]) {
        await expect(panel()).toBeVisible({ timeout: 20_000 })
        await expect(panel('-account').locator('option:checked')).toContainText(account.number)
        await expect(panel('-account-field')).toContainText('Default')
        // a VAT code is never pre-set: "None" on a CHF line and on a EUR line alike, with no marker and nothing "required"
        await expect(panel('-vat-code').locator('option:checked')).toHaveText('None')
        await expect(panel('-vat-code-field')).not.toContainText('Default')
        await expect(panel('-vat-code-field')).not.toContainText('Required')
        await expect(panel('-vat-code-field').getByRole('alert')).toHaveCount(0)
        // and a line without one shows no VAT amount (AC-3.8), not a zero
        await expect(panel('-vat-amount')).toContainText('No VAT code, so no VAT amount.')
        await expect(panel('-vat-amount')).not.toContainText('0.00')
      }
      // the rate in effect and the CHF amount: EUR 10.40 at 0.9246 is CHF 9.62 (the workbook's Amount, on the screen first)
      await expect(eurPanel('-rate')).toContainText(EUR_RATE)
      await expect(eurPanel('-chf')).toContainText('9.62')

      // ─── 3. Accounting sets a VAT code by hand, clears it, and sets one on the flight (AC-3.3, AC-3.13) ───
      await chooseByText(chfPanel('-vat-code'), vat81.code)
      await expect(chfPanel('-saved')).toContainText(vat81.code, { timeout: 10_000 })
      await expect(chfPanel('-account-field')).toContainText('Default') // only the VAT code was touched
      await expect(chfPanel('-vat-amount')).toContainText('1.56') // CHF 20.80 at 8.1 %
      await chfPanel('-vat-code').selectOption({ label: 'None' })
      await expect(chfPanel('-saved')).toContainText('VAT code cleared', { timeout: 10_000 })
      await expect(chfPanel('-vat-code').locator('option:checked')).toHaveText('None')
      await expect(chfPanel('-vat-amount')).toContainText('No VAT code, so no VAT amount.')

      await chooseByText(flightPanel('-vat-code'), vat81.code)
      await expect(flightPanel('-saved')).toContainText(vat81.code, { timeout: 10_000 })
      await expect(flightPanel('-vat-amount')).toContainText('1.56')

      // ─── approve: the request carries three lines with an account each, and a VAT code on ONE of them (AC-3.11) ──
      await pressApprove(acct)
      await expect(acct.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
      await expect(acct.getByTestId(`review-queue-row-${requestA}`)).toContainText(/approved/i, { timeout: 20_000 })

      // what was approved keeps what it held: no VAT code on two lines, one on the flight (AC-5.1 of 20261118)
      await acct.goto(`/refund/review/${requestA}`)
      await expect(chfPanel('-vat-amount')).toContainText('No VAT code, so no VAT amount.', { timeout: 20_000 })
      await expect(eurPanel('-vat-amount')).toContainText('No VAT code, so no VAT amount.')
      await expect(flightPanel('-vat-amount')).toContainText('1.56')

      // ─── 4. The employee sees the numbers (AC-4.9), the earlier expense date first in the sequence (AC-4.4) ──
      await empA.goto(`/refund/requests/${requestA}`)
      await expect(empA.getByTestId('request-detail-approved')).toBeVisible({ timeout: 20_000 })
      await expect(empA.getByTestId('receipt-number')).toHaveCount(3)
      const numberEur = await shownReceiptNumber((await lineOf(empA, motivoEur)).row)
      const numberChf = await shownReceiptNumber((await lineOf(empA, motivoChf)).row)
      const numberFlight = await shownReceiptNumber((await lineOf(empA, motivoFlight)).row)
      expect(numberEur).toMatch(/^[A-Z]{2}26\/001$/)
      expect(numberChf).toMatch(/^[A-Z]{2}26\/002$/)
      expect(numberFlight).toMatch(/^[A-Z]{2}26\/003$/)

      // ─── 5. A type without a default account: the approval is refused, for the account only (AC-3.4) ────────
      await openReview(acct, requestB)
      const gift = await lineOf(acct, motivoNoDefault)
      const giftPanel = (suffix = '') => acct.getByTestId(`classification-${gift.lineId}${suffix}`)
      await expect(giftPanel()).toBeVisible({ timeout: 20_000 })
      await expect(giftPanel('-account-field')).toContainText('Required to approve')
      await expect(giftPanel('-vat-code-field')).not.toContainText('Required')

      await pressApprove(acct)
      const summary = acct.getByTestId('classification-missing-summary')
      await expect(summary).toBeVisible({ timeout: 15_000 })
      await expect(summary).toContainText('Nothing was approved')
      await expect(summary).toContainText('1 line needs an account')
      await expect(summary).not.toContainText('VAT')
      // the dialog is gone and the page is the same: the value to fix is on it, and focus is on it
      await expect(acct.getByTestId('approve-dialog-confirm')).toHaveCount(0)
      await expect(acct.getByTestId('review-detail-decidable')).toBeVisible()
      await expect(giftPanel('-account')).toBeFocused({ timeout: 10_000 })
      await expect(giftPanel('-account-field').getByRole('alert')).toContainText('Choose an account')
      await expect(giftPanel('-vat-code-field').getByRole('alert')).toHaveCount(0)

      // the summary goes as soon as the account is chosen: the VAT code is not asked for
      await chooseByText(giftPanel('-account'), account.number)
      await expect(summary).not.toBeVisible({ timeout: 10_000 })
      await expect(giftPanel('-vat-amount')).toContainText('No VAT code, so no VAT amount.')

      await pressApprove(acct)
      await expect(acct.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
      await expect(acct.getByTestId(`review-queue-row-${requestB}`)).toContainText(/approved/i, { timeout: 20_000 })

      // the refused attempt consumed no number: employee B's first request got 001 (AC-4.3)
      await empB.goto(`/refund/requests/${requestB}`)
      await expect(empB.getByTestId('request-detail-approved')).toBeVisible({ timeout: 20_000 })
      const numberGift = await shownReceiptNumber((await lineOf(empB, motivoNoDefault)).row)
      expect(numberGift).toMatch(/^[A-Z]{2}26\/001$/)

      // ─── 6. A EUR line in a month Accounting has no rate for: approved all the same, "Rate pending" (AC-5.6) ──
      const requestC = await composeAndSubmit(empA, [
        { date: `${pendingMonth}-10`, type: CHF_TYPE, motivo: motivoPending, amount: '10.00', currency: 'EUR' },
      ])
      await openReview(acct, requestC)
      const pending = await lineOf(acct, motivoPending)
      const pendingPanel = (suffix = '') => acct.getByTestId(`classification-${pending.lineId}${suffix}`)
      await expect(pendingPanel('-rate-missing')).toContainText('No rate yet', { timeout: 20_000 })
      await pressApprove(acct)
      await expect(acct.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
      await expect(acct.getByTestId(`review-queue-row-${requestC}`)).toContainText(/approved/i, { timeout: 20_000 })
      await acct.goto(`/refund/review/${requestC}`)
      await expect(pendingPanel('-rate-pending')).toContainText('Rate pending', { timeout: 20_000 })
      await expectNoAxeViolations(acct, 'the review panel with Rate pending')

      // ─── Accounting cannot be read: the page says so once, the lines read as recorded (AC-6.5) ─────────────
      await acct.route(REVIEW_VIEW, reviewViewUnavailable)
      await acct.goto(`/refund/review/${requestA}`)
      await expect(acct.getByTestId('classification-accounting-unavailable')).toContainText('Accounting cannot be read now', {
        timeout: 20_000,
      })
      await expectNoAxeViolations(acct, 'the review page with Accounting unreadable')
      await acct.unroute(REVIEW_VIEW, reviewViewUnavailable)

      // ─── 7. The March rate is corrected in Accounting: what was approved keeps the rate it was booked with (AC-5.5) ──
      await setRate(adminToken, RATE_MONTH, 'EUR', CORRECTED_EUR_RATE)
      await acct.goto(`/refund/review/${requestA}`)
      await expect(acct.getByTestId(`classification-${eur.lineId}-rate`)).toContainText(EUR_RATE, { timeout: 20_000 })
      await expect(acct.getByTestId(`classification-${eur.lineId}-rate`)).not.toContainText(CORRECTED_EUR_RATE)
      await expect(acct.getByTestId(`classification-${eur.lineId}-chf`)).toContainText('9.62')

      const numberPending = await (async () => {
        await empA.goto(`/refund/requests/${requestC}`)
        await expect(empA.getByTestId('request-detail-approved')).toBeVisible({ timeout: 20_000 })
        return shownReceiptNumber((await lineOf(empA, motivoPending)).row)
      })()
      // its year follows its expense date (a month of 2025 is possible on a database that has used up the 2026 ones): any number will do here
      expect(numberPending).toMatch(/^[A-Z]{2}\d{2}\/\d{3,}$/)

      // ─── 8. Compile, check the export card, download and read the file (20261118 AC-6.1, AC-6.2, AC-6.13 to AC-6.17) ──
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
      for (const number of [numberEur, numberChf, numberFlight]) {
        await expect(acct.getByTestId(`batch-employee-group-${empASession.userId}-request-${requestA}-receipts`)).toContainText(number)
      }
      await expect(
        acct.getByTestId(`batch-employee-group-${empBSession.userId}-request-${requestB}-receipts`),
      ).toContainText(numberGift)

      // The pending line has no rate yet: the export is blocked by it, and says which rate is missing (AC-5.6).
      await expect(acct.getByTestId('accounting-export-card')).toBeVisible({ timeout: 20_000 })
      await expect(acct.getByTestId('accounting-export-blocked')).toBeVisible({ timeout: 30_000 })
      await expect(acct.getByTestId('accounting-export-missing-rates')).toContainText('EUR')
      // nothing else blocks it: every line has its account, and a missing VAT code never blocks (AC-3.11)
      await expect(acct.getByTestId('accounting-export-unclassified')).toHaveCount(0)
      await expect(acct.getByTestId('accounting-export-pending')).toContainText('1 line gets its exchange rate at this export')
      await expectNoAxeViolations(acct, 'the export card blocked by a missing rate')

      // Accounting cannot be read (the one answer says so): not a missing rate, its own heading (AC-6.6).
      await acct.route(EXPORT_SUMMARY, exportSummaryUnavailable)
      await acct.getByTestId('accounting-export-check-again').click()
      await expect(acct.getByTestId('accounting-export-unavailable')).toContainText('Accounting cannot be read', { timeout: 15_000 })
      await expect(acct.getByTestId('accounting-export-missing-rates')).toHaveCount(0)
      await expectNoAxeViolations(acct, 'the export card blocked by "Accounting cannot be read"')
      await acct.unroute(EXPORT_SUMMARY, exportSummaryUnavailable)

      // A manager enters the rate in Accounting, at the address a link of the export card opens (AC-7.3)...
      const adminPage = await adminContext.newPage()
      await adminPage.goto(`/accounting/exchange-rates?entity=welld_ch&month=${pendingMonth}`)
      const pendingCell = adminPage.getByTestId(`accounting-fx-cell-${pendingMonth}-EUR`)
      await expect(pendingCell).toContainText('Missing', { timeout: 30_000 })
      await adminPage.getByTestId(`accounting-fx-correct-${pendingMonth}-EUR`).click()
      await adminPage.getByTestId('accounting-fx-correction-value').fill(PENDING_RATE)
      await adminPage.getByTestId('accounting-fx-correction-submit').click()
      await expect(pendingCell).toContainText(PENDING_RATE, { timeout: 15_000 })
      await expect(pendingCell).toContainText('Corrected')

      // ...and Check again says the export is ready: 5 rows (A's three lines, A's pending line, B's line).
      await acct.getByTestId('accounting-export-check-again').click()
      await expect(acct.getByTestId('accounting-export-ready')).toContainText('5 rows will be exported', {
        timeout: 30_000,
      })
      await expect(acct.getByTestId('accounting-export-blocked')).toHaveCount(0)

      const [download] = await Promise.all([
        acct.waitForEvent('download'),
        acct.getByTestId('accounting-export-download').click(),
      ])
      const filename = download.suggestedFilename()
      expect(filename).toMatch(/^refund-accounting-\d{4}-\d{2}-\d{2}-/)
      expect(filename.endsWith(`-${batchId}.xlsx`)).toBe(true)
      await expect(acct.getByTestId('accounting-export-downloaded')).toContainText('Export downloaded: 5 rows')
      // the rate this export copied is frozen: nothing is pending any more
      await expect(acct.getByTestId('accounting-export-pending')).toHaveCount(0, { timeout: 15_000 })

      // the CSV is gone: its route answers 404, and asking for it writes nothing to the export log
      expect((await refundCall(acctToken, 'GET', `/batches/${batchId}/accounting-export/csv`)).status).toBe(404)

      const bytes = new Uint8Array(await readFile(await download.path()))
      expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK') // a ZIP package: an .xlsx, not text
      const book = parseAccountingWorkbook(bytes)
      expect(book.sheetNames).toEqual([ACCOUNTING_SHEET_NAME])
      expect(book.header).toEqual([...ACCOUNTING_XLSX_HEADER])
      // text reaches the file as text only: no cell holds a formula (AC-6.15)
      expect(book.workbook.formulaCells).toEqual([])
      expect(book.rows).toHaveLength(5)

      // the latest Date first (AC-6.16); the five dates differ, so the order is exactly that
      const dates = book.rows.map((row) => isoDateOf(row.cells['Date']))
      expect(dates).toEqual([...dates].sort().reverse())

      /** The row of one line, found by the reason its Description starts with. */
      const rowOf = (reason: string): AccountingRow => {
        const found = book.rows.filter((row) => textOf(row.cells['Description']).startsWith(`${reason} [`))
        if (found.length !== 1) throw new Error(`[refund-accounting] ${found.length} rows for ${reason} in the workbook`)
        return found[0]!
      }
      /** The eight cells of a row against what the line was booked as. `foreign` is `EUR 10.40 = CHF 9.62` for a line in another currency. */
      const expectRow = (
        reason: string,
        expected: { date: string; receipt: string; employee: string; amount: string; foreign?: string },
      ): void => {
        const { cells } = rowOf(reason)
        const description = `${reason} [${expected.receipt}]${expected.foreign ? ` [${expected.foreign}]` : ''} ${expected.employee}`
        expect(isoDateOf(cells['Date'])).toBe(expected.date)
        expect(cells['Date']?.style.formatCode).toBe(DATE_FORMAT)
        expect(cells['Description']).toMatchObject({ type: 'text', value: description })
        expect(cells['Description']?.style.quotePrefix).toBe(true) // a spreadsheet keeps it as text, whatever it starts with
        // Debit: the ledger account, a number because it is its own canonical decimal (AC-6.17); Credit: 5832
        expect(cells['Debit']).toMatchObject({ type: 'number', value: account.number })
        expect(cells['Credit']).toMatchObject({ type: 'number', value: CREDIT_ACCOUNT })
        // Amount: the CHF amount, a number with two decimals; Currency: always CHF
        expect(cells['Amount']).toMatchObject({ type: 'number', value: expected.amount })
        expect(cells['Amount']?.style.formatCode).toBe(AMOUNT_FORMAT)
        expect(cells['Currency']).toMatchObject({ type: 'text', value: 'CHF' })
        // Tax and Note are there and empty on every row (AC-6.14): the file carries no VAT at all
        expect(cells['Tax']?.type).toBe('empty')
        expect(cells['Note']?.type).toBe('empty')
      }

      // EUR 10.40 booked in March at 0.9246: the correction to 0.9300 made since does not reach it (AC-5.5). The Amount is 9.62.
      expectRow(motivoEur, { date: '2026-03-02', receipt: numberEur, employee: empAName, amount: '9.62', foreign: 'EUR 10.40 = CHF 9.62' })
      // a CHF line: no bracket for a currency, whether or not a VAT code was ever set on it
      expectRow(motivoChf, { date: '2026-03-04', receipt: numberChf, employee: empAName, amount: '20.80' })
      // the flight (a new type, with the one VAT code the journey set): the file says nothing of it
      expectRow(motivoFlight, { date: '2026-03-06', receipt: numberFlight, employee: empAName, amount: '20.80' })
      expectRow(motivoNoDefault, { date: '2026-03-10', receipt: numberGift, employee: empBName, amount: '10.00' })
      // the pending line carries the rate typed meanwhile, copied by this export (AC-5.6): EUR 10.00 at 0.9123 is CHF 9.12
      expectRow(motivoPending, {
        date: `${pendingMonth}-10`,
        receipt: numberPending,
        employee: empAName,
        amount: '9.12',
        foreign: 'EUR 10.00 = CHF 9.12',
      })
    } finally {
      await restoreDefaults()
      await Promise.all([empAContext, empBContext, acctContext, adminContext].map((context) => context.close()))
    }
  })
})
