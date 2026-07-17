/**
 * T21 — Refund headline e2e journeys (specs/007-refund-service, QE
 * verification pass). Drives the REAL assembled shell host + refund-ui
 * remote (ADR-0006) against the REAL refund-api/auth/notify-api services —
 * no mocking — mirroring this suite's existing cross-app e2e convention
 * (invitations.spec.ts, notifications.spec.ts, refund-placeholder.spec.ts).
 *
 * Journey 1 (US-1/2/3/5/6/7, AC-2.1/3.2/3.6/6.5/7.2): an employee composes a
 * mixed-entity request (a WellD Italia line + a WellD CH travel-km line) →
 * submits → a single-entity-scoped accounting user opens the SAME
 * mixed-entity request (AC-6.5: sees ALL lines, including the out-of-scope
 * CHF one), adjusts the EUR line's approved total, approves (AC-7.6: the
 * whole request decides, not just the in-scope line) → the employee sees
 * requested-vs-approved (AC-3.2), the monthly-processing note (AC-4.1), and
 * a real in-app notification via notify-api's REST surface (AC-3.6).
 *
 * Journey 2 (US-7, AC-7.3/3.3): a single-line request, rejected with a
 * required motivation, which the employee then sees on their own detail.
 *
 * DELIBERATELY no attachment step (AC-1.7: attachments are always
 * optional — omitting one never blocks submission). No real EU
 * object-storage bucket is provisioned for local/CI e2e (refund-api's
 * `REFUND_S3_*` point at a placeholder endpoint locally) — actually
 * completing a presigned-POST upload here would either hang on DNS or
 * require faking refund-api's own server-side HEAD-confirm call, which
 * Playwright's browser-side `page.route()` cannot intercept (that call
 * never reaches the browser). The mint→upload→confirm flow itself IS
 * covered elsewhere: refund-api's T9 integration tests (storage mocked)
 * and refund-ui's T17 component tests (AttachmentList/RequestDetailPage,
 * all passing) exercise the exact same code these journeys would otherwise
 * click through.
 *
 * Fixtures: refundFixtures.ts (grantRefundEmployee/grantRefundAccounting)
 * grants the REAL Role/PermissionRule/UserRole rows a real admin would grant
 * via the specs/004 admin GUI — refund-api's `GET /authz/resolve` resolves
 * these test users through the exact same code path as production.
 */
import { test, expect, type Page } from '@playwright/test'
import { seedUserSession, applySessionCookie } from './helpers/adminSession'
import { grantRefundEmployee, grantRefundAccounting } from './helpers/refundFixtures'

const NOTIFY_API_URL =
  process.env['E2E_NOTIFY_API_URL'] ?? process.env['VITE_NOTIFY_API_URL'] ?? 'http://localhost:8081'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** Waits for the composer's "Add line" button to re-enable, then submits it and waits for the row to appear. */
async function addExpenseLine(
  page: Page,
  line: { date: string; type: string; motivo: string; amount: string; entity: string; km?: string },
) {
  await page.getByTestId('composer-date').fill(line.date)
  await page.getByTestId('composer-type').selectOption(line.type)
  await page.getByTestId('composer-motivo').fill(line.motivo)
  await page.getByTestId('composer-amount').fill(line.amount)
  await page.getByTestId('composer-entity').selectOption(line.entity)
  if (line.km) {
    await page.getByTestId('composer-km').fill(line.km)
  }
  const rowsBefore = await page.locator('[data-testid^="expense-line-row-"]').count()
  await page.getByTestId('composer-add-button').click()
  await expect(page.locator('[data-testid^="expense-line-row-"]')).toHaveCount(rowsBefore + 1, { timeout: 10_000 })
}

