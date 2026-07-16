---
id: 007
slug: refund-service
status: in-progress
rigor: production
created: 2026-07-16
approved: 2026-07-16
---

# Refund service (Rimborsi): expense requests, expense lines & accounting review

## Problem

wellD employees today submit expense reimbursements ("Richiesta Rimborsi Spese") on a
fillable PDF form, filled out by hand, emailed or handed to accounting, tracked nowhere
but that file and whoever's inbox holds it. An employee has no way to see what happened
to a request after sending it — whether it was received, whether the amount claimed was
the amount approved, or why something was rejected — short of asking. Accounting has no
queue: pending requests exist only as scattered PDFs, with no consolidated view of what
needs a decision, no structured way to record a per-line approved amount that differs
from what was claimed, and no required, recorded reason when a claim is rejected. There
is no audit trail of who approved or rejected what, or when — a real gap given this is
financial data that is eventually reflected on an employee's paycheck. As the Operai
suite already gives wellD a place to put structured, authenticated, role-gated tools
(`refund-ui`/`refund-api` are scaffolded but not yet real), the reimbursement workflow
itself — an employee raising one or more requests, each with its expense lines, and
accounting reviewing and deciding them — needs to move off paper and into the suite.

## Domain language

Terms used throughout (to be reused in the plan, APIs, and UI copy):

- **refund request** ("richiesta rimborsi spese") — a single submission by one employee,
  containing one or more expense lines, that moves through review as a unit. A single
  request MAY contain lines for both entities (see **entity** below) — entity is chosen
  per line, not per request.
- **expense line** — one claimed expense within a request: a date, an expense type, a
  `motivo` (reason/description), a requested amount, a company entity, `km` (mileage
  type only), and zero or more attachments. Attachments are always optional — never
  required to submit (see US-1, AC-1.7).
- **expense type** — one of twelve fixed categories, carried over from the paper form:

  | # | English identifier | Italian label (source form) |
  |---|---|---|
  | 1 | travel-highway | spese di viaggio (autostrada) |
  | 2 | travel-km (mileage) | spese di viaggio (km) |
  | 3 | travel-parking | spese di viaggio (parcheggio) |
  | 4 | travel-train | spese di viaggio (treno) |
  | 5 | travel-other-public-transport | spese di viaggio (altri mezzi pubblici) |
  | 6 | company-manuals | spese manualistica societaria |
  | 7 | stationery | spese di cancelleria |
  | 8 | representation-meals | spese di rappresentanza (pranzi/cene/aperitivi) |
  | 9 | representation-gifts | spese di rappresentanza (regali) |
  | 10 | office-material | spese materiale ufficio |
  | 11 | postal | spese postali |
  | 12 | telephone | spese telefoniche |

- **entity** — the wellD legal entity an expense line is claimed against: WellD Italia
  (EUR) or WellD CH (CHF); carried per line, exactly as the source PDF's per-line
  checkboxes. A request's lines may mix both entities; there is never a combined,
  cross-currency total for a request — only **per-currency subtotals** (below).
- **per-currency subtotal** — for a request, the sum of its lines' requested amounts (and,
  once decided, approved totals) grouped by entity/currency — one subtotal for its WellD
  Italia (EUR) lines, one for its WellD CH (CHF) lines. No currency conversion is ever
  performed and no single blended total is computed or shown (see Non-goals).
