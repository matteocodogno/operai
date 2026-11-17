# 20261117 — The legal-entity registry lives in auth as append-only versions (current = highest) that are immutable in the database, the first Tier 1 table in auth, read through the scope `legal-entities:read`

**Date:** 2026-11-17  
**Status:** Accepted — approved plan of specs/20261117-legal-entities (approved 2026-11-17); owner decisions AC-3.1 (any signed-in person reads), OQ-2 (IBAN check digits) and the constraint that auth owns the registry. Plan ADR candidate ADR-1.  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

The legal details of welld_it and welld_ch (legal name, address in two languages, VAT number, IBAN, contacts line) print on every offer and contract, and today exist only in the CRM's entity profile. specs/20261117-legal-entities moves them to one registry, owned by `auth` (owner constraint), with a history that shows who changed what and lets a person restore an older version (AC-2.1 to AC-2.7). Changing one value, the IBAN, redirects payments on every document of the suite within 60 seconds (plan Risks, R1; Security). The registry's versions are therefore governance and financial records, which ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level assigns to Tier 1 (database-level immutability) and which it kept out of `auth`'s `audit_log`, a Tier 2 table. No table in `auth` is Tier 1 today. The registry also needs a service scope for the tools that read it; `crm.companies.read` already exists for the CRM's customers (`auth/src/system/serviceClients.ts`), and the spec chose the word "legal entity" so it is never confused with them.

## Decision

We will keep the registry in `auth` as one append-only table, `legal_entity_version`, with one row per version of one entity (current = the highest version, no "current" pointer, no mutable row), refuse `UPDATE`, `DELETE` and `TRUNCATE` on it with raising triggers (Tier 1, the first in `auth`), serve it through two routes with one serializer (`GET /legal-entities*` for any signed-in person, `GET /system/legal-entities*` for a service JWT holding the scope `legal-entities:read`), and name the scope without a service prefix and in the colon form.

(Plan, Key decisions 1, 2 and 3; Data model.)

1. **Table.** A save or a restore inserts version n+1 under `pg_advisory_xact_lock(hashtext('legal_entity:' || entity))`; the primary key is `(entity, version)`; details are typed columns, not JSONB; `changedFields` is stored at insert (the row never changes, so it is never recomputed). CHECK constraints fix the entity set, `version >= 1`, the action (`import`, `save`, `restore`), `import` only as version 1 by the system, and `restore` if and only if `restoredFrom` is set and lower than the version. The two entities are one constant, `LEGAL_ENTITIES`.
2. **Immutability at the database.** A row trigger `BEFORE UPDATE OR DELETE` and a statement trigger `BEFORE TRUNCATE` both raise `legal_entity_version_immutable`. The actor columns (`createdByUserId`, `createdByName`) are plain columns with no foreign key, the `User.deletedByUserId` convention, because a foreign-key `SET NULL` is itself an `UPDATE`. No route with PUT, PATCH or DELETE exists under `/legal-entities`, and a static scan finds no mutating call on the model in `auth/src` (the audit tripwire's pattern). A restore creates a new version; it never edits one.
3. **Audit.** `audit_log` (Tier 2, unchanged) still receives one row per import, save and restore, written in the same transaction through `withAudit`. It is a convenience record; the history that matters is the versions table.
4. **Two read routes, one serializer.** Same handler body and serializer, so the person and the service get byte-identical answers (a contract test compares bytes). Not one route for two credential families: `/system/*` stays service-JWT-only with its per-service rate limits (ADR 20261112-system-endpoints-limited-per-verified-service). What a person may do (`canManage`) is not in the details answer; it is `GET /legal-entities/manageable`. Validation lives in `auth` only; the answer carries `complete` and `missing`, so no consumer re-implements the rule.
5. **Scope naming rule.** A scope for a suite resource that `auth` hosts carries **no service prefix** (the host is an implementation detail, unlike `crm.companies.read`, which names the service that serves it) and uses the **colon form** (as `letterhead:render` and the person permission `legal-entity:manage`). The vocabulary is the resource's own word, chosen so it cannot be read as another resource: `legal-entities:read`, not `companies:read` (the request's first name for it). Holders: `crm-api` (added to its client) and `letterhead-api` (a new client). The scope is added to `KNOWN_SERVICE_SCOPES`; `auth` refuses to start with an unknown scope in `SERVICE_CLIENTS` (`parseServiceClients`), which fixes the release order (plan, Release order, steps 1 and 2).

