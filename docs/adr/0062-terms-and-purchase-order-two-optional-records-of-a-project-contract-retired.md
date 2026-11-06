# 0062 — A project has two optional records, its terms and its purchase order: a purchase order is born only from a won deal, a hand-made project never gets one, and "contract" is retired

**Date:** 2026-11-05
**Status:** Accepted (specs/022-projects-handoff, tasks.md § Architecture notes "Decided here"; steering D37–D42, grilling D43–D51; taken at rigor `mvp` without an architect — review before merge)
**Deciders:** wellD
**Project:** Operai

---

## Context

specs/021 modelled what a client bought as a **contract**: several per project, each with its
company, an `origin` (`deal` or `manual`), an optional deal id and Bexio order id, and the per-type
delivery terms (deadline and max effort, SLA, hour package, T&M positions, licence period)
(ADR-0058). specs/022's first draft added the deal and the estimate to it. On 2026-11-04 the user
steered the hand-off (ledger D37–D42) and on 2026-11-05 the grilling settled the rest (D43–D51):

- What a won deal brings to delivery is **one purchase order (PO)** — the deal, its estimate, the
  Bexio order id, a referent at the client and the **ops-manager** it is assigned to. A PO is
  born only from a won deal, together with its project; it is never typed in by hand (D38).
- A deal never attaches to an existing project (D39), and a project's type never changes (D7,
  A30): the 1-to-many "several contracts on one project" is gone.
- A project created **by hand** may be of any type and may still carry its type's delivery
  terms, optionally, at creation or later — but never a PO (D50, A38).
- `saas` is a client type with a company; each licence is its own project (D40).

So two facts that one table used to hold have different origins and lifetimes: the **terms** (what
was agreed to deliver, for any project that has them) and the **purchase order** (what a won deal
handed over, only for a project that came from one). The suite's rename also has to be total (A32):
a retired word that survives in one identifier — a capability, a scope, a route — is how two
vocabularies drift apart.

The constraint on the migration: the 022 PR is **stacked on the open PR #7** (specs/021 as it is),
so 021's `20261103163000_init` ships first and cannot be rewritten; only 022's own, never-shipped
`*_handoff` migration is free to go (user, 2026-11-05).

## Decision

1. **Two 0..1 records of a project, not one.**
   - `project_terms` (the old `contract` table minus its deal, company, origin and Bexio columns;
     0..1 per project, `projectId` UNIQUE) holds the dates and the type-specific terms for *any*
     project that has them, with its `project_terms_position` rows (CASCADE on the terms).
   - `purchase_order` (new; 0..1 per project, `projectId` UNIQUE) holds only what a won deal
     brings: `dealId` (UNIQUE NOT NULL — the database half of "a deal feeds at most one PO"),
     `estimateId`, `bexioOrderId`, `referentContactId` (an id, ADR-0063), `opsManagerId` (NOT
     NULL), `createdById`, `version`.
   - The `project` keeps its company, entity, type and state; `projectManagerId` becomes
     nullable (D42) — null only while the project has a PO, a rule the API enforces.
2. **A PO is born only from a won deal.** The take (`POST /queue/{dealId}/project`) is the only
   thing that creates a PO, and it creates the project, its terms and its PO in one transaction.
   No route adds a PO to an existing project, moves a deal, attaches a deal or changes a type
   (`POST /queue/{dealId}/attach`, `PUT /projects/{id}/type` and every `/contracts*` route are
   removed; `PATCH /projects/{id}` with `type` is `400`). "A hand-made project never has a PO"
   is therefore a matter of **no route creating one**, not of a constraint over a half-empty
   row; the PO routes answer `404 purchase_order_not_found` on such a project.
3. **Terms follow the project, not the deal.** A project from a deal always has terms (the API
   refuses to delete them: `409 terms_required`); a hand-made project may have them or not, and
   its holders of `project:manage` add (`POST /projects/{id}/terms`, `409 terms_exist`), edit
   (`PATCH`, estimate-backed man-days stay server-owned, ADR-0061) and remove them (`DELETE` →
   `204`). `internal` has no terms (`409 terms_not_allowed`; the database agrees with
   `terms_not_internal`). A PO is **never deleted** (no route) — the 021 "never deleted" rule
   now belongs to the PO, not to a contract.