- **requested amount** — the amount the employee claims for a line (the PDF's `totale`),
  always entered directly by the employee — including for `travel-km` lines, where `km`
  is recorded alongside it for reference/audit only, not used to compute the amount (no
  mileage-rate configuration exists — see Constraints).
- **approved total** — the amount accounting records for a line after review (the PDF's
  `approvato`); may equal, be less than, or (rarely) exceed the requested amount.
- **request status** — `draft` (being composed, visible only to its owner), `submitted`
  (locked, in accounting's queue, awaiting a decision), `approved` (accounting accepted
  it, per-line approved totals are final), or `rejected` (accounting declined it, a
  motivation is recorded). There is no separate `withdrawn` status: **withdraw** is an
  ACTION (see US-2, AC-2.2), not a persisted status — it returns a `submitted`,
  not-yet-decided request to `draft`, and is itself recorded in the audit trail (US-8)
  like any other request-affecting action.
- **decision** — accounting's single, request-level outcome (approve or reject), distinct
  from the per-line approved totals it may carry (see US-7). A decision always covers the
  WHOLE request, including any lines for an entity outside the deciding accounting user's
  own scope (see **accounting**, below, and US-6/US-7) — decisions are never partial by
  entity or by line.
- **rejection motivation** — the mandatory free-text reason accounting records when
  rejecting a request.
- **monthly processing** — the (separately specced, see Non-goals) cadence by which
  `approved` requests are compiled and eventually appear on an employee's paycheck. This
  spec's own scope stops at the `approved` state; it does not compile, pay, or mark
  anything "paid", and does not display or enforce any monthly cutoff date.
- **employee** — the default role every Operai user holds; once granted refund access
  (NOT automatic merely from holding `employee` — see Constraints), can create and submit
  their own requests.
- **accounting** — the role, granted by an admin (specs/004), that reviews and decides
  requests. An accounting user is scoped to one or both entities (WellD Italia, WellD CH,
  or both — "global"), reusing specs/004's existing entity attribute condition; this
  scope determines which requests appear in their queue and which they may open/decide
  (see US-5/US-6/US-7). Distinct from `admin`: holding `admin` does not by itself grant
  the `accounting` role's review/decision capability (specs/004's model — app access and
  domain permissions are separate grants).

## User stories

### US-1: Employee composes a refund request with multiple expense lines

As an employee, I want to build a refund request out of one or more expense lines before
sending it anywhere, so that I can assemble a complete claim (possibly over several
sessions) before committing it to review.

**Acceptance criteria:**
- AC-1.1: Given a signed-in employee holding refund access (see Constraints), when they
  start a new refund request, then it is created in `draft` status, visible only to them,
  and not yet in accounting's queue.
- AC-1.2: Given a `draft` request, when the employee adds an expense line, then they can
  set its date, expense type (one of the twelve, US domain language), `motivo`, requested
  amount, and entity (WellD Italia or WellD CH); `km` is additionally required, and must
  be greater than zero, only when the expense type is `travel-km`, and is inapplicable
  (not shown/not required) for every other type. The requested amount is always typed in
  directly by the employee, including for `travel-km` lines — it is never auto-computed
  from `km` (no mileage-rate configuration exists in this spec).
- AC-1.3: Given a `draft` request, when the employee attaches one or more receipt files
  to an expense line, then those attachments are associated with that specific line, and
  the employee can remove an attachment they added before submission.
- AC-1.4: Given a `draft` request, when the employee edits or deletes an expense line, or
  deletes the whole request, then the change is saved (or the request/line is gone) with
  no involvement from accounting. A draft that has never been submitted can be freely
  edited or deleted. Once a request has been submitted at least once (even if later
  withdrawn back to `draft`), it retains its audit history and can no longer be
  hard-deleted — an attempt returns a 409; it may still be edited and re-submitted.
- AC-1.5: Given a `draft` request with zero expense lines, when the employee attempts to
  submit it (US-2), then submission is refused with a clear message — a request needs at
  least one expense line to be submitted.
- AC-1.6: Given an expense line missing a required field for its type (date, type,
  `motivo`, requested amount, entity, or `km` for mileage), when the employee attempts to
  submit the containing request, then submission is refused and the incomplete line(s)
  are identified to the employee. Attachments are never part of this required-field check
  (see AC-1.7).
- AC-1.7: Given a `draft` request in which one, several, or all expense lines have no
  attachments at all, when the employee submits it, then submission proceeds normally —
  attaching a receipt is always optional and never blocks submission (accounting may
  still reject a request for insufficient evidence, per US-7).

### US-2: Employee submits, withdraws, and re-edits a request before a decision

As an employee, I want to submit a completed request for review, and pull it back if I
made a mistake before accounting has acted, so that review only happens on requests I
actually intend accounting to see, and a slip-up doesn't require accounting intervention
to fix.

