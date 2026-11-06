# 0063 — The hand-off is gated by two entity-scoped capabilities, `handoff:take` and `purchase-order:receive`; auth lists the holders of the second behind the first (`GET /authz/users/holders`, amends ADR-0047's "no other attribute"); the admin override is `oversees`, never `hasCapability`; the referent is read live and never copied

**Date:** 2026-11-05
**Status:** Accepted — amends ADR-0047 for one endpoint (its `{ id, name, email, entity }` directory, its gate and its "no role or any other attribute" rule for `GET /authz/users/directory` are unchanged; see Decision 3). Specs/022-projects-handoff, tasks.md § Architecture notes and § Security rules; the security design review is `specs/022-projects-handoff/security-review.md` (T18, PASS-WITH-CHANGES, every medium folded in before the code was written). Taken at rigor `mvp` without an architect — review before merge.
**Deciders:** wellD
**Project:** Operai

---

## Context

specs/022 hands a won deal from sales to delivery in series (ledger D37–D51):

- **Sales takes the deal.** The to-start queue and "new project from a deal" belong to `sales` and
  the admins; a project manager, an ops-manager, accounting and every other `projects:access`
  holder get no queue and a `403` (D37, AC-1.9). That cannot be `project:manage`: the project
  manager and the ops-manager hold it too (ADR-0058).
- **An ops-manager receives the purchase order.** The take assigns the PO to a user who holds the
  `ops-manager` role for the deal's entity — or to an admin (D44) — and that user, or an admin in
  their place (D46, D47), later picks the project manager. Capabilities, not role names, decide
  (ADR-0007).
- **The picker needs a list the suite does not have.** projects-api must offer, and later
  re-validate, "who may be the ops-manager of a deal of entity X". `auth`'s directory
  (ADR-0047/0053/0055) lists every active user with email and entity behind a gate that admits
  asset, deal and project managers; it has no notion of "holds this permission for this entity".
  `POST /authz/users/identities` (ADR-0039) is id-keyed.
- **The referent is a third party's personal data shown to people who may not open the CRM.** A PO
  carries an optional referent, a CRM contact of the PO's company; its name, job title, email and
  phone are shown to every `projects:access` holder, OPS included, who holds no `crm:access`
  (D49). The project module and the CRM are different permission domains (ADR-0058/0059).

The user's standing preference on uncertain designs is the least invasive, easiest-to-change
option; the security check of the referent read was made a gate before any of it was built (D49).

## Decision

1. **Two capabilities in the `projects` catalog, both with the `entity` condition (ADR-0015).**
   - `handoff:take` — read the queue (`GET /queue`, under any entity; the whole queue is visible,
     S3) and take a deal of the entity the grant covers. Held by `sales` for its own entity and by
     `admin` unconditioned. A take needs **both** `handoff:take` **and** `project:manage` for the
     deal's entity: no `handoff:take` at all is `403 forbidden`, one that misses the deal's entity
     (or a missing manage) is `403 out_of_scope`.
   - `purchase-order:receive` — be the ops-manager of a purchase order. Held by the new system
     role `ops-manager` (with `projects:access` and own-entity `project:manage`) for its own entity
     and by `admin` unconditioned.
   - `purchase-order:bexio` (was `contract:bexio`, ADR-0062) stays unconditioned, `accounting` and
     `admin`. The resolver keys grants by `(resource, action)` without the app id, so no other
     catalog may declare a `handoff` or `purchase-order` resource.
