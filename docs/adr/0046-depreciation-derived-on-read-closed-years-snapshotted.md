# 0046 — Depreciation is derived on read for open years and snapshotted, immutably, once a fiscal year is closed

**Date:** 2026-10-06
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/015-hardware-inventory` introduces `inventory-api`, which computes each asset's yearly
depreciation from its entity's rule (US-5), lets an accountant change a rule from a given date
without rewriting existing schedules (US-6), and rolls a fiscal year forward and closes it so
that next year's opening value is exactly what was reported (US-8). The register it replaces is
an Excel sheet in which hand-typed, hand-corrected figures let an opening balance stop matching the
previous closing; AC-8.3 and AC-8.6 exist to make that defect impossible.

Two pressures pull in opposite directions. While a year is open, price and purchase-date edits
(AC-5.9) and new rules (AC-6.2: "a new rule applies to every asset purchased on or after its
effective date") must take effect everywhere with no recomputation step. Once a year has been
reported, its figures must be identical every time they are viewed, whatever code, rule or
rounding is changed later (AC-8.6). A third need follows: wellD CH's history exists only as figures
in the legacy sheet (US-12), which the formula must never recompute (AC-12.2) but must continue
from (AC-12.5).

## Decision

We will store only an asset's inputs (entity, purchase date, integer-cent price) and derive its
depreciation rule and schedule on read, persisting nothing about an open fiscal year; closing a
fiscal year writes one immutable `asset_year_figure` row per asset and one immutable `fiscal_year`
row, and every closed-year read comes only from those rows.

Concretely:

1. **The rule is resolved, not referenced.** An asset has no foreign key to its rule. Its rule is
   the latest `depreciation_rule` row for its entity with `effectiveFrom <= purchaseDate`, ties
   broken by `createdAt`, resolved on read exactly like `resolveEffectiveRate` for mileage rates
   (ADR-0013/0023). Rules are append-only with the DB-level `BEFORE UPDATE/DELETE` trigger
   (ADR-0024 pattern).
2. **The schedule is a pure function** `schedule(priceCents, purchaseYear, rule, anchor?)`
   (`depreciation/schedule.ts`; contract in the plan's "Schedule function"). It has one rounding
   rule: round half-up to the cent, and the final year takes the remainder so book value lands
   exactly on the residual (ADR-0025: round once, one canonical rule). `roundHalfUp` is the only
   rounding function, and `schedule-vectors.json` is shared by `inventory-api` tests and
   `inventory-ui`, which only displays.
3. **Closing is the only write that materialises figures.** Closing a fiscal year (per entity,
   strictly sequential, never reopened) writes one `asset_year_figure` per asset and one
   `fiscal_year` row carrying the five roll-forward lines, in one transaction. A `fiscal_year` row
   existing **is** the closed state: `isClosed(entity, year) = year <= max(fiscal_year.year)` for
   the entity. There is no status column and no reopen operation. Both tables carry the Tier 1
   immutability trigger (ADR-0018/0033).
4. **Imported history uses the same rows.** Legacy assets carry their reported figures as
   `asset_year_figure` rows with `source = 'imported'`. The latest imported figure is the anchor
   from which the remaining schedule is spread evenly over the remaining years (AC-12.5).
   Natively registered assets never anchor: their open years come from the formula, which is
   deterministic because price/date edits are rejected once any year from the purchase year on is
   closed (AC-5.9) and a rule cannot take effect in a closed year.
5. **A close cannot race a backdated write.** Every dated write (register, edit price/date,
   dispose, create rule) and the close itself take `pg_advisory_xact_lock` on the entity inside
   the same transaction, then check `isClosed`.

## Failure shape

**A figure that has already been reported to someone is changed by a process that was never
meant to touch it, and nothing fails when it happens.** The reported number is a *derived* value
(inputs plus code plus rules), so any later change to the inputs, the code, a rounding rule or a
rule table silently re-derives it, and the old answer is gone with no record that it ever differed.
The visible symptom is a boundary that stops reconciling: this period's opening no longer equals
the last period's closing.

The mirror image is equally real and equally quiet: a derived value that is *also stored* while it
is still subject to change. Two copies of the truth, one edited and one not, drift apart, and the
fix is a backfill that someone must remember to run.

Recognise the shape wherever a computed value crosses from "still being worked on" to "someone has
relied on it":

- **Read and write.** Reading a past period through live logic (a closed year recomputed instead of
  read back) and writing a not-yet-final period into storage (an open year persisted at
  registration) are the same mistake in opposite directions. The test is the same for both: is the
  value final, and which side of that line is it stored on?
- **Correction versus history.** A fix to a reported period applied by editing it in place, or by
  reopening it, instead of as a visible adjustment in the period that is still open.
- **Check versus act.** A guard that tests "is this period closed?" in one transaction and a write
  that acts in another. Whenever a boundary can move (a close, a lock, a publish), every write
  that depends on which side of it a date falls must be serialised against the move.
- **Other domains.** Any reported statement, invoice total, payout batch, tax figure or archived
  export: if a person can point at the number and say "that is what we told them", it needs a
  stored, immutable source of truth, not a regenerable cache (see Options and the ADR-0019
  contrast).

## Options considered

### Option A — Derive open years on read; snapshot a year only when it is closed (chosen)

**Pros:**
- Price edits, date edits and new rules need no recomputation job, backfill or cron; AC-5.9 and
  AC-6.2 hold by construction because there is nothing stored to go stale.
- A closed year is read from rows no later code can alter, so AC-8.3 (opening = previous closing)
  and AC-8.6 (identical every time) are properties of storage, not of discipline.
- One mechanism serves native and legacy data: imported figures are the same rows with a `source`
  tag, so a closed-year read has a single path.
- Reuses three existing suite patterns: derived-on-read (ADR-0013/0023), integer-cent round-once
  (ADR-0025) and Tier 1 immutable history (ADR-0018/0024/0027/0033).

**Cons:**
- Open-year roll-forwards are computed per request over all of an entity's assets.
- The close must be correct on the first attempt; there is no reopen (see Consequences).

### Option B — Persist each asset's whole schedule at registration

**Pros:** reads are trivial row lookups.

**Cons:** every price edit or rule change becomes a rewrite of stored rows, and AC-6.2 ("a new rule
applies to every asset purchased on or after its effective date") becomes a data migration. Stored
open-year rows also invite drift between the stored and the computed truth, the second form of the
failure shape. Rejected.

### Option C — Compute everything live, with no snapshot

**Pros:** simplest; no close-time write path, no immutable tables.

**Cons:** a later bug fix, rounding change or rule would silently alter years already reported to
the accountant, and next year's opening balance could stop matching last year's closing: the exact
defect found in the existing spreadsheet. Rejected.

### Option D — A scheduled job that materialises each year's depreciation on 31 December

**Pros:** every year is stored without anyone acting.

**Cons:** contradicts the suite's standing rule that derived lifecycle state is computed on read,
never by a cron or queue sweep (ADR-0013/0016/0019). It would also decide *when a year is final*
by the calendar rather than by the accountant's act of reporting, and a late backdated purchase
would race the job. Rejected.

## Consequences

**Positive:**
- No recomputation, backfill or cron anywhere in the depreciation path.
- A reported year can never change: not by a code fix, a rounding change, a new rule, or an edit.
- The advisory lock makes "is it closed?" and "write it" one atomic step per entity.
- Contrast with ADR-0019: the batch PDF is a regenerable *cache* derived from `RefundBatchItem`
  and may be re-rendered at will. A closed fiscal year is the opposite, a *source of truth* that
  must never be regenerated. Do not carry ADR-0019's "lazily re-render on read" idea across.

**Negative / trade-offs:**
- There is deliberately no reopen. A wrong closed year is corrected in the open year, visibly,
  never by editing history.
- Open-year roll-forwards cost O(assets of the entity) per request. Plan Risk R-8 sets the early
  signal: 2,000 assets must answer `GET /fiscal-years/{e}/{y}` under 500 ms. Beyond that, revisit
  this ADR (cache open-year figures with explicit invalidation, or move the sum into SQL) rather
  than quietly adding a persisted open-year table.
- The even-spread anchor (decision 4) is only correct for the Swiss full-first-year rule. Importing
  wellD IT history under a half-first-year rule would need a per-asset remaining schedule; that is
  spec drift to be taken through the spec, not an extension of this ADR.
- The legacy sheet has no per-year depreciation before 2024, only a value at 31.12.2023, so
  years before 2024 are closed with a closing value only (plan Risk R-2). Anything earlier is a
  spec amendment.
- The date-edit and rule guards depend on a derived fact (`isClosed`) rather than a column, so
  every new dated write path must remember to take the entity lock and check it.

**Risks:**
- A new dated write path that skips the lock or the check could change a closed year's inputs.
  Mitigation: the Tier 1 triggers still make the stored closed rows immutable, so the failure is a
  roll-forward that no longer reconciles with a closed year rather than a silently altered one;
  tests must cover each dated write against a closed year.
- The `schedule` function drifting between `inventory-api` and `inventory-ui`. Mitigation: the
  shared `schedule-vectors.json`, as in ADR-0025.
- A wrong close is permanent. Mitigation: the open year's roll-forward is readable through
  the same view (`GET /fiscal-years/{entity}/{year}`) before it is closed, and corrections go
  forward.

## Compliance notes

- GDPR / data-protection impact: none. The tables hold asset figures, not personal data.
- Data residency: compliant. `inventory-api` deploys to the EU region like every backend.
- Audit trail: required. `fiscal_year` and `asset_year_figure` are Tier 1 (DB-level immutable,
  ADR-0018/0033), and `fiscal_year_closed` is recorded in the append-only `asset_event` log.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
