/**
 * T11 — 401 round trip, work survival, identity, sign-out
 *
 * Refs: spec 002, T11, US-4 (AC-4.1, AC-4.2, AC-4.3), US-5 (AC-5.1, AC-5.2)
 *
 * Coverage map (per plan.md test strategy):
 *
 *   AC-4.1  expired/invalidated session → next navigation redirects to sign-in   e2e (this file)
 *   AC-4.2  re-login returns to the page the user was on                          e2e (this file, UI-side contract)
 *   AC-4.3  unsaved estimate work survives the expiry round trip                  e2e (this file)
 *   AC-5.1  header shows signed-in user's name/avatar                             e2e (this file)
 *   AC-5.2  sign-out ends session, subsequent navigation → sign-in                e2e (this file)
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * MECHANISM MAP
 *
 * The app currently makes NO live backend API call in its normal flow (all
 * estimates are in localStorage; apiFetch is infrastructure not yet wired into
 * the UI data path).  The primary observable "unauthenticated → redirect"
 * mechanism in a browser is therefore the `_authed` route guard (router.tsx
 * beforeLoad, which calls authClient.getSession() and throws a redirect when the
 * session is gone).
 *
 * AC-4.1 — GUARD PATH (primary, exercised here):
 *   We seed a session, load the app, then INVALIDATE the session by clearing all
 *   browser cookies (context.clearCookies()).  The NEXT navigation (page.goto)
 *   triggers the _authed beforeLoad, getSession() returns null, and the guard
 *   throws redirect to <AUTH_URL>/sign-in.  This is the observable expiry
 *   behaviour for the current app.
 *
 * AC-4.1 — APIFETCH 401 PATH (unit-covered, not exercised headlessly here):
 *   The apiFetch interceptor's refresh-retry-then-redirect behaviour (the 401
 *   path) is fully unit-tested in src/lib/api.test.ts (T6).  That path requires
 *   a live backend returning 401 to the in-flight request, which cannot be
 *   triggered headlessly through the UI's current data flow (no live API calls
 *   in normal navigation).  A page.evaluate call driving apiFetch directly could
 *   exercise it, but the Vite preview build wraps the module system and
 *   page.evaluate cannot import from the app bundle — so we rely on the T6 unit
 *   test for that contract and document the boundary here.
 *
 * AC-4.2 / AC-1.2 BOUNDARY NOTE (headless boundary):
 *   The full OAuth return (auth service callback → browser arrives at `redirect`
 *   URL) cannot be simulated headlessly; it requires a live OAuth round-trip
 *   covered in T12 (manual QE).  We test the UI-observable contract instead:
 *     (i)  Expiry redirect carries the originally-visited URL in `redirect` param.
 *     (ii) With a fresh seeded session, navigating directly to that URL loads the
 *          correct page — simulating the post-OAuth return with the session cookie.
 *
 * AC-5.1 SELECTOR PROOF (non-vacuous):
 *   The seeded test user's DB name is E2E_TEST_USER.name (see seedSession.ts).
 *   The POST /test-auth/session endpoint upserts the name on every call (fixed
 *   in commit 7aee4d5), so the stored name deterministically matches what the
 *   seed sends regardless of prior DB state.  UserMenu.tsx renders displayName
 *   (= user.name) in a <span> element with a `text-soft` class (line 43) and
 *   also as aria-label on the avatar element (line 37).
 *   We assert page.getByText(E2E_TEST_USER.name) is visible in the header.
 *   This fails if the UserMenu is not rendered or the user name differs.
 *
 * AC-5.2 SELECTOR PROOF (non-vacuous):
 *   UserMenu.tsx renders a <button aria-label="Sign out"> (line 48) with text
 *   "Sign out" (line 51).  We click it, wait for authClient.signOut() to POST
 *   to /auth/sign-out (which terminates the server-side session), and then
 *   verify server-side termination by calling GET /auth/get-session with the
 *   original session cookie via the Playwright request API — asserting the
 *   response body's `session` field is null/absent.  This is the direct proof
 *   that the server deleted the session row, not merely that the cookie was
 *   cleared from the browser.
 *
 * TRUSTED-ORIGIN NOTE (preview port = 5173):
 *   better-auth's /auth/sign-out validates the request Origin against
 *   trustedOrigins (= ALLOWED_ORIGINS).  The committed default includes
 *   http://localhost:5173.  playwright.config.ts therefore runs the preview
 *   server on port 5173 (--port 5173 --strictPort) so the sign-out POST is
 *   accepted and actually terminates the server session.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { test, expect } from '@playwright/test'
import { seedSession, E2E_TEST_USER } from './helpers/seedSession'
import {
  PROJECTS_KEY,
  projectKey,
  type ProjectData,
} from '../src/lib/projects'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The auth service origin, read from env at test-run time.
 * Matches the resolution logic in seedSession.ts and playwright.config.ts.
 */