2. **`GET /authz/users/holders?resource=purchase-order&action=receive&entity=welld_ch|welld_it`**
   in `auth`, on the forwarded-caller-JWT model (ADR-0014/0035; projects-api calls it with the
   caller's own Bearer, no new credential and no new secret):
   - **Gate:** `HOLDERS_GATE_PERMISSIONS = [handoff:take]` under any entity, resolved live, a
     soft-deleted caller refused (ADR-0012). Deliberately **not** `DIRECTORY_GATE_PERMISSIONS`.
   - **Own limiter**, separate counters from the directory's, keyed by `sub`, counting every
     attempt past authentication — a `403` or a malformed query counts too (`429` +
     `Retry-After`); module constants (60 / 10 minutes), no env pair. `Cache-Control: no-store`.
   - **Strict query:** `entity` ∈ `welld_ch | welld_it`, unknown parameters `400 invalid_query`;
     **only the pair `purchase-order:receive` is answerable**, pinned as a server-side constant —
     any other pair (e.g. `asset:manage`) is `400 unsupported_permission`. The route can never
     become a general "who holds X" oracle.
   - **Answer:** `200 { users: [{ id, name, unconditioned: boolean }] }`, name-sorted — **no email,
     no entity**: the active users whose effective permissions grant the pair for that entity
     **and who hold `projects:access`**. Evaluation mirrors projects-api's `scopeFor` and fails
     closed: an unrecognised condition grants nothing; an entity-conditioned grant qualifies only
     when `user.entity` equals the asked entity (a user with no entity qualifies nobody);
     `unconditioned` is true when the grant is unrestricted.
3. **This ADR amends ADR-0047.** ADR-0047 Decision 1 says a people-list read carries "no address,
   job title, role or any other attribute. Adding a field is a change to this ADR". The holders
   listing is a **different endpoint for a different, narrower audience**, so the directory's
   contract, gate and test are untouched and ADR-0047 stays in force for
   `GET /authz/users/directory`. But the listing does carry one attribute beyond identity,
   `unconditioned` — "holds the permission for every entity", i.e. in practice *is an admin* —
   and that is the amendment: **for this endpoint only, a people-list answer may carry the
   `unconditioned` bit and nothing else**. It is needed because the ops-manager picker lists role
   holders first, admins last and marked, and the prefill counts role holders only (D44, D45); the
   alternative is projects-api re-resolving every person's grants itself. Any further field
   (email, entity, role names) is a change to this ADR. ADR-0047's escalation trigger — a further
   people-list consumer revisits the design instead of quietly extending it — is why this is a
   separate route and not a widening of the directory's gate or shape.
4. **The admin override is `oversees`, and it is computed from the scope, never from
   `hasCapability`.** "An admin" in D44/D47 is a holder whose `purchase-order:receive` grant is
   **unconditioned** — not a role-name test. `GET /scope` reports `take: Entity[]`
   (`handoff:take`) and `oversees: boolean`, where `oversees` is
   `scopeFor(permissions, "purchase-order", "receive", entity).length === ENTITIES.length`.
   `hasCapability` ignores conditions and would make every ops-manager an overseer.
5. **The pick rule.** A project with a PO and no project manager (*awaiting*) takes its project
   manager from `PATCH /projects/{id}` `projectManagerId` only from a caller who `oversees`, or
   from the PO's `opsManagerId` — **read from the row, never from the request** — who **still
   holds `purchase-order:receive` for the project's entity**; anyone else, another ops-manager and
   any other holder of `project:manage` included, gets `403 not_ops_manager`. The check and the
   write sit under the `version` compare-and-set (ADR-0038), so a role lost between them cannot
   slip through. The person must hold project access (`422 not_project_user`). After the first
   pick any holder of manage changes it as in specs/021 (A34); clearing it is
   `422 project_manager_required`; while awaiting, `planned` → `active` is `409
   awaiting_project_manager` (D48). **The restriction is a workflow rule, not a security
   boundary**: a project manager confers no capability, and nothing here lets one escalate.
6. **The ops-manager is chosen from auth, live, twice.** `GET /queue/{dealId}/ops-managers`
   returns the holders for the deal's entity (`admin` = `unconditioned`, admins last) and a
   `prefillId` only when exactly one non-admin exists; the take re-reads the list and refuses an
   `opsManagerId` outside it (`422 ops_manager_invalid`). Auth unreachable, slow, refusing or
   unreadable is `503 identity_unavailable` — fail closed, never an empty list and never "valid" —
   and nothing is cached. A PO is not reassigned in v1 (D47).
7. **Security rules for the referent (T18, binding on every task that touches it).**
   - **Read live, never copied.** The PO stores only `referentContactId`. Its details are read
     from crm-api `GET /system/contacts` (`crm.contacts.read`, granted to `projects-api` only)
     **once per project read, only when a referent is set**, in parallel with the other reads;
     there is no copy and **no cache** of contacts anywhere in projects-api (not the 60-second
     identities cache), so a CRM edit or erasure shows at the next read.
   - **`Cache-Control: no-store`** on `GET /projects/{id}`, the PO `PATCH` echo and both contact
     routes; projects-ui keeps referent and contact lists in memory only, renders their fields as
     text, builds `mailto:` / `tel:` with a fixed scheme (never `href={value}`) and labels an
     `admin: true` picker item "All entities" / "Tutte le entità".
   - **One predicate at read and at set.** The contact shown, and the contact accepted, is the one
     whose `id` equals the stored id exactly **and whose company is the project's** (the live
     deal's company at the take); otherwise the referent shows as none with none of its data. An
     archived contact stays shown (S6) but cannot be chosen. Set-time refusal is one identical
     `422 referent_invalid` body for unknown, other-company and no-company ids, company check
     first, never echoing the id, name or company.
   - **The server derives the company.** Contact lists for pickers come from
     `GET /queue/{dealId}/contacts` and `GET /projects/{id}/purchase-order/contacts`, each for the
     entity's `project:manage` / take holders; a client never sends a company id (the first
     draft's `GET /companies/{id}/contacts` was a contact directory for non-CRM users and was
     removed, M1).
   - **Minimal shapes with an explicit `select`.** crm-api's `GET /system/contacts` has one shape
     per mode — `companyId`: `{ id, firstName, lastName, jobTitle }`, ≤ 500 with `truncated`;
     `ids` (≤ 20): the full display set — built with a Prisma `select` (never `notes`,
     `createdBy`, `updatedBy`, `version`), pinned by a key-set contract test; projects-api picks
     fields by name, never spreads a CRM item (M2, L3).
   - **No referent data leaves the owner's route:** none in `GET /system/purchase-orders`, the
     ops-manager's notification, logs, error bodies or OpenAPI examples; fixtures, examples and
     seeds use synthetic contacts. projects-api logs one structured line per take, referent
     set / clear and project-manager pick — event kind, project id, actor id (L6).
   - **The audience is every `projects:access` holder**, with or without CRM access: the owner's
     decision (D49, Q4) — an internal, admin-assigned audience within one controller. Narrowing
     email and phone to manage holders, the project manager and the ops-manager remains an option,
     not a requirement.

