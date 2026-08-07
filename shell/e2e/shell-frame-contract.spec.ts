/**
 * Shell frame contract — the DOCUMENT must never scroll; only `<main>` may.
 *
 * ADR-0006 gives the shell the frame. `ShellLayout` realises it as a fixed-viewport
 * frame: header and footer pinned (`shrink-0`), the root `h-screen overflow-hidden`,
 * and exactly one scroll region — `<main>` (`flex-1 overflow-y-auto`). `<main>`
 * scrolling as far as its content is CORRECT and expected (the admin user-detail
 * page is legitimately ~1760px tall). What must never happen is the *document*
 * scrolling as well, because that gives a second scrollbar with nothing in it:
 * the user scrolls `<main>` to its end, keeps scrolling, and the whole page slides
 * up past the footer into dead space.
 *
 * THE REGRESSION THIS GUARDS (found on /admin/users/:id, 2026-08-07):
 * `overflow-hidden` on the shell root does not constrain `<html>`. An
 * absolutely-positioned element resolves its containing block to the nearest
 * POSITIONED ancestor — and `<main>` was `position: static`, so such elements
 * resolved against the initial containing block instead, escaped `<main>`'s
 * overflow clip entirely, and stretched `<html>` to their in-flow offset.
 * Measured: `documentElement.scrollHeight` 1582 vs a 900px viewport — 682px of
 * dead scroll.
 *
 * The trigger is ordinary and easy to reintroduce: **Tailwind's `sr-only` is
 * `position: absolute`**. Any remote that puts screen-reader text far down a
 * page taller than the viewport trips this. It is therefore NOT something a
 * remote can be expected to avoid — the fix is `relative` on `<main>`
 * (ShellLayout), and this spec exists so that class cannot be dropped silently.
 *
 * Note what this does NOT assert: it makes no claim about `<main>`'s own
 * scrollHeight. An earlier draft asserted `<main>` must not overshoot its
 * clientHeight, which is simply false for any page with more content than fits.
 */

import { test, expect, type Page } from '@playwright/test'
import { seedAdminSession, applySessionCookie } from './helpers/adminSession'

/** Sub-pixel rounding slack. The regression this catches overshoots by hundreds of px. */
const ROUNDING_TOLERANCE_PX = 2

/** How far `<html>` scrolls beyond the viewport. Must be ~0 in a fixed-viewport frame. */
async function documentOvershoot(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  )
}

/** Names any absolutely-positioned element that escaped `<main>`'s clip, for a useful failure. */
async function escapedElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const viewportBottom = document.documentElement.clientHeight
    const found: string[] = []
    document.querySelectorAll('*').forEach((el) => {
      const style = getComputedStyle(el)
      if (style.position !== 'absolute' && style.position !== 'fixed') return
      const parent = (el as HTMLElement).offsetParent
      const rect = el.getBoundingClientRect()
      // Escaped == positioned against body/ICB rather than a contained ancestor,
      // and sitting below the fold, which is what actually stretches <html>.
      if ((parent === null || parent === document.body) && rect.top > viewportBottom) {
        found.push(
          `<${el.tagName.toLowerCase()} class="${(el.className || '').toString().slice(0, 60)}"> at y=${Math.round(rect.top)}`,
        )
      }
    })
    return found.slice(0, 8)
  })
}

async function expectNoDocumentScroll(page: Page, where: string): Promise<void> {
  const overshoot = await documentOvershoot(page)
  const escaped = overshoot > ROUNDING_TOLERANCE_PX ? await escapedElements(page) : []
  expect(
    overshoot,
    `${where}: the document scrolls ${overshoot}px beyond the viewport. In the shell's ` +
      `fixed-viewport frame only <main> may scroll. The usual cause is an absolutely-positioned ` +
      `element (Tailwind's \`sr-only\` is \`position: absolute\`) escaping <main>'s overflow clip ` +
      `because <main> lost its \`relative\` class — see ShellLayout and ADR-0006.` +
      (escaped.length ? `\nEscaped elements: ${escaped.join(', ')}` : ''),
  ).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX)
}

/*
 * Scope note — why this covers ONE page rather than every remote.
 *
 * The invariant is shell-wide (it lives in ShellLayout, not in any remote), so a
 * single page that genuinely exercises it guards the whole frame: the `relative`
 * class cannot be dropped without this failing. Per-remote cases were tried and
 * removed deliberately — they need a seeded user holding each tool's app grant,
 * and the shared `e2e@operai.test` fixture currently resolves to `apps:["refund"]`
 * only against a local DB with accumulated state, so `/estimai` renders the
 * no-access screen and the case fails for a reason that has nothing to do with
 * this contract. A guard that fails for unrelated reasons gets ignored, which is
 * worse than a narrower guard that is always meaningful. The case below seeds its
 * OWN admin user, so it is self-sufficient and unaffected by that drift.
 */
test.describe('ADR-0006 frame contract: only <main> scrolls, never the document', () => {
  test('the admin user-detail page — taller than the viewport, with sr-only text below the fold', async ({
    browser,
  }) => {
    // This is the exact page that regressed. It matters that it is TALL: the bug
    // is invisible on a short page, because an escaping element below the fold is
    // what stretches <html>. A short viewport makes the condition unambiguous.
    const session = await seedAdminSession(
      `e2e-frame-${Date.now()}@operai.test`,
      'E2E Frame Contract Admin',
    )
    const context = await browser.newContext()
    await applySessionCookie(context, session)
    const page = await context.newPage()
    await page.setViewportSize({ width: 1280, height: 900 })

    await page.goto(`/admin/users/${session.userId}`)
    await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible({ timeout: 15_000 })

    // Sanity-check the precondition: if the page ever became short enough to fit,
    // this test would pass vacuously and stop guarding anything.
    const mainOvershoot = await page.evaluate(() => {
      const main = document.getElementById('shell-main-content')
      return main ? main.scrollHeight - main.clientHeight : 0
    })
    expect(
      mainOvershoot,
      'precondition: the user-detail page must be taller than the viewport for this guard to mean anything',
    ).toBeGreaterThan(100)

    await expectNoDocumentScroll(page, 'admin user-detail')
    await context.close()
  })
})
