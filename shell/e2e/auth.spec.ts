/**
 * T16 — Suite-wide session guard (specs/003-suite-shell)
 *
 * Refs: AC-2.5 (session persists on reload), and the RELOCATED coverage of
 * `estimai-ui/e2e/login-wall.spec.ts`'s AC-1.1 (anonymous visit → sign-in,
 * zero app content) — that file tested estimai-ui's OWN `_authed` guard,
 * which T13 removed (estimai-ui is now a federated remote with no guard of
 * its own, AC-2.3). The guard now lives exclusively in the shell
 * (shell/src/router.tsx's `_authed` route), so this is where that coverage
 * belongs now. See this task's final report for the relocation note.
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

const AUTH_ORIGIN = (
  process.env['E2E_AUTH_URL'] ??
  process.env['VITE_AUTH_URL'] ??
  'http://localhost:3001'
).replace(/\/$/, '')

const SHELL_ORIGIN = 'http://localhost:5173'

// ─── Unauthenticated visitor → hosted sign-in, no suite content ──────────────
// (relocated from estimai-ui/e2e/login-wall.spec.ts's AC-1.1 coverage)

test.describe('unauthenticated visitor is redirected to the hosted sign-in', () => {
  // No seedSession — these tests deliberately run with NO session cookie.

  test('visiting the bare root redirects to auth sign-in with no suite content', async ({
    page,
  }) => {
    await page.goto('/')

    await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), {
      timeout: 15_000,
    })
    await expect(
      page.getByRole('heading', { name: /sign in to estimai/i }),
    ).toBeVisible({ timeout: 10_000 })

    // No suite chrome or tool content leaked through before the redirect.
    await expect(page.getByRole('banner')).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: 'Tool navigation' })).toHaveCount(0)
  })

  test('visiting a deep tool link redirects to sign-in with the original URL as the redirect param', async ({
    page,
  }) => {
    const targetPath = '/estimai/estimates'
    const expectedRedirectParam = `${SHELL_ORIGIN}${targetPath}`

    await page.goto(targetPath)

    await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), {
      timeout: 15_000,
    })

    const url = new URL(page.url())
    expect(url.searchParams.get('redirect')).toBe(expectedRedirectParam)
  })

  test('visiting /refund redirects to auth sign-in with no suite content', async ({ page }) => {
    await page.goto('/refund')

    await expect(page).toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), {
      timeout: 15_000,
    })
    await expect(page.getByRole('banner')).toHaveCount(0)
  })
})

// ─── AC-2.5 — session persists across a full page reload ─────────────────────

test.describe('AC-2.5: a signed-in user stays signed in across a reload', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('reloading a tool URL does not ask the user to sign in again', async ({ page }) => {
    await page.goto('/estimai')
    await expect(page).toHaveURL(/\/estimai/, { timeout: 15_000 })
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })

    await page.reload()

    await expect(page).toHaveURL(/\/estimai/, { timeout: 15_000 })
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page).not.toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`))
  })

  test('reloading the bare root still resolves inside the shell (no re-auth)', async ({
    page,
  }) => {
    await page.goto('/')
    // Root redirects to the most-recently-used tool (default EstimAI on a
    // fresh context, AC-3.4) — either way it must land inside the shell, not
    // back at sign-in.
    await expect(page).not.toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), {
      timeout: 15_000,
    })
    await expect(page.getByRole('banner')).toBeVisible({ timeout: 15_000 })

    await page.reload()

    await expect(page).not.toHaveURL(new RegExp(`^${AUTH_ORIGIN}/sign-in`), {
      timeout: 15_000,
    })
    await expect(page.getByRole('banner')).toBeVisible({ timeout: 15_000 })
  })
})
