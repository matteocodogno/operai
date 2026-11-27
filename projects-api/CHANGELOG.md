# @operai/projects-api

## 0.6.0

### Minor Changes

- 3e5d1b5: Teams on a project (step 2): `PUT /projects/{id}/teams` replaces the attached teams (at most 10, `If-Match`, `project:manage` for the entity; 422 `team_not_found` / `team_archived` for an added team, 503 `teams_unavailable`, 429 `rate_limited` with `retryAfterSeconds`), and `GET /attachable-teams[?q=]` searches active teams on the server (50 at most, 120 requests per caller per 10 minutes). Every `Project` now carries `teams` (live names and members, kept nowhere in projects-api), `onProject`, `onProjectComplete`, `teamsStatus` and `teamsRetryAfterSeconds`. The page always loads: when the team read fails or the person's own limit (120 page reads per 10 minutes, 2 400 for the service) refuses it, the teams and their members are marked as not loaded. A team gives presence on the project, never the capability to change it.

### Patch Changes

- 8653331: Inner deadlines now fit inside their callers' (specs/20261126-teams R13). The host routes of projects-api and crm-api (`/activity-host/v1/resolve`, `/meeting-host/v1/resolve`) wait at most 500 ms for a permission check they have not cached, then answer the usual 503 `authz_unavailable`; the check is single flight per person, is not aborted, and fills its 30 s cache for the retry. hours-api waits 6 s, not 2 s, for activities-api's lists and the meetings list, which ask a host themselves; activities-api waits at most 800 ms for the names on a list, and meetings-api's list makes no permission call (it never read the answer) and waits at most 800 ms for its creators' names. A name not known in time reads as unknown and is known on the next load. No wire contract changes.
- 8653331: A U+0000 in any input is a 400, never a 500. Postgres text (and the text inside jsonb) cannot hold it; every backend's global error handler now answers the database's refusal (Postgres 22021 / 22P05, Prisma P2039 / P2010) with a 400 `validation_failed` (hours-api: `invalid_request`) that names no value and none of the database's words, so a route nobody remembered is still not a 500. In auth a guard in front of the whole app refuses a NUL in the path, the query or a JSON body before any route runs (`GET /admin/users?q=%00`, `POST /admin/departments`, roles, invitations, legal entities, …). In projects-api the shared text helpers (`requiredText`, `optionalText`, a new `searchText`) refuse it, which covers `GET /projects?q=`, a project's name, a T&M position's profile, the Bexio order id and `GET /system/purchase-orders?dealIds=`.
- 8653331: The safety net that answers 400 when Postgres refuses a U+0000 now leaves one log line, `[nul] database refused U+0000 or invalid text` and the Prisma and SQLSTATE codes (`P2039/22021`), so a value built by the server with bad bytes is no longer blamed on the client without a trace (security review A09). The line carries only codes taken from the two closed sets the detector already knows: no message, value, argument, request or person. No wire contract changes.
- 8653331: `GET /companies?q=` and `GET /queue?q=` refuse a NUL character with 400 `validation_failed` instead of forwarding it to crm-api and answering 503 `crm_unavailable`.
- 3e5d1b5: The activity-host and meeting-host resolves wait at most 800 ms for a team read (counted once per call), so a slow auth costs one project's assignees instead of the whole batch; a slower read is not aborted and still fills the cache.
- 3e5d1b5: A U+0000 in a text id or in a team's name or description is now a 400 `validation_failed` (no echo in `detail`) instead of a 500 from Postgres: auth's `/admin/teams` routes (name, description, team and user ids) and projects-api's shared `IdSchema` (`GET /projects?teamId=` and `?projectManagerId=`, `PUT /projects/{id}/teams`, every route taking an id). The host-resolve routes now use the same schema.

## 0.5.0

### Minor Changes

- a17c260: A won public tender is taken from the to-start queue as a project without a purchase order: the funding body is its company, its project manager is chosen at the take, and the project shows it comes from a tender.

## 0.4.0

### Minor Changes

