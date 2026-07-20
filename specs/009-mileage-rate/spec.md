---
id: 009
slug: mileage-rate
status: in-progress
rigor: production
created: 2026-07-20
approved: 2026-07-20
---

# Mileage rate: computed amounts for travel-km expense lines

## Problem

`specs/007-refund-service` recorded `km` on `travel-km` (mileage) expense lines purely
for reference — the employee still had to type in the requested amount by hand, meaning
the actual distance driven was decorative and the claimed amount was whatever the
employee happened to calculate (or guess) against wellD's per-kilometre reimbursement
policy, a figure that differs between WellD CH and WellD Italia and that itself changes
over time. This produces mistakes that reach accounting's queue as ordinary-looking
requested amounts with no way to verify them against policy without accounting doing the
km-times-rate math themselves, and no record of which rate applied to a given historical
claim once the rate changes. As reimbursement moves fully off paper and the suite already
enforces an immutable, governed audit trail for financial and authorization changes
(ADR-0018, ADR-0022), mileage amounts need to be a computed, policy-derived figure rather
than free text, and the underlying per-entity rate needs an admin-governed, effective-dated
history so a rate change never silently rewrites the value of a claim that already went
through review.

## Domain language

Extends `specs/007-refund-service`'s domain language (request/expense line/expense
type/entity/currency/requested amount/approved total — reused verbatim except where
amended below) and reuses `specs/008-refund-monthly-processing`'s batch/subtotal
mechanics unchanged. New and amended terms for this feature:

- **mileage rate** — a per-kilometre monetary rate configured for one entity (WellD CH
  or WellD Italia). Two entirely independent rate series exist, one per entity — never a
  single suite-wide rate, and a change to one entity's series never affects the other's.
- **rate entry** — one point in a mileage rate's history: a positive per-km numeric
  value and a **valid-from** date, scoped to one entity. Entries accumulate as a
  history over time (see US-4); a rate entry is **append-only** — once saved, it can
  never be edited or deleted, only ever superseded by adding a new entry with its own
  `valid-from` (US-4, AC-4.7) — consistent with the suite's immutable-audit posture
  (ADR-0018/ADR-0022). A `valid-from` date may itself be in the past, present, or
  future relative to when the entry is added (US-4, AC-4.8).
- **in effect / effective rate** — for a given entity and a given date D, the rate entry
  that is "in effect" is the one with the latest `valid-from` date that is on or before
  D. If no entry for that entity has a `valid-from` on or before D, no rate is in effect
  for that (entity, date) pair (see US-2).
- **computed amount** — a `travel-km` expense line's requested amount, derived as
  `distance (km) × the rate in effect for that line's entity and expense date`;
  denominated in that entity's designated currency (see next bullet). This value is
  never typed by the employee, and is always shown together with the km × rate
  breakdown that produced it (US-1, AC-1.8).
- **entity-designated currency (mileage-only amendment to 007).** For `travel-km` lines
  only, currency is no longer an independently employee-chosen field: WellD CH →
  CHF, WellD Italia → EUR, always. This is a narrow, type-scoped reversal of 007's
  2026-07-17 amendment, which decoupled currency from entity for every line
  suite-wide. Non-mileage lines are entirely unaffected: currency remains an
  independent, manually-entered field for every other expense type, exactly as 007
  left it.
- **snapshot** — the point at which a mileage line's computed amount becomes fixed and
  is thereafter immune to later mileage-rate changes, guaranteed no later than that
  line's first transition to `submitted` (007). The exact moment within the draft
  lifecycle at which the value is pinned is an open question (see Open questions); what
  is NOT open is the observable guarantee itself (see US-3).

**Supersession note:** this spec supersedes 007's Non-goal "a configurable mileage
rate or any auto-computed requested amount" and 007's Constraints bullet "there is no
mileage-rate configuration" — both are reversed as of this feature, for `travel-km`
lines only.

## User stories

