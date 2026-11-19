# 20261119 — Data that moves from one service to another before the release moves by an additive migration that carries what the source keeps and drops what moved, and an applied migration is never edited

**Date:** 2026-11-19  
**Status:** Accepted — approved plan of specs/20261119-accounting (approved 2026-11-19 under the owner's choice of autonomous execution at spec approval, no plan gate; review on the owner's return); decision D5 and "Data migration strategy" of the plan. Plan ADR candidate 2.  
**Deciders:** Matteo Codogno (product owner), by choice of autonomous execution; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** AGENTS.md rule "Prisma migrations — never modify existing migration files" (the rule this applies to the unreleased case), ADR 20261110-caller-chosen-ids-replace-cross-service-transactions and ADR 20261117-the-crms-legal-details-move-to-the-registry-by-expand-copy-switch-contract-and-version-1-is-attributed-to-the-system (moves of data between services that have users; this ADR covers the case where nothing has been released), ADR 20261119-accounting-reference-data-belongs-to-accounting-api-which-consumers-read-live-with-no-copy-kept-across-requests-copy-by-natural-key-onto-what-they-book-and-refuse-to-act-when-they-cannot-read-it (what moved and why), ADR 20260716-immutable-financial-audit-trail-refund (the triggers a backfill must not trip).

---

## Context

The accounting module takes the ledger accounts, VAT codes, their status history and the exchange rates out of refund-api (specs/20261118-refund-accounting-export, migration `20261119090000_accounting_export`) and into accounting-api. That 20261118 work is on the branch and has not been released, so production holds none of its data. Developer databases and the e2e database, however, have applied the migration and may hold classified lines, defaults and rates, and the migration created guards (a trigger function that names the columns about to be dropped) and CHECKs. AGENTS.md forbids modifying an existing migration file. The temptation is strong: nothing is in production, so editing the unreleased migration would give a clean history and one fewer file.

## Decision

We will move such data by **one new, additive migration in the source service** that, in this order, adds what stays, carries the source's own data into it, replaces the guards that name old columns, adds new constraints, and drops what moved; we will **never edit a migration that any database has applied**, released or not; and what moved to another service is **not carried across** (it is entered again in its new owner, by an operator-run, idempotent seed in development).

1. **Add, then carry, then guard, then constrain, then drop.** In refund-api: add the copy columns to `refund_line`; create the new append-only tables with their immutability triggers; carry Refund's own data (line copies joined from the old catalog on the old FK columns, the history of defaults and the designation with the same ids, actors and times, and for approved or paid numbered lines the rate in effect as their rate copy, else left pending); `CREATE OR REPLACE` the guard function **before any column it names is dropped**; add the CHECKs `NOT VALID` and then `VALIDATE` them, so a developer database with odd rows fails loudly with the constraint's name; drop the foreign keys, indexes, columns, tables and the enum type that moved. A new enum value is added last and is not used inside the same migration.
2. **The carrying writes touch only new columns,** so the existing guard, which watches the old ones, does not fire and no trigger is disabled. A migration that has to disable a trigger to run is a sign the order is wrong.
3. **Carry what stays, drop what moved.** What the source service keeps (the records and their copies, its own defaults and their history) is carried, because it is the source's data and stays valid by natural key once the same entries exist in the new owner. What moved (catalog, rates, attempt log) is dropped: environments enter it again in the new owner; the old designation rows that cannot be deleted because they are immutable are left in place and are never read (D33).
4. **Proved on data, not on an empty database.** A migration test brings a scratch database to the previous migration, inserts fixture rows (classified, paid, EUR and defaults), applies the new migration, and asserts: copies equal the old joins, the carried history keeps ids and actors, EUR lines get the rate in effect, the dropped tables are gone, every CHECK is validated; and a fresh database applies all migrations with `prisma migrate diff` showing no difference, for both services.
5. **One-way.** There is no down migration. It is safe because production is empty; the release runbook states that the two migrations run back to back on empty tables.

## Failure shape

**A change to history that other copies of the history have already built on is made by rewriting the history, so those copies silently disagree with it, or are forced to be thrown away.** An applied migration is a shared fact: every database that ran it holds its checksum and its result. Editing it makes each such database report drift and ask to be reset, or, worse, lets it run on with a schema that no file describes. The mirror failure is the clean-looking move that leaves two sources for the same thing: the data copied to its new home while the old tables stay, both looking current, with foreign keys that still constrain.

