# 20261118 — Accounting classification is live until approval and frozen at approval, changing it afterwards needs its own permission `request:reclassify`, and the database refuses it once the request is paid

**Date:** 2026-11-18  
**Status:** Accepted — approved plan of specs/20261118-refund-accounting-export (approved 2026-11-18 under the owner's pre-authorisation of an unattended run; review on the owner's return); decisions D4, D5, D11 and D12 of the plan. Plan ADR candidate 3. Who holds `request:reclassify` (spec open question 5) is a role edit, not a code change.  
**Deciders:** Matteo Codogno (product owner), by pre-authorisation of the unattended run; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition (snapshot at a lifecycle transition), ADR 20260716-entity-scoped-abac-refund-api (`requestInScope`), ADR 20260721-self-approval-condition-and-403-exception (unchanged), ADR 20260716-immutable-financial-audit-trail-refund (the audit trail the new actions ride), ADR 20261118-receipt-numbers-come-from-a-row-locked-per-employee-and-year-counter-inside-the-approval-transaction-and-are-immutable-in-the-database (numbered in the same transaction).

---

## Context

Each WellD CH expense line must be booked to a **ledger account** and a **VAT code** (AC-3.1 to AC-3.10). An expense type has a default of each, configured by an admin and changeable at any time (AC-2.1 to AC-2.4); a non-CHF line takes the one designated **foreign-currency VAT code** instead of the type's own (AC-3.2); accounting can override either on a line. Three timing questions follow. What does a reviewer see while a request is `submitted`, if an admin changes a default during the review? What exactly is booked once the request is approved, if the default changes afterwards (AC-3.5, AC-2.3)? And who may change a booking after approval, up to which point (AC-3.6, AC-3.7)? Open question 5 left the post-approval permission undecided. In addition, the employee who owns the request opens the same request page as the reviewer, and AC-3.10 says the employee must never see the account, VAT or CHF figures.

## Decision

We will resolve a line's classification **live** (override, else default) until approval, **freeze** it for every non-rejected WellD CH line in the approval transaction, allow later changes only through a separate action `request:reclassify` while the request is `approved` and not `paid`, refuse them when paid in the application and in the database, and serve accounting data only through its own endpoint.