4. **The nested terms wire shape of 021 is kept.** `Terms = { id, type, startDate, endDate,
   terms: <021's per-type view>, version }`; the create input is `{ startDate, endDate?, terms:
   <021's per-type input> }` — on the terms routes, in the take's body and in `POST /projects`
   (T28). The per-type schemas, the validation-path rule (`terms.deadline`) and projects-ui's
   per-type form fields carry over unchanged in substance; a `Project` shows `startDate` /
   `endDate` from its terms. Every write takes its version through `If-Match` (ADR-0038), never in
   the body. (The nesting was spelled out in tasks.md on 2026-11-05, after drift raised by the
   first projects-ui task.)
5. **"Contract" is retired everywhere** (A32): spec, API, data model, UI copy (EN "Purchase order"
   / IT "Ordine d'acquisto", "Terms" / "Termini"), the capability `contract:bexio` →
   `purchase-order:bexio`, the service scope `projects.contracts.read` →
   `projects.purchase-orders.read`, the route `GET /system/contracts` → `GET
   /system/purchase-orders` (ADR-0060 amended). The retired scope is not a known scope any more:
   a `SERVICE_CLIENTS` entry carrying it refuses to start, naming the client and no secret, so a
   half-migrated deployment fails loudly instead of quietly losing the CRM deal page's delivery
   card. (In the CRM "contract" still names the rendered *offer* document, a different thing.)
6. **The migration is stacked and guarded: refuse, do not convert.** `projects-api/prisma/
   migrations` holds 021's `20261103163000_init` byte-for-byte and one new
   `20261105120000_purchase_order` that transforms the 021 schema into the model above (renames
   `contract` → `project_terms` and its CHECKs → `terms_*`, drops the deal / company / origin /
   Bexio columns and the `ContractOrigin` enum, creates `purchase_order`, makes
   `projectManagerId` nullable, and replaces the company CHECK by
   `("companyId" IS NULL) = ("type" = 'internal')`). It opens with a guard that **raises, with a
   message saying what to do by hand, if the `contract` table has any row or any `saas` project
   exists** — data the new model cannot represent unambiguously: several contracts per project,
   a `saas` project that had no company, a Bexio id on a hand-entered contract. No data
   conversion is written. A database with projects but no contract and no `saas` project migrates
   untouched; the developer's local databases are reset and reseeded (T36).
7. **The database enforces what it can, the API the rest.** In the database: one terms row and one
   PO per project, `dealId` UNIQUE NOT NULL, `opsManagerId` NOT NULL, terms never on an
   `internal` project, a company iff the type is not `internal` (`saas` included), and every
   021 terms CHECK kept under its new `terms_*` name. In the API: a project with a PO has terms;
   no route creates a PO except the take; `projectManagerId` is null only while the project has a
   PO. `project_terms.type` repeats the project's type so the per-type CHECKs live on one row;
   it can never diverge because the type never changes (D7).

## Failure shape

**Two facts with different origins and lifetimes stored as one record, so that "this half is absent"
is spelled with nullable columns and CHECKs that must be kept in agreement — and a path left open
that lets a person type in by hand what the system should only receive.** The 021 contract held
both *what was agreed* and *what a won deal handed over*; its `origin` column and the two
`*_handoff` CHECKs were the cost of that: a `manual` contract could carry no deal, a `deal` one
had to, and every new rule ("a hand-made project may have terms but no PO") became another
conditional over the same row. A renamed concept has a second form of the same failure: the old
word surviving in one capability, scope or route name, so that the new model and the old
authorisation vocabulary disagree.

Where else this shape can appear, in the position opposite to where it was met:

- **Optional groups of columns.** A table with a block of nullable columns that are "all set or
  all null" (an asset's invoice, a deal's offer, a user's address) is an optional record in
  disguise; the question to ask is who creates the block and whether anyone else may.
- **A copy of the owner's fact under a different name.** The Bexio order id and the estimate id
  sit on the PO because the PO is what the deal became; a field that merely *describes* the
  project belongs on the project or its terms. Put a field where the record that creates it
  lives.
