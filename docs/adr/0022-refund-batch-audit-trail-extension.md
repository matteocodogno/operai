# 0022 — Batch audit trail as a direct extension of ADR-0018: new `AuditAction` values, `batchId` on `RefundAuditEntry`, no new immutability mechanism

**Date:** 2026-07-19
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

US-7 of `specs/008-refund-monthly-processing` requires that every compile, discard, and
mark-as-paid action be recorded immutably — "exactly as governable and accountable as the
approve/reject decisions that precede it (007 US-8)" — capturing the actor, timestamp, the batch,
and the full set of affected request IDs (AC-7.1), with the same "cannot be edited or deleted by
any user, including `accounting`/`refund-admin`/`admin`" guarantee (AC-7.2) 007 already gives
request-level audit entries. AC-7.3 goes further than 007's original scope: a request's
batch-membership history must remain permanently attached to its audit history even after the
batch that once held it is discarded and the request is later re-included in a different batch —
directly depending on ADR-0020's `RefundBatchItem` (the append-only membership record) existing
alongside the live `batchId` claim pointer.

`RefundAuditEntry` and its enforcement mechanism already exist, built exactly for this purpose:
ADR-0018 gave `refund-api` a dedicated, append-only table, made physically immutable by a
database-level `BEFORE UPDATE/DELETE` trigger (not merely an absent application route), combined
with `onDelete: Restrict` retention, and explicitly named itself "the pattern for future
financial/governance records in the suite." This spec's Constraints section confirms the
expectation directly: "this feature's new audited actions … are expected to reuse that same
enforcement mechanism, not a new one." The only open question this ADR resolves is the *shape* of
the extension — new action values, a new nullable relation, and how per-request granularity for a
batch-wide action is represented — not whether to build a second audit mechanism.

## Decision

We will extend the existing `RefundAuditEntry` table and its ADR-0018 immutability trigger with
three new `AuditAction` values and a nullable `batchId` foreign key, writing **one row per
affected request per batch action** inside the same transaction as the action itself — introducing
no new table, no new trigger, and no new retention rule.

1. **Three new `AuditAction` values:** `batch_compiled`, `batch_paid`, `batch_discarded`, added
   alongside 007's existing `submitted`/`withdrawn`/`approved`/`rejected`/`approved_total_set`.
   `batch_paid` is specifically the per-request `approved → paid` transition record (AC-7.1's
   explicit callout), mirroring how 007's `approved`/`rejected` rows already record the
   request-level decision transition.
2. **`RefundAuditEntry.batchId`** — a new nullable FK to `RefundBatch`, set on the three new
   batch-action rows and left `null` on every existing 007 action (which has no batch to
   reference). `RefundBatch` gets a reciprocal `auditEntries` relation. `onDelete: Restrict` on
   this new FK (matching the existing `requestId` FK's `Restrict` behavior from ADR-0018) means a
   `RefundBatch` with any audit history is as physically undeletable as a request with audit
   history already is.
3. **One row per affected request, not one row per batch.** `writeAuditEntry` is extended to
   accept an optional `batchId`, and each batch action (compile, mark-paid, discard) writes one
   `RefundAuditEntry` row **per request it affects**, inside the same database transaction as the
   state change itself (compile's claim transaction, mark-paid's CAS transaction, discard's CAS
   transaction — all three already transactional per ADR-0020). This directly matches 007's
   existing per-line/per-request audit granularity (ADR-0018 decision point 1) rather than
   introducing a coarser one-row-per-batch-event shape. AC-7.1's "the full set of request IDs
   affected" is then simply the set of rows sharing a given `(batchId, action)` pair — no separate
   summary/manifest column or JSON array is needed to answer that query.
4. **No new immutability mechanism.** The existing `BEFORE UPDATE/DELETE … RAISE EXCEPTION`
   trigger on `RefundAuditEntry` (ADR-0018) applies to every row in the table, including these new
   ones, with zero migration changes to the trigger itself — a new column and new enum values do
   not require re-declaring or re-scoping a trigger defined at the table level. AC-7.2's "immutable
   to any user, including `admin`" holds for batch rows exactly as it already does for request
   rows, verified by the same class of direct-SQL adversarial test ADR-0018 already established.
5. **Permanent retention rides on `RefundBatchItem`, not on the audit table alone.** AC-7.3's
   "permanently attached even after discard and re-inclusion" is satisfied by the combination of
   this audit extension (which records that batch action happened, tied to `batchId` +
   `requestId`) and ADR-0020's `RefundBatchItem` (which independently, and separately, records
   that the request was ever a member of that batch, surviving the batch's own `discarded`
   transition). Both together — not the audit table alone — answer "which batches has this
   request ever been in and what happened in each."