- 1071511: A meeting can be started from a project or a project task: Projects is a meeting host (a project's Meetings card, "Start a meeting" on a task, linked to the task's project with its title), and the creator may let the project's team read it.

## 0.3.2

### Patch Changes

- 080a1fb: Migration logs on Railway no longer show as errors: `bun run` no longer echoes the command on stderr (`[run] silent = true`) and `db:deploy` sends Prisma's informational stderr to stdout. A failing migration still exits non-zero and fails the deploy.

## 0.3.1

### Patch Changes

- 8d5ed71: Pins `hono` to 4.13.16 in every backend (it was a `^4.6.16` range that had resolved to 4.12.12 through 4.13.16 depending on the service), closing the hono advisories reported by `bun audit`, among them the CORS wildcard-origin reflection with credentials (GHSA-88fw-hqm2-52qc), the `bodyLimit()` bypass for chunked bodies (GHSA-9vqf-7f2p-gf9v), the CORS preflight ReDoS (GHSA-8j4g-w8fx-2239), the `mount()` prefix bypass (GHSA-4m76-xfj5-7975) and the RegExpRouter wildcard-middleware skip (GHSA-h7mg-cq63-vhpq). `@hono/node-server`, which only reaches the services through `prisma > @prisma/dev` (pinned there to 1.19.11, used by `prisma dev` and never at runtime), is overridden to 2.1.6 in each `package.json`, closing four path-handling advisories (GHSA-92pp-h63x-v22m, GHSA-frvp-7c67-39w9, GHSA-rmxm-3fg6-px4f, GHSA-jpvv-r467-5p4w). No route, status code or response changes.
- ac1b1ae: Moves projects-api to zod 4 (4.6.7) and `@hono/zod-openapi` 1.6.3, and `@scalar/hono-api-reference` to 0.12.17 (its old version pulled a second, vulnerable zod), closing the zod memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5, zod before 4.6.6, no 3.x fix). Every validation 400 keeps its Problem document and field names, but the default messages are zod 4's wording (for example `Invalid input: expected string, received undefined` instead of `Required`). A JSON body sent with another Content-Type, or none, now answers 415 as a Problem document instead of 400. The OpenAPI document is unchanged except that the nullable `stateBeforeHold` enum now lists `null` as OpenAPI 3.0 requires, and the `/docs` page loads Scalar through a different script.
- fcdb417: The validation hook's issue path type accepts any property key (zod 4 may report symbols), so it type-checks under both zod 3 and zod 4. Responses are unchanged.

## 0.3.0

### Minor Changes

