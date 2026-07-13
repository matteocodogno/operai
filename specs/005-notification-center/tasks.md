---
spec: 005
generated: 2026-07-13
---

# Tasks: Notification center

Derived from `plan.md` (approved) + `design.md`. Domains: **BE** = backend-dev
(notify-api / auth / estimai-api, Bun+Hono+Prisma), **FE** = frontend-dev
(shell + notify-ui, React+Vite+MF), **DevOps** = devops (compose/mise/Railway/Vercel/CSP).

Tracks that can run in parallel: **A** notify-api backend · **B** auth `aud` · **C** notify-ui
remote · **D** shell seam · **E** infra. Sequence only along `deps:`. Route/registration
files shared within a service (notify-api `src/index.ts`, shell `router.tsx`/`ShellLayout.tsx`)
are edited by a single track to avoid collisions.

---

- [x] T1: Scaffold `notify-api` resource service — refs: US-1, US-2, US-4 (enabler) — deps: none
  - touch: `notify-api/` (clone `estimai-api` structure: `package.json`, `tsconfig.json`, `src/index.ts`, `src/lib/env.ts`, `src/lib/db.ts`, `src/lib/errors.ts`, `src/openapi/`, `src/auth/jwt.middleware.ts` (copy, ADR-0005), `src/health/`)
  - port **8081**; `ALLOWED_ORIGINS`, `JWKS`/issuer env validated at startup; RFC 7807 `onError`/`notFound`
  - done when: `bun run typecheck` clean and `GET /health` returns 200 locally

- [x] T2: Notification Prisma model + init migration — refs: US-2, US-6 — deps: T1
  - touch: `notify-api/prisma/schema.prisma`, `notify-api/prisma/migrations/*`
  - `Notification` per plan (recipientId, title, body, severity, originApp, linkHref?, linkLabel?, toastWorthy, readAt?, timestamps) + the two `@@index` on `[recipientId, createdAt Desc]` and `[recipientId, readAt]`
  - done when: `bun run db:migrate` applies the init migration to the `notify` DB and the Prisma client generates

- [x] T3: EventBus + ticket-store seams (in-process impls) — refs: US-1, US-5 — deps: T1
  - touch: `notify-api/src/notifications/eventBus.ts`, `notify-api/src/notifications/ticketStore.ts`
  - `publish(sub,event)`/`subscribe(sub)` behind an interface (R2: Postgres LISTEN/NOTIFY later); single-use, ~30s-TTL, sub-bound ticket `Map` behind an interface
  - done when: `bun test` proves publish→subscriber delivery and ticket mint→consume is single-use + expires

- [x] T4: `POST /notifications` raise endpoint — refs: US-4 (AC-4.1..4.5) — deps: T2, T3
  - touch: `notify-api/src/notifications/raise.routes.ts` (+ register in `src/index.ts`)
  - zod: title 1..200, body 1..2000, severity enum, originApp enum, `link.href` **relative-only** (open-redirect guard), toast default false; body-size cap (413); `recipientId := JWT sub` and **any body `recipient` is ignored** (A01); `publish()` the event
  - done when: integration tests — 201 happy; 400 on empty title/body, bad enum, non-relative `link.href`; persisted `recipientId == sub`; event published

- [x] T5: `GET /notifications` (list) + `GET /notifications/unread-count` — refs: US-2 (2.3, 2.4), US-6 (6.1, 6.2) — deps: T2
  - touch: `notify-api/src/notifications/list.routes.ts` (+ register)
  - cursor pagination, `createdAt DESC`, `sub`-scoped, `[]` (not error) when none; not-owned → 404 (ADR-0005); unread-count = exact server truth
  - done when: integration tests — ordering, empty list, sub-scope isolation, not-owned 404, correct count

- [x] T6: `POST /notifications/mark-all-read` — refs: US-3 (3.1, 3.4) — deps: T2, T3
  - touch: `notify-api/src/notifications/markRead.routes.ts` (+ register)
  - set `readAt := now()` for all unread of `sub`; idempotent (harmless 200 when nothing unread); publish `unread-reset` to sub's streams
  - done when: integration tests — marks unread→read, idempotent 200 no-op, `unread-reset` published

- [x] T7: SSE — `POST /notifications/stream-ticket` + `GET /notifications/stream?ticket=` — refs: US-1 (1.4, 1.5), US-5 (5.1, 5.5, 5.6) — deps: T3, T4, T6
  - touch: `notify-api/src/notifications/stream.routes.ts` (+ register)
  - ticket mint on Bearer/JWKS path; stream authed by ticket only (no `jwtMiddleware`); `event: notification` / `event: unread-reset`; `: heartbeat` ~15s; `MAX_STREAM_DURATION`; subscribe EventBus; CORS `Allow-Origin: <shell origin>`
  - done when: integration tests — invalid/expired/used ticket → 401 (stream never opens); valid ticket streams a `notification` event on raise and `unread-reset` on mark-all-read; two connections for one `sub` both receive fan-out

