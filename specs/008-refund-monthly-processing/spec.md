---
id: 008
slug: refund-monthly-processing
status: in-progress
rigor: production
created: 2026-07-19
approved: 2026-07-19
---

# Refund monthly processing: PDF compilation, email delivery & "mark as paid"

## Problem

`specs/007-refund-service` moved the "Richiesta Rimborsi Spese" workflow off paper and
into Operai, but it deliberately stops at `approved` — an approved request just sits
there. Accounting has no way, inside the app, to turn a month's worth of approved
requests into the artifact they actually use to run payroll, no record of which
requests were actually put on a paycheck versus merely approved-but-still-pending
payment, and no way to tell an employee "yes, this was paid, on this date" instead of
the generic "it'll show up eventually" messaging 007's US-4 introduced. Today that final
mile — compiling, distributing, and confirming payment — still happens entirely outside
the system (a spreadsheet, an email, someone's memory), which is exactly the
scattered-and-untracked problem 007 was meant to solve, just moved one stage later in
the lifecycle. Employees are left with an `approved` request that may sit for weeks with
no further signal, and accounting has no durable record, once a payroll run has
happened, of exactly which requests it covered or that it happened at all.

## Domain language

Extends `specs/007-refund-service`'s domain language (request/line/expense
type/entity/currency/per-currency subtotal/decision — reused verbatim, not
redefined here). New terms for this feature:

- **compilation batch** (or **batch**) — the record produced each time accounting
  triggers monthly processing: a frozen set of eligible refund requests as of a chosen
  **cutoff**, together with the one generated **compiled PDF** for that set. A batch's
  request set and PDF are fixed at compile time and are never mutated in place —
  correcting a mistake means discarding the batch (see US-6), not editing it.
- **cutoff** — the point-in-time boundary accounting chooses when triggering a
  compilation (defaulting to "now"): a request is eligible for a batch only if its
  `decidedAt` (007's term) is on or before the cutoff. There is no fixed calendar-month
  bucket — a late approval simply becomes eligible for whichever batch is next
  compiled, regardless of which calendar month it lands in.
- **batch status** — `compiled` (PDF generated, requests reserved against
  double-inclusion, not yet paid), `paid` (terminal — every included request has been
  marked paid), or `discarded` (terminal — voided before being marked paid, its
  requests released back to the eligible pool for a future batch). Exactly these three
  values; no batch ever moves between them except `compiled → paid` or
  `compiled → discarded`, each exactly once.
- **compiled PDF** — the generated artifact for a batch: organized per requesting
  employee, with each employee's approved lines subtotaled per currency (reusing 007's
  per-currency-subtotal rule verbatim — never blended, never grouped by entity), plus
  the batch's cutoff, generation timestamp, generating accounting user, and a batch
  reference. It is a numeric/textual summary equivalent to the paper form's role, not a
  repackaging of individual receipt attachment files. Stored indefinitely in the same
  EU object storage refund attachments already use (007, ADR-0016), reached only
  through the short-lived signed download link described in US-3 — never emailed as a
  binary attachment.
- **accounting distribution address** — the single, deploy-configured email address
  (not a per-accounting-user address and not a role-resolved list) the compilation
  email's download link is sent to (US-3).