/** Polls notify-api's REST notification list directly (no UI dependency) — proves the push landed (AC-3.6). */
async function fetchNotifications(token: string): Promise<{ items: { title: string; body: string; link: { href: string } | null }[] }> {
  const res = await fetch(`${NOTIFY_API_URL}/notifications`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`GET /notifications failed (${res.status})`)
  return res.json()
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/007-refund-service T21: headline journeys', () => {
  test('Journey 1 — mixed-entity compose → submit → scoped accounting adjusts + approves → employee sees requested-vs-approved, notification, monthly note (AC-2.1/3.2/3.6/4.1/6.5/7.2/7.6)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const empEmail = `e2e-refund-emp-${tag}@operai.test`
    const acctEmail = `e2e-refund-acct-${tag}@operai.test`

    const empSession = await seedUserSession(empEmail, 'E2E Refund Employee')
    grantRefundEmployee(empEmail)
    const acctSession = await seedUserSession(acctEmail, 'E2E Refund Accounting')
    grantRefundAccounting(acctEmail, 'welld_it') // single-entity scope — deliberately NOT global, to prove AC-6.5/7.6

    // ─── Employee: compose a mixed-entity request ──────────────────────────
    const empContext = await browser.newContext()
    await applySessionCookie(empContext, empSession)
    const empPage = await empContext.newPage()

    await empPage.goto('/refund/requests')
    await expect(empPage.getByTestId('refund-my-requests-page')).toBeVisible({ timeout: 20_000 })
    await empPage.getByTestId('my-requests-new-button').click()

    await expect(empPage.getByTestId('refund-request-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(empPage.getByTestId('request-detail-draft')).toBeVisible({ timeout: 20_000 })

    // Line 1 — WellD Italia (EUR), a plain expense type.
    await addExpenseLine(empPage, {
      date: '2026-07-01',
      type: 'office_material',
      motivo: `Notebook ${tag}`,
      amount: '50',
      entity: 'welld_it',
    })
    // Line 2 — WellD CH (CHF), travel_km — proves the type-driven km field (AC-1.2) and the mixed-entity request (AC-3.5).
    await addExpenseLine(empPage, {
      date: '2026-07-02',
      type: 'travel_km',
      motivo: `Client visit ${tag}`,
      amount: '30',
      entity: 'welld_ch',
      km: '120',
    })

    // Per-currency subtotals — never blended (AC-3.5).
    await expect(empPage.getByTestId('subtotals-panel-card-welld_it')).toContainText('50,00 €')
    await expect(empPage.getByTestId('subtotals-panel-card-welld_ch')).toContainText('30,00 CHF')

    await empPage.getByTestId('request-detail-submit').click()
    await expect(empPage.getByTestId('request-detail-submitted')).toBeVisible({ timeout: 20_000 })

    const requestId = await empPage.getByTestId('refund-request-detail-id').textContent()
    expect(requestId).toBeTruthy()

    // ─── Accounting (scoped to welld_it only): review, adjust, approve ─────
    const acctContext = await browser.newContext()
    await applySessionCookie(acctContext, acctSession)
    const acctPage = await acctContext.newPage()

    await acctPage.goto('/refund/review')
    await expect(acctPage.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
    const queueRow = acctPage.getByTestId(`review-queue-row-${requestId}`)
    await expect(queueRow).toBeVisible({ timeout: 20_000 })
    await queueRow.click()

    await expect(acctPage.getByTestId('refund-review-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId('review-detail-decidable')).toBeVisible({ timeout: 20_000 })

    // AC-6.5: an accounting user scoped to welld_it ONLY still sees BOTH
    // lines of this mixed-entity request, including the welld_ch one.
    const lineRows = acctPage.locator('[data-testid^="expense-line-row-"]')
    await expect(lineRows).toHaveCount(2)
    await expect(acctPage.getByText(`Notebook ${tag}`)).toBeVisible()
    await expect(acctPage.getByText(`Client visit ${tag}`)).toBeVisible()

    // Adjust the EUR (in-scope) line's approved total down from 50,00 to 40,00.
    const notebookRow = lineRows.filter({ hasText: `Notebook ${tag}` })
    const approvedInput = notebookRow.locator('input[type="number"]')
    await approvedInput.fill('40')
    await approvedInput.blur()
    // Wait for the write-on-blur PUT to settle (no more "Saving…" indicator).
    await expect(notebookRow.getByText('Saving…')).toHaveCount(0, { timeout: 10_000 })

    await acctPage.getByTestId('review-detail-approve').click()
    await expect(acctPage.getByTestId('approve-dialog-confirm')).toBeVisible({ timeout: 10_000 })
    await acctPage.getByTestId('approve-dialog-confirm').click()

    // AC-7.6: approving a mixed-entity request from a single-entity-scoped
    // user decides the WHOLE request — returns to the queue, row is gone.
    await expect(acctPage.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId(`review-queue-row-${requestId}`)).toHaveCount(0)

    // ─── Employee: sees requested-vs-approved, the monthly note ────────────
    await empPage.goto(`/refund/requests/${requestId}`)
    await expect(empPage.getByTestId('request-detail-approved')).toBeVisible({ timeout: 20_000 })

    // AC-3.2: requested vs approved per line — the adjusted EUR line and the
    // untouched CHF line (AC-7.2's server-side default to requested amount).
    const approvedNotebookRow = empPage.locator('[data-testid^="expense-line-row-"]').filter({ hasText: `Notebook ${tag}` })
    await expect(approvedNotebookRow).toContainText('50,00 €') // requested
    await expect(approvedNotebookRow).toContainText('40,00 €') // approved (adjusted)
    const approvedTravelRow = empPage.locator('[data-testid^="expense-line-row-"]').filter({ hasText: `Client visit ${tag}` })
    await expect(approvedTravelRow).toContainText('30,00 CHF') // requested == approved (defaulted, untouched)

    // AC-4.1: the monthly-processing note appears once decided (approved).
    await expect(empPage.getByTestId('monthly-processing-note')).toBeVisible()

    // AC-3.6: a real in-app notification was pushed via notify-api — checked
    // directly against notify-api's own REST surface (no UI dependency on
    // the shell's bell, which is out of this feature's own scope, ADR-0009).
    const empToken = empSession.token
    await expect
      .poll(async () => {
        const { items } = await fetchNotifications(empToken)
        return items.some((n) => n.link?.href === `/refund/requests/${requestId}` && /approved/i.test(n.title))
      }, { timeout: 15_000, message: 'expected an in-app notification for the approved decision' })
      .toBe(true)

    await empContext.close()
    await acctContext.close()
  })

  test('Journey 2 — reject with a required motivation, employee sees it on their own detail (AC-7.3/3.3)', async ({ browser }) => {
    const tag = uniqueSuffix()
    const empEmail = `e2e-refund-emp2-${tag}@operai.test`
    const acctEmail = `e2e-refund-acct2-${tag}@operai.test`

    const empSession = await seedUserSession(empEmail, 'E2E Refund Employee 2')
    grantRefundEmployee(empEmail)
    const acctSession = await seedUserSession(acctEmail, 'E2E Refund Accounting 2')
    grantRefundAccounting(acctEmail, 'global') // global reviewer — proves the "widest-wins union" composition (AC-5.5)

    const empContext = await browser.newContext()
    await applySessionCookie(empContext, empSession)
    const empPage = await empContext.newPage()

    await empPage.goto('/refund/requests/new')
    await expect(empPage.getByTestId('request-detail-draft')).toBeVisible({ timeout: 20_000 })

    await addExpenseLine(empPage, {
      date: '2026-07-05',
      type: 'representation_meals',
      motivo: `Client lunch ${tag}`,
      amount: '85',
      entity: 'welld_it',
    })

    await empPage.getByTestId('request-detail-submit').click()
    await expect(empPage.getByTestId('request-detail-submitted')).toBeVisible({ timeout: 20_000 })
    const requestId = await empPage.getByTestId('refund-request-detail-id').textContent()
    expect(requestId).toBeTruthy()

    const acctContext = await browser.newContext()
    await applySessionCookie(acctContext, acctSession)
    const acctPage = await acctContext.newPage()

    await acctPage.goto(`/refund/review/${requestId}`)
    await expect(acctPage.getByTestId('review-detail-decidable')).toBeVisible({ timeout: 20_000 })

    await acctPage.getByTestId('review-detail-reject').click()
    const rejectDialog = acctPage.getByTestId('reject-dialog-modal')
    await expect(rejectDialog).toBeVisible({ timeout: 10_000 })

    // AC-7.3: the confirm button stays disabled until a non-empty motivation is entered.
    await expect(acctPage.getByTestId('reject-dialog-confirm')).toBeDisabled()
    const motivation = `Missing receipt, please resubmit with proof ${tag}`
    await acctPage.getByTestId('reject-dialog-motivation').fill(motivation)
    await expect(acctPage.getByTestId('reject-dialog-confirm')).toBeEnabled()
    await acctPage.getByTestId('reject-dialog-confirm').click()

    await expect(acctPage.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })

    // AC-3.3: the employee sees the exact rejection motivation on their own detail.
    await empPage.goto(`/refund/requests/${requestId}`)
    await expect(empPage.getByTestId('request-detail-rejected')).toBeVisible({ timeout: 20_000 })
    await expect(empPage.getByTestId('request-detail-rejection-motivation')).toContainText(motivation)

    // AC-2.4: a rejected request offers "+ New request", never in-place edit/resubmit.
    await expect(empPage.getByTestId('request-detail-new-request-link')).toBeVisible()

    // AC-3.6: rejection also pushes a real in-app notification.
    await expect
      .poll(async () => {
        const { items } = await fetchNotifications(empSession.token)
        return items.some((n) => n.link?.href === `/refund/requests/${requestId}` && /reject/i.test(n.title))
      }, { timeout: 15_000, message: 'expected an in-app notification for the rejected decision' })
      .toBe(true)

    await empContext.close()
    await acctContext.close()
  })
})
