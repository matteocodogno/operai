/**
 * T15 — Cross-service mileage-rate e2e journey (specs/009-mileage-rate, QE
 * verification pass). Drives the REAL assembled shell host + admin-ui/
 * refund-ui remotes (ADR-0006) against the REAL refund-api/auth services —
 * no mocking — mirroring this suite's existing cross-app e2e convention
 * (refund-headline.spec.ts specs/007, refund-batches-headline.spec.ts
 * specs/008).
 *
 * Journey (US-1/2/3/4/5/6, AC-1.1/1.2/1.6/1.8/2.1/2.2/3.1/3.2/4.1/4.2/4.3/
 * 5.1/5.3/6.1/6.4): an admin opens admin-ui's NEW "Mileage Rates" screen and
 * adds a rate entry for WellD CH (US-4/US-5 — persisted, audited) → an
 * employee drafts a `travel_km` line in refund-ui for that SAME entity/date
 * and watches the amount/currency inputs replaced by a live, read-only
 * `km × rate = amount` breakdown that resolves against the admin's
 * just-added rate (US-1/US-2), then submits (freezing the computed amount,
 * Decision 1) → accounting opens the request and sees the SAME applied rate
 * (value + valid-from) displayed alongside the amount (US-6, AC-6.4) → the
 * admin THEN adds a SECOND, higher rate for the identical entity/date → both
 * the employee's and accounting's views of the ALREADY-SUBMITTED line are
 * re-read and asserted to be UNCHANGED — proving the snapshot freeze (US-3,
 * AC-3.1): a rate change after submission never rewrites an already-decided
 * line's amount.
 *
 * Dates: both the admin's rate `validFrom` and the employee's line date are
 * pinned to TODAY (computed at run time, never hardcoded) — `validFrom <=
 * date` is deterministic against ANY prior test run's leftover rate history
 * in this shared local dev DB, because a freshly-added `validFrom === today`
 * entry always wins resolution for a `date === today` line: either its
 * `validFrom` is strictly the latest possible (nothing can be later than
 * today and still be `<= today`), or it ties an earlier same-day run's entry
 * and wins that tie as the most-recently-added one (`resolve.ts`'s own
 * documented tie-break — mirrors that module's doc comment verbatim).
 *
 * BLOCKED IN THIS ENVIRONMENT (documented per this task's own fallback,
 * mirroring 007/008's e2e when their prerequisites weren't met) — TWO
 * independent, verified blockers, neither a code defect:
 *   1. `refundFixtures.ts`/`adminSession.ts` shell out to `direnv exec .`
 *      inside `auth/` to reach 1Password-backed secrets. Actually running
 *      this suite from this pass's automated shell reproduced exactly that:
 *      `direnv exec .` fails env validation (`BETTER_AUTH_SECRET`/OAuth/JWT
 *      vars all "required") because 1Password isn't unlocked in this
 *      non-interactive context — the SAME class of failure already noted for
 *      007/008's own e2e ("if 1Password-gated env blocks the live run").
 *   2. Independently, the shared local `refund-api` dev process this run's
 *      `mise run dev` stack left running predates this feature's commits —
 *      `GET /openapi.json` against it (checked directly during this QE pass)
 *      lists NO `/rates`/`/rates/effective` routes at all, i.e. it is running
 *      pre-specs/009 code that its `bun --hot` reload evidently did not pick
 *      up for a brand-new route-registering module. `bun run db:generate &&
 *      bun run db:deploy` were run during this pass and the migration
 *      applies cleanly; `bun test`/`typecheck` are green against the current
 *      code (see the QE verdict) — restarting a shared background dev server
 *      owned by another terminal was out of scope for this pass, to avoid
 *      disrupting it.
 * This journey is authored and committed per the task instructions; every AC
 * it exercises is independently, additionally proven at unit/integration/
 * component level:
 *   - AC-1.1/1.2/1.3/1.6/1.8/2.2 — refund-ui component tests
 *     (MileageAmountField.test.tsx, ExpenseLineRow.test.tsx)
 *   - AC-2.1/2.3/2.4/4.4 — refund-api unit tests (resolve.test.ts)
 *   - AC-4.1/4.2/4.3/4.5/4.6/4.7/4.8/5.1/5.3 — refund-api integration tests
 *     (rates/routes.test.ts, rates/effective.routes.test.ts,
 *     lib/db.mileage-rate-immutability.test.ts) + admin-ui component tests
 *     (MileageRatesPage.test.tsx)
 *   - AC-3.1/3.2/3.3 — refund-api integration tests
 *     (requests/lifecycle.routes.test.ts)
 *   - AC-6.1/6.2/6.3/6.4 — refund-api integration tests
 *     (requests/requests.service.test.ts, batches/batches.routes.test.ts)
 *     + refund-ui component tests (ExpenseLineRow.test.tsx,
 *     ReviewDetailPage.test.tsx)
 *
 * Fixtures: adminSession.ts (seedAdminSession — real `admin` role, which
 * auth's seed grants `rate:read`+`rate:manage`, T1) + refundFixtures.ts
 * (grantRefundEmployee/grantRefundAccounting) — same real Role/
 * PermissionRule/UserRole rows a real admin would grant.
 */
