/**
 * T6 — Segregation-of-duties e2e journey (specs/010-self-approval-control,
 * QE verification pass). Drives the REAL assembled shell host +
 * admin-ui/refund-ui remotes (ADR-0006) against the REAL auth/refund-api
 * services — no mocking — mirroring this suite's existing cross-app e2e
 * convention (refund-headline.spec.ts specs/007, refund-batches-headline.
 * spec.ts specs/008, mileage-rate.spec.ts specs/009).
 *
 * Journey (US-1/2/3/4, refs plan.md D1/D2/D5, ADR-0026): an admin creates a
 * dedicated role in admin-ui and, via the RoleEditor rule composer, grants it
 * the full refund accounting+employee surface (`refund:access`,
 * `request:create`, `request:read` own, `request:review`,
 * `request:set-approved-total`, `request:reject`, and `request:approve` with
 * the NEW "cannot approve own request" toggle enabled — AC-1.1/1.4) →
 * assigns that role to a single test user ("the accountant") who ALSO
 * creates and submits their own refund request → the accountant opens the
 * review queue and finds their OWN request's Approve button passively
 * disabled with an explanatory tooltip (US-2, AC-2.1, plan.md D5) — the
 * server enforces this independently of the disabled button (verified at
 * integration level, see below) → the SAME accountant nonetheless CAN set
 * the approved total and reject their OWN request (US-4, AC-4.1/4.2 — the
 * restriction is approve-only) → a SECOND employee submits an unrelated
 * request, and the accountant approves THAT ONE successfully (US-2, AC-2.2 —
 * the restriction never blocks a non-owned request).
 *
 * US-3 (a role that never had the restriction enabled behaves exactly as
 * before) is NOT re-exercised here — it is the suite's pre-existing 007
 * behavior (007 AC-7.2) and is proven directly by
 * `refund-api/src/review/decide.routes.test.ts`'s AC-3.1 integration test
 * (owner self-approves successfully with an unrestricted grant); re-deriving
 * it end-to-end would only duplicate that coverage without adding signal.
 *
 * Server-authoritative enforcement (the security-critical property this
 * feature exists for — self-approval-control's OWASP A01 surface) is
 * DELIBERATELY NOT re-proven here via a raw bypass-the-UI fetch: it is
 * exhaustively covered, including the ordering-before-entity-404/status-409
 * requirement (AC-2.4) and the fail-closed posture, by
 * `refund-api/src/review/decide.routes.test.ts`'s
 * "POST /review/requests/:id/approve — self-approval restriction" describe
 * block (AC-2.1/2.2/2.3/2.4/3.1/6.1/6.2/6.3), which calls the route directly
 * — bypassing refund-ui entirely — exactly the same way a request issued
 * outside the UI would. This e2e journey's job is the OTHER half: that the
 * admin-facing control surface (RoleEditor) and the accounting-facing
 * reflection (the disabled button) are wired together correctly end-to-end.
 *
 * BLOCKED IN THIS ENVIRONMENT (documented per this task's own fallback,
 * mirroring 007/008/009's e2e when their prerequisites weren't met) — this
 * pass verified the SAME class of blocker those specs recorded:
 * `refundFixtures.ts`/`adminSession.ts` shell out to `direnv exec .` inside
 * `auth/` to reach 1Password-backed secrets; running that directly in this
 * pass's automated shell reproduced `direnv: error auth/.envrc is blocked.
 * Run 'direnv allow' to approve its content` — a trust decision outside a QE
 * pass's remit to make unilaterally. This journey is authored and committed
 * per the task instructions; every AC it exercises is independently,
 * additionally proven at unit/integration/component level:
 *   - AC-1.1/1.3/1.4 — admin-ui component tests (RoleEditor.test.tsx,
 *     ConditionChip.test.tsx)
 *   - AC-1.2/1.5/1.6 — auth integration tests (roles.routes.test.ts)
 *   - AC-2.1/2.2/2.3/2.4/3.1/4.1/4.2/6.1/6.2/6.3 — refund-api integration
 *     tests (decide.routes.test.ts)
 *   - AC-6.1 (UI reflection), D5 — refund-ui component tests
 *     (ReviewDetailPage.test.tsx)
 *
 * Fixtures: adminSession.ts (seedAdminSession) + refundFixtures.ts
 * (grantRefundEmployee) for the second, non-owning employee. The accountant
 * role itself is created and wired up LIVE through admin-ui in this journey
 * (not via a fixture script) — that IS the thing T6 is testing — then
 * assigned to the accountant's own user via admin-ui's UserDetail screen.
 */
