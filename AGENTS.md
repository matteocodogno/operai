# Operai

Internal toolsuite by **wellD** (wellD.ch) for AI-assisted software consulting and
back-office workflows. Seven tools ship today, composed into one suite by a
Module Federation shell (ADR-0006):

| Tool | Route | What it does |
|---|---|---|
| **EstimAI** | `/estimai` | Software effort estimation — PERT + AI productivity modelling (tool #1) |
| **Refund** (Rimborsi) | `/refund` | Expense reimbursement — requests, review/decision, monthly batch payout |
| **Admin** | `/admin` | Roles, departments, users, permissions, invitations, mileage rates |
| **Inventory** | `/inventory` | Hardware register — assets, assignment to employees (confirmed by the employee), depreciation ledger, fiscal-year close, invoice files (specs/015) |
| **CRM** | `/crm` | Companies, contacts, deals through a stage pipeline, activities and follow-up tasks (specs/017, ADR-0052) |
| **Meetings** | `/meetings` | Record (browser), upload or paste a meeting; EU transcription, summaries from editable templates and cited Q&A; linkable to a host record such as a CRM deal; audio kept 29 days (specs/021, ADR-0058–0068) |

Those six are the entries in `shell/src/lib/tools.ts` — access-gated remotes. The
notification center (`notify-ui`) is a further remote but **not** a `TOOLS` entry: it mounts at
the shell-owned `/notify` route, reached from the header bell (ADR-0009). `inventory-ui` also
exposes a second, UNGATED entry, `./MyDevices`, mounted at the shell-owned `/devices` route
(any signed-in user sees their own devices; ADR-0045). `meetings-ui` does the same with
`./MyMeetings` at `/my-meetings` (a participant can always read what was captured about them;
ADR-0058) and exposes a coarse `./HostMeetings` panel that a host app (today the CRM deal page)
embeds through the shell's `HostExtension` seam with a timeout and an error boundary (ADR-0060).

Backed by seven Bun services: `auth` (identity + authorization), `estimai-api`,
`notify-api`, `refund-api`, `inventory-api`, `crm-api`, `meetings-api`.

**Tagline:** *AI tools built by craftspeople, for craftspeople.*

---

## Project structure

```
operai/
├── estimai-ui/          # EstimAI tool — federated remote (React + Vite)
│   ├── src/
│   │   ├── components/              # ActivityTable, SummaryTable, MetricsBar, ParametersPanel,
│   │   │                            # Header, HelpDrawer, CollaboratorsDialog, ConflictBanner,
│   │   │                            # ImportOfferModal, TemplatePicker, …
│   │   ├── context/
│   │   │   └── EstimatorContext.tsx # Global state + persistence
│   │   ├── federation/              # Remote type declarations + test stubs (the `exposes` map —
│   │   │                            # App root + `./version`, ADR-0030 — lives in vite.config.ts)
│   │   ├── hooks/
│   │   │   ├── useEstimator.ts      # All estimation computation logic
│   │   │   └── useImportOffer.ts    # One-time localStorage → estimai-api import offer
│   │   ├── lib/                     # api (apiFetch interceptor), authClient, estimatesApi,
│   │   │                            # collaboratorsApi, identity, pdfExport, ganttChart,
│   │   │                            # healthWarnings, pert, projects, templates, …
│   │   ├── pages/                   # EstimatesPage, EstimatePage
│   │   ├── router.tsx               # TanStack Router
│   │   ├── strings.ts               # UI copy — no hardcoded strings in components
│   │   ├── types.ts                 # Shared TypeScript interfaces
│   │   ├── EstimatorApp.tsx         # Top-level layout + state + XLSX export
│   │   └── main.tsx                 # Standalone dev entry only — production mounts via the shell
│   ├── package.json     # NOTE: no e2e here — every estimai journey lives in shell/e2e/ (see below)
│   └── vite.config.ts
│
├── shell/               # Suite host (Module Federation) — shared chrome + session; mounts remotes (specs/003, ADR-0006).
│   │                    # Also owns identity-scoped non-tool screens: /account (ADR-0034), /notify (ADR-0009),
│   │                    # the notification bell + SSE manager + ToastHost, and the About modal (ADR-0030).
│   └── e2e/             # Playwright e2e for the WHOLE suite — every remote's journeys run through the
│                        # host, since a remote has no standalone authed bootstrap (specs/003 retired
│                        # estimai-ui/e2e/ when it became a federated remote). helpers/: adminSession,
│                        # seedSession, estimaiFixtures, inviteFixtures, refundFixtures
├── refund-ui/           # Reimbursement tool — federated remote: expense requests, accounting review/decision,
│                        # monthly batch compile/pay (specs/007, 008)
├── admin-ui/            # Admin tool — federated remote: roles/departments/users/permissions/invitations GUI
│                        # (specs/004, 006, admin-only) + audit log, employee address (specs/012, ADR-0031/0032)
│                        # and the mileage-rate screen, which calls refund-api directly (specs/009, ADR-0023),
│                        # and the waiting list: access requests from allowed-domain colleagues without an invitation, approved into an invitation or dismissed (specs/023, ADR-0071/0072)
├── notify-ui/           # Notification center — federated remote: the /notify page, reached from the header bell (specs/005, ADR-0009)
├── inventory-ui/        # Inventory tool — federated remote (port 5178): exposes ./App (gated, /inventory), ./MyDevices
│                        # (ungated, /devices; ADR-0045) and ./version; calls inventory-api and auth's user directory
│                        # through shell/session (no VITE_* of its own) (specs/015)
├── crm-ui/              # CRM tool — federated remote (port 5179): exposes ./App (gated, /crm) and ./version; calls
│                        # crm-api and auth's user directory through shell/session (specs/017, ADR-0052/0053)
├── meetings-ui/         # Meetings tool — federated remote (port 5180): exposes ./App (gated, /meetings), ./MyMeetings
│                        # (ungated, /my-meetings; ADR-0058), ./HostMeetings (panel embedded by hosts via shell/extensions,
│                        # ADR-0060) and ./version; calls meetings-api and auth's user directory through shell/session
│                        # (specs/021)
├── operai-ui/           # @operai/ui — the DESIGN SYSTEM (ADR-0050): tokens/themes/fonts + component classes
│                        # (src/styles/tokens.css, re-exported by shell/tokens.css), React components (src/components),
│                        # Storybook (`mise run ui:storybook`), rules in docs/. NOT an app: never built or deployed;
│                        # apps compile its source through a Vite alias. Used by all six frontends
│
├── auth/                # Bun + Hono authentication service — invitation-only entry: sign-in creates a user only for an
│                        # allowed-domain (`ALLOWED_SIGNUP_DOMAINS`) email holding a live invitation (or the bootstrap admin, also allowed-domain only); an allowed-domain email without one joins a waiting list (`access_request`), an outside-domain one is refused (nothing recorded) (specs/023, ADR-0071/0072)
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
├── estimai-api/         # Bun + Hono + TypeScript backend — estimate persistence (specs/001, ADR-0004/0005);
│                        # + record-level collaborator ACL, optimistic concurrency, live identity resolution
│                        # (specs/013, ADR-0036/0037/0038/0039/0040)
├── notify-api/          # Bun + Hono + TypeScript backend — notification persistence + SSE push, ticket-authed stream (specs/005, ADR-0008/0009); + email delivery channel via Resend, internal /system/emails (specs/006, ADR-0011); + internal /system/notifications for cross-user push (specs/007, ADR-0017)
├── refund-api/          # Bun + Hono + TypeScript backend — reimbursement persistence; authorization-enforcing
│                        # resource server + EU object storage for receipts (specs/007, ADR-0014/0015/0016);
│                        # + batch compile/PDF/paid lifecycle (specs/008, ADR-0018–0022), mileage rates
│                        # (specs/009, ADR-0023/0024/0025), settings store (specs/011, ADR-0027/0028/0029)
├── inventory-api/       # Bun + Hono + TypeScript backend (port 8083, DB `inventory`) — hardware register; authorization-enforcing
│                        # resource server, entity-scoped (ADR-0014/0015 lineage); depreciation derived on read, closed years
│                        # snapshotted (ADR-0046); invoice files in its own EU bucket; pushes to notify-api with a scoped
│                        # service JWT (ADR-0044). scripts/import-legacy.ts = one-off register import (specs/015)
│
├── crm-api/             # Bun + Hono + TypeScript backend (port 8084, DB `crm`) — companies, contacts, deals + pipeline,
│                        # activities/tasks; authorization-enforcing (crm:access, entity-scoped deal:manage, contact:erase),
│                        # optimistic concurrency via If-Match (specs/017, ADR-0052)
├── meetings-api/        # Bun + Hono + TypeScript backend (port 8085, DB `meetings`, single replica) — meetings, transcripts,
│                        # summaries, templates, cited Q&A; authorization-enforcing (`meetings:access`, `template:manage`,
│                        # `meeting:erase`) but creator/participant reads need only a JWT (ADR-0058); audio ONLY in its own EU
│                        # bucket (`MEETINGS_S3_*`, 29-day lifecycle verified at startup, ADR-0063); in-process durable job
│                        # runner (ADR-0062); Google Cloud Chirp 3 + Claude on Vertex AI, EU (ADR-0069/0061); host contract
│                        # with crm-api (ADR-0059); pushes to notify-api as `system:meetings-api` (specs/021)
├── docs/adr/            # Architecture Decision Records (0001–0073; see ## Architecture decisions)
├── docs/ui-inconsistencies.md  # UI/UX audit across the six frontends, with what each migration fixed
├── infra/               # Deploy/verify scripts + the cross-service env contract notes (README.md);
│                        # provision-tool.sh creates/audits one tool's Railway service, Vercel project and DNS
│                        # (runbook: .claude/skills/provision-tool); meetings-bucket-policy.sh applies/verifies the audio
│                        # bucket's 29-day lifecycle rule, versioning off and CORS (specs/021)
├── tools/env-doctor/    # Pre-deploy cross-service env-contract checker (`mise run env:doctor`)
├── scripts/             # Release tooling — version.mjs (umbrella bump), tag.mjs, check-changeset.mjs
├── .github/workflows/   # changeset-check.yml, env-doctor.yml
├── compose.yaml         # Local PostgreSQL 17 (host port 5435) + MinIO (S3 :9000, console :9001)
├── lerna.json           # The package list Changesets reads — NOT a pnpm/Bun workspace (see ### Git)
├── mise.toml            # Node 24, corepack-managed pnpm; `mise run dev` / `db:migrate` / `changeset` /
│                        # `release:version` / `release:tag` / `env:doctor`
└── specs/               # Spec-driven workflow (001–021; 015 hardware-inventory, 017 crm and 021 meetings are in progress; see below)
```

---

## Tech stack

### Frontends (shell, estimai-ui, refund-ui, admin-ui, notify-ui, inventory-ui, crm-ui, meetings-ui)
All eight share one stack. Each is installed and deployed on its own (no npm workspace).

- **Runtime:** Node 24 via mise (pnpm via corepack, see `mise.toml`)
- **Package manager:** pnpm
- **Framework:** Vite 8 + React 19 (TypeScript)
- **Composition:** Module Federation (`@module-federation/vite`) — the shell is the host, the
  other seven are remotes whose URLs resolve at runtime per-env, never build-baked (ADR-0006)
- **Routing:** TanStack Router
- **Auth/session:** better-auth client; in-memory JWT + `apiFetch` interceptor, owned by
  `shell/session` and reused by every remote (ADR-0001/0002)
- **Testing:** Vitest (unit/component) per app; e2e for the WHOLE suite lives in `shell/`
  (`cd shell && pnpm e2e`) — a federated remote has no standalone authed bootstrap, so its
  journeys run through the host
- **Fonts:** DM Sans, DM Mono, Syne (Google Fonts)
- **Styling:** Tailwind CSS 4
- **Design system:** `@operai/ui` (`operai-ui/`, ADR-0050) — tokens, themes, component classes and
  React components, compiled from source by each app (Vite alias + `resolve.dedupe` + tsconfig
  `paths`; see `operai-ui/README.md`); showcased in its own Storybook 10
- **Lint/format:** ESLint 9 (flat config) + Prettier
- **Deploy:** Vercel, one project per frontend (auto-deploy on push to `main`)

estimai-ui additionally uses:
- **Tables:** TanStack Table v8; **drag & drop:** `@dnd-kit`
- **Export:** `exceljs` + `xlsx` for XLSX, `jspdf` + `jspdf-autotable` for PDF
- **Sharing:** account-based collaborators only (specs/013). The anonymous
  link share (`lz-string` payload in a URL fragment + `qrcode`) was removed on
  2026-08-09 — an estimate is never viewable without an Operai account.

admin-ui additionally calls the Google Places API (New) browser-direct with a
referrer-restricted key for address autocomplete — never proxied through `auth`, and it
degrades silently when the key is absent (ADR-0032).

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

### Resource backends (estimai-api, notify-api, refund-api, inventory-api, crm-api, meetings-api)
All six share the `auth` service's shape (see ADR-0003 — one backend stack across the monorepo;
it supersedes the earlier Kotlin/Spring intention). Five are implemented; `meetings-api` is in
progress (specs/021).

