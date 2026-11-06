---
spec: 022
generated: 2026-11-04
synced: 2026-11-05
---

# Tasks: Projects hand-off — a won deal reaches OPS "in series"

Rigor `mvp`: no plan.md; the contract below binds the dev agents as a plan would. Drift
against it is routed to the product owner. Builds on specs/021's contract
(`../021-projects/tasks.md` § Architecture notes) and changes it where stated here.

**Re-sync 2026-11-05.** The spec was steered (ledger D37–D42) and grilled (D43–D51) after
T1–T16 were built; gate 1 was re-approved on 2026-11-05. T1–T16 stay checked — they were
built and verified against the 2026-11-04 text — and the new tasks T18–T36 rework what the
steering changed. The 2026-11-04 notes that no longer hold are listed at the end of
§ Architecture notes ("Superseded"). User constraint, verbatim: *"visto che sarà una nuova
PR, le migrazioni a db se necessario puoi resettarle tenendo solo le nuove e poi fai cleanup
del mio db locale"*, then *"la nuova PR sarà on top alla 7"* (2026-11-05): the 022 PR is
stacked on the open PR #7 (specs/021 as is), so 021's migration ships first and stays; only
022's own `*_handoff` migration is reset and replaced by one new migration (T23), and the
local databases are reset and reseeded (T36).

## Architecture notes

### Components
- **auth** — the `projects` catalog loses `contract:bexio` and gains `purchase-order:bexio`,
  `purchase-order:receive` (entity) and `handoff:take` (entity); a new `ops-manager` system
  role; a holders listing for the ops-manager picker; service scope `projects.contracts.read`
  renamed `projects.purchase-orders.read`, new `crm.contacts.read`.
- **crm-api** — `GET /system/contacts` for projects-api (the referent); the deal page's
  delivery read moves to `GET /system/purchase-orders` (its own `delivery` shape is unchanged,
  so **crm-ui is not touched**).
- **notify-api / notify-ui** — `system:projects-api` may raise `projects` notifications; the
  centre labels them "Projects".
- **projects-api** — new data model (project, 0..1 terms, 0..1 purchase order), one fresh
  migration, "contract" renamed everywhere; the take gains ops-manager, referent and the
  notification and loses attach; the project-manager pick and the awaiting state; hand-made
  projects with optional terms.
- **projects-ui** — rename; queue only for `handoff:take`; new "New project" form; project
  page with the PO card, the terms card, the awaiting notice and the pick; list awaiting
  state; hand-made create with optional terms.

### Decided here (mvp, no architect — ADR candidates, written in T34)
- **Terms and the PO are two 0..1 records of a project**, not one. `project_terms` (the old
  `contract` table, minus its deal and Bexio columns) holds dates and type-specific terms
  for *any* project that has them; `purchase_order` holds only what a won deal brings: the
  deal, its estimate id, the Bexio order id, the referent and the ops-manager. A project from
  a deal always has both; a hand-made project may have terms and never a PO (D38, D50). This
  keeps specs/021's terms CHECKs, routes and form unchanged in substance and makes "never a
  PO" a matter of no route creating one. Rejected: terms as columns of `project` (moves every
  CHECK and the positions, for no behaviour gained); one `purchase_order` table with nullable
  deal columns for hand-made terms (that is the hand-entered contract D38 removed).
- **Capabilities, not role names, decide** (ADR-0007): reading the queue and taking a deal
  need `handoff:take` (sales, own entity; admin, every entity) besides `project:manage`;
  being a PO's ops-manager needs `purchase-order:receive` (ops-manager, own entity; admin,
  every entity). "An admin" in D44/D47 is a holder whose grant is **unconditioned**; the
  prefill counts only entity-scoped holders (D45).
- **The ops-manager picker reads auth live.** projects-api asks auth for the holders of
  `purchase-order:receive` for the deal's entity with the caller's own JWT, both to fill the
  picker and to validate the choice at creation. Fails closed (503).
- **The referent is an id on the PO, its details read live from crm-api** over the existing
  service credential (new scope `crm.contacts.read`), one call per project read, never
  stored (D49). Subject to T18's security check before T20, T21, T24 and T26 start.
- **The project-manager pick is a `PATCH /projects/{id}`** of `projectManagerId` with a
  stricter rule while the project has none — no second route.
