# 0018 — Immutable financial audit trail: append-only table, DB-level write-block, and `onDelete: Restrict` retention for decided requests

**Date:** 2026-07-16
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

US-8 of spec `specs/007-refund-service` requires that every accounting decision on a refund
request — and the state transitions leading to it — be recorded immutably: not merely "no UI
exists to edit it," but genuinely unmodifiable, "including to `accounting` or `admin`" (AC-8.2),
and that a request which has reached a decided state (`approved`/`rejected`) can never be
deleted, audit history and all (AC-8.3). This is the plan's first genuinely financial,
governance-grade retention requirement in the suite. ADR-0007's `audit_log` already exists
inside `auth`, but records a structurally different domain — role/permission/department
mutations, not application business events — and living inside `auth`'s own database would
require `refund-api` to write cross-service into another service's schema, breaking the
resource-server-owns-its-own-database boundary every Operai backend follows (ADR-0005).
`refund-api` needs its own domain audit mechanism, and given the financial/regulated-sector-
adjacent weight the plan's Security section calls out, "no application code path exists to
mutate it" is judged insufficient on its own — the plan calls for defense-in-depth at the
database layer, not just the absence of a route.

## Decision

We will add a dedicated, append-only `RefundAuditEntry` table, made physically immutable by a
database-level rule/trigger blocking `UPDATE` and `DELETE` — not merely the absence of an
application route — combined with `onDelete: Restrict` from `RefundAuditEntry` to
`RefundRequest`, so that any request with audit history (every request that ever reached
`submitted` or beyond) cannot be deleted at all.

1. **`RefundAuditEntry` is its own table** in `refund-api`'s own database
   (`requestId`, `lineId?`, `actorUserId`, `actorEmail`, `action`, `detail: Json?`, `createdAt`),
   written once per state-relevant event — `submitted`, `withdrawn`, `approved`, `rejected`,
   `approved_total_set` — inside the same transaction as the event it records (AC-8.1). This is a
   domain audit shape drafted specifically for refund (actor/timestamp/what changed, including
   the rejection motivation where applicable), not a reuse of ADR-0007's auth-domain `audit_log`.
2. **Database-level immutability, not just an absent route.** The `0001_init` migration adds a
   raw-SQL rule or trigger directly on the table
   (`CREATE RULE refund_audit_no_update AS ON UPDATE TO "RefundAuditEntry" DO INSTEAD NOTHING;`,
   mirrored for `DELETE`, or an equivalent `BEFORE UPDATE/DELETE … RAISE EXCEPTION` trigger).
   `refund-api` additionally exposes **no** update/delete route for audit rows at the application
   layer. The two together are deliberate defense-in-depth: the application-layer omission
   protects against a bug or a future well-intentioned "admin cleanup" endpoint being added by
   mistake; the database rule protects against direct SQL access (a migration mistake, an ad hoc
   production query, a future internal tooling script, a disaster-recovery restore) that the
   application layer can't see at all.
3. **`onDelete: Restrict`, not `Cascade`, from `RefundAuditEntry` to `RefundRequest`.** Combined
   with the route guard that only ever permits `DELETE /requests/:id` while `status == draft`
   (409 otherwise), this means: a draft request — which has no audit rows yet, since nothing
   audit-worthy has happened to it — can still be deleted, cascading its lines and attachments
   normally. Any request that ever transitioned past `draft`, and therefore has at least one
   audit row, becomes physically undeletable at the database level the instant that first row
   exists, independent of and in addition to the application-level status guard (AC-8.3).
4. **Attachment retention follows the request, not a separate policy.** Attachment objects are
   deleted only on explicit draft-time removal (AC-1.3, ADR-0016's lifecycle); once a request is
   decided, its attachments are retained alongside its now-immutable audit trail, never
   garbage-collected by this feature.
5. **Named explicitly as a reusable pattern, not a one-off.** The plan frames this as "the
   pattern for future financial/governance records in the suite" — any future Operai feature
   needing an immutable, retained history of decisions (a future payroll-compilation record,
   another approval workflow) should reuse this exact shape — append-only table, DB-level
   write-block, `Restrict` retention — rather than inventing a new one.

## Options considered

### Option A — Dedicated append-only table + DB-level rule/trigger + `onDelete: Restrict` (chosen)

Described above.

**Pros:**
- AC-8.2's "immutable even to admin" is satisfied at the strongest layer available (the database
  itself), not merely by omission of a route — a direct-SQL access attempt fails the same way an
  API call would
