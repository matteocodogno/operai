/**
 * T15 — Monthly refund processing headline e2e journeys
 * (specs/008-refund-monthly-processing, QE verification pass). Drives the
 * REAL assembled shell host + refund-ui remote (ADR-0006) against the REAL
 * refund-api/auth/notify-api services — no mocking — mirroring
 * refund-headline.spec.ts's (specs/007) own cross-app e2e convention.
 *
 * Journey 1 (US-1/2/3/4/5, AC-1.1/1.2/1.6/2.1/3.1/3.2/4.1/5.1/5.2/5.3): two
 * employees each compose a single-line request in a DIFFERENT entity/currency
 * (WellD Italia/EUR, WellD Svizzera/CHF) → submit → a global-scoped accounting
 * user approves both → compiles them into ONE mixed-employee/mixed-currency
 * batch (cutoff defaults to "now", AC-1.1) → the compiled batch shows both
 * employees with per-currency subtotals never blended (AC-1.6) → downloads
 * the PDF (mints a fresh presigned link, AC-2.1/3.5) → sees the compilation
 * email's delivery status surfaced in-app (AC-3.2 — asserted as VISIBLE,
 * "sent" or "failed", never asserted as a specific outcome since this local
 * run has no guaranteed live Resend delivery, matching AC-3.2's actual
 * requirement: the status is shown, not that delivery always succeeds) →
 * marks the batch paid (AC-4.1) → both employees see their own request as
 * `paid` with a paid date (AC-5.2), the 007 monthly-processing note gone
 * (AC-5.3), and a real in-app `paid` notification via notify-api (AC-5.1).
 *
 * Journey 2 (US-6, AC-6.1/6.2/6.3): a third employee's approved request is
 * compiled into its own batch, then discarded before being paid — the batch
 * itself remains inspectable (discardedAt/discardedBy, AC-6.3) and the
 * released request is immediately re-eligible: proven by compiling it again
 * into a brand-new batch (AC-6.1), which mark-paid then finalizes.
 *
 * DELIBERATELY no attachment step (mirrors 007's own e2e — attachments are
 * always optional and out of this feature's own scope). No real EU object
 * storage bucket is provisioned for local/CI e2e — the compiled PDF's
 * presigned link is still minted and asserted to open successfully (refund-api's
 * `mintPresignedGet` is a local signing computation, no network round-trip
 * required to produce the URL itself); the underlying `PutObject`/actual
 * bytes may or may not be reachable in this environment, which is why this
 * journey does not assert on the opened tab's actual PDF *content*, only
 * that the mint succeeded (no inline error state) and a same-origin-signed
 * URL opened.
 *
 * Fixtures: refundFixtures.ts (grantRefundEmployee/grantRefundAccounting) —
 * same real Role/PermissionRule/UserRole rows a real admin would grant.
 * grantRefundAccounting(email, 'global') bundles review+approve+set-approved-total+reject
 * unconditioned (plan.md § Resolved decisions D3 — the SAME capability
 * already gates approve/reject also gates mark-paid, no separate permission).
 */
import { test, expect, type Page } from '@playwright/test'
import { seedUserSession, applySessionCookie } from './helpers/adminSession'
import { grantRefundEmployee, grantRefundAccounting } from './helpers/refundFixtures'

const NOTIFY_API_URL =
  process.env['E2E_NOTIFY_API_URL'] ?? process.env['VITE_NOTIFY_API_URL'] ?? 'http://localhost:8081'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** Composes a single expense line and submits the draft, returning the request id (mirrors refund-headline.spec.ts). */
