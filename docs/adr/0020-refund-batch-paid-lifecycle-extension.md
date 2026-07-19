# 0020 — `RefundBatch` + terminal `paid` status: supersedes the 007 "no fifth `RefundStatus` value" freeze, live-claim vs. immutable-membership split, atomic claim/terminal CAS

**Date:** 2026-07-19
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/007-refund-service` shipped `RefundRequest.status` as a four-value `RefundStatus` enum
(`draft`/`submitted`/`approved`/`rejected`) and its Prisma schema carries an explicit code
comment freezing it there: *"draft|submitted|approved|rejected only … Do not add a fifth value
here."* No dedicated ADR was written for that freeze at the time — it lived only as a schema
comment — but ADR-0018 (007's immutable audit-trail ADR) was built directly on top of that
four-value assumption: its audit granularity, its `onDelete: Restrict` retention rule, and its
"a decided request is exactly as immutable as approved/rejected" framing all implicitly treat
`approved`/`rejected` as the lifecycle's terminal states. `specs/008-refund-monthly-processing`
now requires a genuinely new terminal state: `paid`, set the instant a compiled batch of
approved requests is confirmed as having actually gone through payroll (US-4, AC-4.1). This
spec's Constraints section explicitly flagged the freeze as a fact the plan stage — not the spec
stage — had to resolve.

Separately, the spec requires a new aggregate concept the schema has no room for: a
**compilation batch** — a frozen set of requests as of a chosen cutoff, tied to one generated PDF
(ADR-0019), that must (a) prevent the same request from ever landing in two simultaneously-live
batches (AC-1.2/1.5, no double-pay), (b) allow a batch to be voided pre-payment with its requests
released back to the eligible pool (US-6), and (c) retain a permanent record of which requests
were ever in a batch even after that batch is discarded and its requests re-included in a later
one (AC-6.3/7.3). A single foreign key on `RefundRequest` cannot satisfy both "tells me who
currently holds this request" and "tells me every batch this request has ever been in," because
the former must be overwritten on release-and-reclaim while the latter must never be.

## Decision

We will (1) **supersede the 007 "no fifth value" freeze** by adding `paid` as the fifth,
terminal `RefundStatus` value, updating the schema comment to cite spec 008 as the reason the
freeze no longer holds; and (2) introduce a `RefundBatch` entity with its own three-value
`BatchStatus` (`compiled`/`paid`/`discarded`), using **two distinct membership representations**
— a live, overwritable claim pointer and an append-only historical record — plus a
transaction-scoped **atomic claim** at compile time and a **terminal compare-and-swap** for both
of a batch's exit transitions.

1. **`RefundStatus` gains `paid` as its fifth, terminal value.** `paid` inherits immutability for
   free: 007's existing mutation guards already gate edits/deletes on `status == 'draft'` and
   decisions on `status == 'submitted'` — `paid` is neither, so no guard changes are required for
   AC-2.3-parity (verified against the `lines`/`lifecycle`/`decide` repos). The Postgres
   `ALTER TYPE … ADD VALUE` for `paid` is emitted as its own statement, before any dependent DDL
   in the same migration, because it cannot run inside the same transaction as other schema
   changes on older PostgreSQL — flagged explicitly in the migration file (plan Risk R6).
2. **`BatchStatus` is a new, separate three-value enum** (`compiled`/`paid`/`discarded`) — not a
   reuse or extension of `RefundStatus`. A batch and the requests inside it move through related
   but distinct state machines: a batch transitions `compiled → paid` or `compiled → discarded`,
   each exactly once and never reversed; its member requests transition `approved → paid` only on
   the batch's `paid` transition, or remain `approved` (unbatched again) on `discarded`.
3. **Two membership representations, deliberately not one.**
   - `RefundRequest.batchId` (nullable FK to `RefundBatch`) is the **live claim pointer** — "which
     batch currently holds this request, if any." `NULL` means eligible for a future compile; a
     non-null value means claimed by a `compiled` or `paid` batch. It is **nulled on discard**
     (US-6, AC-6.1) and can be **overwritten** by a later batch once released — so by design it
     cannot preserve history.
   - `RefundBatchItem` (new join table, `@@unique([batchId, requestId])`) is the **append-only**
     record that a request was *once* in a specific batch. It is never deleted, including through
     discard, giving AC-6.3 ("which requests a discarded batch once held") and AC-7.3 ("permanently
     attached even if later discarded and re-included in a different batch") a durable answer
     `batchId` alone cannot give. It is also the actual input set ADR-0019's PDF renderer reads
     from, so a discarded batch's PDF still resolves correctly (AC-1.10) even after its requests'
     live `batchId` has moved on. `onDelete: Restrict` on `RefundBatchItem → RefundRequest`
     additionally makes any once-batched request physically undeletable, extending 007's AC-8.3
     retention guarantee (ADR-0018) to batch-touched requests specifically.
4. **Atomic claim at compile time.** Compile runs inside one `db.$transaction`:
   `SELECT id FROM refund_request WHERE status='approved' AND "batchId" IS NULL AND
   "decidedAt" <= :cutoff [AND entity-scope] FOR UPDATE` locks the exact candidate rows, so two
   concurrent compiles serialize on those row locks — the second sees the first's claims (or an
   empty remainder) and claims only what's left. An `UPDATE … SET "batchId"=:B WHERE id IN (…)
   AND "batchId" IS NULL` immediately follows as an additional compare-and-swap belt. An empty
   locked set rolls the whole transaction back and creates nothing (AC-1.4 — no empty batch ever
   exists, not even transiently).
5. **Terminal compare-and-swap for mark-paid and discard.** Both use
   `UPDATE refund_batch SET status=… WHERE id=:B AND status='compiled'` — the `status='compiled'`
   predicate is what makes the transition happen exactly once; a `rowCount` of 0 means the batch
   already left `compiled` (already `paid` or `discarded`) and the caller gets 409 (AC-4.3/6.2).
   A concurrent mark-paid vs. discard race on the same batch resolves to exactly one winning CAS;
   the loser 409s deterministically, with no lost-update window.
6. **Mark-paid's request-side flip is in the same transaction as the batch CAS.**
   `UPDATE refund_request SET status='paid' WHERE "batchId"=:B AND status='approved'` runs
   atomically alongside the batch transition (AC-4.1, all-or-nothing) — every included request
   changes together, or the whole transaction rolls back and none do.
7. **Audit extension.** `RefundAuditEntry` gains a nullable `batchId` column and three new
   `AuditAction` values (`batch_compiled`/`batch_paid`/`batch_discarded`); this reuses ADR-0018's
   existing immutability trigger and `onDelete: Restrict` mechanism unchanged — recorded in full
   in ADR-0022, kept as its own ADR per the plan rather than folded into this one.

## Options considered

### Option A — Fifth `RefundStatus` value + `RefundBatch`/`RefundBatchItem` split + row-lock claim + status-predicate CAS (chosen)

Described above.

**Pros:**
- Reuses 007's existing immutability guards for `paid` at zero marginal code — the "gate on
  `draft`/`submitted`" shape already makes every other status, including a brand-new one,
  immutable by default
- The two-representation membership split gives both a correct dedup key (`batchId IS NULL`) and
  a correct permanent history (`RefundBatchItem`) without either concept compromising the other —
  a single FK genuinely cannot do both, since one must be overwritable and the other must not be
- Row-level locking (`FOR UPDATE`) plus a `WHERE batchId IS NULL` CAS gives no-double-claim without
  any application-level mutex, queue, or advisory lock — correctness lives entirely in the
  database's own concurrency control
- The `status='compiled'` predicate CAS gives exactly-once terminal transitions (mark-paid vs.
  discard) the same way, with no separate locking primitive needed for that race either

**Cons:**
- Explicitly reverses a documented, deliberately-worded freeze from 007 ("do not add a fifth
  value here") — a future reader of just that spec/schema history, without also finding this ADR,
  could reasonably be confused about which document is authoritative
- Two membership representations is more schema surface than one FK — a future contributor must
  understand *why* both exist (this ADR) rather than reaching for the simpler, wrong shape
  instinctively
- The `ALTER TYPE … ADD VALUE` ordering requirement (own statement, before dependent DDL) is a
  migration-authoring detail that must be gotten right by hand, with no compile-time check that
  it was (plan Risk R6)

### Option B — Model `paid` as a separate boolean/timestamp on `RefundRequest` instead of a fifth enum value (rejected)

Add `paidAt: DateTime?` to `RefundRequest` and keep `status` frozen at `approved`, treating
"approved + paidAt set" as the de facto paid state.

**Pros:**
- Never touches the frozen `RefundStatus` enum at all — the freeze stays literally true

**Cons:**
- Every existing and future status-based query/guard (`status == 'approved'`, the review-queue
  filter, 007's UI badges) would need to additionally check `paidAt IS NULL`, silently
  reintroducing a two-column composite state everywhere `status` alone used to suffice —
  precisely the class of bug the freeze's "exactly N values" discipline exists to prevent
- AC-5.2's "distinct, clearly marked `paid` state" reads naturally as a first-class status, not a
  side flag on top of `approved`; a UI badge keyed off a boolean-plus-enum combination is a worse
  fit for the domain language 007 already established
- Rejected: technically avoids touching the enum, but at the cost of a worse and more error-prone
  domain model — the freeze's letter would survive, its spirit (one unambiguous status field)
  would not

### Option C — A single `RefundRequest.batchId` with no separate `RefundBatchItem` table, discard sets `batchId=NULL` and relies on `RefundAuditEntry` alone for history (rejected)

Drop the join table; treat the audit trail as the sole historical record of past batch membership.

**Pros:**
- One fewer table; membership is a plain FK, simplest possible shape

**Cons:**
- Audit entries record *actions* (who did what, when) — mining "which requests were ever in
  batch X" back out of a stream of `batch_compiled`/`batch_discarded` rows works, but ADR-0019's
  PDF regeneration needs a direct, queryable membership set, not an event-log reconstruction, to
  stay a simple deterministic function of stored data
- `onDelete: Restrict` has nothing dedicated to hang off for "this request was ever batched" —
  only the audit FK, which was designed for a different purpose (governance record, ADR-0018),
  not membership integrity
- Rejected: conflates two different concerns (what happened, vs. what is/was true) that are
  better kept as separate tables with separate purposes

### Option D — Optimistic concurrency (a `version` column + conditional update) instead of `SELECT … FOR UPDATE` for the compile claim (rejected)

Read candidates without locking, then attempt the claim update conditioned on an unchanged
`version`, retrying on conflict.

**Pros:**
- Avoids holding row locks for the duration of the candidate read, which could in principle allow
  higher read concurrency during compile

**Cons:**
- Requires application-level retry logic for a lost race, and a `version` column purely for this
  purpose, where `SELECT … FOR UPDATE` inside a single short transaction achieves the same
  no-double-claim guarantee natively, with no retry loop and no new column
- The compile transaction is already short-lived (candidate select through commit, no external
  I/O in between — the PDF write happens after commit, per ADR-0019) so the lock-hold-duration
  concern the optimistic approach would address barely applies here
- Rejected: more moving parts for no real concurrency benefit at this transaction's actual shape
  and duration

## Consequences

**Positive:**
- `paid` becomes a first-class, immutable, badge-worthy status with zero new mutation-guard code
  (AC-5.2/2.3-parity for free)
- No request can ever be double-paid or claimed by two batches — the guarantee lives in database
  row locks and a CAS predicate, not in application discipline that could be bypassed by a future
  code path
- A discarded batch's history (who, when, which requests) survives forever, independent of its
  requests being reclaimed by a later batch — `RefundBatchItem` gives this without special-casing
  the audit trail for a job it wasn't designed to do
- Establishes a reusable pattern (live claim pointer for dedup + append-only join table for
  permanent history) for any future Operai feature needing "temporarily/exclusively claimed, but
  permanently remembered" membership

**Negative / trade-offs:**
- Explicitly reverses a documented architectural freeze from the prior spec — must be visible to
  anyone reading 007's history, not just this spec's; this ADR is the canonical record that the
  freeze no longer applies
- Two membership representations to keep mentally straight (which one to query for "is this
  currently claimed" vs. "was this ever in a batch")
- The enum-value migration ordering constraint (Risk R6) is a hand-authored detail with no
  compile-time enforcement that it was done correctly

**Risks:**
- **Concurrent compiles double-claiming a request (plan Risk R2).** Mitigation: `SELECT … FOR
  UPDATE` on exact candidate rows plus the `batchId IS NULL` CAS in one transaction; integration
  test with two overlapping compiles asserting disjoint claims.
- **Concurrent mark-paid vs. discard on one batch (plan Risk R3).** Mitigation: the
  `status='compiled'` CAS predicate — exactly one transition wins, the other 409s; dedicated
  terminal-once test.
- **`ALTER TYPE … ADD VALUE` migration ordering on PostgreSQL (plan Risk R6).** Older PG cannot
  run `ADD VALUE` inside the same transaction as dependent DDL. Mitigation: the `ADD VALUE`
  statement is emitted on its own, before any table DDL that references `paid`, verified against
  the target PG 17 in deploy testing.
- **Future readers missing the freeze reversal.** Anyone consulting only 007's spec/schema
  comment history, without also finding this ADR, could believe the enum is still frozen at four
  values. Mitigation: the Prisma schema comment itself is updated in the same migration to cite
  spec 008 and this ADR as the reason the freeze no longer holds.

## Compliance notes

- GDPR/nLPD impact: low — this decision adds structural/status fields, not new categories of
  personal data beyond what 007 already models (requester identity, amounts); `RefundBatchItem`
  retains request-batch associations indefinitely, consistent with the financial-record retention
  posture ADR-0018 already established.
- Data residency: unaffected — `RefundBatch`/`RefundBatchItem`/the extended `RefundStatus` enum
  all live in `refund-api`'s existing EU-region PostgreSQL database (ADR-0016's deployment
  posture), no new datastore introduced.
- Audit trail: covered in full by ADR-0022 (the batch-scoped extension of ADR-0018), not
  duplicated here.

This decision **supersedes** the unnumbered "no fifth `RefundStatus` value" freeze recorded only
as a Prisma schema comment during `specs/007-refund-service` (no dedicated ADR existed for that
freeze; it is superseded here, not amended, because this is the first ADR to address the enum's
finality directly) and **extends** ADR-0018 (whose audit granularity and `onDelete: Restrict`
retention pattern this decision's `RefundBatchItem`/audit-`batchId` design reuses verbatim) and
ADR-0015 (the entity-scoped ABAC rules the compile-time candidate query reuses unchanged for
scope filtering). ADR-0019 (PDF generation) depends on this ADR's frozen-membership guarantee for
its own regeneration-determinism argument; ADR-0022 records this ADR's audit-side detail as its
own, separately versioned decision.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