## Failure shape

**A permission that is *about people* — who may be asked for, who may receive, whose data is
shown — decided by a coarser grain than the thing it protects, or by a copy that outlives it.** The
quiet routes in: a "just a picker" list gated like the nearest existing list; a role name tested in
code where a capability was meant, so a renamed role or a second holder silently changes who
counts; an admin check written as `hasCapability`, which ignores conditions, so every holder of a
scoped grant behaves like the holder of an unconditioned one; a contact copied "so the page is
fast", after which an erasure in the CRM no longer reaches it; a check made at *set* time that
nobody repeats at *read* time.

Where else this shape can appear, in the position opposite to where it was met:

- **Read and write.** Every write that names a person (assign, pick, hand over) needs a candidate
  read gated by the **same** capability as the write, and the write re-validates the candidate
  live, not from the list the form once showed (ADR-0047's rule, extended to a pair: `take` for
  the queue, `receive` for the assignee).
- **Inbound and outbound.** A service that fetches another domain's personal data to show it holds
  a copy the moment it stores, caches or logs it; the safe shape is id on our side, details live
  from the owner, `no-store` on the way out, minimal `select` on the owner's side.
- **Scoped versus unscoped checks.** Anywhere a test reads "does this caller hold X?" and the
  grant is conditional, the answer must be a *scope* (which entities), not a boolean.
- **A route that answers "who holds X?"** is an oracle for roles. Pin the pairs it answers, narrow
  its gate to the people who need the answer, bound what it returns to what the picker renders.
- **Recognise it** by the sentence "the other tool needs to show / pick … so we also keep …", or
  by a boolean that means *any* grant where the rule means *unrestricted*.

## Alternatives considered

- **Role-name filters on the directory** (`GET /authz/users/directory?role=ops-manager`).
  Rejected: capabilities, not role names, decide (ADR-0007) — a renamed role or a second role
  holding `purchase-order:receive` would silently change the list; the directory carries email and
  entity the picker does not need; and "an admin" could not be expressed except by a role name
  again. ADR-0055 already added an `?appId=` filter to it; a role filter would turn a picker
  endpoint into a query surface.
- **The directory's gate for the holders listing** (`DIRECTORY_GATE_PERMISSIONS`). Rejected (T18
  M4): it admits asset managers, deal managers and project managers, who have no business reading
  who may receive purchase orders — and the project manager and ops-manager must not reach the
  take's picker at all (AC-1.9). The gate is `handoff:take`, the capability of the people who
  actually ask.
- **A "reassign the PO" flow** (an ops-manager away or gone). Rejected for v1 (D47): it needs a
  route, a notification and an audit story; an admin picks the project manager in the assignee's
  place instead, which needs none of them. A non-goal, not an omission.