- **A retired word.** When a concept is renamed, the identifiers that are *checked* (capability
  keys, service scopes, route paths) must refuse the old name, not alias it; a name in prose only
  is cheap to leave and expensive to find.
- **A migration over data the new model cannot hold.** Converting what is ambiguous guesses; a
  guard that refuses names the rows and leaves the decision with a person.

## Alternatives considered

- **Terms as columns of `project`.** Rejected: it moves every terms CHECK, the positions table and
  its foreign key, the per-type validation and the form's shape onto the project — and the wire
  shape would still be a nested projection of it. Nothing is gained in behaviour; a project with
  no terms would carry a dozen null columns.
- **One `purchase_order` table with nullable deal columns, so a hand-made project's terms live on
  it too.** Rejected: that *is* the hand-entered contract D38 removed. `dealId` could no longer be
  NOT NULL (AC-1.6's database half), "a hand-made project never has a PO" would become a CHECK
  over a half-null row instead of "no route creates one", and every consumer of a PO (the CRM's
  deal page, the queue, the notice) would have to ask whether this one is real.
- **Keep the word "contract" for the PO and the terms** and rename only the UI copy. Rejected
  (A32): the capability, the scope, the route and the tables would then say one thing and the
  screen another, which is the drift the rename exists to end.
- **Convert contracts to terms and POs in the migration** (best effort: oldest contract wins,
  company guessed for `saas`, Bexio id dropped or parked). Rejected: each of those is a guess about
  business data; the only databases it could matter for are development ones, which are reset.
  The guard refuses instead and says why.
- **Rewrite or squash 021's `init` together with 022's migration.** Rejected: the 022 PR sits on
  top of PR #7, whose migration is reviewed and ships first; editing it would make the two PRs
  disagree about the same file.

## Consequences

**Positive:**
- Each record has one reason to exist and one creator: the take makes the PO, `project:manage`
  makes terms. "A hand-made project has no PO" and "a deal feeds one project" hold without a
  special case.
- specs/021's terms CHECKs, per-type schemas, routes and form survive in substance, so the rename
  is mostly mechanical in projects-api and projects-ui; the CRM deal page's `delivery` shape does
  not change, so crm-ui is untouched.
- A database in a state the migration cannot represent stops at `db:deploy` with a message, not
  half-way through an application upgrade.

**Negative / trade-offs:**
- A project from a deal is two rows plus the project, written in one transaction; reads join
  both, and "has a PO" implies "has terms" only because the API says so.
- `project_terms.type` duplicates `project.type` for the CHECKs. It is safe only while a type
  never changes; a future "change type" feature reopens this.
- The wrongly entered terms of a hand-made project can be removed, but a PO never is: a project
  made from a deal by mistake is cancelled, its deal does not return to the queue (D34).
- ADR-0058's contract vocabulary is read through this ADR: `contracts` → terms and purchase
  order, `contract:bexio` → `purchase-order:bexio`, "a contract is never deleted" → "a purchase
  order is never deleted". Its other decisions (the seventh tool, the denials, `If-Match`, people
  as ids, the directory gate) stand.

**Risks:**
- A deployment that already holds contracts or `saas` projects cannot run the migration until a
  person clears them. By design; the message says so. Nothing of 021 is on `main` yet (PR #7 is open).
- The retired scope `projects.contracts.read` in a leftover `SERVICE_CLIENTS` entry makes `auth`
  refuse to start. Intended; env-doctor's manifest and the env examples carry the new names (T35).

## Compliance notes

- GDPR / nLPD impact: none added by this ADR. The PO holds ids only — `referentContactId` is an
  opaque CRM id, never a name or contact detail (ADR-0063 records how the referent is read).
- Data residency: compliant — no new store or service; the same logical database `projects`.
- Audit trail: the PO and terms carry `createdById`, `version` and timestamps like every record
  of the module; nothing here is Tier 1 (ADR-0033).

Builds on ADR-0058 (amends its contract vocabulary, as above), ADR-0038 (`If-Match` on every
write), ADR-0060 (amended for the renamed route and scope) and ADR-0061 (estimate-backed man-days
are copied into the terms of a project whose PO carries an estimate id). Companion: ADR-0063
(`handoff:take`, `purchase-order:receive`, the holders listing, the referent).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