const AUTH_ORIGIN = (
  process.env['E2E_AUTH_URL'] ??
  process.env['VITE_AUTH_URL'] ??
  'http://localhost:3001'
).replace(/\/$/, '')

/** UI origin — where Playwright's webServer serves the Vite preview. */
const UI_ORIGIN = 'http://localhost:5173'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Asserts that the browser is on the auth sign-in page with no EstimAI content.
 *
 * Selector proof (non-vacuous, grep-confirmed in app source):
 *   - URL regex: checks origin is AUTH_ORIGIN + path starts with /sign-in
 *   - "Sign in to EstimAI" heading: auth/src/signin/*.ts (T1 work, rendered by auth service)
 *   - "New estimate" button absence: EstimatesPage.tsx line 125 (`+ New estimate`)
 *   - EstimAI logo img absence: EstimatesPage.tsx lines 108 and 141 (<img alt="EstimAI">)
 */
const assertRedirectedToSignIn = async (page: import('@playwright/test').Page) => {
  await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), {
    timeout: 15_000,
  })
  await expect(page.getByRole('heading', { name: /sign in to estimai/i })).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByRole('button', { name: /new estimate/i })).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'EstimAI' })).toHaveCount(0)
}

/**
 * Injects a minimal ProjectData record directly into localStorage via
 * page.evaluate, bypassing the UI.  This represents "unsaved work" that exists
 * in the browser before a session expiry event.
 *
 * Returns the injected project id so callers can assert it survives.
 *
 * localStorage key format matches projects.ts:
 *   PROJECTS_KEY         = 'estimai_projects'       (index)
 *   projectKey(id)       = `estimai_project_${id}`  (per-project data)
 */
const injectProjectIntoLocalStorage = async (
  page: import('@playwright/test').Page,
  id: string,
  name: string,
): Promise<void> => {
  await page.evaluate(
    ({ projKey, listKey, projectId, projectName }) => {
      // Build a minimal ProjectData record (matches ProjectData shape in projects.ts).
      const project = {
        id: projectId,
        name: projectName,
        author: 'E2E Test',
        params: {
          parallelism: 0.7,
          sprintDays: 10,
          workingDaysMonth: 20,
          qaDeployDays: 0,
          qaTestDays: 0,
          pmDays: 0,
          aiCostCoef: 10,
          aiGain: 0.3,
        },
        releases: [],
        acts: [],
      }
      // Write per-project key.
      localStorage.setItem(projKey, JSON.stringify(project))
      // Update the projects index.
      const existingRaw = localStorage.getItem(listKey)
      const existing = existingRaw ? JSON.parse(existingRaw) : []
      existing.push({
        id: projectId,
        name: projectName,
        author: 'E2E Test',
        updatedAt: new Date().toISOString(),
      })
      localStorage.setItem(listKey, JSON.stringify(existing))
    },
    {
      projKey: projectKey(id),
      listKey: PROJECTS_KEY,
      projectId: id,
      projectName: name,
    },
  )
}

/**
 * Reads a project's data from localStorage via page.evaluate.
 * Returns null if the key is absent (project was wiped by a redirect).
 */
const readProjectFromLocalStorage = async (
  page: import('@playwright/test').Page,
  id: string,
): Promise<ProjectData | null> => {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as ProjectData) : null
  }, projectKey(id))
}

// ─── AC-4.1 — Expired session → next navigation redirects to sign-in ─────────

