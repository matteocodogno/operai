/**
 * T14 — User invitations, resend, and user deletion: end-to-end
 * (specs/006-user-invitations).
 *
 * Drives the REAL assembled shell + admin-ui (+ auth, +notify-api for the
 * email-delivery side-effect) in a browser — admin-ui had NO prior e2e
 * coverage (shell/playwright.config.ts never listed it as a webServer before
 * this file; see the `adminRemoteOrigin` doc comment there), so this file
 * both wires that harness gap shut and covers the ACs plan.md's test-strategy
 * assigns to the "E"/e2e level:
 *   AC-1.6  (invite visible / active-vs-pending, roles/depts shown)
 *   AC-2.2  (invite-landing → real OAuth sign-in controls)
 *   AC-2.3  (accept → provisioned with EXACTLY the invite's roles; a named-role
 *            invite replaces the baseline `employee`, it is not additive — the
 *            resolved R9 decision, see auth.config.ts / plan.md Risk R9)
 *   AC-2.6  (accepted invitation moves from Invitations-pending to Users)
 *   AC-3.3  (resend invalidates the OLD link)
 *   AC-5.2  (soft-deleted user's re-sign-in is refused)
 *   AC-5.3  (deleted user vanishes from the Users list)
 *   AC-5.7  (delete requires a distinct confirm step; Cancel is a true no-op)
 *   AC-6.1  (bulk delete soft-deletes every eligible selected user)
 *   AC-6.2  (self-exclusion is enforced by the SERVER too, not just the
 *            disabled checkbox — verified via a direct API call, see below)
 *   AC-6.3  (bulk result reports deleted vs skipped, never a silent partial)
 *
 * STACK REQUIREMENTS (beyond shell/playwright.config.ts's own prerequisites):
 *   - `auth`'s local DB must already have the `employee`/`admin` system roles
 *     seeded (true of any dev DB that has ever run `assignBaselineRolesToNewUser`
 *     or `db:seed`) — this suite grants `admin` directly via Prisma
 *     (helpers/adminSession.ts), it does not seed the RBAC catalog itself.
 *   - `direnv` must be installed and `auth/.envrc` already `direnv allow`ed
 *     (same prerequisite `mise run dev` already documents) — helpers/
 *     inviteFixtures.ts shells out through it to reach the same DATABASE_URL
 *     `bun test`/`bun run dev` use.
 *   - notify-api's `EMAIL_ENABLED=false` (local default) — the invite email
 *     is stubbed (channels/email.channel.ts), so AC-2.1's rendered EMAIL
 *     content is NOT observable from this suite (see the "BLOCKED" notes
 *     below); this suite only observes what the ADMIN sees (emailDelivery
 *     status) and what an invite-landing visitor sees (Screen I1).
 *
 * KNOWN GAP THIS SUITE CANNOT CLOSE (documented, not faked):
 *   AC-2.1 (bilingual email content) and the truly real "click the link IN
 *   the email" path are not observable through this stack — there is no
 *   mailbox stub wired in (EMAIL_ENABLED=false skips the Resend call
 *   entirely and never renders/stores the HTML body — see
 *   notify-api/src/channels/email.channel.ts). This suite instead seeds an
 *   invitation directly at the DB layer with a real, freshly-generated raw
 *   token (auth/scripts/e2e-invite-fixtures.ts, using the EXACT
 *   `generateInvitationToken()` helper the real create-invitation route
 *   uses) so it can still drive the REAL `GET /invite` landing page and the
 *   REAL resend-rotates-the-token behavior end-to-end — just not gated behind
 *   an actual email inbox.
 */
import { test, expect } from '@playwright/test'
import { seedAdminSession, seedUserSession, applySessionCookie } from './helpers/adminSession'
import { seedInvitationWithKnownToken, cleanupFixtures } from './helpers/inviteFixtures'

const AUTH_URL = (
  process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001'
).replace(/\/$/, '')

const RUN = Date.now().toString(36)
const ADMIN_EMAIL = `inv-admin-${RUN}@operai.test`

