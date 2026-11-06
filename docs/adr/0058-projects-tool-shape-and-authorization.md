# 0058 — The project module is a seventh tool (`projects-api` + `projects-ui`) whose reads are open to every `projects:access` holder, whose writes are entity-scoped `project:manage`, and whose Bexio order id is `contract:bexio`

**Date:** 2026-11-03
**Status:** Accepted (specs/021-projects; the product owner chose D13, D34, D35 and D36 in the grilling and at spec review; the rest is the tasks.md architecture notes, written at rigor `mvp` without an architect — review before merge)
**Deciders:** wellD
**Project:** Operai

---

## Context

wellD wants the delivery work it runs to have a home in Operai (specs/021-projects): **projects**
(a type, a state, a project manager, a team), the **contracts** on them (what one client bought, as
structured delivery terms: deadline and effort cap, SLA, hour package, T&M positions, licence
period) and the **Bexio order id** that administration opens for each contract. The suite has a
settled shape for a tool that owns data — a federated remote mounted by the shell (ADR-0006), a
Bun + Hono + Prisma resource server with its own logical database (ADR-0003/0005), app access
gated by an `(appId, "access")` grant (ADR-0007) — and a precedent for open reads with scoped
writes (ADR-0052).

The module serves people the suite has not served before, and that decides the rest:
- **OPS** (delivery) runs the projects and holds no `crm:access`.
- **BD** (the existing `sales` role) opens projects too (D36).
- **Accounting** (the existing `accounting` role, amministrazione) is the only one who writes the
  Bexio order id (D3, D35).
- OPS needs to read colleagues' projects (cover, workload), so a project is team knowledge in the
  same way a client is in the CRM.

## Decision

1. **Shape.** A new service pair, `projects-api` (Bun + Hono + Prisma, port 8085, logical DB
   `projects`, Railway EU) and `projects-ui` (remote `projects`, port 5180, exposes `./App` and
   `./version`), mounted by the shell at the gated `/projects/$` route. No object storage and no
   notify-api calls in v1. Ids are text cuids like the rest of the suite. **No money anywhere in
   the module** (D14): figures stay on the CRM deal behind `deal:financials` (ADR-0054).
2. **Catalog `projects`** (`auth/src/authz/catalogs/projects.ts`) with three permissions:
   - `projects:access` — the tool, and every read: every holder reads every project and contract
     of both entities;
   - `project:manage` — create and edit projects, their team and their contracts, and move their
     states; supports the `entity` condition (ADR-0015);
   - `contract:bexio` — write a contract's Bexio order id and nothing else; unconditioned.

   Seeded (`auth/src/authz/seed.ts`, `seedProjectsGrants`): `admin` all three unconditioned; a new
   system role `project-manager` with `projects:access` and entity-scoped `project:manage`;
   **`sales` gains** `projects:access` and entity-scoped `project:manage` — the same capability as
   the project manager, not a narrower one (D36, A29); **`accounting` gains** `projects:access`
   and `contract:bexio`, and no new "administration" role is created (D35); `employee` nothing.
3. **projects-api is authorization-enforcing** (ADR-0014): live `/authz/resolve`, `(sub, perm_epoch)`
   cache, fail closed with 503 `authz_unavailable`. Every route except `/health` requires
   `projects:access`. The guard stack is `projects-api/src/auth/guards.ts`: `authorized` on the
   route, then `assertCanManage(c, entity)` once the record's entity is known.