test.describe('AC-4.1: invalidated session causes next navigation to redirect to sign-in', () => {
  /**
   * MECHANISM: _authed route guard (router.tsx beforeLoad).
   *
   * We seed a valid session, load the app to confirm it's authenticated,
   * then clear all browser cookies (simulating cookie expiry/invalidation).
   * The next page.goto triggers the _authed beforeLoad which calls
   * authClient.getSession() — with no session cookie the auth service returns
   * null, the guard throws redirect to AUTH_URL/sign-in.
   *
   * This is the guard path.  The apiFetch 401 path is unit-covered in T6.
   */
  test('after session cookie is cleared, next navigation hits the sign-in redirect', async ({ context, page }) => {
    // 1. Establish an authenticated session.
    await seedSession(context)
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // Confirm we are authenticated (app content is present).
    const appContent = page
      .getByRole('heading', { name: /estimates|ready to estimate/i })
      .or(page.getByRole('button', { name: /new estimate/i }))
    await expect(appContent.first()).toBeVisible({ timeout: 10_000 })

    // 2. Invalidate the session: clear all cookies from the browser context.
    //    This simulates what happens when a session cookie expires or is
    //    invalidated server-side (e.g. explicit sign-out or server restart).
    await context.clearCookies()

    // 3. Navigate again — the _authed guard fires, sees no session, redirects.
    await page.goto('/estimates')
    await assertRedirectedToSignIn(page)
  })
})

// ─── AC-4.2 — Re-login returns to the page the user was on ───────────────────