import { test, expect, type Page } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie } from './helpers/adminSession'
import { grantRefundEmployee } from './helpers/refundFixtures'

const uniqueSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const todayIso = () => new Date().toISOString().slice(0, 10)

interface RuleSpec {
  resourceValue: string // "<appId>::<resourceKey>", matches the composer's <option value>
  actionKey: string
  ownershipOwn?: boolean
  selfApproval?: boolean
}

/**
 * Opens the rule composer, fills resource/action/conditions for ONE rule,
 * clicks "Add rule" (which closes the composer per RoleEditor's own
 * behavior — draft-only, not yet persisted), and repeats for every spec in
 * `rules`. Does NOT click "Save rules" — the caller does that once, after
 * every rule has been added to the client-side draft (RoleEditor.tsx design.
 * md F2 step 4d).
 */
async function addDraftRules(page: Page, rules: RuleSpec[]): Promise<void> {
  for (const rule of rules) {
    await page.getByTestId('rule-composer-toggle').click()
    await expect(page.getByTestId('rule-composer')).toBeVisible({ timeout: 10_000 })

    await page.getByTestId('rule-composer-resource').selectOption(rule.resourceValue)
    await page.getByTestId('rule-composer-action').selectOption(rule.actionKey)

    if (rule.ownershipOwn) {
      await page.getByTestId('rule-composer-ownership-own').check()
    }
    if (rule.selfApproval) {
      await expect(page.getByTestId('rule-composer-self-approval')).toBeVisible({ timeout: 10_000 })
      await page.getByTestId('rule-composer-self-approval').check()
    }

    await page.getByTestId('rule-composer-add').click()
    await expect(page.getByTestId('rule-composer')).toHaveCount(0, { timeout: 10_000 })
  }
}

