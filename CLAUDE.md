# Operai — EstimAI

Internal toolsuite by **wellD** (wellD.ch) for AI-assisted software consulting workflows.
EstimAI is the first tool in the suite — a software effort estimator.

**Tagline:** *AI tools built by craftspeople, for craftspeople.*

---

## Project structure

```
operai/
├── estimai-ui/          # React + Vite frontend
│   ├── src/
│   │   ├── components/              # ActivityTable, SummaryTable, MetricsBar,
│   │   │                            # ParametersPanel, Header, UserMenu, HelpDrawer, …
│   │   ├── context/
│   │   │   └── EstimatorContext.tsx # Global state + localStorage persistence
│   │   ├── hooks/
│   │   │   ├── useEstimator.ts      # All estimation computation logic
│   │   │   └── useTheme.ts
│   │   ├── lib/                     # api (apiFetch interceptor), authClient, pdfExport,
│   │   │                            # ganttChart, healthWarnings, shareUrl, projects, …
│   │   ├── pages/                   # EstimatesPage, EstimatePage, SharedEstimatePage
│   │   ├── router.tsx               # TanStack Router (_authed guard)
│   │   ├── types.ts                 # Shared TypeScript interfaces
│   │   ├── EstimatorApp.tsx         # Top-level layout + state + XLSX export
│   │   └── main.tsx
│   ├── package.json     # NOTE: no e2e here — every estimai journey lives in shell/e2e/ (see below)
│   └── vite.config.ts
│
├── shell/               # Suite host (Module Federation) — shared chrome + session; mounts remotes (specs/003, ADR-0006)
│   └── e2e/             # Playwright e2e for the WHOLE suite — every remote's journeys run through the
│                        # host, since a remote has no standalone authed bootstrap (specs/003 retired
│                        # estimai-ui/e2e/ when it became a federated remote). helpers/: adminSession,
│                        # seedSession, estimaiFixtures, inviteFixtures, refundFixtures
├── refund-ui/           # Reimbursement tool — federated remote: expense requests + accounting review/decision (specs/007)
├── admin-ui/            # Admin tool — federated remote: roles/departments/users/permissions GUI (specs/004, admin-only)
├── notify-ui/           # Notification center — federated remote: the /notify page, reached from the header bell (specs/005, ADR-0009)
│
├── auth/                # Bun + Hono authentication service
│   ├── src/
│   │   ├── auth/        # better-auth config, middleware (requireAuth/requireAdmin), routes
│   │   ├── authz/        # authorization (specs/004, ADR-0007): resolver, /authz/me, catalog, audit, seed
│   │   ├── admin/        # admin API — roles/departments/users routes + last-admin guard; user soft-delete + bulk (specs/006)
│   │   ├── invitations/  # invitation lifecycle + admin API (create/list/resend/revoke); notify email trigger (specs/006, ADR-0012/0013)
│   │   ├── invite/       # hosted invite landing page (GET /invite, bilingual) + state JSON (specs/006)
│   │   ├── signin/      # hosted sign-in page (Google/GitHub)
│   │   ├── test-auth/   # dev/test-only session-mint endpoint (gated)
│   │   ├── jwks/        # JWKS endpoint (RS256 public key)
│   │   ├── health/      # Health check routes
│   │   ├── openapi/     # OpenAPI registry (zod-openapi + Scalar)
│   │   └── lib/         # db (Prisma), env validation, errors
│   ├── prisma/          # Schema + migrations (PostgreSQL)
│   └── package.json
│
├── estimai-api/         # Bun + Hono + TypeScript backend — estimate persistence (implemented; JWKS-verified, see specs/001, ADR-0005)
├── notify-api/          # Bun + Hono + TypeScript backend — notification persistence + SSE push, ticket-authed stream (specs/005, ADR-0008/0009); + email delivery channel via Resend, internal /system/emails (specs/006, ADR-0011); + internal /system/notifications for cross-user push (specs/007, ADR-0017)
├── refund-api/          # Bun + Hono + TypeScript backend — reimbursement persistence; authorization-enforcing resource server + EU object storage for receipt attachments (specs/007, ADR-0014/0015/0016)
│
├── docs/adr/            # Architecture Decision Records (0001–0022; see ## Architecture decisions)
├── compose.yaml         # Local PostgreSQL 17 (host port 5435)
├── mise.toml            # Node 24, corepack-managed pnpm; `mise run changeset` / `release:version` / `release:tag`
└── specs/               # Spec-driven workflow (see below)
```

---

## Tech stack