- [x] T8: `auth` issues the `audience` JWT claim — refs: Security R7, ADR-0010 — deps: none
  - touch: `auth/src/auth/*` (better-auth jwt plugin `audience`), `auth/src/lib/env.ts` (`AUTH_AUDIENCE`), `auth/.env.example`
  - done when: a minted JWT carries the `audience` claim; auth `bun run typecheck` + tests green

- [x] T9: `estimai-api` + `notify-api` verify `audience` — refs: Security R7, ADR-0010 — deps: T8, T1
  - touch: `estimai-api/src/auth/jwt.middleware.ts` + env; `notify-api/src/auth/jwt.middleware.ts` + env (`AUTH_AUDIENCE` both)
  - `jwtVerify` pins `audience`; a token with missing/wrong `aud` → 401 in both services
  - done when: both services reject wrong/absent `aud` (401) and accept the correct one (200); existing estimai-api auth tests updated + green

- [ ] T10: Shell notification seam in `shell/session` — refs: US-1 (1.4, 1.5), US-3 (3.1), US-4, US-5, AC-6.3 — deps: T7
  - touch: `shell/src/lib/notifications.ts` (new), `shell/src/lib/session.ts` (extend `getTrustedOrigins` with `VITE_NOTIFY_API_URL`, extend `signOut`), federation `./session` export
  - `raiseNotification`, `getNotifyBaseUrl` (`VITE_NOTIFY_API_URL`), `useUnreadCount` (SSE-driven, REST-seeded, listener-set like `usePermissions`), `resetUnreadCount` (optimistic local zero); internal **SSE connection manager** (mint ticket → `EventSource` → handle `notification`/`unread-reset` → emit toast-worthy → reconnect + REST resync); `signOut` closes + reconnects
  - done when: unit tests — `raiseNotification` shape/sub-only, `useUnreadCount` updates on mocked events, `resetUnreadCount` zeros, SSE manager reconnect re-syncs count, trusted-origins includes notify

- [ ] T11: Shell `Bell` button — refs: US-1 (1.1, 1.2, 1.3, 1.6), US-2 (2.1) — deps: T10
  - touch: `shell/src/components/Bell.tsx` (new), `shell/src/components/Header.tsx` (place beside `ThemeToggle`)
  - `useUnreadCount`; badge shows 1–9 exact, "9+" for ≥10, none at 0; `onClick` → `navigate('/notify')`; a11y: static button name + separate `aria-live` badge region (design.md)
  - done when: unit tests — badge for 0/1/9/10/99, navigates on click; renders on every route

- [ ] T12: Shell `ToastHost` — refs: US-5 (5.1, 5.2, 5.3, 5.5) — deps: T10
  - touch: `shell/src/components/ToastHost.tsx` (new), `shell/src/components/ShellLayout.tsx` (mount once)
  - subscribes SSE toast stream; severity variants `role="status"` (info/success) vs `role="alert"` (warning/error); auto-dismiss + manual dismiss (no reappear); stacking; honors reduced-motion (design.md)
  - done when: unit tests — toast pops on toast-worthy event, auto-dismiss timer, manual dismiss no-reappear, non-toast event pops nothing, correct aria roles

- [x] T14: Scaffold `notify-ui` remote — refs: US-2 (enabler) — deps: none
  - touch: `notify-ui/` (clone `admin-ui`: `@module-federation/vite` exposing `./App`, consumes `shell/session` + `shell/tokens.css`, `src/main.tsx` standalone bootstrap, inner TanStack Router `basepath '/notify'`), port **5176**
  - done when: `pnpm build` succeeds and standalone `pnpm dev` renders a shell of the page

- [ ] T15: Notification center page (`notify-ui`) — refs: US-2 (2.1–2.5), US-3 (3.1–3.4) — deps: T14, T10, T5, T6
  - touch: `notify-ui/src/pages/NotificationCenterPage.tsx`, `notify-ui/src/components/NotificationItem.tsx`, severity lookup, empty/loading/error states
  - `GET /notifications` via `apiFetch(getNotifyBaseUrl())`; item shows title/body/timestamp/read-state/severity/originApp; newest-first; explicit empty state; **capture unread set at open → `resetUnreadCount()` + `POST /mark-all-read`**; "was-unread" affordance for the viewing session only (text+weight+border, sr-only, not color-only — design.md AC-3.2/3.3); "mark all as read" control (AC-3.4); link/action followed as an in-suite route navigation (not `location=`)
  - done when: unit/component tests for populated list, ordering, empty, loading, error, was-unread affordance present-then-absent-on-remount, mark-all-read call, link follow

