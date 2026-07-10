/**
 * Suite-wide sign-out (T18, specs/003-suite-shell, AC-2.4).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES HERE (relocated from estimai-ui/e2e/session-expiry.spec.ts's
 * AC-5.2 sign-out coverage)
 *
 * T14 moved the sign-out control out of EstimAI's own header and into the
 * SHELL chrome (shell/src/components/UserMenu.tsx), wired to the shared
 * `shell/session` signOut (T4). estimai-ui no longer renders a sign-out
 * button, so its standalone sign-out e2e is obsolete. The T16 shell e2e suite
 * covers the guard redirect (auth.spec.ts) and reload persistence (AC-2.5) but
 * did NOT cover AC-2.4 (suite-wide sign-out termination) at the e2e level —
 * this spec closes that gap so the relocated coverage isn't silently dropped.
 *
 * WHAT THIS PROVES (against the live auth service):
 *   Signing out from the shell chrome terminates the session for the whole
 *   suite — proven transport-independently by GET /auth/get-session returning
 *   null even when presented the ORIGINAL session cookie (the server deleted
 *   the row) — and a subsequent navigation to a protected tool route is then
 *   intercepted by the shell's `_authed` guard and redirected to sign-in.
 *
 * The shell's UserMenu default sign-out (`void signOut()`) clears the shared
 * in-memory JWT cache (ADR-0001) and calls better-auth's signOut; the auth
 * service trusts the shell's origin (localhost:5173 is in ALLOWED_ORIGINS),
 * so the /auth/sign-out POST actually deletes the server-side session row.
 */

import { test, expect } from '@playwright/test'
import { seedSession, E2E_TEST_USER } from './helpers/seedSession'

const AUTH_ORIGIN = (
  process.env['E2E_AUTH_URL'] ??
  process.env['VITE_AUTH_URL'] ??
  'http://localhost:3001'
).replace(/\/$/, '')

test.describe('AC-2.4: signing out from the shell terminates the suite-wide session', () => {
  test('sign-out deletes the server-side session and the guard blocks the next navigation', async ({
    context,
    page,
    request,
  }) => {
    // Seed a session and capture the raw session cookie for the server-side
    // termination proof below.
    const cookies = await seedSession(context)
    const sessionCookie = cookies.find((c) => c.name.includes('session_token'))
    expect(sessionCookie, 'session_token cookie must be present in the seeded cookies').toBeTruthy()
    const rawCookieHeader = `${sessionCookie!.name}=${sessionCookie!.value}`

    // Open the shell with EstimAI active; the chrome (and its UserMenu) mounts.
    await page.goto('/estimai')
    await expect(page.getByRole('banner')).toBeVisible({ timeout: 15_000 })

    // Open the user menu (its button's accessible name is the signed-in user's
    // name — unique vs the LogoMenu's "… menu" button which also has a popup).
    const userMenuButton = page.getByRole('button', { name: E2E_TEST_USER.name })
    await expect(userMenuButton, 'UserMenu avatar button must be visible').toBeVisible({
      timeout: 15_000,
    })
    await userMenuButton.click()

    // Click "Sign out" and wait for the better-auth sign-out POST to complete.
    const signOutResponse = page.waitForResponse(
      (r) => r.url().includes('/sign-out') && r.request().method() === 'POST',
      { timeout: 15_000 },
    )
    await page.getByRole('menuitem', { name: 'Sign out' }).click()
    await signOutResponse

    // KEY PROOF (AC-2.4): the server-side session row is gone — presenting the
    // ORIGINAL cookie to /auth/get-session returns 200 with a null body. This
    // cannot pass if sign-out only cleared the browser cookie without
    // terminating the server session.
    const getSessionResponse = await request.get(`${AUTH_ORIGIN}/auth/get-session`, {
      headers: { Cookie: rawCookieHeader },
    })
    expect(getSessionResponse.status()).toBe(200)
    const body = (await getSessionResponse.json()) as { session: unknown; user: unknown } | null
    expect(body, 'the server must have deleted the session row').toBeNull()

    // The suite-wide guard now blocks a fresh navigation to a protected tool.
    await page.goto('/estimai')
    await expect(page, 'the _authed guard must redirect to sign-in after sign-out').toHaveURL(
      new RegExp(`^${AUTH_ORIGIN}/sign-in`),
      { timeout: 15_000 },
    )
  })
})