1. **One function.** `resolveClassification(line, overrides, defaults, foreignVatCodeId)` in `classification.ts` (pure) is used by the review view, the approve freeze, the release backfill and the export blockers. A default or the designation that points at an **inactive** entry resolves to **none**. A line shows or books only active entries; a frozen reference to a since-deactivated entry stays on the line.
2. **Live before approval.** On `submitted`, `ledgerAccountId`/`vatCodeId` on the line are overrides; `null` means "follow the current default". A change goes through `PUT /review/requests/{id}/lines/{lineId}/classification` under `request:set-approved-total`, stores the override and writes `line_classified` (cause `review`).
3. **Frozen at approval.** In the existing approval transaction, after the release gate and before numbering: resolve every non-rejected WellD CH line; if any lacks an account or a VAT code, throw `classification_missing` (409 with the list of lines; nothing changes); otherwise write the account, the VAT code and both `*IsDefault` flags onto the line and write `line_classified` (cause `approval`) (AC-3.5). WellD Italia lines have no classification (AC-3.9).
4. **After approval, a separate permission.** `request:reclassify` (new in `auth`'s refund catalog, `supportedConditions: ["entity"]`, granted like `approve`) is required while the request is `approved`, whether or not it is in a `compiled` batch (cause `post_approval`). It never touches `approvedTotalCents`, `status` or `decided*` (AC-3.6). A `null` on an approved line is refused (`classification_required`).
5. **Locked when paid.** `409 classification_locked` at the application, and the trigger `refund_line_accounting_guard` raises on a change to `ledgerAccountId`, `vatCodeId` or the `*IsDefault` flags when the parent request's `status = 'paid'` **and the line already has a receipt number** (AC-3.7). *Amended 2026-11-19 (implementation, T1, commit 352c6747):*
   - **Why the condition.** The release backfill must classify legacy lines of requests that were paid before this feature. It writes the classification before, or together with, the number. After the release, every non-rejected line is numbered in the same approval transaction that freezes its classification, so every post-release paid line is locked.
   - **What stays unlocked at the database.** Pre-release WellD Italia lines (never numbered) and rejected lines. The application never classifies either, and the export excludes both.
   - **Consequence (from the spec, not from the condition).** A legacy WellD CH line of a paid request that the release leaves unclassified is numbered and then locked for good, so its old batch cannot be exported. The release dry-run lists these lines (plan IS-1).
6. **Decide on the locked status.** The PUT runs in one transaction that locks the request row with `SELECT … FOR UPDATE` and chooses the required permission from the **locked** status. Approve and mark-paid already update that row, so they serialise with it (R7).
7. **Withdraw clears the overrides.** Withdraw-to-draft clears the line overrides, one `line_classified` row per line (cause `withdrawn`), so a changed expense type does not keep a stale override (D12).
8. **Accounting never travels with the employee's view.** `GET /requests/{id}` gains only `receiptNumber`. Account, VAT and CHF come from `GET /review/requests/{id}/accounting`, gated by `request:review` and the entity scope, and 404 for anyone else. A test asserts the exact key set of the owner's line JSON (AC-3.10, R8).
9. **Before approval the amounts shown** use `approvedTotalCents ?? requestedAmountCents`, the figure approval will keep for an untouched line (D11).

## Failure shape

**A fact that must be settled at one moment is kept as a live reference, so a later change of configuration rewrites what was already decided; or the reverse, it is settled too early and the person deciding cannot see what will be true.** Related defects travel with it: the permission to change a settled fact is checked against a status read *before* the status is fixed (a check-then-act race: the rule that applied when the request was read is not the rule that applies when the write lands); the same resolution rule re-implemented in three places that then disagree; and data meant for one role shipped inside a response shared with another, protected only by a condition someone can forget.

Where else this shape can appear, including the mirror-image positions:

- **Set and clear.** Freezing must be answered on the way back too: withdrawing a request must clear what was set for review; clearing a value on an already frozen record (`null` back to default) is refused, not interpreted.
- **Default changes and entry deactivation.** A change of the live default, a deactivated referenced entry, and a reactivated one are three different events; only the first two leave frozen records untouched by design, and "inactive" must mean "none" on the way in and "unchanged" on the way out.
- **Approve and pay.** Any transition that makes a record immutable (paid, closed, exported) needs the lock at the database, because every route that writes it will not be written by the same author.
- **Review and post-approval.** Two phases with two permissions on the same field are a status-dependent gate; the status must be read under the lock that the transition takes.
- **Read and write visibility.** A field hidden on a read must also be absent from every write response and event that echoes the record; a role that can both own and review a record must still get the owner's shape on the owner's route.
- **Snapshot and recompute.** Any value derived later from frozen references (the CHF and VAT amounts) must read the frozen reference, not re-resolve the current default.

## Options considered

### Option A — Live before approval, frozen at approval, a separate permission afterwards, trigger at paid (chosen)

Described above.

**Pros:**
- The reviewer always sees the defaults that would apply now, and the approved record states exactly what was booked
- A default change never rewrites an approved line (AC-2.3, AC-3.5)
- Restricting post-approval changes later is a role edit in admin-ui, with no deploy (open question 5)
- One resolution function, so the view, the freeze, the backfill and the export blockers cannot disagree
- The employee's response has no accounting fields by construction

**Cons:**
- A new action in `auth`'s catalog: auth must be deployed first (R13), until then post-approval reclassification is 403 (fail closed)
- Two phases to explain and to test (`review`, `post_approval`, plus `locked`)
- An extra trigger branch to keep in step with the application rule

### Option B — Write the classification at submit (rejected)

**Pros:**
- Simplest read model

**Cons:**
- A default changed during review would be invisible to the reviewer; AC-3.5 puts "that moment" at approval

### Option C — Never freeze; resolve the current default at export (rejected)

**Pros:**
- No stored classification, no reclassify route

**Cons:**
- A default change would rewrite approved lines and paid batches; breaks AC-2.3 and the books

### Option D — Reuse `request:set-approved-total` after approval (rejected)

**Pros:**
- No new catalog entry

**Cons:**
- Couples "may adjust the amount" to "may rebook"; makes open question 5 a code change instead of a role edit

### Option E — Application check only for paid, no trigger (rejected)

**Pros:**
- Less SQL

**Cons:**
- Every future write path to `refund_line` would have to remember the rule; the same defence in depth the suite uses for the audit trail (ADR 20260716-immutable-financial-audit-trail-refund)

### Option F — Put accounting fields on `GET /requests/{id}` and hide them for the owner (rejected)

**Pros:**
- One endpoint

**Cons:**
- AC-3.10 would depend on a condition that could be forgotten; a person holding both the owner and the accounting role would see it

## Evidence

- Planned, not yet run (plan, Test strategy, AC-2.3, AC-2.7, AC-3.1 to AC-3.10): unit vectors for `resolveClassification` (designation unset, cleared, or pointing at a deactivated code gives VAT `null` for non-CHF lines, CHF lines unaffected); int tests that approve then change defaults leaves the frozen ids, an approved line (no batch, then compiled batch) is reclassified with `reclassify` (audit `post_approval`, money fields unchanged) and refused without it (403), a paid request answers 409 `classification_locked`, a missing default blocks approval and leaves no number or counter row, an Italia line is not classified and an Italia-only request still approves; a db test that a raw `UPDATE refund_line SET "vatCodeId"` on a paid request's line raises; a key-set assertion on the owner's line JSON in every status; a concurrency test for a PUT racing approve and mark-paid is not in the plan's table yet and should be added with the route (R7).

## Consequences

**Positive:**
- What was booked is a fact on the line, with who changed it and why in the audit trail (`line_classified`, with `cause`)
- Defaults can be tuned freely after go-live without touching history
- Visibility of accounting data is a property of the response shape

**Negative / trade-offs:**
- Deactivating or changing a default does nothing for lines already approved; fixing those is an explicit per-line reclassification, unpaid only
- A paid line's classification is permanent short of a reviewed migration

**Risks:**
- **Wrong seed or default frozen into legacy lines** (R1). Mitigation: the release script's `--dry-run` and the release gate; unpaid lines remain reclassifiable.
- **Deploy order** (R13). Mitigation: auth first; fail closed until then.
- **A PUT racing approve or mark-paid** (R7). Mitigation: the request row lock and the trigger.
- **A future field added to `RefundLineResponse`** (R8). Mitigation: the exact-key-set test.

## Escalation triggers

This decision is revisited when any of these happens:

- open question 5 is answered with a narrower holder than `approve`: edit the grants first; change code only if the rule is not "same people as approve";
- a second entity needs classification (the function and the freeze are per entity, WellD CH only today);
- a status after `paid` or a reopening of paid requests is introduced;
- another field of an approved record needs the live-then-frozen treatment: reuse this structure (one pure resolver, a freeze in the transition, a separate permission, a trigger at the final state).

## Compliance notes

- GDPR / data-protection impact: none beyond what refund already holds; the classification is business data about an expense.
- Data residency: no change.
- Audit trail: required (AC-3.3, AC-3.5, AC-3.6). Two new `AuditAction` values, `line_classified` and `receipt_number_assigned`, ride the existing immutable trail; the actor is the verified JWT, or `system:accounting-release` for the script.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