- [ ] T13: Shell `/notify` route + remote registration — refs: US-2 (2.1) — deps: T10, T14
  - touch: `shell/src/router.tsx` (always-available `/notify/*` catch-all mounting `notify/App`), `shell/src/lib/runtimeRemotes.ts`, `shell/vite.config.ts`
  - **NOT** an app-access-gated `tools.ts` entry and NOT in the sidebar `TOOLS` list (plan §Shell) — reachable by any authenticated user, from the bell
  - done when: router test renders the notify remote at `/notify`; asserted absent from the permission-filtered sidebar list

- [x] T16: Local dev wiring — refs: R9 — deps: T1, T14
  - touch: `compose.yaml` (create `notify` logical DB like `estimai`), `mise.toml` (dev/build/preview start notify-api :8081 + notify-ui :5176), `notify-api/.env.example`, shell env (`VITE_NOTIFY_API_URL`)
  - done when: `docker compose up` creates the `notify` DB and `mise run dev` starts both new services

- [x] T17: `notify-api` deploy config — refs: R9, R2, data-residency — deps: T1
  - touch: `notify-api/railway.json` (**`numReplicas: 1`** — single-instance ticket store/fan-out, R2), `notify-api/Dockerfile`, `preDeployCommand` `db:deploy`, EU `europe-west4`, estimai-api logger posture (no bodies logged)
  - done when: config mirrors estimai-api; single-replica pin present

- [x] T18: `notify-ui` deploy config — refs: R9 — deps: T14
  - touch: `notify-ui/vercel.json` (clone `admin-ui`), `SHELL_REMOTE_URL`/runtime-config vars
  - done when: config present and mirrors admin-ui

- [x] T19: Shell CSP + origin allowlists — refs: R6 — deps: none
  - touch: `shell/vercel.json` — **`connect-src`** += `notify-api.operai.welld.io` (SSE is governed by connect-src!) **and** notify-ui origin; `script-src` += `notify.operai.welld.io`; note `ALLOWED_ORIGINS` additions for auth + notify-api
  - done when: CSP includes both new origins, with the notify-api origin in `connect-src` for the EventSource stream

- [ ] T20: Deploy-doc + scripts update — refs: R9, ADR-0010 — deps: T16, T17, T18, T19, T9
  - touch: `infra/README.md`, `infra/deploy.sh`, `infra/check.sh`
  - add notify-api + notify-ui to topology/provisioning; env reference incl. `AUTH_AUDIENCE` (all three services) + `VITE_NOTIFY_API_URL`; `check.sh` verifies notify-api `/health` + notify-ui `remoteEntry.js` + the SSE `connect-src` CSP pin
  - done when: doc + scripts cover both new services and the `aud` env

- [ ] T21: End-to-end (Playwright) — refs: AC-1.4, 1.5, 2.1, 2.4, 2.5, 3.1, 3.2, 3.3, 5.1, 5.5, 5.6, 6.1, 6.2, 6.3 — deps: T7, T13, T15, T16
  - touch: `shell/e2e/notifications.spec.ts` (seeded-session helper)
  - raise → badge ≤~2s; two contexts both update; open center → badge 0 + was-unread affordance; reload → no affordance; toast on toast-worthy over a mounted remote; non-toast → no toast; raise-while-disconnected → present in center, no toast on reconnect; two-user isolation; sign-out/sign-in user switch shows only own
  - done when: the e2e spec passes against the assembled shell + notify-ui + notify-api

- [ ] T22: Close — all gates green, spec status → done — deps: T1–T21
  - QE PASS + owasp (≥medium clear) + eval PASS; then `/wellforge:done 005`
  - done when: done gate met and spec frontmatter `status: done`

---

## Coverage map (every AC → ≥1 task)

| AC | Tasks | | AC | Tasks |
|----|-------|-|----|-------|
| 1.1 | T11, T21 | | 3.4 | T6, T15 |
| 1.2 | T11 | | 4.1 | T4, T10 |
| 1.3 | T11 | | 4.2 | T4, T15 |
| 1.4 | T7, T10, T21 | | 4.3 | T4, T15 |
| 1.5 | T7, T21 | | 4.4 | T4, T15 |
| 1.6 | T11 | | 4.5 | T4, T10 |
| 2.1 | T11, T13, T15, T21 | | 5.1 | T7, T12, T21 |
| 2.2 | T15 | | 5.2 | T12 |
| 2.3 | T5, T15 | | 5.3 | T12 |
| 2.4 | T5, T15, T21 | | 5.4 | T4, T5, T21 |
| 2.5 | T15, T21 | | 5.5 | T7, T12, T21 |
| 3.1 | T6, T10, T15, T21 | | 5.6 | T7, T5, T21 |
| 3.2 | T15, T21 | | 6.1 | T5, T21 |
| 3.3 | T15, T21 | | 6.2 | T5, T21 |
| | | | 6.3 | T10, T21 |

Enabler tasks (T1, T2, T3, T14, T16–T20) serve the above transitively (scaffold, persistence,
seams, infra); T8/T9 serve the plan's Security §R7 / ADR-0010 (the `aud` decision approved at
the plan gate). No task serves zero ACs-or-plan-items.
