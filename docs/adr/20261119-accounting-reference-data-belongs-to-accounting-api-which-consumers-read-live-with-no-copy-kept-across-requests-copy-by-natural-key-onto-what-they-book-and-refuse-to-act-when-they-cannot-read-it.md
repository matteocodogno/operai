# 20261119 — Accounting reference data belongs to accounting-api, which consumers read live with no copy kept across requests, copy by natural key onto what they book, and refuse to act when they cannot read it

**Date:** 2026-11-19  
**Status:** Accepted — approved plan of specs/20261119-accounting (approved 2026-11-19 under the owner's choice of autonomous execution at spec approval, no plan gate; review on the owner's return); decisions D1, D2, D3, D8, D10, D11, D12, D13 and D23 of the plan. Plan ADR candidate 1. The limits (10 s, 60 s, field lengths) are named constants of the plan (D31), not part of the structure of this decision.  
**Deciders:** Matteo Codogno (product owner), by choice of autonomous execution; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential and ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials (the narrow channel and the live read this ADR reuses), ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds (staleness counted from send; here strengthened to no cache and no stale answer on failure), ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition (snapshot at a lifecycle transition, here across a service boundary), ADR 20261118-accounting-classification-is-live-until-approval-then-frozen-and-changing-it-afterwards-needs-request-reclassify-and-is-refused-by-the-database-once-paid (what is frozen, amended 2026-11-19), ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-recorded-once-and-corrected-only-by-an-admin-never-by-a-scheduler-and-the-outbound-fetch-is-hardened (the rates now live in the provider, amended 2026-11-19), ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-the-deadline-of-the-consumer-and-what-triggered-it-is-derived-by-the-provider-never-claimed-by-the-caller (the provider's side of the deadline), ADR 20261119-data-that-moves-from-one-service-to-another-before-the-release-moves-by-an-additive-migration-that-carries-what-the-source-keeps-and-drops-what-moved-and-an-applied-migration-is-never-edited (how the data got here).

---

## Context

The spec (specs/20261119-accounting) makes the chart of accounts, the VAT codes and the monthly exchange rates of each legal entity a module of their own, `accounting-api`, with its own database and its own capabilities (`accounting:read`, `accounting:manage`, entity condition). Until now these lived inside refund-api (specs/20261118-refund-accounting-export) and were joined to lines by foreign key. Refund is the first consumer; Inventory, CRM, Projects and supplier invoices are the likely next ones. The spec fixes four things that decide the shape: an entry's number or code is its identity within its entity and is never edited (AC-1.12); a change saved in Accounting must be used by a consumer within 60 seconds (AC-4.8); when Accounting cannot be read, an approval is refused and no last-known data is used (AC-6.1, AC-6.5, a non-goal); and a line keeps what it was booked with, however Accounting changes later (AC-5.1 to AC-5.7). A Refund reviewer or admin does not hold an Accounting capability (AC-3.9), so the user's token cannot be the channel.

## Decision

We will make `accounting-api` the only owner and writer of reference data, let a consumer read it **live** as itself over a read-only, purpose-scoped service credential, keep **no copy of the lists across requests**, **copy onto its own record, by natural key, exactly what it books at the moment it books it**, and **refuse** the action when the read cannot be made.

1. **One owner, no write path for a reader.** The consumer stores no ledger account, VAT code or rate table. The system routes accept only `GET`; no write route exists for a service principal (AC-3.8). The owner's ids never leave the owner (D1).
2. **A narrow channel.** `/system/v1/*` accepts only a service JWT (RS256 against auth's JWKS, `aud = SERVICE_AUDIENCE`, `sub` starting `system:`), with scope `accounting.reference.read`, and a `sub` in the allowlist `SYSTEM_READERS = ["system:refund-api"]`. Every failure gets the same 401 body; a user JWT is never accepted; answers carry `Cache-Control: no-store`. The user's JWT is never forwarded (AC-3.9). A second consumer is a deliberate change: one sub in the allowlist, one scope on its client, one review.
3. **The reader's projection.** The system routes and the user routes return the same minimal data (number, name, code, label, rate in basis points, `active`, rate and origin), with no who-added and no history (D18).
4. **Live, with one snapshot per operation, and no cache across requests (D2).** Every consumer operation that needs the data reads it at its start, once, and decides from that one snapshot. Within the operation the answer is memoised; across operations nothing is. One deadline covers the token mint and every call of the operation (`ACCOUNTING_DEADLINE_MS = 10_000`, AC-6.8). The read happens **outside any database transaction**, so no row lock is held across an HTTP call; the transaction that follows re-checks the status under its lock and resolves against the snapshot (D11).
5. **Copy at the moment of booking, by natural key.** What a line is booked with (account number and name, VAT code and rate, exchange rate with its month) is written onto the line in the transaction that books it, and the line refers to the entry by number or code, never by the owner's id. From then on the line is the record; the derived amounts read the copy (see the amendments of ADR 20261118-chf-and-vat-amounts-are-derived-on-read-from-integer-micros-and-basis-points-rounded-once-half-up-and-never-stored). A figure that does not exist yet at booking (a rate not yet published) is left explicitly *pending*, never defaulted, and is copied once, at the first successful delivery that needs it, in the transaction that delivers it; the copy is write-once and the database refuses a change (D12).
6. **When the owner cannot be read, the consumer refuses; it never guesses and never uses a stale value.** "Cannot be read" is one condition with many causes: deadline, network error, any non-2xx after at most one re-mint of the token, a redirect, a non-JSON body, an oversized body, a body that fails the shared schema, a different entity echoed, an answer that does not answer each asked item exactly once, a token mint failure. All raise one error with a kind that is logged and never a body or a credential. Approval, classification and settings writes answer 503 `accounting_unavailable`; an export that needs a rate it cannot get is blocked with its own blocker; a view shows what the records hold and marks the rest `unverified`. Operations that need nothing from the owner (a request with no non-rejected WellD CH line, an export whose lines all hold their copies) never call it.
7. **One wire schema, byte-identical on both sides.** `accountingWire` is a shared-copy file in both services, checked by `mise run shared:check` in CI, and each side is tested against fakes plus contract tests and the e2e on the real path (D23).

## Failure shape

**A decision about facts that another party owns is made from something other than what that party says now, and later nobody can tell what it was based on.** Four ways in, one defect. The *copy that drifted*: a cache, a replica or a remembered answer lets an act succeed on facts that are no longer true. The *guess*: a failed or empty read is taken to mean "nothing there", "inactive" or "use the default", so an outage becomes a plausible decision. The *pointer that rewrites the past*: a settled fact is left as a reference to the owner's live record, so a later edit changes what was already decided. The *identity that does not survive*: the reference is a value the owner can re-issue (a surrogate id), so re-entering the owner's data breaks every record that pointed at it. A fifth rides with them: two sides of one wire each parse it by their own reading, and drift without either test failing.

Where else this shape can appear, including the mirror-image positions:

- **Read and write.** The write that stores a reference to the owner's data (a default, a designation, a setting) needs the same live validation as the read that shows it, and refuses on the same outage. A write that checks "is it active?" against a remembered list is the read-side bug on the other side. Recognise it by any consumer route that accepts a key from the owner's domain and does not call the owner.
- **Provider and consumer.** The same rule binds the producer's route: a caller it does not know gets one identical refusal, a user token is not a service token, the projection is the minimum, and a new consumer is a code change. A consumer's parser must refuse an answer that does not answer what was asked (wrong entity, an item missing or twice), as the producer's tests must refuse a consumer that asks for more than its scope.
- **Absent, unreachable and deactivated.** "Could not find out", "found it, and it is switched off" and "not found" are three outcomes with three states in the record and the screen; none may be shown as another. A copy outlives all three by design.
- **Settled and pending.** The mirror of copying at booking is a value that does not yet exist at booking: it must stay visibly pending and be copied once, at a defined moment, by a write the database cannot repeat. Defaulting it, or re-reading it on every view, is this shape.
- **Create and delete, issue and re-issue.** A reference by a key the owner promises never to edit or reuse survives; the day the owner may edit or re-issue that key, every stored reference becomes a lie (see the escalation triggers).
- **Faster and safer.** The cache that makes the next consumer cheap is the change that reintroduces the first way in. It is allowed only with the three conditions under the escalation triggers.
- **Any future owner and consumer.** Any module that owns a list other modules book against (a price list, a cost-centre list, a supplier directory) is the owner here; any module that books against it is the consumer.

## Options considered

### Option A — Own service, live read over a scoped service credential, no cross-request cache, copy by natural key on the record, refuse when unreadable (chosen)

Described above.

**Pros:**
- AC-6.1, AC-6.5 and the non-goal "no approval from last-known data" hold strictly; AC-4.8 holds by construction, because there is nothing to invalidate
- An approved line is a self-contained fact: an export reproduces from the line, whatever Accounting does later (AC-5.4)
- Natural keys survive re-entering an environment's data and are the words people use, in defaults, seed files and audit rows
- The channel is the one the suite already uses for narrow service reads: one scope per capability, a sub allowlist, an identical 401

**Cons:**
- One internal hop per page view that needs the data, and Accounting's availability gates WellD CH approvals (by spec)
- A copy can differ from the owner's current entry by design; showing that difference is the consumer's job (states `deactivated`, `not_found`)
- Two sides, one shared file: a change to the wire is a change in two services in one push

### Option B — A time-limited cache in the consumer (30 s or 60 s) (rejected)

**Pros:**
- No hop for repeated views; survives short outages

**Cons:**
- An approval could succeed for up to the TTL after Accounting went down, which the spec forbids; every AC of US-6 would need clock tests; volume (hundreds of lines a year) does not need it

### Option C — The consumer keeps a replica of the lists and syncs it (rejected)

**Pros:**
- Works offline; local joins and foreign keys

**Cons:**
- A second source that looks current, a sync that can fail silently, and the very drift this decision exists to prevent; the move out of refund-api was made to end exactly this ownership

### Option D — Forward the user's token (rejected)

**Pros:**
- No service credential

**Cons:**
- A Refund reviewer or admin holds no Accounting capability (AC-3.9), so the read would fail or the capability would have to be widened to every reviewer

### Option E — Keep a live reference to the owner's record and derive everything from it (rejected)

**Pros:**
- Nothing to copy

**Cons:**
- A later edit or deactivation rewrites what was booked, and an export is no longer reproducible; the spec requires the line to keep what it was booked with

### Option F — Reference the owner's surrogate ids (rejected)

**Pros:**
- Shorter keys; the owner can change the visible number

**Cons:**
- Breaks on every re-entry of an environment's data (non-goal "carrying test data") and points the consumer's stored defaults at nothing; the spec defines number and code as the identity

## Evidence

- **Executed and green, 2026-11-19** (specs/20261119-accounting/qe-report.md (re-test after fix round 1: accounting-api 655 pass, refund-api 1799 pass, auth 1497 pass, 0 fail, also with `--randomize` and on databases migrated from zero)):
  - `accounting-api/src/system/contract.refund-client.test.ts` (7 tests): refund-api's real `createAccountingClient` against accounting-api's real Hono app, real `systemAuth` and a real RS256 service JWT, the real `accounting` database. Reference data by entity, the snapshot Refund builds (active, deactivated, not found), rates in asked order, a consumer-triggered fetch, a month not yet published, 42 pairs in two calls, one 401 re-mint, a non-allow-listed `system:crm-api`, WellD Italia refused.
  - `accounting-api/src/system/system.routes.test.ts` and `accountingWire.test.ts` (the 401 matrix with one identical body; strict wire schemas), `accounting-api/src/matrix.test.ts` (every `/v1/*` route by grant and entity; no user route takes a service JWT, no system route a user JWT), `mise run shared:check` (`accountingWire` byte-identical).
  - refund-api T25 suites: `src/accounting/accounting-unavailable.matrix.test.ts` (each unreachable kind through approve, classify, view, options, settings write, export and release: nothing written, 503 or the blocker), `no-cache.test.ts` (a fresh read per operation), `natural-keys.test.ts` (defaults resolve after re-entry); `src/lib/db.accounting-copies.test.ts` and `db.accounting-receipt-guard.test.ts` (copies locked when paid and numbered, rate write-once).
  - `accounting-api/src/catalog.cap.cross-package.test.ts`: the largest allowed reference-data answer stays under refund-api's 256 KiB read cap.
- As planned before implementation (kept for the record):  contract tests of both system routes and their 401 matrix (no token, user JWT, wrong audience, expired, bad signature, scope missing, `sub` outside the allowlist, each with the identical body); a fake `AccountingPort` in refund-api tests that raises each unreachable kind, with the approval, classification, settings-write, export and release outcomes asserted for each (nothing written; 503 or the blocker); a test that a request with no non-rejected WellD CH line and an export of fully copied lines make no call; a db test that the rate copy columns reject a change once set and accept null to set, also on a paid batch; the migration test of ADR 20261119-data-that-moves-from-one-service-to-another-before-the-release-moves-by-an-additive-migration-that-carries-what-the-source-keeps-and-drops-what-moved-and-an-applied-migration-is-never-edited; `shared:check` over `accountingWire`; the e2e on the real path.
- Not yet proved: that no cache is acceptable at the volume of a batch day. The estimate is hundreds of lines a year; the first month of production use is the check.

## Consequences

**Positive:**
- One owner for the lists; one capability pair to grant; a record that needs no join to be understood
- A reference that can never point at nothing by accident of re-entry
- A new consumer is a small, reviewable change (one sub, one scope, one client using the same wire file)

**Negative / trade-offs:**
- WellD CH approvals depend on Accounting being up and seeded (R3, R2 of the plan); IT approvals and exports of copied lines do not
- Refund must show states for a copy whose entry has since changed
- The copy columns and the write-once rule are part of every consumer's schema

**Risks:**
- **Contract drift** between producer and consumer, both tested against fakes (R5). Mitigation: the shared-copy file, contract tests on both sides, the e2e.
- **Natural keys stop being identities** if a later spec allows editing a number or code (R8). Mitigation: the spec forbids it (AC-1.12), the database triggers forbid UPDATE, and it is an escalation trigger here.
- **Accounting changes between the read and the commit** of an approval (R9). Mitigation: allowed by AC-4.8 (seconds old); the line records what was read; the audit holds the copied values.
- **A consumer starts to cache for speed.** Mitigation: the escalation trigger below; a review that asks the three questions.

## Amendment (2026-11-19, accounting sign-off) — the write-side live validation covers account defaults only; there is no VAT default and no foreign-currency designation

The accounting sign-off of 2026-11-19 (specs/20261118-refund-accounting-export/plan.md decisions SO-2, SO-16; specs/20261119-accounting/plan.md SO-18, SO-19) retires every VAT default and the foreign-currency VAT designation (see the amendment of ADR 20261118-accounting-classification-…). The Decision stands: one owner, live reads as itself, no cache across requests, copy by natural key at booking, refuse when the owner cannot be read. To be read in place of the original wording:

1. **What the consumer validates on write is now the account defaults and a hand-chosen line classification.** Wherever this ADR (point 5 of the Decision, the "Read and write" bullet of the Failure shape) names "defaults, designation", read: the per-expense-type default **account** (`PUT /accounting/expense-type-defaults/{type}`, `{ accountNumber }` only, strict) and the account and VAT code a reviewer sets by hand on a line. Each key is still checked against the live read, in the same operation, and a write refuses with 503 `accounting_unavailable` when Accounting cannot be read.
2. **A line's VAT code is optional and always a hand choice.** The consumer never resolves a VAT code from a type or a currency, so there is nothing of the VAT half to copy at approval unless a person set it; a line without one holds none. The "copy at the moment of booking" rule is unchanged for what is held (account, a hand-set VAT code and rate, the exchange rate).
3. **Accounting's side is unchanged.** It keeps VAT codes as plain data (six seeded codes) and never decides which applies.

**Failure shape of this amendment.** The write-side rule is unchanged, but its object shrank, so a write-side check must not be left guarding a stored value that no longer exists, nor a stored value be left unguarded because its route was removed. Recognise it when a consumer stores any key of the owner's domain: each stored key has a live check on write, and a retired storage (the designation table, the VAT columns) leaves no route that still accepts the key.

## Escalation triggers

This decision is revisited when any of these happens:

- a later spec allows editing a ledger account number or a VAT code, or re-issuing a deleted one: every stored natural key must be re-examined, and the references move to something the owner cannot re-issue;
- a consumer needs to write to Accounting: that is a new scope, a new route set, a separate decision, and not a widening of `accounting.reference.read`;
- the volume or the latency justifies a cache: it must stamp each entry at send time, stay at or under 60 seconds, and never serve an entry after a failed refresh (compare ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds);
- a second consumer (Inventory, CRM, Projects, supplier invoices) is added: apply this decision, add it to the allowlist deliberately, and consider one scope per consumer;
- the owner asks to re-rate lines that already hold a copied rate: that needs a spec, a privileged action and an exception to the write-once rule, not a quiet UPDATE.

## Compliance notes

- GDPR / data-protection impact: low. The reference data holds no personal data; the owner's audit rows carry the actor's user id and email; the channel carries none.
- Data residency: both services and their databases are in the suite's EU region; nothing leaves it.
- Audit trail: required. The owner's tables are self-auditing and immutable in the database; the consumer's audit rows carry the copied values and the actor (`line_classified` detail v2, `line_rate_copied`).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
