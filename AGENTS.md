# Operai

Internal toolsuite by **wellD** (wellD.ch) for AI-assisted software consulting and
back-office workflows. Nine tools ship today, composed into one suite by a
Module Federation shell (ADR 20260709-suite-frontend-module-federation):

| Tool | Route | What it does |
|---|---|---|
| **EstimAI** | `/estimai` | Software effort estimation — PERT + AI productivity modelling (tool #1) |
| **Refund** (Rimborsi) | `/refund` | Expense reimbursement — requests, review/decision, monthly batch payout |
| **Admin** | `/admin` | Roles, departments, users, permissions, invitations, mileage rates |
| **Inventory** | `/inventory` | Hardware register — assets, assignment to employees (confirmed by the employee), depreciation ledger, fiscal-year close, invoice files (specs/20261006-hardware-inventory) |
| **CRM** | `/crm` | Companies, contacts, deals through a stage pipeline, activities and follow-up tasks (specs/20261101-crm, ADR 20261101-crm-tool-shape-and-authorization) |
| **Meetings** | `/meetings` | Record (browser), upload or paste a meeting; EU transcription, summaries from editable templates and cited Q&A; files and links attached as AI context; linkable to a host record such as a CRM deal; audio and attached files kept 29 days (specs/20261104-meetings, ADR 20261104-meetings-tool-shape-visibility-by-participation–0068) |
| **Projects** | `/projects` | The delivery work wellD runs — projects (type, state, project manager, team), their terms (per-type delivery terms) and, for a project made from a won deal, its purchase order (Bexio order id, referent, ops-manager); no money (specs/20261103-projects, 022, ADR 20261103-projects-tool-shape-and-authorization/0080/0093/0094) |
| **Letterheads** | `/letterheads` | The letterheads and document layout of the suite, served by the Rust `letterhead-api` (specs/20261116-letterhead-service) |
| **Accounting** | `/accounting` | The accounting reference data of each legal entity — ledger accounts, VAT codes and monthly average exchange rates — that other modules (Refund first) read live; reached through the derived `accounting` app of `/authz/me`, never an `access` permission (specs/20261119-accounting, ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…) |
| **Hours** | `/hours` | Time tracking — every employee records the hours spent on a project, a deal, a meeting or other work (a duration on a day, never a time of day) and reads their own; holders of `time-entry:read-all` also see everyone's, with totals and an XLSX export; ungated, so **not** a `TOOLS` entry; the admin lists (categories, work types) are its Settings tab, `/hours/settings`, for holders of `time-list:manage` (specs/20261112-time-tracking, ADR 20261112-hours-api-time-entries-own-service-hours-catalog to 20261112-hours-ui-ungated-remote) |

Those nine are the entries in `shell/src/lib/tools.ts` — access-gated remotes. The
notification center (`notify-ui`) is a further remote but **not** a `TOOLS` entry: it mounts at
the shell-owned `/notify` route, reached from the header bell (ADR 20260713-notification-center-standalone-service-shell-seam). `inventory-ui` also
exposes a second, UNGATED entry, `./MyDevices`, mounted at the shell-owned `/devices` route
(any signed-in user sees their own devices; ADR 20261006-ungated-second-federated-entry-of-a-gated-remote). `meetings-ui` does the same with
`./MyMeetings` at `/my-meetings` (a participant can always read what was captured about them;
ADR 20261104-meetings-tool-shape-visibility-by-participation) and exposes a coarse `./HostMeetings` panel that a host app (the CRM deal page and, since 2026-11-23, the Projects project page)
embeds through the shell's `HostExtension` seam with a timeout and an error boundary (ADR 20261104-host-extension-federated-panel-through-the-shell). It also exposes
`./RecorderDock`, the recorder widget the shell shows in its floating slot while a recording runs and the person
is elsewhere in Operai (ADR 20261110-shell-floating-slot-for-remote-widgets). `hours-ui` is a remote with **no gated half at all**: recording and reading your
own hours is not a tool grant (AC-5.1), so the shell mounts its one entry, `./App`, at the ungated splat route
`/hours/$` (a child of `shellRoute`, no `beforeLoad`), reached from the user menu's **My hours** link and never from
the sidebar (ADR 20261112-hours-ui-ungated-remote). Its second tab, Everyone's hours (`/hours/all`), is for holders of `time-entry:read-all`;
its third tab, Settings (`/hours/settings`), holds the admin lists (categories, work types) for holders of `time-list:manage`.

Backed by eleven Bun services: `auth` (identity + authorization), `estimai-api`,
`notify-api`, `refund-api`, `inventory-api`, `crm-api`, `meetings-api`, `projects-api`,
`activities-api`, `accounting-api`, `hours-api` (and the one Rust service, `letterhead-api`).

`accounting-api` is the owner of the accounting reference data (specs/20261119-accounting). It serves its own
screens (`accounting-ui`) and one narrow, read-only service read to `refund-api`, which reads the list **live** on every
operation as `system:refund-api` (scope `accounting.reference.read`), keeps no copy across requests and copies onto each
line, by natural key, what it books. See `### Accounting (specs/20261119-accounting)` under Domain language.

`activities-api` is the ninth service and is **backend-only**: it has no remote, no `TOOLS` entry and
no screen of its own. It holds the activities, tasks and task blockers of two hosts — the CRM
(pre-sales, about a company) and Projects (operational, about a project) — and the CRM and Projects
screens call it directly through `shell/session` (specs/20261110-activities, ADR 20261110-activities-service-access-delegated-to-host). The CRM's activity timeline
and task list, the project's Tasks card and the **My tasks** page at `/projects/tasks` all read from it.

`hours-api` is the tenth service. It holds time entries — one person's own declaration of a duration, on one
day, on a project, a deal, a meeting or other work — and the categories and work types an admin manages. Its
screens are `hours-ui`'s (`/hours`); its permissions are `auth`'s `hours` catalog, which has **no `access`
resource** (the tool is ungated) and carries only `time-entry:read-all` and `time-list:manage`
(specs/20261112-time-tracking, ADR 20261112-hours-api-time-entries-own-service-hours-catalog, 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route, 20261112-hours-ui-ungated-remote).

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
│   │   │                            # App root + `./version`, ADR 20260803-suite-version-generated-file-federated-export — lives in vite.config.ts)
│   │   ├── hooks/
│   │   │   ├── useEstimator.ts      # All estimation computation logic
│   │   │   └── useImportOffer.ts    # One-time localStorage → estimai-api import offer
│   │   ├── lib/                     # api (apiFetch interceptor), authClient, estimatesApi,
│   │   │                            # collaboratorsApi, identity, ownerFilter, listFilters,
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
├── shell/               # Suite host (Module Federation) — shared chrome + session; mounts remotes (specs/20260709-suite-shell, ADR 20260709-suite-frontend-module-federation).
│   │                    # Also owns identity-scoped non-tool screens: /account (ADR 20260804-shell-identity-scoped-non-tool-screens-account-route), /notify (ADR 20260713-notification-center-standalone-service-shell-seam),
│   │                    # the notification bell + SSE manager + ToastHost, the About modal (ADR 20260803-suite-version-generated-file-federated-export), the
│   │                    # floating slot (`openFloating`/`closeFloating` in shell/session, FloatingHost; ADR 20261110-shell-floating-slot-for-remote-widgets) and
│   │                    # desktop push: the `/push-sw.js` service worker and the My profile push section (specs/20261111-push-notifications).
│   └── e2e/             # Playwright e2e for the WHOLE suite — every remote's journeys run through the
│                        # host, since a remote has no standalone authed bootstrap (specs/20260709-suite-shell retired
│                        # estimai-ui/e2e/ when it became a federated remote). helpers/: adminSession,
│                        # seedSession, estimaiFixtures, inviteFixtures, refundFixtures
├── refund-ui/           # Reimbursement tool — federated remote: expense requests, accounting review/decision,
│                        # monthly batch compile/pay (specs/20260716-refund-service, 008), and the Settings tab: mileage rates and the
│                        # accounting distribution email (specs/20260720-mileage-rate, 011; moved from admin-ui, ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition amendment);
│                        # + WellD CH accounting (specs/20261118-refund-accounting-export): Settings has two views, selected by `?section=` (`general`: mileage rates and the distribution email;
│                        # `defaults`: the default ledger account of each of the 14 expense types, chosen among Accounting's active entries; no VAT default of any kind), a classification panel on each
│                        # line of the review page (the VAT code is optional, "None" is a choice), receipt numbers on lines and batches, and an accounting export card (Excel workbook download) on the batch page. The two views need `settings:read`, their
│                        # writes `settings:manage`. The ledger accounts, VAT codes and exchange-rate views moved to accounting-ui (specs/20261119-accounting): the retired `?section=accounting` and
│                        # `?section=exchange-rates` fall back to `general`, and a note on the defaults view points to the Accounting app
├── admin-ui/            # Admin tool — federated remote: roles/departments/users/permissions/invitations GUI
│                        # (specs/20260713-auth-roles-permissions, 006, admin-only) + audit log, employee address (specs/20260803-employee-address, ADR 20260804-employee-address-auth-identity-attribute-1to1-table/0032)
│                        # and the waiting list: access requests from allowed-domain colleagues without an invitation, approved into an invitation or dismissed (specs/20261105-signup-gate, ADR 20261105-access-only-by-invitation-waiting-list/0072)
├── notify-ui/           # Notification center — federated remote: the /notify page, reached from the header bell (specs/20260713-notification-center, ADR 20260713-notification-center-standalone-service-shell-seam)
├── inventory-ui/        # Inventory tool — federated remote (port 5178): exposes ./App (gated, /inventory), ./MyDevices
│                        # (ungated, /devices; ADR 20261006-ungated-second-federated-entry-of-a-gated-remote) and ./version; calls inventory-api and auth's user directory
│                        # through shell/session (no VITE_* of its own) (specs/20261006-hardware-inventory)
├── crm-ui/              # CRM tool — federated remote (port 5179): exposes ./App (gated, /crm) and ./version; calls
│                        # crm-api, activities-api and auth's user directory through shell/session (specs/20261101-crm, ADR 20261101-crm-tool-shape-and-authorization/0053, 028)
├── meetings-ui/         # Meetings tool — federated remote (port 5180): exposes ./App (gated, /meetings), ./MyMeetings
│                        # (ungated, /my-meetings; ADR 20261104-meetings-tool-shape-visibility-by-participation), ./HostMeetings (panel embedded by hosts via shell/extensions,
│                        # ADR 20261104-host-extension-federated-panel-through-the-shell), ./RecorderDock (the shell's floating recorder widget, ADR 20261110-shell-floating-slot-for-remote-widgets) and ./version;
│                        # calls meetings-api and auth's user directory through shell/session
│                        # (specs/20261104-meetings)
├── projects-ui/         # Projects tool — federated remote (port 5181): exposes ./App (gated, /projects) and ./version; calls
│                        # projects-api, activities-api (project tasks, My tasks) and auth's user directory through
│                        # shell/session (specs/20261103-projects, 028, ADR 20261103-projects-tool-shape-and-authorization)
├── accounting-ui/       # Accounting tool — federated remote (port 5183; 5185 in the e2e preview): exposes ./App (gated, /accounting) and ./version; calls
│                        # accounting-api through shell/session (`VITE_ACCOUNTING_API_URL` is the shell's, no VITE_* of its own). Routes `/accounting/ledger-accounts`,
│                        # `/accounting/vat-codes`, `/accounting/exchange-rates`, each with `?entity=` (a person sees only the entities their grant covers; the switcher
│                        # appears with two or more) — add, deactivate and reactivate accounts and VAT codes, read and correct the monthly rates; write controls follow
│                        # `/v1/me` `canManage`, never `usePermissions()` (specs/20261119-accounting, ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…).
│                        # Moved from refund-ui with `git mv`
├── hours-ui/            # Hours (time tracking) — federated remote (port 5184): exposes ./App (UNGATED, mounted at the shell's
│                        # `/hours/$`, NOT a TOOLS entry; My hours, plus Everyone's hours for `time-entry:read-all`, ADR 20261112-hours-ui-ungated-remote) and
│                        # ./version; calls hours-api through shell/session (`getHoursApiBaseUrl()`, `VITE_HOURS_API_URL` is the
│                        # shell's) and, as the person, projects-api, crm-api, meetings-api and activities-api for its pickers (specs/20261112-time-tracking)
├── operai-ui/           # @operai/ui — the DESIGN SYSTEM (ADR 20261031-shared-ui-library-consumed-as-source): tokens/themes/fonts + component classes
│                        # (src/styles/tokens.css, re-exported by shell/tokens.css), React components (src/components),
│                        # Storybook (`mise run ui:storybook`), rules in docs/. NOT an app: never built or deployed;
│                        # the shell compiles its source and shares it with every remote as a Module Federation
│                        # singleton (`import: false` in the remotes, ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell). Used by every frontend
│
├── auth/                # Bun + Hono authentication service — invitation-only entry: sign-in creates a user only for an
│                        # allowed-domain (`ALLOWED_SIGNUP_DOMAINS`) email holding a live invitation (or the bootstrap admin, also allowed-domain only); an allowed-domain email without one joins a waiting list (`access_request`), an outside-domain one is refused (nothing recorded) (specs/20261105-signup-gate, ADR 20261105-access-only-by-invitation-waiting-list/0072)
│   ├── src/
│   │   ├── auth/        # better-auth config, middleware (requireAuth/requireAdmin), routes
│   │   ├── authz/        # authorization (specs/20260713-auth-roles-permissions, ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims): resolver, /authz/me, catalog, audit, seed; user directory (ADR 20261006-user-directory-endpoint-capability-gated) and the
│   │   │                 # `handoff:take`-gated holders listing `GET /authz/users/holders` (specs/20261103-projects-handoff, ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047)
│   │   ├── admin/        # admin API — roles/departments/users routes + last-admin guard; user soft-delete + bulk (specs/20260713-user-invitations)
│   │   ├── invitations/  # invitation lifecycle + admin API (create/list/resend/revoke); notify email trigger (specs/20260713-user-invitations, ADR 20260714-invitation-activation-hooks-soft-delete-lifecycle/0013)
│   │   ├── invite/       # hosted invite landing page (GET /invite, bilingual) + state JSON (specs/20260713-user-invitations)
│   │   ├── signin/      # hosted sign-in page (Google/GitHub)
│   │   ├── test-auth/   # dev/test-only session-mint endpoint (gated)
│   │   ├── jwks/        # JWKS endpoint (RS256 public key)
│   │   ├── health/      # Health check routes
│   │   ├── openapi/     # OpenAPI registry (zod-openapi + Scalar)
│   │   └── lib/         # db (Prisma), env validation, errors
│   ├── prisma/          # Schema + migrations (PostgreSQL)
│   └── package.json
│
├── estimai-api/         # Bun + Hono + TypeScript backend — estimate persistence (specs/20260606-estimate-persistence, ADR 20260703-estimate-persistence-jsonb-document/0005);
│                        # + record-level collaborator ACL, optimistic concurrency, live identity resolution
│                        # (specs/20260807-estimate-sharing, ADR 20260807-record-level-acl-resource-server-owned-access-primitive/0037/0038/0039/0040); + `GET /system/estimates/{id}/summary` for a
│                        # scoped service credential (specs/20261103-projects-handoff, ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential)
├── notify-api/          # Bun + Hono + TypeScript backend — notification persistence + SSE push, ticket-authed stream (specs/20260713-notification-center, ADR 20260713-sse-stream-auth-short-lived-ticket/0009); + email delivery channel via Resend, internal /system/emails (specs/20260713-user-invitations, ADR 20260714-notify-api-email-channel-service-trust); + internal /system/notifications for cross-user push (specs/20260716-refund-service, ADR 20260716-system-notifications-cross-user-trigger); + Web Push channel (VAPID, encrypted payloads) with user-JWT `/push/config` and `/push/devices` routes, off by default (`PUSH_ENABLED`, specs/20261111-push-notifications, ADR 20261111-web-push-encrypted-payloads-not-fcm/0085)
├── refund-api/          # Bun + Hono + TypeScript backend — reimbursement persistence; authorization-enforcing
│                        # resource server + EU object storage for receipts (specs/20260716-refund-service, ADR 20260716-refund-api-authorization-enforcing-resource-server/0015/0016);
│                        # + batch compile/PDF/paid lifecycle (specs/20260719-refund-monthly-processing, ADR 20260716-immutable-financial-audit-trail-refund–0022), mileage rates
│                        # (specs/20260720-mileage-rate, ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition/0024/0025), settings store (specs/20260722-refund-settings, ADR 20260722-refund-settings-append-only-self-auditing-store/0028/0029)
│                        # + WellD CH accounting export (specs/20261118-refund-accounting-export): `src/accounting/` (ledger accounts, VAT codes, defaults, classification, receipt numbers, the XLSX journal export) and
│                        # the one-off, operator-run `scripts/accounting-release.ts` (`bun run accounting:release [--dry-run] --offsets <csv> [--defaults <json>]`; `--offsets` is required, without it nothing is written and it exits 3), not in the Docker image
│                        # (infra/README.md § Release runbook)
│                        # + since specs/20261119-accounting refund-api keeps NO ledger accounts, VAT codes or exchange rates of its own: `src/accounting/accountingClient.ts` reads them live from
│                        # accounting-api (`ACCOUNTING_INTERNAL_URL`, required at startup; 10 s deadline, no cache across requests), a line carries a copy by natural key (account number and name,
│                        # VAT code and rate, exchange rate and month), `GET /accounting/options` feeds the pickers, and the fetch from the federal source moved to accounting-api
│                        # (`REFUND_FX_SOURCE` is removed). The per-type default accounts stay here (14 types, accounts only; since the 2026-11-19 sign-off there is no VAT default and no foreign-currency VAT designation)
├── inventory-api/       # Bun + Hono + TypeScript backend (port 8083, DB `inventory`) — hardware register; authorization-enforcing
│                        # resource server, entity-scoped (ADR 20260716-refund-api-authorization-enforcing-resource-server/0015 lineage); depreciation derived on read, closed years
│                        # snapshotted (ADR 20261006-depreciation-derived-on-read-closed-years-snapshotted); invoice files in its own EU bucket; pushes to notify-api with a scoped
│                        # service JWT (ADR 20261006-scoped-service-jwt-fourth-notify-caller). scripts/import-legacy.ts = one-off register import (specs/20261006-hardware-inventory)
│
├── crm-api/             # Bun + Hono + TypeScript backend (port 8084, DB `crm`) — companies, contacts, deals + pipeline,
│                        # offers; authorization-enforcing (crm:access, entity-scoped deal:manage, contact:erase),
│                        # optimistic concurrency via If-Match (specs/20261101-crm, ADR 20261101-crm-tool-shape-and-authorization). Its activities and tasks live in
│                        # activities-api since specs/20261110-activities; crm-api is the CRM host that answers activities-api's
│                        # `POST /activity-host/v1/resolve` and holds the scope `activities.write` for its `/system/v1/*`
│                        # calls; + `GET /system/deals` and `GET /system/contacts` for projects-api (specs/20261103-projects-handoff, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials/0094)
├── meetings-api/        # Bun + Hono + TypeScript backend (port 8085, DB `meetings`, single replica) — meetings, transcripts,
│                        # summaries, templates, cited Q&A; authorization-enforcing (`meetings:access`, `template:manage`,
│                        # `meeting:erase`) but creator/participant reads need only a JWT (ADR 20261104-meetings-tool-shape-visibility-by-participation); audio ONLY in its own EU
│                        # bucket (`MEETINGS_S3_*`, 29-day lifecycle verified at startup, ADR 20261104-audio-retention-bucket-lifecycle-verified-at-startup); in-process durable job
│                        # runner (ADR 20261104-durable-job-runner-work-queued-state-derived); Gemini (transcription) + Claude on Vertex AI, EU (ADR 20261110-meetings-transcription-gemini-on-vertex-eu/0069/0061); host contract
│                        # with crm-api (ADR 20261104-meeting-host-contract-resolve-and-notices); pushes to notify-api as `system:meetings-api` (specs/20261104-meetings)
├── projects-api/        # Bun + Hono + TypeScript backend (port 8086, DB `projects`) — projects, their team, terms and purchase
│                        # order, the Bexio order id; authorization-enforcing (projects:access, entity-scoped project:manage,
│                        # handoff:take, purchase-order:receive, purchase-order:bexio), If-Match on every write, no money; reads
│                        # CRM company names from crm-api with a scoped service credential (specs/20261103-projects, ADR 20261103-projects-tool-shape-and-authorization/0080); + the
│                        # to-start queue of won deals, taking a deal into a project + terms + purchase order, the deal's
│                        # estimate man-days, the PO's referent and ops-manager picker, all read live, and a notification to
│                        # the ops-manager (specs/20261103-projects-handoff, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials–0094); the Projects host of activities-api
│                        # (`POST /activity-host/v1/resolve`, specs/20261110-activities) — it never stores tasks
├── activities-api/      # Bun + Hono + TypeScript backend (port 8087, DB `activities`) — activities, tasks, task blockers and
│                        # the meeting mirror state for the CRM (pre-sales) and Projects (operational); NO permission catalog:
│                        # every access decision is asked of the host as the caller (`POST /activity-host/v1/resolve`),
│                        # failing closed; maintenance switch `ACTIVITIES_MAINTENANCE`; pushes to notify-api as
│                        # `system:activities-api`; scripts/import-crm-activities.ts = one-off CRM copy (specs/20261110-activities,
│                        # ADR 20261110-activities-service-access-delegated-to-host/0082/0083). No UI: backend-only
├── accounting-api/      # Bun + Hono + TypeScript backend (port 8089, DB `accounting`) — the accounting reference data of each legal entity: ledger accounts and VAT codes
│                        # (identified by number / code within an entity, never edited or deleted, only deactivated and reactivated) and the monthly average exchange rates (fetched on demand
│                        # from the AFC/ESTV's monthly average rates for VAT, served by the BAZG backend, or typed and corrected by a manager; `ACCOUNTING_FX_SOURCE=bazg|off`); authorization-enforcing (`accounting:read` / `accounting:manage`,
│                        # entity condition, no `access` action; `GET /v1/me` says which entities the caller covers and whether it manages them); user routes `/v1/entities/{entity}/…`;
│                        # one service-only read `GET /system/v1/entities/{entity}/reference-data` and `/rates` behind a scoped service JWT (scope `accounting.reference.read`, `sub`
│                        # allowlist, `aud=SERVICE_AUDIENCE`, one identical 401), the only consumer being refund-api. `scripts/seed-welld-ch.ts` (`bun run seed:welld-ch [--dry-run]`) is the
│                        # one-off, operator-run, optional load of WellD CH's signed-off list (19 ledger accounts, 6 VAT codes: IPM81, IPM77, IP00, BZM81, IPM26, IPM38) from `scripts/data/seed.welld-ch.json`; in the Docker image (`scripts/` is copied, its tests are not), so it runs inside the service
│                        # with `railway ssh` or from a checkout. Per-entity catalog cap (`CATALOG_CAPS`): at most 200 ledger accounts and 50 VAT codes per entity,
│                        # deactivated ones included; since entries are never deleted it is a lifetime limit, reached → 409 `catalog_full` {limit} (keeps the
│                        # reference-data answer well under refund-api's 256 KiB read cap; the operator seed does not check it)
│                        # (specs/20261119-accounting, ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…/20261119-on-demand-outbound-work-…)
├── letterhead-api/      # Rust (axum + tokio, Typst embedded as a library) backend (port 8088, DB `letterhead`, bucket
│                        # `letterhead`) — lays out a whole document for every tool; the ONE service that is not Bun/Hono/TypeScript
│                        # (ADR 20261116-letterhead-api-is-a-rust-service-with-typst-embedded-for-document-layout-only; see ### Rust service).
│                        # Cargo workspace: engine/ (pure) + api/ (HTTP supervisor); package.json is a Changesets shim only
│                        # (specs/20261116-letterhead-service)
├── hours-api/           # Bun + Hono + TypeScript backend (port 8088, DB `hours`) — time entries (a person's hours on a project, a deal,
│                        # a meeting or no entity), time categories and work types; own hours need only a JWT, everyone's hours is the
│                        # oversight path (`time-entry:read-all`, live, fail closed), the lists need `time-list:manage` (ADR 20261112-hours-api-time-entries-own-service-hours-catalog);
│                        # whether a person may record on a project, deal or meeting is asked of its owner as the caller, failing
│                        # closed (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route); reads a meeting's current deal from meetings-api `GET /system/meetings/hosts` with its own
│                        # service credential (scope `meetings.hosts.read`); no If-Match, no notifications (specs/20261112-time-tracking)
├── .railway/           # railway.ts — the Railway project as code (services, Postgres, buckets, domains, build/deploy,
│                        # replicas, EU region); variables unmanaged; plan → apply by a person (ADR 20261113-railway-infrastructure-as-code)
├── docs/adr/            # Architecture Decision Records (0001–0094; see ## Architecture decisions)
├── docs/ui-inconsistencies.md  # UI/UX audit across the six frontends, with what each migration fixed
├── infra/               # Deploy/verify scripts + the cross-service env contract notes (README.md);
│                        # provision-tool.sh audits/applies one tool's Railway IaC block, creates its database, Vercel project and DNS
│                        # (runbook: .claude/skills/provision-tool); meetings-bucket-policy.sh applies/verifies the audio
│                        # bucket's 29-day lifecycle rule, versioning off and CORS (specs/20261104-meetings)
├── tools/env-doctor/    # Pre-deploy cross-service env-contract checker (`mise run env:doctor`)
├── scripts/             # Release tooling — version.mjs (umbrella bump), tag.mjs, check-changeset.mjs
├── .github/workflows/   # changeset-check.yml, env-doctor.yml
├── compose.yaml         # Local PostgreSQL 17 (host port 5435) + MinIO (S3 :9000, console :9001)
├── lerna.json           # The package list Changesets reads — NOT a pnpm/Bun workspace (see ### Git)
├── mise.toml            # Node 24, corepack-managed pnpm, Rust 1.100.0 (letterhead-api); `mise run dev` / `dev:letterhead` / `db:migrate` / `changeset` /
│                        # `release:version` / `release:tag` / `env:doctor`
└── specs/               # Spec-driven workflow (YYYYMMDD-slug; 20261006-hardware-inventory, 20261101-crm and 20261112-time-tracking are in progress; see below)
```

---

## Tech stack

### Frontends (shell, estimai-ui, refund-ui, admin-ui, notify-ui, inventory-ui, crm-ui, meetings-ui, projects-ui, letterheads-ui, accounting-ui, hours-ui)
All of them share one stack. Each is installed and deployed on its own (no npm workspace).

- **Runtime:** Node 24 via mise (pnpm via corepack, see `mise.toml`)
- **Package manager:** pnpm
- **Framework:** Vite 8 + React 19 (TypeScript)
- **Composition:** Module Federation (`@module-federation/vite`) — the shell is the host, the
  others are remotes whose URLs resolve at runtime per-env, never build-baked (ADR 20260709-suite-frontend-module-federation)
- **Routing:** TanStack Router
- **Auth/session:** better-auth client; in-memory JWT + `apiFetch` interceptor, owned by
  `shell/session` and reused by every remote (ADR 20260607-jwt-in-memory-never-web-storage/0002)
- **Testing:** Vitest (unit/component) per app; e2e for the WHOLE suite lives in `shell/`
  (`cd shell && pnpm e2e`) — a federated remote has no standalone authed bootstrap, so its
  journeys run through the host
- **Fonts:** DM Sans, DM Mono, Syne (Google Fonts)
- **Styling:** Tailwind CSS 4
- **Design system:** `@operai/ui` (`operai-ui/`, ADR 20261031-shared-ui-library-consumed-as-source) — tokens, themes, component classes and
  React components, compiled from source by the shell and shared with every remote as a Module
  Federation singleton — remotes declare it with `import: false` and never bundle it; each app
  resolves it through a `link:../operai-ui` devDependency, never a Vite alias (an alias bypasses the
  sharing); `resolve.dedupe` + tsconfig `paths` as before (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell; see `operai-ui/README.md`);
  the rich-text entry is still compiled by each remote that uses it (TipTap is not in the shell);
  showcased in its own Storybook 10
- **Lint/format:** ESLint 9 (flat config) + Prettier
- **Deploy:** Vercel, one project per frontend (auto-deploy on push to `main`)

estimai-ui additionally uses:
- **Tables:** TanStack Table v8; **drag & drop:** `@dnd-kit`
- **Export:** none. The XLSX, client XLSX and PDF exports were removed on 2026-11-23
  (owner: they no longer worked and nobody needed them), with `exceljs`, `xlsx`, `jspdf`
  and `jspdf-autotable`. What stays is the estimate as JSON: the editor's Export JSON
  (`lib/projects.ts` `exportProjectToJson`) writes the file the list's Import JSON reads back, and
  the editor's Import JSON replaces an open estimate's parameters, releases and activities with a
  file's (its `name` and `author` ignored; asks first when activities would be lost; editors only).
- **Sharing:** account-based collaborators only (specs/20260807-estimate-sharing). The anonymous
  link share (`lz-string` payload in a URL fragment + `qrcode`) was removed on
  2026-08-09 — an estimate is never viewable without an Operai account.

admin-ui additionally calls the Google Places API (New) browser-direct with a
referrer-restricted key for address autocomplete — never proxied through `auth`, and it
degrades silently when the key is absent (ADR 20260804-google-places-browser-direct-referrer-restricted-key).

hours-ui additionally builds its XLSX export in the browser (`exceljs`, lazy-loaded, from every page of
`GET /time-entries` — hours-api never builds a file) and uses the `@operai/ui` components and formatters added
for it: `SearchPicker` (a server-side search in a `Field`-wrapped `Combobox`), `ExportButton`, and
`formatDuration`'s `short` style ("2 h 30") and `formatMonth` (specs/20261112-time-tracking).

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
- **System endpoints' limits (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service):** `POST /system/service-token` and
  `POST /system/users/contact` verify the credential first, then count against the verified calling
  service only — 300 tokens (`SERVICE_TOKEN_SERVICE_LIMIT`) and 600 contact lookups
  (`USERS_CONTACT_SERVICE_LIMIT`) per service per window (`SYSTEM_RATE_WINDOW_MS`, 10 min) — plus one
  per-source-address count of 20 invalid credentials (`SYSTEM_INVALID_CREDENTIAL_LIMIT`) shared by both
  routes. One byte-identical 429 with `Retry-After`. `SERVICE_TOKEN_RATE_*` are retired and ignored (env-doctor flags them).

### Resource backends (estimai-api, notify-api, refund-api, inventory-api, crm-api, meetings-api, projects-api, activities-api, accounting-api, hours-api)
All ten share the `auth` service's shape (see ADR 20260703-estimai-api-bun-hono-typescript — one backend stack across the monorepo, with ONE exception, the Rust `letterhead-api`: see **### Rust service**;
it supersedes the earlier Kotlin/Spring intention). Six are implemented; `meetings-api` is in
progress (specs/20261104-meetings); `hours-api` is in progress (specs/20261112-time-tracking).

- **Runtime/framework:** Bun + Hono + `@hono/zod-openapi` (Scalar API reference)
- **Persistence:** Prisma 7 + PostgreSQL, own logical DB per service
- **Auth:** JWKS resource servers — verify the `auth` service's RS256 JWT via its JWKS
  endpoint, pinned to RS256 + issuer, and **require `AUTH_AUDIENCE`** to check the `aud`
  claim or they reject every token with 401 (ADR 20260703-jwt-resource-server-remote-jwks/0010)
- **Errors:** Effect TS; RFC 7807 Problem JSON
- **Deploy:** Railway, EU region (data residency requirement)

Per-service specifics:
- `estimai-api` — estimate persistence as a JSONB document + listing columns (ADR 20260703-estimate-persistence-jsonb-document);
  record-level collaborator ACL owned by the service itself, not `auth`'s catalog (ADR 20260807-record-level-acl-resource-server-owned-access-primitive);
  optimistic concurrency via integer `version` + required `If-Match`/`ETag` (ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004).
  It deliberately is **not** an authorization-enforcing resource server, with ONE exception
  (specs/20261108-estimate-list-oversight, ADR 20261108-estimai-oversight-permission-amends-0036): read-only oversight of every estimate for holders of `estimate:read-all`
  (seeded to `admin`), resolved live from `auth` only on that path and failing closed there.
  It stores the CRM deal an estimate belongs to (`crmDealId`), set only by crm-api's
  deal-link notices (ADR 20261108-crm-pushes-deal-links-to-estimai).
  Its other `/system/*` route, `GET /system/estimates/{id}/summary` (scope `estimai.estimates.read`,
  `SERVICE_AUDIENCE` JWT only), is read by projects-api and returns `{ id, name, manDays }`, never
  the estimate's content (specs/20261103-projects-handoff, ADR 20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential).
- `inventory-api` — hardware register (specs/20261006-hardware-inventory): authorization-enforcing like `refund-api`
  (live `auth GET /authz/resolve`, fails closed, entity-scoped ABAC) with `inventory:access`,
  `asset:manage`, `ledger:manage`; `/me/*` routes need only a valid JWT and scope to `sub`
  (ADR 20261006-ungated-second-federated-entry-of-a-gated-remote); depreciation derived on read, immutable snapshots on fiscal-year close
  (ADR 20261006-depreciation-derived-on-read-closed-years-snapshotted); invoice files in its OWN EU bucket via presigned URLs (`INVENTORY_S3_*`);
  a notify caller, authenticating with a 5-minute scoped service JWT (`notifications.push`
  only) from `auth POST /system/service-token` (`SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET`;
  ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049). Service tokens are signed by better-auth's rotating key published at
  `/auth/jwks`, not by `JWT_PRIVATE_KEY`.
- `crm-api` — CRM (specs/20261101-crm): authorization-enforcing (live `/authz/resolve`, fails closed) with
  `crm:access` (read everything, edit companies/contacts/activities), entity-scoped `deal:manage`
  (403 `out_of_scope`, not 404 — deals are readable, ADR 20261101-crm-tool-shape-and-authorization) and `contact:erase`; If-Match/ETag
  on company, contact and deal writes; owner/assignee ids checked as CRM users against `auth`
  (fail closed); money only with `deal:financials` (ADR 20261101-crm-financial-visibility-permission); estimates via estimai-api with
  the caller's JWT, offers and attachments in its own EU bucket (`CRM_S3_*`, specs/20261101-crm-sales-flow); offers are contracts
  rendered from per-entity, editable templates on the entity's letterhead, numbered `NNNN/YYYY[rN]`,
  with deal PDFs appendable as annexes (specs/20261102-crm-offer-document, ADR 20261102-crm-api-reads-attachment-bytes-for-offer-annexes);
  pushes CRM notifications to notify-api as `system:crm-api`, with email notices for handovers
  (specs/20261101-crm-notifications, ADR 20261101-notify-api-resolves-email-notice-address-from-auth); verifies meetings-api's host notices (scope `host-notices.send`,
  `aud=SERVICE_AUDIENCE`) and answers its `resolve` calls as the caller (specs/20261104-meetings, ADR 20261104-meeting-host-contract-resolve-and-notices; since
  specs/20261112-time-tracking `entityType: "deal"` too, with `involved` — the owner and the technical contact — for
  hours-api, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route); its
  `GET /system/companies` is read by projects-api behind the scope `crm.companies.read` (specs/20261103-projects, ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential), as is `GET /system/deals`
  behind `crm.deals.read` (won deals, no money, specs/20261103-projects-handoff, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials) and `GET /system/contacts` behind
  `crm.contacts.read` (a PO's referent: one minimal shape per mode, `ids` ≤ 20, ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047); its deal page
  reads the deal's project and Bexio order id from projects-api (`GET /system/purchase-orders`, scope
  `projects.purchase-orders.read`) as `system:crm-api` and fails soft (`deliveryKnown`)
- `meetings-api` — Meetings (specs/20261104-meetings): authorization-enforcing, but content is visible by
  relationship to the record, never by role (creator / Operai participant / opted-in host reader;
  anything else 404, ADR 20261104-meetings-tool-shape-visibility-by-participation) — `selfScoped` reads need only a valid JWT and survive an `auth`
  outage, every create/generate/ask/edit is `capability(...)` live and fails closed, with
  `meetings:access` (granted to every `employee` by default, ADR 20261104-default-employee-grant-meetings-access), `template:manage` and
  `meeting:erase` (admin only, erase never reads content); audio ONLY in its own EU bucket
  (`MEETINGS_S3_*`) behind a bucket-wide 29-day lifecycle rule that is verified at startup
  (ADR 20261104-audio-retention-bucket-lifecycle-verified-at-startup); transcription by `gemini-3.8-flash` on Vertex AI (`eu`), a meeting up to 30 minutes in one request, audio
  inline, reply validated as structure (ADR 20261110-meetings-transcription-gemini-on-vertex-eu; Chirp 3 batch through a transient EU bucket kept behind
  `MEETINGS_TRANSCRIBER=chirp`, ADR 20261105-meetings-ai-providers-google-cloud-eu), longer recordings in 30-minute overlapping parts, labels joined only on text evidence
  and separable by the creator, gaps detected and marked (ADR 20261105-meetings-ai-providers-google-cloud-eu/0070/0074), and summaries/Q&A by Claude on Vertex AI (`eu` multi-region, never `global`),
  every setting Google exposes checked at startup and the rest a recorded sign-off (ADR 20261105-meetings-ai-providers-google-cloud-eu/0061); an
  in-process Postgres job runner for asked-for work, so it runs as a single replica (ADR 20261104-durable-job-runner-work-queued-state-derived);
  the THIRD reader of bucket bytes, bounded (ADR 20261104-meetings-api-reads-audio-bytes-third-reader); model output is validated structure and
  plain text only (ADR 20261104-ai-output-structured-validated-plain-text); pushes to notify-api as `system:meetings-api` (`notifications.push`)
  and notices to the host as the same principal (`host-notices.send`), ADR 20261104-meeting-host-contract-resolve-and-notices/0065; for hours-api
  (specs/20261112-time-tracking, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route) `GET /meetings?ids=` narrows the caller's own meetings (a host-only reader's is
  absent) and its FIRST `/system/*` route, `GET /system/meetings/hosts` (`ids=` or `dealId=`; scope
  `meetings.hosts.read`, `sub` `system:hours-api` only, `aud=SERVICE_AUDIENCE`, one identical 401), answers
  each meeting's current host as `{id, host}` and nothing else — never a title, participant or content
- `projects-api` — Projects (specs/20261103-projects, 026): authorization-enforcing (live `/authz/resolve`, fails closed) with
  `projects:access` (read every project, its terms and purchase order), entity-scoped `project:manage` (403
  `out_of_scope`, not 404 — records are readable, ADR 20261101-crm-tool-shape-and-authorization posture), `handoff:take` (sales, own entity; the
  to-start queue and the take), `purchase-order:receive` (ops-manager, own entity; admin unconditioned = the
  override `oversees`, via `scopeFor`, never `hasCapability`) and `purchase-order:bexio` (the Bexio order id, its
  own route, held by `accounting`; ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047); If-Match/ETag on every write on a project, its terms or its PO,
  creates excepted (ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004); a project has 0..1 terms and 0..1 purchase order, a PO born only from a won deal
  and never deleted (a hand-made project may carry terms, never a PO; "contract" is retired, ADR 20261105-terms-and-purchase-order-two-optional-records-of-a-project-contract-retired); no money
  anywhere; PM and team ids checked as module users against `auth` (fail closed); CRM company names via crm-api
  with its own service credential, `name: null` when the CRM cannot answer and 503 `crm_unavailable` on a write
  that must confirm a company (ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential); ids are text cuids (ADR 20261103-projects-tool-shape-and-authorization); the to-start queue (`GET /queue`) and
  taking a deal (`POST /queue/{dealId}/project`, `handoff:take` + `project:manage` for the deal's entity) read
  the deal live from crm-api and never sync it; the take's ops-manager is chosen from auth's holders listing
  (live, fail closed) and notified after the commit through notify-api (`NOTIFY_INTERNAL_URL`, best effort); a
  fixed-price PO from a deal copies its estimate's man-days from estimai-api once and the client never sets them
  (ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials/0092); the PO's referent is a CRM contact id read live from crm-api, never stored or cached
  (`no-store`, ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047); a project from a deal awaits its project manager until the ops-manager (or an admin)
  picks one; `GET /system/purchase-orders` serves crm-api behind `projects.purchase-orders.read`; answers activities-api's
  `POST /activity-host/v1/resolve` for entity type `project` (specs/20261110-activities), whose `assignees` (project manager and
  team) are also what tells hours-api who may record hours on a project (specs/20261112-time-tracking), and meetings-api's
  `POST /meeting-host/v1/resolve` (a project's team are its host readers; no notices, specs/20261104-meetings A18)
- `activities-api` — activities, tasks and blockers of the CRM and Projects (specs/20261110-activities): a JWKS resource
  server with **no permission catalog** — who may read or change an activity is asked of the host as the
  caller on every request (`POST /activity-host/v1/resolve` on crm-api or projects-api with the forwarded JWT,
  2 s, never cached), fails **closed** (503 `host_unavailable`), and a record the caller may not read is a 404
  identical to a nonexistent one (ADR 20261110-activities-service-access-delegated-to-host); ids are opaque text (imported CRM cuids kept unchanged, crm-api's caller-chosen ids UUID v4; ADR 20261110-caller-chosen-ids-replace-cross-service-transactions); a write that used to
  share a crm-api transaction is an idempotent call under a caller-chosen id, compensated on failure, and
  crm-api reaches `/system/v1/*` (estimate task, completion, meeting mirror, contact erase) with a scoped service
  JWT (scope `activities.write`, `sub` `system:crm-api`, `aud=SERVICE_AUDIENCE`, ADR 20261110-caller-chosen-ids-replace-cross-service-transactions); the maintenance switch
  `ACTIVITIES_MAINTENANCE=true` makes every route except `GET /health` answer 503 `maintenance` (ADR 20261110-activities-migration-write-pause);
  notifies as `system:activities-api` (`notifications.push emails.send`, bound by notify-api to the origins `crm`
  and `projects`; best effort, the write stands); a task has a rich `description` (TipTap JSON) and files —
  images inside it, attachments under it — in activities-api's OWN EU bucket `activities` (`ACTIVITIES_S3_*`,
  presigned POST/GET, images named by file id never by URL, object deleted before its row, ADR 20261113-task-description-files-in-activities-api-bucket); port 8087,
  DB `activities`; the one-off
  `scripts/import-crm-activities.ts` copies the CRM's activities in (dry run by default, found-vs-present report);
  `GET /activities?ids=` (≤ 50, a fifth "exactly one of" filter, each id's host asked as the caller, an
  unreadable id omitted exactly like a missing one) is how hours-api checks an activity pointer (specs/20261112-time-tracking)
- `hours-api` — Time tracking (specs/20261112-time-tracking): **ungated** — the `hours` catalog has no `access` resource, so a
  person's own hours need only a valid JWT: every query is scoped to the verified `sub`
  and an entry that is not theirs is a 404 identical to a nonexistent one (ADR 20261112-hours-api-time-entries-own-service-hours-catalog). Two permissions, both
  unconditioned, seeded to `admin` only and in neither user-directory gate (ADR 20261104-user-directory-gate-meetings-access): `time-entry:read-all`
  (see everyone's hours) is the **oversight path** (`whose=all` or a `userId` filter, ADR 20261108-estimai-oversight-permission-amends-0036 shape) —
  resolved live from `auth GET /authz/resolve` ONLY there, a grant never remembered, 503 `authz_unavailable` on
  an `auth` outage, and a holder never writes someone else's entry (403 `owner_only`); `time-list:manage` is
  live and fails closed on every write to the categories and work types (retire and restore, never delete;
  names unique per list, case-insensitively). An entry is a duration in whole 30-minute steps (30 min–24 h) on
  one real day not in the future, never a time of day, on a project, a deal, a meeting or no entity (then with
  a category); it has one writer, so no `If-Match` (ADR 20261112-hours-api-time-entries-own-service-hours-catalog). Whether a person may record on a project
  (`assignees` of projects-api's host resolve), a deal (`involved` of crm-api's, or assignee/participant of one
  of its activities from activities-api) or a meeting (creator or participant from meetings-api) is asked of
  the owner as the caller, with the forwarded JWT, at write time and fails closed (403 `not_on_project` /
  `not_involved_in_deal`, 503 `host_unavailable`, never decided from a copy; ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route). A meeting's current
  deal is read live from meetings-api `GET /system/meetings/hosts` with hours-api's OWN credential (client
  `hours-api`, scope `meetings.hosts.read`, `aud=SERVICE_AUDIENCE`, pair `SERVICE_CLIENT_ID` /
  `SERVICE_CLIENT_SECRET` and `SERVICE_AUDIENCE` ≠ `AUTH_AUDIENCE`), so a fact read that way reaches a viewer only
  together with that viewer's own right to read the deal (id and name, or neither); labels follow the viewer's
  access and totals (`GET /time-entries/totals`, `groupBy` person, project, deal, category, month or day) merge
  what the viewer cannot name into one `hidden` / `unavailable` / `deal-unknown` group (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route § 6, A1). A
  `dealId` filter is refused 503 while meetings-api cannot say which meetings are linked, never answered low
  (AC-4.11); port 8088, DB `hours`, no object storage, sends no notification. It holds personal data about
  workers: informing employees is a go-live sign-off owned by management / HR (specs/20261112-time-tracking O3)
- `notify-api` — notification persistence + ticket-authed SSE stream (ADR 20260713-sse-stream-auth-short-lived-ticket); pinned to a
  single production instance (in-process ticket store + fan-out); email channel via Resend;
  internal `/system/emails` (scope `emails.send`) + `/system/notifications` (scope
  `notifications.push`), each behind a scoped service JWT verified via `auth`'s JWKS with
  `aud=SERVICE_AUDIENCE`; every caller authenticates as itself (`auth` mints its own in
  process, ADR 20261013-auth-mints-own-service-credential-in-process; `refund-api`, `estimai-api`, `inventory-api`, `crm-api`, `meetings-api`, `projects-api` and
  `activities-api` via the service-token endpoint; `system:projects-api` may raise `projects` notifications only,
  specs/20261103-projects-handoff) and the shared `X-Internal-Token` is refused (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired); for an
  `email: true` notification it looks the recipient's address up in `auth`
  (`POST /system/users/contact`, as `system:notify-api`, ADR 20261101-notify-api-resolves-email-notice-address-from-auth); a principal raises only the origins it is
  bound to (`system:crm-api` → `crm`, `system:activities-api` → `crm` and `projects`,
  `system:projects-api` → `projects`); a **Web Push channel**
  (specs/20261111-push-notifications, ADR 20261111-web-push-encrypted-payloads-not-fcm/0085): standard Web Push with encrypted payloads (no FCM), sent after the in-app row is
  stored, best effort, one row per browser in `push_device`; user-JWT routes `GET /push/config`,
  `PUT`/`GET /push/devices` and `DELETE /push/devices/{id}` scoped to `sub`; a recipient `auth` reports inactive
  loses their devices, an unanswered check sends nothing; the liveness answer `active` is remembered 30 s per user (single flight, ADR 20261112-push-liveness-answer-reused-30-seconds) and sends go through a bounded pool (16 concurrent, 1 000 queued, 100 per recipient), a full queue dropping the push. Env: `PUSH_ENABLED` (literal `true`, default off, needs
  the email-notice group too), `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`, `PUSH_EXCLUDED_ORIGINS`;
  rotating the keys invalidates every subscription (infra/README.md § Push notifications). The shell serves
  `/push-sw.js` and shows nothing while an Operai tab is visible, except on Safari, which always shows
- `refund-api` — the suite's authorization-enforcing resource server: resolves the caller's
  live permissions from `auth GET /authz/resolve` on every request, fails **closed** on an
  `auth` outage (ADR 20260716-refund-api-authorization-enforcing-resource-server); entity-scoped ABAC (ADR 20260716-entity-scoped-abac-refund-api); EU-region S3-compatible object
  storage for receipts, reached only via presigned URLs (ADR 20260716-eu-object-storage-refund-attachments); DB-level append-only
  audit/rate/settings tables (ADR 20260716-immutable-financial-audit-trail-refund/0024/0027); WellD CH lines carry an accounting
  classification (an account; the VAT code is optional and never pre-set), a receipt number and a CHF amount, and a batch has an Excel (XLSX) journal export for accounting (specs/20261118-refund-accounting-export,
  the 20261118 ADRs at the end of this file). Approvals answer 409 `accounting_release_pending` until `bun run accounting:release` has run
  once against the refund database, with the list of last hand-issued 2026 receipt numbers (`--offsets`, required: without it nothing is written, exit 3; the 2026 numbering continues the paper register); the e2e global setup runs it (see § Running locally, e2e). Since specs/20261119-accounting the ledger
  accounts, VAT codes and monthly rates are **not** Refund's: it reads them live from `accounting-api` as `system:refund-api`
  (`ACCOUNTING_INTERNAL_URL`, required at startup, scope `accounting.reference.read` in auth's `SERVICE_CLIENTS` (plus `users.contact` only for the production release window, removed after it, T84), one 10 s deadline per operation, no cache),
  answers 503 `accounting_unavailable` when it cannot read them rather than guess, and approves, classifies and exports from the **copy** each line carries
  (ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…, ADR 20261119-on-demand-outbound-work-…)
- `accounting-api` — the owner of the accounting reference data (specs/20261119-accounting): a JWKS resource server (`AUTH_JWKS_URL`, `AUTH_ISSUER`,
  `AUTH_AUDIENCE`) that resolves the caller's `accounting:read` / `accounting:manage` live from `auth GET /authz/resolve` and fails **closed** on an `auth`
  outage; `manage` includes `read`; both carry the `entity` condition, so a manager of WellD CH only sees and changes WellD CH, and a request for an entity the
  caller does not cover is a 404. Its service read (`/system/v1/*`) takes only a scoped service JWT, never a user token: `aud=SERVICE_AUDIENCE` (required, different from
  `AUTH_AUDIENCE`), scope `accounting.reference.read`, `sub` allowlisted to `system:refund-api`, GET only, `Cache-Control: no-store`. Fetches the monthly rates on demand
  from the one fixed BAZG host, the channel of the AFC/ESTV's monthly average rates for VAT (`ACCOUNTING_FX_SOURCE=bazg`, default; `off` makes no outbound call and records every attempt as `disabled`, for the e2e and offline dev;
  the host is a constant, never configuration), on a budget of 6 s inside refund-api's 10 s. Port 8089, DB `accounting`; the one-off `bun run seed:welld-ch`
  loads WellD CH's signed-off list (19 accounts, 6 VAT codes) and is optional (accounting may type it in the app)

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
| `oversight` | Read-only access to an estimate through the `estimate:read-all` permission, with no owner/collaborator relationship; a wire value only, never stored (ADR 20261108-estimai-oversight-permission-amends-0036) |
| `closed` | An estimate closed by its owner or an editor: read-only until reopened, and listed under **Closed** instead of the default **Open** list (archive and close are one status, specs/20261108-estimate-list-oversight) |

### Refund (Rimborsi)

| Term | Meaning |
|---|---|
| `request` | One employee's reimbursement claim — the unit of review, decision and audit |
| `line` | A single expense on a request: `type`, `entity`, `currency`, amount (and `km` iff `travel_km`) |
| `status` | `draft` → `submitted` → `approved`/`rejected` → `paid` (terminal, ADR 20260719-refund-batch-paid-lifecycle-extension) |
| `entity` | The wellD legal entity a line belongs to — `welld_it` \| `welld_ch`; drives ABAC scope (ADR 20260716-entity-scoped-abac-refund-api) |
| `batch` | A monthly payout compilation of approved requests — `compiled` \| `paid` \| `discarded` |
| `mileage rate` | Per-entity, effective-dated €/km series; a `travel_km` line snapshots it at submit (ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition) |
| `line rejection` | A reviewer refuses ONE line of a `submitted` request, with a required reason: approved total 0, restorable until the request is decided, cleared on withdraw; a request whose every line is rejected cannot be approved (specs/20260716-refund-service, 2026-11-10) |
| `ledger account` | One account of WellD CH's chart of accounts a line is booked to (`5905`, `2620.1`), **kept in Accounting** (added, deactivated and reactivated there by an accounting manager, never edited or deleted); a line keeps a copy of the number and name it was classified with (ADR 20261118 classification, specs/20261119-accounting) |
| `VAT code` | A code with one fixed rate (`IPM81` = 8.1 %; the signed-off six are `IPM81`, `IPM77`, `IP00`, `BZM81`, `IPM26`, `IPM38`), **kept in Accounting** with the same lifecycle as a ledger account; the rate is never edited, a new rate is a new code. **Optional on a line and never pre-set**: nothing defaults it, a line without one is approved, released and exported like any other, and the VAT amount exists only with a code; a line keeps a copy of the code and rate when one is set |
| `classification` | The ledger account (required) and the optional VAT code of a WellD CH line: the account is the live default of its expense type until approval, the VAT code only what was set by hand, frozen in the approval transaction as a copy, changed afterwards only with `request:reclassify` and never once the request is paid; WellD Italia lines have none. The options offered are Accounting's active WellD CH entries; when Accounting cannot be read, a change or approval is refused, never guessed |
| `expense type` | One of the 14 fixed types of a line (the paper form's, plus `travel_flight` and `travel_taxi`; `representation_meals` is labelled "Meals with clients" / "Pranzi/cene con clienti"); each has a default ledger account in Settings (account only), `representation_gifts` has none |
| `receipt number` | `MC26/014`: the employee's two initials, the year of the expense date, a running number per employee and year, issued when the request is approved, never reused or changed (ADR 20261118 receipt numbers) |
| `monthly average rate` | CHF for 1 unit of EUR, USD or GBP in a completed month, **kept in Accounting**: from the AFC/ESTV's monthly average rates for VAT (the "XML-File" the BAZG serves; the id `bazg` names the channel) fetched on demand or typed by an accounting manager; a fetched rate is recorded once, a correction is an appended row that wins (ADR 20261118 exchange rates); a line keeps a copy of the rate and its month |
| `accounting export` | The XLSX journal workbook (`Date, Description, Debit, Credit, Amount, Currency, Tax, Note`; one row per approved WellD CH line, `FORMAT_VERSION` 2, deterministic bytes from an in-repo writer, text never a formula) of a compiled or paid batch, generated on request and never stored, every download logged; refused with 409 while a rate, a classification or a number is missing; needs `request:review` with a scope covering `welld_ch` |
| `accounting release` | The one-off `bun run accounting:release` after refund-api is deployed: reads Accounting first (exits 2 and writes nothing when it cannot), seeds Refund's 14 type default accounts from `--defaults <json>` where nothing exists (no VAT default, no designation; it creates no catalog: the list is loaded in Accounting by `seed:welld-ch`), loads the **2026 numbering baseline** from `--offsets <csv>` (**required**: without it nothing is written and it exits 3; a header-only file says "no employee has a hand-issued number"), numbers the legacy WellD CH lines by expense date, writes the marker that lets approvals through; idempotent, `--dry-run` first |
| `2026 baseline` | The last receipt number each employee issued by hand in the paper register for 2026, supplied by email address at release (the list is a release input kept outside the repository; `receipt-baseline:from-register` helps derive it): the first 2026 number Refund issues is that sequence plus one (`MC26/082` after 81). Only 2026 is continued; 2027 starts at `001` (ADR 20261118 receipt numbers) |
| `copy` | The values Refund records on a line when it classifies or approves it: ledger account number and name, VAT code and rate and, for a foreign-currency line, the exchange rate with its month. A copy never changes when Accounting changes; the CHF and VAT amounts and the export are computed from it (specs/20261119-accounting) |
| `rate pending` | An approved WellD CH line in a currency other than CHF whose month had no rate in effect at approval, so no rate is copied yet; it is copied at the first successful export, which is refused with the missing rate named until then |
| `Manage includes Read` | Whoever may manage Accounting's data may also read it: `accounting:manage` covers every entity `accounting:read` would (see Accounting below). Refund shows its Accounting links and rate links by this rule (`viewer.canOpenAccountingRates`) |

Money is always integer minor units (cents); mileage rates are integer micros (ADR 20260720-mileage-rate-money-precision-integer-micros).

### Accounting (specs/20261119-accounting)

| Term | Meaning |
|---|---|
| `Accounting` | The suite module (capital A) that keeps the accounting reference data and shows it in its own app. Lower-case "accounting" keeps its Refund meaning: the team and role that review and classify expenses |
| `reference data` | The ledger accounts, VAT codes and monthly average exchange rates kept in Accounting |
| `entity` | A legal entity of the group (`welld_ch`, `welld_it`) with an **own currency** (CHF, EUR). Accounts and VAT codes belong to exactly one entity and are identified by number or code **within it**: the same number in two entities is two accounts; Refund and every other consumer refer to them by this natural key, never by an id |
| `active` / `deactivated` | Whether an entry is offered for new use. A deactivated entry stays in the lists, with its history, and can be reactivated; there is no edit and no delete (a VAT code's rate never changes) |
| `option` | An active entry offered to a person who has to choose one |
| `monthly average rate` | The average rate of a foreign currency to the entity's own currency for one calendar month; for WellD CH: EUR, USD, GBP to CHF. The **rate in effect** is the latest correction, else the fetched rate. WellD Italia has no official source yet (an empty state, not an error) |
| `published` | A month's rate counts as published from the 5th day of the following month (Europe/Zurich), because the source answers provisional values before that; earlier it is shown as missing and not fetched |
| `Accounting read` / `Accounting manage` | The two capabilities, `accounting:read` and `accounting:manage`, each grantable with the entity condition. **Manage includes Read.** There is no `accounting:access`: the tool appears for a person whose `read` or `manage` covers at least one entity (`apps ∋ accounting`, derived in `/authz/me`); `admin` holds both unconditioned, the `accounting` role both for WellD CH |
| `accounting manager` / `accounting reader` | A person who holds Accounting manage for an entity / read but not manage |
| `consumer` | A module that reads Accounting's data: Refund, the only one for now; it reads live as `system:<service>` with scope `accounting.reference.read` and keeps a copy of what it books (see Refund: `copy`) |
| `unreachable` | Accounting does not answer in time, answers with an error, or answers with something the consumer cannot read: the consumer refuses the operation (`503 accounting_unavailable`) instead of deciding from a stale guess |

### Identity & authorization (auth)

| Term | Meaning |
|---|---|
| `permission` | A `(resource, action)` pair from the per-app catalog, e.g. `request:approve` |
| `role` | A named bundle of permissions, optionally attribute-conditioned |
| `department` | An org grouping used to assign roles in bulk |
| `access` | The `(appId, "access")` permission that gates whether a tool appears at all |
| `perm_epoch` | JWT claim bumped on any grant change — forces live permission re-resolution (ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims) |
| `invitation` | A pending email-matched grant; `expired` is derived on read, never written (ADR 20260714-invitation-lifecycle-derived-expiry-state) |
| `service client` | A non-user principal in `auth`'s `SERVICE_CLIENTS` that mints a scoped service JWT (`sub="system:<id>"`, `aud=SERVICE_AUDIENCE`, scope `notifications.push`, `emails.send`, `users.contact`, `host-notices.send`, `estimate-notices.send`, `deal-link-notices.send`, `crm.companies.read`, `accounting.reference.read`, `activities.write` and/or `meetings.hosts.read`); today `refund-api` (also `accounting.reference.read`, for accounting-api's `/system/v1/*`), `estimai-api`, `inventory-api`, `crm-api` (also `activities.write`, for activities-api's `/system/v1/*`), `meetings-api`, `notify-api`, `projects-api`, `activities-api` (`notifications.push emails.send`) and `hours-api` (`meetings.hosts.read` only — it reads which deal a meeting is linked to from meetings-api's `GET /system/meetings/hosts`, whose `sub` allowlist names `system:hours-api`; every other owner it asks as the caller, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route) (`auth` mints its own in process and may not be a client, ADR 20261013-auth-mints-own-service-credential-in-process/0049); `auth` limits each client to 300 tokens and 600 contact lookups per 10 min, counted per verified service, with one per-address count of 20 invalid credentials (ADR 20261112-system-endpoints-limited-per-verified-service) |

### Inventory (specs/20261006-hardware-inventory)

The authoritative glossary is `specs/20261006-hardware-inventory/spec.md` § Domain language.

| Term | Meaning |
|---|---|
| `asset` | One physical hardware unit owned by one `entity` — never a quantity (13 monitors = 13 assets) |
| `holder` | The Operai account an asset is assigned to, or the **office** it is in (never both); no holder = company stock |
| `office` | A wellD place holding assets (CH - Agno, CH - Lugano, YoRoom - Milano at launch), managed by inventory managers, archived never deleted; assigning to it is immediate; its entity is information only (US-14) |
| `status` | `ordered` · `in_stock` · `assigned` · `in_repair` · `lost` (still on the books) · `disposed` (off the books) |
| `assignment` | `pending` until the employee confirms receipt, then `confirmed`/`declined`/`cancelled` |
| `depreciation rule` | Per-entity, effective-dated parameters (life, first-year share, threshold, residual); resolved on read (ADR 20261006-depreciation-derived-on-read-closed-years-snapshotted) |
| `fiscal year` | Calendar year per entity, `open` or `closed`; closing is irreversible and snapshots the figures |
| `roll-forward` | Opening book value − disposals + purchases − depreciation = closing book value |

Capabilities: `inventory manager` = `asset:manage`, `hardware accountant` = `ledger:manage`.

### Meetings (specs/20261104-meetings)

The authoritative glossary is `specs/20261104-meetings/spec.md` § Domain language.

| Term | Meaning |
|---|---|
| `meeting` | One conversation captured in Operai: metadata, one source, a transcript, any number of summaries, and each participant's private Q&A history |
| `creator` | The one Operai user who created the meeting; a meeting whose creator is deactivated is frozen, not orphaned |
| `participant` | An Operai participant (an active account) or an external participant (a name, never an account) |
| `host` | An Operai app that lists and starts meetings about its own records (CRM, entity type `deal`; Projects, entity type `project`, since 2026-11-23: a meeting started from a project task is linked to its project, specs/20261104-meetings A18); a host reference is `{app, entityType, entityId}`, at most one per meeting |
| `host notice` | The content-free message (id, event, creator, per-meeting `seq`) a host that opted in receives when a linked meeting is linked, changed, relinked, unlinked or deleted (ADR 20261104-meeting-host-contract-resolve-and-notices) |
| `source` | `recorded` (browser), `uploaded` (a file) or `text` (typed/pasted) — exactly one per meeting |
| `audio` | The only thing in the bucket; kept until 29 days after creation, then deleted by the bucket's lifecycle rule (ADR 20261104-audio-retention-bucket-lifecycle-verified-at-startup) |
| `folder` | One person's own grouping of the meetings they see: one level, a meeting in at most one folder per person, never seen by anyone else (ADR 20261113-personal-meeting-folders) |
| `attachment` | A file or link a person added to a meeting (agenda, slides, notes); seen by everyone who can open it, read by the AI as background, never as evidence; a file is deleted 29 days after upload, a link is never opened (ADR 20261117-meeting-attachments-in-the-audio-bucket-forwarded-unparsed) |

### Activities (specs/20261110-activities)

The authoritative glossary is `.claude/context/glossary.md` § Activities.

| Term | Meaning |
|---|---|
| `activity` | Something that happened or must happen about a client relationship or a project, recorded by an Operai user; `pre_sales` or `operational` |
| `pre-sales activity` | An activity about a CRM company (optionally one of its contacts and deals): a note, call, meeting, email or task |
| `operational activity` | An activity about a project; only tasks |
| `task` | An activity someone must do: exactly one assignee, an optional due date, open until done; pre-sales or operational |
| `host` | The Operai app whose record an activity is about (`crm` → company, `projects` → project); it alone decides who may read or change the activity, via `POST /activity-host/v1/resolve` (ADR 20261110-activities-service-access-delegated-to-host) |
| `My tasks` | The tasks assigned to the caller or in which the caller takes part. The CRM shows only pre-sales ones; Projects shows both, pre-sales ones badged |
| `maintenance` | The switch (`ACTIVITIES_MAINTENANCE`) that makes activities-api refuse everything but `/health` while the CRM's activities are copied in (ADR 20261110-activities-migration-write-pause) |

### Time tracking (specs/20261112-time-tracking)

The authoritative glossary is `.claude/context/glossary.md` § Time tracking.

| Term | Meaning |
|---|---|
| `time entry` | One person's own declaration that they spent a duration, on one day, on one thing — a project, a deal, a meeting, or no entity (then with a category); whole 30-minute steps (30 min–24 h), never a time of day. Not an activity, but may point at one (`activityId`, only on a project or a deal) |
| `category` | What a time entry on no entity is about (training, talk preparation, administration, …), from a list an admin manages; it may require a note. Not the inventory's asset category |
| `work type` | The optional kind of work of a time entry on a project or a deal, from one of two lists an admin manages (one per target); never on a meeting or on no entity |
| `retired` | A category or work type an admin withdrew: no longer offered for a new entry, kept by the entries that already have it, restorable; nobody, admins included, deletes one (AC-3.1, AC-3.2) |
| `see everyone's hours` | The permission `time-entry:read-all` (`admin` only by seed): reads every person's entries and totals through hours-api's oversight path (ADR 20261112-hours-api-time-entries-own-service-hours-catalog); never a write, and not part of the user directory's gate |

---

## API contract (estimai-api)

Local base URL `http://localhost:8080`. The authoritative contracts are
`specs/20260606-estimate-persistence/plan.md` and `specs/20260807-estimate-sharing/plan.md`; each
service also serves its live OpenAPI document + Scalar reference. Estimates are persisted
as **whole documents** (JSONB); granular release/activity sub-resource endpoints remain an
explicit non-goal.

```
POST   /estimates                                  Create a new estimate
GET    /estimates?whose=mine|all&status=open|closed
                                                   List estimates the caller owns or collaborates on;
                                                   whose=all needs estimate:read-all (ADR 20261108-estimai-oversight-permission-amends-0036);
                                                   status absent = both
GET    /estimates/{id}                             Get the full estimate (returns an ETag)
PUT    /estimates/{id}                             Update in place — REQUIRES If-Match (ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004)
DELETE /estimates/{id}                             Delete (owner only)
POST   /estimates/import                           One-time bulk import of legacy localStorage estimates

GET    /estimates/{id}/collaborators               List collaborators (+ live display identity)
POST   /estimates/{id}/collaborators               Grant access by email (owner only)
PATCH  /estimates/{id}/collaborators/{collabId}    Change access level (owner only)
DELETE /estimates/{id}/collaborators/{collabId}    Revoke access (owner only)
DELETE /estimates/{id}/collaborators/me            Leave a shared estimate
POST   /estimates/{id}/close | /reopen              Close / reopen (owner or editor, If-Match; ADR 20261105-estimai-closes-the-estimate-crm-follows)

POST   /system/deal-link-notices                   crm-api only (service JWT, scope deal-link-notices.send):
                                                   an estimate was linked to / unlinked from a deal (ADR 20261108-crm-pushes-deal-links-to-estimai)
```

Authentication: RS256 JWT issued by the `auth` service, verified via its JWKS endpoint with
the `aud` claim enforced (ADR 20260713-jwt-audience-claim-enforcement). Access is the caller's ownership **or** a row in the
service's own `estimate_collaborator` ACL (ADR 20260807-record-level-acl-resource-server-owned-access-primitive). Denials follow ADR 20260807-denial-taxonomy-shared-records-403-vs-404: **403** when a
relationship exists but the level is insufficient (`insufficient_access` / `owner_only`),
**404** only when no relationship exists at all. Writes without a valid precondition are
**428**; a stale one is **409** — both map to the same "reload" UX. A per-estimate size guard
rejects over-large payloads (413). Owner/collaborator display names are resolved live from
`auth POST /authz/users/identities` and fail **soft** to `status:"unknown"` (ADR 20260807-live-identity-resolution-by-id-fail-soft).
Errors are RFC 7807 Problem JSON; dates are ISO 8601.

Other services' contracts: `inventory-api` — `specs/20261006-hardware-inventory/plan.md` § API
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
  exits if it fails (ADR 20260716-eu-object-storage-refund-attachments); inventory has its own bucket, never refund's
- Meetings handles the most sensitive content in the suite (recorded conversations), so EVERY hop
  is EU/CH and checked at startup, the process exiting if one fails (ADR 20261104-meetings-ai-providers-eu-zero-retention, AC-4.9): its own
  audio bucket (`MEETINGS_S3_*`, never another tool's), transcription by Gemini on Vertex AI (`eu`
  multi-region, ADR 20261110-meetings-transcription-gemini-on-vertex-eu; Chirp 3 in `eu` as the rollback), summaries and Q&A by Claude on Vertex AI through the `eu`
  multi-region endpoint (`global`, `us` and London are refused; Claude Fable/Mythos excluded), and a
  transient Google Cloud Storage bucket in an EU/CH location that holds audio only while a
  transcription attempt runs (reached through its regional endpoint; 1-day lifecycle rule, soft delete
  0, versioning off and public access prevention verified at startup; deleted at attempt start, in
  `finally` and on explicit deletion, ADR 20261105-meetings-ai-providers-google-cloud-eu). A setting Google exposes (bucket rules, Vertex cache
  and request logging) that cannot be read is a refusal; one it does not expose (Speech data logging,
  contract type, Advanced AI consent) is a recorded go-live sign-off. Known, user-accepted exception
  (2026-11-05): Google may keep the async transcript result for about 5 days. `MEETINGS_AI_PROVIDER=fake`
  is refused in production. Audio is deleted by a bucket-wide 29-day lifecycle rule with versioning
  off (a missing or prefix-filtered rule, `Days > 29` or versioning Enabled stops the start,
  ADR 20261104-audio-retention-bucket-lifecycle-verified-at-startup); set and prove it with `infra/meetings-bucket-policy.sh`. Transcripts and summaries live
  in Postgres until the meeting is deleted; database backups keep deleted content for the backup
  retention period (open item R7 in specs/20261104-meetings). Provider DPAs are a go-live sign-off (plan O3)
- No business data should be logged by the hosting provider beyond standard access logs
- Frontends are purely client-side — they transmit data only to the suite's own services
  (and, for admin-ui, address text to Google Places; ADR 20260804-google-places-browser-direct-referrer-restricted-key). meetings-ui sends microphone audio
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
- **Releases follow `RELEASING.md`** (root): checks before, the Changesets release commands, what follows the tag and what a release must never do — `/wellforge:release` loads it, and a person releasing by hand follows it too.
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
  frontends use the library; a new tool wires it up before its first screen (`link:` devDependency,
  `shared` entry with `import: false`, `resolve.dedupe`, tsconfig `paths`, vitest alias — see
  `operai-ui/README.md`). A remote runs on the LIVE shell's library: add an export in one push and
  use it from a remote once that shell is live; remove or rename one only after no remote uses it
- **One styling dialect (ADR 20261031-one-styling-dialect-token-utilities):** colours and fonts are Tailwind token utilities (`text-soft`,
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
  401 refresh-retry-redirect (ADR 20260607-jwt-in-memory-never-web-storage)
- A remote owns no auth guard and no chrome — the shell does (ADR 20260709-suite-frontend-module-federation). Any screen every
  signed-in user must reach regardless of app-access grants belongs in the shell (ADR 20260804-shell-identity-scoped-non-tool-screens-account-route)
- Every remote exposes `./version` for the shell's About modal; a shell↔remote seam must
  degrade silently when a remote predates the export, never block or throw (ADR 20260803-suite-version-generated-file-federated-export)

### Backend services (auth, estimai-api, notify-api, refund-api, inventory-api — Bun + Hono)
- Validate all environment variables at startup (`src/lib/env.ts`); `process.exit(1)` on missing
- Routes grouped by feature directory, registered in `src/index.ts`; OpenAPI in `src/openapi/`
- Database access only through the Prisma client in `src/lib/db.ts`
- Prisma migrations — never modify existing migration files
- Return RFC 7807 Problem JSON for all error responses (global `app.onError`/`app.notFound`)
- Money is stored and computed in integer minor units — never `Decimal`, never float; round
  exactly once, at compute time, with one canonical rule (ADR 20260720-mileage-rate-money-precision-integer-micros)
- Derived lifecycle state (expiry, orphan reconciliation, PDF regeneration) is computed
  on read, never written by a cron or queue sweep (ADR 20260714-invitation-lifecycle-derived-expiry-state/0016/0019)
- When adding a cross-service env var, update `tools/env-doctor`'s manifest — it is the
  contract, and CI checks it (`.github/workflows/env-doctor.yml`)

### Rust service (letterhead-api)
`letterhead-api/` is the one Rust service (ADR 20261116-letterhead-api-is-a-rust-service-with-typst-embedded-for-document-layout-only): Rust is for document layout ONLY. Every other backend stays Bun + Hono +
TypeScript, and a second Rust service, or Rust in any other service, needs its own ADR.
- **Layout:** a Cargo workspace. `engine/` (`letterhead-engine`) is pure: content model, validation, layouts, outputs. It does no
  I/O — no file system, no network, no clock, no process, no environment, no async runtime — which is what makes the render deterministic
  (AC-1.4) and its file system closed (AC-2.2); a test in `engine/src/lib.rs` fails when a dependency or a source line breaks that rule.
  `api/` (`letterhead-api`) is the supervisor: HTTP, authentication, the worker pool, Postgres, the bucket, logging.
  Everything the engine needs is passed in.
- **Toolchain:** Rust is pinned EXACT in `mise.toml` (`rust`, with `rustfmt` and `clippy`), in the Dockerfile builder (`ARG RUST_VERSION`)
  and as `rust-version` in `letterhead-api/Cargo.toml`; change the three together. `Cargo.lock` is committed and every build uses `--locked`.
- **Format and lint:** `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. `unsafe` is forbidden
  (`[workspace.lints]`). Never silence a lint to pass: fix it, or `#[expect(lint, reason = "…")]` with the reason.
- **Tests:** `cd letterhead-api && cargo test --workspace --locked` (or `pnpm test` there: the shim runs the same). Unit tests sit beside
  the code; the engine's golden corpus and the supervisor's integration tests come with the tasks that add them.
- **Environment:** `api/src/env.rs` reads and validates every variable once at startup and exits 1 listing all problems; it is the only
  reader of the environment. An error line names the variable and the rule, never a value; secrets are `Secret` (redacted `Debug`).
  The S3 EU-residency guard is a port of `crm-api/src/lib/s3Residency.ts` and also stops the start. A new variable goes in `env.rs`,
  in `tools/env-doctor/manifest.ts` and in the README table, in the same change.
- **Errors:** RFC 7807 `application/problem+json` with a `code`, as in every other backend; no error body repeats request text (AC-3.6).
- **Release:** Changesets versions it from `letterhead-api/package.json` (a shim: name, version, CHANGELOG; no dependencies). The Cargo
  version is NOT the release version. `letterhead-api` is in `lerna.json`, `changeset-check.yml` and the env-doctor manifest BY NAME:
  nothing else triggers them for a service without its own `package.json` of dependencies.
- **Image:** `letterhead-api/Dockerfile`, multi-stage, ending in non-root `debian:bookworm-slim`; one binary. It has no curl or wget:
  the HEALTHCHECK is `letterhead-api healthcheck`.
- **Running it:** `mise run dev:letterhead` (host, port 8088, local defaults, no `.envrc`), or `docker compose up letterhead-api`.
- **Migrations:** `letterhead-api migrate` applies the migrations embedded in the binary (`sqlx::migrate!`) and exits. It reads only
  `DATABASE_URL`, exits 0 when nothing is left to apply, and on failure exits non-zero with a message that never holds the URL. `serve`
  never migrates and refuses to start on a database that is behind. Locally: `mise run db:migrate`, or compose's one-shot
  `letterhead-api-migrate`, which `letterhead-api` waits for. On Railway it is the service's `preDeploy` (`.railway/railway.ts`:
  `start: "letterhead-api"`, `preDeploy: "letterhead-api migrate"`); the image has `CMD`, not `ENTRYPOINT`, so both are whole commands. A new
  migration file is picked up by the next build (`api/build.rs`).
- **Railway and performance:** the service, its `letterhead` bucket (`ams`) and its custom domain are declared in `.railway/railway.ts`
  (`limitOverride` 2 vCPU / 4 GB for 2 workers x 1 GiB plus the supervisor). `letterhead-api/perf/` measures the 10-page offer
  (50 sequential previews and 50 PDFs, p50 and p95, against AC-1.9 and AC-1.10) with a service credential, locally against a container
  started with the same limits, and on the deployed service in T40; its README has both recipes.

### All services
- No hardcoded strings that appear in the UI — use constants (e.g. `src/strings.ts`) or i18n
  from day one; the suite needs Italian and English at minimum. `estimai-ui` enforces this
  with a `noHardcodedStrings` test.
- Dates and durations always in ISO 8601 in API contracts; display formatting is a UI concern

---

## Running locally

### The whole suite (preferred)
```bash
mise run db:migrate   # once: Postgres up + Prisma migrations for every backend (meetings and hours included)
mise run dev          # everything, with HMR — opens http://localhost:5173 (the shell) once it answers;
                      # OPERAI_NO_OPEN=1 skips the browser
mise run dev:web      # frontends only (backends already running elsewhere)
mise run dev:preview  # frontends build+preview — no HMR, mirrors the deploy shape
```

Ports: auth `3001`, estimai-api `8080`, notify-api `8081`, refund-api `8082`, inventory-api `8083`,
crm-api `8084`, meetings-api `8085`, projects-api `8086`, activities-api `8087`, letterhead-api `8088` (Rust), **accounting-api `8089`**, hours-api `8088`, shell `5173`, estimai-ui `5174`, refund-ui `5175`, notify-ui `5176`,
admin-ui `5177`, inventory-ui `5178`, crm-ui `5179`, meetings-ui `5180`, projects-ui `5181`, letterheads-ui `5182`, **accounting-ui `5183`**, hours-ui `5184`; MinIO S3 `9000`
(console `9001`). Frontend ports are pinned in each app's `vite.config.ts`. The e2e serves each remote by `build && preview` on its own numbering
(`shell/playwright.config.ts`): accounting-ui is on `5185` there (`E2E_ACCOUNTING_REMOTE_PORT`), because `5183` is another remote's preview in that file.
`accounting-api` has its own logical database `accounting`, created by the idempotent compose one-shot `accounting-createdb` (run by `mise run db:migrate` and named in
the `dev` tasks' `docker compose up`), and its own `.envrc` and `.env.example`.

Prereqs (once): direnv installed and each `.envrc` allowed (`direnv allow auth`, likewise
`estimai-api`, `notify-api`, `refund-api`, `inventory-api`, `crm-api`, `meetings-api`, `projects-api`, `activities-api`, `accounting-api`, `admin-ui`; hours-api reads its `.env`), 1Password CLI signed in, and
`ENABLE_TEST_AUTH=true` for a seeded local session. `mise run dev` invokes `direnv exec`
explicitly — direnv's shell hook does not fire for a non-interactive mise task. Meetings runs against
fake transcription/LLM providers locally (`MEETINGS_AI_PROVIDER=fake`, refused in production) until
the Google Cloud project is provisioned (ADR 20261105-meetings-ai-providers-google-cloud-eu). `hours-api` has no direnv file: a
person copies `hours-api/.env.example` to its gitignored `hours-api/.env` and fills it (bun and `prisma.config.ts` load
it). **Secret values never go in a `.envrc`** — those are committed and hold only `op read` references — but in the
uncommitted per-service `.env`. Until hours-api's `.env` exists hours-api exits at start naming each missing variable
and the rest of the stack keeps running. It also needs an `hours-api` entry (scope `meetings.hosts.read`) in `auth`'s
`SERVICE_CLIENTS`, its secret kept where auth keeps the others (never a committed file), and `SERVICE_AUDIENCE` in
meetings-api's environment — without them a meeting's deal reads as unavailable and nothing else is affected.

### Database + object storage (shared)
```bash
docker compose up -d postgres minio minio-createbucket   # PostgreSQL 17 :5435, MinIO :9000
```

`minio-createbucket` also creates the private `meetings` bucket with the 29-day expiration rule and
versioning off, which meetings-api checks at startup (ADR 20261104-audio-retention-bucket-lifecycle-verified-at-startup). Verify it (needs the AWS CLI and `jq`;
the default MinIO dev credentials):

```bash
MEETINGS_S3_ACCESS_KEY_ID=minioadmin MEETINGS_S3_SECRET_ACCESS_KEY=minioadmin \
  infra/meetings-bucket-policy.sh --check --endpoint http://localhost:9000 --bucket meetings --path-style
```

### A single frontend
```bash
cd estimai-ui        # or shell / refund-ui / admin-ui / notify-ui / inventory-ui / crm-ui / meetings-ui / projects-ui / accounting-ui / hours-ui
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

#### Accounting and Refund in the e2e (specs/20261119-accounting, specs/20261118-refund-accounting-export)

The refund-accounting journeys need three services wired together, not just refund-api:

- **accounting-api** (`:8089`, `mise run dev` or `cd accounting-api && direnv exec . bun run dev`) with its database `accounting` migrated
  (`mise run db:migrate`, or `docker compose run --rm accounting-createdb && (cd accounting-api && bun run db:deploy)`), run with
  **`ACCOUNTING_FX_SOURCE=off`**: no call to the federal source, and the accounting specs type their rates by hand. accounting-ui is served by the e2e on `:5185`
  (`E2E_ACCOUNTING_REMOTE_PORT`); the shell build is told the API's origin by `VITE_ACCOUNTING_API_URL` (`E2E_ACCOUNTING_API_URL`, default `http://localhost:8089`).
- **refund-api** with **`ACCOUNTING_INTERNAL_URL`** set (it exits 1 at startup without it; `http://localhost:8089` locally, `mise run dev` defaults it, compose uses
  `http://accounting-api:8089`). `REFUND_FX_SOURCE` no longer exists: refund-api fetches no rate.
- **auth** with `ENABLE_TEST_AUTH=true`, its seed applied (the `admin` role holds `accounting:read` and `accounting:manage`), and `SERVICE_CLIENTS` giving refund-api's
  entry the scope **`accounting.reference.read`** (and **`users.contact`** only for the production release window, removed after it, T84) (`auth/.env.example`; in a shared environment edit it only after the auth that knows the scope is deployed, or auth
  stops at startup).

The suite's global setup (`shell/e2e/global-setup.ts`) then does three things before any spec, in this order, and fails the whole run naming the command when one cannot run:

1. Checks that accounting-api answers `/health` (`E2E_ACCOUNTING_API_URL`, default `http://localhost:8089`).
2. Runs `direnv exec . bun run seed:welld-ch` in `accounting-api/`: loads WellD CH's ledger accounts and VAT codes into Accounting where they do not exist (idempotent, never
   changes an entry that exists). `E2E_SKIP_ACCOUNTING_SEED=1` skips it, when accounting enters the list by hand.
3. Runs `direnv exec . bun run accounting:release` in `refund-api/` (specs/20261118-refund-accounting-export, T12). refund-api answers every approval with 409
   `accounting_release_pending` until that script has run once against the database it uses, so without it every journey that approves a request fails. The script reads
   Accounting first (step 2 must have run, and accounting-api be reachable; otherwise it exits 2 and writes nothing), is idempotent, seeds Refund's type defaults, and prints
   one summary line, which the setup logs. The release needs the baseline list (`--offsets`, exit 3 without it), so the setup passes a header-only file (no hand-issued number) written in a temp directory (T73). It needs refund-api's migrations applied (`cd refund-api && bun run db:deploy`).
   `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1` skips it, for a run of specs that never approve a refund request; a run that skips it proves nothing about approvals.

Both scripts run under `direnv exec`, so each writes to the database its service's `.envrc` names (the shared dev one). To aim them at another database set
**`E2E_ACCOUNTING_DATABASE_URL`** (accounting-api's database, for `seed:welld-ch`) and **`E2E_REFUND_DATABASE_URL`** (refund-api's, for `accounting:release`) to postgres URLs:
the value replaces `DATABASE_URL` for that one script, is never printed, and **must be the database the running service uses**, or the setup and the specs would
disagree. The journeys (`accounting.spec.ts`, `accounting-access.spec.ts`, `refund-accounting-settings.spec.ts`, `refund-accounting.spec.ts`) write their own accounts, VAT
codes and exchange rate through accounting-api's routes and put back the defaults they changed.

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

### letterhead-api :8088 (Rust)
Not the shape below: see **### Rust service (letterhead-api)** — `mise run dev:letterhead` (host) or `docker compose up letterhead-api`;
`cd letterhead-api && cargo test --workspace --locked`.

### Resource backends (estimai-api :8080, notify-api :8081, refund-api :8082, inventory-api :8083, crm-api :8084, meetings-api :8085, projects-api :8086, activities-api :8087, accounting-api :8089, hours-api :8088)
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

Shipped today: **EstimAI**, **Rimborsi** (refund), **Admin**, **Notify**, **Inventory**, **CRM**, **Meetings**, **Projects**,
**Hours** — see the table at the top. Still on the roadmap, not yet built:

| Tool | Purpose |
|---|---|
| **ReviewAI** | AI-assisted code and architecture review checklists |
| **RetroAI** | Sprint retrospective facilitation and pattern detection |
| **ProposAI** | Consulting proposal drafting from project briefs |

All tools share the Operai design system, `@operai/ui` (DM Sans / DM Mono / Syne, dark ink palette, purple AI accent).
A new tool is a federated remote mounted by the shell (ADR 20260709-suite-frontend-module-federation), gated by an `(appId, "access")`
grant in `auth`'s catalog (ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims), and — if it owns data — a JWKS resource server of its own
(ADR 20260703-jwt-resource-server-remote-jwks/0010).

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

- [20260607] JWT in memory, never web storage — cache the RS256 JWT in a module-scope variable in `src/lib/api.ts`; never write it to localStorage/sessionStorage (see docs/adr/20260607-jwt-in-memory-never-web-storage.md)
- [20260607] Sign-in page hosted by auth service — central `GET /sign-in` (Hono JSX) serves all Operai tools; frontends redirect unauthenticated users there (see docs/adr/20260607-sign-in-page-hosted-by-auth-service.md)
- [20260703] estimai-api is Bun + Hono + TypeScript, not Kotlin/Spring Boot — one backend stack across the monorepo; supersedes the earlier Kotlin/Spring intention (see docs/adr/20260703-estimai-api-bun-hono-typescript.md)
- [20260703] Estimate persistence: JSONB document + denormalised listing columns — one `estimate` row with `content` JSONB; `name`/`author`/`sizeBytes`/timestamps as columns; fidelity is semantic deep-equal; 1 MiB size guard; no count quota (see docs/adr/20260703-estimate-persistence-jsonb-document.md)
- [20260703] JWT resource-server verification via remote JWKS — `estimai-api` verifies Bearer JWTs with `jose createRemoteJWKSet` pinned to RS256 + issuer; all queries scoped to `sub`; not-owned records return 404 not 403; establishes the pattern for all future Operai resource services (see docs/adr/20260703-jwt-resource-server-remote-jwks.md)
- [20260709] Operai suite frontend composition via Module Federation — a shell host owns shared chrome/session (ADR 20260607-jwt-in-memory-never-web-storage/0002/0005 reused via `shell/session`); tools mount as path-basepathed remotes with no own auth guard/chrome; remote URLs resolved at runtime per-env, never build-baked (see docs/adr/20260709-suite-frontend-module-federation.md)
- [20260713] Authorization model: hand-rolled RBAC/ABAC in the auth service, identity+epoch JWT claims, live permission resolution — do not embed roles/permissions in the JWT (identity + `perm_epoch` only); resolve effective permissions live via `GET /authz/me`, cached in-memory and revalidated on navigation, so revocation is immediate; per-app catalog + admin API live inside `auth` (see docs/adr/20260713-authz-hand-rolled-rbac-abac-epoch-claims.md)
- [20260713] SSE stream authentication via a short-lived single-use ticket — `EventSource` cannot send an Authorization header, so the client mints a ~30s single-use ticket via `POST /notifications/stream-ticket` (normal Bearer/JWKS path) then opens `EventSource(GET /notifications/stream?ticket=…)`; the 7-day JWT never enters a URL (see docs/adr/20260713-sse-stream-auth-short-lived-ticket.md)
- [20260713] Notification center as a standalone JWKS resource service (`notify-api`) + federated remote (`notify-ui`), with only the bell/raise-capability/SSE-manager/`ToastHost` living in the shell — never add notification business logic to `shell/session`; the raise-capability's request shape reserves an inert `recipient` field for Refund's future cross-user notifications (see docs/adr/20260713-notification-center-standalone-service-shell-seam.md)
- [20260713] JWT `aud` (audience) claim now enforced across `auth` and every resource server — `notify-api` is the suite's first real second JWKS resource server, tripping ADR 20260703-jwt-resource-server-remote-jwks/ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims's deferred trigger; `auth` stamps `audience` via `definePayload`, and `estimai-api`/`notify-api` verify it via `AUTH_AUDIENCE`, closing the unscoped cross-service token-replay gap (see docs/adr/20260713-jwt-audience-claim-enforcement.md)
- [20260714] notify-api email as a second delivery channel — a new `email` channel (raw address, Resend, bilingual) sits alongside the existing `inApp` (`sub`) channel; `auth` triggers sends via `POST /system/emails`, deliberately NOT a user JWT/JWKS path (ADR 20260703-jwt-resource-server-remote-jwks); fixed escaped templates; the original service-to-service trust is superseded by 0049 (see docs/adr/20260714-notify-api-email-channel-service-trust.md)
- [20260714] Invitation activation via two better-auth hooks + soft-delete lifecycle — `user.create.after` matches a pending invite by OAuth-**verified** email (new users only); `session.create.before` blocks/re-activates a soft-deleted user's return sign-in; deletion is soft (`deletedAt`) with a synchronous session-revocation + `perm_epoch` bump cascade, resource servers untouched at delete time; the **accepted residual-JWT window** (a deleted user's already-issued short-lived JWT stays valid until it expires) is a deliberate ADR-0005-preserving trade-off, with a resource-server liveness/epoch check named as the escalation path (see docs/adr/20260714-invitation-activation-hooks-soft-delete-lifecycle.md)
- [20260714] Invitation lifecycle expiry is derived, not scheduled — `expired` = `status=='pending' && expiresAt<=now`, computed on read, never written by a background job; reconcile-on-write flips stale `pending` rows before insert so the `email WHERE status='pending'` partial-unique index never blocks a fresh invite for a dead address; do not add a cron/queue expiry sweep for this or similar future lifecycle features (see docs/adr/20260714-invitation-lifecycle-derived-expiry-state.md)
- [20260716] refund-api is the suite's first authorization-enforcing resource server — a new Bearer-authed `auth GET /authz/resolve` (forwards the caller's already-verified JWT, no new secret) is resolved via `refund-api`'s `authzMiddleware`, cached in-process by `(sub, perm_epoch)` with a 30s TTL backstop; capability-absent denials are 403, record-level ownership/entity failures are 404 (ADR-0005-style, no existence leak); an `auth` outage fails **closed** (503), never open — realizes ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims's explicitly deferred resource-server side (see docs/adr/20260716-refund-api-authorization-enforcing-resource-server.md)
- [20260716] Entity-scoped ABAC in refund-api evaluates specs/20260713-auth-roles-permissions's entity condition at **request** level — "at least one line's entity matches the caller's `user.entity`" — never per-line; "global" review scope is composed via the resolver's pre-existing widest-wins union (no `accounting-global` role is seeded); approve/reject/set-approved-total always apply **whole-request**, even across an out-of-scope line (see docs/adr/20260716-entity-scoped-abac-refund-api.md)
- [20260716] Refund receipt attachments live in EU-region S3-compatible object storage, reached only via presigned URLs (policy-capped ≤10 MiB, `pdf`/`jpeg`/`png` POST; ~60s authz-gated GET) — never proxy file bytes through refund-api; two-phase `pending`→`confirm` upload, orphans reconciled on read (only `stored` ever surfaced), no cron (ADR 20260714-invitation-lifecycle-derived-expiry-state posture); `REFUND_S3_REGION` is validated against an EU allowlist at startup (see docs/adr/20260716-eu-object-storage-refund-attachments.md)
- [20260716] notify-api gains `POST /system/notifications` (mirrors ADR 20260714-notify-api-email-channel-service-trust's `/system/emails`) for cross-user in-app push, activating ADR 20260713-notification-center-standalone-service-shell-seam's reserved `recipient` seam for refund-api's decision notifications; best-effort, never rolls back the decision; the user-JWT `POST /notifications` stays strictly self-only (OWASP A01); the caller authentication is superseded by 0049 (see docs/adr/20260716-system-notifications-cross-user-trigger.md)
- [20260716] refund-api's financial audit trail (`RefundAuditEntry`) is append-only at the **database** level, not just by absent route — a `CREATE RULE`/trigger blocks `UPDATE`/`DELETE` outright, and `onDelete: Restrict` makes any request with an audit row (i.e. anything past `draft`) physically undeletable; the reusable pattern for future financial/governance records in the suite (see docs/adr/20260716-immutable-financial-audit-trail-refund.md)
- [20260719] Compiled-batch PDF generation runs server-side in refund-api with `pdf-lib` (pure-TS, no headless browser) — never a Puppeteer/Chromium dependency; the PDF is a **deterministic, regenerable cache derived from `RefundBatchItem`**, not the source of truth, so the compile transaction commits before the EU-bucket `PutObject` and a failed write is lazily re-rendered on the next read, with no 4th "compiling" batch status (see docs/adr/20260719-refund-batch-pdf-generation-pdf-lib.md)
- [20260719] `RefundStatus` gains a fifth, terminal `paid` value — **supersedes 007's "no fifth value" schema-comment freeze**; batch membership is split between the live `RefundRequest.batchId` claim pointer (dedup, overwritable) and the append-only `RefundBatchItem` (permanent history); compile-time claim uses `SELECT … FOR UPDATE` + `batchId IS NULL` CAS to prevent double-pay, mark-paid/discard use a `status='compiled'` CAS for exactly-once terminal transitions (see docs/adr/20260719-refund-batch-paid-lifecycle-extension.md)
- [20260719] The compiled-batch email carries an **in-app deep link** (`/refund/batches/:id`), never a raw presigned S3 URL and never a PDF attachment — the recipient must sign in and pass the same `request:review` authz check as any in-app batch view before a short-lived presigned GET is minted; sent only to the single configured `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`; `notify-api`'s email channel (ADR 20260714-notify-api-email-channel-service-trust) gains one new template + per-template `data` shape, explicitly **not** attachment support (see docs/adr/20260719-refund-batch-signed-link-email-delivery.md)
- [20260719] Batch audit trail extends ADR 20260716-immutable-financial-audit-trail-refund in place — new `AuditAction` values (`batch_compiled`/`batch_paid`/`batch_discarded`) + a nullable `batchId` FK on the existing `RefundAuditEntry`, one row per affected request per action, reusing the same DB-level immutability trigger and `onDelete: Restrict` retention with **no new mechanism**; membership is retained forever via ADR 20260719-refund-batch-paid-lifecycle-extension's `RefundBatchItem` even after discard/re-inclusion (see docs/adr/20260719-refund-batch-audit-trail-extension.md)
- [20260720] Mileage rate model lives entirely in refund-api (not auth) — per-entity effective-dated rate series resolved derived-on-read (ADR 20260714-invitation-lifecycle-derived-expiry-state lineage, never cron), a travel_km line's computed amount snapshots exactly once at submit and clears on withdraw-to-draft, `rate:read`/`rate:manage` is a NEW global (non-entity-scoped) catalog permission (deliberate contrast with ADR 20260716-entity-scoped-abac-refund-api), and the management screen calls refund-api's `/rates` directly — refund-api stays the sole owner of rate data and all money logic; amended 2026-11-13: the screen (with the distribution email setting) moved from admin-ui to refund-ui's Settings tab (`/refund/settings`, shown with `rate:read` or `settings:read`) (see docs/adr/20260720-mileage-rate-model-snapshot-admin-ui-composition.md)
- [20260720] `MileageRate` is its own append-only, self-auditing table — same DB-level `BEFORE UPDATE/DELETE` immutability trigger as `refund_audit_entry` (ADR 20260716-immutable-financial-audit-trail-refund/0022), no separate audit table since every AC-5.1 field already lives on the row itself; never extend `RefundAuditEntry` for a non-request-scoped record, give it a sibling table with the identical trigger mechanism instead (see docs/adr/20260720-mileage-rate-history-self-auditing-table.md)
- [20260720] Mileage rate precision: store `ratePerKmMicros` (integer micros of the major unit), compute `amountCents = roundHalfUp(km × ratePerKmMicros / 10_000)` — round exactly once, at compute time, with one canonical rule mirrored (and test-vector-shared) between refund-api and refund-ui; never `Decimal`/float for the rate, extending 007's integer-minor-unit money posture (see docs/adr/20260720-mileage-rate-money-precision-integer-micros.md)
- [20260721] Self-approval segregation-of-duties: opt-in `{key:"self-approval",match:"deny"}` attribute on `request:approve` only (catalog-only change), enforced inline in refund-api's approve decide path with a distinguishable 403 (`code:self_approval_forbidden`) BEFORE the entity-404/status-409 gates — a deliberate exception to ADR 20260703-jwt-resource-server-remote-jwks/0014's "not yours = 404"; denials are logged (`refund.self_approval_denied`), never a new `RefundAuditEntry` action; subject to ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims/0015's widest-wins union (a second unconditioned approve grant unions the restriction away) (see docs/adr/20260721-self-approval-condition-and-403-exception.md)
- [20260722] Refund settings store: append-only, self-auditing `refund_setting` key/value table, current value derived latest-per-key, same `BEFORE UPDATE/DELETE` immutability trigger as `MileageRate` (ADR 20260716-immutable-financial-audit-trail-refund/0024) — never `RefundAuditEntry` (requestId is NOT NULL, settings aren't request-scoped); no-op saves suppressed by read-before-append; the reusable extensible-config pattern for future admin-governed, non-request-scoped settings in the suite (see docs/adr/20260722-refund-settings-append-only-self-auditing-store.md)
- [20260722] New global `settings` catalog resource (`read`/`manage`, unconditioned) — deliberately NOT a reuse of `rate:manage` (ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition): a distribution mailbox is not a rate, and conflating them would make the two admin surfaces un-separable/un-auditable in isolation; enforced server-side in refund-api on BOTH read and write (unlike `rate`'s deliberately-ungated employee-facing `GET /rates/effective`) — a non-holder must not even learn the mailbox exists (see docs/adr/20260722-settings-catalog-permission-config-not-rate.md)
- [20260722] Batch email recipient now resolves LIVE from `refund_setting` at every send/resend — **amends ADR 20260719-refund-batch-signed-link-email-delivery** (its compile-time `recipientEmailSnapshot` freeze is dropped; the column is repurposed to nullable per-attempt delivery provenance; `compileBatch` drops its recipient param entirely); unconfigured at send/resend → `422` + `code:"accounting_distribution_email_unconfigured"` + `emailStatus:"blocked_unconfigured"`, distinguishable from an ordinary Resend outage (still best-effort `200`+`"failed"`, ADR 20260714-notify-api-email-channel-service-trust); compile and mark-paid are unaffected either way (see docs/adr/20260722-batch-email-recipient-live-resolution-amends-0021.md)
- [20260803] Suite version surfacing splits in two: the umbrella `operai` version reaches the shell build via a generated, committed in-tree file (`shell/src/lib/suiteVersion.generated.json`, written by `scripts/version.mjs` at umbrella-bump time) — never a cross-directory read of the root `package.json`, which would contradict the very reason `lerna.json` (not `workspaces`) enumerates Changesets packages; each remote gains a new federated `./version` export, dynamically imported by the shell's About modal and raced against a timeout — a remote predating this change must degrade silently, never block or throw the modal, the reusable rule for every future shell↔remote seam (see docs/adr/20260803-suite-version-generated-file-federated-export.md)
- [20260804] Employee address is an `auth`-owned identity/profile attribute, stored in a 1:1 `employee_address` table — an explicit, reasoned departure from ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition (which kept refund-domain data out of `auth`); the boundary test is "attribute of the person vs. data about a domain transaction"; `NOT NULL` on the 1:1 table expresses the all-four-or-none required-component group, `formatted` is derived on read and never stored (ADR 20260714-invitation-lifecycle-derived-expiry-state/ADR 20260719-refund-batch-pdf-generation-pdf-lib lineage); the admin gate reuses the existing `admin` role / `requireAdmin` with NO new catalog permission — the deliberate counterpoint to ADR 20260722-settings-catalog-permission-config-not-rate (see docs/adr/20260804-employee-address-auth-identity-attribute-1to1-table.md)
- [20260804] Google Places API (New) is called browser-direct from admin-ui with a referrer-restricted key — never proxied through `auth` (identity service must never carry a third party's latency on the suite's critical path); a federated remote's referrer restriction must list the SHELL's origin, not the remote's own; use `locationBias` for regional preference, never `includedRegionCodes` (a restriction, would violate AC-2.4); silent graceful degradation is the standing posture for every optional third-party enrichment in the suite (see docs/adr/20260804-google-places-browser-direct-referrer-restricted-key.md)
- [20260804] The suite runs TWO tiers of audit assurance: Tier 1 (DB-level immutable trigger, ADR 20260716-immutable-financial-audit-trail-refund/0024/0027) for financial/governance records, Tier 2 (application-level only) for `auth`'s `audit_log` — decided by the user at specs/20260803-employee-address's plan gate (2026-08-04) when address changes extended `audit_log` to personal data; AC-5.2 was amended to match the code, not the reverse; regression tripwire is `auth/src/authz/audit-immutability.contract.test.ts` (test/fixture teardown exempt); raising `audit_log` to Tier 1 requires first dropping `AuditLog.actorUserId`'s `ON DELETE SET NULL` FK (an FK-initiated SET NULL is an UPDATE a BEFORE UPDATE trigger would abort, silently turning SetNull into Restrict) plus reworking six test/fixture teardown paths — do not assume ADR 20260716-immutable-financial-audit-trail-refund's "reusable pattern" extends to `audit_log` (see docs/adr/20260804-two-tier-audit-assurance-auth-audit-log-application-level.md)
- [20260804] The shell may own identity-scoped, non-tool screens — a new un-gated `/account` route ("My profile"), child of `shellRoute` with no `beforeLoad` guard and absent from `TOOLS`, extends ADR 20260709-suite-frontend-module-federation's "shell owns chrome + session" and mirrors ADR 20260713-notification-center-standalone-service-shell-seam's `/notify` placement; the rule: any screen every signed-in user must reach regardless of app-access grants belongs in the shell, never a gated remote (see docs/adr/20260804-shell-identity-scoped-non-tool-screens-account-route.md)
- [20260807] Third-party app-access lookup (`auth POST /authz/app-access-check`) is a decision endpoint, not a fact endpoint, on the forwarded-caller-JWT model — returns `{eligible}` only (both negative causes byte-identical), caller-gated on holding `(appId,"access")`, equalised query path + dual response floors + the suite's first rate limiter; an internal shared token was explicitly rejected (unattributable, un-rate-limitable, new secret on the identity service) (see docs/adr/20260807-third-party-app-access-decision-endpoint-forwarded-jwt.md)
- [20260807] Record-level sharing (per-record ACL) is a new access primitive owned by the resource server that owns the record — `estimai-api`'s `estimate_collaborator` table, never expressed in `auth`'s catalog; the rule: role/attribute rules live in `auth` (ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims/0014), per-record grants live in the owning app; `estimai-api` deliberately does NOT become an authorization-enforcing resource server and keeps no hard runtime dependency on `auth` for its read/write path (see docs/adr/20260807-record-level-acl-resource-server-owned-access-primitive.md)
- [20260807] Denial taxonomy for shared records narrows ADR 20260703-jwt-resource-server-remote-jwks's blanket "not owned = 404" — 403 (`insufficient_access`/`owner_only`) when a relationship exists but the level is insufficient, 404 only when no relationship exists at all; mirrors ADR 20260716-refund-api-authorization-enforcing-resource-server's capability-vs-record split, second deliberate exception to ADR 20260703-jwt-resource-server-remote-jwks after ADR 20260721-self-approval-condition-and-403-exception's self-approval 403 (see docs/adr/20260807-denial-taxonomy-shared-records-403-vs-404.md)
- [20260807] Optimistic concurrency via integer `version` + REQUIRED `If-Match`/`ETag` CAS on every `estimai-api` write — **amends ADR 20260703-estimate-persistence-jsonb-document**, superseding its accepted last-write-wins posture (persistence shape itself — JSONB document, size guard, deep-equal fidelity — is untouched); `updatedAt`-as-precondition and an opaque content-hash ETag were rejected on correctness/cost grounds; absent/malformed precondition → 428, mapped to the same "reload" UX as 409 (see docs/adr/20260807-optimistic-concurrency-version-if-match-cas-amends-0004.md)
- [20260807] Display identity for a shared estimate's owner/collaborators is resolved LIVE from `auth POST /authz/users/identities` (id-keyed, ≤100, no email/search) by `estimai-api`, never denormalised — the only way to satisfy AC-10.5's "never stale identity implying an active account"; fails SOFT to `status:"unknown"`, in explicit, named contrast to ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt's fail-CLOSED authorization path in the same service (see docs/adr/20260807-live-identity-resolution-by-id-fail-soft.md)
- [20260807] `estimai-api` pushes collaborator grant/removal notifications through notify-api's `/system/notifications`, best-effort; its caller authentication is superseded by 0049, which built the scoped service credentials this ADR committed to (see docs/adr/20260807-estimai-api-third-notify-internal-token-holder.md)
- [20260811] Typed-query autocomplete matches CLIENT-SIDE over a server-projected, pre-ranked personal corpus — `refund-api`'s parameterless `GET /line-suggestions` ships the whole ranked corpus once per composing session and the typed motivo text NEVER leaves the browser, making "no new log/store of motivo text" true by construction and leaving no caller-controlled selector to attack (no IDOR, no injection surface); corpus is memory-only + `Cache-Control: no-store` (ADR 20260607-jwt-in-memory-never-web-storage extended from the JWT to personal data) and derived on read with no trip table and no cron (ADR 20260714-invitation-lifecycle-derived-expiry-state); text folding lives in application code mirrored api/ui with shared canonical vectors (ADR 20260720-mileage-rate-money-precision-integer-micros) — never a Postgres `unaccent`/FTS/`pg_trgm` dependency; the server still fails closed (ADR 20260716-refund-api-authorization-enforcing-resource-server) while only the client degrades silently (ADR 20260804-google-places-browser-direct-referrer-restricted-key); escalate to a per-query endpoint if the 200-signature cap needs raising, the corpus stops being per-user, or ranking becomes query-dependent (see docs/adr/20260811-client-side-autocomplete-server-projected-corpus-app-code-folding.md)
- [20260811] A derived projection over data an existing grant ALREADY authorises reuses that gate — the new route is gated on the existing `request:read` with zero `auth`/catalog/seed change, via the **reconstructibility test** ("could a holder of the existing grant rebuild this output by hand? then a new permission withholds nothing and lies about a control that does not exist"), the third branch after ADR 20260722-settings-catalog-permission-config-not-rate (different subject → mint) and ADR 20260804-employee-address-auth-identity-attribute-1to1-table (same authority + subject → reuse); the handler **ignores the grant's conditions entirely** and scopes unconditionally to the verified JWT `sub`, so ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims's widest-wins union can never widen a self-scoped personal-data read (an unconditioned `request:review` holder still gets only their own lines) and ADR 20260716-entity-scoped-abac-refund-api's entity predicate is deliberately not consulted; capability-absent is 403 with no 404 branch at all (no record is addressed, so ADR 20260703-jwt-resource-server-remote-jwks/0037's taxonomy does not engage); never apply the test to a cross-user aggregate or a shared/team corpus — that fails the premise and needs its own permission (see docs/adr/20260811-derived-projection-reuses-existing-gate-reconstructibility-test.md)
- [20260908] The per-request archive export gives `refund-api` permission to READ attachment bytes — a bounded, SINGLE-caller departure from ADR 20260716-eu-object-storage-refund-attachments's never-proxy rule (proxying a file a client asked for is still forbidden; reading one to compose a derived document refund-api authors itself is now allowed, the same category ADR 20260719-refund-batch-pdf-generation-pdf-lib's batch PDF already occupied for writes); memory is bounded by a new `MAX_EXPORT_RECEIPT_BYTES` checked from the DB's `sizeBytes` BEFORE any download (nothing else bounds it — attachments-per-request is uncapped); a receipt that cannot be embedded fails the WHOLE export with a 502 and no placeholder page (the inverse of the suite's usual fail-soft posture — an archive is never re-checked, so a silently incomplete one is worse than a refusal); approved/**rejected**/paid only (409 otherwise — draft/submitted are still MOVING, whereas rejected is terminal and is the document a disputing employee most needs; a rejected export shows the motivation and NO approved figure anywhere, since a reviewer can set line totals before rejecting); deliberately NOT PDF/A and the reason is recorded — copied receipt pages from arbitrary user PDFs break conformance unfixably, so PDF/A-3b with receipts as embedded FILES is the named path and its trigger; no new catalog permission via ADR 20260811-derived-projection-reuses-existing-gate-reconstructibility-test's reconstructibility test, every denial 404; generated per call and never stored, unlike the batch PDF; escalation trigger — a SECOND `getObject` caller revisits this ADR rather than quietly extending it (see docs/adr/20260908-request-archive-export-refund-api-reads-attachment-bytes.md)
- [20261006] The fourth notify caller (`inventory-api`) gets a scoped, short-lived service JWT — `auth POST /system/service-token` (client-credentials against a per-client `SERVICE_CLIENTS` entry, identical 401, rate-limited) mints a 5-minute RS256 JWT `sub="system:inventory-api"`, `aud=SERVICE_AUDIENCE` (distinct from `AUTH_AUDIENCE`), `scope="notifications.push"`, verified by `notify-api` via the existing JWKS; rejected: forwarding the acting user's JWT (an employee with no capability triggers the push), a keypair per service with multi-JWKS trust, and a prerequisite spec migrating all callers first; extended to every caller by 0049 (see docs/adr/20261006-scoped-service-jwt-fourth-notify-caller.md)
- [20261006] A gated tool remote may expose a second, UNGATED federated entry mounted at a shell-owned route when the screen is identity-scoped (ADR 20260804-shell-identity-scoped-non-tool-screens-account-route's test) — `inventory-ui` exposes `./App` (gated), `./MyDevices` (ungated) and `./version`, the shell adds an un-guarded `/devices` child of `shellRoute` absent from `TOOLS` (the `/notify` shape, first applied to a remote that also has a gated entry) plus a "My devices" UserMenu link, and `inventory-api`'s `/me/*` routes need only a valid JWT, skip authz middleware and scope every query to the verified `sub` (ADR 20260811-derived-projection-reuses-existing-gate-reconstructibility-test posture, not-yours 404, no price/ledger fields); both halves (ungated route AND self-scoped API) are required; rejected: a shell-native AccountScreen-style screen (tool business logic in the shell, against ADR 20260713-notification-center-standalone-service-shell-seam), granting everyone `inventory:access` (breaks specs/20261006-hardware-inventory AC-9.6), and a fifth remote for one screen (see docs/adr/20261006-ungated-second-federated-entry-of-a-gated-remote.md)
- [20261006] Depreciation is derived on read for open years and snapshotted, immutably, only when a fiscal year is closed — an asset stores only entity/purchase date/price in integer cents, its rule is the latest `depreciation_rule` effective at purchase date (resolved on read like mileage rates, no FK), the schedule is a pure `schedule()` with one round-half-up rule and the remainder in the final year, closing writes immutable `fiscal_year` + `asset_year_figure` rows (Tier 1 triggers; row existence IS the closed state, no reopen; imported history uses the same rows as the anchor), and every dated write plus the close takes `pg_advisory_xact_lock` on the entity; rejected: persisting each asset's whole schedule at registration, computing everything live with no snapshot, and a 31-December materialisation cron (see docs/adr/20261006-depreciation-derived-on-read-closed-years-snapshotted.md)
- [20261006] A list-of-people read is a fact endpoint, acceptable only behind a named capability whose holders have a business need to pick a person — `auth GET /authz/users/directory` returns active `{id,name,email,entity}` (both entities, name-sorted, no pagination) on the forwarded-caller JWT, gated on the `inventory` catalog's `asset:manage`, rate-limited, called directly by `inventory-ui` with `inventory-api` keeping no copy; it narrows ADR 20260807-live-identity-resolution-by-id-fail-soft (which stays in force for `/authz/users/identities`) for that one audience only, and each further consumer is added to the gate deliberately; rejected: an exact-email decision endpoint (ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt style), reusing `requireAdmin` `GET /admin/users`, proxying/caching the list in `inventory-api`, and adding search/email to `/authz/users/identities`; escalation trigger: a second consuming app or a user count that makes an unpaginated list unreasonable ; amended by ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047 for the separate `handoff:take`-gated holders listing, which may carry the `unconditioned` bit (see docs/adr/20261006-user-directory-endpoint-capability-gated.md)
- [20261013] `auth` is both the issuer of service credentials and a notify-api caller (invitation emails), so it mints its own credential IN PROCESS instead of calling its own `POST /system/service-token` — `sub="system:auth"`, `aud=SERVICE_AUDIENCE`, scope `emails.send`, same better-auth signer and 300 s lifetime, one claim/sign function shared with the endpoint, signer injected in `src/index.ts`; the client id `auth` is RESERVED (a `SERVICE_CLIENTS` entry named `auth` refuses to start, otherwise the holder of that entry's secret could mint tokens indistinguishable from `auth`'s own); rejected: loopback HTTP to its own endpoint with its own client secret (extra hop, spends the endpoint's rate limit, a secret that proves nothing because the verifier is the holder), and keeping the shared token for `auth` alone (it could never be retired, specs/20261013-notify-service-credentials US-5) (see docs/adr/20261013-auth-mints-own-service-credential-in-process.md)
- [20261013] Every notify-api caller authenticates as itself and the shared token is retired — `auth`, `refund-api`, `estimai-api` and `inventory-api` use scoped 5-minute service JWTs, one scope per capability (`notifications.push`, `emails.send`; estimai-api and inventory-api push only, auth email only, refund-api both), push origin bound per client, one notify-api middleware guards both `/system` routes and logs `caller=<sub>`; retirement is THREE pushes (notify-api and auth accept the new mechanism → callers switch, verified from the caller log → a person deletes the variable from notify-api, the point of no return, undone by restoring it → legacy code, env-doctor, infra and docs removed), because one push redeploys every Railway service in no fixed order; **supersedes the shared-token parts of ADR 20260714-notify-api-email-channel-service-trust, ADR 20260716-system-notifications-cross-user-trigger and ADR 20260807-estimai-api-third-notify-internal-token-holder** and completes ADR 20261006-scoped-service-jwt-fourth-notify-caller's named follow-up; rejected: one scope for both capabilities, a single push, a caller-side fallback to the shared token (keeps it alive, hides a misconfigured client), and per-template binding of the email scope (deferred; trigger: a client that should send only some templates) (see docs/adr/20261013-all-notify-callers-scoped-credentials-shared-token-retired.md)
- [20261031] The design system becomes a shared React library, `@operai/ui` in `operai-ui/`, that every frontend compiles FROM SOURCE via a Vite alias + `resolve.dedupe: ['react','react-dom']` + tsconfig `paths` (no build, no publish, no workspace, one React under the MF singleton); `tokens.css` moves into it and `shell/src/styles/tokens.css` becomes a one-line `@import` so `shell/tokens.css` keeps working; components render only library classes (no utilities, no inline colours) and take all copy as props; apps keep thin adapters that bind copy and e2e test ids; adoption is app by app (refund-ui first); rejected: pnpm `link:`/`file:` (second or missing React on Vercel, stale snapshot), a workspace (breaks per-app installs), exposing components via Module Federation (untyped runtime coupling), a private registry (publish step, credentials) (see docs/adr/20261031-shared-ui-library-consumed-as-source.md)
- [20261031] One styling dialect in every frontend: tokens are CSS custom properties defined once in `operai-ui/src/styles/tokens.css`, mapped by Tailwind v4 `@theme inline` (utilities read `var(--x)`, one definition per token, default palette removed), reaching elements ONLY as token utilities (`text-soft`, `bg-org/10`) or library component classes; inline `style` only for runtime values; enforced by `operai-ui/eslint/design-tokens.ts` in every app (no `var(--` in TS, no colour in `style`, no arbitrary colour classes); remotes' standalone `index.css` import the library tokens instead of copies (supersedes the ADR 20260709-suite-frontend-module-federation addendum's sync-the-copy rule); the inline-`var()` dialect of refund/admin/notify/inventory rested on a premise the ADR 20260709-suite-frontend-module-federation single-sheet addendum had already removed; rejected: inline vars everywhere (no variants), CSS Modules / zero-runtime CSS-in-JS (second toolchain), runtime CSS-in-JS, per-remote prefixed Tailwind sheets (the federation-pure escape hatch — trigger: a remote deploying from another repo or cadence) (see docs/adr/20261031-one-styling-dialect-token-utilities.md)
- [20261101] The CRM is a sixth tool (`crm-api` + `crm-ui`) whose reads are open to every `crm:access` holder — a client relationship is team knowledge — while deal writes need entity-scoped `deal:manage` and erasing a contact needs `contact:erase`; a deal write outside the caller's scope is a 403 `out_of_scope`, NOT a 404, because the same caller can read the deal (ADR 20260807-denial-taxonomy-shared-records-403-vs-404's branch, deliberate contrast with refund/inventory's 404); company/contact/deal writes use ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004's If-Match CAS; owners/assignees are auth ids resolved live (fail soft) and checked active on write (fail closed); rejected: entity-scoped reads, one permission for all, per-record ACLs, CRM tables in estimai-api (see docs/adr/20261101-crm-tool-shape-and-authorization.md)
- [20261101] The user directory's second consumer: the `crm` catalog's `deal:manage` is added to `DIRECTORY_GATE_PERMISSIONS` (ADR 20261006-user-directory-endpoint-capability-gated's escalation trigger) for the CRM owner/assignee pickers — deliberately NOT `crm:access` or `contact:erase`; endpoint shape/population/rate limit unchanged, crm-api keeps no copy; a non-holder's records default to themselves and the UI shows the owner read-only on 403 (see docs/adr/20261101-user-directory-gate-widened-to-deal-manage.md)
- [20261101] CRM money is its own permission: the `crm` catalog's `deal:financials` (unconditioned; seeded to `admin` and `sales`, NOT to the new `crm-technical` role = `crm:access` only); crm-api OMITS — never zeroes — deal `amountCents`/`currency`/`notes` and pipeline `totals` for a caller without it, offers and entity profiles require it, an attachment is downloadable without it only by its uploader, `GET /scope` reports `financials`; `deal:manage` without `deal:financials` is unsupported (seed never creates it, every money route refuses it); rejected: UI-only hiding, a read-only technical role, per-deal visibility, entity-scoped financials (see docs/adr/20261101-crm-financial-visibility-permission.md)
- [20261101] `auth POST /authz/app-access-check` also answers by `{ appId, userId }` (exactly one of email/userId; same caller gate, limiter, byte-identical negative and timing floor; probe `id = $1 AND deletedAt IS NULL`) and `GET /authz/users/directory` takes an optional `?appId=` narrowing to holders of `(appId,"access")` — `crm-api` knows only auth ids and the pickers must offer only people who can open the CRM; amends ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt and ADR 20261006-user-directory-endpoint-capability-gated, same gate so the audience does not widen (see docs/adr/20261101-app-access-check-by-user-id-and-directory-app-filter.md)
- [20261101] An email notice is addressed by user id: a caller sets `email: true` on notify-api's `POST /system/notifications` (and must hold `emails.send` as well as `notifications.push`), and notify-api resolves the active user's address at send time from a new auth endpoint `POST /system/users/contact` (one user per call, service JWT with the new scope `users.contact` held only by `system:notify-api`, rate-limited, logs no id or address) — no copy kept, a deactivated user gets nothing, the generic English `notification_notice` template is built from the notification itself and is unreachable through `/system/emails`; best effort with `emailStatus` sent/failed/skipped, the in-app row always stands; rejected: crm-api looking addresses up itself (a technician lacks `deal:manage`, every tool would repeat it), granting `users.contact` to crm-api, a synced address copy in notify-api, a batch lookup (see docs/adr/20261101-notify-api-resolves-email-notice-address-from-auth.md)
- [20261102] crm-api reads its own bucket's object bytes to build an offer — the bounded-read rule of ADR 20260908-request-archive-export-refund-api-reads-attachment-bytes, second caller: the deal PDFs a user appends as annexes (≤ 5, total `sizeBytes` ≤ 20 MiB checked from the DB BEFORE any `getObject`) and the entity's letterhead PDF (≤ 5 MiB, key must match `letterheads/<entity>/<uuid>.pdf` before it is read or deleted); proxying a requested file stays forbidden (ADR 20260716-eu-object-storage-refund-attachments) and downloads stay presigned GETs; an unreadable or non-PDF file fails the WHOLE generation with 422 `attachment_unreadable` naming it (no placeholder, the rolled-back transaction keeps the offer number); escalation trigger — a third service reading bytes, a file the user did not choose, or > 25 MiB per request (see docs/adr/20261102-crm-api-reads-attachment-bytes-for-offer-annexes.md)
- [20261104] Visibility by relationship to the record, never by role, and a read of your own data must not hang on a remote authority — meetings content opens only for creator / Operai participant / opted-in host reader (anything else 404, identical to nonexistent); no role (admin, `meeting:erase`) ever reads content; `selfScoped` reads work without `auth`, every create/generate/ask/edit is `capability(...)` live + fail closed; deletion of your own data needs no grant; ungated `./MyMeetings` AND self-scoped API both required (see docs/adr/20261104-meetings-tool-shape-visibility-by-participation.md)
- [20261104] A cross-service "may this user…" question is asked as the USER, a state push is sent as the SERVICE, and a replicated state must survive reordering — meeting host `resolve` forwards the caller's JWT and fails closed for every grant (soft only for labels); `notices` use scope `host-notices.send`, a strict content-minimal body, per-meeting `seq` and an outbox (manual retry for linked/changed, until-delivered for unlinked/deleted, null title on removal so nothing outlives a delete); hosts are registry data, never a branch (see docs/adr/20261104-meeting-host-contract-resolve-and-notices.md)
- [20261104] A cross-app UI seam must not let the other side's code failure become the host page's failure — hosts embed Meetings via `shell/extensions` `HostExtension` (props = three strings) with 5 s timeout + error boundary + the host's own fallback, and import the seam dynamically; coarse domain widgets only, NOT precedent for shared primitives (ADR 20261031-shared-ui-library-consumed-as-source stands) (see docs/adr/20261104-host-extension-federated-panel-through-the-shell.md)
- [20261104] User content must never leave the permitted jurisdiction or be retained by a processor through a change we did not make in code — every hop (storage, transcription, LLM, any future one) is verified at STARTUP (exit 1): EU/CH regions, retention settings (unreadable = refuse), no fake provider in production, model id pinned, a model change needs a green eval; the provider choice (Azure Speech + Bedrock) is superseded by 0069 (see docs/adr/20261104-meetings-ai-providers-eu-zero-retention.md)
- [20261104] User-requested work must be neither lost nor left looking pending, and time-based state must never depend on a writer — Postgres `meeting_job` queue (SKIP LOCKED, lease, `attemptId` re-check at commit, enqueue in the same transaction) runs asked-for work only; every time-derived state (interrupted, expired, stale, stuck-pending reads failed) stays derived on read, never swept (ADR 20260714-invitation-lifecycle-derived-expiry-state boundary) (see docs/adr/20261104-durable-job-runner-work-queued-state-derived.md)
- [20261104] A deletion promise must hold when our code is not running, and a storage setting must not quietly undo it — audio expires by a bucket-wide 29-day lifecycle rule verified at startup (no prefix filter, versioning not enabled, else refuse), lazy delete on read, explicit deletes remove the bucket prefix FIRST (503 and nothing changed on failure); backups of transcripts are an open gap (R7) (see docs/adr/20261104-audio-retention-bucket-lifecycle-verified-at-startup.md)
- [20261104] Reading user-supplied bytes through our own process needs a ceiling, an allowlist and isolation, and the reason must not widen — meetings-api is the THIRD byte reader (ADR 20260908-request-archive-export-refund-api-reads-attachment-bytes/0057): only `prepare_audio` and the upload probe, ≤ 500 MiB streamed to disk, demuxer allowlist authoritative only on the LOCAL file (`-protocol_whitelist file`; the URL probe is an early reject, a scheme list does not bound hosts), `-format_whitelist` on every input, output caps (`-t`, `-fs`) that fail as `too_long`, non-root, minimal child env, timeouts, keys fixed server-side; a FOURTH reader, a file the user did not choose, or a new media type revisits this ADR (see docs/adr/20261104-meetings-api-reads-audio-bytes-third-reader.md)
- [20261104] A message crossing a service boundary must be rendered in the READER's language, and a new field must reach every surface that renders it — notify-api `/system/notifications` takes optional `it: {title, body}`, stored, returned by list AND SSE, picked by notify-ui and `ToastHost` from `<html lang>` with English fallback; no per-user language on the server (see docs/adr/20261104-bilingual-system-notifications.md)
- [20261104] A gate defined by a permission is only as narrow as that permission's holders — `meetings:access` joins `DIRECTORY_GATE_PERMISSIONS` (third consumer after 0053/0055), so with the default employee grant (0068) EVERY employee can list every active user; the user accepted this explicitly at the plan gate; participants are re-validated server-side as active (fail closed); any new default grant must first enumerate the gates that list the permission (see docs/adr/20261104-user-directory-gate-meetings-access.md)
- [20261104] Untrusted text is never instructions and model output is never trusted structure — transcripts are escaped and delimited as quoted data, output is one offered, unforced tool whose reply is accepted only as exactly one schema-valid call (else `invalid_output`, one resample, then `failed`; text/thinking discarded unread — the guarantee is our validation, not a provider mechanism, amended 2026-11-05) with no actionable tools, the server renders headings/order/count and drops uncited or unknown citations, invalid output is `failed` never partial, rendering is plain text (no links/images), whole record in context with no embeddings store; injection evals are a release and model-change gate (ReviewAI/ProposAI inherit) (see docs/adr/20261104-ai-output-structured-validated-plain-text.md)
- [20261104] A default grant silently widens every gate that lists its permission — `employee` gets `meetings:access` (the suite's FIRST default grant, explicit departure from specs/20260713-auth-roles-permissions, accepted by the user at the plan gate); `template:manage`/`meeting:erase` stay `admin`-only and pinned by a seed contract test; not a template for tools reading shared business data; the auth re-seed deploys first (see docs/adr/20261104-default-employee-grant-meetings-access.md)
- [20261105] Meetings AI on Google Cloud, with every retention setting either read at startup or signed off — a processor's intermediate storage (staging bucket, soft-delete window, operation store, logging toggle) is a retention decision of its own and its default is often long; whatever the vendor exposes is verified (exit 1 when wrong or unreadable), whatever it does not is a named sign-off with an owner, never implicit: Chirp 3 BatchRecognize (`eu`) through a transient EU GCS bucket (1-day lifecycle, soft delete 0, deleted at attempt start/in `finally`/before any DB change on user deletion) + Claude on Vertex `eu` multi-region (never `global`, no Fable/Mythos, no caching); user-accepted exception 2026-11-05: Google may keep the async transcript ~5 days; supersedes 0061's provider choice (see docs/adr/20261105-meetings-ai-providers-google-cloud-eu.md)
- [20261105] Never assert that two independently labelled things are the same — long recordings are transcribed in parts and parts overlap and a label joins the previous part's only on text evidence (≥ 20 matched words with mutual ≥ 80 % agreement, never by position, number, voice matching or the audio; a silence in the overlap no longer refuses), otherwise it stays separate and the creator can separate a joined one (a false merge reaches every summary invisibly, a false split costs one rename; amended 2026-11-05 and 2026-11-09 after a production recording joined 0 of 9 labels); the same shape applies to any labels, ids or clusters joined by position across files, batches or meetings (see docs/adr/20261105-meetings-transcript-parts-speaker-labels-per-part.md)
- [20261105] Access is decided where a principal comes into being, never after — only a live pending invitation (verified email) or the bootstrap admin creates a user, and both only for an allowed-domain email, in better-auth `user.create.before`; an outside-`ALLOWED_SIGNUP_DOMAINS` email (welld.ch, welld.it) is refused even with an invitation; everyone else is recorded in a separate `access_request` waiting list that grants nothing, and approving it creates an invitation via specs/20260713-user-invitations (never a user, no second activation path); a new user-creating path (import, SSO, test endpoint) must be deliberate and listed, and no test exemption goes inside the gate; amends specs/20260713-auth-roles-permissions AC-6.3 and specs/20260713-user-invitations Non-goals (see docs/adr/20261105-access-only-by-invitation-waiting-list.md)
- [20261105] A best-effort notice must not block, undo or leak through the action it announces — `system:auth` gains `notifications.push` bound to origin `admin` (amends ADR 20261013-auth-mints-own-service-credential-in-process/0049 "auth: email only") to notify every effective admin of a new access request, in-app plus `email: true` (notify-api resolves addresses, ADR 20261101-notify-api-resolves-email-notice-address-from-auth; auth sends none), not awaited by the sign-in, failures logged; a new scope ships with its origin binding, and any other origin revisits the ADR (see docs/adr/20261105-auth-pushes-admin-notifications.md)
- [20261105] A state written in two places drifts, and a state replicated by messages must survive loss, repetition and reordering — an estimate is finished only when closed in EstimAI (owner/editor, If-Match, read-only until reopened); estimai-api pushes a content-free notice `{estimateId, event, version, at, byUserId}` to crm-api `POST /system/estimate-notices` with its service JWT (new scope `estimate-notices.send`, ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049), best effort; crm-api accepts only `system:estimai-api`, applies under a row lock only a newer version (`estimaiVersion`, reset on relink), completes or reopens the task and notifies; the CRM's own Mark ready/Reopen are removed, the override stays (since 2026-11-13 open to whoever manages the deal's entity, not only admins); a second follower, content in the notice or guaranteed delivery revisits it (see docs/adr/20261105-estimai-closes-the-estimate-crm-follows.md)
- [20261105] A transcript that cannot be proven complete says where it may not be — a silent omission by a producer that reports success is read downstream as a complete record (and absence as fact): detect probable gaps from an independent signal (audio energy vs the word timeline), mark final gaps (the per-part retry is suspended, tries = 1, because the provider returned byte-identical results 8 of 8 times; revisit under O15 only with DIFFERENT audio; a repetition never flags a part; duplicates removed same-speaker within a part) and have the SERVICE write the caveat on every derived artefact (summary, answer, copy); empty-with-gaps is `failed` `speech_not_transcribed`, never "no speech"; any new consumer of a transcript must carry the gaps; the gap bound is 60 s and the creator can mark a range "no speech here" after listening, which withdraws the service's caveats (amended 2026-11-09) (see docs/adr/20261105-meetings-transcript-completeness-detect-retry-mark.md)
- [20261108] A privilege for looking must not become a dependency of, or a write path through, the ordinary path — estimai-api enforces ONE catalog permission, `estimate:read-all` (unconditioned, seeded to `admin` only), resolved live from `auth GET /authz/resolve` ONLY on the oversight path (`GET /estimates?whose=all`: 403 `oversight_required`, 503 `authz_unavailable`; `GET /estimates/{id}` only when no owner/collaborator relationship: 200 `access:"oversight"` else 404); own/shared estimates never call `auth`; any write route answers a holder 403 `oversight_read_only` (404 if the check fails); `oversight` is a wire value, never stored or a collaborator level; an existing level always wins; amends 0036, narrows 0037; rejected: `estimate:view`, `requireAdmin`, admin as implicit editor, enforcing every route; revisit for oversight writes, conditioned oversight or > ~500 estimates (see docs/adr/20261108-estimai-oversight-permission-amends-0036.md)
- [20261108] A fact about a record is stated only by its owner, and a copy kept by messages must survive loss, repetition and reordering — crm-api pushes `{estimateId, dealId, event: linked|unlinked, at}` to estimai-api `POST /system/deal-link-notices` (service JWT, scope `deal-link-notices.send`, `sub` must be `system:crm-api`) for the EstimAI "Deal" badge; EstimAI stores only `crmDealId`/`crmLinkAt` and never learns deal content; one conditional update applies only a newer `at` (equal: unlinked wins; unlink clears only the same dealId), ordered by the CRM clock because there is one replica and at most two events per link; best effort, never fails the CRM action, repaired by the re-runnable `crm-api/scripts/backfill-estimate-links.ts`; any future deal deletion MUST send `unlinked`; grant the scope in production `SERVICE_CLIENTS` only AFTER the new auth is live (an unknown scope stops auth); a second replica, a relink path, deal content or guaranteed delivery revisits it (see docs/adr/20261108-crm-pushes-deal-links-to-estimai.md)
- [20261110] When a provider's per-request limit forces a split that the product then repairs by guessing, change the limit, not the repair — meetings transcription moves from Chirp 3 (20 min per request, 10-minute parts, labels restarting per part: 9 labels for 2 people) to `gemini-3.8-flash` on Vertex AI `eu` (never `global`), model pinned in code, a meeting up to 30 minutes in ONE request (longer: 30-minute overlapping parts through the unchanged detector and stitcher), audio inline, temperature 0 + response schema, the reply accepted only as exactly `[{start,end,speaker,text}]` (one resample, then refused), segment times trusted only when ordered and inside the part, the prompt never states a speaker count, request-response logging checked off at startup for the model too; gap detection is weaker (segment-level times); Chirp 3 kept behind `MEETINGS_TRANSCRIBER=chirp`; rejected: AssemblyAI/Speechmatics/Gladia (new processor), Gemini 3.5 Transcribe (15 min per file), self-hosted Whisper+pyannote (voice embeddings, AC-6.17); supersedes 0069's transcription provider (see docs/adr/20261110-meetings-transcription-gemini-on-vertex-eu.md)
- [20261110] Something running on the person's behalf must never become invisible because the code that draws it failed — a remote may ask the shell for a FLOATING SLOT that survives navigation (`openFloating(name, props)`/`closeFloating(name)` in `shell/session`, `FloatingHost` mounted by `ShellLayout` outside the outlet, `@operai/ui` `FloatingPanel` on the window's edge clear of header/footer, dragged or moved with the arrow keys, position in memory); the shell owns the frame and a fallback ("Recording in progress · Open meeting") shown while loading and on any failure, the remote owns the content through the ADR 20261104-host-extension-federated-panel-through-the-shell loader (`meetings.recorderDock` → `meetings/RecorderDock`, plain-string props); the remote asks, the shell never loads a remote to find out; keeping the work alive stays the remote's job (the recorder counts holders, the panel hands the session to the widget and takes it back, the remote keeps the tab-close prompt); feature-detected both ways; amends specs/20261104-meetings AC-2.10 (no in-app prompt) and adds AC-2.12; rejected: a widget in the routed page or a portal from it, the shell rendering the recorder, loading the remote on every page, persisting the position (see docs/adr/20261110-shell-floating-slot-for-remote-widgets.md)
- [20261103] The project module is a seventh tool (`projects-api` :8086, DB `projects` + `projects-ui` :5181, shell route `/projects/$`) — a capability must be checked at the grain of what it protects (this record's entity, this field's owner), never just at the route, and a shared record must never be written from a stale picture; gating reads like writes is the same mistake as gating writes like reads: reads are open to every `projects:access` holder (both entities, ADR 20261101-crm-tool-shape-and-authorization posture); every write on a project or contract is entity-scoped `project:manage` (403 `out_of_scope`, NOT 404 — the caller can read the record; a refused write changes nothing) AND takes `If-Match` (ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004; creates do not), including derived writes (transition, type change, team replacement, end date) and whatever principal runs them (specs/20261103-projects-handoff hand-off); the Bexio order id is a field owned by another role, so it has its own route and capability `contract:bexio` (`accounting`, unconditioned), accepted by no other route, and no other route reads it to decide anything; contracts are never deleted (DELETE 405 `not_deletable`, they end by an end date); no money anywhere in the module (D14); ids are text cuids; the seed adds the system role `project-manager`, gives `sales` access + entity-scoped manage and `accounting` access + bexio (no new administration role), `employee` nothing; `project:manage` joins `DIRECTORY_GATE_PERMISSIONS` (ADR 20261101-user-directory-gate-widened-to-deal-manage/0055, no other catalog may declare a `project:manage`) for the PM/team pickers while the list's PM filter reads `GET /project-managers` (access only); rejected: project tables inside crm-api, per-project visibility, a dedicated administration role, deleting a contract, a create-only capability for `sales` (see docs/adr/20261103-projects-tool-shape-and-authorization.md)
- [20261103] A service that needs a narrow fact owned by another permission domain gets it over a narrow, purpose-scoped channel — never by forwarding the user's token (it fails for the users the feature is for), by widening the other domain's access, or by copying the data — and an unanswered question is handled per path, not once (a read degrades, a write that must confirm refuses), in either direction between two tools: projects-api reads CRM companies as `system:projects-api` with the scope `crm.companies.read` (`KNOWN_SERVICE_SCOPES`, ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049 pattern) on crm-api `GET /system/companies` — its first `/system/*` route; `SERVICE_AUDIENCE` JWT only, a user JWT is never accepted, every credential failure is the same 401; returns `{id,name,entity,archived}` and nothing else (`q` non-archived, `ids` ≤ 100 archived included, `limit` default `ids.length` with ids); reads fail soft (`name: null`), a write that must confirm a company is 503 `crm_unavailable`, an unknown or archived company is 422 `company_not_found`; crm-api reading projects would need its own scope and its own route, and specs/20261103-projects-handoff's deals scope is a new scope, never a wider `crm.companies.read`; rejected: forwarding the user JWT, snapshotting company names, granting OPS `crm:access` (see docs/adr/20261103-projects-api-reads-crm-companies-with-scoped-service-credential.md)
- [20261110] A record's access is asked of the one service that owns its entity, as the caller, on every request, and never copied into a second store — activities-api holds the records and no permission catalog; each host answers `POST /activity-host/v1/resolve` with the forwarded JWT (2 s, batches of 25, never cached, fail closed → 503 `host_unavailable`, missing or unreadable → 404 identical to nonexistent), hosts are registry data; rejected: per-tool activity tables, crm-api as owner, an `activities` catalog in auth, hosts proxying activities-api; revisit when resolve p95 > 300 ms on CRM pages (add a `(sub, perm_epoch)` cache), a third host is added, or a host's access is per record (see docs/adr/20261110-activities-service-access-delegated-to-host.md)
- [20261110] Caller-chosen ids replace cross-service transactions — a write that used to share a transaction becomes an idempotent call under an id the caller picks, compensated on failure; an erasure is ordered before the delete and fails closed, and a guard commits with the data it protects, never in another service (see docs/adr/20261110-caller-chosen-ids-replace-cross-service-transactions.md)
- [20261110] Records move between services by expand → copy → contract, and a copy is trusted only when a found-vs-present count proves every record arrived (never on exit code alone); a short announced write pause removes the dual-write and deploy-order gaps, and the source is dropped only in a later push, never with the switch (see docs/adr/20261110-activities-migration-write-pause.md)
- [20261111] Business content leaves our process for a third party's delivery network only in a form that party cannot read — push is standard Web Push with notify-api encrypting each payload (RFC 8291 aes128gcm, RFC 8292 VAPID, `web-push`); a plaintext-body API (FCM HTTP v1, any relay or email API) is not used for content, and any new intermediary call built from user or notification fields states what the intermediary can read, keep, and where the ciphertext and its metadata travel; rejected: FCM, content-free push with a service-worker fetch (needs a credential in the browser), hand-written RFC 8291 (kept as fallback) (see docs/adr/20261111-web-push-encrypted-payloads-not-fcm.md)
- [20261111] Whether a person sees a thing is decided by the party that can observe the state, never by a proxy for it (an open connection, a visibility flag reported earlier) — a push is suppressed or shown by the shell's service worker from the browser's own `visibilityState`, every device gets every push, and `tag` = notification id dedups per browser; rejected: skipping push while an SSE stream is open (a background tab swallows it), tabs reporting visibility to notify-api (racy, stale at the switch), always showing (double alert); Safari (endpoint `web.push.apple.com`) always shows, because it cancels the subscription after pushes that show nothing (confirmed by the specs/20261111-push-notifications spike) (see docs/adr/20261111-push-suppression-decided-by-the-browser.md)
- [20261112] A limit protecting one party's volume or failures is keyed by that party's verified identity and consulted only after its credential verifies — a shared network address, a claimed client id or a global constant charges one caller's traffic or mistakes to every other caller, and a refusal must never reveal credential validity; auth's `/system/*` routes verify first, count valid requests per calling service (300 tokens, 600 lookups per 10 min) and invalid ones per source address (20 per 10 min, one counter for both routes), with one byte-identical 429 and a fixed `Retry-After`; any new `/system` route inherits this (see docs/adr/20261112-system-endpoints-limited-per-verified-service.md)
- [20261112] A per-event check paid from a budget shared with other callers is spent by whoever raises the most events, and a memo of its answer must start its clock when the question is sent and keep only the granting answer — push's liveness check reuses a `found` answer for 30 s per user, counted from send, single flight, never `inactive` or `failed`; email notices stay a fresh lookup per send; before a new per-event caller joins a shared lookup, check its volume is caller-controlled (see docs/adr/20261112-push-liveness-answer-reused-30-seconds.md)
- [20261113] A setting that matters for correctness must live in exactly one place that is actually read — the Railway project (services, Postgres, volume, buckets, domains, build/deploy, replicas, EU region) is declared in `.railway/railway.ts` (Railway IaC, SDK `railway` pinned at the root), changed by a commit, previewed with `railway config plan` and applied by a person with `railway config apply`; variables stay unmanaged (no value or secret in the file); a destructive plan is a stop (in a single-file setup an omitted resource is deleted — never `--confirm-destructive` unread); `railway-drift.yml` plans on weekdays and fails on drift; the per-service `railway.json` (Config as Code, unread after 2026-12-01) were migrated by aligning the dashboard FIRST, then cutting over, then removing them; rejected: waiting for the cutoff, dashboard-only, managed variables, Terraform/Pulumi (see docs/adr/20261113-railway-infrastructure-as-code.md)
- [20261113] A document that names a resource by address makes every reader fetch what the author wrote, and a delete that removes the record before its stored bytes leaves bytes nobody can reach — a task's description is TipTap JSON (tasks only, ≤ 128 KiB, a plain `body` kept as paragraphs) whose images are nodes naming one of THIS task's stored files by id (else 422 `image_not_found`), rendered as React elements, never HTML; files live in activities-api's own EU bucket `activities` (presigned POST with type/size pinned, uploader confirms, 60 s presigned GET; images png/jpeg/gif/webp ≤ 10 MiB, attachments ≤ 20 MiB, 20 per task), access is the task's (read = see, edit = add/remove), the object is deleted before its row (task delete 503 on a bucket failure, FK RESTRICT), images dropped from the text are cleaned on the next save (no sweep), and forms keep chosen files in the browser until the task is saved; amends specs/20261110-activities AC-3.6 (see docs/adr/20261113-task-description-files-in-activities-api-bucket.md)
- [20261113] A way of organising shared records is the organiser's own — meeting folders are personal (`meeting_folder` per owner, `meeting_folder_entry` PK `(meetingId, userId)` so one folder per meeting and person, composite FK so an entry can only point at the same person's folder), one level, names unique per owner ignoring case, ≤ 200 per person; JWT-only `selfScoped` routes (`/folders`, `PUT /meetings/{id}/folder`), someone else's folder is a 404, `GET /meetings?folder=<id>|none`; deleting a folder leaves its meetings in no folder; never read by a model, a host or a log; rejected: creator-set or team-wide folders (a second access path to meetings, against ADR 20261104-meetings-tool-shape-visibility-by-participation), tags, nesting (see docs/adr/20261113-personal-meeting-folders.md)
- [20261104] Two tools that own different facts see each other's by asking the owner live over a scoped service credential — never by a copy or an event that must be kept right — and "could not find out" never shows as "nothing there", and "still free?" is decided by the store, not by a check: `crm.deals.read` (crm-api `GET /system/deals`: `stage=won` or `ids`, no amount/currency/owner/notes, won capped at 500 with `truncated`) and `projects.purchase-orders.read` (projects-api `GET /system/purchase-orders?dealIds=`: project + Bexio order id; amended 2026-11-05 from the 2026-11-04 `contracts` names, ADR 20261105-terms-and-purchase-order-two-optional-records-of-a-project-contract-retired) behind `system:<client>` service JWTs, a user JWT never accepted, one identical 401; the to-start queue and the "deal is no longer won" notice are computed at read time (no event, sync or backfill, D17); the queue and a take fail closed (503 `crm_unavailable`), a project/purchase order and the CRM deal page fail soft with unknown kept distinct from none (`deal.won: null` vs `false`, `deliveryKnown: false` vs `delivery: null`); crm-api reads projects-api through its OWN token provider, so `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` are a pair required with `NOTIFY_INTERNAL_URL` or `PROJECTS_INTERNAL_URL`; a take re-reads the deal's live stage and writes the project, its terms and its purchase order in one transaction — the unique `purchase_order.dealId` index, not the pre-check, arbitrates a race (409 `deal_taken`, nothing left behind); amended 2026-11-05: a third channel `crm.contacts.read` (crm-api `GET /system/contacts`, the PO's referent, personal data, ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047) and no attach; rejected: syncing or eventing deals into projects-api, forwarding the user JWT, reusing notify's token provider (see docs/adr/20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials.md)
- [20261104] A figure has one author, and a value whose authority is elsewhere is never client input on ANY write path (create, update, import) — estimate-backed contract man-days are copied once from the estimate: a take sets them, `PATCH` keeps them, the client OMITS the member and sending it, even as `null`, is 422 `estimated_man_days_from_estimate` (omitted is never `null`); EstimAI 404 → `null` with `estimateId` kept, EstimAI unreachable or unconfigured → 503 and nothing written; estimai-api's first `/system/*` route, `GET /system/estimates/{id}/summary` (scope `estimai.estimates.read`, `SERVICE_AUDIENCE` JWT only, one identical 401), reads any estimate regardless of owner or collaborators — the one query not scoped to `sub` — so its answer is only `{ id, name, manDays }`, never content; `manDays` = Expected effort without AI gain, the unrounded sum rounded half up ONCE to one decimal, the formula a byte-identical copy of crm-api `src/offers/scope.ts` (`manDays` group in `scripts/check-shared-copies.ts`; change both in one commit); the router is mounted BEFORE the user-JWT estimates routers in `estimai-api/src/index.ts` (mounted after, it meets their wildcard `jwtMiddleware` and a service credential gets 401); rejected: forwarding the user JWT, a snapshot in crm-api when an estimate is marked ready, the latest offer's figure (see docs/adr/20261104-estimai-api-first-system-route-estimate-man-days-for-a-service-credential.md)
- [20261105] A project has two OPTIONAL records, never one record with a half-null side: `project_terms` (0..1, `projectId` UNIQUE — the old `contract` table minus its deal/company/origin/Bexio columns, every 021 terms CHECK kept as `terms_*`, `terms_not_internal`) for ANY project that has terms, and `purchase_order` (0..1, `projectId` UNIQUE, `dealId` UNIQUE NOT NULL, `estimateId`, `bexioOrderId`, `referentContactId`, `opsManagerId` NOT NULL) only for what a won deal brings; a PO is born only from the take (project + terms + PO in ONE transaction) — no route attaches, adds a PO to an existing project or changes a type, so "a hand-made project never has a PO" is "no route creates one" (PO routes `404 purchase_order_not_found`), and a PO is never deleted; a hand-made project may carry terms (`POST`/`PATCH`/`DELETE /projects/{id}/terms`; `409 terms_exist`/`terms_required`/`terms_not_allowed`), the nested 021 wire shape `{ startDate, endDate?, terms: <per-type> }` is kept, `projectManagerId` is nullable only while a PO exists, and the company CHECK is `("companyId" IS NULL) = ("type" = 'internal')` (`saas` is a client type); "contract" is retired in every checked identifier (`contract:bexio` → `purchase-order:bexio`, the contracts service scope → `projects.purchase-orders.read`, the old one refused at startup, `/system/contracts` → `/system/purchase-orders`); the migration is STACKED on PR #7 — 021's `20261103163000_init` kept byte-for-byte, one new `20261105120000_purchase_order` that opens with a guard REFUSING to run if `contract` has any row or any `saas` project exists (refuse instead of convert: data the new model cannot represent unambiguously is handled by hand); rejected: terms as columns of `project`, one `purchase_order` table with nullable deal columns (the hand-entered contract again), keeping the word "contract", converting data in the migration, rewriting 021's init (see docs/adr/20261105-terms-and-purchase-order-two-optional-records-of-a-project-contract-retired.md)
- [20261105] A permission about people is decided at the grain of what it protects and never by a copy: `handoff:take` (sales own entity, admin unconditioned: the queue and the take, with `project:manage` for the deal's entity — `403 forbidden` without any, `403 out_of_scope` for another entity) and `purchase-order:receive` (the new `ops-manager` role own entity, admin unconditioned: be a PO's ops-manager); auth `GET /authz/users/holders?resource=purchase-order&action=receive&entity=` (forwarded caller JWT, gate `HOLDERS_GATE_PERMISSIONS = [handoff:take]` — NOT the directory gate —, own limiter counting 403s, `no-store`, strict query, the pair pinned server-side so any other is `400 unsupported_permission`) answers `{ users: [{ id, name, unconditioned }] }` — no email, no entity — for active users who hold the pair for that entity (mirroring `scopeFor`, fail closed) and `projects:access`; **amends ADR 20261006-user-directory-endpoint-capability-gated** for this endpoint only by allowing the `unconditioned` bit (the directory's four fields, gate and "no role or other attribute" rule are unchanged; a further field is a change to ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047); the admin override `oversees` = `scopeFor(permissions, "purchase-order", "receive", entity).length === ENTITIES.length`, NEVER `hasCapability` (it ignores conditions); the project manager of an awaiting project is picked only by the PO's `opsManagerId` read from the row who STILL holds `receive` for the entity, or by an `oversees` admin (`403 not_ops_manager`), check and write under the `If-Match` CAS, `planned` → `active` refused while awaiting; the ops-manager is chosen from auth live at the form and re-validated at the take (`422 ops_manager_invalid`, auth down `503 identity_unavailable`, fail closed, no cache); security rules (T18): the referent is an id on the PO, its name/job title/email/phone read LIVE from crm-api `GET /system/contacts` (`crm.contacts.read`, projects-api only; per-mode minimal shapes via explicit `select`, `ids` ≤ 20) once per project read and only when set, NEVER stored or cached, `Cache-Control: no-store` on every referent/contact answer, the same predicate at read and set (exact id + the project's/deal's company; one identical `422 referent_invalid` body), company derived by the server never sent by the client, no contact data in `/system/purchase-orders`, notifications, logs, error bodies or OpenAPI examples, one structured log line per take/referent change/pick, UI memory-only with text rendering and fixed-scheme `mailto:`/`tel:`; rejected: role-name filters on the directory, the directory gate, a reassign-PO flow, `hasCapability` for the override, copying or caching the referent, granting OPS `crm:access` (see docs/adr/20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047.md)
- [20261114] The design system is compiled once, by the shell, and shared with every remote as a Module Federation singleton — **amends ADR 20261031-shared-ui-library-consumed-as-source** (point 2 and its rejected option D): the shell shares `@operai/ui` `{ singleton, requiredVersion: false }`, every remote declares it `import: false` (no fallback, never bundled); each app resolves it through a `link:../operai-ui` devDependency because the plugin reads named exports from the installed package and a Vite alias bypasses sharing; `dedupe` keeps one React; the rich-text entry stays compiled by its three remotes (TipTap is not in the shell); deploy rule: a remote runs on the LIVE shell's library, so an export is added before a remote uses it and removed only after none does; a remote's standalone dev page no longer renders the library; rejected: per-app copies, a share with fallback, a `shell/ui` expose, sharing rich-text now (see docs/adr/20261114-operai-ui-shared-singleton-provided-by-the-shell.md)
- [20261115] Two implementations of one rule drift apart while each stays internally consistent, and a value a person typed becomes structure once it reaches a parser — any text an author writes (offer templates, `compute:` expressions, `source:` bindings) is read by the one pure engine `crm-api/src/offers/engine/` and its byte-identical copy in `crm-ui/src/lib/offerEngine/` with shared vectors, never a second parser, formatter or markup string built from an answer; a preview is drawn from the same resolved structure as the PDF; amended 2026-11-15: a CRM-supplied value (issuer legal name, issuer address) that is blank prints nothing and is never a missing field, a profile value is escaped exactly as an answer, and `systemRead` reports which system values the printed text read (see docs/adr/20261115-offer-template-self-describing-text-shared-interpreter.md)
- [20261115] A commit must be the version the person reviewed, and every delete of a working copy must name the version it consumed — generate, send and approve take no body: they read the stored draft pinned by `If-Match` and the template version, delete it with `WHERE version = $consumed` in the same transaction, and remove any object written inside that transaction when any later statement fails (see docs/adr/20261115-offer-draft-server-held-generated-from-stored-state.md)
- [20261115] A group that must keep exactly one current member is changed in one transaction, never by two writes, and an act that retires a member a person owns is the same act whether a person or a seed performs it — every route that makes an offer template current (create, duplicate, restore, language change, seed) runs the supersession function under the entity's advisory lock, and a legacy restore or the last active template of an (entity, language) is refused (see docs/adr/20261115-offer-template-format-supersession-per-entity-language.md)
- [20261115] A figure printed under a label is summed over the scope its label names, with one inclusion rule everywhere it is summed — a cost table prints a total per span of lines and never counts an option line, while the stored price stays the one-off figure, so a printed first-year total and a stored price can differ; a percentage discount must name its base (see docs/adr/20261115-offer-cost-table-total-rows-and-option-lines.md)
- [20261115] Uploaded bytes handed to a third-party parser become that parser's code paths — a browser renderer of a user file gets no worker, wasm, eval, font or map loads, no bearer credential (our code fetches the link and passes bytes only) and no CSP change, is exact-pinned and re-proven on every bump; a preview renderer of a file the PDF also reads is a second reader to check against the printing one — amended 2026-11-15 (OA-3, M-4): the letterhead is one render drawn on every page, and a main-thread parse is admissible only behind the server's decoded-size bound (`boundPdf`, checked and stored before any draw), with pdf.js `maxImageSize` as the second guard (see docs/adr/20261115-letterhead-preview-pdfjs-main-thread-in-the-remote.md, Amendment 2026-11-15)
- [20261115] A default that rewrites a copy it once wrote decides from the copy's content, once, under the lock and a version guard — a seeded row is replaced only while its SHA-256 equals a recorded shipped revision, otherwise marked kept and never revisited; an edit that differs only in spacing is still an edit, and no new default may insert a row beside a person's or rewrite text on every read (see docs/adr/20261115-seeded-content-upgraded-in-place-only-when-unedited.md)
- [20261115] Bytes a person supplied are sized by what a parser would decode, never by what the file says about itself — a length, a dimension or an object count the file writes is a claim, not a bound: any parser or renderer of a user PDF (crm-api, the browser, a deal annex, any future reader) runs only after `boundPdf` (decoded size, objects, streams, image pixels; `/Length` never read; JBIG2, Crypt and unknown filters refused) and stores only the checked bytes under a key nobody can still write (see docs/adr/20261115-uploaded-pdf-decoded-size-bound-before-parse.md)
- [20261115] A page break in an HTML rendering is layout, never content — one continuous text flow with empty floats for the gaps and a decorative, `aria-hidden`, `inert` page layer behind it: no page element, clipped copy, hidden measuring copy or multicol, and nothing in the flow establishes a block formatting context or paints a border except tables, their cells and a hand-edited section's clipped rule; any new flow element is checked against the in-page measurement (see docs/adr/20261115-paginated-preview-one-flow-float-rail.md)
- [20261112] Time entries get their own service and an ungated catalog with one oversight permission — `hours-api` (port 8088, DB `hours`) owns entries, categories and work types; the `hours` catalog has no `access` resource and carries `time-entry:read-all` (resolved live only on the oversight path, ADR 20261108-estimai-oversight-permission-amends-0036 shape) and `time-list:manage`, both admin-only and unconditioned; a holder of a read privilege never gains a write, and a record with a single writer takes no version precondition (see docs/adr/20261112-hours-api-time-entries-own-service-hours-catalog.md)
- [20261112] Time bookability is asked of the owner, as the caller, at write time — never decided from a copy of who is involved or with a service's authority: hours-api asks projects-api (`assignees`), crm-api (resolve `entityType: "deal"` → `involved`), activities-api (`GET /activities?dealId=` / `?ids=`) and meetings-api (`GET /meetings?ids=`) live with the forwarded JWT and fails closed, and reads a meeting's current deal from meetings-api's content-free `GET /system/meetings/hosts` (scope `meetings.hosts.read`, sub `system:hours-api`); a fact read with that credential (a meeting's deal) reaches a viewer only with the right to name it, id and name or neither, for every viewer including the author, and totals merge what cannot be named into `hidden` / `unavailable` / `deal-unknown` groups; a `dealId`-filtered read is refused 503 while meetings-api cannot say which meetings are linked, never answered low (the failure shape: a fact held under one service's right shown under another person's right, or a total that looks complete while it is not; see docs/adr/20261112-time-bookability-asked-of-owners-meeting-hosts-system-route.md, amendment 2026-11-12)
- [20261112] A screen every signed-in user must reach is ungated and absent from `TOOLS`, mounted on a shell-owned route with no `beforeLoad` — the hours screens are a new remote `hours-ui` at `/hours/$`, whose self-service calls never check a catalog permission while the oversight view stays behind its own; the admin lists are its Settings tab for `time-list:manage` holders (amended 2026-11-16: moved from admin-ui, as Refund's settings moved to refund-ui) (see docs/adr/20261112-hours-ui-ungated-remote.md)
- [20261116] A stack exception granted for one capability must not become the template for the next, and a service in another language gets none of the controls that a `package.json` used to trigger — `letterhead-api` is Rust with Typst 0.15.1 embedded for document layout ONLY (amends 20260703's "one backend stack"); every other backend stays Bun/Hono/TypeScript, a second Rust service needs its own ADR, and the missing triggers are attached by hand: mise `rust` pin, slim non-root Docker image, Changesets via a `package.json` shim + CHANGELOG, env-doctor entries, compose/Railway (`europe-west4`, DB `letterhead`, EU bucket) (see docs/adr/20261116-letterhead-api-is-a-rust-service-with-typst-embedded-for-document-layout-only.md)
- [20261116] A computation that cannot be stopped from inside must not run where other callers' availability, memory or secrets live, and a limit must be in the unit that runs out — Typst cannot be cancelled, so every render runs in a pre-started worker process (cleared environment, no secret, no network) that the supervisor SIGKILLs at 30 s or at the RSS cap; concurrency is set by worst-request memory (~855 MiB), `LH_WORKERS=2`, `LH_QUEUE=4`, 2 per caller, else 429 `busy`; the comemo cache is evicted after each render; image sizes are bounded from the header before decode (see docs/adr/20261116-renders-run-in-killable-worker-processes-and-concurrency-is-bounded-by-memory.md)
- [20261116] A stored record that promises to reproduce must name the code that produces it, and a guard nobody runs is not a guard — each letterhead version stores a `layout_version` (template + Typst version + fonts pinned by SHA-256), a render always uses the version's own layout (read as well as write; unknown layout refuses), old layouts stay compiled in (newer Typst as a renamed Cargo dependency), and a per-layout golden corpus runs in `.github/workflows/letterhead-api.yml`, a deliberate exception to "no CI runs service tests"; never edit an existing layout to fix a drift (see docs/adr/20261116-a-letterhead-version-pins-its-layout-and-old-layouts-stay-compiled-in.md)
- [20261116] A preview must be made by the same engine as the thing it previews, and a restricted service is reached through the party that holds its credential — the letterhead preview is the PDF's own compile rasterised to 64-colour PNG pages (1.5 px/pt, ~65 KiB a page) plus page text, never SVG/HTML (browser fonts break AC-1.3); crm-ui calls crm-api `POST /deals/{id}/offer-draft/preview` (unsaved draft body), which calls letterhead-api with a service token, never the browser; at the `LETTERHEAD_SERVICE_ENABLED` switch this supersedes 20261115-paginated-preview-one-flow-float-rail and 20261115-letterhead-preview-pdfjs-main-thread-in-the-remote (those files are deliberately not edited) (see docs/adr/20261116-the-preview-is-the-pdfs-own-compile-as-palette-png-pages-and-the-crm-wizard-reaches-it-through-crm-api.md)
- [20261116] A record promised permanent must be protected at the database, not by the absence of a route, and its references must be permanent too — `letterhead_version`, `letterhead_version_asset`, `letterhead_change` and any referenced `letterhead_asset` have `BEFORE UPDATE OR DELETE` triggers that raise (Tier 1, as refund), FKs are `ON DELETE RESTRICT`, actor columns carry no FK (an FK `SET NULL` is an UPDATE), restore creates a new version, only unreferenced uploads older than 24 h are swept; any new history or version-dependent table gets the same triggers and a real-Postgres UPDATE/DELETE refusal test (see docs/adr/20261116-letterhead-versions-assets-and-change-record-are-immutable-in-the-database.md)
- [20261117] Context a person attaches is kept as long as the raw material it explains, and reaches a model unparsed — meeting attachments (files and links, specs/20261104-meetings US-15, A14) live in the meetings bucket under `meetings/<id>/attachments/<uuid>` (presigned POST pinned to an allowlisted type and the exact size, ≤ 20 MiB, 10 files + 10 links per meeting, confirmed by HEAD) and are deleted by the bucket's 29-day rule like the audio (`expired` derived on read); deleting the recording keeps them (`Storage.deleteAudio`), deleting the meeting removes them; editors are the agenda's (`assertMeetingEditor`, host reader 403 `attachment_editors_only`), readers everyone who can open the meeting, downloads a 60 s GET forcing `attachment`; a link is `http(s)` without credentials and NEVER fetched, only its label reaches a model; the fourth byte reader is bounded (PDF/PNG/JPEG/WebP/text only, ≤ 5 MiB each, ≤ 8 MiB total, oldest first, one `aiContextOf` for page and models, signature check only) and forwards bytes UNPARSED to Gemini (transcription) and Claude (summaries, Q&A) on Vertex `eu` — no parser in our process, Office files stored but never read; attachments are quoted data, never instructions, never cited, never evidence; best effort, and a refused request is retried once without them; amends ADR 20261104-audio-retention-bucket-lifecycle-verified-at-startup ("audio only") and ADR 20261104-meetings-api-reads-audio-bytes-third-reader; rejected: a dedicated non-expiring bucket, fetching links, parsing in process, Office to the AI, bytea in Postgres (see docs/adr/20261117-meeting-attachments-in-the-audio-bucket-forwarded-unparsed.md)
- [20261118] Something the system must do on a schedule runs in the service that owns the record, claimed before it acts — inventory-api reminds an employee to confirm a pending assignment 24 h after the offer, then every 7 days until answered (specs/20261006-hardware-inventory US-15): an in-process 15-minute tick (`startReminderScheduler`, off in tests and with `ASSIGNMENT_REMINDERS=off`), the due rule derived from `lastReminderAt` (pure `reminderClock.ts`, shared with the asset view), each reminder claimed by a CAS on `lastReminderAt` before the push and given back when notify-api does not take it or the history write fails; the push is a notify-api email notice (`email: true`), so inventory-api's service client holds `emails.send` too (grant it in `auth` `SERVICE_CLIENTS` before deploying); `POST /assignments/{id}/remind` forces one (`asset:manage`, 409 `reminder_too_soon` within the hour, 502 `reminder_not_sent`); a reminder is an action, not derived state, so ADR 20260714-invitation-lifecycle-derived-expiry-state still holds; rejected: a Railway cron service, jobs queued at offer time, send-without-claim, notify-api scheduling (see docs/adr/20261118-assignment-reminders-in-process-scheduler-claimed-by-cas.md)
- [20261117] A record people rely on to prove what was true must be protected at the database, and its history must not be rebuilt from a weaker record; and two resources must not get names a reader can swap — the legal-entity registry is `legal_entity_version` in auth, append-only (current = highest, no mutable row, a restore inserts n+1), `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers raise (the first Tier 1 table in auth; `audit_log` stays Tier 2), actor columns carry no FK (an FK `SET NULL` is an UPDATE), tests run in a rolled-back transaction, never by deleting rows; read by any signed-in person and by services through `legal-entities:read` (one serializer, two routes); a scope for a suite resource hosted by auth has no service prefix and uses the colon form, in the resource's own word (never `companies:read` beside `crm.companies.read`) (see docs/adr/20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database.md)
- [20261117] A document must print one version of a shared fact, chosen by the party that owns it and never by the caller, and an old peer must refuse what it cannot honour rather than print without it — letterhead-api reads the issuer's details from the registry (`contentVersion: 2`, `entityData` accepted and discarded in v1 and v2, so a skewed deploy fails closed), v2 carries `legalEntityVersion` (409 `legal_entity_version_mismatch` → drop cache, rebuild, retry once); every consumer keeps one cache entry per process, age counted from when the request was SENT, fresh 30 s, usable 60 s only when the refresh fails, then 503 `legal_entities_unavailable` and no document (a preview may degrade, a document may not); any new tool printing the issuer inherits this (see docs/adr/20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds.md)
- [20261117] A permission must not be granted for a page its holder cannot reach, and reaching an area must not open the area's other rooms — `/authz/me` derives `admin` into `apps` for a holder of `legal-entity:manage` over at least one entity (`adminAreaReachable`, built on the coverage function the management routes use; `/authz/resolve`, `/authz/app-access-check` and the directory keep their derivation), admin-ui shows each section by its own capability (hidden URLs redirect), the admin APIs keep `requireAdmin`; `apps ∋ admin` is a menu entry, never proof of administrator rights *Amended 2026-11-19: derivation is a `DERIVED_APPS` table, `admin` from `legal-entity:manage` and `accounting` from `accounting:read` or `manage` covering at least one entity (no `accounting:access` action); a link that depends on one entity (Refund's AC-7.3) is decided by the service from resolved permissions, never from `apps`.* (see docs/adr/20261117-an-app-is-reachable-through-a-capability-it-administers-admin-in-authz-me-apps-and-admin-ui-sections-by-capability.md)
- [20261117] A move is not done while its source can still change and its destination applies stricter rules — the CRM's legal details move to the registry by expand → copy (operator-run dry-run-by-default script in auth, read-only CRM session, credentials in the environment only; never overwrites, a difference is reported `mismatched`) under an announced settings freeze → pre-switch dry run (present 2, mismatched 0) → switch (order-independent) → contract in a later push; version 1 is `action: import`, creator null (the system), values the new rules refuse move as they are and are reported; a tolerated old-client write (legacy keys) is a silent drop, removed at the contract; a new ADR applying 20261110's pattern, not an amendment of it (see docs/adr/20261117-the-crms-legal-details-move-to-the-registry-by-expand-copy-switch-contract-and-version-1-is-attributed-to-the-system.md)
- [20261117] A control that exists to fire after something went wrong must not hang off its trigger by a path that can be lost silently (a restart, a timeout or an outage between commit and send), and must not make the downstream's trouble block the action — a notice of a protected legal-entity change (legal name, VAT, IBAN) is a durable duty: `legal_entity_notice` rows written in the version's own transaction (recipients fixed then, no value in any row, log, key or audit entry), sent by auth's dispatcher (kick after commit + 15 s sweep on every replica, `FOR UPDATE SKIP LOCKED`, 60 s lease, +1/+3/+5/+10/+20 min then 30 min, given up 24 h after the version), every first failure, late success and give-up in the audit log, retries safe by receiver idempotency; amends 20261105 (auth's second kind of notice, same `admin` origin and scopes) and departs from 20260716 §4 (best effort) for this notice only; any new durable send needs the same pair (row with the fact + a receiver that recognises repeats), or a stated reason why best effort is enough (see docs/adr/20261117-notices-of-a-protected-legal-entity-change-are-a-durable-duty-an-outbox-written-in-the-versions-transaction-sent-at-least-once-for-24-hours-with-outcomes-in-the-audit-log.md)
- [20261117] A retried call must not repeat its effect, and a capability must not let every holder do everything it can express — notify-api `/system/notifications` and `/system/emails` take an `idempotencyKey` scoped to the verified calling `sub` (partial unique index on notifications; on emails unique only over `sent` so failed attempts can be retried; a repeat answers 200 before any address lookup; the key reaches Resend as `<sub>:<key>`), and `EMAIL_TEMPLATE_POLICY` binds a template to its callers (403 `template_not_allowed`) and decides who may address by `recipientId` (`legal_entity_change`: `system:auth` only, `data` a strict closed shape, nothing beyond an IBAN's last 4 characters, no free text); a new retried route needs a key, a new template needs a stated caller list and a closed `data`, never caller-written text; amends 20260714 and 20261101 (see docs/adr/20261117-notify-api-system-routes-protect-against-repeats-by-a-caller-scoped-idempotency-key-and-bind-a-template-to-its-caller-with-closed-typed-data.md)
- [20261117] A decision that depends on a server rule must ask the server, not keep a copy that can drift, and a prompt only well-behaved clients see is a convenience, not a control — admin-ui confirms a protected legal-entity change (legal name, VAT, IBAN) by asking `POST /legal-entities/{entity}/versions/check` (the save's own body, rules, authorisation and refusal order; read-only, own limiter, no echo); a refusal of the check is a refusal of the save (no dialog), a check that cannot be made saves nothing, Confirm sends the very body that was checked, every Save checks again; the registry does NOT enforce the confirmation (owner-accepted non-goal, a direct caller is covered by the notice only), so never describe it as enforcement; any dry run must refuse in the save's order and never become an oracle (see docs/adr/20261117-a-confirmation-is-backed-by-a-read-only-server-check-it-is-admin-uis-and-the-registry-does-not-enforce-it-and-when-the-check-cannot-be-made-nothing-is-saved.md)
- [20261117] A mode that exists for one output (the configurator preview) must not alter or leak into the real one, and a patch of a pinned artefact must fail loudly when its anchor is missing — letterhead layouts draw the "missing" mark by an in-memory replacement of one template line (`MARKING_FROM`, exactly once, in `engine/src/layout/mod.rs`; layout 1's `main.typ` is never edited, golden corpus byte-identical), the drawing holds the bare label in ink `3a2a00` over `ffe58a` (no bundled font has `⟦ ⟧`), the page text adds `⟦Label⟧` (a wrapped label keeps both brackets), only the preview job may set `mark_missing`; a layout 2 must provide the mark with the same data (`t`, `m`) and ink and the same tests, else the preview is refused with `Internal "mark missing"`, never drawn unmarked; a new cue needs a text alternative in the layer that can carry it, and a third language or placeholder extends the closed label list, drawing, matcher and tests together (see docs/adr/20261117-a-layout-draws-the-configurators-missing-mark-through-a-runtime-patch-of-one-template-line-the-label-only-in-the-drawing-and-the-brackets-only-in-the-page-text-and-a-layout-that-cannot-is-refused.md)
- [20261118] A control with native browser meaning must not be placed where a surrounding element gives it another, and jsdom will not tell you — `@operai/ui` `ConfirmDialog` and `FormDialog` render their own `<form>` and `Dialog` does not portal, so mount them as a sibling of the page's form (or in a slot outside any form), never inside it (nested forms: Confirm submits the outer form natively, no POST; defect D3); assert `document.querySelectorAll('form form')` is empty in every dialog state and prove the confirming control in a real-browser journey, keyboard included; the same shape applies to any library component that renders a native element with behaviour (button in link, form in form), also after a library change adds one (see docs/adr/20261118-a-dialog-that-renders-its-own-form-is-mounted-beside-the-form-never-inside-it.md)
- [20261118] A value chosen by the caller must not make a service spend a shared, bounded resource of a third party, and spacing is not a budget — letterhead-api re-reads the registry for a `legalEntityVersion` pin only when the pin is NEWER than the version held (an older or equal pin cannot be cured by a read: 409 `legal_entity_version_mismatch` at once, no call), at most once per second and at most 30 times in any 10 minutes per process (100 under T76, lowered by T77; a pin-forced refresh keeps the held entry as fallback) (`refresh_for_pin`; auth allows 300 per service per 10 minutes shared by all replicas), anything beyond answers the 409 at once; crm-api waits 1 100 ms before its single retry (past the one-second window); the same applies to any request-forced refresh (no-cache header, refresh parameter, retry loop): bound it by spacing AND count below the upstream allowance, per replica; amends 20261117 letterhead-service ADR points 3 and 4 (see docs/adr/20261118-a-pin-ahead-of-the-held-version-forces-one-registry-refresh-at-most-once-a-second-and-100-times-in-10-minutes-per-process-and-any-other-mismatching-pin-is-answered-409-at-once.md)
- [20261118] A record that tells others who did something must not take the "who" from a field its subject can edit, nor look it up after the event, and an exception to "carries no value" is a closed list — a notice of a protected legal-entity change names its author by the account email read from the `user` row inside the version's own transaction (`legal_entity_notice.authorEmail`, Tier 2, every row of the version, never updated, never on `legal_entity_version`, no display name anywhere in a notice; an address failing `noticeAuthorEmail` or `null` reads "no email address on record"); it is the one personal value a notice carries, only in the body, push text, email, stored notification and the column — never in a log, audit entry, key or 400 body (sentinel tests both ways); recipients are still addressed by `recipientId` and history/audit keep the name (OQ-16); amends 20261117 notices (point 3, N1, GDPR) and notify-api (point 7, GDPR); any new surface that names an author, or a second personal value, needs its own decision (see docs/adr/20261118-a-notice-identifies-its-author-by-the-account-email-captured-in-the-versions-transaction-and-that-address-is-the-one-personal-value-a-notice-carries.md)
- [20261120] An activity's details visibility is the author's choice, stored on the record by activities-api — `activity.detailsVisibility` (`everyone` default | `sales_team` | `author`), CRM only (CHECK + registry `restrictsDetails`, Projects 422 `field_not_allowed`), set and changed by the author only; the sales team is a fact crm-api's resolve answers live as `salesTeam` (`dealScope(c).length > 0`, never `hasCapability`), absent = not in the team (fail closed); a caller who may not see the details gets the activity with `body`/`task.description` null, `task.files` empty and `detailsHidden: true`, a file URL is the missing-file 404; the author and a task's assignee always see them, no role overrides it; crm-ui deploys after activities-api (strict create schema); amends ADR 20261110-activities-service-access-delegated-to-host (see docs/adr/20261120-activity-details-visibility-stored-by-activities-api-sales-team-answered-by-the-host.md)
- [20261118] A figure other numbers are computed from must not change, or be believed, without anyone having decided it, and an outside party's failure must not become ours — refund-api's monthly CHF rates (BAZG, `src/fx/`) are fetched ON DEMAND (admin "Fetch now", Settings `fetchDue`, an export that finds a rate missing), never by a scheduler or cron (a tick is only for actions toward a person, 20261118 reminders); only completed months + 5 days (the source also answers for current and future months), `<monat>` echo must match, DOCTYPE/ENTITY refused, constant https host, `redirect: "error"`, 5 s, 512 KiB, 15-min throttle; a fetched (currency, month) is recorded ONCE (partial unique index, never overwritten, a later difference is logged in the attempt log only), an admin correction is an appended row and wins, a failed fetch is a logged attempt and a "missing rate" blocker, never a 5xx or a default of 0/1; any new external reference data follows the same rules *Amended 2026-11-19: the rates now live in accounting-api (`src/rates/`), per entity (WellD Italia: no source, fetch 422 `no_rate_source`); "admin" = `accounting:manage` covering the entity; the triggers are `manager` (Fetch now, the once-per-visit auto-fetch) and `consumer` (refund-api's rates read, 6 s total budget inside its 10 s deadline), derived by the server and never sent by the caller; a consumer copies the rate onto its line, so a correction no longer moves a copied line.* *Amended 2026-11-19, accounting sign-off: a source must not be believed (or labelled as an authority) because it works and matches one known value — verified 2026-11-19 that the AFC/ESTV's own "XML-File" for the monthly VAT average IS the BAZG endpoint already read, so the feed stays, the UI names the AFC/ESTV, the internal id `bazg` names the channel; the proof is repeatable (opt-in `ACCOUNTING_LIVE_RATES=1` live test, once per release, never CI); the 25th-to-24th window vs the 5-day grace rule and the SIX Financial Information licence note remain open owner items.* (see docs/adr/20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-recorded-once-and-corrected-only-by-an-admin-never-by-a-scheduler-and-the-outbound-fetch-is-hardened.md)
- [20261118] An identifier people quote must not be issued twice, consumed by work that did not happen, or changed after it was quoted — receipt numbers (`MC26/014`) come from a `receipt_counter` row per (employee, year of the expense date) locked `FOR UPDATE` inside the approval transaction (ascending year order; a Postgres SEQUENCE is out: gaps on rollback), are stored on the line at numbering time (initials never recomputed), and are immutable in the database (`refund_line_accounting_guard`: no change to the five receipt columns, no DELETE; counter only grows; unique index as backstop); numbering by expense date, then `createdAt`, then id; approvals answer 409 `accounting_release_pending` until `bun run accounting:release` has backfilled legacy WellD CH lines (offsets only where no number exists yet); any new numbered document allocates inside the transaction that uses the number and fences its backfill before live issuing *Amended 2026-11-19: `accounting:release` reads Accounting first and, if it cannot, exits 2 having written nothing (no offset, number, classification or marker); it no longer seeds the catalog (accounting-api `seed:welld-ch` runs first); approval reads Accounting BEFORE its transaction so the counter lock is never held across an HTTP call.* *Amended 2026-11-19, accounting sign-off: a sequence another party already advanced must not restart from zero because its starting input was optional, keyed on someone who does not exist yet, or applied once — the 2026 hand-issued last numbers are a REQUIRED release input (`accounting:release --offsets <csv>`; missing = writes nothing, exit 3; a header-only file says "none"), stored append-only in `receipt_number_baseline` by lower-cased email and applied when an employee's 2026 counter row is CREATED (so it reaches people not yet in Refund; year 2026 only, 2027 starts at 001); a doubtful register entry counts toward the maximum — a gap, never a repeat.* (see docs/adr/20261118-receipt-numbers-come-from-a-row-locked-per-employee-and-year-counter-inside-the-approval-transaction-and-are-immutable-in-the-database.md)
- [20261118] A fact settled at one moment must not stay a live reference, and a permission must be decided on the status that is locked, not the one that was read — accounting classification (ledger account + VAT code per WellD CH line) is resolved live by ONE pure function (`resolveClassification`, shared by view, approve, release backfill and export blockers; an inactive default account = none; VAT has no default) until approval, frozen on the line in the approval transaction (missing = 409 `classification_missing`, nothing changes), changed afterwards only with `request:reclassify` (approved, not paid; conditions `entity` + `self-approval`, seeded like `approve`; scope checked on the line's own entity; the owner is refused 403 `self_approval_forbidden` when either their `reclassify` or `approve` grant is self-restricted), refused when paid by the route, and by the database trigger once numbered (a line with no receipt number, a legacy line of a request paid before this feature, must stay classifiable for the release backfill, so the trigger leaves it alone; after the release every non-rejected line is numbered in the transaction that freezes its classification, so every later paid line is locked; plan IS-1); the PUT locks the request row and picks the permission from the locked status; withdraw clears overrides; account/VAT/CHF travel only on `GET /review/requests/{id}/accounting`, never on `GET /requests/{id}` (key-set test) *Amended 2026-11-19: a line holds COPIES by natural key (`accountNumber`/`accountName`, `vatCode`/`vatRateBasisPoints`), not ids; defaults and designation are append-only copy rows validated live; options and "active" come from Accounting (states active, deactivated, not_found, unverified); an Accounting outage refuses approval, classification and default changes with 503 `accounting_unavailable` and writes nothing; the guard also makes the rate copy write-once (null to set only).* *Amended 2026-11-19, accounting sign-off: a plausible value must not be filled in for a fact that varies per record and nobody decided, and a gate must not demand a value that may be legitimately empty — the VAT code has NO default of any kind (no type default, no foreign-currency designation; table, route and `vatCodeIsDefault` retired) and is optional: a hand copy or none, `vatCode: null` on the PUT clears it, approval/release/export blockers need the ACCOUNT only (`missing` is `["account"]`), `vatAmountCents` is null without a code (IP00 is a decided 0.00), 14 account-only type defaults; multi-rate receipts are split by the employee, one rate per line.* (see docs/adr/20261118-accounting-classification-is-live-until-approval-then-frozen-and-changing-it-afterwards-needs-request-reclassify-and-is-refused-by-the-database-once-paid.md)
- [20261118] A money figure that appears in several places must not be computed in each from rounded, stale or partial inputs, and a missing input must not become a plausible number — the CHF amount and the VAT amount of a refund line are DERIVED ON READ, never stored: `chfCents = round(cents x rateMicros / 1e6)`, `vatCents = round(chfCents x bp / (10000 + bp))` (VAT extracted from the ROUNDED CHF amount; net-from-gross is a different formula and needs its own vectors), BigInt, one half-up rounding per figure, golden vectors in `amounts-vectors.json`; no rate = `null` + `rateMissing` and an export blocker, never 0 or 1; a rate correction changes later exports (logged by hash); any future total is the sum of per-line rounded figures *Amended 2026-11-19: the inputs are the line's COPIED rate and copied VAT rate, not the rate in effect; a rate-pending approved line has no amount (null, never 0 or 1); a correction no longer changes a line that holds its copy.* (see docs/adr/20261118-chf-and-vat-amounts-are-derived-on-read-from-integer-micros-and-basis-points-rounded-once-half-up-and-never-stored.md)
- [20261118] Data that leaves the system must be provable afterwards and must not be read by the receiver as instructions — the WellD CH accounting export (an XLSX journal workbook since 2026-11-19; CSV originally) is generated on request and never stored; every download writes an append-only `refund_batch_export` row (actor, batch, row count, SHA-256, format version) BEFORE the body is returned (log failure = 500, no file; the summary writes none); blockers (missing rate, unclassified or unnumbered line) = 409, never a partial file; deterministic bytes (no timestamp, code-point sort); every text cell starting `= + - @ TAB CR` is prefixed with `'` (a future import must know it); the dialect lives only in `exportFormat.ts` (`FORMAT_VERSION`, provisional until accounting answers); scope must cover `welld_ch`, not only `request:review`; any new outbound report needs the same three answers: who may pull it, what proves what left, can a cell be read as a command *Amended 2026-11-19: the first successful export copies pending rates inside the export transaction (lock, write where null, audit `line_rate_copied`, build, log row, commit, then send; a refused export copies nothing); Accounting unreachable is its own 409 blocker `accountingUnavailable`, not a missing rate and not a 503; a batch whose lines all hold their copies never calls Accounting.* *Amended 2026-11-19, accounting sign-off: the file is an XLSX workbook in the accountant's template (`Date|Description|Debit|Credit|Amount|Currency|Tax|Note`, route `…/accounting-export/file`, `FORMAT_VERSION` 2, not CSV); a guard written for one carrier's syntax must not be carried to another (the CSV leading `'` is gone) and a hash is a fingerprint only if the bytes are deterministic, so `xlsx.ts` is a small in-repo writer (ZIP STORE, fixed entry order and 1980 dates, no docProps, no dependency), and text only ever reaches a cell as an XML-escaped shared string with `quotePrefix`, never a formula, control characters flattened to spaces; Debit is a number only when the account is in canonical decimal form, else text, never re-typed; an importer needing sheets, formulas or a Table object reopens the library choice.* (see docs/adr/20261118-the-accounting-export-is-generated-on-request-never-stored-and-logged-append-only-with-its-content-hash-and-format-version.md)
- [20261119] A decision about facts another party owns must not be made from a copy that drifted, a guess after a failed read, or a pointer that rewrites the past, on the write side as much as the read side — accounting-api owns ledger accounts, VAT codes and monthly rates; a consumer (refund-api first, then any module that books against a list) reads them LIVE as itself (`system:<service>`, scope `accounting.reference.read`, sub allowlist, one identical 401, GET only, never the user's token), keeps NO copy across requests (one snapshot per operation, one 10 s deadline, read outside any DB transaction), writes onto its own record, by natural key (number or code, never the owner's ids), a copy of exactly what it books when it books it (a rate not yet published stays visibly pending and is copied once, write-once at the database), validates every key it stores (the type-default accounts and hand-set line keys) against the live read too, and REFUSES when it cannot read (503 or a named blocker, never stale, never a default; "could not find out" is not "nothing there"); the wire schema is one shared-copy file (`accountingWire`); a cache is allowed only send-stamped, at most 60 s, never served after a failed refresh; editing a number or code, a consumer needing writes or a second consumer reopens it *Amended 2026-11-19, accounting sign-off: write-side live validation now covers account defaults and hand-set line keys only — VAT defaults and the foreign-currency designation are retired, a line's VAT code is optional and chosen by hand; every stored key keeps a live check on write, and a retired storage must leave no route that still accepts the key.* (see docs/adr/20261119-accounting-reference-data-belongs-to-accounting-api-which-consumers-read-live-with-no-copy-kept-across-requests-copy-by-natural-key-onto-what-they-book-and-refuse-to-act-when-they-cannot-read-it.md)
- [20261119] A change to history other copies of the history have already built on must not be made by rewriting it, and a move must not leave two sources that both look current — data that moves between services before its release moves by ONE additive migration in the source (add what stays, carry its own data touching only new columns, `CREATE OR REPLACE` guards BEFORE dropping the columns they name, CHECKs `NOT VALID` then `VALIDATE`, drop what moved; proved by a migration test on fixture data at the previous migration); a migration any database has applied is never edited, released or not, and what moved is re-entered in its new owner by an idempotent operator-run seed; a move with users needs expand, copy, switch, contract instead (see docs/adr/20261119-data-that-moves-from-one-service-to-another-before-the-release-moves-by-an-additive-migration-that-carries-what-the-source-keeps-and-drops-what-moved-and-an-applied-migration-is-never-edited.md)
- [20261119] A working provider must not be judged dead because its consumer gave up first, and the caller must not be able to say what the work was — on-demand outbound work a provider does for a consumer runs on a budget strictly inside the consumer's deadline (rates: 6 s inside refund-api's 10 s, with a cross-package test relating the two constants; every chain of calls: each inner deadline fits the outer minus a margin; a slow third party is answered `missing` with a reason, not an error), and any log or audit field saying why or by whom (the fetch attempt `trigger`, `manager` or `consumer`) is derived by the server from the verified principal, never read from the request body (see docs/adr/20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-the-deadline-of-the-consumer-and-what-triggered-it-is-derived-by-the-provider-never-claimed-by-the-caller.md)