- AC-8.3's retention guarantee is enforced twice, independently: the application-level status
  guard and the database-level `Restrict` constraint — a bug in either layer alone does not
  compromise retention
- Establishes a concrete, reusable pattern for every future financial/governance record in the
  suite, named explicitly in the plan
- Cleanly separates refund's own domain audit trail from `auth`'s authorization-change
  `audit_log` (ADR-0007) — each service owns the audit mechanism for its own domain's events,
  consistent with the resource-server-owns-its-own-data convention (ADR-0005)

**Cons:**
- A genuine data-correction need (e.g. a typo caught after the fact in an audit `detail` JSON)
  has no remediation path short of a manual, out-of-band database intervention explicitly
  bypassing the DB-level protection
- The DB-level rule/trigger lives in raw SQL inside the migration, outside Prisma's own
  schema-modeling vocabulary — it must be maintained by hand and is easy to overlook when
  reasoning about the schema from `schema.prisma` alone

### Option B — Application-layer-only enforcement, no database-level rule (rejected)

Omit update/delete routes for audit entries; rely solely on "no code path exists to mutate it."

**Pros:**
- Simpler migration — no raw SQL, no rule/trigger to maintain by hand

**Cons:**
- Insufficient defense-in-depth for financial/audit data given the plan's own security
  weighting — "no route exists" only protects against the application's own HTTP surface, not a
  direct-SQL path (a migration error, an ad hoc production query, future internal tooling, a
  disaster-recovery restore) — exactly the class of access AC-8.2's "cannot be edited or deleted
  by **any** user, including `accounting` or `admin`" is written broadly enough to cover
- Rejected: does not meet the plan's stated bar for a financial audit trail

### Option C — Reuse ADR-0007's `auth`-service `audit_log` table for refund's audit entries (rejected)

Write refund's request/line-level audit events into `auth`'s existing authorization-change
`audit_log` table.

**Pros:**
- Zero new table; one audit story for the whole suite

**Cons:**
- That table lives in `auth`'s own database and schema, scoped to authorization-domain events
  (role/permission/department mutations) — writing refund's request/line-level events into it
  would require `refund-api` to reach across a service boundary into another service's database,
  violating the resource-server-owns-its-own-data pattern every other Operai backend follows
  (ADR-0005)
- Would force refund's audit rows to fit a schema shaped for a different domain — no natural
  `requestId`/`lineId` foreign key, and no relation to `RefundRequest` for the `Restrict`-
  retention mechanism to hang off of
- Rejected: crosses an established service boundary for no real benefit, and doesn't fit the
  domain shape

### Option D — Soft-delete/versioning for audit entries, mirroring specs/006's User soft-delete (rejected)

Give audit rows a `deletedAt` (or a superseding-row model) instead of a hard write-block.