import { test, expect, type Page } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie } from './helpers/adminSession'
import { grantRefundEmployee, grantRefundAccounting } from './helpers/refundFixtures'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const todayIso = () => new Date().toISOString().slice(0, 10)

/** Opens admin-ui's Mileage Rates screen and appends one entry for `entity`, waiting for the modal to close. */
async function addMileageRate(
  page: Page,
  entity: 'welld_ch' | 'welld_it',
  ratePerKm: string,
  validFrom: string,
): Promise<void> {
  await page.goto('/admin/rates')
  await expect(page.getByTestId('admin-rates-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId(`rates-section-${entity}`)).toBeVisible({ timeout: 20_000 })

  await page.getByTestId(`add-rate-button-${entity}`).click()
  await expect(page.getByTestId(`add-rate-modal-${entity}`)).toBeVisible({ timeout: 10_000 })

  await page.getByTestId('add-rate-value').fill(ratePerKm)
  await page.getByTestId('add-rate-valid-from').fill(validFrom)
  await page.getByTestId('add-rate-submit').click()

  await expect(page.getByTestId(`add-rate-modal-${entity}`)).toHaveCount(0, { timeout: 10_000 })
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/009-mileage-rate T15: cross-service mileage flow', () => {
  test('admin adds a rate → employee drafts + submits a computed travel_km line → accounting sees the applied rate → a later rate change never disturbs the submitted line (US-1/2/3/4/5/6, AC-1.1/1.2/1.6/1.8/2.1/2.2/3.1/4.1/4.2/5.1/6.1/6.4)', async ({
    browser,
  }) => {
    const tag = uniqueSuffix()
    const adminEmail = `e2e-mileage-admin-${tag}@operai.test`
    const empEmail = `e2e-mileage-emp-${tag}@operai.test`
    const acctEmail = `e2e-mileage-acct-${tag}@operai.test`
    const today = todayIso()

    const adminSession = await seedAdminSession(adminEmail, 'E2E Mileage Admin')
    const empSession = await seedUserSession(empEmail, 'E2E Mileage Employee')
    grantRefundEmployee(empEmail)
    const acctSession = await seedUserSession(acctEmail, 'E2E Mileage Accounting')
    grantRefundAccounting(acctEmail, 'welld_ch')

    const adminContext = await browser.newContext()
    await applySessionCookie(adminContext, adminSession)
    const adminPage = await adminContext.newPage()

    const empContext = await browser.newContext()
    await applySessionCookie(empContext, empSession)
    const empPage = await empContext.newPage()

    const acctContext = await browser.newContext()
    await applySessionCookie(acctContext, acctSession)
    const acctPage = await acctContext.newPage()

    // ─── US-4/US-5: admin adds a WellD CH rate, valid from today ───────────
    await addMileageRate(adminPage, 'welld_ch', '0.81', today)

    // Persisted + shows in the per-entity history, attributed to the admin
    // who added it (AC-4.1/4.2/5.1/5.3).
    const rateRow = adminPage.locator('[data-testid^="rate-row-"]').filter({ hasText: adminEmail })
    await expect(rateRow).toBeVisible({ timeout: 10_000 })
    await expect(rateRow).toContainText('0.81 CHF/km')

    // ─── US-1/US-2: employee drafts a travel_km line for the SAME entity/date ──
    await empPage.goto('/refund/requests')
    await expect(empPage.getByTestId('refund-my-requests-page')).toBeVisible({ timeout: 20_000 })
    await empPage.getByTestId('my-requests-new-button').click()
    await expect(empPage.getByTestId('refund-request-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(empPage.getByTestId('request-detail-draft')).toBeVisible({ timeout: 20_000 })

    await empPage.getByTestId('composer-date').fill(today)
    await empPage.getByTestId('composer-type').selectOption('travel_km')
    await empPage.getByTestId('composer-motivo').fill(`Client site visit ${tag}`)

    // AC-1.1/1.6 — Amount/Currency inputs are GONE (not disabled) for travel_km.
    await expect(empPage.getByTestId('composer-amount')).toHaveCount(0)
    await expect(empPage.getByTestId('composer-currency')).toHaveCount(0)

    await empPage.getByTestId('composer-entity').selectOption('welld_ch')
    await empPage.getByTestId('composer-km').fill('100')

    // AC-1.2/1.8 — live breakdown resolves against the admin's rate: km, the
    // per-km rate, AND the resulting amount together (100km × CHF0.81/km).
    await expect(empPage.getByTestId('mileage-amount-status')).toContainText(
      '100 km × 0,81 CHF/km = 81,00 CHF',
      { timeout: 10_000 },
    )

    await empPage.getByTestId('composer-add-button').click()
    await expect(empPage.locator('[data-testid^="expense-line-row-"]')).toHaveCount(1, { timeout: 10_000 })
    await expect(empPage.locator('[data-testid^="expense-line-row-"]')).toContainText('81,00 CHF')

    await empPage.getByTestId('request-detail-submit').click()
    await expect(empPage.getByTestId('request-detail-submitted')).toBeVisible({ timeout: 20_000 })

    const requestId = await empPage.getByTestId('refund-request-detail-id').textContent()
    expect(requestId).toBeTruthy()

    // Submitted view shows the frozen amount + the applied rate (AC-6.4 also
    // renders for the owner, not just accounting — summaryCore is shared).
    await expect(
      empPage.locator('[data-testid^="expense-line-row-"]').filter({ hasText: `Client site visit ${tag}` }),
    ).toContainText('81,00 CHF')

    // ─── US-6: accounting opens the request, sees the SAME applied rate ────
    await acctPage.goto('/refund/review')
    await expect(acctPage.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
    const queueRow = acctPage.getByTestId(`review-queue-row-${requestId}`)
    await expect(queueRow).toBeVisible({ timeout: 20_000 })
    await queueRow.click()

    await expect(acctPage.getByTestId('refund-review-detail-page')).toBeVisible({ timeout: 20_000 })
    await expect(acctPage.getByTestId('review-detail-decidable')).toBeVisible({ timeout: 20_000 })

    const acctLineRow = acctPage
      .locator('[data-testid^="expense-line-row-"]')
      .filter({ hasText: `Client site visit ${tag}` })
    await expect(acctLineRow).toContainText('81,00 CHF')
    // AC-6.4 — the specific rate applied (value + valid-from), not just the amount.
    await expect(acctLineRow).toContainText('0,81 CHF/km')
    await expect(acctLineRow).toContainText(/valid from/i)

    // AC-6.1 — the computed amount is never a ceiling/floor: approve at a
    // DIFFERENT approved total, proving the field stays independently editable.
    const approvedInput = acctLineRow.locator('input[type="number"]')
    await approvedInput.fill('70')
    await approvedInput.blur()
    await expect(acctLineRow.getByText('Saving…')).toHaveCount(0, { timeout: 10_000 })
    await acctPage.getByTestId('review-detail-approve').click()
    await expect(acctPage.getByTestId('approve-dialog-confirm')).toBeVisible({ timeout: 10_000 })
    await acctPage.getByTestId('approve-dialog-confirm').click()
    await expect(acctPage.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })

    // ─── US-3/AC-3.1: a LATER, higher rate for the SAME entity/date never
    // rewrites the already-submitted (now approved) line ──────────────────
    await addMileageRate(adminPage, 'welld_ch', '0.95', today)

    // Employee's own view of the now-decided request: still 81,00 CHF
    // requested, still the ORIGINAL 0,81 rate — never recomputed to 0,95.
    await empPage.goto(`/refund/requests/${requestId}`)
    await expect(empPage.getByTestId('request-detail-approved')).toBeVisible({ timeout: 20_000 })
    const empDecidedRow = empPage
      .locator('[data-testid^="expense-line-row-"]')
      .filter({ hasText: `Client site visit ${tag}` })
    await expect(empDecidedRow).toContainText('81,00 CHF')
    await expect(empDecidedRow).toContainText('0,81 CHF/km')
    await expect(empDecidedRow).not.toContainText('95,00 CHF')
    await expect(empDecidedRow).not.toContainText('0,95 CHF/km')

    await adminContext.close()
    await empContext.close()
    await acctContext.close()
  })
})