- **Runtime/framework:** Bun + Hono + `@hono/zod-openapi` (Scalar API reference)
- **Persistence:** Prisma 7 + PostgreSQL, own logical DB per service
- **Auth:** JWKS resource servers — verify the `auth` service's RS256 JWT via its JWKS
  endpoint, pinned to RS256 + issuer, and **require `AUTH_AUDIENCE`** to check the `aud`
  claim or they reject every token with 401 (ADR-0005/0010)
- **Errors:** Effect TS; RFC 7807 Problem JSON
- **Deploy:** Railway, EU region (data residency requirement)

Per-service specifics:
- `estimai-api` — estimate persistence as a JSONB document + listing columns (ADR-0004);
  record-level collaborator ACL owned by the service itself, not `auth`'s catalog (ADR-0036);
  optimistic concurrency via integer `version` + required `If-Match`/`ETag` (ADR-0038).
  It deliberately is **not** an authorization-enforcing resource server.
- `inventory-api` — hardware register (specs/015): authorization-enforcing like `refund-api`
  (live `auth GET /authz/resolve`, fails closed, entity-scoped ABAC) with `inventory:access`,
  `asset:manage`, `ledger:manage`; `/me/*` routes need only a valid JWT and scope to `sub`
  (ADR-0045); depreciation derived on read, immutable snapshots on fiscal-year close
  (ADR-0046); invoice files in its OWN EU bucket via presigned URLs (`INVENTORY_S3_*`);
  a notify caller, authenticating with a 5-minute scoped service JWT (`notifications.push`
  only) from `auth POST /system/service-token` (`SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET`;
  ADR-0044/0049). Service tokens are signed by better-auth's rotating key published at
  `/auth/jwks`, not by `JWT_PRIVATE_KEY`.
- `crm-api` — CRM (specs/017): authorization-enforcing (live `/authz/resolve`, fails closed) with
  `crm:access` (read everything, edit companies/contacts/activities), entity-scoped `deal:manage`
  (403 `out_of_scope`, not 404 — deals are readable, ADR-0052) and `contact:erase`; If-Match/ETag
  on company, contact and deal writes; owner/assignee ids checked as CRM users against `auth`
  (fail closed); money only with `deal:financials` (ADR-0054); estimates via estimai-api with
  the caller's JWT, offers and attachments in its own EU bucket (`CRM_S3_*`, specs/018); offers are contracts
  rendered from per-entity, editable templates on the entity's letterhead, numbered `NNNN/YYYY[rN]`,
  with deal PDFs appendable as annexes (specs/020, ADR-0057);
  pushes CRM notifications to notify-api as `system:crm-api`, with email notices for handovers
  (specs/019, ADR-0056); verifies meetings-api's host notices (scope `host-notices.send`,
  `aud=SERVICE_AUDIENCE`) and answers its `resolve` calls as the caller (specs/021, ADR-0059)
- `meetings-api` — Meetings (specs/021): authorization-enforcing, but content is visible by
  relationship to the record, never by role (creator / Operai participant / opted-in host reader;
  anything else 404, ADR-0058) — `selfScoped` reads need only a valid JWT and survive an `auth`
  outage, every create/generate/ask/edit is `capability(...)` live and fails closed, with
  `meetings:access` (granted to every `employee` by default, ADR-0068), `template:manage` and
  `meeting:erase` (admin only, erase never reads content); audio ONLY in its own EU bucket
  (`MEETINGS_S3_*`) behind a bucket-wide 29-day lifecycle rule that is verified at startup
  (ADR-0063); transcription by Google Cloud Speech-to-Text v2 Chirp 3 batch (`eu`) through a
  transient EU Cloud Storage bucket, long recordings in 10-minute overlapping parts, labels joined only on text evidence
  and separable by the creator, gaps detected, retried and marked (ADR-0069/0070/0071), and summaries/Q&A by Claude on Vertex AI (`eu` multi-region, never `global`),
  every setting Google exposes checked at startup and the rest a recorded sign-off (ADR-0069/0061); an
  in-process Postgres job runner for asked-for work, so it runs as a single replica (ADR-0062);
  the THIRD reader of bucket bytes, bounded (ADR-0064); model output is validated structure and
  plain text only (ADR-0067); pushes to notify-api as `system:meetings-api` (`notifications.push`)
  and notices to the host as the same principal (`host-notices.send`), ADR-0059/0065
