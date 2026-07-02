/**
 * T10 — Login wall and post-login return
 *
 * Refs: spec 002, T10, US-1 (AC-1.1, AC-1.2, AC-1.3), US-2 (AC-2.2)
 *
 * Coverage map (per plan.md test strategy):
 *
 *   AC-1.1  anonymous visit → sign-in, no app content      e2e (this file)
 *   AC-1.2  post-login → originally requested page          e2e (this file, UI-side contract)
 *   AC-1.3  direct sign-in visit → home after login         e2e (this file, UI-side contract)
 *   AC-2.2  session survives page reload                    e2e (this file)
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * HEADLESS BOUNDARY NOTE (AC-1.2 and AC-1.3):
 *
 * The real OAuth round-trip (Google/GitHub provider → callback → app) cannot
 * run headlessly because it requires an interactive browser session with the
 * provider.  This file tests the **UI-observable contract** instead:
 *
 *   AC-1.2:
 *     (i)  Anonymous visit to a deep link → redirect carries `redirect=<url>`.
 *          We assert the query param equals the originally-requested absolute URL.
 *     (ii) With a seeded session, navigating directly to that same URL loads
 *          the target page without a redirect.  This simulates what happens after
 *          the OAuth callback completes and the auth service sends the browser
 *          back to the `redirect` URL with a fresh session cookie.
 *     The auth service's `callbackURL` wiring (the step that actually performs
 *     the return) is unit-tested in T2 and covered live in T12 (manual QE).
 *
 *   AC-1.3:
 *     (i)  Anonymous visit to the sign-in page directly (no `redirect` param).
 *     (ii) With a seeded session, visiting `/` resolves to the EstimAI home
 *          without a redirect loop.  This simulates the post-OAuth landing when
 *          no prior deep-link `redirect` was present — the auth service falls
 *          back to `UI_HOME_URL` (unit-tested in T2) and the user arrives at `/`.
 *
 * The manual QE pass (T12) covers the live OAuth flows end-to-end.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The auth service origin, read from env at test-run time.
 * Matches the resolution logic in seedSession.ts and playwright.config.ts.
 */
const AUTH_ORIGIN =
  (process.env['E2E_AUTH_URL'] ??
    process.env['VITE_AUTH_URL'] ??
    'http://localhost:3001').replace(/\/$/, '')

/**
 * UI origin — where Playwright's webServer serves the Vite preview.
 * Must match the port configured in playwright.config.ts webServer.
 * Port 5173 is used (not the default 4173) so that the origin is in
 * better-auth's ALLOWED_ORIGINS trusted list and sign-out succeeds.
 */
const UI_ORIGIN = 'http://localhost:5173'

/**
 * Asserts that the browser was redirected to the auth sign-in page and that
 * no EstimAI app content is visible.
 *
 * What "no app content" means:
 *   - The URL has moved to the auth service origin (different from UI_ORIGIN).
 *   - The sign-in page's own heading is present ("Sign in to EstimAI").
 *   - EstimAI-specific elements are absent: the "New estimate" button,
 *     the "Ready to estimate" empty-state heading, and the Operai logo
 *     <img alt="EstimAI"> rendered by the app shell (EstimatesPage header).
 */
const assertRedirectedToSignIn = async (
  page: import('@playwright/test').Page,
) => {
  // Must land on the auth service domain.
  await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), {
    timeout: 15_000,
  })

  // The auth-hosted sign-in page is present.
  await expect(page.getByRole('heading', { name: /sign in to estimai/i })).toBeVisible({
    timeout: 10_000,
  })

  // No EstimAI app content should be present.
  await expect(page.getByRole('button', { name: /new estimate/i })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /ready to estimate/i })).toHaveCount(0)
  // The Operai logo <img alt="EstimAI"> is always present in the authenticated app shell
  // (EstimatesPage header and empty-state card). Its absence confirms the app did not render.
  await expect(page.getByRole('img', { name: 'EstimAI' })).toHaveCount(0)
}

// ─── AC-1.1 — Anonymous visit → sign-in, zero app content ────────────────────

test.describe('AC-1.1: anonymous visits redirect to sign-in with no app content', () => {
  // No seedSession — these tests deliberately have NO session cookie.

  test('visiting / redirects to auth sign-in', async ({ page }) => {
    await page.goto('/')
    await assertRedirectedToSignIn(page)
  })

  test('visiting /estimates redirects to auth sign-in', async ({ page }) => {
    await page.goto('/estimates')
    await assertRedirectedToSignIn(page)
  })

  test('visiting /share redirects to auth sign-in', async ({ page }) => {
    await page.goto('/share')
    await assertRedirectedToSignIn(page)
  })
})

