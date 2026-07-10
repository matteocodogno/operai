/**
 * T16 — Authenticated backend calls succeed inside the shell (specs/003-suite-shell)
 *
 * Refs: AC-2.2 — a signed-in user opening a tool (EstimAI) makes authenticated
 * backend calls (to estimai-api) succeed without any further sign-in prompt.
 *
 * Drives the REAL estimai-api (see shell/playwright.config.ts's prerequisites)
 * rather than mocking the network — this is the whole point of the cross-app
 * e2e gate: prove the shared `shell/session` Bearer-JWT plumbing actually
 * reaches a live resource server across the federation boundary.
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

const apiUrl = (
  process.env['E2E_API_URL'] ??
  process.env['VITE_API_URL'] ??
  'http://localhost:8080'
).replace(/\/$/, '')

test.describe('AC-2.2: opening EstimAI inside the shell makes an authenticated estimai-api call succeed', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('GET /estimates succeeds (200) with a Bearer token, and no sign-in prompt is shown', async ({
    page,
  }) => {
    const estimatesResponsePromise = page.waitForResponse(
      (response) => response.url() === `${apiUrl}/estimates` && response.request().method() === 'GET',
      { timeout: 20_000 },
    )

    await page.goto('/estimai')

    const response = await estimatesResponsePromise
    expect(response.status()).toBe(200)

    const authHeader = response.request().headers()['authorization']
    expect(authHeader).toBeTruthy()
    expect(authHeader).toMatch(/^Bearer .+/)

    // The tool rendered its real content — no error banner, no redirect to
    // sign-in, and the tool's own stable chrome anchor is visible.
    await expect(page).toHaveURL(/\/estimai/)
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