## Failure shape

**A record that people rely on to prove what was true, and to roll back to, is protected only by the absence of a way to change it, or its history is rebuilt from a weaker record kept beside it.** "No route edits it" holds against the application as written; it does not hold against a migration, an ad hoc query, a script that resets state, a foreign-key action or a future admin tool. A "current" value stored as a mutable row, with its past reconstructed from a log, is as weak as that log: the history has to be parsed back out of audit JSON, and anyone who can change the row changes what is current without a version to point at. The legal identity printed on documents, IBAN included, is exactly such a record.

A second failure sits in the naming: **two resources given names that differ by one word, so a grant or a call meant for one reaches the other.** A scope called `companies:read` beside `crm.companies.read` is a grant that a reader cannot tell apart from the CRM's customers.

Where else this shape appears:

- **Update and delete, row and statement.** `BEFORE UPDATE OR DELETE` does not fire on `TRUNCATE`, which needs only ordinary table rights; the statement trigger is part of the decision. `DROP TABLE` and a superuser who disables triggers are not covered (see Risks).
- **Write and read.** The write side is the trigger; the read side is every copy: a consumer's cache, an export, the `audit_log` row holding before and after values. A copy treated as the source of truth reintroduces the failure; the consumers' cache is bounded for that reason (ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds).
- **Undo, revert, restore, rollback** over any protected record: the mirror-image operation must append (restore 2 when 4 is current creates 5 equal to 2), never rewrite.
- **A side effect that is itself a write.** A foreign key with `ON DELETE SET NULL` or `CASCADE`, a column default changed by a migration that touches every row (`ADD COLUMN … DEFAULT` fires no row trigger, which is what keeps a future detail cheap), a "normalise" job.
- **The people who test it.** Tests that clean tables by deleting rows cannot clean this one; they run in a rolled-back transaction or on a database made per file (plan R10). A new test that deletes from the table is the failure arriving in the test suite.
- **Another resource with a similar word.** Any new scope or permission in a suite resource hosted by one service and used by many: recognise the shape by asking whether its name could be mistaken for an existing one, and whether it names the host (which can move) or the resource (which cannot).

## Options considered

### Option A — Append-only versions table in `auth`, raising triggers, two read routes with one serializer (chosen)

Described above.

**Pros:**
- Holds against every path to the database, not only those the application knows (the reason ADR 20260716-immutable-financial-audit-trail-refund gave); the pattern exists in the repo, so a reviewer knows what to look for
- History is the table itself: whole versions, not diffs parsed from audit JSON (AC-2.3 needs whole versions)
- Typed columns give typed diffs and CHECKs, and a future detail is one `ADD COLUMN … DEFAULT`
- "The same answer" for person and service holds by construction

**Cons:**
- A wrong save cannot be corrected, only superseded by a newer version, and a mistaken IBAN stays in the history for good
- The first Tier 1 table in `auth`: test data cannot be deleted row by row
- Every consumer must read the version it prints (the pin, in the ADR on the letterhead service)

### Option B — A mutable `legal_entity` row, with `audit_log` as the only history (rejected)

**Pros:**
- Smallest change; `audit_log` already exists

**Cons:**
- History would depend on a Tier 2 table (ADR 20260804 keeps `audit_log` at application-level immutability) and on parsing audit JSON; AC-2.3 needs whole versions

### Option C — JSONB details per version (rejected)

**Pros:**
- A new detail needs no migration

**Cons:**
- Opaque rows that would need a schema version inside them; columns give typed diffs and checks

### Option D — Raise `audit_log` to Tier 1 instead (rejected)

**Pros:**
- One audit mechanism

**Cons:**
- Its `actorUserId` foreign key carries `ON DELETE SET NULL`, an `UPDATE` the trigger would abort (ADR 20260804, decision point 3); it is not touched by this decision

