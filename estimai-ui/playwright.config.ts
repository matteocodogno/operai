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

/**
 * The UI preview is served on port 5173 (not the default 4173).
 *
 * Rationale: better-auth's /auth/sign-out validates the request Origin against
 * its trustedOrigins list, which is populated from the auth service's
 * ALLOWED_ORIGINS env var.  The committed default is:
 *   ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
 *
 * Running the preview on the default port 4173 would place it outside the
 * trusted-origins list, causing sign-out POSTs to fail with 403 INVALID_ORIGIN
 * and leaving the server-side session alive — which makes AC-5.2's server-side
 * termination assertion non-verifiable without local env edits.
 *
 * Serving on 5173 (already trusted) avoids any local env configuration and makes
 * the e2e reproducible out-of-the-box.  The `--strictPort` flag ensures the
 * command fails fast if 5173 is already in use (rather than silently falling
 * back to another port that is not trusted).
 */
const uiUrl = 'http://localhost:5173'

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
   * then starts `vite preview` on port 5173 (a trusted origin in ALLOWED_ORIGINS).
   *
   * --port 5173  — serve on the trusted origin (see rationale above)
   * --strictPort — fail fast if 5173 is already occupied (avoids silent fallback
   *                to an untrusted port that would break sign-out tests)
   *
   * reuseExistingServer=true in non-CI so a pre-running preview server is reused
   * (speeds up iteration when running tests repeatedly).
   */
  webServer: {
    command: 'pnpm build && pnpm preview --port 5173 --strictPort',
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