test.describe('specs/006-user-invitations — e2e (T14)', () => {
  test.afterAll(() => {
    cleanupFixtures(RUN)
  })

  test.beforeEach(async ({ context }) => {
    const admin = await seedAdminSession(ADMIN_EMAIL, 'QE Invitations Admin')
    await applySessionCookie(context, admin)
  })

  // ── AC-1.6 / AC-2.3 / AC-2.6 ────────────────────────────────────────────
  test('invite a person with a role, they accept via OAuth-equivalent sign-up, and they move from pending to an active user with exactly the invited role (no baseline employee)', async ({
    page,
  }) => {
    const invitedEmail = `invitee-${RUN}@operai.test`

    // Create a fresh, uniquely-named role through the REAL admin API (not a
    // DB shortcut) so AC-2.3's "additive to baseline" check has a role that
    // is provably NOT the baseline `employee` role.
    const admin = await seedAdminSession(ADMIN_EMAIL, 'QE Invitations Admin')
    const roleName = `qe-invite-role-${RUN}`
    // auth's OWN /admin/* routes are guarded by `sessionMiddleware` (better-
    // auth's cookie-based session check, auth/src/admin/users.routes.ts) —
    // NOT the RS256 JWT bearer scheme resource servers like estimai-api/
    // notify-api verify. The Bearer JWT from GET /auth/token is for THOSE
    // services; calls into auth's own admin surface must carry the session
    // Cookie instead (found empirically — the Bearer form 401s here).
    const createRoleRes = await fetch(`${AUTH_URL}/admin/roles`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: roleName }),
    })
    const createRoleBody = await createRoleRes.text()
    expect(createRoleRes.status, createRoleBody).toBe(201)
    const role = JSON.parse(createRoleBody) as { id: string; name: string }

    // ── F1: admin invites, with the role assigned at invite time (AC-1.1) ──
    await page.goto('/admin/users/invitations')
    await expect(page.getByTestId('admin-invitations-page')).toBeVisible({ timeout: 20_000 })

    await page.getByTestId('invitations-invite-button').click()
    await expect(page.getByTestId('invite-user-modal')).toBeVisible()
    await page.getByTestId('invite-user-email').fill(invitedEmail)
    await page.getByTestId(`invite-user-role-${role.id}`).check()
    await page.getByTestId('invite-user-submit').click()

    await expect(page.getByTestId('invite-user-modal')).toBeHidden({ timeout: 10_000 })

    // ── AC-1.6: the new row is visible, in `pending`, roles shown ──────────
    await page.getByTestId('invitations-search-input').fill(invitedEmail)
    const row = page.locator(`tr:has-text("${invitedEmail}")`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toContainText('Pending')
    await expect(row).toContainText(roleName)

    // ── AC-2.3: the invited email "accepts" via the real user.create.after
    // hook — POST /test-auth/session is the exact better-auth internalAdapter
    // path a real OAuth sign-up also goes through (this was independently
    // verified empirically for this QE pass: internalAdapter.createUser()
    // fires databaseHooks.user.create.after end-to-end, including the T8
    // invitation-activation logic, not just the baseline-role hook).
    await seedUserSession(invitedEmail, 'QE Invitee')

    // ── AC-2.6: gone from pending, now an active user ──────────────────────
    await page.getByTestId('invitations-status-filter').selectOption('pending')
    await page.reload()
    await expect(page.getByTestId('admin-invitations-page')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('invitations-search-input').fill(invitedEmail)
    await expect(page.locator(`tr:has-text("${invitedEmail}")`)).toHaveCount(0)

    await page.goto('/admin/users')
    await expect(page.getByTestId('admin-users-page')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('users-search-input').fill(invitedEmail)
    // The `user-row-<id>` testid lives on the name <Link> inside the row,
    // which does NOT itself contain the email cell's text — filter the <tr>
    // by the email, then click the name link nested inside it.
    const userTableRow = page.locator('tr').filter({ hasText: invitedEmail })
    await expect(userTableRow).toBeVisible({ timeout: 10_000 })
    await userTableRow.locator('[data-testid^="user-row-"]').click()

    // ── AC-2.3 exact check: a named-role invite grants EXACTLY the invited
    // role — the baseline `employee` is NOT added (replace-not-add, the
    // resolved R9 decision; empty invites still get baseline employee).
    await expect(page.getByTestId('admin-user-detail-page')).toBeVisible({ timeout: 20_000 })
    // The roles fieldset populates from its own catalog fetch, slightly after
    // the page shell itself renders — wait for it, rather than counting
    // checkboxes on the first (possibly still-empty) render.
    const roleCheckboxes = page.locator('[data-testid^="role-checkbox-"]')
    await expect(roleCheckboxes.first()).toBeVisible({ timeout: 10_000 })
    const checkedIds: string[] = []
    const count = await roleCheckboxes.count()
    for (let i = 0; i < count; i++) {
      const cb = roleCheckboxes.nth(i)
      if (await cb.isChecked()) {
        checkedIds.push((await cb.getAttribute('data-testid'))!.replace('role-checkbox-', ''))
      }
    }
    expect(checkedIds).toContain(role.id)
    expect(checkedIds.length).toBe(1) // EXACTLY the invited role — baseline employee replaced, not added (AC-2.3, resolved R9)
  })

  // ── AC-2.2 / AC-3.3 ──────────────────────────────────────────────────────
  test('invite-landing page shows OAuth sign-in controls for a live pending token, and resend invalidates the OLD link', async ({
    page,
    context,
  }) => {
    const email = `landing-${RUN}@operai.test`
    const { id, token } = seedInvitationWithKnownToken(email)

    // ── AC-2.2: unauthenticated visit to the real landing page ────────────
    const anonContext = await context.browser()!.newContext()
    const anonPage = await anonContext.newPage()
    await anonPage.goto(`${AUTH_URL}/invite?id=${id}&token=${encodeURIComponent(token)}`)
    await expect(anonPage.locator('[data-provider="google"]')).toBeVisible({ timeout: 10_000 })
    await expect(anonPage.locator('[data-provider="github"]')).toBeVisible()
    await expect(anonPage.getByText(email)).toBeVisible()
    await anonContext.close()

    // ── AC-3.3: admin resends via the real UI, rotating the token ──────────
    await page.goto('/admin/users/invitations')
    await expect(page.getByTestId('admin-invitations-page')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('invitations-search-input').fill(email)
    await page.getByTestId(`invitation-resend-${id}`).click()
    await expect(page.getByTestId(`invitation-resend-${id}`)).toHaveText('Resend', { timeout: 10_000 })

    // The OLD token must now be rejected — even though the invitation itself
    // is still very much alive under its NEW (unknown-to-this-test) token.
    const staleContext = await context.browser()!.newContext()
    const stalePage = await staleContext.newPage()
    await stalePage.goto(`${AUTH_URL}/invite?id=${id}&token=${encodeURIComponent(token)}`)
    // A stale (pre-resend) token resolves to the "invalid" state (token-hash
    // mismatch — auth/src/invite/invite.routes.ts's COPY.invalid), rendered as
    // "This link is not valid." — this IS the AC-2.5 "no longer valid"
    // experience (plan.md's own paraphrase); the shipped copy just doesn't
    // use that literal English phrase.
    await expect(stalePage.getByText(/this link is not valid/i)).toBeVisible({ timeout: 10_000 })
    await staleContext.close()
  })

  // ── AC-5.2 / AC-5.3 / AC-5.7 ─────────────────────────────────────────────
  test('deleting a user requires a distinct confirm step, the user vanishes from the list, and their re-sign-in is refused', async ({
    page,
  }) => {
    const targetEmail = `to-delete-${RUN}@operai.test`
    await seedUserSession(targetEmail, 'QE Deletable User')

    await page.goto('/admin/users')
    await expect(page.getByTestId('admin-users-page')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('users-search-input').fill(targetEmail)
    const userTableRow = page.locator('tr').filter({ hasText: targetEmail })
    await expect(userTableRow).toBeVisible({ timeout: 10_000 })
    const rowTestId = await userTableRow.locator('[data-testid^="user-row-"]').getAttribute('data-testid')
    const userId = rowTestId!.replace('user-row-', '')

    // ── AC-5.7 (Cancel path): confirm dialog opens, Cancel is a true no-op ──
    await page.getByTestId(`user-delete-${userId}`).click()
    await expect(page.getByTestId('confirm-delete-modal')).toBeVisible()
    await page.getByTestId('confirm-delete-cancel').click()
    await expect(page.getByTestId('confirm-delete-modal')).toBeHidden()
    await page.getByTestId('users-search-input').fill(targetEmail)
    await expect(page.locator('tr').filter({ hasText: targetEmail })).toBeVisible()

    // ── AC-5.7 (Confirm path) + AC-5.3 (vanishes) ──────────────────────────
    await page.getByTestId(`user-delete-${userId}`).click()
    await expect(page.getByTestId('confirm-delete-modal')).toBeVisible()
    await page.getByTestId('confirm-delete-confirm').click()
    await expect(page.getByTestId('confirm-delete-modal')).toBeHidden({ timeout: 10_000 })
    await page.getByTestId('users-search-input').fill(targetEmail)
    await expect(page.locator('tr').filter({ hasText: targetEmail })).toHaveCount(0, {
      timeout: 10_000,
    })

    // ── AC-5.2: the soft-deleted email's re-sign-in must be refused ────────
    // POST /test-auth/session uses the exact same internalAdapter.createSession
    // path a real OAuth callback uses (see auth.config.test.ts's R1 spike) —
    // session.create.before must deny it since deletedAt is now set and there
    // is no live-pending invitation for this email.
    let refused = false
    try {
      const res = await fetch(`${AUTH_URL}/test-auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, name: 'QE Deletable User' }),
      })
      if (!res.ok || !res.headers.get('set-cookie')) refused = true
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
  })

  // ── AC-6.1 / AC-6.3 (browser-driven, no skips) ─────────────────────────
  test('bulk-selecting two ordinary users and confirming deletes both and reports zero skips', async ({ page }) => {
    const emailA = `bulk-a-${RUN}@operai.test`
    const emailB = `bulk-b-${RUN}@operai.test`
    await seedUserSession(emailA, 'QE Bulk A')
    await seedUserSession(emailB, 'QE Bulk B')

    await page.goto('/admin/users')
    await expect(page.getByTestId('admin-users-page')).toBeVisible({ timeout: 20_000 })

    // Search once for a substring common to both fixtures (same RUN tag) so
    // BOTH rows are visible together — checking each box in a single stable
    // render avoids any re-fetch-between-checks race from re-filling the
    // search box per email (found empirically: re-searching between checks
    // intermittently left only the second checkbox actually toggled).
    await page.getByTestId('users-search-input').fill(RUN)
    for (const email of [emailA, emailB]) {
      const tableRow = page.locator('tr').filter({ hasText: email })
      await expect(tableRow).toBeVisible({ timeout: 10_000 })
      const id = (await tableRow.locator('[data-testid^="user-row-"]').getAttribute('data-testid'))!.replace(
        'user-row-',
        '',
      )
      await page.getByTestId(`user-checkbox-${id}`).check()
    }

    await expect(page.getByTestId('bulk-action-bar')).toBeVisible()
    await page.getByTestId('bulk-delete-button').click()
    await expect(page.getByTestId('confirm-delete-modal')).toBeVisible()
    await page.getByTestId('confirm-delete-confirm').click()

    await expect(page.getByTestId('bulk-delete-result-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('bulk-delete-result-summary')).toContainText('2 of 2')
    await expect(page.getByTestId('bulk-delete-result-skipped-list')).toHaveCount(0)
  })

  // ── AC-6.2 (server-side self-exclusion — direct API, see doc comment) ──
  test('the server itself refuses to delete the acting admin even if asked directly (AC-6.2 defense-in-depth)', async () => {
    const admin = await seedAdminSession(ADMIN_EMAIL, 'QE Invitations Admin')
    const otherEmail = `selfskip-${RUN}@operai.test`
    const otherSession = await seedUserSession(otherEmail, 'QE Bulk Other')

    const res = await fetch(`${AUTH_URL}/admin/users/delete`, {
      method: 'POST',
      headers: { Cookie: admin.cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [admin.userId, otherSession.userId] }),
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as {
      deleted: string[]
      skipped: { userId: string; reason: string }[]
    }
    expect(body.deleted).toContain(otherSession.userId)
    expect(body.deleted).not.toContain(admin.userId)
    const skip = body.skipped.find((s) => s.userId === admin.userId)
    expect(skip).toBeDefined()
    expect(skip!.reason.toLowerCase()).toMatch(/own account|self/)
  })
})
