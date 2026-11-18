# 20261118 — Receipt numbers come from a row-locked per-employee-and-year counter inside the approval transaction, are stored once, and are immutable in the database

**Date:** 2026-11-18  
**Status:** Accepted — approved plan of specs/20261118-refund-accounting-export (approved 2026-11-18 under the owner's pre-authorisation of an unattended run; review on the owner's return); decisions D2, D6 and D7 of the plan. Plan ADR candidate 2. The starting offsets (spec open question 2) are a mechanism here, not a value: the owner supplies them at release.  
**Deciders:** Matteo Codogno (product owner), by pre-authorisation of the unattended run; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20260716-immutable-financial-audit-trail-refund (database-level immutability), ADR 20260722-refund-settings-append-only-self-auditing-store (the release marker is a setting), ADR 20261118-accounting-classification-is-live-until-approval-then-frozen-and-changing-it-afterwards-needs-request-reclassify-and-is-refused-by-the-database-once-paid (the same approval transaction freezes the classification).

---

## Context

Every approved expense line must carry a **receipt number** of the form `MC26/014`: the employee's initials, the two-digit year of the expense date, a three-digit sequence per employee and year (AC-4.1 to AC-4.10). Accounting writes it on the paper receipt and quotes it back, so a number issued twice, skipped, or changed later is a defect in the books. The sequence must be contiguous (AC-4.3), unique per employee and year even when two approvals race (AC-4.10), independent of whether the batch is later discarded and recompiled (AC-4.7), and, for the WellD CH lines already approved or paid, assigned once in expense-date order by a backfill (AC-7.1). Two employees can share initials, so the number alone does not identify a person (AC-4.6). The register already issued numbers on paper (open question 2: `MC26/081` exists), so a starting offset per employee and year may be needed. Numbering is a write in the approval transaction, which already holds the request row through a compare-and-set.

## Decision

We will keep one `receipt_counter` row per (employee, year of the expense date), lock it inside the approval transaction in ascending year order, store the issued number on the line (`receiptNumber`, `receiptOwnerUserId`, `receiptYear`, `receiptSeq`, `numberedAt`), and make both the counter and the stored number immutable in the database.

1. **Issue inside the approval transaction.** `assignReceiptNumbers(tx, request)` runs after the classification is frozen and before commit, over every non-rejected line of both entities (AC-4.1), ordered by expense date, then `createdAt`, then `id` (AC-4.4). A refused approval (`classification_missing`, 409) rolls back and consumes nothing (AC-4.3).
2. **Counter rows, not a sequence.** The row `(ownerUserId, year)` holds `lastSeq` and `startAfter`. It is locked with `FOR UPDATE`, in ascending year order when one request spans two years (AC-4.5), so two approvals cannot deadlock on two counters. A Postgres `SEQUENCE` is rejected: it is non-transactional, so a rollback leaves a gap.
3. **Unique backstop.** `@@unique([receiptOwnerUserId, receiptYear, receiptSeq])` on `refund_line` refuses a duplicate even if the lock is ever bypassed.
4. **Stored, not derived.** The initials are computed from the owner's name (or email) **at numbering time** and stored inside `receiptNumber`; a later change of name or email changes no number. The format is initials + `YY` + `/` + the sequence padded to 3 digits (1000 and above print in full).
5. **Immutable in the database.** Trigger `refund_line_accounting_guard` (BEFORE UPDATE OR DELETE): once `OLD."receiptNumber"` is non-null, a change to any of the five receipt columns raises, and DELETE of the line raises (AC-4.7). A trigger on `receipt_counter` requires `lastSeq` to grow only, makes `startAfter` and `startAfterSetBy` immutable and refuses DELETE. Discarding or recompiling a batch never touches a number.
6. **One-time offset.** `accounting:release --offsets <csv>` (`email,year,lastIssuedSeq`) sets `startAfter` and `lastSeq` only for an (employee, year) with no number issued yet, with `startAfterSetBy = "system:accounting-release"`. A pair that already has numbers is refused. Without a file, numbering starts at 001 (D2).
7. **Release gate.** Until the release script has written the marker (`refund_setting` key `accounting-release-completed-at`), approvals answer 409 `accounting_release_pending`. This guarantees that no new number exists before the legacy lines are numbered in expense-date order, and that offsets can still be applied (D6).
8. **Scope of the backfill.** The script numbers WellD CH lines of `approved`/`paid` requests that have no number. WellD Italia lines approved before the release stay unnumbered (AC-7.3, D7); a WellD Italia line approved after release is numbered, because AC-4.1 applies to every line.

## Failure shape

**An identifier that people quote to each other and to auditors is issued from a place that can hand out the same value twice, can consume a value for an operation that did not happen, or can be changed after it was quoted.** The three variants are one defect seen at different times: two issuers read the same maximum (concurrency), an issuer advances before the work it numbers is committed (rollback leaves a hole, or a retry reuses the value), or a record is edited, regenerated or deleted after its identifier left the building (mutation). A backfill that runs after live issuing starts is a fourth: the identifier order no longer follows the order it claims to.

Where else this shape can appear, including the mirror-image positions:

