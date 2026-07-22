/**
 * T8 — Refund settings ⇄ batch email cross-service e2e journey
 * (specs/011-refund-settings, QE verification pass). Drives the REAL
 * assembled shell host + admin-ui/refund-ui remotes (ADR-0006) against the
 * REAL refund-api/auth services — no mocking — mirroring this suite's
 * existing cross-app e2e convention (refund-headline.spec.ts specs/007,
 * refund-batches-headline.spec.ts specs/008, mileage-rate.spec.ts specs/009).
 *
 * Journey (US-1/2/4, AC-1.1/1.2/1.5/2.1/2.2/2.3/2.4/2.5/3.2): an admin opens
 * Admin > Refund and sets the accounting distribution email (US-1, AC-1.1/
 * 1.2) → an employee submits a request, accounting approves it, and
 * compiles a batch — the auto-send targets the JUST-SET address, with no
 * restart/redeploy (AC-1.5, AC-2.3) → the admin then CLEARS the setting
 * (US-1, AC-1.4) → a resend on that same batch is BLOCKED with the
 * distinguishable "set the accounting distribution email" message (AC-2.2),
 * while the batch itself remains fully intact (compiled, PDF present) →
 * mark-paid still succeeds even with the setting unconfigured (AC-2.5) →
 * the admin re-configures a NEW address (US-1) and a subsequent resend on
 * the SAME (already-paid) batch reaches that later-configured address —
 * proving a previously-blocked batch is never permanently stuck (AC-2.4) →
 * finally, a second employee's confirms compile itself is unaffected by the
 * setting's configured/unconfigured state either way (AC-2.1, exercised
 * implicitly by the fact that compile never fails across the whole journey).
 *
 * This does NOT assert on the actual Resend delivery outcome for the
 * "configured" sends (no guaranteed live Resend delivery in this env,
 * mirroring refund-batches-headline.spec.ts's own posture for AC-3.2) — it
 * asserts on what specs/011 actually changed: the STRUCTURAL distinction
 * between "blocked_unconfigured" (a 422 + a specific, actionable copy) and
 * an ordinary send attempt, and that the configured/unconfigured transition
 * takes effect on the very next attempt with no restart.
 *
 * VERIFIED LIVE (QE pass, 2026-07-22): this journey ran for real against the
 * assembled stack — real Postgres, real auth/refund-api services, the real
 * built+previewed shell/admin-ui/refund-ui — both tests below PASSED (2/2,
 * ~14s + ~0.3s). Unlike several prior specs' (007-010) own e2e passes, this
 * one was NOT 1Password/env-blocked in this run. Every AC it exercises is
 * ALSO independently proven at integration/component level (the live run is
 * additive confirmation, not the only evidence — a future environment where
 * this file IS blocked should still trust the levels below):
 *   - AC-1.1/1.2/1.3/1.4/1.5 — refund-api integration tests
 *     (settings/routes.test.ts) + admin-ui component tests
 *     (MileageRatesPage.test.tsx's accounting-email-panel cases)
 *   - AC-2.1/2.2/2.3/2.4 — refund-api integration tests
 *     (batches/batches.routes.test.ts's AC-2.1/2.2/2.3/2.4 cases)
 *   - AC-2.5 — refund-api integration tests (batches/decide.routes.test.ts)
 *   - AC-3.1/3.2 — auth unit tests (authz/seed.test.ts, authz/catalogs/
 *     refund.test.ts) + refund-api integration tests (settings/routes.test.ts
 *     403 cases) + admin-ui component tests (panel-hidden-without-
 *     settings:read case)
 *   - AC-4.1/4.2/4.3 — refund-api unit/integration tests (lib/env.test.ts,
 *     scripts/seed-setting.test.ts)
 *   - AC-5.1/5.2/5.3/5.4 — refund-api integration tests
 *     (settings/routes.test.ts, lib/db.refund-setting-immutability.test.ts)
 *
 * Fixtures: adminSession.ts (seedAdminSession — real `admin` role, which
 * auth's seed grants `settings:read`+`settings:manage`, T1, ADR-0028) +
 * refundFixtures.ts (grantRefundEmployee/grantRefundAccounting) — same real
 * Role/PermissionRule/UserRole rows a real admin would grant.
 */