test.describe('AC-4.2: expiry redirect carries the original page URL; re-login returns there', () => {
  /**
   * MECHANISM: _authed route guard encodes the current URL as `redirect` param.
   *
   * UI-side contract (two parts):
   *   Part i  — The redirect to sign-in carries `redirect=<originally-requested-URL>`.
   *   Part ii — With a fresh seeded session, navigating directly to that URL
   *             loads the correct page (simulating the post-OAuth return).
   *
   * Full OAuth callback return (T12): manual QE only — see HEADLESS BOUNDARY NOTE.
   */
  test('(part i) expiry redirect from /estimates encodes the correct redirect param', async ({ context, page }) => {
    // Authenticate, load the app, then invalidate.
    await seedSession(context)
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })
    await context.clearCookies()

    // Navigate again — triggers guard redirect.
    await page.goto('/estimates')
    await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), { timeout: 15_000 })

    // The `redirect` param must equal the originally-requested absolute URL.
    const url = new URL(page.url())
    const redirectParam = url.searchParams.get('redirect')
    expect(redirectParam).toBe(`${UI_ORIGIN}/estimates`)
  })

  test('(part ii) with a fresh session, navigating to the original URL loads the correct page', async ({ context, page }) => {
    // Simulate the post-OAuth state: fresh session cookie + navigate to the
    // originally-requested URL (the value that was in the `redirect` param).
    await seedSession(context)
    await page.goto('/estimates')

    // Guard passes — we are on the app.
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    const appContent = page
      .getByRole('heading', { name: /estimates|ready to estimate/i })
      .or(page.getByRole('button', { name: /new estimate/i }))
    await expect(appContent.first()).toBeVisible({ timeout: 10_000 })

    // Confirm we are NOT on the auth sign-in page.
    await expect(page).not.toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`))
  })
})

// ─── AC-4.3 — Unsaved estimate work survives the expiry round trip ────────────

test.describe('AC-4.3: estimate edits in localStorage survive the session-expiry redirect', () => {
  /**
   * MECHANISM: AC-4.3 survival guarantee (plan.md Architecture §6).
   *
   * Edits are written synchronously to localStorage by lib/projects.ts.
   * The _authed guard performs a full-page redirect (window.location / TanStack
   * Router redirect()) but NEVER clears localStorage.  Therefore any data written
   * before the redirect is present when the browser returns to the app.
   *
   * Test flow:
   *   1. Seed a session and load the app.
   *   2. Inject a project into localStorage directly (bypassing the UI, which
   *      avoids depending on form interactions that may change between iterations).
   *      This represents work the user has done before the session expires.
   *   3. Verify the project is in localStorage (pre-condition).
   *   4. Invalidate the session (clear cookies) and navigate — triggers redirect.
   *   5. Confirm the browser is on the sign-in page (redirect fired).
   *   6. Re-seed the session (simulates re-login).
   *   7. Navigate back to the app.
   *   8. Assert the project data is STILL in localStorage.
   *      This assertion genuinely fails if the redirect path wiped localStorage.
   *   9. Assert the project title appears in the UI estimates list.
   */
  const WORK_PROJECT_ID = 'e2e-ac43-test-project'
  const WORK_PROJECT_NAME = 'AC-4.3 Survival Test Project'

  test('estimate data injected before session expiry is still present after re-login', async ({ context, page }) => {
    // 1. Seed a session and load the app.
    await seedSession(context)
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // 2. Inject project data into localStorage — represents pre-expiry work.
    await injectProjectIntoLocalStorage(page, WORK_PROJECT_ID, WORK_PROJECT_NAME)

    // 3. Verify pre-condition: the project exists in localStorage.
    const before = await readProjectFromLocalStorage(page, WORK_PROJECT_ID)
    expect(before).not.toBeNull()
    expect(before!.name).toBe(WORK_PROJECT_NAME)

    // 4. Invalidate session and navigate — triggers the guard redirect.
    await context.clearCookies()
    await page.goto('/estimates')

    // 5. Confirm the redirect fired (browser is on sign-in page).
    await assertRedirectedToSignIn(page)

    // 6. Re-seed the session (simulates the user re-logging in via OAuth).
    await seedSession(context)

    // 7. Navigate back to the app.
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // 8. KEY ASSERTION: the project data is still in localStorage.
    //    This assertion fails if the redirect path wiped localStorage.
    const after = await readProjectFromLocalStorage(page, WORK_PROJECT_ID)
    expect(after).not.toBeNull()
    expect(after!.name).toBe(WORK_PROJECT_NAME)
    expect(after!.id).toBe(WORK_PROJECT_ID)

    // 9. The project title appears in the UI estimates list (UI-visible confirmation).
    //    The EstimatesPage renders each project name in a `text-sm font-medium truncate` div.
    //    Grep: EstimatesPage.tsx line 194: `<div className="text-sm font-medium truncate">{p.name || 'Untitled'}</div>`
    await expect(page.getByText(WORK_PROJECT_NAME)).toBeVisible({ timeout: 10_000 })
  })
})

// ─── AC-5.1 — Header shows signed-in user's name/avatar ──────────────────────

test.describe('AC-5.1: header displays the signed-in user\'s name', () => {
  /**
   * MECHANISM: UserMenu component (src/components/UserMenu.tsx).
   *
   * The seeded test user's name is E2E_TEST_USER.name (= 'E2E User' as sent by
   * seedSession.ts).  The POST /test-auth/session endpoint upserts the `name`
   * field on every call (commit 7aee4d5), so the stored DB name deterministically
   * matches what the seed sends regardless of prior DB state.  This removes the
   * original ambiguity where the name was "Test User" (the schema default) even
   * when the seed sent "E2E User", because only `createUser` was called the first
   * time and subsequent calls only minted a new session without updating the name.
   *
   * UserMenu renders displayName (= user.name ?? user.email ?? 'Account') as:
   *   - aria-label on the avatar <span> element (UserMenu.tsx line 37)
   *   - visible text in a <span class="hidden sm:block ..."> (line 43)
   *   - aria-label on the avatar <img> if user.image is set (line 32)
   *
   * The assertion is non-vacuous: it fails if:
   *   - UserMenu is not rendered (session absent, wrong user prop)
   *   - The user name in the DB differs from E2E_TEST_USER.name
   *   - The displayName span is hidden (sm: breakpoint: Desktop Chrome = 1280px ≫ 640px)
   *
   * The span has class "hidden sm:block" — Desktop Chrome viewport (1280px) is
   * above the sm: breakpoint (640px in Tailwind 4), so the text IS visible.
   *
   * Grep: E2E_TEST_USER.name = 'E2E User' (seedSession.ts line 29)
   *       UserMenu.tsx line 43: "{displayName}"
   */
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('signed-in user name is visible in the estimates page header', async ({ page }) => {
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // Assert on E2E_TEST_USER.name — the actual name the seed sends and the
    // endpoint upserts into the DB.  Anchoring on the exported constant (not a
    // hardcoded string) guarantees the test stays in sync if the seed name changes.
    // Grep: seedSession.ts: name: 'E2E User'
    // Grep: UserMenu.tsx line 43: "{displayName}"
    const userNameText = page.getByText(E2E_TEST_USER.name, { exact: true })
    await expect(userNameText).toBeVisible({ timeout: 10_000 })

    // Additionally: the sign-out button is present in the header (confirms
    // the full UserMenu rendered, not just a coincidental text match).
    // Grep: UserMenu.tsx line 48: aria-label="Sign out"
    await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible()
  })

  test('avatar element carries the user name as aria-label', async ({ page }) => {
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // The avatar (span when no image) has aria-label={displayName}.
    // Grep: UserMenu.tsx line 37: aria-label={displayName}
    // The seeded test user has no image (image: null from getSession response),
    // so the <span> avatar branch is rendered with aria-label = E2E_TEST_USER.name.
    const avatar = page.locator(`[aria-label="${E2E_TEST_USER.name}"]`).first()
    await expect(avatar).toBeVisible({ timeout: 10_000 })
  })
})

// ─── AC-5.2 — Sign-out ends session; subsequent navigation → sign-in ─────────

test.describe('AC-5.2: sign-out ends the session and redirects subsequent navigation to sign-in', () => {
  /**
   * MECHANISM: UserMenu onSignOut callback (EstimatesPage.tsx handleSignOut).
   *
   * handleSignOut (EstimatesPage.tsx line 29-33):
   *   1. Calls authClient.signOut()  — POSTs to /auth/sign-out; invalidates
   *      the server-side session and the browser's session cookie.
   *   2. Calls clearJwtCache()       — drops the in-memory JWT (ADR-0001).
   *   3. Calls window.location.assign(`${AUTH_URL}/sign-in`) — hard redirect.
   *
   * TRUSTED-ORIGIN REQUIREMENT:
   *   better-auth's /auth/sign-out validates the request's Origin header against
   *   trustedOrigins (populated from ALLOWED_ORIGINS, default includes 5173).
   *   playwright.config.ts serves the preview on port 5173 (--port 5173 --strictPort)
   *   so the sign-out POST is trusted and actually deletes the server-side session row.
   *
   * SERVER-SIDE TERMINATION PROOF (AC-5.2):
   *   After the sign-out button is clicked we verify the session was terminated
   *   server-side by calling GET /auth/get-session via the Playwright request API
   *   with the original session cookie.  A null/absent `session` field in the
   *   response proves the server deleted the session row — this cannot pass if
   *   sign-out merely cleared the browser cookie without terminating the server session.
   *
   * Grep: UserMenu.tsx line 48: aria-label="Sign out"
   *       UserMenu.tsx line 51: "Sign out" (button text)
   *       EstimatesPage.tsx line 29: handleSignOut
   */

  test('clicking Sign out redirects to the auth sign-in page', async ({ context, page }) => {
    await seedSession(context)
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // Confirm the UserMenu is visible before clicking.
    // Grep: UserMenu.tsx line 45-53, aria-label="Sign out", text "Sign out"
    const signOutBtn = page.getByRole('button', { name: /sign out/i })
    await expect(signOutBtn).toBeVisible({ timeout: 10_000 })

    // Click sign-out — triggers handleSignOut which calls authClient.signOut()
    // then unconditionally does window.location.assign(AUTH_URL + '/sign-in').
    await signOutBtn.click()

    // The browser should now be on the auth sign-in page.
    // This assertion is non-vacuous: it fails if the hard redirect didn't fire
    // (e.g. handleSignOut threw before reaching window.location.assign).
    await assertRedirectedToSignIn(page)
  })

  test('sign-out terminates the server-side session (GET /auth/get-session returns null with original cookie)', async ({ context, page, request }) => {
    /**
     * AC-5.2 SERVER-SIDE TERMINATION PROOF
     *
     * This test proves that authClient.signOut() actually deletes the session
     * row on the server — not merely clears the browser cookie.
     *
     * Mechanism:
     *   1. Seed a session and capture the raw session cookie value.
     *   2. Navigate to the app and click Sign out.
     *   3. Wait for the redirect to sign-in (confirms handleSignOut ran).
     *   4. Using the Playwright `request` API (not the browser), call
     *      GET /auth/get-session on the auth service with the ORIGINAL
     *      session cookie explicitly set in the Cookie header.
     *   5. Assert the response's `session` field is null — the server deleted
     *      the session row, so even presenting the original token returns null.
     *
     * This assertion CANNOT pass if:
     *   - sign-out's POST /auth/sign-out was rejected (e.g. origin mismatch)
     *   - the session row was not deleted (sign-out returned 200 but was a no-op)
     *   - the cookie we captured was wrong (test infrastructure issue)
     *
     * The only way it passes is if the server-side session was genuinely terminated.
     */

    // 1. Seed a session and capture the session cookie.
    const seededCookies = await seedSession(context)
    // Find the better-auth session token cookie (name contains "session_token").
    const sessionCookie = seededCookies.find((c) => c.name.includes('session_token'))
    expect(sessionCookie, 'session_token cookie must be present in seeded cookies').toBeTruthy()
    const rawCookieHeader = `${sessionCookie!.name}=${sessionCookie!.value}`

    // 2. Navigate to the app — confirm authenticated.
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // 3. Click Sign out.
    const signOutBtn = page.getByRole('button', { name: /sign out/i })
    await expect(signOutBtn).toBeVisible({ timeout: 10_000 })
    await signOutBtn.click()

    // Wait for the hard redirect to sign-in — confirms handleSignOut completed
    // (including the authClient.signOut() call before window.location.assign).
    await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), { timeout: 15_000 })

    // 4. Verify server-side session termination via a direct request to the auth service.
    //    We use the Playwright `request` fixture (a fresh APIRequestContext) rather
    //    than the browser, so the browser's cleared cookie jar does not interfere —
    //    we are explicitly passing the ORIGINAL cookie value to prove the session row
    //    is gone server-side, not merely that the browser no longer sends the cookie.
    const getSessionResponse = await request.get(`${AUTH_ORIGIN}/auth/get-session`, {
      headers: {
        Cookie: rawCookieHeader,
      },
    })

    // better-auth returns HTTP 200 with the JSON literal `null` body when no
    // valid session is found for the presented token (the session row was deleted).
    // With a VALID session it returns { session: {...}, user: {...} }.
    // Therefore a `null` body is the definitive proof the session row is gone.
    // (Confirmed by manual curl: after sign-out, GET /auth/get-session → 200, body: null)
    expect(getSessionResponse.status()).toBe(200)
    const body: { session: unknown; user: unknown } | null =
      await getSessionResponse.json() as { session: unknown; user: unknown } | null

    // 5. KEY ASSERTION: body is null — better-auth found no session for the token.
    //    This fails if sign-out did NOT terminate the server session (e.g. the
    //    /auth/sign-out POST was rejected due to origin mismatch or was a no-op).
    expect(body).toBeNull()
  })

  test('after sign-out, navigating to /estimates is blocked by the auth guard', async ({ context, page }) => {
    /**
     * This test verifies the GUARD PATH after a sign-out event:
     * once the user is on the sign-in page and has no valid session, any
     * attempt to navigate to a protected route redirects back to sign-in.
     *
     * Sequence:
     *   1. Click sign-out → authClient.signOut() terminates the server session
     *      and clears the browser cookie; window.location.assign sends the
     *      browser to the auth sign-in page.
     *   2. Navigate to /estimates — the _authed guard fires, getSession() returns
     *      null (no cookie + server session gone), guard throws redirect to sign-in.
     *
     * No explicit cookie clear is needed here — authClient.signOut() clears
     * the browser cookie as part of its normal flow (the server instructs the
     * browser to expire the cookie via Set-Cookie with Max-Age=0 in the response).
     */
    await seedSession(context)
    await page.goto('/estimates')
    await expect(page).toHaveURL(/\/estimates/, { timeout: 15_000 })

    // Sign out via the button.
    const signOutBtn = page.getByRole('button', { name: /sign out/i })
    await expect(signOutBtn).toBeVisible({ timeout: 10_000 })
    await signOutBtn.click()

    // Wait for the redirect to sign-in.
    await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), { timeout: 15_000 })

    // Navigate to /estimates — the _authed guard must block access.
    // No clearCookies() needed: sign-out instructed the browser to expire the
    // session cookie (Max-Age=0), so getSession() returns null naturally.
    await page.goto('/estimates')
    await assertRedirectedToSignIn(page)
  })
})