Where else this shape can appear, including the mirror-image positions:

- **Released and unreleased.** "Nothing is in production" is not "nothing has applied it". The test is who holds the checksum, not whether a user exists. The same holds for a seed, a fixture or a generated file that other branches and databases have already consumed.
- **Move out and move in.** The mirror of dropping the moved tables is the receiving service's initial migration: it starts from nothing and must be seeded, so a move needs its seed and its order of operations written down, or the first approval after the deploy finds an empty list.
- **Carry and re-enter.** What the source keeps must carry its meaning to the new world; if it carries a surrogate id of something that moved, the reference points at nothing. That is why records refer to what moved by a key that survives re-entry (see the reference-data ADR above).
- **Replace and drop.** A guard, a view, a default or a generated column that names a column must be replaced before the column goes, or the drop fails halfway or, worse, succeeds and leaves a function that raises at the first write.
- **Constrain and validate.** A constraint added over rows nobody has looked at either fails the whole migration obscurely or is accepted unvalidated. `NOT VALID` then `VALIDATE` makes the first loud and the second visible.
- **Forward and back.** A one-way migration is acceptable only when the first run is on data that can be re-created; the day a move has users, it needs the expand, copy, switch, contract sequence of the CRM registry move instead.

## Options considered

### Option A — One additive migration that carries what stays and drops what moved (chosen)

Described above.

**Pros:**
- Every database, in every state, ends at the same schema through files that are all still true
- One source of truth after the move; no dead tables and no foreign keys into nothing
- The order is testable, and the test uses data

**Cons:**
- One more migration file whose first half is a backfill that is a no-op in production
- Developer and e2e databases lose the moved reference data and must re-enter it (one seed command)

### Option B — Edit the unreleased migration `20261119090000_accounting_export` (rejected)

**Pros:**
- A cleaner history; no backfill step

**Cons:**
- Developer and e2e databases have applied it: Prisma reports a checksum mismatch and asks to reset them; AGENTS.md forbids it for every service; it sets a precedent that "unreleased" suspends the rule

### Option C — Leave the moved tables in place, unused (rejected)

**Pros:**
- No drop, nothing to get wrong

**Cons:**
- Two sources that both look current, and foreign keys that still constrain writes toward data nobody maintains

### Option D — Reset the developer and e2e databases (rejected)

**Pros:**
- Simple for the author

**Cons:**
- Loses other people's work in progress on shared databases and teaches that migrations may be rewritten

## Evidence

- Planned, not yet run (plan, Test strategy, "mig"): the scratch-database test above on `accounting_qe`/`refund_mig` databases that are dropped afterwards; risk R7 (a developer database with hand-made odd rows, or the old guard firing during the backfill) is the case the test and the `NOT VALID`/`VALIDATE` order cover.
- The shape of the move is in the plan, Data model, "refund-api — one additive migration".

## Consequences

**Positive:**
- No developer is asked to reset a database because of this feature
- The rule "an applied migration is never edited" gets a stated answer for the case that most tempts a breach

**Negative / trade-offs:**
- The migration's carrying step is dead code in production; it is kept because it is the only path for the databases that need it
- Moved reference data in development is lost and must be re-seeded

**Risks:**
- **The backfill fails on hand-made rows** (R7). Mitigation: the carrying writes touch only new columns, constraints are validated with named errors, the test runs on fixture data.
- **Someone reads the one-way migration as a precedent for released data.** Mitigation: the failure shape and the last bullet of it state the limit; a move with users follows the registry move.

## Escalation triggers

This decision is revisited when any of these happens:

- a move of data between services is planned after the source's migration has been released: use the expand, copy, switch, contract sequence, with its count check and announced write pause;
- the carrying step needs a trigger disabled or a table locked for longer than a deploy;
- the receiving service cannot be seeded by an operator-run script (the moved data is too large or not reproducible): the move then needs its own data-copy decision.

## Compliance notes

- GDPR / data-protection impact: none. The carried history keeps its actors' ids and emails exactly as they were; nothing new is collected or exposed.
- Data residency: no change.
- Audit trail: preserved. The carried history keeps its ids, actors and times, and the immutability triggers stay on.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