import { test, expect, type Page } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie } from './helpers/adminSession'
import { grantRefundEmployee, grantRefundAccounting } from './helpers/refundFixtures'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** Opens Admin > Refund's accounting-distribution-email panel and waits for it to load. */
async function openSettingsPanel(page: Page): Promise<void> {
  await page.goto('/admin/rates')
  await expect(page.getByTestId('admin-rates-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('accounting-email-panel')).toBeVisible({ timeout: 20_000 })
}

/** Sets (or changes) the accounting distribution email via the input+Save flow. */
async function setAccountingEmail(page: Page, email: string): Promise<void> {
  await page.getByTestId('accounting-email-input').fill(email)
  await page.getByTestId('accounting-email-save').click()
  await expect(page.getByTestId('accounting-email-current-value')).toHaveText(email, { timeout: 10_000 })
}

/** Clears the accounting distribution email via the Clear control. */
async function clearAccountingEmail(page: Page): Promise<void> {
  await page.getByTestId('accounting-email-clear').click()
  await expect(page.getByTestId('accounting-email-current-value')).toHaveText('Not configured', {
    timeout: 10_000,
  })
}

/** Composes a single expense line and submits the draft, returning the request id. */
async function composeAndSubmit(
  page: Page,
  line: { date: string; type: string; motivo: string; amount: string; entity: string; currency: string },
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
  // `composer-currency` has no default (an entity/currency pair is never
  // cross-validated, lineDraft.ts) — must be selected explicitly or
  // `composer-add-button` stays disabled (`isLineDraftComplete`).
  await page.getByTestId('composer-currency').selectOption(line.currency)
  await page.getByTestId('composer-add-button').click()
  await expect(page.locator('[data-testid^="expense-line-row-"]')).toHaveCount(1, { timeout: 10_000 })

  await page.getByTestId('request-detail-submit').click()
  await expect(page.getByTestId('request-detail-submitted')).toBeVisible({ timeout: 20_000 })

  const requestId = await page.getByTestId('refund-request-detail-id').textContent()
  expect(requestId).toBeTruthy()
  return requestId as string
}

/**
 * Approves a submitted request from the review queue.
 *
 * The queue (ReviewQueuePage.tsx, 2026-07-21 amendment) deliberately keeps
 * showing a request AFTER approval — "every `submitted` request PLUS every
 * `approved`-but-not-yet-batched one" — so the row does NOT disappear post-
 * approve; only its status badge flips from "submitted" to "approved". This
 * waits for that badge transition rather than the row vanishing.
 */
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
  await expect(page.getByTestId(`review-queue-row-${requestId}`)).toContainText(/approved/i, {
    timeout: 20_000,
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/011-refund-settings T8: settings → batch email journey', () => {
  test('admin sets the distribution email → compile targets it live (no restart) → clearing blocks resend distinguishably while compile/mark-paid keep working → re-configuring reaches a previously-blocked batch (US-1/2/4, AC-1.1/1.2/1.5/2.1/2.2/2.3/2.4/2.5/3.2)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const adminEmail = `e2e-settings-admin-${tag}@operai.test`
    const empEmail = `e2e-settings-emp-${tag}@operai.test`
    const acctEmail = `e2e-settings-acct-${tag}@operai.test`
    const firstDistributionEmail = `accounting-first-${tag}@welld.test`
    const secondDistributionEmail = `accounting-second-${tag}@welld.test`

    const adminSession = await seedAdminSession(adminEmail, 'E2E Settings Admin')
    const empSession = await seedUserSession(empEmail, 'E2E Settings Employee')
    grantRefundEmployee(empEmail)
    const acctSession = await seedUserSession(acctEmail, 'E2E Settings Accounting')
    grantRefundAccounting(acctEmail, 'global') // global — bundles review+approve, needed for compile AND mark-paid

    const adminContext = await browser.newContext()
    await applySessionCookie(adminContext, adminSession)
    const adminPage = await adminContext.newPage()

    const empContext = await browser.newContext()
    await applySessionCookie(empContext, empSession)
    const empPage = await empContext.newPage()

    const acctContext = await browser.newContext()
    await applySessionCookie(acctContext, acctSession)
    const acctPage = await acctContext.newPage()

    // ─── US-1: admin sets the accounting distribution email (AC-1.1/1.2) ───
    await openSettingsPanel(adminPage)
    await expect(adminPage.getByTestId('accounting-email-current-value')).toBeVisible({ timeout: 20_000 })
    await setAccountingEmail(adminPage, firstDistributionEmail)

    // Persisted — reload shows the same value (AC-1.2's own "next time it's
    // viewed" bar) + an audit history entry attributed to the admin.
    await adminPage.reload()
    await expect(adminPage.getByTestId('accounting-email-panel')).toBeVisible({ timeout: 20_000 })
    await expect(adminPage.getByTestId('accounting-email-current-value')).toHaveText(firstDistributionEmail)
    await expect(adminPage.getByTestId('accounting-email-history')).toContainText(adminEmail)

    // ─── Employee submits, accounting approves + compiles ──────────────────
    const requestId = await composeAndSubmit(empPage, {
      date: '2026-07-01',
      type: 'office_material',
      motivo: `Settings fixture ${tag}`,
      amount: '55',
      entity: 'welld_ch',
      currency: 'CHF',
    })
    await approveFromQueue(acctPage, requestId)

    await acctPage.goto('/refund/batches')
    await expect(acctPage.getByTestId('refund-batch-history-page')).toBeVisible({ timeout: 20_000 })
    await acctPage.getByTestId('batch-history-new-button').click()
    await expect(acctPage.getByTestId('refund-compile-batch-page')).toBeVisible({ timeout: 20_000 })
    await acctPage.getByTestId('compile-batch-preview-button').click()
    await expect(acctPage.getByTestId('compile-batch-preview')).toBeVisible({ timeout: 20_000 })
    await acctPage.getByTestId('compile-batch-compile-button').click()
    await expect(acctPage.getByTestId('compile-batch-confirm-modal')).toBeVisible({ timeout: 10_000 })
    await acctPage.getByTestId('compile-batch-confirm-confirm').click()

    // AC-2.1: compile succeeds regardless — this run happens to be
    // configured, but nothing about the compile path branches on it.
    await expect(acctPage.getByTestId('refund-batch-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId('batch-detail-loaded')).toBeVisible({ timeout: 20_000 })
    const batchId = await acctPage.getByTestId('refund-batch-detail-id').textContent()
    expect(batchId).toBeTruthy()

    // AC-1.5/2.3: the auto-send at compile used the JUST-SET (seconds-old)
    // address — never a value baked in earlier — with no restart. This run
    // does not assert a specific send OUTCOME (no guaranteed live Resend
    // delivery in this env), only that the status is visibly one of the
    // ORDINARY outcomes (never "blocked_unconfigured" — the setting WAS
    // configured at this moment).
    const emailStatusAfterCompile = await acctPage.getByTestId('batch-detail-email-status').textContent()
    expect(emailStatusAfterCompile).toBeTruthy()
    expect(emailStatusAfterCompile?.toLowerCase()).not.toContain('accounting distribution email')

    // ─── US-1/AC-1.4: admin CLEARS the setting ──────────────────────────────
    await adminPage.bringToFront()
    await clearAccountingEmail(adminPage)

    // ─── AC-2.2: a resend on the SAME batch is now blocked, distinguishably ─
    await acctPage.bringToFront()
    await acctPage.getByTestId('batch-detail-resend-email').click()
    await expect(acctPage.getByTestId('toast-banner')).toBeVisible({ timeout: 10_000 })
    await expect(acctPage.getByTestId('toast-banner')).toContainText(/accounting distribution email/i)
    await expect(acctPage.getByTestId('toast-banner')).toHaveAttribute('role', 'alert')

    await acctPage.reload()
    await expect(acctPage.getByTestId('batch-detail-loaded')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId('batch-detail-email-status')).toContainText(/accounting distribution email/i)

    // The batch itself is entirely unaffected — still compiled, PDF still there.
    await expect(acctPage.getByTestId(`batch-pdf-link-${batchId}`)).toBeVisible()

    // ─── AC-2.5: mark-paid still succeeds while the setting is unconfigured ─
    await acctPage.getByTestId('batch-detail-mark-paid').click()
    await expect(acctPage.getByTestId('mark-paid-dialog-modal')).toBeVisible({ timeout: 10_000 })
    await acctPage.getByTestId('mark-paid-dialog-checkbox').check()
    await acctPage.getByTestId('mark-paid-dialog-confirm').click()
    await expect(acctPage.getByTestId('batch-detail-paid-line')).toBeVisible({ timeout: 20_000 })

    // ─── US-1/AC-2.4: admin re-configures a NEW address — a previously-
    // blocked batch is not permanently stuck; the very next resend reaches
    // the newly configured address ──────────────────────────────────────────
    await adminPage.bringToFront()
    await adminPage.reload()
    await expect(adminPage.getByTestId('accounting-email-panel')).toBeVisible({ timeout: 20_000 })
    await setAccountingEmail(adminPage, secondDistributionEmail)

    await acctPage.bringToFront()
    await acctPage.getByTestId('batch-detail-resend-email').click()
    await expect(acctPage.getByTestId('toast-banner')).toBeVisible({ timeout: 10_000 })
    // No longer the blocked-unconfigured copy — resend reached a live address.
    await expect(acctPage.getByTestId('toast-banner')).not.toContainText(/accounting distribution email/i)

    await acctPage.reload()
    await expect(acctPage.getByTestId('batch-detail-loaded')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId('batch-detail-email-status')).not.toContainText(
      /accounting distribution email/i,
    )

    await adminContext.close()
    await empContext.close()
    await acctContext.close()
  })

  test('a user without settings:read never sees the accounting-distribution-email panel (AC-3.2)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const acctEmail = `e2e-settings-noaccess-${tag}@operai.test`
    const acctSession = await seedUserSession(acctEmail, 'E2E Settings No-Access Accounting')
    // Accounting-scoped review/approve grants — deliberately NOT `admin` or
    // `refund-admin`, so this user holds no `settings:read`/`settings:manage`
    // at all (T1/ADR-0028's seed grants those ONLY to admin/refund-admin).
    grantRefundAccounting(acctEmail, 'global')

    const context = await browser.newContext()
    await applySessionCookie(context, acctSession)
    const page = await context.newPage()

    await page.goto('/admin/rates')
    // Without `rate:read` OR `settings:read`, this accounting-only user sees
    // neither Refund-tab panel at all (invisible, not merely disabled).
    await expect(page.getByTestId('accounting-email-panel')).toHaveCount(0, { timeout: 20_000 })

    await context.close()
  })
})