### Frontend (estimai-ui)
- **Runtime:** Node 24 via mise (pnpm via corepack, see `mise.toml`)
- **Package manager:** pnpm
- **Framework:** Vite 8 + React 19 (TypeScript)
- **Routing:** TanStack Router
- **Tables:** TanStack Table v8
- **Export:** `exceljs` + `xlsx` for XLSX, `jspdf` + `jspdf-autotable` for PDF
- **Sharing:** `lz-string` (URL-encoded estimates) + `qrcode`
- **Auth:** better-auth client; in-memory JWT + `apiFetch` interceptor (see ADR-0001)
- **Testing:** Vitest (unit/component) here; e2e lives in `shell/` (`cd shell && pnpm e2e`) — a
  federated remote has no standalone authed bootstrap, so its journeys run through the host
- **Fonts:** DM Sans, DM Mono, Syne (Google Fonts)
- **Styling:** Tailwind CSS 4
- **Lint/format:** ESLint 9 (flat config) + Prettier
- **Deploy:** Vercel (auto-deploy on push to `main`)

### Auth service (auth)
- **Runtime:** Bun (`bun run --hot` for dev)
- **Framework:** Hono + `@hono/zod-openapi` (Scalar API reference)
- **Auth:** better-auth — OAuth (Google, GitHub) + session management; hosted sign-in page
- **Tokens:** RS256 JWT issuance (`jose`) + JWKS endpoint; keypair via env vars
  (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`), generated locally with openssl — `.pem`
  files are gitignored, never commit them
- **Origin trust:** `ALLOWED_ORIGINS` feeds BOTH the Hono CORS layer and better-auth's
  `trustedOrigins` (sign-out and other session-mutating calls). Never set
  `BETTER_AUTH_TRUSTED_ORIGINS` — it bypasses that validated allowlist.
- **Database:** PostgreSQL via Prisma 7 (`@prisma/adapter-pg`)
- **Errors:** Effect TS; RFC 7807 Problem JSON
- **Secrets:** 1Password references via `.envrc` (direnv); see `auth/.env.example`

### Backend (estimai-api) — planned, not yet implemented
- **Runtime/framework:** Bun + Hono + `@hono/zod-openapi` (mirrors the `auth` service; see ADR-0003)
- **Persistence:** Prisma 7 + PostgreSQL; estimates stored as a JSONB document + listing columns (see ADR-0004)
- **Auth:** resource server — verifies the `auth` service's RS256 JWT via its JWKS endpoint (see ADR-0005)
- **Errors:** Effect TS; RFC 7807 Problem JSON
- **Deploy:** EU region (Railway EU — data residency requirement)
- The full design lives in `specs/001-estimate-persistence/plan.md`.

---

## Estimation model

All computation lives in `estimai-ui/src/hooks/useEstimator.ts`. Do not duplicate
logic in components.

### Calculation chain (per release)

```
PERT              = (O + 4 × ML + P) / 6
Expected          = PERT + Risk Buffer
Individual M/D    = Σ Expected (for release) + QA Deploy + QA Test + PM overhead
Planning Days     = FTE × (Individual / Sprint Duration) / 8
Total Baseline    = Individual + Planning
Elapsed Days      = ROUND(Baseline × (1 − Parallelism × (FTE−1) / FTE))
Total Man/Days    = Elapsed × FTE
Elapsed Months    = Elapsed / Working Days per Month

AI-assisted M/D   = Expected × (1 − AI Productivity Gain)   [per activity, falls back to global]
AI-assisted Elapsed = same chain applied to AI-assisted individual sum
Total M/D (AI)    = AI-assisted Elapsed × FTE
AI Cost           = AI Cost Coefficient × FTE × Elapsed Days

Best Case         = full chain using Optimistic estimates
Worst Case        = full chain using Pessimistic estimates
```

### Model parameters and defaults

| Parameter | Default | Notes |
|---|---|---|
| Parallelism factor | 0.70 | % of work runnable in parallel |
| Sprint duration | 10 days | Drives planning overhead |
| Working days / month | 20 | Elapsed → months conversion |
| QA Deploy / release | 0 days | Fixed cost per release |
| QA Test / release | 0 days | Fixed cost per release |
| PM overhead / release | 0 days | Fixed cost per release |
| AI cost coefficient | 10 | €/$ per FTE per elapsed day |
| AI productivity gain | 0.30 | 30% effort reduction with AI tools |

### PERT derivation when only ML is given
```
Optimistic  = ML × 0.75
Pessimistic = ML × 1.60
```

### Important: PERT is never used directly in Summary
PERT is an intermediate value in the Detail table. Summary always SUMIFs on
`Expected` (= PERT + Risk Buffer), `Optimistic`, or `Pessimistic` — never on
PERT directly.

---

## Domain language

Use these terms consistently in code, API contracts, and UI copy:

| Term | Meaning |
|---|---|
| `estimate` | A top-level estimation document (project + releases + activities) |
| `release` | A delivery milestone, has a name and FTE count |
| `activity` | A single unit of work, belongs to an epic and a release |
| `epic` | A feature group containing multiple activities (embedded on the activity, not a table) |
| `profile` | Specialist role required for an activity (e.g. Backend Dev, Designer) |
| `expected` | PERT + risk buffer — the primary effort figure per activity |
| `elapsed` | Calendar days for a release (after parallelism adjustment) |
| `man_days` | Total person-days (elapsed × FTE) |
| `ai_gain` | Fractional productivity improvement from AI tools (0.0–1.0) |
| `ai_cost_coef` | Cost per FTE per elapsed day for AI tooling |

---

## API contract (estimai-api — planned)

Base URL: `https://api.estimai.operai.io` (production) / `http://localhost:8080` (local).
The authoritative contract is `specs/001-estimate-persistence/plan.md`. Estimates are
persisted as **whole documents** (JSONB); granular release/activity sub-resource endpoints
are an explicit non-goal for the first iteration.

```
POST   /estimates            Create a new estimate
GET    /estimates            List the current user's estimates (id, name, updatedAt)
GET    /estimates/{id}       Get the full estimate (owned by caller; 404 otherwise)
PUT    /estimates/{id}       Update in place (last-write-wins, no duplicate)
DELETE /estimates/{id}       Delete
POST   /estimates/import     One-time bulk import of legacy localStorage estimates
```

Authentication: RS256 JWT issued by the `auth` service, verified via its JWKS endpoint;
every query is scoped to the caller's `sub`. A per-estimate size guard rejects over-large
payloads (413). Errors are RFC 7807 Problem JSON; dates are ISO 8601.

---

## Data residency

wellD operates across Italy and Switzerland. Some clients are in regulated sectors
(energy, finance, healthcare). Apply these rules:

- Backend **must** deploy to an EU region (Railway EU, Fly.io fra, Azure Switzerland North)
- No estimate data should be logged by the hosting provider beyond standard access logs
- The frontend is purely client-side — no estimate data is transmitted except to the estimai-api

---

## Spec-driven workflow

Features follow the WellForge spec-driven workflow: `specs/NNN-slug/` holds `spec.md`
(what & why) → `plan.md` (how) → `tasks.md` (ordered work), produced by
`/wellforge:spec`, `/wellforge:plan`, and `/wellforge:tasks` with a user approval
gate between each stage, then `/wellforge:implement` and `/wellforge:eval`. See
`specs/README.md`. The spec is the source of truth — if implementation reveals it's
wrong, update the spec first, then re-sync tasks. Run traces live in `.forge/runs/`.

---

## Development conventions

### Git
- Branch naming: `feat/`, `fix/`, `refactor/`, `chore/`
- Commit style: Conventional Commits (`feat: add AI cost column to summary`)
- **Integrating a feature branch: prefer `git merge --ff-only` or `git merge --squash`** so history stays linear and every commit on `main` is a Conventional Commit. Avoid `--no-ff` merge commits — a `Merge branch …` message is NOT a Conventional Commit and just adds noise. If a merge commit is genuinely unavoidable, give it a conventional subject (`chore(merge): …`). (Changelogs come from **Changesets**, not from commit messages — see below — so commit style no longer affects releases; keep it clean for history's sake anyway.)
- `main` is always deployable
- A pre-commit hook runs gitleaks; 1Password references are allowlisted in `.gitleaksignore`
- **Versioning & releases: [Changesets](https://github.com/changesets/changesets), independent per-app SemVer + an aggregate `operai` umbrella version** (see `.changeset/README.md`). Each app (`@operai/auth`, `@operai/refund-ui`, …) is versioned on its own; the root `operai` version is bumped by the **largest** per-app bump in each release. Flow (all local, `mise`-driven): when a feature lands, record intent with **`mise run changeset`** (pick the affected app(s) + patch/minor/major, commit the `.changeset/*.md` with the feature — a cross-app change selects BOTH apps in one changeset, since the apps aren't npm-linked). To release: **`mise run release:version`** (applies pending changesets → per-app version bumps + `CHANGELOG.md`, then the umbrella `operai` bump + root `CHANGELOG.md`; commit these), then **`mise run release:tag`** (per-app `@operai/x@a.b.c` + `operai@a.b.c` git tags) and `git push --follow-tags`. Nothing is published to npm (all apps are `private`). Run `pnpm install` at the repo **root** once so `@changesets/cli` is available. The package list Changesets enumerates lives in **`lerna.json`** (`version: independent`), NOT in a root `package.json` `workspaces` field or a `pnpm-workspace.yaml` — because this is a **mixed pnpm (frontends) + Bun (backends) monorepo**: pnpm honors `pnpm-workspace.yaml` and Bun honors `package.json` `workspaces`, so either would make a package manager try to treat all apps as one workspace and break the per-app installs / Vercel + Railway deploys. **Neither** pnpm nor Bun reads `lerna.json`, but Changesets/@manypkg does — so per-app installs and deploys stay completely untouched.

### Frontend
- **All files must be TypeScript** (`.ts` or `.tsx`) — never create `.js` or `.jsx` files
- Computation logic belongs in `useEstimator.ts` — never in components
- Components receive data and callbacks as props; they do not compute
- CSS variables defined in the root `<style>` block in `EstimatorApp.tsx`; do not add
  external CSS files unless introducing a proper CSS module setup
- All numbers displayed to the user must be rounded (`.toFixed()` or `Math.round()`)
- Authenticated backend calls go through `apiFetch` (`src/lib/api.ts`) — it attaches the
  Bearer JWT to trusted origins only and handles the 401 refresh-retry-redirect (ADR-0001)

### Auth service & estimai-api (Bun + Hono)
- Validate all environment variables at startup (`src/lib/env.ts`); `process.exit(1)` on missing
- Routes grouped by feature directory, registered in `src/index.ts`; OpenAPI in `src/openapi/`
- Database access only through the Prisma client in `src/lib/db.ts`
- Prisma migrations — never modify existing migration files
- Return RFC 7807 Problem JSON for all error responses (global `app.onError`/`app.notFound`)

### All services
- No hardcoded strings that appear in the UI — use constants or i18n from day one
  (the tool will need Italian and English at minimum)
- Dates and durations always in ISO 8601 in API contracts; display formatting is a UI concern

---

## Running locally

### Database (shared)
```bash
docker compose up -d   # PostgreSQL 17 on localhost:5435
```

### Frontend
```bash
cd estimai-ui
pnpm install
pnpm dev              # http://localhost:5173
pnpm lint             # ESLint
pnpm build            # tsc -b + vite build (typecheck happens here)
pnpm test             # vitest
```

`estimai-ui` has **no** `e2e` script. Playwright for every remote runs from the shell host:

```bash
cd shell
pnpm e2e                              # whole suite (needs the stack up: mise run dev)
pnpm e2e estimate-sharing.spec.ts     # one spec
pnpm e2e:ui                           # interactive
```

### Auth service
```bash
cd auth
bun install
cp .env.example .env  # fill in credentials (or use direnv + 1Password via .envrc)
bun run db:migrate    # Prisma migrate dev
bun run dev           # http://localhost:3001 (hot reload)
bun run typecheck     # tsc --noEmit
bun test
```

### Resource backends (estimai-api :8080, notify-api :8081, refund-api :8082)
Same shape as the auth service (Bun + Hono + Prisma, own logical DB, own `.envrc`):
`bun install`, `bun run db:migrate`, `bun run dev`. All three are JWKS resource servers and
**require `AUTH_AUDIENCE`** (the same suite-wide value auth stamps as the `aud` claim, ADR-0010)
or they reject every token with 401. `notify-api` also serves the ticket-authed SSE stream
(ADR-0008) and is pinned to a single instance in production (in-process ticket store + fan-out).
`refund-api` is additionally an **authorization**-enforcing resource server (ADR-0014) — it
resolves the caller's live permissions from `auth GET /authz/resolve` on every request — and
uses EU-region S3-compatible object storage for receipt attachments, reached only via
presigned URLs (ADR-0016; `REFUND_S3_*` env, not yet provisioned in any environment as of
specs/007's devops task — see `infra/README.md`). The whole suite comes up with one command
from the repo root: `mise run dev`.

---

## Operai suite — future tools

EstimAI is tool #1. The suite roadmap (not yet built):

| Tool | Purpose |
|---|---|
| **EstimAI** | Software effort estimation with PERT + AI productivity modelling |
| **ReviewAI** | AI-assisted code and architecture review checklists |
| **RetroAI** | Sprint retrospective facilitation and pattern detection |
| **ProposAI** | Consulting proposal drafting from project briefs |

All tools share the Operai design system (DM Sans / DM Mono / Syne, dark ink palette, purple AI accent).

---

## Architecture decisions

- [0001] JWT in memory, never web storage — cache the RS256 JWT in a module-scope variable in `src/lib/api.ts`; never write it to localStorage/sessionStorage (see docs/adr/0001-jwt-in-memory-never-web-storage.md)
- [0002] Sign-in page hosted by auth service — central `GET /sign-in` (Hono JSX) serves all Operai tools; frontends redirect unauthenticated users there (see docs/adr/0002-sign-in-page-hosted-by-auth-service.md)
- [0003] estimai-api is Bun + Hono + TypeScript, not Kotlin/Spring Boot — one backend stack across the monorepo; supersedes the earlier Kotlin/Spring intention (see docs/adr/0003-estimai-api-bun-hono-typescript.md)
- [0004] Estimate persistence: JSONB document + denormalised listing columns — one `estimate` row with `content` JSONB; `name`/`author`/`sizeBytes`/timestamps as columns; fidelity is semantic deep-equal; 1 MiB size guard; no count quota (see docs/adr/0004-estimate-persistence-jsonb-document.md)
- [0005] JWT resource-server verification via remote JWKS — `estimai-api` verifies Bearer JWTs with `jose createRemoteJWKSet` pinned to RS256 + issuer; all queries scoped to `sub`; not-owned records return 404 not 403; establishes the pattern for all future Operai resource services (see docs/adr/0005-jwt-resource-server-remote-jwks.md)
- [0006] Operai suite frontend composition via Module Federation — a shell host owns shared chrome/session (ADR-0001/0002/0005 reused via `shell/session`); tools mount as path-basepathed remotes with no own auth guard/chrome; remote URLs resolved at runtime per-env, never build-baked (see docs/adr/0006-suite-frontend-module-federation.md)
- [0007] Authorization model: hand-rolled RBAC/ABAC in the auth service, identity+epoch JWT claims, live permission resolution — do not embed roles/permissions in the JWT (identity + `perm_epoch` only); resolve effective permissions live via `GET /authz/me`, cached in-memory and revalidated on navigation, so revocation is immediate; per-app catalog + admin API live inside `auth` (see docs/adr/0007-authz-hand-rolled-rbac-abac-epoch-claims.md)
- [0008] SSE stream authentication via a short-lived single-use ticket — `EventSource` cannot send an Authorization header, so the client mints a ~30s single-use ticket via `POST /notifications/stream-ticket` (normal Bearer/JWKS path) then opens `EventSource(GET /notifications/stream?ticket=…)`; the 7-day JWT never enters a URL (see docs/adr/0008-sse-stream-auth-short-lived-ticket.md)
- [0009] Notification center as a standalone JWKS resource service (`notify-api`) + federated remote (`notify-ui`), with only the bell/raise-capability/SSE-manager/`ToastHost` living in the shell — never add notification business logic to `shell/session`; the raise-capability's request shape reserves an inert `recipient` field for Refund's future cross-user notifications (see docs/adr/0009-notification-center-standalone-service-shell-seam.md)
- [0010] JWT `aud` (audience) claim now enforced across `auth` and every resource server — `notify-api` is the suite's first real second JWKS resource server, tripping ADR-0005/ADR-0007's deferred trigger; `auth` stamps `audience` via `definePayload`, and `estimai-api`/`notify-api` verify it via `AUTH_AUDIENCE`, closing the unscoped cross-service token-replay gap (see docs/adr/0010-jwt-audience-claim-enforcement.md)
- [0011] notify-api email as a second delivery channel + auth→notify-api service-to-service trust — a new `email` channel (raw address, Resend, bilingual) sits alongside the existing `inApp` (`sub`) channel; `auth` triggers sends via `POST /system/emails`, authenticated by a shared `NOTIFY_INTERNAL_TOKEN`, deliberately NOT a user JWT/JWKS path (ADR-0005) — leak of that token = arbitrary email over wellD's Resend domain, mitigated by internal-only exposure + fixed escaped templates; self-issued-audience service JWT is the named future hardening (see docs/adr/0011-notify-api-email-channel-service-trust.md)
- [0012] Invitation activation via two better-auth hooks + soft-delete lifecycle — `user.create.after` matches a pending invite by OAuth-**verified** email (new users only); `session.create.before` blocks/re-activates a soft-deleted user's return sign-in; deletion is soft (`deletedAt`) with a synchronous session-revocation + `perm_epoch` bump cascade, resource servers untouched at delete time; the **accepted residual-JWT window** (a deleted user's already-issued short-lived JWT stays valid until it expires) is a deliberate ADR-0005-preserving trade-off, with a resource-server liveness/epoch check named as the escalation path (see docs/adr/0012-invitation-activation-hooks-soft-delete-lifecycle.md)
- [0013] Invitation lifecycle expiry is derived, not scheduled — `expired` = `status=='pending' && expiresAt<=now`, computed on read, never written by a background job; reconcile-on-write flips stale `pending` rows before insert so the `email WHERE status='pending'` partial-unique index never blocks a fresh invite for a dead address; do not add a cron/queue expiry sweep for this or similar future lifecycle features (see docs/adr/0013-invitation-lifecycle-derived-expiry-state.md)
- [0014] refund-api is the suite's first authorization-enforcing resource server — a new Bearer-authed `auth GET /authz/resolve` (forwards the caller's already-verified JWT, no new secret) is resolved via `refund-api`'s `authzMiddleware`, cached in-process by `(sub, perm_epoch)` with a 30s TTL backstop; capability-absent denials are 403, record-level ownership/entity failures are 404 (ADR-0005-style, no existence leak); an `auth` outage fails **closed** (503), never open — realizes ADR-0007's explicitly deferred resource-server side (see docs/adr/0014-refund-api-authorization-enforcing-resource-server.md)
- [0015] Entity-scoped ABAC in refund-api evaluates specs/004's entity condition at **request** level — "at least one line's entity matches the caller's `user.entity`" — never per-line; "global" review scope is composed via the resolver's pre-existing widest-wins union (no `accounting-global` role is seeded); approve/reject/set-approved-total always apply **whole-request**, even across an out-of-scope line (see docs/adr/0015-entity-scoped-abac-refund-api.md)
- [0016] Refund receipt attachments live in EU-region S3-compatible object storage, reached only via presigned URLs (policy-capped ≤10 MiB, `pdf`/`jpeg`/`png` POST; ~60s authz-gated GET) — never proxy file bytes through refund-api; two-phase `pending`→`confirm` upload, orphans reconciled on read (only `stored` ever surfaced), no cron (ADR-0013 posture); `REFUND_S3_REGION` is validated against an EU allowlist at startup (see docs/adr/0016-eu-object-storage-refund-attachments.md)
- [0017] notify-api gains `POST /system/notifications` (internal-token, mirrors ADR-0011's `/system/emails`) for cross-user in-app push, activating ADR-0009's reserved `recipient` seam for refund-api's decision notifications; reuses the **same** `NOTIFY_INTERNAL_TOKEN` for a second caller — knowingly tripping ADR-0011's named "second internal caller" escalation trigger without acting on it yet; best-effort, never rolls back the decision; the user-JWT `POST /notifications` stays strictly self-only (OWASP A01) (see docs/adr/0017-system-notifications-cross-user-trigger.md)
- [0018] refund-api's financial audit trail (`RefundAuditEntry`) is append-only at the **database** level, not just by absent route — a `CREATE RULE`/trigger blocks `UPDATE`/`DELETE` outright, and `onDelete: Restrict` makes any request with an audit row (i.e. anything past `draft`) physically undeletable; the reusable pattern for future financial/governance records in the suite (see docs/adr/0018-immutable-financial-audit-trail-refund.md)
- [0019] Compiled-batch PDF generation runs server-side in refund-api with `pdf-lib` (pure-TS, no headless browser) — never a Puppeteer/Chromium dependency; the PDF is a **deterministic, regenerable cache derived from `RefundBatchItem`**, not the source of truth, so the compile transaction commits before the EU-bucket `PutObject` and a failed write is lazily re-rendered on the next read, with no 4th "compiling" batch status (see docs/adr/0019-refund-batch-pdf-generation-pdf-lib.md)
- [0020] `RefundStatus` gains a fifth, terminal `paid` value — **supersedes 007's "no fifth value" schema-comment freeze**; batch membership is split between the live `RefundRequest.batchId` claim pointer (dedup, overwritable) and the append-only `RefundBatchItem` (permanent history); compile-time claim uses `SELECT … FOR UPDATE` + `batchId IS NULL` CAS to prevent double-pay, mark-paid/discard use a `status='compiled'` CAS for exactly-once terminal transitions (see docs/adr/0020-refund-batch-paid-lifecycle-extension.md)
- [0021] The compiled-batch email carries an **in-app deep link** (`/refund/batches/:id`), never a raw presigned S3 URL and never a PDF attachment — the recipient must sign in and pass the same `request:review` authz check as any in-app batch view before a short-lived presigned GET is minted; sent only to the single configured `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`; `notify-api`'s email channel (ADR-0011) gains one new template + per-template `data` shape, explicitly **not** attachment support (see docs/adr/0021-refund-batch-signed-link-email-delivery.md)
- [0022] Batch audit trail extends ADR-0018 in place — new `AuditAction` values (`batch_compiled`/`batch_paid`/`batch_discarded`) + a nullable `batchId` FK on the existing `RefundAuditEntry`, one row per affected request per action, reusing the same DB-level immutability trigger and `onDelete: Restrict` retention with **no new mechanism**; membership is retained forever via ADR-0020's `RefundBatchItem` even after discard/re-inclusion (see docs/adr/0022-refund-batch-audit-trail-extension.md)
- [0023] Mileage rate model lives entirely in refund-api (not auth) — per-entity effective-dated rate series resolved derived-on-read (ADR-0013 lineage, never cron), a travel_km line's computed amount snapshots exactly once at submit and clears on withdraw-to-draft, `rate:read`/`rate:manage` is a NEW global (non-entity-scoped) catalog permission (deliberate contrast with ADR-0015), and admin-ui hosts the management screen but calls refund-api's `/rates` directly via `shell/session` apiFetch + a shell-owned `getRefundApiBaseUrl()` — refund-api stays the sole owner of rate data and all money logic (see docs/adr/0023-mileage-rate-model-snapshot-admin-ui-composition.md)
- [0024] `MileageRate` is its own append-only, self-auditing table — same DB-level `BEFORE UPDATE/DELETE` immutability trigger as `refund_audit_entry` (ADR-0018/0022), no separate audit table since every AC-5.1 field already lives on the row itself; never extend `RefundAuditEntry` for a non-request-scoped record, give it a sibling table with the identical trigger mechanism instead (see docs/adr/0024-mileage-rate-history-self-auditing-table.md)
- [0025] Mileage rate precision: store `ratePerKmMicros` (integer micros of the major unit), compute `amountCents = roundHalfUp(km × ratePerKmMicros / 10_000)` — round exactly once, at compute time, with one canonical rule mirrored (and test-vector-shared) between refund-api and refund-ui; never `Decimal`/float for the rate, extending 007's integer-minor-unit money posture (see docs/adr/0025-mileage-rate-money-precision-integer-micros.md)
- [0026] Self-approval segregation-of-duties: opt-in `{key:"self-approval",match:"deny"}` attribute on `request:approve` only (catalog-only change), enforced inline in refund-api's approve decide path with a distinguishable 403 (`code:self_approval_forbidden`) BEFORE the entity-404/status-409 gates — a deliberate exception to ADR-0005/0014's "not yours = 404"; denials are logged (`refund.self_approval_denied`), never a new `RefundAuditEntry` action; subject to ADR-0007/0015's widest-wins union (a second unconditioned approve grant unions the restriction away) (see docs/adr/0026-self-approval-condition-and-403-exception.md)
- [0027] Refund settings store: append-only, self-auditing `refund_setting` key/value table, current value derived latest-per-key, same `BEFORE UPDATE/DELETE` immutability trigger as `MileageRate` (ADR-0018/0024) — never `RefundAuditEntry` (requestId is NOT NULL, settings aren't request-scoped); no-op saves suppressed by read-before-append; the reusable extensible-config pattern for future admin-governed, non-request-scoped settings in the suite (see docs/adr/0027-refund-settings-append-only-self-auditing-store.md)
- [0028] New global `settings` catalog resource (`read`/`manage`, unconditioned) — deliberately NOT a reuse of `rate:manage` (ADR-0023): a distribution mailbox is not a rate, and conflating them would make the two admin surfaces un-separable/un-auditable in isolation; enforced server-side in refund-api on BOTH read and write (unlike `rate`'s deliberately-ungated employee-facing `GET /rates/effective`) — a non-holder must not even learn the mailbox exists (see docs/adr/0028-settings-catalog-permission-config-not-rate.md)
- [0029] Batch email recipient now resolves LIVE from `refund_setting` at every send/resend — **amends ADR-0021** (its compile-time `recipientEmailSnapshot` freeze is dropped; the column is repurposed to nullable per-attempt delivery provenance; `compileBatch` drops its recipient param entirely); unconfigured at send/resend → `422` + `code:"accounting_distribution_email_unconfigured"` + `emailStatus:"blocked_unconfigured"`, distinguishable from an ordinary Resend outage (still best-effort `200`+`"failed"`, ADR-0011); compile and mark-paid are unaffected either way (see docs/adr/0029-batch-email-recipient-live-resolution-amends-0021.md)
- [0030] Suite version surfacing splits in two: the umbrella `operai` version reaches the shell build via a generated, committed in-tree file (`shell/src/lib/suiteVersion.generated.json`, written by `scripts/version.mjs` at umbrella-bump time) — never a cross-directory read of the root `package.json`, which would contradict the very reason `lerna.json` (not `workspaces`) enumerates Changesets packages; each remote gains a new federated `./version` export, dynamically imported by the shell's About modal and raced against a timeout — a remote predating this change must degrade silently, never block or throw the modal, the reusable rule for every future shell↔remote seam (see docs/adr/0030-suite-version-generated-file-federated-export.md)
- [0031] Employee address is an `auth`-owned identity/profile attribute, stored in a 1:1 `employee_address` table — an explicit, reasoned departure from ADR-0023 (which kept refund-domain data out of `auth`); the boundary test is "attribute of the person vs. data about a domain transaction"; `NOT NULL` on the 1:1 table expresses the all-four-or-none required-component group, `formatted` is derived on read and never stored (ADR-0013/ADR-0019 lineage); the admin gate reuses the existing `admin` role / `requireAdmin` with NO new catalog permission — the deliberate counterpoint to ADR-0028 (see docs/adr/0031-employee-address-auth-identity-attribute-1to1-table.md)
- [0032] Google Places API (New) is called browser-direct from admin-ui with a referrer-restricted key — never proxied through `auth` (identity service must never carry a third party's latency on the suite's critical path); a federated remote's referrer restriction must list the SHELL's origin, not the remote's own; use `locationBias` for regional preference, never `includedRegionCodes` (a restriction, would violate AC-2.4); silent graceful degradation is the standing posture for every optional third-party enrichment in the suite (see docs/adr/0032-google-places-browser-direct-referrer-restricted-key.md)
- [0033] The suite runs TWO tiers of audit assurance: Tier 1 (DB-level immutable trigger, ADR-0018/0024/0027) for financial/governance records, Tier 2 (application-level only) for `auth`'s `audit_log` — decided by the user at specs/012's plan gate (2026-08-04) when address changes extended `audit_log` to personal data; AC-5.2 was amended to match the code, not the reverse; regression tripwire is `auth/src/authz/audit-immutability.contract.test.ts` (test/fixture teardown exempt); raising `audit_log` to Tier 1 requires first dropping `AuditLog.actorUserId`'s `ON DELETE SET NULL` FK (an FK-initiated SET NULL is an UPDATE a BEFORE UPDATE trigger would abort, silently turning SetNull into Restrict) plus reworking six test/fixture teardown paths — do not assume ADR-0018's "reusable pattern" extends to `audit_log` (see docs/adr/0033-two-tier-audit-assurance-auth-audit-log-application-level.md)
- [0034] The shell may own identity-scoped, non-tool screens — a new un-gated `/account` route ("My profile"), child of `shellRoute` with no `beforeLoad` guard and absent from `TOOLS`, extends ADR-0006's "shell owns chrome + session" and mirrors ADR-0009's `/notify` placement; the rule: any screen every signed-in user must reach regardless of app-access grants belongs in the shell, never a gated remote (see docs/adr/0034-shell-identity-scoped-non-tool-screens-account-route.md)
- [0035] Third-party app-access lookup (`auth POST /authz/app-access-check`) is a decision endpoint, not a fact endpoint, on the forwarded-caller-JWT model — returns `{eligible}` only (both negative causes byte-identical), caller-gated on holding `(appId,"access")`, equalised query path + dual response floors + the suite's first rate limiter; an internal shared token was explicitly rejected (unattributable, un-rate-limitable, new secret on the identity service) (see docs/adr/0035-third-party-app-access-decision-endpoint-forwarded-jwt.md)
- [0036] Record-level sharing (per-record ACL) is a new access primitive owned by the resource server that owns the record — `estimai-api`'s `estimate_collaborator` table, never expressed in `auth`'s catalog; the rule: role/attribute rules live in `auth` (ADR-0007/0014), per-record grants live in the owning app; `estimai-api` deliberately does NOT become an authorization-enforcing resource server and keeps no hard runtime dependency on `auth` for its read/write path (see docs/adr/0036-record-level-acl-resource-server-owned-access-primitive.md)
- [0037] Denial taxonomy for shared records narrows ADR-0005's blanket "not owned = 404" — 403 (`insufficient_access`/`owner_only`) when a relationship exists but the level is insufficient, 404 only when no relationship exists at all; mirrors ADR-0014's capability-vs-record split, second deliberate exception to ADR-0005 after ADR-0026's self-approval 403 (see docs/adr/0037-denial-taxonomy-shared-records-403-vs-404.md)
- [0038] Optimistic concurrency via integer `version` + REQUIRED `If-Match`/`ETag` CAS on every `estimai-api` write — **amends ADR-0004**, superseding its accepted last-write-wins posture (persistence shape itself — JSONB document, size guard, deep-equal fidelity — is untouched); `updatedAt`-as-precondition and an opaque content-hash ETag were rejected on correctness/cost grounds; absent/malformed precondition → 428, mapped to the same "reload" UX as 409 (see docs/adr/0038-optimistic-concurrency-version-if-match-cas-amends-0004.md)
- [0039] Display identity for a shared estimate's owner/collaborators is resolved LIVE from `auth POST /authz/users/identities` (id-keyed, ≤100, no email/search) by `estimai-api`, never denormalised — the only way to satisfy AC-10.5's "never stale identity implying an active account"; fails SOFT to `status:"unknown"`, in explicit, named contrast to ADR-0035's fail-CLOSED authorization path in the same service (see docs/adr/0039-live-identity-resolution-by-id-fail-soft.md)
- [0040] `estimai-api` becomes the THIRD holder of `NOTIFY_INTERNAL_TOKEN` (after `auth`, `refund-api`/ADR-0017) for collaborator grant/removal push — ADR-0011's "second internal caller" escalation trigger fires again and is again deferred (reuse over a 4-service `aud`/`scope` coordination effort), but this ADR commits to a HARD STOP: a fourth internal caller, or any suspected leak, builds ADR-0011's Option C (scoped self-issued service JWTs) rather than deferring again (see docs/adr/0040-estimai-api-third-notify-internal-token-holder.md)