## Options considered

### Option A — Extend `RefundAuditEntry` in place: new enum values + nullable `batchId`, one row per affected request, reused trigger (chosen)

Described above.

**Pros:**
- Zero new immutability infrastructure — the exact database-level trigger and `onDelete:
  Restrict` guarantee ADR-0018 already proved out for 007's audit rows applies unchanged to these
  new rows, with no second mechanism to independently verify or maintain
- Matches 007's existing per-request audit granularity exactly, so "the full set of affected
  request IDs" (AC-7.1) is a plain query (`WHERE batchId=:B AND action=:A`), not a derived or
  denormalized summary that could drift from the underlying rows
- Realizes ADR-0018's own stated intent — "the pattern for future financial/governance records in
  the suite" — on its very first opportunity to be reused, rather than that framing going untested

**Cons:**
- A single batch action now produces N audit rows (one per affected request) rather than one
  summary row per action — a batch of, say, 40 requests generates 40 `batch_compiled` rows on
  compile, which is more rows than a single-event-per-action model would, though this exactly
  mirrors how 007 already records per-request/per-line events rather than one row per HTTP call
- The nullable `batchId` column is unused (always `null`) on every pre-008 action type, a small
  permanent schema footprint on rows that will never reference it

### Option B — One summary audit row per batch action, with a JSON array of affected request IDs (rejected)

Write a single `RefundAuditEntry` row per compile/mark-paid/discard event, with `detail: Json`
holding the full list of affected request IDs.

**Pros:**
- Fewer rows written per action — one instead of N

**Cons:**
- Breaks from 007's established per-request audit granularity (ADR-0018 decision point 1) for no
  stated benefit, introducing two different audit shapes (per-request rows for
  submit/withdraw/approve/reject, per-event-with-a-JSON-array rows for batch actions) a future
  reader must keep straight
- Makes "which specific requests were affected by this action" a JSON-array query/deserialization
  rather than a plain relational `WHERE` clause — a worse fit for the kind of ad hoc governance
  query (a request's own audit history, a specific batch's full row set) this table exists to
  support
- Rejected: optimizes row count at the cost of query shape and consistency with the table's
  existing design, for a table whose row count was never the plan's stated concern

### Option C — A separate, dedicated `RefundBatchAuditEntry` table, distinct from `RefundAuditEntry` (rejected)

Introduce a new table specifically for batch-level events, parallel to but independent of the
existing request-level audit table.

**Pros:**
- Would keep the two domains (request-level events, batch-level events) in structurally separate
  tables, if that separation were ever independently valuable

**Cons:**
- Requires re-declaring the exact same `BEFORE UPDATE/DELETE` immutability trigger a second time,
  on a second table — literally the "new mechanism" the spec's Constraints section and ADR-0018's
  own stated intent both explicitly said not to build
- A request's full audit history would now be split across two tables (its own submit/decide
  rows in one, its batch-membership rows in another) for no query or domain benefit — a request's
  audit trail is one coherent history, and US-7 explicitly compares batch actions to 007's
  existing decision-audit precedent, not to a separate concept
- Rejected: directly contradicts the spec's Constraints and duplicates a proven mechanism for no
  benefit

### Option D — No `batchId` column; recover batch association only via a join through `RefundBatchItem` (rejected)

Skip the new FK entirely; infer which batch an audit row relates to by joining
`RefundAuditEntry.requestId` against `RefundBatchItem` and matching on the row's `createdAt`
falling within a batch's lifecycle window.

**Pros:**
- One fewer column on `RefundAuditEntry`

