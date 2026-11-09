---
spec: 024
generated: 2026-11-03
synced: 2026-11-03
---

# Tasks: Projects — the delivery work wellD runs and the contracts behind it

Rigor `mvp`: no plan.md; the contract below binds the dev agents as a plan would. Drift
against it is routed to the product owner.

## Architecture notes

### Components
- **auth** — new catalog `projects`, one new system role, grants added to `sales` and
  `accounting`, the directory gate widened, one new service scope.
- **crm-api** — one new system route: CRM companies readable by a scoped service credential.
- **projects-api** (new; Bun + Hono + Prisma like crm-api, port **8085**, logical DB
  **`projects`**, test DB `projects_test`) — authorization-enforcing (ADR-0014): live
  `/authz/resolve`, fail closed 503; every route requires `projects:access`.
- **projects-ui** (new federated remote `projects`, port **5180**, exposes `./App` and
  `./version`), mounted by the shell at the gated route `/projects/$`.
- **shell**, repo wiring (lerna, mise, compose, env-doctor, infra/check.sh), docs.

### Decided here (mvp, no architect — each is an ADR candidate, written in T18)
- **CRM companies are read service-to-service.** A project-module user may hold no
  `crm:access` (D13), yet must see company names and a project manager must pick a company.
  projects-api calls crm-api `GET /system/companies` with an auth-issued service credential
  (`sub = system:projects-api`, scope `crm.companies.read`, ADR-0049 pattern). Rejected:
  forwarding the user JWT (fails for users without `crm:access`); snapshotting company names
  (stale on rename). specs/025 adds a deals scope on the same channel.
- **A project's entity and company are fixed at creation** (not discussed in the grilling;
  no AC asks to change them). A wrong one is a new project (cf. D7).
- **Derived dates (AC-1.5):** `startDate` = earliest contract start, `null` with no
  contracts; `endDate` = latest contract end, `null` when there is no contract or any
  contract is open-ended.

### Authorization (auth catalog `projects`)
| Resource | Action | Conditions | Seeded to |
|---|---|---|---|
| `projects` | `access` | — | admin, `project-manager` (new), `sales`, `accounting` |
| `project` | `manage` | `entity` | admin (unconditioned), `project-manager` and `sales` (entity-scoped) |
| `contract` | `bexio` | — | admin, `accounting` |

`employee` gets nothing. `project:manage` joins `DIRECTORY_GATE_PERMISSIONS` (pickers,
ADR-0053/0055). `crm.companies.read` joins `KNOWN_SERVICE_SCOPES`.

### Data model (projects-api, migration `prisma/migrations/*_init`)
- `Project` — `id text` (cuid), `name varchar(200)`, `type ProjectType`, `state ProjectState`
  default `planned`, `stateBeforeHold ProjectState?`, `entity Entity`, `companyId text?`
  (CRM company id), `projectManagerId text` (auth user id), `version int` default 1,
  `createdById text`, `createdAt`, `updatedAt`.
  CHECKs: `companyId` NOT NULL iff `type IN (t_and_m, fixed_price, maintenance)`;
  `stateBeforeHold` NOT NULL iff `state = on_hold`.
- `ProjectMember` — `(projectId, userId)` PK, `addedAt`.
- `Contract` — `id`, `projectId` FK, `type ProjectType`, `companyId text`, `origin`
  (`manual` | `deal`) default `manual`, `dealId text?` (unique, filled by specs/025),
  `bexioOrderId varchar(64)?`, `startDate date`, `endDate date?`, `version`, timestamps;
  fixed price: `deadline date?`, `estimatedManDays numeric(6,1)?`, `maxEffortManDays
  numeric(6,1)?`; SLA: `slaHighDays int?`, `slaNormalDays int?`; hour package:
  `hourPackageHours int?`, `hourPackageKind (capacity|yearly)?`, `hourPackageStart date?`,
  `hourPackageExpiry date?`.
  CHECKs: `type = fixed_price` ⇒ `deadline` and `maxEffortManDays > 0` NOT NULL;
  `type = maintenance` ⇒ SLA pair or hour package present; SLA pair both-or-neither, each
  0–60; hour package fields both-or-neither as a group, `hours > 0`, expiry only for
  `capacity`; `endDate >= startDate`.