### Option E — One route accepting both credential families (rejected)

**Pros:**
- One handler to register

**Cons:**
- Mixes person and service credentials on one route, which the letterhead plan's separate routers avoided; loses the per-service limits of `/system/*`

### Option F — Scope named `companies:read` or `crm.legal-entities.read` (rejected)

**Pros:**
- Matches the request's wording or the existing prefixed form

**Cons:**
- `companies:read` sits next to `crm.companies.read` (customers), the exact confusion the spec forbids; a service prefix would name `auth`, an implementation detail of a suite resource

## Evidence

- Pattern: `refund-api/prisma/migrations/20260716133804_init/migration.sql:129-142` (ADR 20260716-immutable-financial-audit-trail-refund); the same trigger plus a statement-level `TRUNCATE` trigger in `letterhead-api` (ADR 20261116-letterhead-versions-assets-and-change-record-are-immutable-in-the-database, Amendment 2026-11-17).
- Planned, not yet run (plan, Test strategy, AC-2.7 and AC-3.2): A-int against compose Postgres: raw `UPDATE`, `DELETE` and `TRUNCATE` of `legal_entity_version` raise `legal_entity_version_immutable`; a router-table test shows no PUT, PATCH or DELETE under `/legal-entities`; the person and service bodies are byte-equal; a service JWT without the scope, a person JWT, a wrong audience and an expired token all get the one frozen 401. The audit tripwire `auth/src/authz/audit-immutability.contract.test.ts` must still pass.
- The test must run against real Postgres, not a mock: the guarantee is a property of the database.

## Consequences

**Positive:**
- Every version of the legal identity that a document printed can be read back, whole, and cannot be changed by any path to the database that fires the triggers
- A restore is a normal save of older details, so it appears in the history and the audit log like any other change
- A tool that needs the group's legal details reads one registry through one scope, without depending on the CRM

**Negative / trade-offs:**
- A wrongly saved version cannot be removed, only superseded
- Integration tests of the registry need a rolled-back transaction or a per-file database; nothing may clean the table by deleting rows
- `audit_log` now holds IBAN before and after values at Tier 2 (admin-only read); it is not the record of truth

**Risks:**
- **Row and statement triggers do not stop `DROP TABLE` or a superuser disabling the triggers.** Same limit as the refund trail and the letterhead tables. Only the migration path and a person with production database access hold such rights; Railway backups cover disaster recovery.
- **A future migration forgets the triggers on a new table meant to be permanent.** Mitigation: the real-Postgres refusal test is the place to add it.
- **Payment redirection (plan R1).** Whoever may change an IBAN changes where clients pay. Mitigations in the plan: per-entity permission, administrator-only seed, this history, audit before and after, restore. A notification to other managers when an IBAN changes is recommended to the owner and is outside this decision.
- **Any signed-in person reads the IBAN** (owner decision AC-3.1). Flagged to the security review.
- **An unknown scope stops `auth`** (R6): credentials are set only after the `auth` push that knows the scope is live.

## Escalation triggers

This decision is revisited when any of these happens:

- a third legal entity is needed (the CHECK, `LEGAL_ENTITIES` and `ENTITY_VALUES` in `auth/src/admin/users.routes.ts` change together, by a migration);
- someone needs to correct or remove a stored version (a legal request, an erasure that reaches `createdByName`): the owner decides, and the path is a reviewed migration, never a loosened trigger;
- a second kind of caller is given database access to the `auth` database;
- another suite resource hosted by `auth` needs a service scope: apply the naming rule, and amend this ADR if it does not fit.

## Compliance notes

- GDPR / data-protection impact: low. The details are a company's (legal person); the contacts line may name a person or a direct number. `createdByName` and `createdByUserId` identify the staff member who saved a version and cannot be erased through the service; an erasure request reaching them needs an owner decision (see triggers). No new retention beyond permanence of the versions.
- Data residency: compliant, provided `auth`'s Postgres stays in the EU region the suite already uses (see AGENTS.md, Data residency); the registry adds no store outside it.
- Audit trail: required (AC-2.2, AC-2.5). Tier 1 for the versions; `audit_log` (Tier 2) in addition.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