- **Folding the queue into `project:manage`, or leaving it "readable by every access holder"**
  (the 2026-11-04 text, A20). Superseded by D37: the project manager and the ops-manager hold
  manage and must see no queue, so the queue and the take need their own capability.
- **`hasCapability` for the admin override.** Rejected (T18 L5): it ignores the entity condition
  and would make every ops-manager oversee every entity.
- **Copying the referent's details onto the PO, or caching them.** Rejected (D49): the copy goes
  stale, an erasure in the CRM (specs/017 AC-2.4) would not reach it, and projects-api would
  become a second store of third-party personal data with weaker rules.
- **Giving OPS `crm:access`** so the plain contact routes work. Rejected as in ADR-0059: it opens
  every CRM record to people who need one person's details.

## Consequences

**Positive:**
- The queue and the take are visible only to those who hand deals over; the project manager and
  the ops-manager see no queue, in the UI and at the server.
- The admin override is structural: `oversees` follows the grant, so it needs no role name and
  cannot be inherited by an own-entity ops-manager.
- The holders listing is narrower than the directory in three ways — gate, population and fields —
  and the project-module audience for referent data is bounded by one live read, one predicate and
  `no-store`.
- No copy of a contact exists in projects-api or its logs: erasure and edits in the CRM take effect
  at the next read.

**Negative / trade-offs:**
- **A second people-list endpoint in `auth`**, with its own gate, limiter, pinned pair and shape: a
  standing maintenance obligation, guarded by contract tests (non-holders get `403`, any other pair
  `400`, the answer carries exactly `{ id, name, unconditioned }`).
- `unconditioned` tells every `handoff:take` holder (sales) which candidates are admins — a
  role-derived fact, accepted here because the picker's order and labels need it.
- Every `projects:access` holder, CRM access or not, sees a referent's name, job title, email and
  phone (D49). That is the owner's accepted exposure, not a technical need.
- A take now needs auth (for the holders) and crm-api (the deal and the referent check) to answer:
  both fail closed (`503 identity_unavailable`, `503 crm_unavailable`) and nothing is written.
- Holders are evaluated per candidate with the resolver — fine at wellD's size; the first user
  count that makes it slow revisits this ADR.
- Rate limiting is in-process, per instance (as ADR-0035/0047): a scale-out of `auth` multiplies
  the limit.

**Risks:**
- **Gate erosion.** A later consumer asks for the holders of another pair and the constant is
  relaxed instead of the design revisited. Mitigation: the pair is pinned in code, a test asserts
  `asset:manage` is `400`, and this ADR names it a change here.
- **An assignee who loses `purchase-order:receive`** between the take and the pick can no longer
  pick (`403 not_ops_manager`); only an admin can. Designed (D47), not a defect; the awaiting
  notice names the ops-manager so the admin knows who to ask.
- **An erased CRM contact leaves an orphan id** on the PO. It shows as no referent and none of its
  data (AC-3.9); clearing the id is deferred (L10).
- **Deferred, knowingly:** per-viewer logging of referent reads (L6) and a per-caller limit on
  crm-api `/system/*` (L7).

## Compliance notes

- GDPR / nLPD impact: **medium-low**. A referent is a third party's personal data (name, job title,
  work email, phone), shown to every `projects:access` holder for the stated purpose of running a
  delivery with that client. It is read live from its controller's system (the CRM), never stored
  or cached by the project module, never logged, never put in a notification or a system route,
  and `no-store` on the wire; an erasure in the CRM takes effect at the next read. The holders
  listing exposes employees' names and the `unconditioned` bit to `handoff:take` holders, no email.
- Data residency: compliant — `auth`, `crm-api` and `projects-api` stay in the suite's EU
  deployment; no third party is involved.
- Audit trail: structured log lines (event kind, project id, actor id) for the take, a referent set
  or clear and a project-manager pick; nothing is Tier 1 or Tier 2 (ADR-0033).

Builds on ADR-0007 (capabilities decide), ADR-0014/0035 (forwarded caller JWT), ADR-0015 (entity
condition), ADR-0038 (`If-Match`), ADR-0039 (live identities), ADR-0058/0062 (the projects module
and its model) and ADR-0059/0060 (scoped service credentials, live reads). **Amends ADR-0047**
(Decision 3 above); ADR-0053 and ADR-0055's directory changes are unaffected.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