**Pros:**
- Reuses a pattern the suite already has (specs/006's soft-deleted `User`), rather than
  introducing a new immutability mechanism

**Cons:**
- Soft-delete still permits an `UPDATE` (setting `deletedAt`) and, depending on implementation,
  could still allow other columns to change — AC-8.2 requires the row cannot be edited or deleted
  **at all**, a strictly stricter bar than "hidden but technically still mutable"
- Soft-delete is the right shape for `User` specifically because a user's *other* fields
  legitimately keep changing after deletion (specs/006) — the opposite of what an audit row needs
- Rejected: does not meet AC-8.2's immutability bar

### Option E — `onDelete: Cascade`, relying only on the application-level status guard for retention (rejected)

Drop the `Restrict` constraint; rely solely on the route guard (`409` on non-draft delete) to
prevent deletion of decided requests.

**Pros:**
- Simpler foreign-key relationship, no database-level delete failure mode to account for

**Cons:**
- Makes AC-8.3's retention guarantee depend entirely on the application-layer route guard never
  having a bug or a bypass (e.g. a future admin superuser route, a bulk-cleanup script) — the
  same defense-in-depth reasoning as Option B's rejection, applied to deletion rather than
  mutation
- Rejected: `Restrict` makes the guarantee hold at the database level even if a future code path
  forgets to check status first

## Consequences

**Positive:**
- AC-8.2 and AC-8.3 are both enforced at the strongest available layer, not merely by the
  absence of a route — a direct-SQL access attempt fails identically to an API call
- Establishes a concrete, reusable pattern (append-only + DB-level write-block + `Restrict`
  retention) for every future financial/governance record in the suite, avoiding each future
  feature inventing its own immutability approach from scratch
- Cleanly separates refund's own domain audit trail from `auth`'s authorization-change
  `audit_log`, keeping each service's audit mechanism scoped to its own domain's events

**Negative / trade-offs:**
- No remediation path exists for a genuine data-correction need short of a manual, out-of-band
  database intervention that explicitly bypasses the DB-level protection — an accepted cost of
  "immutable" actually meaning immutable
- The DB-level rule/trigger is maintained by hand in raw SQL, outside Prisma's schema vocabulary,
  and easy to overlook when reasoning about the schema from `schema.prisma` alone
- Two distinct immutability mechanisms (the DB rule/trigger, and `onDelete: Restrict`) must both
  be correctly wired in the same migration for the guarantee to hold end to end — a partial
  migration would silently weaken US-8 with no application-level symptom until specifically
  tested for

**Risks:**
- **Migration correctness is a single point of failure for both guarantees.** If `0001_init`
  ships without the rule/trigger, or with `onDelete` left at Prisma's default (`Cascade`) instead
  of `Restrict`, both AC-8.2 and AC-8.3 silently fail with no application-level signal — every
  ordinary path would still appear to work correctly. Mitigation: dedicated integration tests
  asserting a direct SQL `UPDATE`/`DELETE` against `RefundAuditEntry` fails, and that `DELETE` on
  a request with audit rows fails, both named explicitly in the plan's test map (AC-8.2, AC-8.3);
  the project convention of never modifying an applied migration keeps this guarantee stable once
  shipped.
- **`CREATE RULE` vs. trigger choice affects behavior under bulk/direct operations.** PostgreSQL
  rules rewrite the query at parse time and can behave unexpectedly compared to a row-level
  `BEFORE` trigger raising an exception; a rule silently doing nothing (`DO INSTEAD NOTHING`) is
  less visible in logs/tests than a trigger that raises. Mitigation: prefer a `BEFORE
  UPDATE/DELETE` trigger that `RAISE EXCEPTION`s over a silent rule, so any inadvertent write
  attempt fails loudly rather than being silently no-op'd — decided at implementation time.
- **Prisma schema drift.** Because Prisma has no native trigger syntax, a future database
  reset/recreate from `schema.prisma` alone (rather than through the migration history) could
  silently omit the protection. Mitigation: the trigger lives only in the versioned migration
  file (never hand-run ad hoc); CI/deploy always applies migrations, never a schema push.

## Compliance notes

- GDPR/nLPD impact: low-to-medium — audit entries record actor (`userId`/`email`) and financial
  amounts/decisions, necessary for governance/accountability of a financial process; retained
  indefinitely by design (no delete path), consistent with typical financial record-keeping
  expectations for a process that reaches an employee's paycheck; no special-category data is
  stored in the audit `detail` beyond what the request itself already carries.
- Data residency: unaffected — `RefundAuditEntry` lives in `refund-api`'s own EU-region
  PostgreSQL database, same as every other `refund-api` table.
- Audit trail: this ADR **is** the audit trail decision — required by US-8 and delivered as
  described; distinct from, and not a replacement for, ADR-0007's auth-domain `audit_log`, which
  continues to cover authorization-configuration changes only.

This decision builds on ADR-0005 (the resource-server-owns-its-own-database pattern this ADR
follows rather than reusing `auth`'s `audit_log`), ADR-0007 (the suite's only prior audit-trail
precedent, whose domain and database boundary this ADR deliberately does not cross), and
ADR-0013 (the suite's schedulerless-lifecycle discipline — while not directly reused here, since
audit immutability is a permanent database constraint rather than a derived read-time state, the
same "no periodic job for correctness" posture holds: the DB rule/trigger is always-on, never
enforced by a sweep).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
