import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for shell e2e tests (T16, specs/003-suite-shell).
 *
 * This is the cross-app suite: it drives the REAL assembled shell host
 * together with the real remotes (estimai-ui, refund-ui, notify-ui) in a
 * browser, with a seeded better-auth session — the convergence point for
 * shell-chrome (T3-T11), estimai-migration (T12-T14), refund-stub (T15), and
 * the notification center (specs/005-notification-center, T21).
 *
 * Prerequisites (must be running before `pnpm e2e`):
 *   1. Postgres: `docker compose up -d` (localhost:5435)
 *   2. Auth service: `bun run dev` in `auth/`, with ENABLE_TEST_AUTH=true
 *      (localhost:3001) — required for the seeded-session helper.
 *   3. estimai-api: `bun run dev` in `estimai-api/` (localhost:8080) —
 *      required for AC-2.2 (authenticated backend calls succeed inside the
 *      shell).
 *   4. notify-api: `bun run dev` in `notify-api/` (localhost:8081) —
 *      required for specs/005's US-1..US-6 (bell/badge, center, SSE, toasts).
 *
 * All five frontends (shell, estimai-ui, refund-ui, notify-ui, admin-ui) are
 * started here via `build && preview` (NOT `vite dev`) — dev-mode host + build-mode remote
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

// notify-api base URL (specs/005-notification-center). Mirrors apiUrl above —
// E2E_NOTIFY_API_URL / VITE_NOTIFY_API_URL override, default matches
// notify-api's pinned local port (8081, notify-api/vite... n/a, see
// notify-api/.env.example PORT=8081).
const notifyApiUrl =
  process.env['E2E_NOTIFY_API_URL'] ?? process.env['VITE_NOTIFY_API_URL'] ?? 'http://localhost:8081'

const shellUrl = 'http://localhost:5173'
const estimaiRemoteOrigin = 'http://localhost:5175'
const refundRemoteOrigin = 'http://localhost:5176'
// notify-ui added for T21 (specs/005-notification-center). This e2e harness
// already uses its OWN port numbering for the built+previewed remotes,
// distinct from mise.toml's `dev`/`dev:preview` HMR port assignments
// (estimai-ui/refund-ui above are on 5175/5176 here, not their mise.toml dev
// ports 5174/5175) — `--port`/`--strictPort` on the `preview` command below
// is what actually binds the port, not each app's own vite.config.ts dev
// server default. notify-ui's dev-mode default (5176, vite.config.ts) is
// already claimed by refundRemoteOrigin in THIS file's numbering, so 5178
// (free here) is used for its e2e preview instance only.
const notifyRemoteOrigin = 'http://localhost:5178'
// admin-ui (specs/004-auth-roles-permissions T25, specs/006-user-invitations
// T14) — the Roles/Permissions/Invitations admin GUI. Was federated into the
// shell's router/vite.config (ADMIN_REMOTE_URL) back in specs/004 but never
// added to THIS webServer array, so admin-ui had NO real browser e2e coverage
// until this feature's T14 — every ACL/roles/departments AC that named "e2e"
// in specs/004's own test-strategy table was, in practice, only verified at
// the component (vitest) level. 5179 is the next free e2e-preview slot.
const adminRemoteOrigin = 'http://localhost:5179'

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
      // notify-ui (specs/005-notification-center, T21) — added alongside
      // estimai-ui/refund-ui above so AC-1.4/1.5/2.1/2.4/2.5/3.x/5.x/6.x can
      // be driven against the REAL federated notification-center remote, not
      // a mock. Consumes shell/session (Bearer JWT + the notification
      // transport seam) exactly like estimai-ui/refund-ui do.
      command: 'pnpm build && pnpm preview --port 5178 --strictPort',
      cwd: '../notify-ui',
      url: notifyRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
      },
    },
    {
      // admin-ui (specs/006-user-invitations T14 — see adminRemoteOrigin doc
      // comment above for why this entry is new). Same shape as
      // estimai-ui/refund-ui/notify-ui above: independently built + previewed,
      // consumes shell/session + shell/tokens.css.
      command: 'pnpm build && pnpm preview --port 5179 --strictPort',
      cwd: '../admin-ui',
      url: adminRemoteOrigin,
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
        NOTIFY_REMOTE_URL: `${notifyRemoteOrigin}/remoteEntry.js`,
        ADMIN_REMOTE_URL: `${adminRemoteOrigin}/remoteEntry.js`,
        VITE_AUTH_URL: authUrl,
        VITE_API_URL: apiUrl,
        VITE_NOTIFY_API_URL: notifyApiUrl,
      },
    },
  ],
})