4. **Denials.** No capability → 403 `forbidden`. `project:manage` held for the other entity only →
   **403 `out_of_scope`**, not 404: the caller can read that record (ADR-0037's "a relationship
   exists but the level is insufficient" branch, as in ADR-0052). Unknown id → 404. `GET /scope`
   reports `{ manage, managesAll, bexio }` so projects-ui hides exactly what the server would
   refuse. A refused write changes nothing.
5. **The Bexio order id has its own route and its own capability.**
   `PUT /projects/:id/contracts/:contractId/bexio-order` needs `contract:bexio`, not entity-scoped
   (accounting writes it on either entity's contract). It is the only way to write the field: no
   `project:manage` route accepts it, and holding `contract:bexio` reaches no other field. Nothing
   in the module reads it to decide anything, so a missing id never blocks creating, starting or
   closing a project (AC-3.3).
6. **Every write on a project or contract takes `If-Match`** (ADR-0038): rename, change of project
   manager, state transition, type change, team replacement, contract edit and end, and the Bexio
   order id. Integer `version`, `ETag`, 428 without the header, 409 `version_conflict` when stale.
   **Creates do not** (`POST /projects`, `POST /projects/:id/contracts`): there is nothing to be
   stale against.
7. **A contract is never deleted.** `DELETE` answers 405 `not_deletable`; a contract ends by setting
   its end date (D34). A project's entity and company are fixed at creation: a wrong one is a new
   project.
8. **People are ids.** Names are resolved live and fail soft (ADR-0039). A project manager or team
   member must hold `projects:access`, checked live with `app-access-check` by user id (ADR-0055):
   422 `not_project_user`, and 503 when `auth` cannot answer.
9. **`project:manage` joins `DIRECTORY_GATE_PERMISSIONS`** (`auth/src/authz/directory.routes.ts`;
   ADR-0053's escalation, ADR-0055's `?appId=` filter) for the project-manager and team pickers.
   Deliberately not `projects:access` and not `contract:bexio`. The list's project-manager filter
   does **not** use the directory: it reads `GET /project-managers`, which needs only
   `projects:access` and returns the distinct project managers of projects the reader can already
   see, so every reader can filter.

CRM company names and the company picker are the subject of ADR-0059.

## Failure shape

**Two mistakes, both about how much of a record a caller's authority is allowed to touch, and how
sure the writer is of what it is changing.**

*Authority checked at a coarser grain than the thing it protects.* The guard asks "may this caller
do this kind of thing?" where the real question is "may they do it to *this record*, or to *this
field of it*?". The route-level check passes, the handler writes, and a holder scoped to one entity
edits the other's record, or the one person who may set a single field reaches the rest of the
record through the same endpoint (or the reverse). Its mirror image is a read gated like a write:
hiding or scoping records that every access holder legitimately works with, so a refusal
contradicts what the same caller just read.

*A shared record written from a stale picture.* Two people change the same record, the second
save lands on top of the first, and nobody is told. Every route that changes a record is a
read-modify-write whatever it is called: a rename, a state move, a "replace the team", a one-field
update by a different role.

Where else these shapes appear, in the position opposite to where they were met:
- **Read and write.** A new reader surface (an export, a search, a dashboard, a count, a picker's
  list) inherits "open to every access holder", and must not leak what writes are scoped to
  protect — here, a roster of people (the filter reads only names already on visible projects).
  Anything that takes a record id and changes it takes the record's entity and its version.
- **Create, update, delete.** A create has no stored entity: the check is on the requested one. An
  update checks the stored one, and a field that could later change entity would need both.
  Delete is the same write with the same entity check, or it is refused outright, as for
  contracts.
- **Derived and indirect writes.** A state transition, a type change, a team replacement, an
  end-dated contract, a record created by a hand-off from another tool or by a background job
  (specs/022 creates contracts from won deals): each is a write on a scoped, versioned record and
  needs the same entity decision and the same precondition, whichever principal runs it.
- **Field-level capabilities.** A field owned by a different role than its record (the Bexio order
  id) belongs behind its own route and capability; the record's general update must not accept it
  and its own route must accept nothing else.
- **Recognise it** by asking of any write: *whose entity is this record, who checked it after
  the record was loaded, which version did the writer see, and does a refused request leave the
  database byte-for-byte unchanged?*

## Alternatives considered

- **Project tables inside crm-api.** Rejected: different users (OPS holds no `crm:access`, and
  giving them it would open every CRM record to them) and a different lifecycle (a project
  outlives and aggregates sales opportunities; specs/022 hands deals over one at a time). One
  service would carry two permission domains and one deploy cadence.
- **Per-project visibility.** Rejected (D13): OPS needs colleagues' projects (cover, workload),
  and visibility per project needs an access list per record — ADR-0036's primitive, meant for a
  document an owner shares, not a team's shared register. Entity-scoped reads were not weighed
  separately here; ADR-0052 rejected them for the CRM on the same ground.
- **A dedicated `administration` role for the Bexio order id.** Rejected (D35, amending D13):
  `accounting` is already that function. It gains access and the capability; what is new is the
  capability, not the role.
- **Deleting a wrongly attached contract.** Rejected (D34): the product owner chose "no undo" over
  "remove it". A contract ends by an end date; a deal attached to the wrong project stays
  attached, and a hand-entered contract is not deleted either.
- **A narrower "create only" capability for `sales`.** Rejected (A29, an assumption the owner may
  strike): `sales` holds the same `project:manage` as the project manager. Whoever creates a
  project is its project manager by default and can hand it to an OPS colleague (D15).

## Consequences

- **Positive:**
  - OPS, BD and accounting each get the tool with exactly the capability their work needs, using
    two roles that already exist and one new one.
  - `projects-api/src/matrix.test.ts` drives every route against every persona (no access, access
    only, `project-manager`, `sales`, `accounting`, admin) on a record of each entity, and checks
    that a refused write leaves the database untouched. A route added without a row, or without a
    guard, fails it.
- **Negative:**
  - A reader of the module sees every project and contract of both entities, with their terms. If
    wellD ever needs private projects, that is a new read condition and it revisits point 4 (a 404
    becomes correct for unreadable records).
  - The project manager is not necessarily OPS: `sales` can create projects, edit terms and move
    states, and is the project manager of what it creates until it hands it over.
  - The user directory's gate now has three entries (`asset:manage`, `deal:manage`,
    `project:manage`), so every `project:manage` holder can list every active user. The resolver
    matches `(resource, action)` without the app id, so no other catalog may declare a `project`
    resource with a `manage` action — it would open the gate too.
  - The pickers need the directory, so a reader without `project:manage` gets no person pickers;
    the list's project-manager filter works for them through `GET /project-managers`, with no
    "only my projects" fallback.
  - A wrongly entered contract cannot be removed, only ended. A wrongly entered Bexio order id can
    be changed or cleared.
  - `projects-api` has a hard runtime dependency on `auth` for every request (ADR-0014's accepted
    trade-off) and for every project-manager or team write.
- **Risks:**
  - specs/023 adds writes that need less than `project:manage` (any access holder opens a thread
    and replies, D31; the assignee of a task marks it done, A22). Those are named exceptions to
    point 4's "writes are entity-scoped", to be recorded when that spec lands, not a quiet
    loosening of this one.
  - If a project ever shows money, it needs ADR-0054's server-side omission, not a hidden column.