**Cons:**
- A timestamp-window join is fragile and ambiguous the moment a request is ever re-included in a
  second batch after a discard (exactly the AC-7.3 scenario this feature must handle correctly) —
  two candidate batches could both have overlapping windows around the same request, with no
  reliable way to disambiguate which action's row belongs to which batch without an explicit key
- Directly undermines AC-7.1's requirement that an audit entry capture "the batch" as a concrete,
  unambiguous fact, not something reconstructed by inference
- Rejected: trades a trivial schema addition for a genuinely unreliable query, for no real benefit

## Consequences

**Positive:**
- ADR-0018's core guarantee — immutable to any user including `admin`, DB-enforced, not merely
  route-absent — extends to every new batch-scoped audit action with zero new trigger code to
  write, review, or independently verify
- AC-7.1's "full set of affected request IDs" and AC-7.3's "permanently attached even after
  discard and re-inclusion" are both answerable with plain relational queries against existing,
  already-tested retention (`onDelete: Restrict`) and membership (`RefundBatchItem`) machinery
- Validates ADR-0018's own explicit design intent — a reusable pattern for future
  financial/governance records — on its first real reuse opportunity, strengthening confidence in
  applying it again to whatever the suite's next financial feature turns out to be

**Negative / trade-offs:**
- Per-request row volume for batch actions (N rows for an N-request batch, per action) is higher
  than a single-summary-row design would produce, an accepted consistency-over-row-count trade-off
  matching 007's own existing granularity
- The `batchId` column sits permanently `null` on every pre-008 audit action type — a small,
  permanent piece of schema surface unused by most rows in the table

**Risks:**
- **Migration correctness remains the single point of failure it already was under ADR-0018.**
  Because this decision reuses the existing trigger unchanged, a migration mistake affecting that
  trigger (accidentally dropped, altered, or scoped differently) would silently weaken both 007's
  and 008's audit guarantees together, not just this feature's. Mitigation: this migration adds
  only the enum values and the `batchId` column/FK — it does not touch the trigger definition at
  all, minimizing the surface for such a mistake; adversarial coverage (AC-7.2: direct SQL
  `UPDATE`/`DELETE` against a batch-scoped row fails) is named explicitly in the plan's test map.
- **Row-volume growth on `RefundAuditEntry` from batch actions**, over time, at a scale
  proportional to (requests per batch) × (compile+mark-paid+discard events) rather than to
  request count alone. Mitigation: not addressed by this ADR — the table's indefinite retention
  (ADR-0018) already accepted unbounded growth as a deliberate financial-record-keeping trade-off;
  a future indexing/partitioning need, if it arises, is an operational concern independent of this
  decision's shape.
- **`onDelete: Restrict` on the new `batchId` FK could, in principle, block a hypothetical future
  batch-deletion path** the same way it already blocks request deletion. Mitigation: no delete
  route for `RefundBatch` exists or is planned (batches are only ever discarded, never deleted,
  per US-6/Non-goals) — this mirrors, rather than introduces, the existing request-side posture.

## Compliance notes

- GDPR/nLPD impact: low-to-medium — batch audit rows record actor identity and which requests
  (and, transitively via `RefundBatchItem`, which employees) were affected by a money-moving
  action, necessary for the same governance/accountability purpose ADR-0018 already established
  for request-level decisions; retained indefinitely by design, consistent with financial
  record-keeping expectations for a process reaching an employee's paycheck.
- Data residency: unaffected — all new columns and rows live in `refund-api`'s existing EU-region
  PostgreSQL database, on the same table ADR-0018 already placed there.
- Audit trail: this ADR **is** the audit-trail decision for US-7, delivered as a direct,
  same-mechanism extension of ADR-0018 rather than a new one — distinct from, and not a
  replacement for, ADR-0007's `auth`-domain `audit_log`, which continues to cover
  authorization-configuration changes only.

This decision is a **direct extension of ADR-0018** (same table, same DB-level immutability
trigger, same `onDelete: Restrict` retention discipline, reused verbatim rather than
re-implemented) and depends on ADR-0020's `RefundBatch`/`RefundBatchItem`/`BatchStatus` design for
the entities its new `AuditAction` values and `batchId` column reference. It is deliberately kept
as its own ADR, separate from ADR-0020, per the plan's ADR-candidate breakdown, even though the
two are tightly coupled and were designed together.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