- `notify-api` — notification persistence + ticket-authed SSE stream (ADR-0008); pinned to a
  single production instance (in-process ticket store + fan-out); email channel via Resend;
  internal `/system/emails` (scope `emails.send`) + `/system/notifications` (scope
  `notifications.push`), each behind a scoped service JWT verified via `auth`'s JWKS with
  `aud=SERVICE_AUDIENCE`; every caller authenticates as itself (`auth` mints its own in
  process, ADR-0048; `refund-api`, `estimai-api`, `inventory-api`, `crm-api` and `meetings-api`
  via the service-token endpoint) and the shared `X-Internal-Token` is refused (ADR-0049); for an
  `email: true` notification it looks the recipient's address up in `auth`
  (`POST /system/users/contact`, as `system:notify-api`, ADR-0056)
- `refund-api` — the suite's authorization-enforcing resource server: resolves the caller's
  live permissions from `auth GET /authz/resolve` on every request, fails **closed** on an
  `auth` outage (ADR-0014); entity-scoped ABAC (ADR-0015); EU-region S3-compatible object
  storage for receipts, reached only via presigned URLs (ADR-0016); DB-level append-only
  audit/rate/settings tables (ADR-0018/0024/0027)

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

Use these terms consistently in code, API contracts, and UI copy.

### EstimAI

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
| `collaborator` | A per-record grant on one estimate — `viewer` or `editor`, never `owner` |

### Refund (Rimborsi)

| Term | Meaning |
|---|---|
| `request` | One employee's reimbursement claim — the unit of review, decision and audit |
| `line` | A single expense on a request: `type`, `entity`, `currency`, amount (and `km` iff `travel_km`) |
| `status` | `draft` → `submitted` → `approved`/`rejected` → `paid` (terminal, ADR-0020) |
| `entity` | The wellD legal entity a line belongs to — `welld_it` \| `welld_ch`; drives ABAC scope (ADR-0015) |
| `batch` | A monthly payout compilation of approved requests — `compiled` \| `paid` \| `discarded` |
| `mileage rate` | Per-entity, effective-dated €/km series; a `travel_km` line snapshots it at submit (ADR-0023) |

Money is always integer minor units (cents); mileage rates are integer micros (ADR-0025).

### Identity & authorization (auth)

| Term | Meaning |
|---|---|
| `permission` | A `(resource, action)` pair from the per-app catalog, e.g. `request:approve` |
| `role` | A named bundle of permissions, optionally attribute-conditioned |
| `department` | An org grouping used to assign roles in bulk |
| `access` | The `(appId, "access")` permission that gates whether a tool appears at all |
| `perm_epoch` | JWT claim bumped on any grant change — forces live permission re-resolution (ADR-0007) |
| `invitation` | A pending email-matched grant; `expired` is derived on read, never written (ADR-0013) |
| `service client` | A non-user principal in `auth`'s `SERVICE_CLIENTS` that mints a scoped service JWT (`sub="system:<id>"`, `aud=SERVICE_AUDIENCE`, scope `notifications.push`, `emails.send`, `users.contact` and/or `host-notices.send`); today `refund-api`, `estimai-api`, `inventory-api`, `crm-api`, `meetings-api` and `notify-api` (`auth` mints its own in process and may not be a client, ADR-0048/0049) |

### Inventory (specs/015)

The authoritative glossary is `specs/015-hardware-inventory/spec.md` § Domain language.

| Term | Meaning |
|---|---|
| `asset` | One physical hardware unit owned by one `entity` — never a quantity (13 monitors = 13 assets) |
| `holder` | The Operai account an asset is assigned to; no holder = company stock |
| `status` | `ordered` · `in_stock` · `assigned` · `in_repair` · `lost` (still on the books) · `disposed` (off the books) |
| `assignment` | `pending` until the employee confirms receipt, then `confirmed`/`declined`/`cancelled` |
| `depreciation rule` | Per-entity, effective-dated parameters (life, first-year share, threshold, residual); resolved on read (ADR-0046) |
| `fiscal year` | Calendar year per entity, `open` or `closed`; closing is irreversible and snapshots the figures |
| `roll-forward` | Opening book value − disposals + purchases − depreciation = closing book value |

Capabilities: `inventory manager` = `asset:manage`, `hardware accountant` = `ledger:manage`.

### Meetings (specs/021)

The authoritative glossary is `specs/021-meetings/spec.md` § Domain language.

| Term | Meaning |
|---|---|
| `meeting` | One conversation captured in Operai: metadata, one source, a transcript, any number of summaries, and each participant's private Q&A history |
| `creator` | The one Operai user who created the meeting; a meeting whose creator is deactivated is frozen, not orphaned |
| `participant` | An Operai participant (an active account) or an external participant (a name, never an account) |
| `host` | An Operai app that lists and starts meetings about its own records (today CRM, entity type `deal`); a host reference is `{app, entityType, entityId}`, at most one per meeting |
| `host notice` | The content-free message (id, event, creator, per-meeting `seq`) a host that opted in receives when a linked meeting is linked, changed, relinked, unlinked or deleted (ADR-0059) |
| `source` | `recorded` (browser), `uploaded` (a file) or `text` (typed/pasted) — exactly one per meeting |
| `audio` | The only thing in the bucket; kept until 29 days after creation, then deleted by the bucket's lifecycle rule (ADR-0063) |

---

## API contract (estimai-api)

Local base URL `http://localhost:8080`. The authoritative contracts are
`specs/001-estimate-persistence/plan.md` and `specs/013-estimate-sharing/plan.md`; each
service also serves its live OpenAPI document + Scalar reference. Estimates are persisted
as **whole documents** (JSONB); granular release/activity sub-resource endpoints remain an
explicit non-goal.

```
POST   /estimates                                  Create a new estimate
GET    /estimates                                  List estimates the caller owns or collaborates on
GET    /estimates/{id}                             Get the full estimate (returns an ETag)
PUT    /estimates/{id}                             Update in place — REQUIRES If-Match (ADR-0038)
DELETE /estimates/{id}                             Delete (owner only)
POST   /estimates/import                           One-time bulk import of legacy localStorage estimates

GET    /estimates/{id}/collaborators               List collaborators (+ live display identity)
POST   /estimates/{id}/collaborators               Grant access by email (owner only)
PATCH  /estimates/{id}/collaborators/{collabId}    Change access level (owner only)
DELETE /estimates/{id}/collaborators/{collabId}    Revoke access (owner only)
DELETE /estimates/{id}/collaborators/me            Leave a shared estimate
```

Authentication: RS256 JWT issued by the `auth` service, verified via its JWKS endpoint with
the `aud` claim enforced (ADR-0010). Access is the caller's ownership **or** a row in the
service's own `estimate_collaborator` ACL (ADR-0036). Denials follow ADR-0037: **403** when a
relationship exists but the level is insufficient (`insufficient_access` / `owner_only`),
**404** only when no relationship exists at all. Writes without a valid precondition are
**428**; a stale one is **409** — both map to the same "reload" UX. A per-estimate size guard
rejects over-large payloads (413). Owner/collaborator display names are resolved live from
`auth POST /authz/users/identities` and fail **soft** to `status:"unknown"` (ADR-0039).
Errors are RFC 7807 Problem JSON; dates are ISO 8601.

Other services' contracts: `inventory-api` — `specs/015-hardware-inventory/plan.md` § API
contracts (capability × route matrix: 403 capability-absent, 404 out of scope; `/me/*` needs only
a valid JWT) plus its live OpenAPI/Scalar at `http://localhost:8083`; `auth`'s additions for it
(`POST /system/service-token`, `GET /authz/users/directory`) are in the same section.

---

## Data residency

wellD operates across Italy and Switzerland. Some clients are in regulated sectors
(energy, finance, healthcare). Apply these rules:

- Every backend **must** deploy to an EU region (Railway EU, Fly.io fra, Azure Switzerland North)
- Object storage is EU too — `REFUND_S3_REGION` / `INVENTORY_S3_REGION` (or, for a non-AWS
  endpoint, the `*_S3_EU_ENDPOINT_HOSTS` allowlist) are validated at startup and the process
  exits if it fails (ADR-0016); inventory has its own bucket, never refund's