- `ContractPosition` — `id`, `contractId` FK cascade, `profile varchar(120)`,
  `plannedManDays numeric(6,1) > 0`, `position int`.
- **Ids are text, never uuid** (amended 2026-11-03, drift raised by T2): CRM and auth ids
  are cuids (`TEXT`), so every id column is `text` and every id input is validated as a
  1–64 character string; projects-api's own ids are cuids too (`@default(cuid())`).
- `ProjectType = t_and_m | fixed_price | maintenance | saas | internal`;
  `ProjectState = planned | active | on_hold | closed | cancelled`;
  `Entity = welld_ch | welld_it`.

### API contracts
Errors are `application/problem+json` with a `code` (crm-api `lib/problem.ts` shape).
Common: 400 validation; 401 no/invalid JWT; 403 `forbidden` (missing capability) or
`out_of_scope` (manage held for the other entity); 404 unknown id; 428 missing `If-Match`;
409 `version_conflict`; 503 `authz_unavailable` (auth down). Writes on projects and
contracts take `If-Match: "<version>"` and return `ETag` (ADR-0038). `Person = { id, name:
string | null, deleted: boolean }` (crm-api `lib/people.ts`). `CompanyRef = { id, name:
string | null }` — `name` is `null` when crm-api cannot answer (fail soft).

**crm-api (T2)**
- `GET /system/companies?q=&ids=&limit=` — `Authorization: Bearer <service JWT>`, `aud =
  SERVICE_AUDIENCE`, scope `crm.companies.read`. `q`: case-insensitive substring of name,
  non-archived only; `ids`: comma-separated ids (1–64 characters each, ≤ 100), archived included,
  ANDed with `q`; `limit` 1–50, default 20 — or `ids.length` when `ids` is given without one. → `200 { items: [{ id, name, entity, archived }] }`. Every credential
  failure → the same `401` body. A user JWT is never accepted here.

**projects-api**
- `GET /scope` → `{ manage: Entity[], managesAll: boolean, bexio: boolean }` (T3).
- `GET /companies?q=` → `{ items: [{ id, name, entity }] }` — needs `project:manage` (any
  entity); proxies crm-api; crm-api down → 503 `crm_unavailable` (T5).
- **projects-ui routes** (T11): the shell mounts the remote at `/projects/$` and the inner
  router has basepath `/projects`, so inner routes are `/` and `/$id` (URLs `/projects`,
  `/projects/<id>`).
- `GET /projects?page=&q=&type=&state=&projectManagerId=` → `{ items: ProjectSummary[],
  page, pageSize: 25, total }`, sorted by name; `q` case-insensitive substring of name.
  `ProjectSummary = { id, name, type, state, entity, company: CompanyRef | null,
  clientCount: number, projectManager: Person }` (`clientCount` = distinct contract
  companies; shown for `saas`) (T5).
- `POST /projects` `{ name, type, entity, companyId?, projectManagerId? }` → `201 Project`.
  422 `company_required` (client type without company), `company_not_allowed` (`saas` /
  `internal` with one), `company_not_found`, `not_project_user` (PM without
  `projects:access`, checked live via auth `app-access-check` by user id, ADR-0055); 403
  `out_of_scope`. PM defaults to the caller (T5).
- `GET /projects/:id` → `Project = { id, name, type, state, stateBeforeHold: ProjectState |
  null, entity, company, projectManager, team: Person[], contracts: ContractSummary[],
  startDate, endDate, version, createdAt, updatedAt }` (T5; `stateBeforeHold` added by T20 —
  the UI needs it to offer the one state an `on_hold` project can return to).