async function composeAndSubmit(
  page: Page,
  line: { date: string; type: string; motivo: string; amount: string; entity: string; km?: string },
): Promise<string> {
  await page.goto('/refund/requests')
  await expect(page.getByTestId('refund-my-requests-page')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('my-requests-new-button').click()
  await expect(page.getByTestId('refund-request-detail-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('request-detail-draft')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('composer-date').fill(line.date)
  await page.getByTestId('composer-type').selectOption(line.type)
  await page.getByTestId('composer-motivo').fill(line.motivo)
  await page.getByTestId('composer-amount').fill(line.amount)
  await page.getByTestId('composer-entity').selectOption(line.entity)
  if (line.km) await page.getByTestId('composer-km').fill(line.km)
  await page.getByTestId('composer-add-button').click()
  await expect(page.locator('[data-testid^="expense-line-row-"]')).toHaveCount(1, { timeout: 10_000 })

  await page.getByTestId('request-detail-submit').click()
  await expect(page.getByTestId('request-detail-submitted')).toBeVisible({ timeout: 20_000 })

  const requestId = await page.getByTestId('refund-request-detail-id').textContent()
  expect(requestId).toBeTruthy()
  return requestId as string
}

/** Approves a submitted request from the review queue, at whatever approved total the server defaults to (untouched). */
async function approveFromQueue(page: Page, requestId: string): Promise<void> {
  await page.goto('/refund/review')
  await expect(page.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
  const row = page.getByTestId(`review-queue-row-${requestId}`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()

  await expect(page.getByTestId('refund-review-detail-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('review-detail-decidable')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('review-detail-approve').click()
  await expect(page.getByTestId('approve-dialog-confirm')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('approve-dialog-confirm').click()

  await expect(page.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId(`review-queue-row-${requestId}`)).toHaveCount(0)
}

/** Polls notify-api's REST notification list directly (no UI dependency) — proves a push landed. */
async function fetchNotifications(token: string): Promise<{ items: { title: string; link: { href: string } | null }[] }> {
  const res = await fetch(`${NOTIFY_API_URL}/notifications`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET /notifications failed (${res.status})`)
  return res.json()
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/008-refund-monthly-processing T15: headline journeys', () => {
  test('Journey 1 — cutoff defaults to now → preview → compile a mixed-employee/mixed-currency batch → PDF + email status → mark paid → both employees see paid (AC-1.1/1.2/1.6/2.1/3.1/3.2/4.1/5.1/5.2/5.3)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const empAEmail = `e2e-batch-empA-${tag}@operai.test`
    const empBEmail = `e2e-batch-empB-${tag}@operai.test`
    const acctEmail = `e2e-batch-acct-${tag}@operai.test`

    const empASession = await seedUserSession(empAEmail, 'E2E Batch Employee A')
    grantRefundEmployee(empAEmail)
    const empBSession = await seedUserSession(empBEmail, 'E2E Batch Employee B')
    grantRefundEmployee(empBEmail)
    const acctSession = await seedUserSession(acctEmail, 'E2E Batch Accounting')
    grantRefundAccounting(acctEmail, 'global') // global — bundles review+approve, needed for compile AND mark-paid

    // ─── Employee A: WellD Italia / EUR ────────────────────────────────────
    const empAContext = await browser.newContext()
    await applySessionCookie(empAContext, empASession)
    const empAPage = await empAContext.newPage()
    const requestAId = await composeAndSubmit(empAPage, {
      date: '2026-07-01',
      type: 'office_material',
      motivo: `Batch fixture A ${tag}`,
      amount: '75',
      entity: 'welld_it',
    })

    // ─── Employee B: WellD Svizzera / CHF ──────────────────────────────────
    const empBContext = await browser.newContext()
    await applySessionCookie(empBContext, empBSession)
    const empBPage = await empBContext.newPage()
    const requestBId = await composeAndSubmit(empBPage, {
      date: '2026-07-02',
      type: 'travel_km',
      motivo: `Batch fixture B ${tag}`,
      amount: '45',
      entity: 'welld_ch',
      km: '80',
    })

    // ─── Accounting: approve both (untouched approved totals) ──────────────
    const acctContext = await browser.newContext()
    await applySessionCookie(acctContext, acctSession)
    const acctPage = await acctContext.newPage()
    await approveFromQueue(acctPage, requestAId)
    await approveFromQueue(acctPage, requestBId)

    // ─── Accounting: batch history → compile new batch ─────────────────────
    await acctPage.goto('/refund/batches')
    await expect(acctPage.getByTestId('refund-batch-history-page')).toBeVisible({ timeout: 20_000 })
    await acctPage.getByTestId('batch-history-new-button').click()

    await expect(acctPage.getByTestId('refund-compile-batch-page')).toBeVisible({ timeout: 20_000 })
    // AC-1.1: cutoff pre-filled to "now" — no override needed, both requests
    // were just decided moments ago.
    await expect(acctPage.getByTestId('compile-batch-cutoff-input')).toHaveValue(/.+/)
    await acctPage.getByTestId('compile-batch-preview-button').click()

    // AC-1.2/1.6: the candidate preview groups BOTH employees, per-currency.
    await expect(acctPage.getByTestId('compile-batch-preview')).toBeVisible({ timeout: 20_000 })
    const previewGroups = acctPage.locator('[data-testid^="batch-employee-group-"]')
    await expect(previewGroups).toHaveCount(2)
    await expect(acctPage.getByText('75,00 €')).toBeVisible()
    await expect(acctPage.getByText('45,00 CHF')).toBeVisible()

    await acctPage.getByTestId('compile-batch-compile-button').click()
    await expect(acctPage.getByTestId('compile-batch-confirm-modal')).toBeVisible({ timeout: 10_000 })
    await acctPage.getByTestId('compile-batch-confirm-confirm').click()

    // ─── Screen B3: the newly compiled batch ────────────────────────────────
    await expect(acctPage.getByTestId('refund-batch-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId('batch-detail-loaded')).toBeVisible({ timeout: 20_000 })
    const batchId = await acctPage.getByTestId('refund-batch-detail-id').textContent()
    expect(batchId).toBeTruthy()

    // AC-1.6/2.1: per-employee, per-currency subtotals never blended, on the REAL persisted batch.
    await expect(acctPage.getByText('75,00 €')).toBeVisible()
    await expect(acctPage.getByText('45,00 CHF')).toBeVisible()
    const detailGroups = acctPage.locator('[data-testid^="batch-employee-group-"]')
    await expect(detailGroups).toHaveCount(2)

    // AC-3.1/3.2: the compilation email was auto-attempted on compile, and
    // its delivery status is visibly shown — asserted as VISIBLE, not a
    // specific outcome (this env has no guaranteed live Resend delivery).
    const emailStatusText = await acctPage.getByTestId('batch-detail-email-status').textContent()
    expect(emailStatusText).toBeTruthy()
    expect(emailStatusText).not.toMatch(/^\s*$/)

    // AC-2.1/3.5: the PDF link mints a fresh presigned GET and opens — no
    // inline mint-error state. Content itself is not asserted (no live EU
    // bucket guaranteed in this env — see file header).
    const pdfLinkButton = acctPage.getByTestId(`batch-pdf-link-${batchId}`)
    await expect(pdfLinkButton).toBeVisible()
    const [pdfPopup] = await Promise.all([acctPage.waitForEvent('popup', { timeout: 15_000 }), pdfLinkButton.click()])
    expect(pdfPopup.url()).toMatch(/^https?:\/\//)
    await pdfPopup.close()
    await expect(acctPage.getByTestId(`batch-pdf-link-${batchId}-error`)).toHaveCount(0)

    // ─── Mark as paid (AC-4.1/4.2) ──────────────────────────────────────────
    await acctPage.getByTestId('batch-detail-mark-paid').click()
    await expect(acctPage.getByTestId('mark-paid-dialog-modal')).toBeVisible({ timeout: 10_000 })
    // Requires the acknowledgement checkbox before Confirm is enabled.
    await expect(acctPage.getByTestId('mark-paid-dialog-confirm')).toBeDisabled()
    await acctPage.getByTestId('mark-paid-dialog-checkbox').check()
    await expect(acctPage.getByTestId('mark-paid-dialog-confirm')).toBeEnabled()
    await acctPage.getByTestId('mark-paid-dialog-confirm').click()

    await expect(acctPage.getByTestId('batch-detail-paid-line')).toBeVisible({ timeout: 20_000 })

    // ─── Employee A sees `paid` (AC-5.2/5.3) ────────────────────────────────
    await empAPage.goto(`/refund/requests/${requestAId}`)
    await expect(empAPage.getByTestId('request-detail-paid')).toBeVisible({ timeout: 20_000 })
    await expect(empAPage.getByTestId('request-detail-paid-line')).toBeVisible()
    await expect(empAPage.getByTestId('monthly-processing-note')).toHaveCount(0)

    // ─── Employee B sees `paid` too (AC-5.2/5.3) ────────────────────────────
    await empBPage.goto(`/refund/requests/${requestBId}`)
    await expect(empBPage.getByTestId('request-detail-paid')).toBeVisible({ timeout: 20_000 })
    await expect(empBPage.getByTestId('request-detail-paid-line')).toBeVisible()
    await expect(empBPage.getByTestId('monthly-processing-note')).toHaveCount(0)

    // AC-5.1: a real in-app `paid` notification was pushed to EACH owner.
    await expect
      .poll(
        async () => {
          const { items } = await fetchNotifications(empASession.token)
          return items.some((n) => n.link?.href === `/refund/requests/${requestAId}` && /paid/i.test(n.title))
        },
        { timeout: 15_000, message: 'expected an in-app `paid` notification for employee A' },
      )
      .toBe(true)
    await expect
      .poll(
        async () => {
          const { items } = await fetchNotifications(empBSession.token)
          return items.some((n) => n.link?.href === `/refund/requests/${requestBId}` && /paid/i.test(n.title))
        },
        { timeout: 15_000, message: 'expected an in-app `paid` notification for employee B' },
      )
      .toBe(true)

    // ─── Batch history reflects the terminal `paid` status (AC-8.1/8.2) ─────
    await acctPage.goto('/refund/batches')
    await expect(acctPage.getByTestId('refund-batch-history-page')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId(`batch-history-row-${batchId}`)).toContainText(/paid/i)

    await empAContext.close()
    await empBContext.close()
    await acctContext.close()
  })

  test('Journey 2 — discard a compiled batch before payment: it stays inspectable, and its request is immediately re-eligible for a future compile (AC-6.1/6.2/6.3)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const empEmail = `e2e-batch-empC-${tag}@operai.test`
    const acctEmail = `e2e-batch-acct2-${tag}@operai.test`

    const empSession = await seedUserSession(empEmail, 'E2E Batch Employee C')
    grantRefundEmployee(empEmail)
    const acctSession = await seedUserSession(acctEmail, 'E2E Batch Accounting 2')
    grantRefundAccounting(acctEmail, 'global')

    const empContext = await browser.newContext()
    await applySessionCookie(empContext, empSession)
    const empPage = await empContext.newPage()
    const requestId = await composeAndSubmit(empPage, {
      date: '2026-07-03',
      type: 'stationery',
      motivo: `Discard fixture ${tag}`,
      amount: '20',
      entity: 'welld_it',
    })

    const acctContext = await browser.newContext()
    await applySessionCookie(acctContext, acctSession)
    const acctPage = await acctContext.newPage()
    await approveFromQueue(acctPage, requestId)

    // ─── Compile batch A (solo request) ─────────────────────────────────────
    await acctPage.goto('/refund/batches/new')
    await expect(acctPage.getByTestId('refund-compile-batch-page')).toBeVisible({ timeout: 20_000 })
    await acctPage.getByTestId('compile-batch-preview-button').click()
    await expect(acctPage.getByTestId('compile-batch-preview')).toBeVisible({ timeout: 20_000 })
    await acctPage.getByTestId('compile-batch-compile-button').click()
    await expect(acctPage.getByTestId('compile-batch-confirm-modal')).toBeVisible({ timeout: 10_000 })
    await acctPage.getByTestId('compile-batch-confirm-confirm').click()

    await expect(acctPage.getByTestId('refund-batch-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId('batch-detail-loaded')).toBeVisible({ timeout: 20_000 })
    const batchAId = await acctPage.getByTestId('refund-batch-detail-id').textContent()
    expect(batchAId).toBeTruthy()

    // ─── Discard batch A before it's paid (AC-6.1) ──────────────────────────
    await acctPage.getByTestId('batch-detail-discard').click()
    await expect(acctPage.getByTestId('batch-discard-confirm-modal')).toBeVisible({ timeout: 10_000 })
    await acctPage.getByTestId('batch-discard-confirm-confirm').click()

    // AC-6.3: the discarded batch remains inspectable — status/stamp visible,
    // and its (now-released) member request row still shows.
    await expect(acctPage.getByTestId('batch-detail-discarded-line')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.locator('[data-testid^="batch-employee-group-"]')).toHaveCount(1)
    // Mark-as-paid/Discard controls are structurally gone now (terminal, AC-6.2).
    await expect(acctPage.getByTestId('batch-detail-mark-paid')).toHaveCount(0)
    await expect(acctPage.getByTestId('batch-detail-discard')).toHaveCount(0)

    // ─── AC-6.1: the released request is immediately re-eligible — proven by
    // successfully compiling it into a BRAND NEW batch B ─────────────────────
    await acctPage.goto('/refund/batches/new')
    await expect(acctPage.getByTestId('refund-compile-batch-page')).toBeVisible({ timeout: 20_000 })
    await acctPage.getByTestId('compile-batch-preview-button').click()
    await expect(acctPage.getByTestId('compile-batch-preview')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.locator('[data-testid^="batch-employee-group-"]')).toHaveCount(1)
    await acctPage.getByTestId('compile-batch-compile-button').click()
    await expect(acctPage.getByTestId('compile-batch-confirm-modal')).toBeVisible({ timeout: 10_000 })
    await acctPage.getByTestId('compile-batch-confirm-confirm').click()

    await expect(acctPage.getByTestId('refund-batch-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId('batch-detail-loaded')).toBeVisible({ timeout: 20_000 })
    const batchBId = await acctPage.getByTestId('refund-batch-detail-id').textContent()
    expect(batchBId).toBeTruthy()
    expect(batchBId).not.toBe(batchAId)

    // Finalize batch B — the request that was once discarded from A is now
    // genuinely, permanently paid via B.
    await acctPage.getByTestId('batch-detail-mark-paid').click()
    await expect(acctPage.getByTestId('mark-paid-dialog-modal')).toBeVisible({ timeout: 10_000 })
    await acctPage.getByTestId('mark-paid-dialog-checkbox').check()
    await acctPage.getByTestId('mark-paid-dialog-confirm').click()
    await expect(acctPage.getByTestId('batch-detail-paid-line')).toBeVisible({ timeout: 20_000 })

    await empPage.goto(`/refund/requests/${requestId}`)
    await expect(empPage.getByTestId('request-detail-paid')).toBeVisible({ timeout: 20_000 })

    // Batch A's own history entry is untouched by B's later compile —
    // discard voided its effect, it did not erase the record (AC-6.3).
    await acctPage.goto('/refund/batches')
    await expect(acctPage.getByTestId('refund-batch-history-page')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId(`batch-history-row-${batchAId}`)).toContainText(/discarded/i)
    await expect(acctPage.getByTestId(`batch-history-row-${batchBId}`)).toContainText(/paid/i)

    await empContext.close()
    await acctContext.close()
  })
})
