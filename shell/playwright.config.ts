import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for shell e2e tests.
 *
 * T2's (specs/003-suite-shell/tasks.md) R1-gate suite — which proved the
 * Module Federation walking skeleton against a throwaway `mf-seed-remote` —
 * has been retired now that the mechanism is proven (see docs/adr/0006 and
 * the T2 run trace) and the two real remotes (estimai-ui, refund-ui) exist
 * in `shell/vite.config.ts`'s federation config instead. No e2e spec lives
 * in `e2e/` yet: the cross-app suite (chrome persistence, deep-linking,
 * seeded-session auth, the Refund placeholder, remote-failure handling) is
 * T16, which needs T7 (Sidebar), T10 (root redirect), T13/T14 (EstimAI
 * rewired to the shell session/chrome), and T15 (refund-ui) — none of which
 * exist yet. This config is left in place, webServer-ready, for T16 to add
 * specs to; build+preview (not `vite dev`) is deliberate here — dev-mode
 * host + build-mode remote does NOT reliably negotiate the shared React
 * singleton (esbuild's dev dependency pre-bundling and the federation
 * runtime's dev-mode virtual modules don't line up the same way build-mode
 * chunks do), and build+preview also mirrors how the suite actually deploys
 * (independently built + served remotes).
 */

const shellUrl = 'http://localhost:5174'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',

  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: shellUrl,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // The shell host, built + previewed on 5174. T16 will add the estimai-ui
  // and refund-ui webServer entries (and their remote URLs) alongside this
  // one once those specs land.
  webServer: [
    {
      command: 'pnpm build && pnpm preview --port 5174 --strictPort',
      url: shellUrl,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
