/**
 * T16 — Refund placeholder is authed-only (specs/003-suite-shell)
 *
 * Refs: AC-5.2 — selecting Refund shows a minimal placeholder tool inside the
 * shell, authenticated by the shell's session (it renders content only for a
 * signed-in user, and reads the shared session's identity — not a locally
 * re-created auth client).
 */

import { test, expect } from '@playwright/test'
import { seedSession, E2E_TEST_USER } from './helpers/seedSession'

test.describe('AC-5.2: Refund renders only for a signed-in user, using the shared shell session', () => {
  test('signed-in: the Refund placeholder renders and shows the shared-session identity', async ({
    context,
    page,
  }) => {
    await seedSession(context)

    await page.goto('/refund')

    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText(/coming soon/i)).toBeVisible()

    // Proves the identity comes from the shared `shell/session` module
    // (useSession(), T4), not a locally re-created auth client — the
    // displayed name is the E2E test user's name from the seeded session.
    const signedInAs = page.getByTestId('refund-signed-in-as')
    await expect(signedInAs).toBeVisible({ timeout: 15_000 })
    await expect(signedInAs).toContainText(E2E_TEST_USER.name)
  })

  test('unauthenticated: selecting Refund never renders its content — the shell guard intercepts first', async ({
    page,
  }) => {
    // No seedSession — the shell's suite-wide `_authed` guard (AC-2.1) must
    // resolve before Refund's own component is ever mounted, so there is no
    // "Refund renders with signed-out content" state to reach.
    await page.goto('/refund')

    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toHaveCount(0)
    await expect(page.getByTestId('refund-signed-in-as')).toHaveCount(0)
  })
})