### US-1: Employee enters distance instead of amount for a mileage line

As an employee, I want to just record how far I drove and have wellD's actual mileage
policy compute what I'm owed, so that I don't have to look up or calculate the rate
myself and my claim always reflects current policy while I'm still drafting it.

**Acceptance criteria:**
- AC-1.1: Given a `draft` request, when the employee sets an expense line's type to
  `travel-km`, then the amount and currency input fields are hidden (not merely
  disabled) and replaced by a read-only **computed amount** display; distance (km)
  remains the only value the employee directly enters toward that line's monetary
  figure.
- AC-1.2: Given a `draft` `travel-km` line with a rate in effect (US-2) for its current
  entity and expense date, when the employee enters or changes its distance (km), then
  the displayed computed amount updates live (`km × effective rate`) without requiring
  a page reload or explicit save action.
- AC-1.3: Given a `draft` `travel-km` line, when the employee changes its entity or its
  expense date, then the computed amount re-resolves against whichever rate is in
  effect for the NEW entity/date combination and updates live, exactly as in AC-1.2.
- AC-1.4: Given a `draft` `travel-km` line, when the employee enters a distance of zero
  or a negative value, then submission of the containing request is refused with a
  clear message identifying the line — this preserves 007's AC-1.2 `km > 0` rule
  unchanged.
- AC-1.5: Given a `draft` expense line of any type OTHER than `travel-km`, when the
  employee fills it in, then amount and currency behave exactly as 007 specified —
  manually typed, independently chosen, unaffected by this feature.
- AC-1.6: Given a `travel-km` line's currency, then it is always exactly its entity's
  designated currency (WellD CH → CHF, WellD Italia → EUR) — it is never independently
  selectable by the employee, unlike every other expense type's currency field
  (AC-1.5).
- AC-1.7: Given a `travel-km` line that already existed in `draft` status before this
  feature shipped (created under 007's manual-amount behavior), when the employee next
  opens it, then it presents with this feature's computed-amount UI (AC-1.1–AC-1.3) —
  any previously manually-typed amount/currency on that draft line is superseded by the
  computed value the moment its km/entity/date are resolved under these rules. A
  `travel-km` line that has EVER been submitted (submitted/approved/rejected/paid,
  including one later withdrawn back to `draft`) before this feature shipped is never
  touched by this migration — its stored amount/currency remain exactly as recorded,
  permanently (see US-3, and Non-goals).
- AC-1.8: Given a `draft` `travel-km` line with a computed amount showing, when the
  employee views it, then it is displayed together with the breakdown that produced
  it — the distance (km), the per-km rate applied, and the resulting amount — never
  just the resulting figure in isolation.

### US-2: Mileage rate resolution, and what happens when none is configured

As an employee (and, functionally, as the system on their behalf), I want the correct
per-km rate for my line's entity and date to be found automatically, and to be told
clearly if wellD hasn't configured one yet, so that I never submit a claim with a
silently wrong or missing amount.

**Acceptance criteria:**
- AC-2.1: Given a `travel-km` line's entity and expense date, when its computed amount
  is derived, then the rate used is the entity's rate entry with the latest
  `valid-from` date that is on or before the line's expense date (Domain language:
  "in effect").
- AC-2.2: Given a `travel-km` line whose entity has NO rate entry at all, or whose
  earliest rate entry's `valid-from` date is AFTER the line's expense date, when the
  computed amount would be derived, then no amount can be computed — the UI clearly
  shows this to the employee on the line itself, and submission of the containing
  request is refused with a clear message identifying the affected line(s), mirroring
  007's AC-1.6 incomplete-line submission block.
- AC-2.3: Given the two entities' rate series (WellD CH, WellD Italia), then they are
  resolved completely independently — configuring, changing, or leaving unconfigured
  one entity's rate history has no effect on the other entity's line resolution.