- **Create and delete.** Deleting a numbered record frees its number for reuse unless deletion is refused; the DELETE half is in the trigger for that reason. The same holds for any "void", "cancel" or "recompile" that removes and re-creates a record: it must keep the identifier, not re-issue it.
- **Issue and derive.** An identifier that is recomputed on read from mutable inputs (a name, a date, a status) changes under people's feet. Store what was issued; compute only the part that must be recomputed to be checked.
- **Allocate and release.** A reservation made outside the transaction that uses it (a sequence, a counter bumped before the commit, a number handed to the UI first) has the gap-on-rollback shape. Allocate inside the transaction, or accept and document gaps.
- **Live issue and backfill.** Any one-time migration of history into a numbered scheme must run before live issuing starts, or the live numbers must be fenced; hence the gate. A future numbered document (offers use `NNNN/YYYY`; this is the per-person variant) meets the same question on day one.
- **One counter and several.** An operation that spans two counters (two years, two entities, two people) must lock them in one global order, or two such operations deadlock.
- **Uniqueness scope.** An identifier unique only within a scope (here per employee and year) must always travel with the scope's name, or two records look the same on a printout.
- **Offset and reset.** A starting value loaded after the first issue silently collides with it; refuse it once any number exists.

## Options considered

### Option A — A locked counter row per (employee, year) inside the approval transaction (chosen)

Described above.

**Pros:**
- Rollback gives the number back with the rest of the transaction; contiguity is by construction
- A natural place for the starting offset, with its own immutability
- The lock is visible in the code and in `pg_locks`, not hidden in a function
- Reuses the approval transaction's existing row lock, so no new race with mark-paid or reclassify

**Cons:**
- Approvals of one employee within one year serialise on a row (milliseconds; approvals are human-paced)
- A trigger and a counter table to keep in step with the Prisma schema (R11)
- A gap in numbers can only appear if someone deletes rows with the triggers disabled; that is outside what this decision can stop

### Option B — `MAX(receiptSeq) + 1` under an advisory lock (rejected)

**Pros:**
- No counter table

**Cons:**
- A hidden lock keyed by a hash, and no place for the starting offset; deleting the highest line would let its number be reissued

### Option C — A Postgres `SEQUENCE` per employee and year (rejected)

**Pros:**
- Built-in concurrency control

**Cons:**
- Sequences are non-transactional: a rolled-back approval burns a number, which violates AC-4.3; one sequence per person and year is also an unbounded number of objects

### Option D — Numbers assigned at submit or on first export (rejected)

**Pros:**
- Earlier visibility

**Cons:**
- A submitted request can still be rejected or withdrawn, so numbers would be consumed by nothing; AC-4.1 ties the number to approval

### Option E — No release gate, backfill whenever the operator gets to it (rejected)

**Pros:**
- No blocked approvals after deploy

**Cons:**
- A live approval could take 001 before the legacy 001 to 081 are numbered, and an offset could no longer be applied (R3, R5)

## Evidence

- Pattern: the immutability triggers of `refund_audit_entry` and `refund_setting` (ADR 20260716-immutable-financial-audit-trail-refund; ADR 20260722-refund-settings-append-only-self-auditing-store).
- Planned, not yet run (plan, Test strategy, AC-4.1 to AC-4.10, AC-7.1, AC-7.3): unit vectors for initials (`Matteo Codogno` to `MC`, `mcodogno@…`, `m.c@…`, `Cher`, `x@…`, `Élise Würth` to `EW`); int tests for contiguity over three approvals, a refused approval that consumes nothing and leaves no counter row, order by expense date, two years in one request, two owners with the same initials, two approvals fired with `Promise.all` and repeated 20 times; db tests that a raw UPDATE of `receiptNumber` raises, DELETE of a numbered line raises, and the unique index refuses a duplicate; a release-script test with `--offsets`, including refusal for a pair that already has numbers, and a second run that changes nothing.

## Consequences

**Positive:**
- Contiguous, unique, immutable numbers per employee and year, provable in the database and not only in the application
- The backfill and live approvals share one function and one order, so the legacy lines are numbered exactly as they would have been
- The paper-era offset has a place and a one-shot rule

**Negative / trade-offs:**
- Approval has a new 409 (`accounting_release_pending`) until the operator runs `bun run accounting:release`; the existing approve tests need `markAccountingReleased()` (R14)
- A wrong number cannot be corrected by editing; the way out is a reviewed migration that disables the trigger deliberately
- Surname-first names produce the "wrong" initials (`Codogno Matteo` to `CM`); the number stays unique and the name always travels with it (R15)

**Risks:**
- **The operator forgets the release script** (R5). Mitigation: a clear 409 message in the UI, a runbook step in `infra/README.md`, an idempotent script.
- **Collision with paper-era numbers** (R3). Mitigation: offsets before any number exists; the gate guarantees nothing is numbered earlier.
- **Deadlock across two years** (R6). Mitigation: ascending lock order, the unique index as backstop, and the 20-fold concurrency loop.
- **Triggers drift from `schema.prisma`** (R11). Mitigation: a `db.*.test.ts` for each trigger; migrations only through `migrate deploy`.

## Escalation triggers

This decision is revisited when any of these happens:

- a numbered document of another kind is needed in the suite (apply the same counter-in-transaction rule; consider a shared counter helper);
- the owner wants gap-tolerant or globally unique numbers instead of per employee and year;
- a legal request needs a number removed or changed: the owner decides, and the path is a reviewed migration, never a loosened trigger;
- numbering is needed for a third entity, or WellD Italia legacy lines must be numbered (that reverses D7 and needs its own backfill order).

## Compliance notes

- GDPR / data-protection impact: low. A number carries two initials of an employee and is stored with the owner's user id; no new category of data. An erasure request reaching `receiptOwnerUserId` needs an owner decision (the trigger forbids edits on purpose).
- Data residency: no change (refund-api's database in the suite's EU region).
- Audit trail: required. One `receipt_number_assigned` row per number (cause `approval` or `release`) through the existing audit trail; the release actor is `system:accounting-release`.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