- **021's migration stays, 022's is replaced** (user, 2026-11-05: the 022 PR sits on top of
  PR #7). `prisma/migrations/20261103163000_init` is kept byte-for-byte; `20261104120000_handoff`
  (never shipped) is deleted; one new `prisma/migrations/*_purchase_order` transforms the 021
  schema into the model below. It opens with a guard that **refuses to run if `contract` has
  any row or any `saas` project exists** — data the new model cannot represent
  unambiguously (several contracts per project, a `saas` project without a company, a Bexio
  id on a hand-entered contract) is handled by hand; no data conversion is written.

### Authorization

| Capability | Condition | Held by | Needed for |
|---|---|---|---|
| `projects:access` | — | project-manager, ops-manager, sales, accounting, admin | every route (unchanged) |
| `project:manage` | entity (own) | project-manager, ops-manager, sales; admin unconditioned | create/edit projects, terms, referent, states (unchanged) |
| `handoff:take` | entity (own) | sales; admin unconditioned | `GET /queue` (any entity), take a deal (the deal's entity) |
| `purchase-order:receive` | entity (own) | ops-manager; admin unconditioned | being a PO's ops-manager; unconditioned = the admin override of D47 |
| `purchase-order:bexio` | — | accounting, admin | the Bexio order id (was `contract:bexio`) |

Service scopes (auth `KNOWN_SERVICE_SCOPES`):

| Scope | Accepted by | Client that holds it |
|---|---|---|
| `crm.deals.read` | crm-api `GET /system/deals` | `projects-api` (unchanged) |
| `crm.contacts.read` (new) | crm-api `GET /system/contacts` | `projects-api` |
| `estimai.estimates.read` | estimai-api `GET /system/estimates/{id}/summary` | `projects-api` (unchanged) |
| `projects.purchase-orders.read` (was `projects.contracts.read`) | projects-api `GET /system/purchase-orders` | `crm-api` |
| `notifications.push` | notify-api `POST /system/notifications` | `projects-api` (new holder) |

### Data model (projects-api — new migration `prisma/migrations/*_purchase_order` on top of 021's `20261103163000_init`)
- `project` — as specs/021 except: `projectManagerId text NULL`; CHECK
  `project_company_matches_type` becomes `("companyId" IS NULL) = ("type" = 'internal')`
  (`saas` is a client type, D40). Other CHECKs kept.
- `project_terms` (was `contract`; 0..1 per project) — `id`, `projectId` UNIQUE (FK RESTRICT),
  `type` (= the project's type, kept for the CHECKs), `startDate`, `endDate?`, the fixed-price,
  SLA and hour-package columns and `estimatedManDays` exactly as specs/021, `version`,
  timestamps; every specs/021 contract CHECK kept; new CHECK `terms_not_internal`
  `"type" <> 'internal'`. Dropped: `companyId`, `origin`, `dealId`, `estimateId`,
  `bexioOrderId`, enum `ContractOrigin`.
- `project_terms_position` (was `contract_position`; CASCADE on the terms).
- `purchase_order` (new; 0..1 per project) — `id`, `projectId` UNIQUE (FK RESTRICT), `dealId`
  UNIQUE NOT NULL (AC-1.6, the database half), `estimateId text NULL`, `bexioOrderId
  varchar(64) NULL`, `referentContactId text NULL`, `opsManagerId text NOT NULL`,
  `createdById`, `version`, timestamps.
- Enforced by the API, not the database: a project with a PO has terms; no route creates a
  PO except the take; `projectManagerId` is null only while the project has a PO.

No data change in crm-api, estimai-api or notify-api. auth changes rules and a role through
its seed, not a migration.

### API contracts
Errors are `application/problem+json` with a `code`, as in specs/021. `CompanyRef`,
`Person`, the terms input/output shapes and the validation-path rule (`terms.deadline`)
are specs/021's and 2026-11-04's, renamed from `contract` to `terms`.

**auth (T19, T20)**
- Catalog `projects`: resources `projects` (`access`), `project` (`manage`, entity),
  `purchase-order` (`bexio` no condition; `receive`, entity), `handoff` (`take`, entity). No
  `contract` resource. Resource keys stay unique across catalogs (the directory gate rule).
- Seed (idempotent): `ops-manager` system role ("Ops manager — receives purchase orders and
  picks their project manager") with `projects:access`, `project:manage` own entity,
  `purchase-order:receive` own entity; `sales` + `handoff:take` own entity; `accounting`
  `purchase-order:bexio` instead of `contract:bexio`; `admin` `purchase-order:bexio`,
  `purchase-order:receive`, `handoff:take` unconditioned.
- `GET /authz/users/holders?resource=purchase-order&action=receive&entity=welld_ch` — user
  Bearer JWT; **gate `HOLDERS_GATE_PERMISSIONS = [handoff:take]`** under any entity (not the
  directory gate — T18 M4), resolved live, a soft-deleted caller refused; its **own** rate
  limiter keyed by `sub`, counting 403s too; `Cache-Control: no-store`; strict query
  (`entity` ∈ `welld_ch | welld_it`, unknown parameters → `400`); only the pair
  `purchase-order:receive` is answerable, pinned as a server-side constant (any other, e.g.
  `asset:manage` → `400 unsupported_permission`) → `200 { users: [{ id, name, unconditioned:
  boolean }] }` — **no email, no entity** (T18 M4): the active users whose effective
  permissions grant the pair for that entity **and who hold `projects:access`** (T18 L4),
  name-sorted. Evaluation mirrors projects-api's `scopeFor` fail-closed: an unrecognised
  condition grants nothing; an entity-conditioned grant qualifies only when `user.entity`
  equals the asked entity (null qualifies nobody); `unconditioned` = the grant is
  unrestricted. `400` bad query, `401`, `403` gate, `429`. This amends ADR-0047's "no other
  attribute" rule (`unconditioned`) — recorded in ADR-0063 (T34).

**crm-api (T21)**
- `GET /system/contacts?companyId=<id>` or `?ids=a,b` (exactly one; each id 1–64
  characters; `ids` ≤ **20**) — service JWT, scope `crm.contacts.read`, system auth as `GET
  /system/deals`; **one shape per mode, built with an explicit Prisma `select`** (never
  `notes`, `createdBy`, `updatedBy`, `version`) (T18 M2, L3):
  - `companyId` → `200 { items: [{ id, firstName, lastName, jobTitle: string | null }],
    truncated: boolean }` — that company's non-archived contacts, by last then first name,
    ≤ 500, `truncated` past it (T18 L8). No email, phone, `archived` or `companyId`.
  - `ids` → `200 { items: [{ id, companyId: string | null, firstName, lastName, jobTitle,
    email, phone, archived: boolean }] }` — those contacts whether archived or not; an erased
    contact is absent.
  - `400` for neither or both, a malformed id or > 20 ids. A contract test pins the exact key
    set of each mode.
- `src/lib/projects.ts` calls `GET /system/purchase-orders?dealIds=` and reads
  `purchaseOrderId`; `GET /deals/{id}`'s `delivery` / `deliveryKnown` are unchanged.

**notify-api (T22)** — `SERVICE_ORIGIN_BINDINGS["system:projects-api"] = ["projects"]`.

**projects-api — shapes (T23)**
- `Terms` = specs/021's contract output without `companyId`, `origin`, `dealId`,
  `estimate`, `deal`, `bexioOrderId` — **nested as in 021** (clarified 2026-11-05, drift
  raised by T30): `{ id, type, startDate, endDate, terms: <021 per-type terms view>, version
  }`; the create input (terms routes and the take's `terms` member) is `{ startDate,
  endDate?, terms: <021 per-type terms input> }`; `PATCH` as 021's contract PATCH. Every
  write takes its version through `If-Match` (021 convention), never in the body, and
  returns the written resource.
- `PurchaseOrder = { id, deal: { id, title: string | null, won: boolean | null }, estimate:
  { id } | null, bexioOrderId: string | null, referent: Referent | null, opsManager: Person,
  version }`. `Referent = { id, status: "ok" | "unavailable", name: string | null, jobTitle:
  string | null, email: string | null, phone: string | null }` — values `null` when
  `unavailable`; `referent: null` when none is set **or** the CRM no longer has the contact.
  (T23 returns `referent: null` always; T26 fills it.)
- `Project` gains `projectManager: Person | null`, `awaitingProjectManager: boolean` (has a
  PO and no project manager), `purchaseOrder: PurchaseOrder | null`, `terms: Terms | null`,
  `startDate` / `endDate` from its terms (`null` without); loses `contracts` and the
  earliest/latest contract dates. A `saas` project carries its `company`.
- `ProjectListItem` gains `projectManager: Person | null`, `awaitingProjectManager`; a `saas`
  row carries `company`; loses `clientCount`.

**projects-api — routes**
- T23 (parity rename + the new take shape):
  - `POST /projects/{id}/terms` (create: `409 terms_exist`; `internal` → `409
    terms_not_allowed`), `PATCH /projects/{id}/terms` (partial, `version`, as the old
    contract PATCH; `404 terms_not_found`; estimate-backed `estimatedManDays` stay
    server-owned → `422 estimated_man_days_from_estimate`), `DELETE /projects/{id}/terms` →
    `204` on a hand-made project, `409 terms_required` on one with a PO. Each needs
    `project:manage` for the project's entity; open/closed rules as the old contract routes.
  - `PUT /projects/{id}/purchase-order/bexio-order` — `purchase-order:bexio`, body and rules
    of the old contract Bexio route; `404 purchase_order_not_found` on a hand-made project.
  - `GET /system/purchase-orders?dealIds=a,b` (1–100) — scope
    `projects.purchase-orders.read` → `200 { items: [{ dealId, purchaseOrderId, project: {
    id, name }, bexioOrderId }] }`.
  - `POST /queue/{dealId}/project` `{ name, type: "t_and_m" | "fixed_price" | "maintenance" |
    "saas", terms: TermsInput, opsManagerId: string, referentContactId?: string | null }`
    (strict: `projectManagerId` → `400`) → `201 Project`: state `planned`, deal's company and
    entity, **no project manager**, one PO (`dealId`, `estimateId`, `opsManagerId`,
    `referentContactId`) and its terms, all in one transaction. In T23 `opsManagerId` and
    `referentContactId` are stored as sent (T24 validates them). The 2026-11-04 take errors
    stay (`deal_not_found`, `deal_not_won`, `deal_taken`, `out_of_scope`, EstimAI ones).
  - Removed: `POST /queue/{dealId}/attach`, `PUT /projects/{id}/type`, every
    `/projects/{id}/contracts*` route, `GET /system/contracts`. `PATCH /projects/{id}` with
    `type` → `400` (strict; A30).
- T24 (the take's rules):
  - `GET /queue` needs `handoff:take` under any entity; `POST /queue/{dealId}/project` needs
    `handoff:take` **and** `project:manage` for the deal's entity → else `403 out_of_scope`
    (`403 forbidden` with neither).
  - `GET /queue/{dealId}/ops-managers` → `200 { items: [{ id, name, admin: boolean }],
    prefillId: string | null }` — auth holders of `purchase-order:receive` for the deal's
    entity (`admin` = `unconditioned`), admins last; `prefillId` = the only non-admin when
    there is exactly one. `404 deal_not_found`, `503 crm_unavailable`, `503
    identity_unavailable`. Same gate as the take.
  - The take re-reads that list: `opsManagerId` not in it → `422 ops_manager_invalid`; auth
    down → `503 identity_unavailable`; nothing written.
  - `GET /queue/{dealId}/contacts` → `200 { items: [{ id, name, jobTitle }] }` — the
    **deal's** company's non-archived contacts (crm `companyId` mode; the client never sends a
    company id — T18 M1); same gate as the take (`403 out_of_scope`); the deal read live
    (`404 deal_not_found`, `409 deal_taken`); `503 crm_unavailable`; `Cache-Control:
    no-store`. (Replaces the `GET /companies/{id}/contacts` of the first draft.)
  - The take checks `referentContactId` (charset `^[A-Za-z0-9_-]{1,64}$`) through crm `ids`
    mode: the item whose `id` equals it exactly must exist, have a company, have **the live
    deal's company** (server-derived, never from the body) and not be archived; otherwise
    `422 referent_invalid` with **one identical body** for unknown, other-company and
    no-company (company check first; an archived contact of the right company may say so;
    never echo the id, name or company; no extras) (T18 M3, L1); crm down → `503
    crm_unavailable`.
  - `GET /scope` gains `take: Entity[]` (`handoff:take`) and `oversees: boolean` —
    **`scopeFor(permissions, "purchase-order", "receive", entity).length ===
    ENTITIES.length`**, never `hasCapability` (which ignores conditions and would make every
    ops-manager oversee) (T18 L5).
- T25 (notification): after the take commits, one push to `opsManagerId` through notify-api
  `POST /system/notifications` (`notifications.push`, originApp `projects`): title `Purchase
  order assigned: <project name>`, body `<company name> — pick the project manager of this
  project.`, link `{ href: "/projects/<projectId>" }`, severity `info`, English only (D51).
  Never awaited by the response and never failing it; logs the event kind, project id and an
  HTTP status only; a no-op when `NOTIFY_INTERNAL_URL` is unset and under `NODE_ENV=test`
  unless a test injects a notifier — crm-api's `src/lib/notify.ts` is the pattern.
- T26 (the referent on the PO):
  - `GET /projects/{id}` resolves `purchaseOrder.referent` with one crm `ids` call per
    request, **only when a referent is set**, in parallel with the deal and company reads
    (timeout as the other crm calls) (T18 L7): the item whose `id` equals the stored id
    exactly, **and whose `companyId` equals the project's `companyId`**, → `status: "ok"` with
    its fields picked by name (never spread) (T18 M3, L3); absent, moved to another company or
    unlinked → `referent: null` with none of its data; archived → still shown (S6); crm down →
    `status: "unavailable"`, the project still `200`.
  - `GET /projects/{id}/purchase-order/contacts` → `200 { items: [{ id, name, jobTitle }] }`
    — the **project's** company's non-archived contacts (T18 M1); `project:manage` for the
    project's entity (`403 out_of_scope`); `404 purchase_order_not_found` on a hand-made
    project; `503 crm_unavailable`.
  - `PATCH /projects/{id}/purchase-order` `{ referentContactId: string | null }` with
    `If-Match` →
    `200 PurchaseOrder` — `project:manage` for the entity (`403 out_of_scope`); checks as in
    T24 against **`project.companyId`** (`422 referent_invalid`, `503 crm_unavailable`); `409
    version_conflict`; `404 purchase_order_not_found` on a hand-made project.
  - **No cache of contacts** anywhere in projects-api (not the 60 s identities cache), and
    `Cache-Control: no-store` on `GET /projects/{id}`, the PATCH echo and both contacts routes
    (T18 M5).
- T27 (the pick and the awaiting state):
  - `PATCH /projects/{id}` `projectManagerId`: when the project has none, only a caller whose
    `oversees` is true, or the PO's `opsManagerId` **read from the row** who **still holds
    `purchase-order:receive` for the project's entity**, may set it (`403 not_ops_manager`);
    check and write under the `version` compare-and-set (T18 L5);
    when it has one, specs/021's rule; `null` → `422 project_manager_required`; the person
    must hold project access (`422 not_project_user`).
  - `POST /projects/{id}/transitions` to `active` while awaiting → `409
    awaiting_project_manager`.
  - `GET /projects?projectManagerId=none` → only the awaiting projects.
- T28 (hand-made): `POST /projects` `{ name, type (any of the five), entity, companyId?,
  projectManagerId?, terms?: TermsInput }` — company required for every type but `internal`
  (`saas` included) and absent for `internal` (`422 company_required` / `company_not_allowed`);
  `terms` on `internal` → `422 terms_not_allowed`; invalid terms → `400 validation_failed` for a shape error and `422` for a domain rule, both naming `terms.<field>` as the take does (clarified 2026-11-05, drift raised by T28);
  project and terms in one transaction; the creator is project manager by default; no PO.

**projects-ui (T30–T33)** — renders the shapes above; copy EN / IT: "Purchase order" /
"Ordine d'acquisto", "Terms" / "Termini", "Referent" / "Referente", "Ops manager" /
"Responsabile OPS", "Awaiting project manager" / "In attesa del project manager".
- "To start" nav and `/queue` only when `scope.take` is non-empty; otherwise `/queue` shows
  the permission-denied state.
- Project page: a project with a PO shows a **Purchase order** card (deal link
  `/crm/deals/<id>`, the "no longer won" notice, estimate link `/estimai/estimates/<id>`,
  Bexio order id, referent with its ok / unavailable / none states and an edit control for
  manage, ops-manager, and its terms); a hand-made project shows a **Terms** card (add, edit,
  remove for manage) and nothing of a PO.
- Awaiting: list cell "Awaiting project manager", filter option "None yet"; page notice
  naming the ops-manager; "Pick project manager" for the PO's ops-manager
  (`currentUserId === opsManager.id`) or `scope.oversees`; "Activate" disabled with the
  reason while awaiting.

### Environment notes (for every agent)
- Run service commands as `cd <service> && direnv exec . <command>` (the shell loads no
  direnv); tools through `mise exec --`.
- **crm-api tests only against `crm_test`**: `cd crm-api && direnv exec . env
  DATABASE_URL=postgresql://postgres:postgres@localhost:5435/crm_test bun test` — its
  test world truncates every CRM table and `.envrc` points at the dev `crm`.
- Never read or print `.env*`; env files are applied by the developer (T35).

### Security rules (T18, `security-review.md` — binding on T20–T35)
- Referent data (name, job title, email, phone) never reaches `GET /system/purchase-orders`,
  the notification body, logs, error bodies or OpenAPI examples; fixtures, examples and
  seeds use synthetic contacts (L2).
- projects-api logs one structured line per take, referent set / clear and project-manager
  pick: event kind, project id, actor id — no contact data (L6).
- projects-ui keeps referent and contact lists in memory only (no storage, re-fetched on
  open); renders their fields as text; builds `mailto:` / `tel:` with a fixed scheme, never
  `href={value}` (M5, L9); labels an `admin: true` picker item "All entities" / "Tutte le
  entità" (L5).
- `crm.contacts.read` is granted to the `projects-api` service client only (M2).

### Deferred (knowingly not done at this tier)
- Reassigning a PO, a "my POs" view (non-goals); clearing a referent id the CRM erased (it
  shows as none, the id stays).
- An Italian notification (D51); queue pagination (cap 500, as before).
- Production provisioning of keys, scopes and the `ops-manager` role assignment (owner,
  after merge, `provision-tool` skill), and a shell e2e journey — as specs/021.

### Superseded (2026-11-04 notes that no longer hold)
- The `Contract` model, its `origin` / `dealId` / `estimateId` / `bexioOrderId` columns and
  the two `*_handoff` CHECKs (now `project_terms` + `purchase_order`).
- `POST /queue/{dealId}/attach`, `PUT /projects/{id}/type`, `/projects/{id}/contracts*`,
  `GET /system/contracts`, scope `projects.contracts.read`, capability `contract:bexio`.
- "PM = the caller unless given" on a take (now no PM until the pick); "types offered from a
  deal are the client types without `saas`" (now with `saas`); "the queue is readable by
  every access holder" (now `handoff:take`).

## Tasks

> T1–T16 were built against the 2026-11-04 text and stay checked. Where the steering changed
> them, the rework is a new task: T7's attach and T13's `AttachDealDialog` are removed (T23,
> T30); T8 / T14's contract becomes the PO and terms (T23, T30, T32); T4's `/system/contracts`
> and T1's `projects.contracts.read` are renamed (T23, T19); T12's queue becomes sales-only
> (T24, T30).

- [x] T1: auth — `crm.deals.read`, `estimai.estimates.read`, `projects.contracts.read` service scopes — refs: AC-1.1, AC-3.1, AC-3.4 — deps: none
  - touch: `auth/src/system/serviceClients.ts`, `auth/src/system/serviceClients.test.ts`
  - done when: `cd auth && bun test src/system` is green with a test that a `SERVICE_CLIENTS` entry carrying each new scope is accepted and an unknown scope still refuses to start.
- [x] T2: estimai-api — `GET /system/estimates/{id}/summary` behind `estimai.estimates.read`; man-days formula copied from crm-api under a `manDays` shared-copy group — refs: AC-3.1 — deps: none
  - touch: `estimai-api/src/system/**`, `estimai-api/src/index.ts`, `estimai-api/src/lib/env.ts`, `estimai-api/src/openapi/registry.ts`, `crm-api/src/offers/scope.ts`, `scripts/check-shared-copies.ts`
  - done when: `cd estimai-api && bun run typecheck && bun test` is green with tests that a scoped service JWT gets `200 { id, name, manDays }` for an estimate it neither owns nor collaborates on; a user JWT, another scope and no token get the identical `401`; an unknown id is `404`; `manDays` equals crm-api's `totalManDays(estimate, false)` to one decimal on the shared vectors of `crm-api/src/offers/scope.test.ts`; `bun scripts/check-shared-copies.ts` exits 0 with the `manDays` group; crm-api `bun test src/offers` still green.
- [x] T3: crm-api — `GET /system/deals` behind `crm.deals.read` — refs: AC-1.1, AC-2.1, AC-2.2, AC-2.3 — deps: none
  - touch: `crm-api/src/system/**`, `crm-api/src/index.ts`, `crm-api/src/openapi/registry.ts`
  - done when: `cd crm-api && bun test src/system` is green: `stage=won` lists only won deals by `wonAt` descending with `truncated` past 500; `ids` returns deals in any stage with `wonAt: null` when not won; a reopened deal drops out of `stage=won`; no item carries an amount, currency, owner or notes; neither or both parameters → `400`; a user JWT, another scope and no token → the identical `401`. Full `bun test` still green.
- [x] T4: projects-api — system auth (copy), `SERVICE_AUDIENCE`, `GET /system/contracts`, and stub `queue` / `take` routers mounted — refs: AC-3.4 — deps: none
  - touch: `projects-api/src/system/**`, `projects-api/src/index.ts`, `projects-api/src/lib/env.ts`, `projects-api/src/openapi/**`, `projects-api/src/queue/queue.routes.ts`, `projects-api/src/queue/take.routes.ts`
  - done when: `cd projects-api && bun run typecheck && bun test src/system` is green: a scoped service JWT gets the contracts of the asked deals with project name and Bexio order id, deals without a contract absent; > 100 ids → `400`; a user JWT, another scope, no token and an unset `SERVICE_AUDIENCE` → the identical `401`; `src/index.ts` mounts `systemRouter`, `queueRouter` and `takeRouter` (stubs) so T6 and T7 never edit it.
- [x] T5: projects-api — migration (`Contract.estimateId`, two CHECKs), crm-api deals client, estimai-api summary client, test fakes — refs: AC-1.6, AC-3.1, AC-3.2 — deps: T4
  - touch: `projects-api/prisma/**`, `projects-api/src/db.constraints.test.ts`, `projects-api/src/lib/crm.ts`, `projects-api/src/lib/estimai.ts`, `projects-api/src/lib/estimai.test.ts`, `projects-api/src/lib/crm.deals.test.ts`, `projects-api/src/lib/env.ts`, `projects-api/src/test-support/**`
  - done when: `bun run db:deploy` succeeds on `projects` and `projects_test`; `bun test src/db.constraints.test.ts src/lib` is green proving at the database that a `deal` contract without `dealId`, a `manual` contract with one, and an `estimateId` on a `manual` contract are refused; `lib/crm.ts` exposes `wonDeals()` and `dealsById(ids)` (crm-api down → `CrmUnavailableError`); `lib/estimai.ts` exposes `estimateManDays(id)` → number, `null` on `404`, `503 estimai_unavailable` when down, `503 estimai_unconfigured` when `ESTIMAI_INTERNAL_URL` is unset; `test-support` has fakes for both that T6–T8 use.
- [x] T6: projects-api — `GET /queue` — refs: AC-1.1, AC-1.6, AC-2.1, AC-2.2 — deps: T4, T5
  - touch: `projects-api/src/queue/queue.routes.ts`, `projects-api/src/queue/queue.test.ts`
  - done when: `bun test src/queue/queue.test.ts` is green: a won deal without a contract is listed with title, company, entity, `wonAt` and estimate (or `null`), and no amount field exists in the response; a deal with a contract is absent; a deal reopened in the fake CRM is absent and back once won again; `q` matches title or company name; `entity` filters; `truncated` passes through; crm-api down → `503 crm_unavailable`; no `projects:access` → `403`.
- [x] T7: projects-api — take a deal: `POST /queue/{dealId}/project` and `/attach`; project and contract creation extracted for reuse — refs: AC-1.2, AC-1.3, AC-1.6, AC-3.1, AC-3.2 — deps: T4, T5
  - touch: `projects-api/src/queue/take.routes.ts`, `projects-api/src/queue/take.test.ts`, `projects-api/src/projects/create.ts`, `projects-api/src/contracts/create.ts`, `projects-api/src/projects/projects.routes.ts`, `projects-api/src/contracts/contracts.routes.ts`
  - done when: `bun test src/queue/take.test.ts src/projects src/contracts` is green: "new project" creates a `planned` project with the deal's company and entity, the given name, the caller (or the given module user) as PM, and one `deal` contract with `dealId`, company, type and `estimateId`, in one transaction; only client types are accepted; attach adds a contract of the project's type; each refusal of the contract (`contracts_not_allowed`, `project_not_open` for `closed` and `cancelled`, `company_mismatch`, `out_of_scope` for the other entity, `deal_not_won`, `deal_taken` including two concurrent takes of one deal, `deal_not_found`) leaves no project and no contract behind; a `fixed_price` contract from a deal with an estimate gets the fake EstimAI's man-days and sending `estimatedManDays` → `422`; EstimAI `404` → `null`; EstimAI down → `503` and nothing written; specs/021's `POST /projects` and `POST /projects/{id}/contracts` tests still pass unchanged.
- [x] T8: projects-api — contracts and projects show their deal; man-days locked; no detach — refs: AC-2.3, AC-2.4, AC-3.1, AC-3.2, AC-3.3 — deps: T7
  - touch: `projects-api/src/contracts/contracts.routes.ts`, `projects-api/src/contracts/contracts.schemas.ts`, `projects-api/src/contracts/contracts.test.ts`, `projects-api/src/projects/projects.routes.ts`, `projects-api/src/projects/projects.schemas.ts`, `projects-api/src/projects/projects.test.ts`
  - done when: `bun test src/contracts src/projects` is green: `GET /projects/{id}` and `GET …/contracts/{id}` return `deal: { id, title, won }` read live (one `dealsById` call per request), `won: false` after the fake CRM reopens the deal and `true` again once re-won, `title` / `won` `null` with crm-api down while the project still returns `200`; hand-entered contracts have `deal: null`; `Contract.estimate` is `{ id }` or `null`; `PATCH` with `terms.estimatedManDays` on an estimate-backed contract → `422 estimated_man_days_from_estimate`, on a hand-entered one still allowed; `PATCH` with `dealId`, `projectId` or `origin` → `400`; `DELETE` still `405`.
- [x] T9: projects-api — authorization matrix covers the new routes — refs: AC-1.1, AC-1.2 — deps: T4, T6, T7, T8
  - touch: `projects-api/src/matrix.test.ts`
  - done when: `bun test src/matrix.test.ts` is green for `GET /queue`, both takes and `GET /system/contracts` × {no access, access only, `project-manager` (welld_ch), `sales` (welld_it), `accounting`, admin} — takes allowed only for manage of the deal's entity, the system route refusing every user JWT — and the full `bun test` and `bun run typecheck` are green.
- [x] T10: crm-api — the deal page reads its project and Bexio order id from projects-api — refs: AC-3.4 — deps: none
  - touch: `crm-api/src/lib/projects.ts`, `crm-api/src/lib/projects.test.ts`, `crm-api/src/lib/env.ts`, `crm-api/src/deals/deals.routes.ts`, `crm-api/src/deals/delivery.test.ts`
  - done when: `cd crm-api && bun run typecheck && bun test` is green with tests that `GET /deals/{id}` returns `delivery: { project: { id, name }, bexioOrderId }` for a deal the fake projects-api knows, `delivery: null` with `deliveryKnown: true` for one it does not, and `delivery: null` with `deliveryKnown: false` — and still `200` — when projects-api is down or `PROJECTS_INTERNAL_URL` is unset; the call uses a service token from crm-api's existing `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` without editing the shared `serviceToken.ts` region.
- [x] T11: crm-ui — read-only "Delivery" card on the deal page (en + it) — refs: AC-3.4 — deps: T10
  - touch: `crm-ui/src/components/DeliveryCard.tsx`, `crm-ui/src/components/DeliveryCard.test.tsx`, `crm-ui/src/pages/DealDetailPage.tsx`, `crm-ui/src/pages/DealDetailPage.test.tsx`, `crm-ui/src/lib/types.ts`, `crm-ui/src/strings/deals.ts`
  - done when: `cd crm-ui && pnpm lint && pnpm build && pnpm test` is green with tests that the card shows the project name and the Bexio order id ("—" when empty) with no edit control, is absent when `delivery` is `null` and known, and says the delivery side is unavailable when `deliveryKnown` is `false`.
- [x] T12: projects-ui — queue page `/queue`, nav entry, API client and types for every 022 route (en + it) — refs: AC-1.1, AC-1.6, AC-2.1 — deps: none
  - touch: `projects-ui/src/router.tsx`, `projects-ui/src/pages/QueuePage.tsx`, `projects-ui/src/pages/QueuePage.test.tsx`, `projects-ui/src/components/ProjectsShell.tsx`, `projects-ui/src/components/ProjectsShell.test.tsx`, `projects-ui/src/lib/projectsApi.ts`, `projects-ui/src/lib/types.ts`, `projects-ui/src/lib/errors.ts`, `projects-ui/src/strings.ts`, `projects-ui/src/strings/queue.ts`, `projects-ui/src/strings/nav.ts`
  - done when: `cd projects-ui && pnpm lint && pnpm build && pnpm test` is green with tests that `/queue` lists title, company, entity, won date and an estimate link (`/estimai/estimates/<id>`) when there is one, renders no amount, filters by search and entity, shows "showing the newest 500" when `truncated`, shows the crm-unavailable state on `503`, and that the shell's nav offers "To start" to every reader; `projectsApi.ts` and `types.ts` carry the queue, take, attach and the new contract fields so T13 and T14 do not edit them.
- [x] T13: projects-ui — "New project" and "Attach to project" from a queued deal — refs: AC-1.2, AC-1.3, AC-3.1 — deps: T12
  - touch: `projects-ui/src/components/TakeDealDialog.tsx`, `projects-ui/src/components/TakeDealDialog.test.tsx`, `projects-ui/src/components/AttachDealDialog.tsx`, `projects-ui/src/components/AttachDealDialog.test.tsx`, `projects-ui/src/components/ContractTermsFields.tsx`, `projects-ui/src/components/ContractFormDialog.tsx`, `projects-ui/src/pages/QueuePage.tsx`, `projects-ui/src/strings/queue.ts`
  - done when: `pnpm lint && pnpm build && pnpm test` is green with tests that both actions show only with manage scope for the deal's entity; "New project" prefills the name from the deal title (editable), offers only T&M / Fixed price / Maintenance, defaults the PM to the user and lets it change, and asks the contract's dates and terms with the specs/021 per-type fields (now `ContractTermsFields`, shared with `ContractFormDialog`); a fixed-price form from a deal with an estimate shows "estimated man-days: from the estimate" instead of an input; each refusal (`contracts_not_allowed`, `project_not_open`, `company_mismatch`, `deal_taken`, `deal_not_won`) shows its own message; on success the deal leaves the list and the user lands on the project.
- [x] T14: projects-ui — contract card and project page show the deal, "no longer won" notice, estimate link; man-days read-only — refs: AC-2.3, AC-2.4, AC-3.1, AC-3.2, AC-3.3 — deps: T12, T13
  - touch: `projects-ui/src/components/ContractCard.tsx`, `projects-ui/src/components/ContractCard.test.tsx`, `projects-ui/src/components/ContractFormDialog.tsx`, `projects-ui/src/components/ContractFormDialog.test.tsx`, `projects-ui/src/pages/ProjectDetailPage.tsx`, `projects-ui/src/pages/ProjectDetailPage.test.tsx`, `projects-ui/src/strings/contracts.ts`, `projects-ui/src/strings/project.ts`
  - done when: `pnpm lint && pnpm build && pnpm test` is green with tests that a deal contract shows the deal title linking to `/crm/deals/<id>` and the origin "from deal" ("entered by hand" otherwise), the estimate link `/estimai/estimates/<id>` when `estimate` is set, the notice "the deal is no longer won" on the card and on the project page when `deal.won` is `false` and neither when it is `true` or `null`; editing an estimate-backed fixed-price contract shows the man-days read-only; no control detaches or moves a contract.
- [x] T15: docs — ADR-0060 (hand-off reads between crm-api and projects-api over service credentials, live, no events), ADR-0061 (estimai-api estimate man-days for a service credential; the `manDays` copy), AGENTS.md, READMEs, glossary, changesets — refs: AC-1.1, AC-3.1, AC-3.4 — deps: T2, T3, T4, T10
  - touch: `docs/adr/0060-*.md`, `docs/adr/0061-*.md`, `AGENTS.md`, `estimai-api/README.md`, `crm-api/README.md`, `projects-api/README.md`, `.claude/context/glossary.md`, `.changeset/*.md`
  - done when: both ADRs exist with Context / Decision / Alternatives / Consequences, AGENTS.md's ADR index lists them, the glossary defines **to-start queue** and a contract's **deal**, and `pnpm changeset status` shows bumps for auth, estimai-api, crm-api, crm-ui, projects-api and projects-ui.
- [x] T16: local env — new keys and service-client scopes in the env examples and env-doctor — drafted by the agent, applied by the developer (the guard stops agents writing env files) — refs: AC-1.1, AC-3.1, AC-3.4 — deps: T1, T2, T3, T4, T5, T10
  - touch: `auth/.env.example`, `estimai-api/.env*`, `crm-api/.env*`, `projects-api/.env*`, `tools/env-doctor/manifest.ts`, `tools/env-doctor/*.test.ts`
  - done when: `bun test tools/env-doctor` is green with `SERVICE_AUDIENCE` for estimai-api and projects-api, `ESTIMAI_INTERNAL_URL` for projects-api and `PROJECTS_INTERNAL_URL` for crm-api in the manifest; the `SERVICE_CLIENTS` example gives `projects-api` `crm.companies.read crm.deals.read estimai.estimates.read` and `crm-api` `projects.contracts.read` besides its notify scopes; with them applied, `mise run dev` shows a seeded won deal in `/projects/queue`.
- [x] T18: security — design check of the referent read and the ops-manager holders listing, before they are built (D49) — refs: AC-3.6, AC-3.8, AC-3.9, AC-3.10, AC-4.1 — deps: none
  - touch: `specs/022-projects-handoff/security-review.md`
  - done when: `wellforge:owasp-reviewer` has reviewed § API contracts "auth (T19, T20)", "crm-api (T21)" and the referent parts of T23–T26 against what crosses from the CRM and auth into the project module and to whom; the main loop has written its verdict and findings to `security-review.md` (the reviewer has no write tool); every finding ≥ medium is folded into these notes — through the product owner if it changes an AC — before T20, T21, T24 or T26 starts.
- [x] T19: auth — `projects` catalog (`purchase-order:bexio|receive`, `handoff:take`, no `contract`), `ops-manager` role and grants, service scopes `projects.purchase-orders.read` and `crm.contacts.read` — refs: AC-1.1, AC-1.9, AC-3.4, AC-4.1, AC-4.8 — deps: none
  - touch: `auth/src/authz/catalogs/projects.ts`, `auth/src/authz/seed.ts`, `auth/src/system/serviceClients.ts`, `auth/src/**/*.test.ts`
  - done when: `cd auth && direnv exec . bun run typecheck && direnv exec . bun test` is green with tests that the catalog declares exactly the five capabilities of § Authorization with their conditions and no `contract` resource; the seed, run twice, leaves one `ops-manager` system role with `projects:access`, own-entity `project:manage` and `purchase-order:receive`, gives `sales` own-entity `handoff:take`, `accounting` `purchase-order:bexio`, and `admin` `purchase-order:bexio`, `purchase-order:receive` and `handoff:take` unconditioned; a `SERVICE_CLIENTS` entry with `projects.purchase-orders.read` or `crm.contacts.read` is accepted and one with `projects.contracts.read` refuses to start.
- [x] T20: auth — `GET /authz/users/holders` for `purchase-order:receive` — refs: AC-4.1, AC-4.2 — deps: T18, T19
  - touch: `auth/src/authz/holders.routes.ts`, `auth/src/authz/holders.routes.test.ts`, `auth/src/auth/holders.routes.test.ts`, `auth/src/authz/resolver.ts`, `auth/src/authz/directory.routes.ts`, `auth/src/index.ts` (amended 2026-11-05: HTTP tests that mint a real token live in `src/auth/`, the existing precedent — drift raised by T20)
  - done when: `cd auth && direnv exec . bun test src/authz src/auth/holders.routes.test.ts` is green with tests that the route lists, name-sorted, as `{ id, name, unconditioned }` only, the active `ops-manager` holders of the asked entity holding `projects:access` with `unconditioned: false` and the admins with `true`, and no ops-manager of the other entity, no soft-deleted user, no user without `projects:access`; any pair other than `purchase-order:receive` (e.g. `asset:manage`) → `400 unsupported_permission`; an unknown query parameter or entity → `400`; a caller without `handoff:take` (an asset or deal manager included) → `403`; no token → `401`; its own limiter answers `429`; the response carries `Cache-Control: no-store`. The stale "nor contract:bexio" comment in `directory.routes.ts` is corrected.
- [x] T21: crm-api — `GET /system/contacts` behind `crm.contacts.read`; the deal page reads `GET /system/purchase-orders` — refs: AC-3.4, AC-3.6, AC-3.8, AC-3.9 — deps: T18
  - touch: `crm-api/src/system/**`, `crm-api/src/index.ts`, `crm-api/src/openapi/registry.ts`, `crm-api/src/lib/projects.ts`, `crm-api/src/lib/projects.test.ts`, `crm-api/src/deals/delivery.test.ts`, `crm-api/src/matrix.test.ts`, `crm-api/src/lib/env.ts` and `crm-api/src/deals/deals.routes.ts` (comments only) (amended 2026-11-05: the matrix's service-route exemption and stale `contract` comments — drift raised by T21)
  - done when: on `crm_test` (§ Environment notes) `bun run typecheck` and the full `bun test` are green with tests that `companyId` mode returns that company's non-archived contacts only, sorted, with exactly its key set and `truncated`; `ids` mode returns exactly its key set, archived ones flagged, and omits erased ones; neither or both parameters, a malformed id → `400`; > 20 ids → `400`; a user JWT, another scope and no token → the identical `401`; `GET /deals/{id}` still returns `delivery` / `deliveryKnown` as before, now from a fake `GET /system/purchase-orders`.
- [x] T22: notify-api + notify-ui — `system:projects-api` may raise `projects` notifications; the centre labels them "Projects" / "Progetti" — refs: AC-4.3 — deps: none
  - touch: `notify-api/src/system/systemAuth.middleware.ts`, `notify-api/src/system/systemAuth.middleware.test.ts`, `notify-api/src/notifications/notifications.schemas.ts`, `notify-api/src/system/notifications.routes.test.ts`, `notify-ui/src/strings.ts`, `notify-ui/src/lib/severity.ts`, `notify-ui/src/**/*.test.ts*` (amended 2026-11-05: `ORIGIN_APPS` validates the body before the binding — drift raised by T22)
  - done when: `cd notify-api && direnv exec . bun test src/system` is green with a test that a `system:projects-api` token may post with `originApp: "projects"` and not with another origin app — **at the route** (`POST /system/notifications` answers `201` for a `projects` body from that client), not only in the middleware; `cd notify-ui && mise exec -- pnpm lint && mise exec -- pnpm test` is green with a test that a `projects` notification shows "Projects" (en) and "Progetti" (it).
- [x] T23: projects-api — new data model in one fresh migration; "contract" → terms + purchase order at parity; attach, type change and contract routes removed; the new take body — refs: AC-1.2, AC-1.3, AC-1.6, AC-1.8, AC-1.10, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-3.5, AC-5.2, AC-5.4 — deps: none
  - touch: `projects-api/prisma/**`, `projects-api/src/**`
  - done when: `prisma/migrations` holds exactly `20261103163000_init` (unchanged from PR #7) and one new `*_purchase_order` directory besides `migration_lock.toml`; `bun run db:deploy` applies both on a freshly created empty `projects_test`; the new migration's guard refuses (clear message) when a `contract` row or a `saas` project exists before it; `cd projects-api && direnv exec . bun run typecheck && direnv exec . bun test` is green with tests that: the database refuses a second terms row or a second PO for one project, a PO without `dealId` or `opsManagerId`, terms on an `internal` project, a `saas` project without a company, and keeps every specs/021 terms CHECK; the take makes a `planned` project with no project manager, its terms and its PO in one transaction and accepts `saas`; `projectManagerId` in the take body → `400`; the terms routes create, edit and (hand-made only) delete with the errors of § API contracts; estimate-backed man-days stay server-owned; the Bexio route works on the PO and `404`s on a hand-made project; `GET /system/purchase-orders` answers as specified; the removed routes answer `404`; `PATCH /projects/{id}` with `type` → `400`; the deal notice (`won`) and estimate link appear on `purchaseOrder`; no `contract` identifier is left in `src/` (`grep -ri contract src` finds only comments citing specs/021).
- [x] T24: projects-api — the take's rules: `handoff:take` gate, ops-manager candidates and check, referent check, contacts for the form, `/scope` `take` and `oversees` — refs: AC-1.1, AC-1.2, AC-1.9, AC-1.11, AC-3.6, AC-4.1, AC-4.2, AC-4.8 — deps: T18, T23
  - touch: `projects-api/src/queue/**`, `projects-api/src/scope/**`, `projects-api/src/auth/guards.ts`, `projects-api/src/lib/crm.ts`, `projects-api/src/lib/holders.ts`, `projects-api/src/lib/holders.test.ts`, `projects-api/src/lib/crm.contacts.test.ts`, `projects-api/src/test-support/**`, `projects-api/src/openapi/registry.ts`, `projects-api/src/matrix.test.ts` (amended 2026-11-05: the matrix breaks on the new gate — minimal rows now, full matrix in T29; drift raised by T24. `403 forbidden` = no `handoff:take` for any entity, `403 out_of_scope` = take or manage misses the deal's entity)
  - done when: `bun test src/queue src/companies src/scope src/lib` is green with tests that a `project-manager`, an `ops-manager` and `accounting` get `403` on `GET /queue`, the take and `ops-managers`, a `sales` of one entity reads the whole queue but takes only its own entity's deals (`403 out_of_scope`); `ops-managers` returns role holders and admins with `prefillId` set only for exactly one role holder (none, one, two, admins-only cases); a take with an `opsManagerId` outside the list → `422 ops_manager_invalid` and with auth down → `503 identity_unavailable`, nothing written; `referentContactId` of another company, companyless or unknown → the identical `422 referent_invalid` body (and archived → `422`), crm down → `503`; `GET /queue/{dealId}/contacts` lists the deal company's non-archived contacts only, refuses a taken deal and sends `Cache-Control: no-store`; `/scope` reports `take`, and `oversees` is `true` for an unconditioned grant and `false` for an ops-manager.
- [x] T25: projects-api — notify the PO's ops-manager after a take — refs: AC-4.3, AC-4.4 — deps: T22, T24
  - touch: `projects-api/src/lib/notify.ts`, `projects-api/src/lib/notify.test.ts`, `projects-api/src/lib/env.ts`, `projects-api/src/queue/take.routes.ts`, `projects-api/src/queue/take.test.ts`
  - done when: `bun test src/lib/notify.test.ts src/queue` is green with tests that one successful take sends exactly one push to `opsManagerId` with originApp `projects`, the English title and body of § API contracts and the link `/projects/<id>`, and nobody else is notified; a notify-api failure, timeout or unset `NOTIFY_INTERNAL_URL` still answers `201` with the project awaiting a project manager; the log carries no token, title or name; a failed take sends nothing.
- [x] T26: projects-api — the referent on the PO: live read on the project page, edit through `PATCH /projects/{id}/purchase-order` — refs: AC-3.6, AC-3.7, AC-3.8, AC-3.9, AC-3.10 — deps: T18, T25
  - touch: `projects-api/src/purchase-orders/**`, `projects-api/src/projects/projects.routes.ts`, `projects-api/src/projects/projects.schemas.ts`, `projects-api/src/projects/projects.test.ts`, `projects-api/src/lib/crm.ts`, `projects-api/src/test-support/**`, `projects-api/src/openapi/registry.ts`, `projects-api/src/queue/take.test.ts`, `projects-api/src/matrix.test.ts` (amended 2026-11-05: two take assertions encoded T23's `referent: null` stub; minimal matrix rows — drift raised by T26. Every answer carrying a `Project` or `PurchaseOrder` is `no-store` and shows the live referent)
  - done when: `bun test src/projects src/purchase-orders` is green with tests that `GET /projects/{id}` shows the referent's name, job title, email and phone from the fake CRM with one contacts call, a changed contact shows changed at the next read, an erased one and one moved to another company give `referent: null`, an archived one is still shown, crm down gives `status: "unavailable"` and still `200`, no crm contacts call is made without a referent, and the response carries `Cache-Control: no-store`; `GET /projects/{id}/purchase-order/contacts` lists the project company's non-archived contacts for manage of the entity only; nothing of the contact is stored (the PO row holds only the id); the `PATCH` sets, changes and clears the referent for manage of the entity, refuses others (`403`), refuses an invalid contact (`422 referent_invalid`), a stale version (`409`) and a hand-made project (`404`).
- [x] T27: projects-api — the project-manager pick and the awaiting state — refs: AC-4.5, AC-4.7, AC-4.8, AC-4.9 — deps: T26
  - touch: `projects-api/src/projects/**`, `projects-api/src/test-support/**`
  - done when: `bun test src/projects` is green with tests that on an awaiting project the PO's ops-manager and an `oversees` admin can set the project manager and another ops-manager, a sales, a project manager of the entity and the assignee after losing `purchase-order:receive` get `403 not_ops_manager`; a person without project access → `422 not_project_user`; after the pick the project is no longer awaiting and any manage holder changes the project manager as in specs/021; `projectManagerId: null` → `422 project_manager_required`; `planned` → `active` while awaiting → `409 awaiting_project_manager` and other moves still work; `GET /projects?projectManagerId=none` returns only awaiting projects and their list items carry `projectManager: null`, `awaitingProjectManager: true`.
- [x] T28: projects-api — hand-made projects: any type, `saas` with a company, optional terms at creation — refs: AC-5.1, AC-5.2, AC-5.3 — deps: T27
  - touch: `projects-api/src/projects/**`, `projects-api/src/terms/**`, `projects-api/src/test-support/**`
  - done when: `bun test src/projects src/terms` is green with tests that `POST /projects` creates each of the five types with the company rule of § API contracts, the creator as project manager and no PO; with valid terms it creates project and terms together, with invalid ones `422` naming `terms.<field>` and nothing created, with terms on `internal` `422 terms_not_allowed`; a hand-made project's terms can later be added, edited and removed (S5) and no route gives it a PO.
- [x] T29: projects-api — authorization matrix for every changed route — refs: AC-1.1, AC-1.9, AC-3.7, AC-4.8, AC-5.1 — deps: T24, T25, T26, T27, T28
  - touch: `projects-api/src/matrix.test.ts`
  - done when: `bun test src/matrix.test.ts` is green for `GET /queue`, the take, `ops-managers`, both contacts routes, the terms routes, the PO routes, the pick and `GET /system/purchase-orders` × {no access, access only, `project-manager` (welld_ch), `ops-manager` (welld_ch), `sales` (welld_it), `accounting`, admin}, matching § Authorization; and the full `bun test` and `bun run typecheck` are green.
- [x] T30: projects-ui — rename to purchase order / terms at parity, API client and types for every route above, sales-only queue, attach and type change removed (en + it) — refs: AC-1.1, AC-1.9, AC-1.10, AC-3.3, AC-5.2 — deps: none
  - touch: `projects-ui/src/**`
  - done when: `cd projects-ui && mise exec -- pnpm lint && mise exec -- pnpm build && mise exec -- pnpm test` is green with tests that the nav shows "To start" and `/queue` loads only when `scope.take` is non-empty (otherwise the permission-denied state); `AttachDealDialog` and the type-change control no longer exist; the project page renders a project with a PO and one without from the § API contracts shapes (PO card with deal link, notice and estimate link; Terms card without any PO element); `projectsApi.ts`, `types.ts` and `errors.ts` carry every route, shape and error code of § API contracts so T31–T33 do not edit them; no "contract" copy is left in `strings/` (EN "Purchase order", IT "Ordine d'acquisto").
- [x] T31: projects-ui — "New project" from a queued deal: `saas` offered, no project manager, ops-manager picker with prefill, referent picker — refs: AC-1.2, AC-1.8, AC-1.11, AC-3.5, AC-3.6, AC-4.1, AC-4.2 — deps: T30
  - touch: `projects-ui/src/components/TakeDealDialog.tsx`, `projects-ui/src/components/TakeDealDialog.test.tsx`, `projects-ui/src/components/OpsManagerPicker.tsx`, `projects-ui/src/components/ReferentPicker.tsx`, `projects-ui/src/components/ReferentPicker.test.tsx`, `projects-ui/src/pages/QueuePage.tsx`, `projects-ui/src/pages/QueuePage.take.test.tsx`, `projects-ui/src/strings/queue.ts`
  - done when: `pnpm lint && pnpm build && pnpm test` is green with tests that the form offers T&M / Fixed price / Maintenance / SaaS and no project-manager field; the ops-manager picker lists role holders and admins (marked), is prefilled from `prefillId` and otherwise requires a choice; the referent picker lists the deal company's contacts and may stay empty; fixed price without an estimate offers estimated man-days as optional input; `ops_manager_invalid`, `referent_invalid`, `identity_unavailable`, `out_of_scope` and the 2026-11-04 refusals each show their own message; on success the user lands on the project, awaiting its project manager.
- [x] T32: projects-ui — project page: PO card (referent states and edit, ops-manager), awaiting notice, "Pick project manager", activation blocked while awaiting — refs: AC-2.3, AC-2.4, AC-3.1, AC-3.2, AC-3.7, AC-3.8, AC-3.9, AC-3.10, AC-4.6, AC-4.7, AC-4.8, AC-4.9 — deps: T31
  - touch: `projects-ui/src/components/PurchaseOrderCard.tsx`, `projects-ui/src/components/PurchaseOrderCard.test.tsx`, `projects-ui/src/components/PickProjectManagerDialog.tsx`, `projects-ui/src/components/PickProjectManagerDialog.test.tsx`, `projects-ui/src/components/ReferentPicker.tsx`, `projects-ui/src/components/StateActions.tsx`, `projects-ui/src/pages/ProjectDetailPage.tsx`, `projects-ui/src/pages/ProjectDetailPage.test.tsx`, `projects-ui/src/strings/project.ts`, `projects-ui/src/strings/purchaseOrder.ts`
  - done when: `pnpm lint && pnpm build && pnpm test` is green with tests that the PO card shows the referent's name, job title, email and phone, "referent unavailable" for `status: "unavailable"` and no referent for `null`, and offers the referent edit only with manage of the entity; an awaiting project shows the notice naming the ops-manager and "Pick project manager" only to that ops-manager or when `scope.oversees`; a successful pick removes the notice; "Activate" is disabled with the reason while awaiting; no control clears the project manager; the estimate-backed man-days stay read-only in the terms edit.
- [x] T33: projects-ui — list awaiting state and filter; hand-made create with any type and optional terms; terms add / edit / remove on a hand-made project — refs: AC-4.5, AC-5.1, AC-5.2, AC-5.3, AC-5.4 — deps: T32
  - touch: `projects-ui/src/pages/ProjectsPage.tsx`, `projects-ui/src/pages/ProjectsPage.test.tsx`, `projects-ui/src/components/ProjectFormDialog.tsx`, `projects-ui/src/components/ProjectFormDialog.test.tsx`, `projects-ui/src/components/TermsCard.tsx`, `projects-ui/src/components/TermsCard.test.tsx`, `projects-ui/src/components/TermsFormDialog.tsx`, `projects-ui/src/pages/ProjectDetailPage.tsx`, `projects-ui/src/strings/projects.ts`
  - done when: `pnpm lint && pnpm build && pnpm test` is green with tests that an awaiting row reads "Awaiting project manager" and the project-manager filter offers "None yet"; a `saas` row shows its company; the create dialog offers all five types, requires a company for all but Internal, and offers the type's terms as an optional section that, once opened, enforces the type's rules; a hand-made project's Terms card adds, edits and removes terms for manage holders and shows none when it has none.
- [x] T34: docs — ADR-0062 (terms and purchase order as two 0..1 records; "contract" retired), ADR-0063 (`handoff:take` and `purchase-order:receive`, the auth holders listing, the admin override); ADR-0060 amended for `/system/purchase-orders`; AGENTS.md, READMEs, changesets — refs: AC-1.9, AC-1.10, AC-4.1, AC-5.2 — deps: T19, T20, T21, T22, T23, T24
  - touch: `docs/adr/0060-*.md`, `docs/adr/0062-*.md`, `docs/adr/0063-*.md`, `AGENTS.md`, `auth/README.md`, `crm-api/README.md`, `projects-api/README.md`, `notify-api/README.md`, `.changeset/*.md`
  - done when: both ADRs exist with Context / Decision / Alternatives / Consequences and the rejected alternatives of § Decided here; ADR-0063 states that it amends ADR-0047 (the holders listing's `unconditioned` bit) and records § Security rules; ADR-0060 carries a dated amendment note; AGENTS.md's index lists 0062 and 0063; `mise exec -- pnpm changeset status` shows bumps for auth, crm-api, notify-api, notify-ui, projects-api and projects-ui.
- [x] T35: local env — `NOTIFY_INTERNAL_URL` for projects-api and the renamed / new service-client scopes in the env examples and env-doctor; a script the developer runs for the local values — refs: AC-3.4, AC-3.8, AC-4.3 — deps: T19, T21, T22, T25
  - touch: `auth/.env.example`, `projects-api/.env.example`, `crm-api/.env.example`, `tools/env-doctor/manifest.ts`, `tools/env-doctor/*.test.ts`
  - done when: `bun test tools/env-doctor` is green with `NOTIFY_INTERNAL_URL` required for projects-api in the manifest; the `SERVICE_CLIENTS` examples give `projects-api` `crm.companies.read crm.deals.read crm.contacts.read estimai.estimates.read notifications.push` and `crm-api` `projects.purchase-orders.read` besides its notify scopes; the developer has run the main loop's script for the gitignored values (agents never write env files).
- [x] T36: local databases — reset `projects` and `projects_test` to the two migrations (021's init + the new one), drop the stale `contract:*` permission rules from the local auth database, assign the `ops-manager` role, reseed CRM, EstimAI and Projects with coherent data (user constraint) — refs: AC-1.1, AC-4.1, AC-5.1 — deps: T19, T23, T35
  - touch: none in the repository — local databases and the session scratchpad only (main loop)
  - done when: after a backup of the current dumps, `projects` and `projects_test` hold exactly the two migrations' history (no `*_handoff`); the auth database has no `contract` permission rule and one user per entity holds `ops-manager`; under `mise run dev` the queue shows won deals to a `sales` user and not to a project manager, and the seed holds at least one project awaiting its project manager, one with a project manager and a referent, one `saas` licence project and one hand-made project with terms.
- [x] T37: every remote module — the router is built when the module mounts, so browser back/forward across modules shows the right page (D52; added 2026-11-05 after gate 1 re-approval) — refs: AC-6.1 — deps: none
  - touch: `admin-ui/src/App.tsx`, `crm-ui/src/App.tsx`, `estimai-ui/src/App.tsx`, `inventory-ui/src/App.tsx`, `notify-ui/src/App.tsx`, `projects-ui/src/App.tsx`, `refund-ui/src/App.tsx`, `*-ui/src/**/*.test.tsx` (one new back-navigation test per module)
  - contract: root cause to confirm first (systematic-debugging) — each remote creates its TanStack router once at module load (`const router = createAppRouter('/<base>')`), so after the shell switches module and the user comes back the remount renders the match of the *other* module's address (projects-ui: `/$id` matches `admin`). Expected fix: create the router per mount (e.g. `useState(() => createAppRouter(…))`), checking that the previous instance leaves no history listener behind; if the test shows another mechanism, state it and fix that instead. No route or URL changes.
  - done when: in each of the seven modules a test, red before the fix, mounts the app on its own address, moves the browser history to another module's address, unmounts, goes back and remounts — and asserts the module's own page (the list for projects-ui) and, in projects-ui, no `GET /projects/<other module>`; then green with each module's `pnpm lint && pnpm build && pnpm test`; and a headless check on the dev stack of `/projects` → `/admin` → back and `/crm` → `/admin` → back shows the list / companies page with no 404 request.
- [x] T38: every remote module — browser back/forward *within* a module shows the page of the address (D4; D53, added 2026-11-06) — refs: AC-6.2 — deps: none
  - touch: `*-ui/src/App.tsx`, `*-ui/src/router.tsx`, `*-ui/src/**/*.test.tsx`, `*-ui/package.json`, `*-ui/pnpm-lock.yaml`, `shell/package.json`, `shell/pnpm-lock.yaml`, `.changeset/*.md` (the seven remotes: admin, crm, estimai, inventory, notify, projects, refund) — `unknown` beyond that until the root cause is known: report any other file before touching it
  - contract: root cause first (systematic-debugging) — QE round 2 (`qe-report.md`, D4): back/forward inside a module changes the address but not the page (`/projects` → "To start" → back still shows "To start"; `/crm` → a company → back stays), reproduced at the pre-T37 code too; both history listeners fire but the module's router does not commit the BACK load; a later `popstate` makes it catch up. Lead to check, not a conclusion: `@tanstack/react-router` `^1.168.2` in the shell vs 1.170.x in the remotes, shared at runtime by module federation. Keep AC-6.1 (and the T37 / fix-round-2 guarantees) green. Also add the changeset T37 lacked (N1) covering the seven modules' router change.
  - done when: a test, red before the fix, reproduces in-module back and forward in projects-ui and crm-ui (and in every module where it reproduces); green after with each touched module's `pnpm lint && pnpm build && pnpm test`; the main loop's headless check on the dev stack shows `/projects` → "To start" → back = list, list → a project → back = list, `/crm` → a company → back = the CRM page, forward after back = the page left, and the T37 cross-module checks still pass; `pnpm changeset status` lists the router change.
- [x] T39: projects-ui — a field's error clears when the field changes, in the take, "Edit details", terms and end-terms dialogs (D2; D53, added 2026-11-06) — refs: AC-7.1 — deps: none
  - touch: `projects-ui/src/components/TakeDealDialog.tsx`, `projects-ui/src/components/ProjectEditDialog.tsx`, `projects-ui/src/components/TermsFormDialog.tsx`, `projects-ui/src/components/EndTermsDialog.tsx`, `projects-ui/src/components/TermsFields.tsx`, their `*.test.tsx`, a shared helper under `projects-ui/src/lib/` if extracted from `ProjectFormDialog`'s `clearErrors`
  - done when: for each of the four dialogs a test, red before the fix, shows a refused field's message and invalid mark gone after the field changes (no new submit), the next submit re-validating; the end-date message also goes when the start date changes; `projects-ui` lint, build and test green.
- [x] T17: QE-light verification; all gates green; spec status → done — refs: every AC — deps: T18, T19, T20, T21, T22, T23, T24, T25, T26, T27, T28, T29, T30, T31, T32, T33, T34, T35, T36, T37, T38, T39
  - touch: `specs/022-projects-handoff/qe-report.md`, `specs/022-projects-handoff/spec.md`
  - done when: the quality-engineer's QE-light verdict is PASS in `qe-report.md` — including a live pass: as `sales`, take a won deal into a new fixed-price project with a referent and the prefilled ops-manager and see the estimate's man-days; as that ops-manager, see the notification, fail to activate the project, pick its project manager; as a project manager, see no queue; open the PO's referent as a user without CRM access; reopen and re-win the deal and see the notice come and go; open the estimate link as a user without EstimAI access; see project and Bexio id on the CRM deal page; create a hand-made `saas` project with terms — every local gate it lists is green (auth, crm-api on `crm_test`, notify-api, notify-ui, crm-ui, projects-api, projects-ui, estimai-api, env-doctor, shared copies, changeset, secret scan), and `/wellforge:done 022-projects-handoff` accepts the feature.

## Coverage

| AC | Tasks |
|---|---|
| AC-1.1 | T19, T24, T30, T36 (built: T3, T6, T12) |
| AC-1.2 | T23, T24, T31 |
| AC-1.3 | T23, T31 |
| AC-1.6 | T23 (built: T5, T6, T7) |
| AC-1.8 | T23, T31 |
| AC-1.9 | T19, T24, T29, T30 |
| AC-1.10 | T23, T30 |
| AC-1.11 | T24, T31 |
| AC-2.1 | T23 (built: T3, T6, T12) |
| AC-2.2 | T23 (built: T3, T6) |
| AC-2.3 | T23, T32 |
| AC-2.4 | T23, T32 |
| AC-3.1 | T23, T32 (built: T2, T5, T7) |
| AC-3.2 | T23, T32 |
| AC-3.3 | T23, T30 |
| AC-3.4 | T19, T21, T23 (built: T10, T11) |
| AC-3.5 | T23, T31 |
| AC-3.6 | T18, T21, T24, T26, T31 |
| AC-3.7 | T26, T29, T32 |
| AC-3.8 | T18, T21, T26, T32, T35 |
| AC-3.9 | T18, T21, T26, T32 |
| AC-3.10 | T18, T26, T32 |
| AC-4.1 | T18, T19, T20, T24, T31, T36 |
| AC-4.2 | T20, T24, T31 |
| AC-4.3 | T22, T25, T35 |
| AC-4.4 | T25 |
| AC-4.5 | T27, T33 |
| AC-4.6 | T32 |
| AC-4.7 | T27, T32 |
| AC-4.8 | T19, T24, T27, T29, T32 |
| AC-4.9 | T27, T32 |
| AC-5.1 | T28, T29, T33, T36 |
| AC-5.2 | T23, T28, T30, T33 |
| AC-5.3 | T28, T33 |
| AC-5.4 | T23, T33 |
| AC-6.1 | T37 |
| AC-6.2 | T38 |
| AC-7.1 | T39 |

Effective graph (`deps:` ∪ `touch:` overlap) for the open tasks, batches that can run in
parallel:
1. T18 (owasp-reviewer), T19 (auth), T22 (notify), T23 (projects-api), T30 (projects-ui)
2. T20 (auth), T21 (crm-api), T24 (projects-api), T31 (projects-ui)
3. T25, T32
4. T26, T33
5. T27, T34
6. T28, T35
7. T29
8. T36 (main loop)
9. T37 (after the first QE pass), then T17 again

Overlap edges declared (none merged): T19 → T20 (`auth/src/**/*.test.ts`); T23 → T24 →
T25 → T26 → T27 → T28 → T29 (each touches `projects-api/src/**` or a file of the one
before — projects-api is one sequential track); T30 → T31 → T32 → T33 (`projects-ui/src/**`,
`ReferentPicker.tsx`, `ProjectDetailPage.tsx`). The tracks auth, crm-api, notify,
projects-api and projects-ui share no file and run in parallel worktrees; T23's
`projects-api/src/**` is deliberately broad because the rename touches nearly every module.