- 0d8b9df: Projects hand-off (specs/20261103-projects-handoff, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials to 0094): a won deal reaches OPS "in series".
  Sales (and admins) see a to-start queue of the CRM's won deals that no project has taken, read live
  (a reopened deal leaves it, a re-won one returns), and turn one into a new project with its purchase
  order (PO): type, dates and terms, an optional referent among the company's CRM contacts, and the
  ops-manager the PO is assigned to. The project starts without a project manager; the ops-manager is
  notified and picks one (an admin may in their place), and `planned` to `active` is refused until then.
  A project has 0..1 terms and 0..1 purchase order: a PO is born only from a won deal, and a hand-made
  project may be of any type and carry terms but never a PO. A fixed-price PO from
  a deal with an estimate copies the estimate's man-days once, and they cannot be edited. The PO shows its
  deal, a "no longer won" notice, the estimate link and the referent's name, job title, email and phone,
  read live from the CRM and never stored; the CRM deal page shows its project and the PO's Bexio order id,
  read-only.
  - **auth:** the `projects` catalog gains `purchase-order:bexio` (held by `accounting`: the PO's Bexio
    order id), `purchase-order:receive` and `handoff:take`; new `ops-manager` system role; `sales` gains
    `handoff:take`. New `GET /authz/users/holders`, gated on `handoff:take`, lists the holders of
    `purchase-order:receive` for an entity as `{ id, name, unconditioned }` (ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047 amends ADR 20261006-user-directory-endpoint-capability-gated). New
    service scopes `crm.deals.read`, `crm.contacts.read`, `estimai.estimates.read` and
    `projects.purchase-orders.read`.
  - **estimai-api:** its first `/system/*` route, `GET /system/estimates/{id}/summary`, returns only
    `{ id, name, manDays }` to a service credential with `estimai.estimates.read`; new optional
    `SERVICE_AUDIENCE`.
  - **crm-api:** new `GET /system/deals` (`crm.deals.read`, no amounts) and `GET /system/contacts`
    (`crm.contacts.read`, minimal shape per mode) for projects-api; the deal read gains `delivery` and
    `deliveryKnown`, read from projects-api's `GET /system/purchase-orders`; `SERVICE_CLIENT_ID` /
    `SERVICE_CLIENT_SECRET` are now required with either `NOTIFY_INTERNAL_URL` or the new optional
    `PROJECTS_INTERNAL_URL`.
  - **crm-ui:** a read-only "Delivery" card on the deal page.
  - **notify-api:** `system:projects-api` may raise `projects` notifications.
  - **notify-ui:** the notification centre labels the `projects` origin "Projects" / "Progetti".
  - **projects-api:** one new migration on top of the Projects module's own; the take (`POST /queue/{dealId}/project`) behind
    `handoff:take`, with ops-manager candidates from auth, referent contacts from the CRM and a best-effort
    notification; `GET /queue`, the terms and purchase-order routes, the referent and the project-manager
    pick, hand-made projects with optional terms, and `GET /system/purchase-orders`; `GET /scope` gains
    `take` and `oversees`; new `ESTIMAI_INTERNAL_URL`, `NOTIFY_INTERNAL_URL` and `SERVICE_AUDIENCE`.
  - **projects-ui:** the queue (sales only), "New project" from a deal with the ops-manager and referent
    pickers, the purchase-order and terms cards, the awaiting notice with "Pick project manager", the
    list's "Awaiting project manager" state and filter, and hand-made creation with optional terms.

## 0.2.0

### Minor Changes

- 4f8e70f: Add activities-api (specs/20261110-activities, ADR 20261110-activities-service-access-delegated-to-host/0082/0083): one backend-only service for the activities, tasks and
  task blockers of the CRM and of Projects, with no permission catalog of its own, so every access decision is
  asked of the host (`crm-api`, `projects-api`) as the caller and fails closed. `crm-api` moves its activities,
  participants, blockers and meeting host state out (they are copied in once by
  `activities-api/scripts/import-crm-activities.ts`, a later push drops the old tables) and calls
  `activities-api` with the new service scope `activities.write`; `projects-api` becomes a host. `auth`
  registers the scope and the `activities-api` service client; `notify-api` accepts the `projects` origin and
  binds `system:activities-api` to `crm` and `projects`; `notify-ui` tags it. The shell trusts the
  activities-api origin; `crm-ui` reads activities from it; `projects-ui` gains a Tasks card on a project and a
  My tasks page.
- 4f8e70f: Add the Projects module (specs/20261103-projects, ADR 20261103-projects-tool-shape-and-authorization/0080): the delivery work wellD runs. A
  project has a type (T&M, fixed price, maintenance, SaaS, internal), a state, a project manager and
  a team; its contracts record what each client bought as structured delivery terms (deadline and
  max effort, SLA, hour package, T&M positions, licence period), and `accounting` records the Bexio
  order id on each contract. No money anywhere in the module. New services `projects-api` and
  `projects-ui`; the shell mounts the tool at `/projects`.
  - **auth:** registers the `projects` catalog (`projects:access`, entity-scoped `project:manage`,
    `contract:bexio`) and the `project-manager` role; `sales` gains access and entity-scoped manage,
    `accounting` gains access and the Bexio order capability; `project:manage` holders can read the
    user directory; new service scope `crm.companies.read`.
  - **crm-api:** new `GET /system/companies`, readable only with a service credential carrying
    `crm.companies.read` (the first `/system/*` route on the CRM).