- `GET /project-managers` → `{ items: Person[] }` — the distinct project managers of all
  projects, sorted by name; access only (the user directory is open to managers only, so
  this is what feeds the list's project-manager filter for every reader, AC-1.4) (T20). `ContractSummary = { id, type, company: CompanyRef, origin,
  bexioOrderId, startDate, endDate }`.
- `PATCH /projects/:id` `{ name?, projectManagerId? }` → `200 Project` (T5).
- `POST /projects/:id/transitions` `{ to: ProjectState }` → `200 Project`; 409
  `invalid_transition` outside the AC-1.3 matrix (T6).
- `PUT /projects/:id/type` `{ type: "saas" }` → `200 Project`; 409 `type_change_refused`
  unless `internal → saas` (T6).
- `PUT /projects/:id/team` `{ memberIds: string[] }` → `200 Project`; 422 `not_project_user`
  with `{ userIds }` (T7).
- `POST /projects/:id/contracts` `{ companyId?, startDate, endDate?, terms }` → `201
  Contract`. Type = the project's. 409 `contracts_not_allowed` (`internal`), 409
  `project_not_open` (`closed` / `cancelled`); client project: `companyId` defaults to the
  project's, another → 422 `company_mismatch`; `saas`: `companyId` required, must exist
  (422 `company_not_found`) (T8).
  `terms` by type — `fixed_price: { deadline, estimatedManDays?: number | null,
  maxEffortManDays }`; `maintenance: { sla?: Sla | null, hourPackage?: HourPackage | null }`
  (one required, else 422 `maintenance_needs_sla_or_hours`); `saas: { sla?, hourPackage? }`;
  `t_and_m: { positions: [{ profile, plannedManDays }] }` (≥ 1); `internal`: none.
  `Sla = { highDays: int 0–60, normalDays: int 0–60 }` (UI prefills 1 / 3).
  `HourPackage = { hours: int > 0, kind: "capacity" | "yearly", startDate, expiryDate?:
  date | null }` (expiry only for `capacity`). Man-days: ≥ 0, one decimal.
- `GET /projects/:id/contracts/:contractId` → `Contract = ContractSummary + { projectId,
  dealId: null, terms, version }` (T8).
- `PATCH /projects/:id/contracts/:contractId` `{ startDate?, endDate?, terms? }` → `200
  Contract`; ending a contract = setting `endDate` (T8). `DELETE` → 405 `not_deletable`.
- `PUT /projects/:id/contracts/:contractId/bexio-order` `{ bexioOrderId: string | null }` →
  `200 Contract`; needs `contract:bexio`; trimmed, empty → `null`, > 64 → 400 (T9).

### Deferred (knowingly not done at this tier)
- Production provisioning (Railway `projects-api`, Vercel `projects-ui`, DNS, shell
  runtime-config, `SERVICE_CLIENTS` secret) — outward-facing, the owner runs it with the
  `provision-tool` skill after merge; `bash infra/check.sh` goes green only after it (QE D1).
- A shell e2e journey for `/projects` (CRM precedent: specs/017 T15) — next step towards
  `production`.
- Hand-off from the CRM (specs/025), tasks and threads (specs/026), glossary entries.

## Tasks

- [x] T1: auth — `projects` catalog, `project-manager` role, grants to `sales` / `accounting`, directory gate, `crm.companies.read` scope — refs: AC-4.1, AC-4.3, AC-4.4, AC-4.5, AC-4.6, AC-1.6 — deps: none
  - touch: `auth/src/authz/catalogs/projects.ts`, `auth/src/authz/catalogs/projects.test.ts`, `auth/src/authz/seed.ts`, `auth/src/authz/seed.test.ts`, `auth/src/authz/directory.routes.ts`, `auth/src/auth/directory.routes.test.ts`, `auth/src/system/serviceClients*.ts`
  - done when: `cd auth && bun test src/authz src/system src/auth/directory.routes.test.ts` is green, including new tests that the seed grants `project-manager` (access + entity-scoped manage), `sales` (+ access + entity-scoped manage), `accounting` (+ access + bexio), admin all, employee nothing; that the directory admits a `project:manage` holder; and that `crm.companies.read` is an accepted scope.
- [x] T2: crm-api — `GET /system/companies` behind a `crm.companies.read` service credential — refs: AC-1.1, AC-1.4, AC-2.2 — deps: none
  - touch: `crm-api/src/system/**`, `crm-api/src/index.ts`, `crm-api/src/lib/env.ts`, `crm-api/src/openapi/registry.ts`
  - done when: `cd crm-api && bun test src/system` is green: a scoped service JWT gets `200` with `items`; a user JWT, a token with another scope and no token each get the identical `401`; `q` excludes archived companies, `ids` includes them; `ids` over 100 → `400`. Full `bun test` still green.
- [x] T3: projects-api scaffold — env, JWT + authz middleware (copied from crm-api), problem JSON, OpenAPI, health, `/scope`, people/identities, service-token client, stub routers for every area — refs: AC-4.2 — deps: none
  - touch: `projects-api/package.json`, `projects-api/bun.lock`, `projects-api/bunfig.toml`, `projects-api/tsconfig.json`, `projects-api/Dockerfile`, `projects-api/railway.json`, `projects-api/README.md`, `projects-api/.gitignore`, `projects-api/src/index.ts`, `projects-api/src/lib/**`, `projects-api/src/auth/**`, `projects-api/src/authz/**`, `projects-api/src/health/**`, `projects-api/src/scope/**`, `projects-api/src/openapi/**`, `projects-api/src/test-support/**`, `projects-api/src/*/*.routes.ts`, `projects-api/src/authz-outage.test.ts`, `scripts/check-shared-copies.ts`
  - done when: `cd projects-api && bun run typecheck && bun test` is green with `GET /health` 200, `GET /scope` 403 without `projects:access`, 503 when `/authz/resolve` is down; `src/index.ts` mounts `projects`, `transitions`, `team`, `contracts`, `bexio` and `companies` routers (stubs) so later tasks never edit it; `bun scripts/check-shared-copies.ts` exits 0 with `projects-api/src/lib/serviceToken.ts` in the `serviceToken` group.
- [x] T4: projects-api data model — Prisma schema and initial migration with the CHECKs — refs: AC-1.1, AC-1.3, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7 — deps: T3
  - touch: `projects-api/prisma/**`, `projects-api/prisma.config.ts`, `projects-api/src/lib/db.ts`, `projects-api/src/db.constraints.test.ts`
  - done when: `bun run db:deploy` succeeds on `projects` and `projects_test`; `bun test src/db.constraints.test.ts` proves at the database that a client project without company, a `fixed_price` contract without max effort, a `maintenance` contract with neither SLA nor hours and an SLA with only one priority are each refused.
- [x] T5: projects-api projects — list, create, read, rename / change PM, company lookup — refs: AC-1.1, AC-1.4, AC-1.5, AC-1.6, AC-1.7, AC-4.3, AC-4.4 — deps: T2, T4
  - touch: `projects-api/src/projects/projects.routes.ts`, `projects-api/src/projects/projects.schemas.ts`, `projects-api/src/projects/projects.test.ts`, `projects-api/src/projects/dates.ts`, `projects-api/src/companies/**`, `projects-api/src/lib/crm.ts`
  - done when: `bun test src/projects/projects.test.ts src/companies` is green covering: `company_required` / `company_not_allowed` / `company_not_found`; `out_of_scope` 403 for the other entity; `not_project_user` 422 and 503 when auth cannot answer; PM defaults to the caller; pagination (25), name search, type / state / PM filters, sort by name; `clientCount`; derived dates per the notes; company name `null` when crm-api is down; 428 / 409 on `PATCH`.
- [x] T6: projects-api states and type change — refs: AC-1.2, AC-1.3 — deps: T5
  - touch: `projects-api/src/projects/transitions.ts`, `projects-api/src/projects/transitions.routes.ts`, `projects-api/src/projects/transitions.test.ts`
  - done when: `bun test src/projects/transitions.test.ts` is green: every allowed move of AC-1.3 succeeds, every other pair is 409 `invalid_transition`, `on_hold` returns to the state it left, `cancelled` accepts nothing; `internal → saas` succeeds and every other type change is 409 `type_change_refused`.
- [x] T7: projects-api team — refs: AC-1.5, AC-1.6 — deps: T5
  - touch: `projects-api/src/projects/team.routes.ts`, `projects-api/src/projects/team.test.ts`
  - done when: `bun test src/projects/team.test.ts` is green: `PUT` replaces the team; a member without `projects:access` → 422 `not_project_user` naming the ids; auth down → 503; names are live (a renamed user shows the new name).
- [x] T8: projects-api contracts — create by hand, read, edit terms and dates, end; never delete — refs: AC-1.7, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-2.8, AC-2.9, AC-2.10 — deps: T5
  - touch: `projects-api/src/contracts/contracts.routes.ts`, `projects-api/src/contracts/contracts.schemas.ts`, `projects-api/src/contracts/terms.ts`, `projects-api/src/contracts/contracts.test.ts`
  - done when: `bun test src/contracts/contracts.test.ts` is green: per-type term validation (fixed price required fields, maintenance one-of, SLA bounds, hour package shapes, T&M ≥ 1 position, SaaS both optional); `contracts_not_allowed` for `internal`; `project_not_open` for `closed` / `cancelled`; `company_mismatch` on a client project; any CRM company on `saas`; `DELETE` → 405; no response field carries an amount; 428 / 409 on `PATCH`.
- [x] T9: projects-api Bexio order id — refs: AC-3.1, AC-3.2, AC-3.3 — deps: T8
  - touch: `projects-api/src/contracts/bexio.routes.ts`, `projects-api/src/contracts/bexio.test.ts`
  - done when: `bun test src/contracts/bexio.test.ts` is green: `accounting` sets, changes and clears it; a `project-manager` gets 403; value trimmed, empty → `null`, 65 characters → 400; a project whose contracts have no id still moves `planned → active → closed`.
- [x] T10: projects-api authorization matrix over the assembled app — refs: AC-4.2, AC-4.3, AC-4.4, AC-4.5, AC-4.6 — deps: T6, T7, T9
  - touch: `projects-api/src/matrix.test.ts`
  - done when: `bun test src/matrix.test.ts` is green for every route × {no access, access only, `project-manager` (welld_ch), `sales` (welld_it), `accounting`, admin}, and the full `bun test` and `bun run typecheck` are green.
- [x] T20: projects-api — `stateBeforeHold` on `Project`, `GET /project-managers` (added by re-sync 2026-11-03 after T12's drift report) — refs: AC-1.3, AC-1.4 — deps: T10
  - touch: `projects-api/src/projects/projects.routes.ts`, `projects-api/src/projects/projects.schemas.ts`, `projects-api/src/projects/projects.test.ts`, `projects-api/src/matrix.test.ts`
  - done when: `cd projects-api && bun test` is green with tests that `GET /projects/:id` returns `stateBeforeHold` (`null` unless `on_hold`, else the state it left), that `GET /project-managers` lists each distinct project manager once with live names and needs only `projects:access`, and that the matrix covers the new route.
- [x] T11: projects-ui scaffold — federated remote `projects` (`./App`, `./version`), router with every page route, API client, `useScope`, strings aggregator (en + it) — refs: AC-4.1, AC-4.7 — deps: none
  - touch: `projects-ui/package.json`, `projects-ui/pnpm-lock.yaml`, `projects-ui/index.html`, `projects-ui/vite.config.ts`, `projects-ui/vitest.config.ts`, `projects-ui/tsconfig*.json`, `projects-ui/eslint.config.js`, `projects-ui/postcss.config.js`, `projects-ui/vercel.json`, `projects-ui/src/main.tsx`, `projects-ui/src/App.tsx`, `projects-ui/src/router.tsx`, `projects-ui/src/version.ts`, `projects-ui/src/index.css`, `projects-ui/src/vite-env.d.ts`, `projects-ui/src/federation/**`, `projects-ui/src/lib/**`, `projects-ui/src/hooks/**`, `projects-ui/src/test-support/**`, `projects-ui/src/strings.ts`, `projects-ui/src/strings.test.ts`, `projects-ui/src/strings/**`
  - done when: `cd projects-ui && pnpm lint && pnpm build && pnpm test` is green; `strings.test.ts` fails if any key lacks `en` or `it`; the router declares `/`, `/projects/$id` with placeholder pages, and `strings/projects.ts`, `strings/project.ts`, `strings/contracts.ts` exist (empty) behind the aggregator, so later tasks only fill pages, components and their own strings file.
- [x] T12: projects-ui projects list and create dialog — refs: AC-1.1, AC-1.4, AC-4.4 — deps: T11
  - touch: `projects-ui/src/pages/ProjectsPage.tsx`, `projects-ui/src/pages/ProjectsPage.test.tsx`, `projects-ui/src/components/ProjectFormDialog.tsx`, `projects-ui/src/components/CompanyPicker.tsx`, `projects-ui/src/components/PersonPicker.tsx`, `projects-ui/src/components/ProjectFormDialog.test.tsx`, `projects-ui/src/strings/projects.ts`
  - done when: `pnpm test` is green with tests that the list shows the AC-1.4 columns (company / "N clients" / "Internal"), search and filters reach the query, "New project" is hidden without manage scope, and the company field appears only for client types.
- [x] T13: projects-ui project page — details, state actions, type change, PM and team, derived dates, contracts list, reload on conflict — refs: AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-1.7, AC-4.4 — deps: T12, T20
  - touch: `projects-ui/src/pages/ProjectDetailPage.tsx`, `projects-ui/src/pages/ProjectDetailPage.test.tsx`, `projects-ui/src/components/StateActions.tsx`, `projects-ui/src/components/TeamCard.tsx`, `projects-ui/src/components/PersonPicker.tsx`, `projects-ui/src/strings/project.ts`, `projects-ui/src/pages/ProjectsPage.tsx`, `projects-ui/src/pages/ProjectsPage.test.tsx`, `projects-ui/src/components/Badges.tsx`
  - done when: `pnpm test` is green with tests that only allowed transitions are offered, "Make SaaS" shows only on `internal`, team and PM pickers list only module users, a 409 `version_conflict` asks to reload, controls are hidden without manage scope, "Resume" targets `stateBeforeHold`, and the list's project-manager filter is fed by `GET /project-managers` for every reader (no "only my projects" fallback).
- [x] T14: projects-ui contracts — per-type form, contract card, end contract, Bexio field for accounting — refs: AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-2.8, AC-2.9, AC-2.10, AC-3.1, AC-3.2, AC-3.3 — deps: T13
  - touch: `projects-ui/src/components/ContractFormDialog.tsx`, `projects-ui/src/components/ContractFormDialog.test.tsx`, `projects-ui/src/components/ContractCard.tsx`, `projects-ui/src/components/BexioOrderField.tsx`, `projects-ui/src/components/BexioOrderField.test.tsx`, `projects-ui/src/pages/ProjectDetailPage.tsx`, `projects-ui/src/strings/contracts.ts`
  - done when: `pnpm lint && pnpm build && pnpm test` is green with tests that each type shows only its fields (SLA prefilled 1 / 3), maintenance without SLA and hours cannot be saved, no delete control exists, no amount is rendered, and the Bexio field is editable only with the `bexio` scope.
- [x] T15: shell — `/projects/$` route, TOOLS entry, sidebar, remote registration, session origin, CSP, About modal version — refs: AC-4.1 — deps: T11
  - touch: `shell/src/lib/tools.ts`, `shell/src/lib/tools.test.ts`, `shell/src/router.tsx`, `shell/src/components/Sidebar.tsx`, `shell/src/strings.ts`, `shell/src/federation/remotes.d.ts`, `shell/src/federation/__stubs__/projects*`, `shell/src/federation/remoteVersion*.test.ts`, `shell/src/hooks/useRemoteVersions.ts`, `shell/src/lib/runtimeRemotes.ts`, `shell/src/lib/session.ts`, `shell/src/components/AboutModal.test.tsx`, `shell/src/vite-env.d.ts`, `shell/vite.config.ts`, `shell/vitest.config.ts`, `shell/vercel.json`, `shell/public/runtime-config.example.json`
  - done when: `cd shell && pnpm lint && pnpm build && pnpm test` is green, with `tools.test.ts` proving the Projects tool appears only for `projects:access` holders.
- [x] T16: repo wiring — lerna, mise tasks, compose service and DB, env-doctor manifest, check script — refs: AC-4.1 — deps: T3, T11
  - touch: `lerna.json`, `mise.toml`, `compose.yaml`, `tools/env-doctor/manifest.ts`, `tools/env-doctor/*.test.ts`, `infra/check.sh`
  - done when: `bun test tools/env-doctor` is green with projects-api and projects-ui in the manifest; `bash infra/check.sh` runs projects-api and projects-ui gates; `mise tasks` lists the projects dev tasks.
- [x] T17: local env — `projects-api/.env.example` and `.envrc`, auth `SERVICE_CLIENTS` entry for `projects-api` (`crm.companies.read`), crm-api `SERVICE_AUDIENCE`, shell `VITE_PROJECTS_API_URL` / remote URL — drafted by the agent, applied by the developer (the guard stops agents writing env files) — refs: AC-4.1 — deps: T16
  - touch: `projects-api/.env.example`, `projects-api/.envrc`, `auth/.env.example`, `crm-api/.env.example`, `shell/.env.example`
  - done when: `mise run dev` serves `/projects` in the shell for a signed-in admin and the company picker returns CRM companies.
- [x] T18: docs — ADR-0075 (projects tool shape and authorization), ADR-0076 (projects-api reads CRM companies with a scoped service credential), AGENTS.md (tools table, layout, ADR index), README, changesets — refs: AC-4.1, AC-4.4, AC-4.5 — deps: T10, T15
  - touch: `docs/adr/0075-*.md`, `docs/adr/0076-*.md`, `docs/adr/README.md`, `AGENTS.md`, `README.md`, `.changeset/*.md`
  - done when: both ADRs exist with Context / Decision / Alternatives / Consequences, AGENTS.md's ADR index lists them, and `pnpm changeset status` shows bumps for auth, crm-api, projects-api, projects-ui and shell.
- [x] T19: QE-light verification; all gates green; spec status → done — refs: every AC — deps: T1, T2, T10, T14, T15, T16, T17, T18
  - touch: `specs/024-projects/qe-report.md`, `specs/024-projects/spec.md`
  - done when: the quality-engineer's QE-light verdict is PASS in `qe-report.md`, every local gate it lists is green (auth, crm-api, projects-api, projects-ui, shell, env-doctor, shared copies, changeset, secret scan), and `/wellforge:done 024-projects` accepts the feature. (Amended 2026-11-03, QE D1: `bash infra/check.sh` probes production hosts and belongs to the deferred provisioning step, not to this gate.)

## Coverage

| AC | Tasks |
|---|---|
| AC-1.1 | T2, T4, T5, T12 |
| AC-1.2 | T6, T13 |
| AC-1.3 | T4, T6, T13, T20 |
| AC-1.4 | T2, T5, T12, T13, T20 |
| AC-1.5 | T5, T7, T13 |
| AC-1.6 | T1, T5, T7, T13 |
| AC-1.7 | T5, T8, T13 |
| AC-2.1 | T8, T14 |
| AC-2.2 | T2, T8, T14 |
| AC-2.3 – AC-2.7 | T4, T8, T14 |
| AC-2.8 – AC-2.10 | T8, T14 |
| AC-3.1 – AC-3.3 | T9, T14 |
| AC-4.1 | T1, T11, T15, T16, T17 |
| AC-4.2 | T3, T10 |
| AC-4.3 | T1, T5, T10 |
| AC-4.4 | T1, T5, T10, T12, T13 |
| AC-4.5 | T1, T9, T10 |
| AC-4.6 | T1, T10 |
| AC-4.7 | T11, T12, T13, T14 |
