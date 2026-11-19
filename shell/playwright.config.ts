import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for shell e2e tests (T16, specs/20260709-suite-shell).
 *
 * This is the cross-app suite: it drives the REAL assembled shell host
 * together with the real remotes (estimai-ui, refund-ui, notify-ui) in a
 * browser, with a seeded better-auth session — the convergence point for
 * shell-chrome (T3-T11), estimai-migration (T12-T14), refund-stub (T15), and
 * the notification center (specs/20260713-notification-center, T21).
 *
 * Prerequisites (must be running before `pnpm e2e`):
 *   1. Postgres: `docker compose up -d` (localhost:5435)
 *   2. Auth service: `bun run dev` in `auth/`, with ENABLE_TEST_AUTH=true
 *      (localhost:3001) — required for the seeded-session helper.
 *   3. estimai-api: `bun run dev` in `estimai-api/` (localhost:8080) —
 *      required for AC-2.2 (authenticated backend calls succeed inside the
 *      shell).
 *   4. notify-api: `bun run dev` in `notify-api/` (localhost:8081) —
 *      required for specs/20260713-notification-center's US-1..US-6 (bell/badge, center, SSE, toasts).
 *   5. refund-api: `bun run dev` in `refund-api/` (localhost:8082) — required
 *      for specs/20260716-refund-service's headline journeys (refund-headline.spec.ts, T21):
 *      compose/submit/review/decide/notify. refund-api's post-decision
 *      notification is authenticated with its own scoped service credential
 *      (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired): `auth` needs a `SERVICE_CLIENTS` entry for it plus
 *      `SERVICE_AUDIENCE`, `refund-api` needs `SERVICE_CLIENT_ID` and
 *      `SERVICE_CLIENT_SECRET`, and `notify-api` needs `SERVICE_AUDIENCE`;
 *      without them the notification silently no-ops. Real object-storage
 *      credentials (`REFUND_S3_*`) are NOT
 *      required to run these journeys — refund-headline.spec.ts deliberately
 *      never attaches a receipt (AC-1.7: attachments are always optional),
 *      since no EU bucket is provisioned for local/CI e2e.
 *   6. inventory-api: `bun run dev` in `inventory-api/` (localhost:8083) — required
 *      for specs/20261006-hardware-inventory's journeys (inventory-assignment.spec.ts, inventory-ledger.spec.ts,
 *      T45). Its assignment/decision notifications (AC-2.8/2.9) also need `auth`'s
 *      `SERVICE_AUDIENCE` + `SERVICE_CLIENTS` and `notify-api`'s `SERVICE_AUDIENCE`
 *      (ADR 20261006-scoped-service-jwt-fourth-notify-caller); without them the push fails soft and those two ACs cannot pass.
 *   7. specs/20261110-activities (activities-*.spec.ts, T21): projects-api (8086), crm-api (8084) and
 *      activities-api (8087), each with the env listed at the top of activities-crm.spec.ts
 *      (activities-api's URL on crm-api, its SERVICE_CLIENTS entry and `activities.write` in `auth`,
 *      VITE_ACTIVITIES_API_URL / VITE_PROJECTS_API_URL on the shell build). projects-ui is served here
 *      on E2E_PROJECTS_REMOTE_PORT (default 5183).
 *
 *   8. specs/20261116-letterhead-service (letterheads.spec.ts, T26): letterhead-api (Rust; `mise run dev:letterhead`, :8088) with
 *      its own database and bucket, `auth` running with ENABLE_TEST_AUTH=true and `AUTH_AUDIENCE`, `letterhead-api` reading
 *      `auth`'s JWKS and `/authz/resolve` (nothing is stubbed: the journeys sign in as real users whose grants are written
 *      through `auth`'s admin API). letterheads-ui is served here on E2E_LETTERHEADS_REMOTE_PORT (default 5184) and
 *      the shell's build is told the service's origin (VITE_LETTERHEADS_API_URL, E2E_LETTERHEADS_API_URL; default
 *      http://localhost:8088).
 *
 *   9. specs/20261116-letterhead-service (crm-offer-wizard-service.spec.ts, T34): everything of item 8, PLUS the CRM side on the
 *      service path: activities-api (:8087, the estimate override's timeline note), crm-api with LETTERHEAD_SERVICE_ENABLED=true,
 *      its SERVICE_CLIENT_ID/SECRET, and `auth`'s `crm-api` SERVICE_CLIENTS entry holding the scopes `letterhead:render`
 *      and `activities.write`. crm-api's LETTERHEAD_API_URL must be the RELAY the spec runs itself
 *      (http://localhost:18240, E2E_LETTERHEAD_RELAY_PORT), which forwards to E2E_LETTERHEADS_API_URL: that is how the spec
 *      stops "the service" in the middle of a session without touching a container. The spec header has the details; the
 *      preview timings (40 edits, p50/p95) are letterhead-api/perf/preview-edits.ts, not a Playwright spec.
 *
 *  10. specs/20261117-legal-entities (T41): the global setup (e2e/global-setup.ts) prepares the legal-entity registry of `auth`
 *      before any spec runs: `auth` migrated AND seeded (`cd auth && bun run db:release`: the `admin` role holds
 *      `legal-entity:manage`), and, while an entity still has no version, the compose Postgres with the CRM database for
 *      `mise run legal-entities:import` (T9). It leaves both entities at version >= 1 and complete and three people made
 *      (admin, a welld_ch-conditioned manager, a no-grant user). E2E_SKIP_LEGAL_ENTITIES_SETUP=1 skips it.
 *
 *  11. specs/20261119-accounting (T40; accounting.spec.ts, accounting-access.spec.ts, and the adapted refund-accounting*.spec.ts):
 *      accounting-api (`mise run dev`, or `cd accounting-api && direnv exec . bun run dev`; :8089) with its own database
 *      `accounting` migrated, `ACCOUNTING_FX_SOURCE=off` (no call to the federal source: a month's rate is typed by hand),
 *      `auth` running with ENABLE_TEST_AUTH=true and its seed applied (the `admin` role holds `accounting:read` and
 *      `accounting:manage`), refund-api with ACCOUNTING_INTERNAL_URL naming it, and `auth`'s SERVICE_CLIENTS entry for refund-api
 *      holding the scope `accounting.reference.read`. accounting-ui is served here on E2E_ACCOUNTING_REMOTE_PORT (default 5185;
 *      the `mise run dev` stack has it on 5183, which the projects-ui preview takes in THIS file's numbering), and the shell's
 *      build is told the API's origin (VITE_ACCOUNTING_API_URL, E2E_ACCOUNTING_API_URL; default http://localhost:8089).
 *      The global setup (e2e/global-setup.ts) checks accounting-api's `/health` first (it stops the run, naming the command,
 *      when nothing answers), then loads WellD CH's list with `seed:welld-ch` (E2E_SKIP_ACCOUNTING_SEED=1 skips it), then
 *      releases refund accounting (E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1 skips it). Both scripts run under `direnv exec`, so each
 *      writes to the database its service's `.envrc` names (the shared dev one). To point them at another database set
 *      E2E_ACCOUNTING_DATABASE_URL (the accounting-api database) and E2E_REFUND_DATABASE_URL (the refund-api database) to
 *      postgres URLs: the value replaces DATABASE_URL for that script only, is never printed, and must be the database the
 *      RUNNING service uses.
 *
 * Every notification the suite raises (invitation email from `auth`, refund
 * decisions and batch emails from `refund-api`, collaborator changes from
 * `estimai-api`, assignments from `inventory-api`) is sent under that caller's
 * own scoped service credential (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired). There is no shared token to keep
 * identical across services, and none is a prerequisite here.
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

// notify-api base URL (specs/20260713-notification-center). Mirrors apiUrl above —
// E2E_NOTIFY_API_URL / VITE_NOTIFY_API_URL override, default matches
// notify-api's pinned local port (8081, notify-api/vite... n/a, see
// notify-api/.env.example PORT=8081).
const notifyApiUrl =
  process.env['E2E_NOTIFY_API_URL'] ?? process.env['VITE_NOTIFY_API_URL'] ?? 'http://localhost:8081'

// refund-api base URL (specs/20260716-refund-service, T21). Mirrors apiUrl/
// notifyApiUrl above. Needed on BOTH sides of the federation boundary:
// refund-ui reads it directly (src/lib/refundApi.ts's `refundApiBase()`)
// AND the shell needs it at ITS OWN build time too, because
// `shell/src/lib/session.ts`'s `getTrustedOrigins()` (the allowlist
// `apiFetch` checks before attaching the Bearer JWT, ADR 20260607-jwt-in-memory-never-web-storage) is compiled
// into the SHELL bundle, not refund-ui's — without this, refund-ui's calls
// to refund-api would go out with no Authorization header and 401
// unconditionally (see refundApi.ts's own "DRIFT" doc comment, closed by
// T20's session.ts fix — this wires the actual env value through for e2e).
const refundApiUrl =
  process.env['E2E_REFUND_API_URL'] ?? process.env['VITE_REFUND_API_URL'] ?? 'http://localhost:8082'

// inventory-api base URL (specs/20261006-hardware-inventory, T45). Needed by the SHELL's
// own build for the same reason as refundApiUrl above (trusted-origin allowlist).
const inventoryApiUrl =
  process.env['E2E_INVENTORY_API_URL'] ??
  process.env['VITE_INVENTORY_API_URL'] ??
  'http://localhost:8083'

// crm-api / meetings-api base URLs (specs/20261101-crm / specs/20261104-meetings). The SHELL's build needs both
// for the trusted-origin allowlist (ADR 20260607-jwt-in-memory-never-web-storage), exactly like refundApiUrl above.
const crmApiUrl =
  process.env['E2E_CRM_API_URL'] ?? process.env['VITE_CRM_API_URL'] ?? 'http://localhost:8084'
const meetingsApiUrl =
  process.env['E2E_MEETINGS_API_URL'] ??
  process.env['VITE_MEETINGS_API_URL'] ??
  'http://localhost:8085'

// projects-api / activities-api base URLs (specs/20261103-projects / specs/20261110-activities, T21). Same reason as the
// ones above: the SHELL's build bakes both into its trusted-origin allowlist (ADR 20260607-jwt-in-memory-never-web-storage) and exposes them
// to the remotes (`getProjectsApiBaseUrl`, `getActivitiesApiBaseUrl`); without VITE_ACTIVITIES_API_URL
// crm-ui and projects-ui send no Bearer token to activities-api and every call 401s.
const projectsApiUrl =
  process.env['E2E_PROJECTS_API_URL'] ?? process.env['VITE_PROJECTS_API_URL'] ?? 'http://localhost:8086'
const activitiesApiUrl =
  process.env['E2E_ACTIVITIES_API_URL'] ??
  process.env['VITE_ACTIVITIES_API_URL'] ??
  'http://localhost:8087'

// letterhead-api base URL (specs/20261116-letterhead-service, T26). The SHELL's build bakes it into its trusted-origin
// allowlist (ADR 20260607-jwt-in-memory-never-web-storage) and exposes it to letterheads-ui (`getLetterheadsApiBaseUrl`),
// which ships no VITE_* of its own: without it the configurator sends no Bearer token and every call is a 401.
const letterheadsApiUrl =
  process.env['E2E_LETTERHEADS_API_URL'] ??
  process.env['VITE_LETTERHEADS_API_URL'] ??
  'http://localhost:8088'

// accounting-api base URL (specs/20261119-accounting, T40). The SHELL's build bakes it into its trusted-origin allowlist
// (ADR 20260607-jwt-in-memory-never-web-storage) and exposes it to accounting-ui (`getAccountingApiBaseUrl`), which ships no
// VITE_* of its own: without it the Accounting screens send no Bearer token and every call is a 401. The same variable
// (E2E_ACCOUNTING_API_URL) is what e2e/helpers/accountingFixtures.ts and the global setup's health pre-check talk to.
const accountingApiUrl =
  process.env['E2E_ACCOUNTING_API_URL'] ??
  process.env['VITE_ACCOUNTING_API_URL'] ??
  'http://localhost:8089'

// The shell's preview port. 5173 by default — the origin in auth's committed
// ALLOWED_ORIGINS. E2E_SHELL_PORT only exists for a machine where 5173 is
// already taken by an unrelated dev server (the services under test must then
// be started with that origin in their own ALLOWED_ORIGINS).
const shellPort = process.env['E2E_SHELL_PORT'] ?? '5173'
const shellUrl = `http://localhost:${shellPort}`
const estimaiRemoteOrigin = `http://localhost:${process.env['E2E_ESTIMAI_REMOTE_PORT'] ?? '5175'}`
const refundRemoteOrigin = `http://localhost:${process.env['E2E_REFUND_REMOTE_PORT'] ?? '5176'}`
// notify-ui added for T21 (specs/20260713-notification-center). This e2e harness
// already uses its OWN port numbering for the built+previewed remotes,
// distinct from mise.toml's `dev`/`dev:preview` HMR port assignments
// (estimai-ui/refund-ui above are on 5175/5176 here, not their mise.toml dev
// ports 5174/5175) — `--port`/`--strictPort` on the `preview` command below
// is what actually binds the port, not each app's own vite.config.ts dev
// server default. notify-ui's dev-mode default (5176, vite.config.ts) is
// already claimed by refundRemoteOrigin in THIS file's numbering, so 5178
// (free here) is used for its e2e preview instance only.
const notifyRemoteOrigin = `http://localhost:${process.env['E2E_NOTIFY_REMOTE_PORT'] ?? '5178'}`
// admin-ui (specs/20260713-auth-roles-permissions T25, specs/20260713-user-invitations
// T14) — the Roles/Permissions/Invitations admin GUI. Was federated into the
// shell's router/vite.config (ADMIN_REMOTE_URL) back in specs/20260713-auth-roles-permissions but never
// added to THIS webServer array, so admin-ui had NO real browser e2e coverage
// until this feature's T14 — every ACL/roles/departments AC that named "e2e"
// in specs/20260713-auth-roles-permissions's own test-strategy table was, in practice, only verified at
// the component (vitest) level. 5179 is the next free e2e-preview slot.
const adminRemoteOrigin = `http://localhost:${process.env['E2E_ADMIN_REMOTE_PORT'] ?? '5179'}`
// inventory-ui (specs/20261006-hardware-inventory, T45) — gated `./App` at /inventory,
// ungated `./MyDevices` at /devices. 5180 is the next free e2e-preview slot.
const inventoryRemoteOrigin = `http://localhost:${process.env['E2E_INVENTORY_REMOTE_PORT'] ?? '5180'}`
// crm-ui (specs/20261101-crm) and meetings-ui (specs/20261104-meetings, T86): the next two free e2e-preview
// slots. The meetings journeys reach a deal's Meetings card (crm-ui `HostExtension` -> meetings-ui
// `./HostMeetings`), so both remotes must be served. The ports are overridable for a machine that
// already serves them (the `mise run dev` stack has crm-ui on 5179 and meetings-ui on 5180:
// `E2E_CRM_REMOTE_PORT=5179 E2E_MEETINGS_REMOTE_PORT=5180 pnpm e2e meetings-*`; Playwright then
// reuses whatever answers on those URLs).
const crmRemoteOrigin = `http://localhost:${process.env['E2E_CRM_REMOTE_PORT'] ?? '5181'}`
const meetingsRemoteOrigin = `http://localhost:${process.env['E2E_MEETINGS_REMOTE_PORT'] ?? '5182'}`
// projects-ui (specs/20261103-projects, specs/20261110-activities T21): ./App at /projects, with the Tasks card and My tasks.
// 5183 is the next free e2e-preview slot (the `mise run dev` stack has it on 5181:
// `E2E_PROJECTS_REMOTE_PORT=5181 pnpm e2e activities-*`; Playwright then reuses what answers there).
const projectsRemoteOrigin = `http://localhost:${process.env['E2E_PROJECTS_REMOTE_PORT'] ?? '5183'}`
// Running against an already-started stack (`mise run dev:preview`, whose remotes sit on their own
// vite.config ports) instead of letting Playwright build and preview them: point every remote at the port
// that stack uses, so a spec that intercepts a remote's origin (remote-failure.spec.ts) intercepts the right
// one. A port left at its e2e default while 5173 is a reused shell built for other ports silently tests the
// wrong remote:
//   E2E_ESTIMAI_REMOTE_PORT=5174 E2E_REFUND_REMOTE_PORT=5175 E2E_NOTIFY_REMOTE_PORT=5176
//   E2E_ADMIN_REMOTE_PORT=5177 E2E_INVENTORY_REMOTE_PORT=5178 E2E_CRM_REMOTE_PORT=5179
//   E2E_MEETINGS_REMOTE_PORT=5180 E2E_PROJECTS_REMOTE_PORT=5181 E2E_LETTERHEADS_REMOTE_PORT=5182 E2E_ACCOUNTING_REMOTE_PORT=5183 pnpm e2e
// letterheads-ui (specs/20261116-letterhead-service, T26): ./App at /letterheads. The `mise run dev` stack has it on 5182,
// which the meetings-ui preview above takes in THIS file's numbering, so 5184 is the next free e2e-preview slot
// (`E2E_LETTERHEADS_REMOTE_PORT=5182 pnpm e2e letterheads` reuses the `mise run dev` one).
const letterheadsRemoteOrigin = `http://localhost:${process.env['E2E_LETTERHEADS_REMOTE_PORT'] ?? '5184'}`
// accounting-ui (specs/20261119-accounting, T40): ./App at /accounting. The `mise run dev` stack has it on 5183, which the
// projects-ui preview above takes in THIS file's numbering, so 5185 is the next free e2e-preview slot
// (`E2E_ACCOUNTING_REMOTE_PORT=5183 pnpm e2e accounting` reuses the `mise run dev` one).
const accountingRemoteOrigin = `http://localhost:${process.env['E2E_ACCOUNTING_REMOTE_PORT'] ?? '5185'}`
const projectsRemotePort = new URL(projectsRemoteOrigin).port
const crmRemotePort = new URL(crmRemoteOrigin).port
const meetingsRemotePort = new URL(meetingsRemoteOrigin).port
const letterheadsRemotePort = new URL(letterheadsRemoteOrigin).port
const accountingRemotePort = new URL(accountingRemoteOrigin).port

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',

  // specs/20261117-legal-entities (T41): the registry seeded by the import and complete, and its three people (e2e/global-setup.ts).
  globalSetup: './e2e/global-setup.ts',

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
      testIgnore: '**/meetings-*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // specs/20261104-meetings (T86). Chromium with a FAKE microphone: the permission prompt is
      // auto-accepted and getUserMedia returns a synthetic tone, so the in-browser recorder runs
      // for real with no hardware (where the OS audio stack is unreachable, e.g. a sandboxed
      // macOS shell, Chromium's fake device never answers; the fixtures then install a WebAudio
      // microphone, see `installFakeMicrophone` in helpers/meetingsFixtures.ts). Tab audio (getDisplayMedia) cannot be captured headless: the
      // journeys cover the mic-only path and the capability notice. The AI side is meetings-api's
      // own `MEETINGS_AI_PROVIDER=fake` (fake transcriber and LLM), an env of that process.
      name: 'meetings',
      testMatch: '**/meetings-*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
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
      command: `pnpm build && pnpm preview --port ${new URL(estimaiRemoteOrigin).port} --strictPort`,
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
      command: `pnpm build && pnpm preview --port ${new URL(refundRemoteOrigin).port} --strictPort`,
      cwd: '../refund-ui',
      url: refundRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
        VITE_REFUND_API_URL: refundApiUrl,
      },
    },
    {
      // notify-ui (specs/20260713-notification-center, T21) — added alongside
      // estimai-ui/refund-ui above so AC-1.4/1.5/2.1/2.4/2.5/3.x/5.x/6.x can
      // be driven against the REAL federated notification-center remote, not
      // a mock. Consumes shell/session (Bearer JWT + the notification
      // transport seam) exactly like estimai-ui/refund-ui do.
      command: `pnpm build && pnpm preview --port ${new URL(notifyRemoteOrigin).port} --strictPort`,
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
      // admin-ui (specs/20260713-user-invitations T14 — see adminRemoteOrigin doc
      // comment above for why this entry is new). Same shape as
      // estimai-ui/refund-ui/notify-ui above: independently built + previewed,
      // consumes shell/session + shell/tokens.css.
      command: `pnpm build && pnpm preview --port ${new URL(adminRemoteOrigin).port} --strictPort`,
      cwd: '../admin-ui',
      url: adminRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
        // admin-ui's first import.meta.env.VITE_* var (specs/20260803-employee-
        // address, T7/T16). googlePlaces.ts's loadPlacesLibrary() throws
        // BEFORE ever checking window.google if this is falsy at BUILD time
        // (this webServer entry runs `pnpm build && pnpm preview`) — so
        // without it, employee-address.spec.ts's fully-stubbed
        // window.google.maps.importLibrary (installFakeGooglePlaces) is
        // never even reached, and the spec fails at its first suggestion
        // assertion (AC-3.2's graceful-degradation path kicks in instead).
        // A placeholder value is sufficient: the SDK itself is stubbed at
        // the network layer in the spec, so this key's VALUE is never used
        // for a real request — it only needs to be non-empty. Overridable
        // via VITE_GOOGLE_MAPS_API_KEY in the environment (e.g. CI) for a
        // real key once T16's provisioning is unblocked.
        VITE_GOOGLE_MAPS_API_KEY:
          process.env['VITE_GOOGLE_MAPS_API_KEY'] ?? 'e2e-stub-not-a-real-key',
      },
    },
    {
      // inventory-ui (specs/20261006-hardware-inventory, T45). It reads no VITE_* of its
      // own: the inventory-api origin comes from the shell (getInventoryApiBaseUrl).
      command: `pnpm build && pnpm preview --port ${new URL(inventoryRemoteOrigin).port} --strictPort`,
      cwd: '../inventory-ui',
      url: inventoryRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
      },
    },
    {
      // crm-ui (specs/20261101-crm): the deal page that hosts the Meetings card (specs/20261104-meetings).
      command: `pnpm build && pnpm preview --port ${crmRemotePort} --strictPort`,
      cwd: '../crm-ui',
      url: crmRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
      },
    },
    {
      // meetings-ui (specs/20261104-meetings, T86): ./App, ./MyMeetings, ./HostMeetings, ./version.
      // Reads no VITE_* of its own: the meetings-api origin comes from the shell.
      command: `pnpm build && pnpm preview --port ${meetingsRemotePort} --strictPort`,
      cwd: '../meetings-ui',
      url: meetingsRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
      },
    },
    {
      // projects-ui (specs/20261110-activities, T21): the project page's Tasks card and /projects/tasks.
      // Reads no VITE_* of its own: the projects-api and activities-api origins come from the shell.
      command: `pnpm build && pnpm preview --port ${projectsRemotePort} --strictPort`,
      cwd: '../projects-ui',
      url: projectsRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
      },
    },
    {
      // letterheads-ui (specs/20261116-letterhead-service, T26): the Letterheads configurator at /letterheads.
      // Reads no VITE_* of its own: the letterhead-api origin comes from the shell.
      command: `pnpm build && pnpm preview --port ${letterheadsRemotePort} --strictPort`,
      cwd: '../letterheads-ui',
      url: letterheadsRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
      },
    },
    {
      // accounting-ui (specs/20261119-accounting, T40): the Accounting tool at /accounting.
      // Reads no VITE_* of its own: the accounting-api origin comes from the shell.
      command: `pnpm build && pnpm preview --port ${accountingRemotePort} --strictPort`,
      cwd: '../accounting-ui',
      url: accountingRemoteOrigin,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        SHELL_REMOTE_URL: `${shellUrl}/remoteEntry.js`,
      },
    },
    {
      command: `pnpm build && pnpm preview --port ${shellPort} --strictPort`,
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
        INVENTORY_REMOTE_URL: `${inventoryRemoteOrigin}/remoteEntry.js`,
        CRM_REMOTE_URL: `${crmRemoteOrigin}/remoteEntry.js`,
        MEETINGS_REMOTE_URL: `${meetingsRemoteOrigin}/remoteEntry.js`,
        PROJECTS_REMOTE_URL: `${projectsRemoteOrigin}/remoteEntry.js`,
        LETTERHEADS_REMOTE_URL: `${letterheadsRemoteOrigin}/remoteEntry.js`,
        ACCOUNTING_REMOTE_URL: `${accountingRemoteOrigin}/remoteEntry.js`,
        VITE_AUTH_URL: authUrl,
        VITE_API_URL: apiUrl,
        VITE_NOTIFY_API_URL: notifyApiUrl,
        VITE_REFUND_API_URL: refundApiUrl,
        VITE_INVENTORY_API_URL: inventoryApiUrl,
        VITE_CRM_API_URL: crmApiUrl,
        VITE_MEETINGS_API_URL: meetingsApiUrl,
        VITE_PROJECTS_API_URL: projectsApiUrl,
        VITE_ACTIVITIES_API_URL: activitiesApiUrl,
        VITE_LETTERHEADS_API_URL: letterheadsApiUrl,
        VITE_ACCOUNTING_API_URL: accountingApiUrl,
      },
    },
  ],
})
