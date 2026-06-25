/**
 * T9 smoke test — seeded-session harness verification.
 *
 * Proves that the Playwright e2e infrastructure works end-to-end:
 *   - The seeded-session helper establishes a better-auth session without OAuth.
 *   - With that session injected into the browser context, the UI's `_authed`
 *     route guard allows access (no redirect to /sign-in).
 *   - The estimates list page is visible.
 *
 * This spec is NOT about login-wall or session-expiry behaviours — those are
 * T10 and T11 respectively.  This is purely a harness smoke test.
 *
 * Refs: spec 002, T9, AC-1.1 (e2e enabling infra)
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

test.describe('seeded-session harness smoke test', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('authenticated session bypasses the login wall and shows the estimates list', async ({ page }) => {
    // Navigate to the estimates page.  Without a session the guard would
    // redirect to the auth service sign-in page; with a seeded session it
    // should render the EstimatesPage component.
    await page.goto('/estimates')

    // The page must NOT be the auth sign-in page.
    // The sign-in page is hosted at the auth service (localhost:3001),
    // so a redirect would cause the URL to change domain.
    await expect(page).toHaveURL(/\/estimates/)

    // The estimates list heading or new-estimate button must be present —
    // confirming the app rendered, not the sign-in page.
    // EstimatesPage renders an "h1" with "Your estimates" or a "New estimate" button.
    const appContent = page.getByRole('heading').or(
      page.getByRole('button', { name: /new estimate/i })
    )
    await expect(appContent.first()).toBeVisible({ timeout: 15_000 })
  })
})