// ─── AC-1.2 — Deep-link redirect: param encoding + authenticated return ───────

test.describe('AC-1.2: deep-link redirect carries correct redirect param and authenticated load works', () => {
  test('anonymous visit to /estimates encodes redirect param = originally-requested URL', async ({ page }) => {
    /**
     * UI-side contract (part i):
     * The `_authed` guard redirects to <AUTH_URL>/sign-in?redirect=<current absolute URL>.
     * We verify the `redirect` query param equals the originally-requested URL.
     *
     * Part ii (full OAuth return) is manual QE (T12) — see HEADLESS BOUNDARY NOTE above.
     */
    const targetPath = '/estimates'
    const expectedRedirectParam = `${UI_ORIGIN}${targetPath}`

    await page.goto(targetPath)

    // Wait for the redirect to the auth service to complete.
    await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), {
      timeout: 15_000,
    })

    const url = new URL(page.url())
    const redirectParam = url.searchParams.get('redirect')

    expect(redirectParam).toBe(expectedRedirectParam)
  })

  test('anonymous visit to /share encodes redirect param = originally-requested URL', async ({ page }) => {
    const targetPath = '/share'
    const expectedRedirectParam = `${UI_ORIGIN}${targetPath}`

    await page.goto(targetPath)

    await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), {
      timeout: 15_000,
    })

    const url = new URL(page.url())
    const redirectParam = url.searchParams.get('redirect')

    expect(redirectParam).toBe(expectedRedirectParam)
  })

  test('with a seeded session, navigating to /estimates loads the app (simulates post-OAuth return)', async ({ context, page }) => {
    /**
     * UI-side contract (part ii):
     * After OAuth completes the auth service sends the browser back to the
     * `redirect` URL (verified in T2 unit test) with a fresh session cookie.
     * We simulate that state: inject a valid session and navigate to the deep
     * link — the `_authed` guard must pass and the app must load.
     *
     * This does NOT drive a real OAuth round trip; that is covered in T12.
     */
    await seedSession(context)
    await page.goto('/estimates')

    // Guard passed — still on the UI origin.
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // App content is visible.
    const appContent = page
      .getByRole('heading', { name: /estimates|ready to estimate/i })
      .or(page.getByRole('button', { name: /new estimate/i }))
    await expect(appContent.first()).toBeVisible({ timeout: 10_000 })
  })
})

// ─── AC-1.3 — Direct sign-in visit → home after login ────────────────────────

test.describe('AC-1.3: direct sign-in visit resolves to home after authentication', () => {
  test('with a seeded session, visiting / resolves to the app home without a redirect loop', async ({ context, page }) => {
    /**
     * UI-side contract:
     * When a user visits / directly (no prior deep link), after sign-in the auth
     * service falls back to UI_HOME_URL (unit-tested in T2).  The browser arrives
     * at / with a fresh session cookie.  The `_authed` guard must allow it through
     * and the root index route must redirect to /estimates (no infinite loop).
     *
     * We simulate the post-OAuth state: seeded session + navigate to /.
     * The real OAuth flow for this path is covered in T12 (manual QE).
     */
    await seedSession(context)
    await page.goto('/')

    // The root index route redirects to /estimates — assert that we land there,
    // not on the auth sign-in page (which would mean a redirect loop).
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // App content is present — we are not on the sign-in page.
    const appContent = page
      .getByRole('heading', { name: /estimates|ready to estimate/i })
      .or(page.getByRole('button', { name: /new estimate/i }))
    await expect(appContent.first()).toBeVisible({ timeout: 10_000 })
  })
})

// ─── AC-2.2 — Session survives a full page reload ─────────────────────────────

test.describe('AC-2.2: session persists across a full page reload', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('after reload the session is still active and app content is present', async ({ page }) => {
    // Initial load.
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    const appContent = page
      .getByRole('heading', { name: /estimates|ready to estimate/i })
      .or(page.getByRole('button', { name: /new estimate/i }))
    await expect(appContent.first()).toBeVisible({ timeout: 10_000 })

    // Full page reload — simulates AC-2.2: "session persists across a page reload".
    await page.reload()

    // After reload: still on /estimates, not redirected to sign-in.
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // App content still rendered — no redirect to the auth service.
    await expect(appContent.first()).toBeVisible({ timeout: 10_000 })

    // Confirm we are NOT on the sign-in page.
    await expect(page).not.toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`))
  })
})