- AC-2.4: Given a `draft` `travel-km` line whose expense date or entity is edited after
  a computed amount was already showing, then AC-2.1/AC-2.2 are re-evaluated against
  the new entity/date pair — a line that previously had a computed amount can become
  blocked (AC-2.2) by an edit, and vice versa.

### US-3: A submitted mileage line's amount never moves under it

As an employee and as accounting, I want a mileage line's claimed/approved amount to
stay exactly what it was once the request has been submitted, so that adding or
changing wellD's mileage rate later never silently rewrites a claim that's already in
review, decided, or paid.

**Acceptance criteria:**
- AC-3.1: Given a `travel-km` line belonging to a request that has ever reached
  `submitted` status (including `approved`, `rejected`, or `paid`, and including one
  later withdrawn back to `draft`), when an admin subsequently adds a new rate entry
  or the rate configuration otherwise changes for that line's entity, then that
  specific line's already-fixed amount does NOT change — it remains exactly what it
  was at the point it was snapshotted (see Domain language, and Open questions for the
  exact moment).
- AC-3.2: Given a `travel-km` line that has NEVER been submitted, or one whose request
  has been withdrawn back to `draft` (007 AC-2.2) and not yet resubmitted, when a rate
  change occurs for its entity, then its displayed computed amount DOES recompute live
  against the newly effective rate for its date (US-1/US-2) — unlike AC-3.1, an
  unsubmitted or withdrawn-to-draft line is never snapshotted and always reflects
  current rate configuration until its next submission.
- AC-3.3: Given a `travel-km` line whose containing request has reached `approved`,
  `rejected`, or `paid` (007/008), when its detail is viewed by the employee or by
  accounting, then the amount shown is exactly the snapshotted value from AC-3.1 — it
  is never recomputed from live rate configuration for display purposes either.

### US-4: Admin configures and evolves each entity's mileage rate over time

As an admin, I want to set WellD CH's and WellD Italia's per-km rates and change them
over time without disturbing past claims, so that the app always reflects wellD's
current reimbursement policy going forward while preserving history.

**Acceptance criteria:**
- AC-4.1: Given an authorized admin, when they open mileage rate management, then they
  see, per entity, the full history of rate entries (value + `valid-from` date),
  ordered chronologically.
- AC-4.2: Given an authorized admin, when they add a new rate entry for an entity
  (a positive per-km value and a `valid-from` date), then it is persisted as part of
  that entity's rate history (AC-4.1) and becomes available for resolution (US-2) for
  any expense date on or after its `valid-from`.
- AC-4.3: Given an entity's rate history, when an authorized admin views it, then the
  entry currently in effect as of today (Domain language: "in effect") is clearly
  distinguished from past entries.
- AC-4.4: Given an authorized admin adds a rate entry with a `valid-from` date in the
  future (after today), when that entry is saved, then it does NOT retroactively
  become effective for any date before its `valid-from` — a `draft` line dated before
  that future `valid-from` continues to resolve (US-2) against whichever rate was
  already in effect for its own date, unaffected by the future entry until that date
  arrives.
- AC-4.5: Given an authorized admin attempts to add a rate entry with a non-positive
  value or a missing/invalid `valid-from` date, then the attempt is rejected with a
  clear message and nothing is persisted.
- AC-4.6: Given a user who is NOT authorized to manage mileage rates, when they attempt
  to view rate history or add a rate entry via the UI or its underlying API directly,
  then the action is denied — the exact permission/capability mechanism gating this is
  an open question for the plan (see Open questions and Constraints).
- AC-4.7: Given a saved rate entry, then it can never be edited or deleted through the
  UI or its underlying API, by any user including an admin — no such action is offered
  or accepted; the only way to change policy going forward is to add a NEW entry
  (AC-4.2) with its own `valid-from`. This is enforced, not merely a UI convention,
  mirroring the suite's append-only, immutable-audit posture (ADR-0018/ADR-0022).