/** Creates a new office_material draft line and submits the request; returns its id. */
async function createAndSubmitRequest(page: Page, motivo: string, today: string): Promise<string> {
  await page.goto('/refund/requests')
  await expect(page.getByTestId('refund-my-requests-page')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('my-requests-new-button').click()
  await expect(page.getByTestId('refund-request-detail-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('request-detail-draft')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('composer-date').fill(today)
  await page.getByTestId('composer-type').selectOption('office_material')
  await page.getByTestId('composer-motivo').fill(motivo)
  await page.getByTestId('composer-amount').fill('42.50')
  await page.getByTestId('composer-entity').selectOption('welld_it')
  await page.getByTestId('composer-currency').selectOption('EUR')
  await page.getByTestId('composer-add-button').click()
  await expect(page.locator('[data-testid^="expense-line-row-"]')).toHaveCount(1, { timeout: 10_000 })

  await page.getByTestId('request-detail-submit').click()
  await expect(page.getByTestId('request-detail-submitted')).toBeVisible({ timeout: 20_000 })

  const requestId = await page.getByTestId('refund-request-detail-id').textContent()
  expect(requestId).toBeTruthy()
  return requestId!
}

test.describe.configure({ mode: 'serial' })

test.describe('specs/010-self-approval-control T6: segregation-of-duties journey', () => {
  test(
    'admin enables "cannot approve own request" on a role (US-1) → the accountant holding it is blocked ' +
      'approving their OWN request (US-2, AC-2.1) but can still reject/set-total on it (US-4, AC-4.1/4.2) → ' +
      'the SAME accountant CAN approve another employee\'s request (US-2, AC-2.2)',
    async ({ browser }) => {
      const tag = uniqueSuffix()
      const adminEmail = `e2e-selfapproval-admin-${tag}@operai.test`
      const acctEmail = `e2e-selfapproval-acct-${tag}@operai.test`
      const otherEmpEmail = `e2e-selfapproval-otheremp-${tag}@operai.test`
      const today = todayIso()

      const adminSession = await seedAdminSession(adminEmail, 'E2E Self-Approval Admin')
      const acctSession = await seedUserSession(acctEmail, 'E2E Self-Approval Accountant')
      const otherEmpSession = await seedUserSession(otherEmpEmail, 'E2E Self-Approval Other Employee')
      grantRefundEmployee(otherEmpEmail)

      const adminContext = await browser.newContext()
      await applySessionCookie(adminContext, adminSession)
      const adminPage = await adminContext.newPage()

      const acctContext = await browser.newContext()
      await applySessionCookie(acctContext, acctSession)
      const acctPage = await acctContext.newPage()

      const otherEmpContext = await browser.newContext()
      await applySessionCookie(otherEmpContext, otherEmpSession)
      const otherEmpPage = await otherEmpContext.newPage()

      // ─── US-1: admin creates a role carrying the FULL refund surface,
      // including `request:approve` with the self-approval restriction ────
      await adminPage.goto('/admin/roles')
      await expect(adminPage.getByTestId('admin-roles-page')).toBeVisible({ timeout: 20_000 })
      await adminPage.getByTestId('roles-new-button').click()
      await expect(adminPage.getByTestId('create-role-modal')).toBeVisible({ timeout: 10_000 })
      await adminPage.getByTestId('create-role-name').fill(`e2e-self-approval-role-${tag}`)
      await adminPage.getByTestId('create-role-submit').click()

      // Navigates to the new role's editor (design.md F2 step 2).
      await expect(adminPage.getByTestId('role-editor-page')).toBeVisible({ timeout: 20_000 })
      await adminPage.waitForURL(/\/admin\/roles\/[^/]+$/, { timeout: 20_000 })
      const roleId = adminPage.url().split('/').pop()!

      await addDraftRules(adminPage, [
        { resourceValue: 'refund::refund', actionKey: 'access' },
        { resourceValue: 'refund::request', actionKey: 'create' },
        { resourceValue: 'refund::request', actionKey: 'read', ownershipOwn: true },
        { resourceValue: 'refund::request', actionKey: 'review' },
        { resourceValue: 'refund::request', actionKey: 'set-approved-total' },
        // AC-1.1/1.4 — the self-approval toggle is offered distinctly from
        // the entity checkbox for `approve`, and persists as its own chip.
        { resourceValue: 'refund::request', actionKey: 'approve', selfApproval: true },
        { resourceValue: 'refund::request', actionKey: 'reject' },
      ])

      // AC-1.4 — a dedicated self-approval chip renders on the approve rule
      // row, distinct from any other condition chip.
      const approveRuleRow = adminPage.getByTestId('role-rules-list').locator('li', { hasText: 'Approve' })
      await expect(approveRuleRow.locator('[data-testid="condition-chip-self-approval"]')).toBeVisible()

      await adminPage.getByTestId('role-save-rules').click()
      await expect(adminPage.getByTestId('role-rules-list')).toBeVisible({ timeout: 10_000 })

      // ─── Assign the new role to the accountant (AC-1.2 — the resolver
      // picks this up live, no re-login required) ─────────────────────────
      await adminPage.goto(`/admin/users/${acctSession.userId}`)
      await expect(adminPage.getByTestId('admin-user-detail-page')).toBeVisible({ timeout: 20_000 })
      await adminPage.getByTestId(`role-checkbox-${roleId}`).check()
      await adminPage.getByTestId('save-roles-button').click()
      await expect(adminPage.getByTestId('roles-effective-immediately-hint')).toBeVisible({ timeout: 10_000 })

      // ─── The accountant creates and submits their OWN request ───────────
      const ownRequestId = await createAndSubmitRequest(acctPage, `Own claim ${tag}`, today)

      // ─── The other employee creates and submits an unrelated request ────
      const otherRequestId = await createAndSubmitRequest(otherEmpPage, `Other employee claim ${tag}`, today)

      // ─── US-2/AC-2.1: the accountant opens their OWN request in the
      // review queue — Approve is passively disabled with a tooltip ───────
      await acctPage.goto('/refund/review')
      await expect(acctPage.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })
      const ownQueueRow = acctPage.getByTestId(`review-queue-row-${ownRequestId}`)
      await expect(ownQueueRow).toBeVisible({ timeout: 20_000 })
      await ownQueueRow.click()

      await expect(acctPage.getByTestId('refund-review-detail-page')).toBeVisible({ timeout: 20_000 })
      await expect(acctPage.getByTestId('review-detail-decidable')).toBeVisible({ timeout: 20_000 })

      const ownApproveButton = acctPage.getByTestId('review-detail-approve')
      await expect(ownApproveButton).toHaveAttribute('aria-disabled', 'true')
      await expect(ownApproveButton).toHaveAttribute('title', /.+/)

      // Clicking a passively-disabled button (not a native `disabled`
      // attribute) must NOT open the approve confirmation dialog — the
      // component's own click handler guards this (ReviewDetailPage.tsx
      // D5's "defensive — the button is already disabled" comment).
      await ownApproveButton.click({ force: true })
      await expect(acctPage.getByTestId('approve-dialog-confirm')).toHaveCount(0)

      // ─── US-4/AC-4.2: set-approved-total on the OWN request is NOT
      // blocked by the restriction ──────────────────────────────────────
      const ownLineRow = acctPage.locator('[data-testid^="expense-line-row-"]').first()
      const ownApprovedTotalInput = ownLineRow.locator('input[type="number"]')
      await ownApprovedTotalInput.fill('40')
      await ownApprovedTotalInput.blur()
      await expect(ownLineRow.getByText('Saving…')).toHaveCount(0, { timeout: 10_000 })

      // ─── US-4/AC-4.1: reject on the OWN request is NOT blocked ─────────
      await acctPage.getByTestId('review-detail-reject').click()
      await expect(acctPage.getByTestId('reject-dialog-modal')).toBeVisible({ timeout: 10_000 })
      await acctPage.getByTestId('reject-dialog-motivation').fill('Self-approval e2e control check')
      await acctPage.getByTestId('reject-dialog-confirm').click()
      await expect(acctPage.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })

      // ─── US-2/AC-2.2: the SAME accountant CAN approve the OTHER
      // employee's request ────────────────────────────────────────────────
      const otherQueueRow = acctPage.getByTestId(`review-queue-row-${otherRequestId}`)
      await expect(otherQueueRow).toBeVisible({ timeout: 20_000 })
      await otherQueueRow.click()

      await expect(acctPage.getByTestId('refund-review-detail-page')).toBeVisible({ timeout: 20_000 })
      await expect(acctPage.getByTestId('review-detail-decidable')).toBeVisible({ timeout: 20_000 })
      const otherApproveButton = acctPage.getByTestId('review-detail-approve')
      await expect(otherApproveButton).not.toHaveAttribute('aria-disabled', 'true')

      await otherApproveButton.click()
      await expect(acctPage.getByTestId('approve-dialog-confirm')).toBeVisible({ timeout: 10_000 })
      await acctPage.getByTestId('approve-dialog-confirm').click()
      await expect(acctPage.getByTestId('refund-review-queue-page')).toBeVisible({ timeout: 20_000 })

      // Confirm the terminal states are what we expect: own request rejected,
      // other employee's request approved.
      await acctPage.goto(`/refund/review/${ownRequestId}`)
      await expect(acctPage.getByTestId('review-detail-rejected')).toBeVisible({ timeout: 20_000 })

      await otherEmpPage.goto(`/refund/requests/${otherRequestId}`)
      await expect(otherEmpPage.getByTestId('request-detail-approved')).toBeVisible({ timeout: 20_000 })

      await adminContext.close()
      await acctContext.close()
      await otherEmpContext.close()
    },
  )
})