**Acceptance criteria:**
- AC-2.1: Given a valid `draft` request (US-1's requirements met), when the employee
  submits it, then it transitions to `submitted`, becomes read-only to the employee (its
  lines, amounts, entities, and attachments can no longer be edited or removed), and
  becomes visible in accounting's review queue (US-5).
- AC-2.2: Given a `submitted` request that accounting has not yet decided, when the
  employee withdraws it, then it transitions back to `draft` — editable again exactly as
  in US-1, except that, because the submission is recorded in the audit trail (US-8), the
  request can no longer be deleted (a delete attempt returns 409); it can still be edited
  and re-submitted — and it disappears from accounting's queue immediately. Withdraw is
  an action on an existing request, not a distinct status the request ends up in (see
  Domain language).
- AC-2.3: Given a request already `approved` or `rejected`, when the employee attempts to
  edit, delete, or withdraw it, then the action is refused — a decided request is
  terminal and immutable (see Non-goals on in-place resubmission).
- AC-2.4: Given a `rejected` request, when the employee wants to claim the same or
  corrected expenses, then they do so by creating a brand-new request (US-1) — a rejected
  request itself is never edited or resubmitted in place.
- AC-2.5: Given any request regardless of status, when a user other than its owning
  employee (and not holding `accounting`) attempts to view, edit, submit, or withdraw it,
  then the action is denied.

### US-3: Employee tracks status and outcome of their own requests

As an employee, I want to see all my requests and what happened to each one, so that I
know what's pending, what was approved (and for how much), and why anything was
rejected, without having to ask accounting.

**Acceptance criteria:**
- AC-3.1: Given an employee with one or more requests in any status, when they open their
  requests list, then every request they own is listed with, at minimum, its status and
  last-updated date — and no other employee's requests appear.
- AC-3.2: Given an `approved` request, when the employee opens its detail, then they see
  each line's requested amount alongside its approved total, so they can see exactly
  where (if anywhere) an amount was adjusted.
- AC-3.3: Given a `rejected` request, when the employee opens its detail, then they see
  the rejection motivation accounting recorded.
- AC-3.4: Given a `submitted` request awaiting a decision, when the employee opens its
  detail, then it clearly reads as pending — not conflated with `approved` or `rejected`.
- AC-3.5: Given a request containing lines for both entities, when the employee opens its
  detail, then requested amounts (and, once decided, approved totals) are shown as
  separate per-currency subtotals (EUR for WellD Italia lines, CHF for WellD CH lines) —
  never combined into one cross-currency figure.
- AC-3.6: Given a request transitions to `approved` or `rejected`, when the decision is
  saved, then the requesting employee is sent a notification through the suite's existing
  notification center (ADR-0009/notify-api) reflecting the outcome — this is a push,
  observable without the employee having to revisit the request list to discover it.

### US-4: Employee understands monthly processing

As an employee, I want to know that approved reimbursements aren't paid out instantly,
so that I don't expect an approved request to show up on my very next paycheck if
processing hasn't run yet.

**Acceptance criteria:**
- AC-4.1: Given an `approved` request, when the employee views it, then the UI states
  that approved requests are compiled and reflected on paychecks on a monthly cadence —
  without promising, computing, or displaying a specific payroll date or paycheck amount,
  and without any submission/decision cutoff date (that compilation and any cutoff are
  out of this spec's scope — see Non-goals).
- AC-4.2: Given any request in `draft` or `submitted` status, then no such
  monthly-payroll messaging is shown — it only applies once a decision (`approved`) has
  been made.

### US-5: Accounting sees a queue of requests awaiting decision, scoped to their entity

As an accounting user, I want a single place listing every request awaiting my decision
that's actually relevant to the entity/entities I handle, so that nothing is reviewed
off a scattered inbox, I'm not shown requests entirely outside my remit, and I know
what's outstanding for me.

**Acceptance criteria:**
- AC-5.1: Given an accounting user, when they open the review queue, then every
  `submitted` request containing at least one line for an entity that user is scoped to
  is listed, showing at minimum the requesting employee, submission date, and (per
  AC-5.2) enough summary to prioritize.
- AC-5.2: Given the review queue, when an accounting user views it, then `draft`,
  `approved`, and `rejected` requests are NOT mixed into it — the queue is exactly the
  set of requests currently `submitted` and awaiting a decision that are also within
  that user's entity scope. (A withdrawn request is, by definition, back in `draft` —
  see Domain language — so it is excluded via the `draft` exclusion, not as a separate
  case.)
- AC-5.3: Given a request that was `submitted` and then withdrawn by its owner (US-2),
  when the queue is next viewed, then it is no longer present.
- AC-5.4: Given a non-`accounting` user (an employee without that role), when they
  attempt to open the review queue or its underlying API directly, then access is denied.
- AC-5.5: Given an accounting user scoped to BOTH entities ("global"), when they open the
  queue, then it contains every `submitted` request regardless of which entity/entities
  its lines belong to — equivalent to no scoping restriction at all.
- AC-5.6: Given an accounting user scoped to a single entity, when a `submitted` request
  contains lines for ONLY the other entity (none for the user's scoped entity), then that
  request does not appear in their queue at all.

### US-6: Accounting inspects a request's full detail before deciding

As an accounting user, I want to see every line of a request — including its
attachments — before I decide it, so that my decision is based on the actual claim and
supporting receipts, not a summary.

**Acceptance criteria:**
- AC-6.1: Given a `submitted` request, when an accounting user opens it, then they see
  every expense line's date, type, `motivo`, requested amount, entity, and `km` (where
  applicable), plus the requesting employee's identity.
- AC-6.2: Given an expense line with one or more attachments, when an accounting user
  opens the request, then they can view/download each attachment.
- AC-6.3: Given a request that is already `approved` or `rejected`, when an accounting
  user opens it, then they see the same full detail (US-3.2/US-3.3's outcome) in a
  read-only view — past decisions remain inspectable, not just pending ones.
- AC-6.4: Given an accounting user whose entity scope matches NONE of a request's lines,
  when they attempt to open that request directly (e.g. a deep link), then access is
  denied — mirroring the queue's scoping (US-5), not just its listing.
- AC-6.5: Given an accounting user whose entity scope matches AT LEAST ONE of a request's
  lines, when they open it, then they see ALL of that request's lines in full — including
  any line for an entity outside their own scope — access is granted at the whole-request
  level, never filtered down to only the lines matching their scope, because the eventual
  decision is per-request, not per-line (US-7).
- AC-6.6: Given a request containing lines across both entities, when its detail is
  viewed by an accounting user, then requested amounts (and, once decided, approved
  totals) are shown as separate per-currency subtotals, exactly as the employee sees them
  (AC-3.5) — never a combined cross-currency figure.

### US-7: Accounting sets approved amounts and decides a request

As an accounting user, I want to record what I'm actually approving per line and then
approve or reject the request as a whole — with a required reason when I reject — so
that the outcome is precise, traceable, and every rejection is explained.

**Acceptance criteria:**
- AC-7.1: Given a `submitted` request under review, when an accounting user reviews it,
  then each expense line has an editable approved-total field, defaulting to that line's
  requested amount, that the accounting user may lower, raise, or set to zero
  independently per line.
- AC-7.2: Given a `submitted` request with per-line approved totals set (or left at their
  defaults), when the accounting user approves the request, then it transitions to
  `approved`, each line's final approved total is recorded exactly as set (defaulting to
  the requested amount for any line left untouched), and the identity of the approving
  accounting user plus the decision timestamp are recorded.
- AC-7.3: Given a `submitted` request, when the accounting user instead rejects it, then
  they must supply a non-empty rejection motivation before the rejection is accepted; the
  request transitions to `rejected`, the motivation plus the rejecting user's identity and
  timestamp are recorded, and per-line approved totals are not applicable to a rejected
  request.
- AC-7.4: Given a request already `approved` or `rejected`, when an accounting user
  attempts to change its decision, its per-line approved totals, or the rejection
  motivation, then the action is refused — a decision, once made, is terminal (no
  re-approve, re-reject, or undo).
- AC-7.5: Given a non-`accounting` user, when they attempt to set an approved total or
  approve/reject a request via the UI or its underlying API directly, then it is denied.
- AC-7.6: Given a request accessible to a deciding accounting user under AC-6.5 (their
  scope matches at least one of its lines), when they approve or reject it, then the
  decision applies to the WHOLE request, including any lines for an entity outside their
  own scope — an accounting user is never restricted to deciding only the subset of lines
  matching their own scope; decisions are never partial by entity.

### US-8: Financial audit trail of accounting decisions

As wellD, we want every accounting decision on a refund request recorded immutably, so
that approvals and rejections of financial claims are governable and accountable after
the fact.

**Acceptance criteria:**
- AC-8.1: Given a request transitions to `submitted`, `approved`, or `rejected`, is
  withdrawn back to `draft` (US-2, AC-2.2), or any expense line's approved total is
  set/changed during review, then an audit entry is recorded capturing the actor,
  timestamp, the affected request/line, and what changed (including the rejection
  motivation, when applicable).
- AC-8.2: Given a recorded audit entry, when accessed through the system, then it cannot
  be edited or deleted by any user, including `accounting` or `admin`.
- AC-8.3: Given a request that has reached `approved` or `rejected`, when anyone
  attempts to delete the request itself, then the action is refused — decided requests
  (and their audit history) are retained, not removable, mirroring the rest of the suite's
  treatment of financial/authorization-relevant records (specs/004 US-5, specs/006 soft
  deletion).
- AC-8.4: Given a request has been submitted at least once, then its submission audit
  entry (AC-8.1) is permanent, even if the request is later withdrawn back to `draft`
  (US-2) — this is precisely why such a request can no longer be hard-deleted (AC-1.4,
  AC-2.2): deleting it would orphan or destroy audit history that must outlive the
  request's current status, consistent with audit entries never being editable or
  deletable (AC-8.2).

## Non-goals

- **Monthly compilation into a PDF/output, emailing it to accounting or the employee,
  and marking a request "paid".** This spec's terminal, in-scope states are `approved`
  and `rejected`; turning approved requests into the monthly payroll artifact is a
  follow-up spec — confirmed deferred.
- **Payroll/paycheck system integration.** This spec produces the approved reimbursement
  data; actually posting an amount onto an employee's paycheck happens outside Operai.
- **A monthly submission/decision cutoff date shown or enforced in-app.** No cutoff is
  displayed or computed by this feature; any payroll-cycle assignment of an approved
  request happens entirely outside the app (see AC-4.1).
- **A configurable mileage rate or any auto-computed requested amount.** The employee
  always types in the requested amount directly, including for `travel-km` lines; `km`
  is recorded for reference/audit only (AC-1.2). No rate table/config is introduced.
- **In-place resubmission or editing of a `rejected` request.** A rejection is terminal
  (AC-2.3/AC-2.4); a corrected or repeated claim is always a new request. (A convenience
  "duplicate this request's lines into a new draft" affordance is not excluded by this
  spec, but is not required by it either.)
- **Cross-employee visibility for the employee role.** An employee only ever sees their
  own requests (AC-3.1), never a colleague's — no manager or team-lead view is introduced
  here.
- **Multi-stage or manager approval chains.** A single `accounting` decision (approve or
  reject) is authoritative; no pre-approval or escalation step precedes it.
- **Currency conversion or a cross-currency blended total.** Mixed-entity requests are
  explicitly ALLOWED, per line (see Domain language, AC-3.5, AC-6.6) — but amounts are
  always recorded and shown in the currency implied by each line's entity (EUR for WellD
  Italia, CHF for WellD CH), only ever subtotaled per currency; no conversion is
  performed and no single blended cross-currency total is ever computed or displayed.
