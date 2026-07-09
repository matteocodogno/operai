import { test, expect } from '@playwright/test'

/**
 * R1 GATE (specs/003-suite-shell/tasks.md, T2) — federation walking skeleton.
 *
 * Proves, at runtime, in a real browser, against real built-and-served
 * host + remote artifacts (see playwright.config.ts):
 *
 *  1. The shell loads the throwaway `mf-seed-remote`'s exposed `SeedProbe`
 *     component via the Module Federation runtime.
 *  2. The remote's hook (`useState`) actually works when rendered under the
 *     host's react-dom reconciler — clicking increments visible state with
 *     no console error. This alone is not proof of a shared singleton (a
 *     duplicate-but-functioning React could theoretically render once), so:
 *  3. `window.__mfSingletonCheck` — set by `SeedProbeMount` after comparing
 *     the host's and remote's `react` module's `useState` function AND
 *     dispatcher-internals object by reference (see
 *     shell/src/federation/SeedProbeMount.tsx for why raw namespace-object
 *     identity is the wrong check) — is `true`. This was verified to
 *     actually discriminate: temporarily disabling `shared` on the remote
 *     produced a real `TypeError: Cannot read properties of null (reading
 *     'useState')` — the exact classic MF duplicate-React failure — proving
 *     this assertion is not a tautology.
 */
test('shell loads the seed remote and proves a single shared React instance', async ({
  page,
}) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto('/')

  // (1) The remote's exposed component rendered inside the shell.
  const seedProbe = page.getByTestId('seed-probe')
  await expect(seedProbe).toBeVisible()
  await expect(seedProbe).toContainText('mf-seed-remote')

  // (2) The remote's hook works under the host's reconciler: click twice,
  // assert visible state actually advances, with no runtime error surfaced.
  const incrementButton = page.getByTestId('seed-probe-increment')
  await expect(incrementButton).toContainText('remote hook count: 0')
  await incrementButton.click()
  await incrementButton.click()
  await expect(incrementButton).toContainText('remote hook count: 2')

  // (3) The host-side identity assertion reports a shared singleton, not a
  // duplicate React instance.
  const singletonCheck = page.getByTestId('singleton-check')
  await expect(singletonCheck).toHaveAttribute('data-status', 'shared')
  await expect(singletonCheck).toContainText('React singleton check: shared')

  const windowCheck = await page.evaluate(() => window.__mfSingletonCheck)
  expect(windowCheck).toBe(true)

  expect(consoleErrors.filter((e) => !e.includes('favicon'))).toEqual([])
})
