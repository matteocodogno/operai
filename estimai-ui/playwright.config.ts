import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for estimai-ui e2e tests.
 *
 * Prerequisites (must be running before `pnpm e2e`):
 *   1. Postgres: `docker compose up -d` (localhost:5435)
 *   2. Auth service: `bun run dev` in `auth/` (localhost:3001)
 *
 * The UI preview server is started automatically by the webServer block.
 *
 * Auth service URL is read from E2E_AUTH_URL (falls back to VITE_AUTH_URL,
 * then to the default http://localhost:3001).
 *
 * env var summary:
 *   E2E_AUTH_URL   — auth service base URL (overrides VITE_AUTH_URL)
 *   VITE_AUTH_URL  — used as fallback; also embedded in the UI build
 */

const authUrl =
  process.env['E2E_AUTH_URL'] ??
  process.env['VITE_AUTH_URL'] ??
  'http://localhost:3001'

const uiUrl = 'http://localhost:4173'

export default defineConfig({
  testDir: './e2e',
  // Only pick up .spec.ts files in e2e/ — vitest's include glob is
  // 'src/**/*.{test,spec}.{ts,tsx}' and never touches e2e/ so there is no overlap.
  testMatch: '**/*.spec.ts',

  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: uiUrl,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /**
   * webServer builds the Vite bundle (VITE_AUTH_URL is embedded at build time)
   * then starts `vite preview` so Playwright can hit it at localhost:4173.
   *
   * reuseExistingServer=true in non-CI so a pre-running preview server is reused
   * (speeds up iteration when running tests repeatedly).
   */
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: uiUrl,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      VITE_AUTH_URL: authUrl,
    },
  },
})
