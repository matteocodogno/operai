import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for shell e2e tests (T16, specs/003-suite-shell).
 *
 * This is the cross-app suite: it drives the REAL assembled shell host
 * together with BOTH real remotes (estimai-ui, refund-ui) in a browser, with
 * a seeded better-auth session — the convergence point for shell-chrome
 * (T3-T11), estimai-migration (T12-T14), and refund-stub (T15).
 *
 * Prerequisites (must be running before `pnpm e2e`):
 *   1. Postgres: `docker compose up -d` (localhost:5435)
 *   2. Auth service: `bun run dev` in `auth/`, with ENABLE_TEST_AUTH=true
 *      (localhost:3001) — required for the seeded-session helper.
 *   3. estimai-api: `bun run dev` in `estimai-api/` (localhost:8080) —
 *      required for AC-2.2 (authenticated backend calls succeed inside the
 *      shell).
 *
 * All three frontends (shell, estimai-ui, refund-ui) are started here via
 * `build && preview` (NOT `vite dev`) — dev-mode host + build-mode remote
 * does NOT reliably negotiate the shared React singleton (esbuild's dev
 * dependency pre-bundling and the federation runtime's dev-mode virtual
 * modules don't line up the same way build-mode chunks do), and build+preview
 * also mirrors how the suite actually deploys (independently built + served
 * remotes). See the R1/T2 run trace and docs/adr/0006 for the underlying MF
 * mechanism this config exercises for real, end-to-end.
 *
 * Port assignment (resolves the T9 dev-port-collision note this file used to
 * carry — see git history, this file previously served the shell on 5174):
 *   - shell   → 5173  (a TRUSTED origin in `auth`'s committed ALLOWED_ORIGINS
 *                       default, http://localhost:5173,http://localhost:3000
 *                       — see auth/.env.example and estimai-api/.env.example
 *                       — so shell/session's getSession()/apiFetch()/signOut()
 *                       calls, and estimai-api's CORS, all succeed against
 *                       the default local env with zero extra config)
 *   - estimai remote → 5175
 *   - refund remote  → 5176
 * Remote URLs are wired via env vars at BUILD time (read from `process.env`
 * in each app's vite.config.ts — ESTIMAI_REMOTE_URL/REFUND_REMOTE_URL on the
 * shell side, SHELL_REMOTE_URL on each remote's side). This mirrors the
 * plan's federation contract; T17 later moves this to true per-environment
 * *runtime* resolution for Vercel — these are build-time envs scoped to this
 * local/CI e2e run only.
 */

const authUrl =
  process.env['E2E_AUTH_URL'] ?? process.env['VITE_AUTH_URL'] ?? 'http://localhost:3001'

const apiUrl =
  process.env['E2E_API_URL'] ?? process.env['VITE_API_URL'] ?? 'http://localhost:8080'

const shellUrl = 'http://localhost:5173'
const estimaiRemoteOrigin = 'http://localhost:5175'
const refundRemoteOrigin = 'http://localhost:5176'

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

  // Three independently built+previewed frontends, matching the deploy
  // topology (three separate Vercel projects, per plan.md). None of the
  // three needs the others to exist at BUILD time (dts is disabled on every
  // federation config, so no cross-app dts fetch happens at build time) —
  // they only need each other at RUNTIME, when a shell route mounts a
  // remote. Playwright starts all three concurrently and waits for every
  // `url` to respond before running tests.
  webServer: [
    {
      command: 'pnpm build && pnpm preview --port 5175 --strictPort',
      cwd: '../estimai-ui',
      url: estimaiRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // estimai-ui consumes the shell as a remote for shell/session +
        // shell/tokens.css (T13). VITE_AUTH_URL/VITE_API_URL are also baked
        // in here, but at runtime estimai-ui delegates every session/apiFetch
        // call to the shared `shell/session` module (see estimai-ui/src/lib/
        // api.ts, authClient.ts) — the shell's OWN build-time env is what
        // actually governs trusted origins and the auth/API base URLs for
        // suite-wide calls, not this copy.
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
        VITE_AUTH_URL: authUrl,
        VITE_API_URL: apiUrl,
      },
    },
    {
      command: 'pnpm build && pnpm preview --port 5176 --strictPort',
      cwd: '../refund-ui',
      url: refundRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
      },
    },
    {
      command: 'pnpm build && pnpm preview --port 5173 --strictPort',
      url: shellUrl,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ESTIMAI_REMOTE_URL: `${estimaiRemoteOrigin}/remoteEntry.js`,
        REFUND_REMOTE_URL: `${refundRemoteOrigin}/remoteEntry.js`,
        VITE_AUTH_URL: authUrl,
        VITE_API_URL: apiUrl,
      },
    },
  ],
})