- AC-4.8: Given an authorized admin adds a rate entry whose `valid-from` date is in the
  PAST (before today), when it is saved, then it is accepted and immediately becomes
  part of that entity's resolvable history (AC-4.2) — it is used for resolution
  (US-2) by any still-`draft` or newly-created `travel-km` line dated on or after it —
  but it never disturbs a line that has already been snapshotted (US-3, AC-3.1): a
  backdated entry can change what a currently-`draft` line's computed amount evaluates
  to, but it can never change what an already-submitted line's fixed amount was.

### US-5: Rate changes are auditable

As wellD, we want every mileage-rate entry recorded immutably with who added it and
when, so that the policy driving computed reimbursement amounts is exactly as
governable and accountable as the rest of the suite's financial and authorization
history.

**Acceptance criteria:**
- AC-5.1: Given an admin adds a rate entry (AC-4.2), when it is saved, then an audit
  entry is recorded capturing the actor, timestamp, the entity, the rate value, and the
  `valid-from` date.
- AC-5.2: Given a recorded rate-change audit entry, when accessed through the system,
  then it cannot be edited or deleted by any user, including an admin — mirroring the
  suite's existing immutable-audit posture (ADR-0018, ADR-0022).
- AC-5.3: Given an authorized admin, when they open the rate audit history, then they
  see the chronological list of every rate change (who, when, entity, value,
  `valid-from`), for both entities.

### US-6: Computed mileage amounts flow through review and batch processing like any other line

As accounting, I want a mileage line's computed amount to behave exactly like a
manually-entered line's amount everywhere downstream, so that reviewing, deciding, and
compiling requests doesn't require special-casing mileage.

**Acceptance criteria:**
- AC-6.1: Given a `submitted` request containing one or more `travel-km` lines, when
  accounting reviews it, then each mileage line's approved-total field is editable
  exactly as 007's AC-7.1 already specifies for every line — accounting may lower,
  raise, or zero it independently of the computed requested amount; the computed amount
  is never enforced as a ceiling or floor on the approved total.
- AC-6.2: Given a request's per-currency subtotal (007 AC-3.5/AC-6.6), when it includes
  one or more `travel-km` lines, then their (computed, and once snapshotted, fixed)
  amounts contribute to the SAME per-currency subtotal as any other line sharing that
  currency — there is no separate mileage grouping or subtotal.
- AC-6.3: Given a compiled monthly batch (008) that includes one or more `travel-km`
  lines, when its per-employee, per-currency totals are produced, then those lines'
  snapshotted amounts are included exactly as any other line's — no distinct handling,
  labeling, or exclusion exists for mileage in the compiled PDF or batch totals.
- AC-6.4: Given a `travel-km` line under review, when an accounting user opens the
  containing request (whatever its status — `submitted`, `approved`, `rejected`, or
  `paid`), then they see the specific rate that was applied to that line — its per-km
  value and its `valid-from` date — displayed alongside the (computed or snapshotted)
  amount, not just the resulting figure in isolation.

## Non-goals

- **Currency conversion or FX between the two rate series (CHF vs EUR), or across any
  currency.** None is performed anywhere in this feature — a mileage line's amount
  stays permanently in its entity-designated currency (AC-1.6), exactly like 007's
  existing no-conversion rule for every line.
- **Retroactive recompute of any line that has ever been submitted.** A rate addition
  or change never rewrites the amount of a submitted/approved/rejected/paid `travel-km`
  line (US-3) — this is a hard guarantee, not a best-effort one.
- **Per-user, per-vehicle, per-trip-type, or otherwise more granular rates.** Exactly
  one rate series per entity (two total); no per-employee or per-vehicle-class
  variation is introduced.
- **Backfilling or retroactively correcting existing, already-submitted mileage
  lines.** A `travel-km` line that reached `submitted` (or any later status) before
  this feature shipped keeps its manually-entered amount and currency exactly as
  originally recorded, permanently — this feature never touches historical financial
  records, only lines still in (or returning to) `draft` from this point forward
  (AC-1.7).