- **paid** — the terminal `request status` value following `approved` (extending 007's
  four-value enum), set atomically for every request in a batch the instant that batch
  is marked paid. A `paid` request is exactly as immutable as an `approved` or
  `rejected` one (007's AC-2.3 continues to apply): no further edits, no re-decision.
- **mark as paid** — the batch-level action, distinct from compiling and from emailing,
  that transitions a `compiled` batch to `paid` and every one of its included requests
  from `approved` to `paid` in one atomic step. Authorized by the exact same
  accounting/`refund-admin` capability that already gates approve/reject (007) — no
  separate, dedicated permission exists for it (see Constraints).

## User stories

### US-1: Accounting compiles this cycle's approved requests into a batch

As an accounting user, I want to compile every approved-and-not-yet-paid request as of
a point in time into a single artifact, so that I have exactly what I need to run this
cycle's payroll reimbursements without hand-collecting data from individual requests.

**Acceptance criteria:**
- AC-1.1: Given an accounting or `refund-admin` user, when they trigger a new
  compilation, then they may specify a cutoff timestamp, defaulting to the current
  moment if they don't override it.
- AC-1.2: Given a triggered compilation with its cutoff resolved, when the system
  builds the candidate set, then it includes every request that is currently `approved`
  (not `draft`/`submitted`/`rejected`/already `paid`), has `decidedAt` on or before the
  cutoff, and is not already included in any other `compiled` or `paid` batch — exactly
  the same entity-scope visibility the user already has under 007's review-queue rule
  (AC-5.1/AC-5.5/AC-5.6): an entity-scoped accounting user's batch only ever contains
  requests with at least one line in their scope, a global-scoped accounting user or a
  `refund-admin` user's batch contains every eligible request suite-wide.
- AC-1.3: Given a request with lines in more than one entity, when it is included in a
  batch under AC-1.2's "at least one line matches" rule, then the WHOLE request enters
  the batch and is later marked paid as a whole — never split or partially included by
  entity or line, mirroring 007's AC-6.5/AC-7.6 whole-request atomicity.
- AC-1.4: Given a resolved candidate set, when it is empty, then compilation is refused
  with a clear message and no batch, PDF, or email is produced — an empty batch is never
  created.
- AC-1.5: Given a non-empty candidate set, when compilation completes, then a new batch
  is created in `compiled` status, holding exactly that request set, and every included
  request becomes ineligible for any other batch's candidate set from that point on
  (AC-1.2's dedup), even before it is ever marked paid.
- AC-1.6: Given a compiled batch, when its PDF is generated, then it contains one
  section per requesting employee, each employee's approved lines subtotaled per
  currency (never blended, never grouped by entity — reusing 007's AC-3.5/AC-6.6 rule),
  and a document header showing the cutoff, the generation timestamp, the generating
  accounting user's identity, and a batch reference identifying that specific run.
- AC-1.7: Given a compiled batch's PDF, when it is generated, then it never embeds the
  original receipt attachment files/images belonging to any included line — those
  remain individually accessible through the existing per-request/per-line attachment
  view (007 AC-6.2), not folded into this artifact.
- AC-1.8: Given a non-accounting, non-`refund-admin` user, when they attempt to trigger
  a compilation via the UI or its underlying API directly, then the action is denied.
- AC-1.9: Given a request whose every line was approved at a $0 total (007 AC-7.1
  permits this), when compilation runs, then it is eligible on exactly the same terms as
  any other `approved`, not-yet-paid request — approved amount does not affect
  eligibility.
- AC-1.10: Given a compiled batch's PDF, once generated, then it is retained
  indefinitely — never deleted or expired by the system, regardless of the batch's
  eventual status (`compiled`, `paid`, or `discarded`) — mirroring 007's AC-8.3
  never-delete posture for decided/financial records.

### US-2: Accounting inspects a batch before committing to payment

As an accounting user, I want to review exactly what a compilation produced — which
requests, which employees, the PDF itself — before I treat it as final, so that a
mistake in the compiled set is caught before it's ever marked paid.

**Acceptance criteria:**
- AC-2.1: Given a `compiled` batch, when an accounting or `refund-admin` user opens it,
  then they see its cutoff, generation timestamp, generating user, the full list of
  included requests grouped by employee, and can download/preview the generated PDF.
- AC-2.2: Given a batch in any status (`compiled`, `paid`, or `discarded`), when an
  accounting or `refund-admin` user attempts to open an individual request contained in
  it, then the same entity-scope read rules already established in 007 (AC-6.4/AC-6.5)
  apply — access to that specific request is neither widened nor narrowed by virtue of
  it being part of a batch.
- AC-2.3: Given a non-accounting, non-`refund-admin` user, when they attempt to open a
  batch or its PDF via the UI or its underlying API directly, then access is denied.

### US-3: The compiled batch is emailed to accounting as a signed download link

As accounting, I want a link to the compiled PDF delivered to our accounting mailbox by
email as soon as it's generated (and re-sendable on demand), so that the artifact I
need to actually run payroll is durably reachable outside the app, not just something I
have to remember to log in and fetch.

**Acceptance criteria:**
- AC-3.1: Given a batch that just completed compilation (AC-1.5), when compilation
  finishes, then the system automatically attempts to deliver an email containing a
  short-lived, authz-gated signed download link to the compiled PDF (reusing the
  existing ADR-0016 presigned-URL pattern already used for receipt attachments — never
  the PDF itself as a binary email attachment) to the single configured accounting
  distribution address; the delivery attempt is best-effort and never blocks or fails
  the compilation itself (mirroring the suite's existing soft-failure email posture,
  ADR-0011).
- AC-3.2: Given a batch of any status, when an accounting or `refund-admin` user views
  it, then the current delivery status of its compilation email (e.g. sent vs. failed)
  is visibly shown to them.
- AC-3.3: Given a batch whose delivery failed, or one whose email an accounting user
  simply wants re-sent, when that user triggers a resend, then a fresh email containing
  a newly minted signed download link is sent to the same configured accounting
  distribution address, without re-running compilation or altering the batch's frozen
  request set or PDF — resend is available regardless of the batch's current status.
- AC-3.4: Given a batch's included requests span multiple employees, when its
  compiled-PDF email is sent, then it is delivered only to the configured accounting
  distribution address — the download link (and the PDF it resolves to) is never
  emailed, as an attachment or otherwise, to any individual employee whose request is
  included, because it necessarily also carries other employees' financial data.
- AC-3.5: Given the signed download link contained in a compilation email, when anyone
  attempts to use it, then it only ever resolves to the PDF after the same
  accounting/`refund-admin` authorization check that gates opening the batch in-app
  (AC-2.3) passes, and it expires after a short, bounded window — mirroring ADR-0016's
  signed-GET pattern for receipt attachments; the link itself grants no standalone,
  unauthenticated, or permanent access to the PDF.

### US-4: Accounting marks a compiled batch as paid

As an accounting user, I want to explicitly confirm that a compiled batch's requests
have actually been put through payroll, so that "paid" in the app reflects something
that genuinely happened, on my say-so, not merely that a PDF was generated.

**Acceptance criteria:**
- AC-4.1: Given a `compiled` batch, when an accounting or `refund-admin` user marks it
  as paid, then the batch transitions to `paid` and every request it contains
  transitions from `approved` to `paid`, atomically — either all of them change or none
  do.
- AC-4.2: Given the mark-as-paid action, then it does not require the batch's
  compilation email to have been successfully delivered first (AC-3.1's soft-failure
  posture) — an accounting user may mark a batch paid even while its email delivery
  status shows failed, provided they can see that status (AC-3.2) to act with full
  information.
- AC-4.3: Given a batch already `paid` or `discarded`, when any user attempts to mark
  it as paid (again, or at all), then the action is refused — a batch's transition out
  of `compiled` happens exactly once and is terminal; there is no undo, un-mark, or
  reopen path anywhere in this feature (a genuine mistake is corrected outside the app).
- AC-4.4: Given the mark-as-paid action, then it is authorized by the exact same
  accounting/`refund-admin` refund-decision capability that already gates approve/reject
  (007 AC-7.5) — no new, separate permission or role is introduced for it; a
  non-accounting, non-`refund-admin` user attempting it via the UI or its underlying
  API directly is denied.

### US-5: Employee sees their request marked paid

As an employee, I want to see, on the request I submitted, that it has actually been
paid and when, so that I have a concrete confirmation instead of only the generic
"processed monthly" messaging I get while it's merely approved.

**Acceptance criteria:**
- AC-5.1: Given a request transitions from `approved` to `paid` (US-4), when the
  transition is saved, then the requesting employee is sent a notification through the
  suite's existing notification center (ADR-0009/notify-api, reusing 007 AC-3.6's
  pattern) reflecting that it has been paid — a push, not something they must revisit
  the list to discover.
- AC-5.2: Given a `paid` request, when the employee opens its detail, then they see it
  clearly marked `paid`, distinct from `approved`, `rejected`, and `submitted`, and see
  when it was paid.
- AC-5.3: Given a `paid` request, when the employee opens its detail, then 007's generic
  "approved requests are compiled and reflected on paychecks on a monthly cadence"
  messaging (007 AC-4.1) is no longer shown for that request — it is superseded by the
  concrete `paid` state, which never promises or displays anything about how the PDF
  batch that paid it was composed (which other employees or requests it contained).
- AC-5.4: Given a `paid` request, when the employee opens its detail, then they see
  exactly the same per-line requested-vs-approved detail 007's AC-3.2 already provides —
  reaching `paid` does not remove or alter that existing detail.
- AC-5.5: Given any request regardless of status (including `paid`), when a user other
  than its owning employee (and not holding `accounting`/`refund-admin`) attempts to
  view it, then access is denied — unchanged from 007's AC-2.5.

### US-6: Accounting discards a compiled batch before it's paid

As an accounting user, I want to void a compiled batch I've decided not to proceed
with — because it was compiled with the wrong cutoff, or accounting realizes an error —
without permanently losing the ability to pay those requests, so that a mistake before
payment doesn't require workarounds.

**Acceptance criteria:**
- AC-6.1: Given a `compiled` batch that has not been marked paid, when an accounting or
  `refund-admin` user discards it, then the batch transitions to `discarded`
  (terminal — a discarded batch can never later be marked paid or un-discarded) and
  every request it contained is released back into the eligible candidate pool
  (AC-1.2) for a future compilation.
- AC-6.2: Given a batch already `paid`, when any user attempts to discard it, then the
  action is refused — only a not-yet-paid, `compiled` batch can be discarded.
- AC-6.3: Given a discarded batch, when an accounting or `refund-admin` user views its
  history entry (US-7), then it remains visible and inspectable (which requests it once
  held, who discarded it, when) — discarding voids the batch's effect, it does not erase
  the record that it happened.

### US-7: Audit trail of monthly processing actions

As wellD, we want every compile, discard, and mark-as-paid action recorded immutably,
so that the final, money-moving stage of the reimbursement lifecycle is exactly as
governable and accountable as the approve/reject decisions that precede it (007 US-8).

**Acceptance criteria:**
- AC-7.1: Given a batch is compiled, discarded, or marked paid, when that action
  completes, then an audit entry is recorded capturing the actor, timestamp, the batch,
  and the full set of request IDs affected — for mark-as-paid, this includes each
  individual request's `approved → paid` transition, mirroring 007's AC-8.1 granularity
  for state-relevant events.
- AC-7.2: Given a recorded audit entry for a monthly-processing action, then it cannot
  be edited or deleted by any user, including `accounting`, `refund-admin`, or `admin` —
  the same immutability guarantee 007's AC-8.2 already gives request-level audit
  entries.
- AC-7.3: Given a request that has ever been included in any batch (compiled, paid, or
  discarded), then that fact and the batch's identity remain permanently attached to
  its audit history, even if the batch was later discarded and the request re-included
  in a different, later batch.

### US-8: Accounting reviews the history of past compilation batches

As an accounting user, I want a list of every batch that's ever been compiled —
whatever its outcome — so that I can find and re-open a specific run without having to
remember exactly when I triggered it.

**Acceptance criteria:**
- AC-8.1: Given an accounting or `refund-admin` user, when they open the batch history,
  then every batch is listed with, at minimum, its cutoff, status, request count, and
  per-currency totals.
- AC-8.2: Given the batch history, when an accounting or `refund-admin` user views it,
  then batches of every status (`compiled`, `paid`, `discarded`) appear — history is not
  filtered down to only currently-actionable (`compiled`) batches.
- AC-8.3: Given a non-accounting, non-`refund-admin` user, when they attempt to open the
  batch history via the UI or its underlying API directly, then access is denied.

## Non-goals

- **Actual payroll-system integration or posting.** This feature produces the compiled
  artifact and records `paid` inside Operai; actually running payroll or posting an
  amount into an external payroll system happens outside the app, exactly as 007's
  Non-goals already stated for the pre-`paid` lifecycle.
- **Currency conversion or a cross-currency blended total anywhere in the compiled
  PDF or batch totals.** Carried forward from 007 verbatim — amounts are always
  subtotaled per currency, never converted or combined.
- **Per-employee individual PDF extracts or per-employee email delivery of the
  compiled artifact.** The batch PDF's download link is emailed only to the configured
  accounting distribution address (AC-3.4); an employee-facing personal extract is a
  plausible future enhancement, not built here.
- **Binary PDF email attachments, or extending `notify-api`'s email channel to support
  them.** Resolved 2026-07-19: delivery is via a short-lived signed download link only
  (US-3); the plan adds a new template/data shape for that link, it does not add
  attachment support to `notify-api`.
- **Embedding original receipt attachment files/images inside the compiled PDF**
  (AC-1.7) — it is a numeric/textual summary; attachments remain accessible only
  through the existing per-request view.
- **A scheduled/cron-triggered compilation.** Every compilation is explicitly
  accounting-triggered with an accounting-chosen cutoff (US-1); no background job ever
  compiles a batch on its own, consistent with this suite's established schedulerless
  posture (ADR-0013).
- **Reopening, un-marking, or undoing a `paid` batch or `paid` request.** Terminal means
  terminal (AC-4.3); a genuine payroll mistake is corrected outside the app, mirroring
  007's no-undo stance on decisions (AC-7.4).
- **In-place editing of a `compiled` batch's included-request set or regenerating its
  PDF with different contents.** A batch's contents are frozen at compile time; a
  correction is always discard-then-recompile (US-6), never an edit.
- **Multi-approver / dual-authorization for marking a batch paid.** A single accounting
  or `refund-admin` user's action is authoritative, mirroring 007's single-decision-maker
  stance — no second-approver step is introduced.
- **A dedicated, stricter permission (or a distinct payroll-approver role) gating
  mark-as-paid separately from the existing accounting/`refund-admin` decision
  capability.** Resolved 2026-07-19: mark-as-paid reuses the same capability that
  already gates approve/reject (AC-4.4); a separate, stricter tier is a possible future
  tightening, not v1 scope.
- **A per-accounting-user or role-resolved list of email recipients for the
  compilation email.** Resolved 2026-07-19: delivery targets exactly one
  deploy-configured accounting distribution address (AC-3.1/AC-3.4); no per-user or
  dynamic recipient resolution is introduced.
- **A bounded retention window or expiry for generated compiled PDFs.** Resolved
  2026-07-19: retention is indefinite (AC-1.10), mirroring 007's AC-8.3 never-delete
  posture — no cleanup/expiry job is introduced for this artifact.
- **Bilingual (Italian) email or PDF content for this feature.** `refund-ui` shipped
  English-only in 007, a tracked-but-unresolved gap against CLAUDE.md's i18n mandate
  (007 eval-report); this feature does not reopen or resolve that gap — the compiled
  PDF and its email are English-only, consistent with the rest of refund's v1 surface.
- **Integration with any external payroll calendar.** The cutoff (US-1) is a simple
  point in time chosen by accounting inside the app; it is not derived from or synced
  with any external payroll schedule.
- **A staleness/reminder signal for approved requests that have gone multiple cycles
  without being included in any batch** (e.g. because no one triggered a compilation).
  Confirmed 2026-07-19 as out of scope for v1 — real, but not required by this spec.

## Constraints

*Facts already established by the codebase, plus 007's precedent, captured verbatim for
the plan, not elaborated here.*

- 007's `RefundRequest.status` (`RefundStatus` enum) currently has exactly four values —
  `draft`/`submitted`/`approved`/`rejected` — and its Prisma schema carries an explicit
  code comment: "draft|submitted|approved|rejected only... Do not add a fifth value
  here." Introducing `paid` (this spec's terminal state) means the plan stage must
  explicitly decide how to extend or supersede that comment/enum — not assumed or
  designed here.
- `notify-api`'s existing `/system/emails` internal endpoint (ADR-0011) — the suite's
  only email-sending mechanism — currently supports a small fixed set of enum
  templates, a fixed variable-input shape (`to`/`inviteUrl`/`inviterName`/`expiresAt`,
  all escaped into pre-built bilingual HTML), and a 16 KiB request body cap. It has no
  concept of a binary/PDF attachment, and this feature does not require one: resolved
  2026-07-19, the compilation email carries a signed download link, not a binary
  attachment (US-3) — the plan adds a new template/data shape for that link (well within
  the existing body-size cap), it does not extend the channel for attachments.
- Compiled PDFs are stored in the same EU-region S3-compatible object storage refund
  attachments already use (007, ADR-0016), accessed via presigned URLs, never proxied
  through `refund-api`'s own process — this is the storage/access pattern the
  compilation email's signed download link (AC-3.1/AC-3.5) resolves against. Retention
  is indefinite (AC-1.10, resolved 2026-07-19) — no deletion or expiry job applies to
  the PDF object itself (the link that reaches it does still expire, per AC-3.5).
- Monthly-processing actions (compile, discard, mark-paid) are all gated by the same
  existing accounting/`refund-admin` refund-decision capability already used for
  approve/reject (007) — resolved 2026-07-19: no new `request:mark-paid` (or similarly
  scoped) permission, and no new payroll-approver role, are introduced by this spec. A
  dedicated, stricter permission tier for mark-as-paid specifically is named as a
  possible future tightening, not v1 scope (see Non-goals).
- The compilation email's recipient is a single deploy-configured accounting
  distribution address (env/config value, resolved 2026-07-19) — not a per-user or
  role-resolved list; the exact address/mechanism for configuring it is a plan/deploy
  concern, not specified further here.
- Roles `accounting` (entity-scoped) and `refund-admin` (unconditioned/global,
  bundling every refund request action) already exist (007, `auth/src/authz/seed.ts`).
- The source paper form `form_richiesta_rimborso_spese_WellD_A4_compilabile.pdf`
  (repo root) remains the reference for what information the compiled PDF should
  mirror, exactly as it was for 007's request/line fields.
- 007's audit trail (`RefundAuditEntry`, ADR-0018) is append-only and DB-enforced
  immutable via a raising trigger; this feature's new audited actions (compile,
  discard, mark-paid) are expected to reuse that same enforcement mechanism, not a
  new one.

## Open questions

None — all resolved 2026-07-19.