- **The admin roles/departments/permissions GUI.** It already exists (specs/004); this
  spec only requires that refund's real permission catalog (create/list-own request,
  review/set-approved-total, approve, reject) be declarable and assignable through that
  existing GUI — not that the GUI itself changes.
- **Automatic refund access for every `employee`.** Holding the baseline `employee` role
  does not by itself grant refund access — see Constraints; this spec does not change the
  suite's admin-assigns-access convention (specs/004) to make any app opt-out/automatic.
- **Delegation or out-of-office reassignment of accounting review duties.**
- **Rate-limiting or anti-abuse protection** on request/line creation — an operational
  concern for the plan stage, not specified as a product requirement here (mirrors
  specs/006's stance on invitation creation).
- **Reimbursement in any entity/currency beyond WellD Italia and WellD CH.**

## Constraints

*Facts already established by the codebase/domain and the calling brief, plus decisions
made at the approval gate (2026-07-16) and the Gate 2 drift-review consistency fixes
below; captured verbatim for the plan, not elaborated here.*

- The reimbursement domain (request → expense lines, the twelve expense types, per-line
  `motivo`/`km`/entity/attachments, accounting's per-line approved total) replaces the
  existing fillable PDF `form_richiesta_rimborso_spese_WellD_A4_compilabile.pdf`, whose
  field set is the source of the domain language above.
- Refunds are **processed monthly**; approved requests are what eventually appear on an
  employee's **paycheck** (the compilation step itself is out of this spec's scope — see
  Non-goals); no cutoff date is shown or enforced by this feature.
- Roles `employee` and `accounting` already exist (specs/004, `auth/src/authz/seed.ts`);
  every user gets `employee` by default, `accounting` is admin-granted. This spec does
  not create new roles, only (at the plan stage) declares `refund`'s real permission
  catalog against those existing roles, replacing its current access-only stub entry.
- **Holding the `employee` role does not by itself grant refund access.** Consistent
  with the rest of the suite (specs/004), refund app-access and the create/list-own
  request permissions are admin-assigned per user/role through the existing specs/004
  admin GUI — they are NOT automatic merely from being a signed-in Operai user. Every AC
  above phrased as "a signed-in employee" (e.g. AC-1.1) presumes that grant is already in
  place; it does not promise the grant itself. The `accounting` role's admin-granted
  nature (already established) is unchanged by this note.
- **There is no persisted `withdrawn` request status.** The request status enum is
  exactly `draft` / `submitted` / `approved` / `rejected` (four values). Withdraw (US-2,
  AC-2.2) is an ACTION that transitions a `submitted`, not-yet-decided request back to
  `draft`; it is audited (AC-8.1) like any other request-affecting action, but a
  withdrawn request's resulting, persisted status is `draft`, not a distinct value.
- `refund-ui` (federated remote) and `refund-api` (planned JWKS resource server,
  Bun+Hono+Prisma, mirroring `estimai-api`/`notify-api`) already exist as scaffolding
  under this monorepo's established Module Federation / resource-server patterns
  (ADR-0005/0006); this spec is what gives them real domain content.
- **Attachments (receipts) are stored server-side in EU-region S3-compatible object
  storage** (data residency, CLAUDE.md); `refund-api` persists metadata + object keys and
  serves them via signed/download URLs. This is a plan/architecture detail, not
  elaborated further here — attaching a receipt itself is always optional (AC-1.7).
- **Mixed-entity requests are allowed, per line.** A single request may contain lines for
  both WellD Italia and WellD CH; amounts are only ever subtotaled per currency, never
  combined into a cross-currency total (AC-3.5, AC-6.6, Non-goals).
- **There is no mileage-rate configuration.** A `travel-km` line's requested amount is
  entered directly by the employee; `km` is recorded for reference/audit only (AC-1.2).
- **Accounting review is entity-scoped.** An accounting user is scoped to one or both
  entities, reusing specs/004's existing entity attribute condition. A request is visible
  to, and fully decidable by, any accounting user scoped to AT LEAST ONE of its lines'
  entities (AC-5.1/AC-5.6, AC-6.4/AC-6.5); decisions remain whole-request and are never
  partial by entity — an accounting user with access to a mixed-entity request decides
  all of it, including lines outside their own scope (AC-7.6). A "global" accounting user
  (scoped to both entities) sees and can decide every request (AC-5.5).
- **On approve/reject, the requesting employee is actively notified** via the existing
  suite notification center (`notify-api`, ADR-0009) — a push, not merely something
  discoverable only by revisiting the request (AC-3.6).
- **A request that has been submitted at least once is never hard-deletable, even after
  being withdrawn back to `draft`** (ADR-0018): its audit trail (US-8) is immutable and
  `onDelete: Restrict`-backed, so a delete attempt on such a request returns 409; it
  remains editable and re-submittable (AC-1.4, AC-2.2, AC-8.4). Only a request that has
  NEVER been submitted can be freely deleted.

## Open questions

None — all resolved 2026-07-16.
