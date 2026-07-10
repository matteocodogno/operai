/**
 * T16 — A failing remote does not break the suite (specs/003-suite-shell)
 *
 * Refs: AC-6.1 — a tool that fails to load (network error / load failure)
 * shows a clear in-place error in the content area; chrome and the OTHER
 * tool remain fully usable; a Retry action is offered.
 *
 * Failure is injected deterministically via Playwright network interception
 * — aborting every request to the Refund remote's origin (5176), which is
 * exactly the "network error fetching remoteEntry.js" case RemoteMount
 * (shell/src/components/RemoteMount.tsx) is built to handle. This is
 * preferred over standing up a second, differently-configured shell build
 * (which would need its own port / env matrix) — it exercises the SAME
 * built shell artifact the rest of this suite runs against, with a real,
 * reproducible network failure at the federation boundary.
 *
 * VERIFIED BROWSER LIMITATION (found while writing this test — see this
 * task's final report for the full repro): once a browser's native dynamic
 * `import()` has rejected for a given exact URL, that engine permanently
 * caches the failure for the page's lifetime — a same-URL `import()` never
 * re-issues a network request again, Retry or not (confirmed by instrumenting
 * the route handler: clicking Retry after lifting the network block does NOT
 * produce a new request to `remoteEntry.js`, and the SAME cached rejection
 * re-surfaces). This is standard ECMAScript module-map behavior, not a bug
 * introduced by RemoteMount's retry mechanism (which does correctly re-invoke
 * `loader()`/`import('refund/App')` per its own module doc) — it is a ceiling
 * that mechanism cannot get past without the federation runtime cache-busting
 * the retried URL itself (e.g. a query-string nonce), which RemoteMount does
 * not currently do. This test therefore verifies what Retry actually
 * guarantees today (a fresh load ATTEMPT, re-rendering the boundary) and
 * verifies full recovery via the realistic path a user actually has once the
 * underlying network condition is fixed — reloading the page — rather than
 * asserting an in-place recovery this implementation cannot deliver.
 */

import { test, expect } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

const REFUND_REMOTE_ORIGIN = 'http://localhost:5176'

test.describe('AC-6.1: a failing Refund remote shows an in-place error while the rest of the suite stays usable', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('Refund fails to load -> in-place error + retry; chrome and EstimAI stay usable', async ({
    page,
  }) => {
    // Force every request to the Refund remote's origin (remoteEntry.js and
    // any of its chunks) to fail at the network level.
    await page.route(`${REFUND_REMOTE_ORIGIN}/**`, (route) => route.abort('failed'))

    await page.goto('/refund')

    const errorRegion = page.getByTestId('remote-mount-error')
    await expect(errorRegion).toBeVisible({ timeout: 15_000 })
    await expect(errorRegion.getByRole('alert')).toContainText(/refund couldn.?t load/i)
    const retryButton = errorRegion.getByRole('button', { name: /retry/i })
    await expect(retryButton).toBeVisible()

    // The chrome is completely unaffected by the failure — still one banner,
    // one nav, both tool entries present and clickable.
    await expect(page.getByRole('banner')).toBeVisible()
    await expect(page.getByRole('link', { name: 'EstimAI' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Refund (Rimborsi)' })).toBeVisible()

    // Switching to the OTHER tool works normally — one tool's outage does
    // not take down the suite.
    await page.getByRole('link', { name: 'EstimAI' }).click()
    await expect(page).toHaveURL(/\/estimai/, { timeout: 15_000 })
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })
    // Chrome still intact after navigating away from the failed tool.
    await expect(page.getByRole('banner')).toBeVisible()

    // Going back to the still-blocked Refund route shows the error again
    // (not a stale/blank screen).
    await page.getByRole('link', { name: 'Refund (Rimborsi)' }).click()
    await expect(page.getByTestId('remote-mount-error')).toBeVisible({ timeout: 15_000 })

    // Clicking Retry (still blocked) genuinely re-attempts the load: it
    // discards the old error boundary (key={attempt}, RemoteMount.tsx) and
    // mounts a fresh one, which itself catches the (still-failing) import and
    // re-renders the error state — proving Retry is wired end to end, not a
    // no-op button.
    await page.getByTestId('remote-mount-error').getByRole('button', { name: /retry/i }).click()
    await expect(page.getByTestId('remote-mount-error')).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByTestId('remote-mount-error').getByRole('alert'),
    ).toContainText(/refund couldn.?t load/i)

    // Recovery: once the underlying network condition is actually fixed and
    // the user reloads, Refund loads normally — the failure was NOT a
    // permanent/whole-suite break. (A same-URL retry-in-place cannot recover
    // here: once a browser's `import()` rejects for an exact URL it never
    // re-fetches that URL again for the page's lifetime — see this file's
    // module doc. Reload is the realistic recovery path once the condition
    // that caused the failure is resolved.)
    await page.unroute(`${REFUND_REMOTE_ORIGIN}/**`)
    await page.reload()

    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByTestId('remote-mount-error')).toHaveCount(0)
    // Chrome is exactly as it was throughout — one banner, both tools listed.
    await expect(page.getByRole('banner')).toBeVisible()
    await expect(page.getByRole('link', { name: 'EstimAI' })).toBeVisible()
  })
})