- **A scheduled/cron job that "activates" a rate entry on its `valid-from` date.** The
  effective rate for any (entity, date) pair is always computed on read (AC-2.1), never
  written or flipped by a background process — mirrors the suite's existing
  derived-state posture (ADR-0013).
- **Editing or deleting a saved rate entry.** Rate entries are strictly append-only
  (AC-4.7) — a correction is always a new entry with its own `valid-from`, never an
  in-place edit or delete, mirroring the suite's immutable-audit posture
  (ADR-0018/ADR-0022).
- **Any change to non-`travel-km` expense types**, their manual amount/currency entry,
  or the twelve-type catalog itself (007) — entirely out of scope and unaffected.
- **Any change to the `km` field's existing role for audit/reference purposes** beyond
  now also driving the computed amount — the field itself, and its `> 0` validation,
  are unchanged (AC-1.4).
- **A separate or multi-stage review/approval workflow specific to mileage lines.**
  Accounting's existing single-decision workflow (007 US-7) covers `travel-km` lines
  exactly like any other line (AC-6.1).
- **Deciding whether mileage-rate management needs a new permission or reuses an
  existing admin capability.** Flagged for the architect at the plan stage (see Open
  questions) — not decided here.

## Constraints

*Facts already established by the codebase/prior specs, captured verbatim for the
plan, not elaborated here.*

- This spec extends `specs/007-refund-service`'s expense-line domain (entity, currency,
  requested amount, approved total, the twelve expense types) and reuses
  `specs/008-refund-monthly-processing`'s batch/subtotal mechanics unchanged, except
  where explicitly amended above (entity-designated currency for `travel-km` only).
- This spec supersedes 007's Non-goal "a configurable mileage rate or any
  auto-computed requested amount" and 007's Constraints bullet "there is no
  mileage-rate configuration" — both are reversed, for `travel-km` lines only.
- Only two entities exist (WellD CH, WellD Italia; specs/007) — mileage rate
  configuration needs exactly two independent per-entity rate series, never more.
- Admin-only management surfaces in the suite are gated through specs/004's
  role/department/permission catalog model (admin-ui + auth `/admin` API). Whether
  mileage-rate management needs a new catalog permission or reuses an existing
  admin-scoped capability is the plan/architect's call (see Open questions), not
  decided here.
- The suite's established posture for financial/governance record history is
  DB-level append-only immutability (ADR-0018, extended by ADR-0022) and derived,
  not scheduled, state resolution (ADR-0013). This feature's rate history is
  append-only by product decision (AC-4.7) and its effective-rate resolution is
  always computed on read (AC-2.1); the exact schema/enforcement mechanism is the
  plan's call.
- A rate entry's `valid-from` date may be in the past, present, or future relative to
  when it is added (AC-4.8) — no restriction on backdating is imposed by this spec.
- Twelve expense types exist (007, unchanged); only `travel-km` is affected by this
  feature — every other type's behavior is untouched.
- Currency values in use suite-wide remain EUR/CHF/USD/GBP (007); this feature only
  fixes `travel-km` lines to their entity's currency (CHF or EUR) — it does not
  introduce, remove, or otherwise touch USD/GBP handling.

## Open questions

- [ ] Exact snapshot moment: is a `travel-km` line's computed amount fixed the instant
  it is saved as part of ordinary draft editing, or specifically pinned only at the
  request's transition to `submitted`? This matters for a line that's withdrawn back
  to `draft` (US-3, AC-3.2) and resubmitted without further edits. — owner: architect
  (plan)
- [ ] Whether mileage-rate management requires a NEW permission/catalog entry in
  specs/004's authorization model, or reuses an existing admin-scoped capability (and
  if new, whether it should be entity-scoped like `accounting`'s condition, or global
  admin-only). — owner: architect (plan)
- [ ] Rounding/precision convention for the computed amount (`km × rate`) — number of
  decimal places and rounding rule to apply, per currency. — owner: architect (plan)
