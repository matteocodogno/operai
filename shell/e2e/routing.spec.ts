/**
 * T16 — Tool routing: URL reflects active tool, reload-safe, deep-link-safe
 * (specs/003-suite-shell)
 *
 * Refs: AC-3.2 (selecting a tool updates the URL; the location is shareable
 * and survives a reload), AC-3.3 (a URL that points directly at a specific
 * tool shows the correct tool first, without flashing a different tool).
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

test.describe('AC-3.2: selecting a tool updates the URL and is reload-safe', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('selecting Refund from the sidebar updates the URL, and reloading stays on Refund', async ({
    page,
  }) => {
    await page.goto('/estimai')
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })

    await page.getByRole('link', { name: 'Refund (Rimborsi)' }).click()

    await expect(page).toHaveURL(/\/refund$/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toBeVisible({
      timeout: 15_000,
    })

    await page.reload()

    await expect(page).toHaveURL(/\/refund$/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('selecting EstimAI from the sidebar updates the URL, and reloading stays on EstimAI', async ({
    page,
  }) => {
    await page.goto('/refund')
    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toBeVisible({
      timeout: 15_000,
    })

    await page.getByRole('link', { name: 'EstimAI' }).click()

    // EstimAI's OWN inner router (createAppRouter('/estimai'), estimai-ui/src/
    // router.tsx) redirects its bare basepath index ('/') to '/estimates' —
    // so the settled URL is `/estimai/estimates`, not the bare `/estimai`.
    // That inner redirect is existing, pre-T16 EstimAI behavior (unchanged by
    // the shell), so this asserts the shell-owned prefix, not the exact path.
    await expect(page).toHaveURL(/\/estimai/, { timeout: 15_000 })
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })

    await page.reload()

    await expect(page).toHaveURL(/\/estimai/, { timeout: 15_000 })
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })
  })
})

test.describe('AC-3.3: deep-linking directly at a tool resolves that tool first, not a different one', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('deep-linking to /refund shows Refund immediately, never EstimAI', async ({ page }) => {
    await page.goto('/refund')

    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toBeVisible({
      timeout: 15_000,
    })
    // EstimAI's stable anchor must never have appeared.
    await expect(page.getByRole('button', { name: /import json/i })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Refund (Rimborsi)' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  test('deep-linking to an inner EstimAI path (/estimai/estimates) resolves EstimAI directly, never Refund', async ({
    page,
  }) => {
    await page.goto('/estimai/estimates')

    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'EstimAI' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })
})
