/**
 * T16 — Module Federation shared-singleton check, in a real browser
 * (specs/003-suite-shell)
 *
 * This is not a distinct spec AC — it is the R2 watch item carried forward
 * from T9/T13's implementation notes: the build-time `[IMPORT_IS_UNDEFINED]`
 * warnings emitted by `@module-federation/vite` (seen on every `pnpm build`
 * in shell/estimai-ui/refund-ui) cannot by themselves confirm the shared
 * `react`/`react-dom` singleton actually negotiates to ONE copy at runtime —
 * they are a known-benign artifact of how the plugin's prebuild shim is
 * statically analyzed. The real proof is behavioral: mount a remote whose
 * root component calls a HOOK that crosses the federation boundary
 * (Refund's `App` calls `useSession()` from the shell's OWN exposed
 * `shell/session` module) under the HOST's React reconciler. If `react`
 * resolved to two separate copies, this is exactly the shape of bug that
 * throws "Invalid hook call" / "Cannot read properties of null (reading
 * 'useState'/'useContext')" — a real, uncaught runtime error, not a build
 * warning. Its absence across a full navigation cycle (mount EstimAI ->
 * mount Refund -> back to EstimAI) is the closest thing to a runtime proof
 * this suite can produce.
 */

import { test, expect, type Page } from '@playwright/test'
import { seedSession } from './helpers/seedSession'

const HOOK_ERROR_PATTERN = /invalid hook call|cannot read propert.*of null|null is not an object/i

const collectFailures = (page: Page) => {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => {
    pageErrors.push(err.message)
  })

  return { consoleErrors, pageErrors }
}

test.describe('MF shared React singleton holds across a real navigation cycle', () => {
  test.beforeEach(async ({ context }) => {
    await seedSession(context)
  })

  test('mounting EstimAI, then Refund, then EstimAI again raises no hook-duplication errors', async ({
    page,
  }) => {
    const { consoleErrors, pageErrors } = collectFailures(page)

    await page.goto('/estimai')
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })

    await page.getByRole('link', { name: 'Refund (Rimborsi)' }).click()
    await expect(page.getByRole('heading', { name: 'Refund (Rimborsi)' })).toBeVisible({
      timeout: 15_000,
    })
    // Refund's App calls useSession() from the federated shell/session
    // module AND reads its own local useState-free render — its signed-in
    // line rendering at all is the hook resolving without throwing.
    await expect(page.getByTestId('refund-signed-in-as')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('link', { name: 'EstimAI' }).click()
    await expect(page.getByRole('button', { name: /import json/i })).toBeVisible({
      timeout: 15_000,
    })

    const hookFailures = [...consoleErrors, ...pageErrors].filter((text) =>
      HOOK_ERROR_PATTERN.test(text),
    )

    expect(
      hookFailures,
      `Expected no React-hook-duplication errors; got:\n${hookFailures.join('\n')}`,
    ).toEqual([])
    expect(pageErrors, `Expected no uncaught page errors; got:\n${pageErrors.join('\n')}`).toEqual(
      [],
    )
  })
})
