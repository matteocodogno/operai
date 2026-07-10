/**
 * T16 — Chrome persistence + design-system consistency (specs/003-suite-shell)
 *
 * Refs: AC-1.2 (chrome stays mounted and unchanged when the active tool
 * switches — no reload/flicker, only the content area swaps), AC-1.3 (any
 * tool displayed inside the shell renders in the suite's shared typography
 * and color palette).
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

test.describe('AC-1.2: shared chrome persists across a tool switch', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('switching EstimAI -> Refund does not remount the header/sidebar/footer or reload the page', async ({
    page,
  }) => {
    await page.goto('/estimai')
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })

    // Mark the persistent chrome landmarks with attributes React does not
    // manage. If the underlying DOM node survives the tool switch (i.e. the
    // component was NOT unmounted/remounted), these attributes survive too —
    // React's reconciler only touches the props/attributes it owns and
    // leaves externally-added ones alone as long as it reuses the same node.
    // A `window`-scoped marker additionally proves no FULL page
    // reload/navigation occurred (a document reload would reset `window`).
    await page.evaluate(() => {
      document.querySelector('header[role="banner"]')?.setAttribute('data-e2e-stable', 'header')
      document
        .querySelector('nav[aria-label="Tool navigation"]')
        ?.setAttribute('data-e2e-stable', 'sidebar')
      document.querySelector('footer[role="contentinfo"]')?.setAttribute('data-e2e-stable', 'footer')
      ;(window as unknown as { __e2eNoReload: boolean }).__e2eNoReload = true
    })

    await page.getByRole('link', { name: 'Refund (Rimborsi)' }).click()

    await expect(page).toHaveURL(/\/refund/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toBeVisible({
      timeout: 15_000,
    })

    // Chrome landmarks were never torn down.
    await expect(page.locator('header[role="banner"][data-e2e-stable="header"]')).toHaveCount(1)
    await expect(
      page.locator('nav[aria-label="Tool navigation"][data-e2e-stable="sidebar"]'),
    ).toHaveCount(1)
    await expect(page.locator('footer[role="contentinfo"][data-e2e-stable="footer"]')).toHaveCount(
      1,
    )

    // No full document reload happened.
    const noReloadMarkerSurvived = await page.evaluate(
      () => (window as unknown as { __e2eNoReload?: boolean }).__e2eNoReload === true,
    )
    expect(noReloadMarkerSurvived).toBe(true)

    // Only one banner/nav/contentinfo landmark exists for the whole document
    // at any time — switching tools does not duplicate the chrome either.
    await expect(page.getByRole('banner')).toHaveCount(1)
    await expect(page.getByRole('contentinfo')).toHaveCount(1)
  })

  test('switching Refund -> EstimAI likewise keeps the chrome mounted', async ({ page }) => {
    await page.goto('/refund')
    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toBeVisible({
      timeout: 15_000,
    })

    await page.evaluate(() => {
      document.querySelector('header[role="banner"]')?.setAttribute('data-e2e-stable', 'header')
    })

    await page.getByRole('link', { name: 'EstimAI' }).click()

    await expect(page).toHaveURL(/\/estimai/, { timeout: 15_000 })
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.locator('header[role="banner"][data-e2e-stable="header"]')).toHaveCount(1)
  })
})

test.describe('AC-1.3: remotes render in the shared Operai design system', () => {
  // Force a deterministic dark color scheme: the suite's :root design tokens
  // (shell/src/styles/tokens.css) declare the dark-ink palette directly on
  // `:root`; the light-theme override only applies under
  // `@media (prefers-color-scheme: light)` (or an explicit data-theme
  // override). Pinning `dark` here means the assertions below check the
  // suite's actual default look, not whatever the test runner's OS defaults to.
  test.use({ colorScheme: 'dark' })

  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('the shell document uses the shared DM Sans / dark-ink palette', async ({ page }) => {
    await page.goto('/estimai')
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })

    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
    expect(bodyFont).toContain('DM Sans')

    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    // --ink: #0d0d14 -> rgb(13, 13, 20)
    expect(bodyBg).toBe('rgb(13, 13, 20)')

    const headerBg = await page.evaluate(() => {
      const header = document.querySelector('header[role="banner"]')
      return header ? getComputedStyle(header).backgroundColor : null
    })
    // bg-ink-soft -> --color-ink-soft: #13131e -> rgb(19, 19, 30)
    expect(headerBg).toBe('rgb(19, 19, 30)')
  })

  test('the Refund remote consumes the shell-exposed tokens.css at runtime (cross-boundary consistency)', async ({
    page,
  }) => {
    await page.goto('/refund')
    const heading = page.getByRole('heading', { name: 'Refund (Rimborsi)' })
    await expect(heading).toBeVisible({ timeout: 15_000 })

    // Refund's own root component (refund-ui/src/App.tsx) sets this heading's
    // font-family inline via `var(--disp)` — a CSS custom property it never
    // defines itself, only the shell-exposed `shell/tokens.css` (federated
    // module, T3) defines it. A resolved "Syne" here is direct proof the
    // remote is rendering with the SAME shared token file as the shell
    // chrome, not a local copy or unstyled fallback.
    const headingFont = await heading.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(headingFont).toContain('Syne')
  })
})