- Meetings handles the most sensitive content in the suite (recorded conversations), so EVERY hop
  is EU/CH and checked at startup, the process exiting if one fails (ADR-0061, AC-4.9): its own
  audio bucket (`MEETINGS_S3_*`, never another tool's), transcription by Google Cloud Speech-to-Text
  v2 (Chirp 3, location `eu` only), summaries and Q&A by Claude on Vertex AI through the `eu`
  multi-region endpoint (`global`, `us` and London are refused; Claude Fable/Mythos excluded), and a
  transient Google Cloud Storage bucket in an EU/CH location that holds audio only while a
  transcription attempt runs (reached through its regional endpoint; 1-day lifecycle rule, soft delete
  0, versioning off and public access prevention verified at startup; deleted at attempt start, in
  `finally` and on explicit deletion, ADR-0069). A setting Google exposes (bucket rules, Vertex cache
  and request logging) that cannot be read is a refusal; one it does not expose (Speech data logging,
  contract type, Advanced AI consent) is a recorded go-live sign-off. Known, user-accepted exception
  (2026-11-05): Google may keep the async transcript result for about 5 days. `MEETINGS_AI_PROVIDER=fake`
  is refused in production. Audio is deleted by a bucket-wide 29-day lifecycle rule with versioning
  off (a missing or prefix-filtered rule, `Days > 29` or versioning Enabled stops the start,
  ADR-0063); set and prove it with `infra/meetings-bucket-policy.sh`. Transcripts and summaries live
  in Postgres until the meeting is deleted; database backups keep deleted content for the backup
  retention period (open item R7 in specs/021). Provider DPAs are a go-live sign-off (plan O3)
- No business data should be logged by the hosting provider beyond standard access logs
- Frontends are purely client-side — they transmit data only to the suite's own services
  (and, for admin-ui, address text to Google Places; ADR-0032). meetings-ui sends microphone audio
  only to the meetings bucket by presigned POST and never to a third party; the browser never
  holds a provider key

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
- A pre-commit hook runs betterleaks; reviewed placeholders (test DB URLs, compose defaults, example keys) are allowlisted by fingerprint in `.betterleaksignore`
- **Versioning & releases: [Changesets](https://github.com/changesets/changesets), independent per-app SemVer + an aggregate `operai` umbrella version** (see `.changeset/README.md`). Each app (`@operai/auth`, `@operai/refund-ui`, …) is versioned on its own; the root `operai` version is bumped by the **largest** per-app bump in each release. Flow (all local, `mise`-driven): when a feature lands, record intent with **`mise run changeset`** (pick the affected app(s) + patch/minor/major, commit the `.changeset/*.md` with the feature — a cross-app change selects BOTH apps in one changeset, since the apps aren't npm-linked). To release: **`mise run release:version`** (applies pending changesets → per-app version bumps + `CHANGELOG.md`, then the umbrella `operai` bump + root `CHANGELOG.md`; commit these), then **`mise run release:tag`** (per-app `@operai/x@a.b.c` + `operai@a.b.c` git tags) and `git push --follow-tags`. Nothing is published to npm (all apps are `private`). Run `pnpm install` at the repo **root** once so `@changesets/cli` is available. The package list Changesets enumerates lives in **`lerna.json`** (`version: independent`), NOT in a root `package.json` `workspaces` field or a `pnpm-workspace.yaml` — because this is a **mixed pnpm (frontends) + Bun (backends) monorepo**: pnpm honors `pnpm-workspace.yaml` and Bun honors `package.json` `workspaces`, so either would make a package manager try to treat all apps as one workspace and break the per-app installs / Vercel + Railway deploys. **Neither** pnpm nor Bun reads `lerna.json`, but Changesets/@manypkg does — so per-app installs and deploys stay completely untouched.

### Frontend
- **All files must be TypeScript** (`.ts` or `.tsx`) — never create `.js` or `.jsx` files
- Computation logic belongs in a hook or `lib/` module — in estimai-ui specifically, in
  `useEstimator.ts`; never in components
- Components receive data and callbacks as props; they do not compute
- CSS variables defined in the root `<style>` block in `EstimatorApp.tsx`; do not add
  external CSS files unless introducing a proper CSS module setup
- All numbers displayed to the user must be rounded (`.toFixed()` or `Math.round()`)
- **Building or changing any screen (page, dialog, form, list, table) in any frontend: FIRST load
  `operai-ui/docs/building-pages.md`** (the procedure, step by step) **and
  `operai-ui/docs/design-system.md`** (the rules it points to: tokens, which colours may be text,
  button variants by meaning, dialogs, forms, states, a11y). Then read `operai-ui/src/index.ts` for
  what exists. Working examples of each page type: Storybook § Pages
  (`operai-ui/src/pages/`, a generic example tool).
- Use `@operai/ui` components (`Button`, `ConfirmDialog`, `FormDialog`, `Field`, `DataTable`,
  `PageHeader`, `Banner`, `StatePanel`, …) instead of writing markup; never copy a component from
  another app. A pattern a second app needs goes INTO the library, with a story and a test. All six
  frontends use the library; a new tool wires it up before its first screen (Vite alias,
  `resolve.dedupe`, tsconfig `paths` — see `operai-ui/README.md`)
- **One styling dialect (ADR-0051):** colours and fonts are Tailwind token utilities (`text-soft`,
  `bg-ink-mid`, `border-rule`, `bg-org/10`, `font-mono`); never `var(--…)` in TS/TSX, never a colour
  in `style`, never an arbitrary colour class (`text-[#…]`) — ESLint rejects all three in every app.
  A status → colour map holds complete class strings. Inline `style` only for runtime values
  (width, position). A new colour is a new token in `operai-ui/src/styles/tokens.css`
- Never restyle colour, border or radius of a library component or `.btn`; never use `--muted` for
  text a user must read (it fails WCAG AA)
- Library components take every user-visible string as a prop — copy stays in the app's strings module
- **Copy and language (INC-24/25):** every user-visible string lives in the app's strings module as an
  `en` catalog plus a complete `it: typeof en`, exported via `selectStrings({ en, it })`; each app tests
  parity (`catalogGaps`) and scans every `.tsx` for hardcoded copy. The shell sets `<html lang>` once at
  startup; never detect the language in an app. Sentence case everywhere
- **Format and icons:** dates/amounts/numbers only through the library formatters (`formatDate` dd.mm.yyyy,
  `formatMoney(cents, currency)`, `formatNumber`); statuses through `StatusBadge` with the app's one
  domain→meaning map; icons only through `Icon` — never an emoji or a Unicode glyph as an icon
- Authenticated backend calls go through `apiFetch` (`src/lib/api.ts`, or `shell/session`'s
  for the other remotes) — it attaches the Bearer JWT to trusted origins only and handles the
  401 refresh-retry-redirect (ADR-0001)
- A remote owns no auth guard and no chrome — the shell does (ADR-0006). Any screen every
  signed-in user must reach regardless of app-access grants belongs in the shell (ADR-0034)
- Every remote exposes `./version` for the shell's About modal; a shell↔remote seam must
  degrade silently when a remote predates the export, never block or throw (ADR-0030)

### Backend services (auth, estimai-api, notify-api, refund-api, inventory-api — Bun + Hono)
- Validate all environment variables at startup (`src/lib/env.ts`); `process.exit(1)` on missing
- Routes grouped by feature directory, registered in `src/index.ts`; OpenAPI in `src/openapi/`
- Database access only through the Prisma client in `src/lib/db.ts`
- Prisma migrations — never modify existing migration files
- Return RFC 7807 Problem JSON for all error responses (global `app.onError`/`app.notFound`)
- Money is stored and computed in integer minor units — never `Decimal`, never float; round
  exactly once, at compute time, with one canonical rule (ADR-0025)
- Derived lifecycle state (expiry, orphan reconciliation, PDF regeneration) is computed
  on read, never written by a cron or queue sweep (ADR-0013/0016/0019)
- When adding a cross-service env var, update `tools/env-doctor`'s manifest — it is the
  contract, and CI checks it (`.github/workflows/env-doctor.yml`)

### All services
- No hardcoded strings that appear in the UI — use constants (e.g. `src/strings.ts`) or i18n
  from day one; the suite needs Italian and English at minimum. `estimai-ui` enforces this
  with a `noHardcodedStrings` test.
- Dates and durations always in ISO 8601 in API contracts; display formatting is a UI concern

---

## Running locally

### The whole suite (preferred)
```bash
mise run db:migrate   # once: Postgres up + Prisma migrations for every backend (meetings included)
mise run dev          # everything, with HMR — opens http://localhost:5173 (the shell) once it answers;
                      # OPERAI_NO_OPEN=1 skips the browser
mise run dev:web      # frontends only (backends already running elsewhere)
mise run dev:preview  # frontends build+preview — no HMR, mirrors the deploy shape
```

Ports: auth `3001`, estimai-api `8080`, notify-api `8081`, refund-api `8082`, inventory-api `8083`,
crm-api `8084`, meetings-api `8085`, shell `5173`, estimai-ui `5174`, refund-ui `5175`, notify-ui `5176`,
admin-ui `5177`, inventory-ui `5178`, crm-ui `5179`, meetings-ui `5180`; MinIO S3 `9000`
(console `9001`). Frontend ports are pinned in each app's `vite.config.ts`.

Prereqs (once): direnv installed and each `.envrc` allowed (`direnv allow auth`, likewise
`estimai-api`, `notify-api`, `refund-api`, `inventory-api`, `crm-api`, `meetings-api`, `admin-ui`), 1Password CLI signed in, and
`ENABLE_TEST_AUTH=true` for a seeded local session. `mise run dev` invokes `direnv exec`
explicitly — direnv's shell hook does not fire for a non-interactive mise task. Meetings runs against
fake transcription/LLM providers locally (`MEETINGS_AI_PROVIDER=fake`, refused in production) until
the Google Cloud project is provisioned (ADR-0069).

### Database + object storage (shared)
```bash
docker compose up -d postgres minio minio-createbucket   # PostgreSQL 17 :5435, MinIO :9000
```

`minio-createbucket` also creates the private `meetings` bucket with the 29-day expiration rule and
versioning off, which meetings-api checks at startup (ADR-0063). Verify it (needs the AWS CLI and `jq`;
the default MinIO dev credentials):

```bash
MEETINGS_S3_ACCESS_KEY_ID=minioadmin MEETINGS_S3_SECRET_ACCESS_KEY=minioadmin \
  infra/meetings-bucket-policy.sh --check --endpoint http://localhost:9000 --bucket meetings --path-style
```

### A single frontend
```bash
cd estimai-ui        # or shell / refund-ui / admin-ui / notify-ui / inventory-ui / crm-ui / meetings-ui
pnpm install
pnpm dev              # standalone; a remote still needs the shell for an authed session
pnpm lint             # ESLint
pnpm build            # tsc -b + vite build (typecheck happens here)
pnpm test             # vitest
```

The shared design system (`operai-ui/`) is not an app; it has its own checks and Storybook:

```bash
mise run ui:storybook   # http://localhost:6006 — components, foundations, page compositions, both themes
mise run ui:check       # library typecheck/lint/tests/Storybook build + build & test of every consumer
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

### Resource backends (estimai-api :8080, notify-api :8081, refund-api :8082, inventory-api :8083, crm-api :8084, meetings-api :8085)
Same shape as the auth service (Bun + Hono + Prisma, own logical DB, own `.envrc`):
`bun install`, `bun run db:migrate`, `bun run dev`. See **### Resource backends** under
Tech stack for what each one is; `REFUND_S3_*` / `INVENTORY_S3_*` / `MEETINGS_S3_*` point at local MinIO in dev
— check `infra/README.md` for the deployed-environment state and the inventory rollout checklist.

The one-off legacy register import is a script, dry-run by default (see `infra/README.md`
§ Legacy register import — `--apply` additionally needs `--expected-opening-cents`):

```bash
cd inventory-api
bun scripts/import-legacy.ts --file <register.xlsx>                                         # dry run
bun scripts/import-legacy.ts --file <register.xlsx> [--user-map <users.json>] \
  --expected-opening-cents <cents> --apply                                                    # writes
```

### Checking the env contract before a deploy
```bash
mise run env:doctor -- --env production --dir ./resolved   # one <service>.env per service
mise run env:doctor                                        # the production templates (what CI runs)
mise run env:doctor -- --env local                         # this machine: each <service> dotenv file + what direnv resolves
```

### Before pushing
```bash
mise run changeset:check   # local parity with CI — did this branch's app-code change get a changeset?
```

---

## Operai suite — future tools

Shipped today: **EstimAI**, **Rimborsi** (refund), **Admin**, **Notify**, **Inventory**, **CRM**, **Meetings** — see the table at
the top. Still on the roadmap, not yet built:

| Tool | Purpose |
|---|---|
| **ReviewAI** | AI-assisted code and architecture review checklists |
| **RetroAI** | Sprint retrospective facilitation and pattern detection |
| **ProposAI** | Consulting proposal drafting from project briefs |

All tools share the Operai design system, `@operai/ui` (DM Sans / DM Mono / Syne, dark ink palette, purple AI accent).
A new tool is a federated remote mounted by the shell (ADR-0006), gated by an `(appId, "access")`
grant in `auth`'s catalog (ADR-0007), and — if it owns data — a JWKS resource server of its own
(ADR-0005/0010).

---
<!-- VERCEL BEST PRACTICES START -->
## Best practices for developing on Vercel

These defaults are optimized for AI coding agents (and humans) working on apps that deploy to Vercel.

- Treat Vercel Functions as stateless + ephemeral (no durable RAM/FS, no background daemons), use Blob or marketplace integrations for preserving state
- Edge Functions (standalone) are deprecated; prefer Vercel Functions
- Don't start new projects on Vercel KV/Postgres (both discontinued); use Marketplace Redis/Postgres instead
- Store secrets in Vercel Env Variables; not in git or `NEXT_PUBLIC_*`
- Provision Marketplace native integrations with `vercel integration add` (CI/agent-friendly)
- Sync env + project settings with `vercel env pull` / `vercel pull` when you need local/offline parity
- Use `waitUntil` for post-response work; avoid the deprecated Function `context` parameter
- Set Function regions near your primary data source; avoid cross-region DB/service roundtrips
- Tune Fluid Compute knobs (e.g., `maxDuration`, memory/CPU) for long I/O-heavy calls (LLMs, APIs)
- Use Runtime Cache for fast **regional** caching + tag invalidation (don't treat it as global KV)
- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET
- Use Vercel Blob for uploads/media; Use Edge Config for small, globally-read config
- If Enable Deployment Protection is enabled, use a bypass secret to directly access them
- Add OpenTelemetry via `@vercel/otel` on Node; don't expect OTEL support on the Edge runtime
- Enable Web Analytics + Speed Insights early
- Use AI Gateway for model routing, set AI_GATEWAY_API_KEY, using a model string (e.g. 'anthropic/claude-sonnet-4.6'), Gateway is already default in AI SDK
  needed. Always curl https://ai-gateway.vercel.sh/v1/models first; never trust model IDs from memory
- For durable agent loops or untrusted code: use Workflow (pause/resume/state) + Sandbox; use Vercel MCP for secure infra access
<!-- VERCEL BEST PRACTICES END -->
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
- [0011] notify-api email as a second delivery channel — a new `email` channel (raw address, Resend, bilingual) sits alongside the existing `inApp` (`sub`) channel; `auth` triggers sends via `POST /system/emails`, deliberately NOT a user JWT/JWKS path (ADR-0005); fixed escaped templates; the original service-to-service trust is superseded by 0049 (see docs/adr/0011-notify-api-email-channel-service-trust.md)
- [0012] Invitation activation via two better-auth hooks + soft-delete lifecycle — `user.create.after` matches a pending invite by OAuth-**verified** email (new users only); `session.create.before` blocks/re-activates a soft-deleted user's return sign-in; deletion is soft (`deletedAt`) with a synchronous session-revocation + `perm_epoch` bump cascade, resource servers untouched at delete time; the **accepted residual-JWT window** (a deleted user's already-issued short-lived JWT stays valid until it expires) is a deliberate ADR-0005-preserving trade-off, with a resource-server liveness/epoch check named as the escalation path (see docs/adr/0012-invitation-activation-hooks-soft-delete-lifecycle.md)
- [0013] Invitation lifecycle expiry is derived, not scheduled — `expired` = `status=='pending' && expiresAt<=now`, computed on read, never written by a background job; reconcile-on-write flips stale `pending` rows before insert so the `email WHERE status='pending'` partial-unique index never blocks a fresh invite for a dead address; do not add a cron/queue expiry sweep for this or similar future lifecycle features (see docs/adr/0013-invitation-lifecycle-derived-expiry-state.md)
- [0014] refund-api is the suite's first authorization-enforcing resource server — a new Bearer-authed `auth GET /authz/resolve` (forwards the caller's already-verified JWT, no new secret) is resolved via `refund-api`'s `authzMiddleware`, cached in-process by `(sub, perm_epoch)` with a 30s TTL backstop; capability-absent denials are 403, record-level ownership/entity failures are 404 (ADR-0005-style, no existence leak); an `auth` outage fails **closed** (503), never open — realizes ADR-0007's explicitly deferred resource-server side (see docs/adr/0014-refund-api-authorization-enforcing-resource-server.md)
- [0015] Entity-scoped ABAC in refund-api evaluates specs/004's entity condition at **request** level — "at least one line's entity matches the caller's `user.entity`" — never per-line; "global" review scope is composed via the resolver's pre-existing widest-wins union (no `accounting-global` role is seeded); approve/reject/set-approved-total always apply **whole-request**, even across an out-of-scope line (see docs/adr/0015-entity-scoped-abac-refund-api.md)
- [0016] Refund receipt attachments live in EU-region S3-compatible object storage, reached only via presigned URLs (policy-capped ≤10 MiB, `pdf`/`jpeg`/`png` POST; ~60s authz-gated GET) — never proxy file bytes through refund-api; two-phase `pending`→`confirm` upload, orphans reconciled on read (only `stored` ever surfaced), no cron (ADR-0013 posture); `REFUND_S3_REGION` is validated against an EU allowlist at startup (see docs/adr/0016-eu-object-storage-refund-attachments.md)
- [0017] notify-api gains `POST /system/notifications` (mirrors ADR-0011's `/system/emails`) for cross-user in-app push, activating ADR-0009's reserved `recipient` seam for refund-api's decision notifications; best-effort, never rolls back the decision; the user-JWT `POST /notifications` stays strictly self-only (OWASP A01); the caller authentication is superseded by 0049 (see docs/adr/0017-system-notifications-cross-user-trigger.md)
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
- [0040] `estimai-api` pushes collaborator grant/removal notifications through notify-api's `/system/notifications`, best-effort; its caller authentication is superseded by 0049, which built the scoped service credentials this ADR committed to (see docs/adr/0040-estimai-api-third-notify-internal-token-holder.md)
- [0041] Typed-query autocomplete matches CLIENT-SIDE over a server-projected, pre-ranked personal corpus — `refund-api`'s parameterless `GET /line-suggestions` ships the whole ranked corpus once per composing session and the typed motivo text NEVER leaves the browser, making "no new log/store of motivo text" true by construction and leaving no caller-controlled selector to attack (no IDOR, no injection surface); corpus is memory-only + `Cache-Control: no-store` (ADR-0001 extended from the JWT to personal data) and derived on read with no trip table and no cron (ADR-0013); text folding lives in application code mirrored api/ui with shared canonical vectors (ADR-0025) — never a Postgres `unaccent`/FTS/`pg_trgm` dependency; the server still fails closed (ADR-0014) while only the client degrades silently (ADR-0032); escalate to a per-query endpoint if the 200-signature cap needs raising, the corpus stops being per-user, or ranking becomes query-dependent (see docs/adr/0041-client-side-autocomplete-server-projected-corpus-app-code-folding.md)
- [0042] A derived projection over data an existing grant ALREADY authorises reuses that gate — the new route is gated on the existing `request:read` with zero `auth`/catalog/seed change, via the **reconstructibility test** ("could a holder of the existing grant rebuild this output by hand? then a new permission withholds nothing and lies about a control that does not exist"), the third branch after ADR-0028 (different subject → mint) and ADR-0031 (same authority + subject → reuse); the handler **ignores the grant's conditions entirely** and scopes unconditionally to the verified JWT `sub`, so ADR-0007's widest-wins union can never widen a self-scoped personal-data read (an unconditioned `request:review` holder still gets only their own lines) and ADR-0015's entity predicate is deliberately not consulted; capability-absent is 403 with no 404 branch at all (no record is addressed, so ADR-0005/0037's taxonomy does not engage); never apply the test to a cross-user aggregate or a shared/team corpus — that fails the premise and needs its own permission (see docs/adr/0042-derived-projection-reuses-existing-gate-reconstructibility-test.md)
- [0043] The per-request archive export gives `refund-api` permission to READ attachment bytes — a bounded, SINGLE-caller departure from ADR-0016's never-proxy rule (proxying a file a client asked for is still forbidden; reading one to compose a derived document refund-api authors itself is now allowed, the same category ADR-0019's batch PDF already occupied for writes); memory is bounded by a new `MAX_EXPORT_RECEIPT_BYTES` checked from the DB's `sizeBytes` BEFORE any download (nothing else bounds it — attachments-per-request is uncapped); a receipt that cannot be embedded fails the WHOLE export with a 502 and no placeholder page (the inverse of the suite's usual fail-soft posture — an archive is never re-checked, so a silently incomplete one is worse than a refusal); approved/**rejected**/paid only (409 otherwise — draft/submitted are still MOVING, whereas rejected is terminal and is the document a disputing employee most needs; a rejected export shows the motivation and NO approved figure anywhere, since a reviewer can set line totals before rejecting); deliberately NOT PDF/A and the reason is recorded — copied receipt pages from arbitrary user PDFs break conformance unfixably, so PDF/A-3b with receipts as embedded FILES is the named path and its trigger; no new catalog permission via ADR-0042's reconstructibility test, every denial 404; generated per call and never stored, unlike the batch PDF; escalation trigger — a SECOND `getObject` caller revisits this ADR rather than quietly extending it (see docs/adr/0043-request-archive-export-refund-api-reads-attachment-bytes.md)
- [0044] The fourth notify caller (`inventory-api`) gets a scoped, short-lived service JWT — `auth POST /system/service-token` (client-credentials against a per-client `SERVICE_CLIENTS` entry, identical 401, rate-limited) mints a 5-minute RS256 JWT `sub="system:inventory-api"`, `aud=SERVICE_AUDIENCE` (distinct from `AUTH_AUDIENCE`), `scope="notifications.push"`, verified by `notify-api` via the existing JWKS; rejected: forwarding the acting user's JWT (an employee with no capability triggers the push), a keypair per service with multi-JWKS trust, and a prerequisite spec migrating all callers first; extended to every caller by 0049 (see docs/adr/0044-scoped-service-jwt-fourth-notify-caller.md)
- [0045] A gated tool remote may expose a second, UNGATED federated entry mounted at a shell-owned route when the screen is identity-scoped (ADR-0034's test) — `inventory-ui` exposes `./App` (gated), `./MyDevices` (ungated) and `./version`, the shell adds an un-guarded `/devices` child of `shellRoute` absent from `TOOLS` (the `/notify` shape, first applied to a remote that also has a gated entry) plus a "My devices" UserMenu link, and `inventory-api`'s `/me/*` routes need only a valid JWT, skip authz middleware and scope every query to the verified `sub` (ADR-0042 posture, not-yours 404, no price/ledger fields); both halves (ungated route AND self-scoped API) are required; rejected: a shell-native AccountScreen-style screen (tool business logic in the shell, against ADR-0009), granting everyone `inventory:access` (breaks specs/015 AC-9.6), and a fifth remote for one screen (see docs/adr/0045-ungated-second-federated-entry-of-a-gated-remote.md)
- [0046] Depreciation is derived on read for open years and snapshotted, immutably, only when a fiscal year is closed — an asset stores only entity/purchase date/price in integer cents, its rule is the latest `depreciation_rule` effective at purchase date (resolved on read like mileage rates, no FK), the schedule is a pure `schedule()` with one round-half-up rule and the remainder in the final year, closing writes immutable `fiscal_year` + `asset_year_figure` rows (Tier 1 triggers; row existence IS the closed state, no reopen; imported history uses the same rows as the anchor), and every dated write plus the close takes `pg_advisory_xact_lock` on the entity; rejected: persisting each asset's whole schedule at registration, computing everything live with no snapshot, and a 31-December materialisation cron (see docs/adr/0046-depreciation-derived-on-read-closed-years-snapshotted.md)
- [0047] A list-of-people read is a fact endpoint, acceptable only behind a named capability whose holders have a business need to pick a person — `auth GET /authz/users/directory` returns active `{id,name,email,entity}` (both entities, name-sorted, no pagination) on the forwarded-caller JWT, gated on the `inventory` catalog's `asset:manage`, rate-limited, called directly by `inventory-ui` with `inventory-api` keeping no copy; it narrows ADR-0039 (which stays in force for `/authz/users/identities`) for that one audience only, and each further consumer is added to the gate deliberately; rejected: an exact-email decision endpoint (ADR-0035 style), reusing `requireAdmin` `GET /admin/users`, proxying/caching the list in `inventory-api`, and adding search/email to `/authz/users/identities`; escalation trigger: a second consuming app or a user count that makes an unpaginated list unreasonable (see docs/adr/0047-user-directory-endpoint-capability-gated.md)
- [0048] `auth` is both the issuer of service credentials and a notify-api caller (invitation emails), so it mints its own credential IN PROCESS instead of calling its own `POST /system/service-token` — `sub="system:auth"`, `aud=SERVICE_AUDIENCE`, scope `emails.send`, same better-auth signer and 300 s lifetime, one claim/sign function shared with the endpoint, signer injected in `src/index.ts`; the client id `auth` is RESERVED (a `SERVICE_CLIENTS` entry named `auth` refuses to start, otherwise the holder of that entry's secret could mint tokens indistinguishable from `auth`'s own); rejected: loopback HTTP to its own endpoint with its own client secret (extra hop, spends the endpoint's rate limit, a secret that proves nothing because the verifier is the holder), and keeping the shared token for `auth` alone (it could never be retired, specs/016 US-5) (see docs/adr/0048-auth-mints-own-service-credential-in-process.md)
- [0049] Every notify-api caller authenticates as itself and the shared token is retired — `auth`, `refund-api`, `estimai-api` and `inventory-api` use scoped 5-minute service JWTs, one scope per capability (`notifications.push`, `emails.send`; estimai-api and inventory-api push only, auth email only, refund-api both), push origin bound per client, one notify-api middleware guards both `/system` routes and logs `caller=<sub>`; retirement is THREE pushes (notify-api and auth accept the new mechanism → callers switch, verified from the caller log → a person deletes the variable from notify-api, the point of no return, undone by restoring it → legacy code, env-doctor, infra and docs removed), because one push redeploys every Railway service in no fixed order; **supersedes the shared-token parts of ADR-0011, ADR-0017 and ADR-0040** and completes ADR-0044's named follow-up; rejected: one scope for both capabilities, a single push, a caller-side fallback to the shared token (keeps it alive, hides a misconfigured client), and per-template binding of the email scope (deferred; trigger: a client that should send only some templates) (see docs/adr/0049-all-notify-callers-scoped-credentials-shared-token-retired.md)
- [0050] The design system becomes a shared React library, `@operai/ui` in `operai-ui/`, that every frontend compiles FROM SOURCE via a Vite alias + `resolve.dedupe: ['react','react-dom']` + tsconfig `paths` (no build, no publish, no workspace, one React under the MF singleton); `tokens.css` moves into it and `shell/src/styles/tokens.css` becomes a one-line `@import` so `shell/tokens.css` keeps working; components render only library classes (no utilities, no inline colours) and take all copy as props; apps keep thin adapters that bind copy and e2e test ids; adoption is app by app (refund-ui first); rejected: pnpm `link:`/`file:` (second or missing React on Vercel, stale snapshot), a workspace (breaks per-app installs), exposing components via Module Federation (untyped runtime coupling), a private registry (publish step, credentials) (see docs/adr/0050-shared-ui-library-consumed-as-source.md)
- [0051] One styling dialect in every frontend: tokens are CSS custom properties defined once in `operai-ui/src/styles/tokens.css`, mapped by Tailwind v4 `@theme inline` (utilities read `var(--x)`, one definition per token, default palette removed), reaching elements ONLY as token utilities (`text-soft`, `bg-org/10`) or library component classes; inline `style` only for runtime values; enforced by `operai-ui/eslint/design-tokens.ts` in every app (no `var(--` in TS, no colour in `style`, no arbitrary colour classes); remotes' standalone `index.css` import the library tokens instead of copies (supersedes the ADR-0006 addendum's sync-the-copy rule); the inline-`var()` dialect of refund/admin/notify/inventory rested on a premise the ADR-0006 single-sheet addendum had already removed; rejected: inline vars everywhere (no variants), CSS Modules / zero-runtime CSS-in-JS (second toolchain), runtime CSS-in-JS, per-remote prefixed Tailwind sheets (the federation-pure escape hatch — trigger: a remote deploying from another repo or cadence) (see docs/adr/0051-one-styling-dialect-token-utilities.md)
- [0052] The CRM is a sixth tool (`crm-api` + `crm-ui`) whose reads are open to every `crm:access` holder — a client relationship is team knowledge — while deal writes need entity-scoped `deal:manage` and erasing a contact needs `contact:erase`; a deal write outside the caller's scope is a 403 `out_of_scope`, NOT a 404, because the same caller can read the deal (ADR-0037's branch, deliberate contrast with refund/inventory's 404); company/contact/deal writes use ADR-0038's If-Match CAS; owners/assignees are auth ids resolved live (fail soft) and checked active on write (fail closed); rejected: entity-scoped reads, one permission for all, per-record ACLs, CRM tables in estimai-api (see docs/adr/0052-crm-tool-shape-and-authorization.md)
- [0053] The user directory's second consumer: the `crm` catalog's `deal:manage` is added to `DIRECTORY_GATE_PERMISSIONS` (ADR-0047's escalation trigger) for the CRM owner/assignee pickers — deliberately NOT `crm:access` or `contact:erase`; endpoint shape/population/rate limit unchanged, crm-api keeps no copy; a non-holder's records default to themselves and the UI shows the owner read-only on 403 (see docs/adr/0053-user-directory-gate-widened-to-deal-manage.md)
- [0054] CRM money is its own permission: the `crm` catalog's `deal:financials` (unconditioned; seeded to `admin` and `sales`, NOT to the new `crm-technical` role = `crm:access` only); crm-api OMITS — never zeroes — deal `amountCents`/`currency`/`notes` and pipeline `totals` for a caller without it, offers and entity profiles require it, an attachment is downloadable without it only by its uploader, `GET /scope` reports `financials`; `deal:manage` without `deal:financials` is unsupported (seed never creates it, every money route refuses it); rejected: UI-only hiding, a read-only technical role, per-deal visibility, entity-scoped financials (see docs/adr/0054-crm-financial-visibility-permission.md)
- [0055] `auth POST /authz/app-access-check` also answers by `{ appId, userId }` (exactly one of email/userId; same caller gate, limiter, byte-identical negative and timing floor; probe `id = $1 AND deletedAt IS NULL`) and `GET /authz/users/directory` takes an optional `?appId=` narrowing to holders of `(appId,"access")` — `crm-api` knows only auth ids and the pickers must offer only people who can open the CRM; amends ADR-0035 and ADR-0047, same gate so the audience does not widen (see docs/adr/0055-app-access-check-by-user-id-and-directory-app-filter.md)
- [0056] An email notice is addressed by user id: a caller sets `email: true` on notify-api's `POST /system/notifications` (and must hold `emails.send` as well as `notifications.push`), and notify-api resolves the active user's address at send time from a new auth endpoint `POST /system/users/contact` (one user per call, service JWT with the new scope `users.contact` held only by `system:notify-api`, rate-limited, logs no id or address) — no copy kept, a deactivated user gets nothing, the generic English `notification_notice` template is built from the notification itself and is unreachable through `/system/emails`; best effort with `emailStatus` sent/failed/skipped, the in-app row always stands; rejected: crm-api looking addresses up itself (a technician lacks `deal:manage`, every tool would repeat it), granting `users.contact` to crm-api, a synced address copy in notify-api, a batch lookup (see docs/adr/0056-notify-api-resolves-email-notice-address-from-auth.md)
- [0057] crm-api reads its own bucket's object bytes to build an offer — the bounded-read rule of ADR-0043, second caller: the deal PDFs a user appends as annexes (≤ 5, total `sizeBytes` ≤ 20 MiB checked from the DB BEFORE any `getObject`) and the entity's letterhead PDF (≤ 5 MiB, key must match `letterheads/<entity>/<uuid>.pdf` before it is read or deleted); proxying a requested file stays forbidden (ADR-0016) and downloads stay presigned GETs; an unreadable or non-PDF file fails the WHOLE generation with 422 `attachment_unreadable` naming it (no placeholder, the rolled-back transaction keeps the offer number); escalation trigger — a third service reading bytes, a file the user did not choose, or > 25 MiB per request (see docs/adr/0057-crm-api-reads-attachment-bytes-for-offer-annexes.md)
- [0058] Visibility by relationship to the record, never by role, and a read of your own data must not hang on a remote authority — meetings content opens only for creator / Operai participant / opted-in host reader (anything else 404, identical to nonexistent); no role (admin, `meeting:erase`) ever reads content; `selfScoped` reads work without `auth`, every create/generate/ask/edit is `capability(...)` live + fail closed; deletion of your own data needs no grant; ungated `./MyMeetings` AND self-scoped API both required (see docs/adr/0058-meetings-tool-shape-visibility-by-participation.md)
- [0059] A cross-service "may this user…" question is asked as the USER, a state push is sent as the SERVICE, and a replicated state must survive reordering — meeting host `resolve` forwards the caller's JWT and fails closed for every grant (soft only for labels); `notices` use scope `host-notices.send`, a strict content-minimal body, per-meeting `seq` and an outbox (manual retry for linked/changed, until-delivered for unlinked/deleted, null title on removal so nothing outlives a delete); hosts are registry data, never a branch (see docs/adr/0059-meeting-host-contract-resolve-and-notices.md)
- [0060] A cross-app UI seam must not let the other side's code failure become the host page's failure — hosts embed Meetings via `shell/extensions` `HostExtension` (props = three strings) with 5 s timeout + error boundary + the host's own fallback, and import the seam dynamically; coarse domain widgets only, NOT precedent for shared primitives (ADR-0050 stands) (see docs/adr/0060-host-extension-federated-panel-through-the-shell.md)
- [0061] User content must never leave the permitted jurisdiction or be retained by a processor through a change we did not make in code — every hop (storage, transcription, LLM, any future one) is verified at STARTUP (exit 1): EU/CH regions, retention settings (unreadable = refuse), no fake provider in production, model id pinned, a model change needs a green eval; the provider choice (Azure Speech + Bedrock) is superseded by 0069 (see docs/adr/0061-meetings-ai-providers-eu-zero-retention.md)
- [0062] User-requested work must be neither lost nor left looking pending, and time-based state must never depend on a writer — Postgres `meeting_job` queue (SKIP LOCKED, lease, `attemptId` re-check at commit, enqueue in the same transaction) runs asked-for work only; every time-derived state (interrupted, expired, stale, stuck-pending reads failed) stays derived on read, never swept (ADR-0013 boundary) (see docs/adr/0062-durable-job-runner-work-queued-state-derived.md)
- [0063] A deletion promise must hold when our code is not running, and a storage setting must not quietly undo it — audio expires by a bucket-wide 29-day lifecycle rule verified at startup (no prefix filter, versioning not enabled, else refuse), lazy delete on read, explicit deletes remove the bucket prefix FIRST (503 and nothing changed on failure); backups of transcripts are an open gap (R7) (see docs/adr/0063-audio-retention-bucket-lifecycle-verified-at-startup.md)
- [0064] Reading user-supplied bytes through our own process needs a ceiling, an allowlist and isolation, and the reason must not widen — meetings-api is the THIRD byte reader (ADR-0043/0057): only `prepare_audio` and the upload probe, ≤ 500 MiB streamed to disk, demuxer allowlist authoritative only on the LOCAL file (`-protocol_whitelist file`; the URL probe is an early reject, a scheme list does not bound hosts), `-format_whitelist` on every input, output caps (`-t`, `-fs`) that fail as `too_long`, non-root, minimal child env, timeouts, keys fixed server-side; a FOURTH reader, a file the user did not choose, or a new media type revisits this ADR (see docs/adr/0064-meetings-api-reads-audio-bytes-third-reader.md)
- [0065] A message crossing a service boundary must be rendered in the READER's language, and a new field must reach every surface that renders it — notify-api `/system/notifications` takes optional `it: {title, body}`, stored, returned by list AND SSE, picked by notify-ui and `ToastHost` from `<html lang>` with English fallback; no per-user language on the server (see docs/adr/0065-bilingual-system-notifications.md)
- [0066] A gate defined by a permission is only as narrow as that permission's holders — `meetings:access` joins `DIRECTORY_GATE_PERMISSIONS` (third consumer after 0053/0055), so with the default employee grant (0068) EVERY employee can list every active user; the user accepted this explicitly at the plan gate; participants are re-validated server-side as active (fail closed); any new default grant must first enumerate the gates that list the permission (see docs/adr/0066-user-directory-gate-meetings-access.md)
- [0067] Untrusted text is never instructions and model output is never trusted structure — transcripts are escaped and delimited as quoted data, output is one offered, unforced tool whose reply is accepted only as exactly one schema-valid call (else `invalid_output`, one resample, then `failed`; text/thinking discarded unread — the guarantee is our validation, not a provider mechanism, amended 2026-11-05) with no actionable tools, the server renders headings/order/count and drops uncited or unknown citations, invalid output is `failed` never partial, rendering is plain text (no links/images), whole record in context with no embeddings store; injection evals are a release and model-change gate (ReviewAI/ProposAI inherit) (see docs/adr/0067-ai-output-structured-validated-plain-text.md)
- [0068] A default grant silently widens every gate that lists its permission — `employee` gets `meetings:access` (the suite's FIRST default grant, explicit departure from specs/004, accepted by the user at the plan gate); `template:manage`/`meeting:erase` stay `admin`-only and pinned by a seed contract test; not a template for tools reading shared business data; the auth re-seed deploys first (see docs/adr/0068-default-employee-grant-meetings-access.md)
- [0069] Meetings AI on Google Cloud, with every retention setting either read at startup or signed off — a processor's intermediate storage (staging bucket, soft-delete window, operation store, logging toggle) is a retention decision of its own and its default is often long; whatever the vendor exposes is verified (exit 1 when wrong or unreadable), whatever it does not is a named sign-off with an owner, never implicit: Chirp 3 BatchRecognize (`eu`) through a transient EU GCS bucket (1-day lifecycle, soft delete 0, deleted at attempt start/in `finally`/before any DB change on user deletion) + Claude on Vertex `eu` multi-region (never `global`, no Fable/Mythos, no caching); user-accepted exception 2026-11-05: Google may keep the async transcript ~5 days; supersedes 0061's provider choice (see docs/adr/0069-meetings-ai-providers-google-cloud-eu.md)
- [0070] Never assert that two independently labelled things are the same — long recordings are transcribed in parts and parts overlap and a label joins the previous part's only on text evidence (≥ 20 matched words, one-to-one, never by position, number, voice matching or the audio), otherwise it stays separate and the creator can separate a joined one (a false merge reaches every summary invisibly, a false split costs one rename; amended 2026-11-05); the same shape applies to any labels, ids or clusters joined by position across files, batches or meetings (see docs/adr/0070-meetings-transcript-parts-speaker-labels-per-part.md)
- [0071] Access is decided where a principal comes into being, never after — only a live pending invitation (verified email) or the bootstrap admin creates a user, and both only for an allowed-domain email, in better-auth `user.create.before`; an outside-`ALLOWED_SIGNUP_DOMAINS` email (welld.ch, welld.it) is refused even with an invitation; everyone else is recorded in a separate `access_request` waiting list that grants nothing, and approving it creates an invitation via specs/006 (never a user, no second activation path); a new user-creating path (import, SSO, test endpoint) must be deliberate and listed, and no test exemption goes inside the gate; amends specs/004 AC-6.3 and specs/006 Non-goals (see docs/adr/0071-access-only-by-invitation-waiting-list.md)
- [0072] A best-effort notice must not block, undo or leak through the action it announces — `system:auth` gains `notifications.push` bound to origin `admin` (amends ADR-0048/0049 "auth: email only") to notify every effective admin of a new access request, in-app plus `email: true` (notify-api resolves addresses, ADR-0056; auth sends none), not awaited by the sign-in, failures logged; a new scope ships with its origin binding, and any other origin revisits the ADR (see docs/adr/0072-auth-pushes-admin-notifications.md)
- [0073] A state written in two places drifts, and a state replicated by messages must survive loss, repetition and reordering — an estimate is finished only when closed in EstimAI (owner/editor, If-Match, read-only until reopened); estimai-api pushes a content-free notice `{estimateId, event, version, at, byUserId}` to crm-api `POST /system/estimate-notices` with its service JWT (new scope `estimate-notices.send`, ADR-0044/0049), best effort; crm-api accepts only `system:estimai-api`, applies under a row lock only a newer version (`estimaiVersion`, reset on relink), completes or reopens the task and notifies; the CRM's own Mark ready/Reopen are removed, the admin override stays; a second follower, content in the notice or guaranteed delivery revisits it (see docs/adr/0073-estimai-closes-the-estimate-crm-follows.md)
- [0071] A transcript that cannot be proven complete says where it may not be — a silent omission by a producer that reports success is read downstream as a complete record (and absence as fact): detect probable gaps from an independent signal (audio energy vs the word timeline), retry the part up to 3 tries in memory within one job claim, then mark final gaps and have the SERVICE write the caveat on every derived artefact (summary, answer, copy); empty-with-gaps is `failed` `speech_not_transcribed`, never "no speech"; any new consumer of a transcript must carry the gaps (see docs/adr/0071-meetings-transcript-completeness-detect-retry-mark.md)
