# 0013 — Invitation lifecycle as derived state: schedulerless expiry, reconcile-on-read/write

**Date:** 2026-07-14  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

Spec `specs/006-user-invitations` (US-4) requires an unaccepted invitation to stop working 72
hours after it was created, or after its most recent resend (AC-4.1), "with no admin action
required to trigger the expiry" — and requires this to be observable: an admin must see a
past-window invitation as `expired`, distinguishable from `pending` (AC-4.2), and following its
link must be refused (AC-4.3) regardless of what OAuth identity subsequently signs in. The spec
also locks (AC-1.4) that at most one **live** invitation may exist per email at a time, enforced
so that a genuinely dead invitation (expired or revoked) never blocks a fresh one for the same
address (AC-1.5).

A naive implementation would need a background process — a cron job or queue consumer — that
periodically scans for `pending` rows past their `expiresAt` and flips them to a stored
`expired` status, so that reads always see an up-to-date value and so that a partial-unique
index scoped to `status='pending'` never sees a stale row it should have excluded. This
introduces a scheduled job purely to keep a status column truthful — new infrastructure, a new
failure mode (a missed or delayed sweep silently keeping a dead invitation "live" past its
window), and a coordination question (how promptly must the sweep run relative to the 72-hour
window) that the spec's "no admin action required" wording does not actually demand.

## Decision

We will make `expired` a **derived** state, never a distinct value written by any scheduled
process, and reconcile it opportunistically on both read and write instead of running a
background sweep.

1. **Stored states are only `{pending, accepted, revoked}`.** `Invitation.status` never holds
   the literal value `expired` as a routine matter of course; effective status is computed as
   `status == 'pending' && expiresAt <= now() ? 'expired' : status` everywhere it is displayed
   or reasoned about.
2. **Reconcile-on-read.** List, detail, and the public invite-landing page all compute effective
   status at query time (AC-4.2 — a past-window `pending` row renders as `expired` without
   needing its stored value to have been touched).
3. **The activation-matching hook filters, it does not read effective status.** The
   `user.create.after` invitation lookup queries `status = 'pending' AND expiresAt > now()`
   directly — a lazily-expired row (still physically `status='pending'` but past its window)
   is simply excluded by the `WHERE` clause, which has the same effect as checking effective
   status without needing to compute it as a separate step (AC-4.3/AC-2.5).
4. **Reconcile-on-write, only where correctness requires a physical value.** The one place a
   stored value must actually be current is the **partial unique index**
   (`CREATE UNIQUE INDEX invitation_pending_email_key ON invitation (email) WHERE status =
   'pending'`), which enforces "at most one live pending invitation per email" (AC-1.4) at the
   database layer using the *physical* `status` column — an index predicate cannot reference
   "effective" status. At invite-create, the same transaction first flips any of that email's
   past-expiry `status='pending'` rows to a physical `status='expired'` before inserting the new
   row, so the unique index never blocks a legitimately fresh invitation for an address whose
   only prior invitation is dead (AC-1.5/AC-1.14) — the write is triggered by the very act of
   trying to create a new invitation, not by a clock-driven job.
5. **Resend and revoke remain ordinary, admin-triggered stored transitions.** Resend
   (on an invitation whose *effective* status is `pending` or `expired`) sets `status='pending'`,
   rotates the token (`tokenHash`), and resets `expiresAt = now() + 72h` (AC-3.1/3.3). Revoke
   (same effective-status precondition) sets the terminal, physical `status='revoked'`
   (AC-1.9). Both are refused with `422` if the invitation's effective status is already
   `accepted` or `revoked` (AC-1.10/1.11/AC-3.4). Neither of these depends on the derived-state
   mechanism — they are ordinary explicit admin actions writing a real stored value.

## Options considered

### Option A — Derived `expired`, reconcile-on-read + reconcile-on-write at create (chosen)

Described above: no stored `expired` value in the hot path, no background process.

**Pros:**
- No scheduler, queue, or cron infrastructure to build, deploy, or monitor purely to keep a
  status column accurate — the entire feature has zero new background-job surface
- Correctness does not depend on a sweep's timing: an invitation's effective state is always
  exactly right the instant it's computed (`expiresAt <= now()`), with no window where a stale
  `pending` value is visible after 72 hours have actually elapsed
- The one place a physical value truly matters (the partial-unique index) is kept correct by
  tying the reconciling write to the natural trigger for needing it — an admin trying to create
  a new invitation for that email — rather than a time-based job unrelated to that specific need
- Matches the spec's literal wording ("no admin action required to trigger the expiry") more
  directly than a scheduled sweep would: expiry is a property of time having passed, not an
  event that must be triggered by anything at all

**Cons:**
- A `pending` row that has, in fact, expired can sit in the database indefinitely with its
  physical `status` still reading `'pending'` if nobody ever lists it, revokes it, or tries to
  invite that email again — anyone querying the table directly (an ad hoc SQL query, a future
  report) must remember to combine `status` with `expiresAt`, or risk miscounting "pending"
  invitations
- Every code path that reasons about invitation state must consistently apply the same
  `expiresAt` check alongside `status` — a discipline requirement rather than something the
  schema enforces uniformly on its own (see Risks)

### Option B — Scheduled sweep (cron/queue) that writes `status='expired'` (rejected)

A periodic job (e.g. hourly) queries `pending` rows past `expiresAt` and updates them to a
stored `expired` value, so every read is a plain `status` column read with no derived
computation.

**Pros:**
- Every consumer of the table — application code, ad hoc queries, future reporting — sees a
  single, always-accurate `status` column with no need to separately reason about `expiresAt`
- The partial-unique index's predicate (`WHERE status='pending'`) is correct without any
  reconcile-on-write logic at insert time, since the sweep already keeps physical status current

**Cons:**
- Introduces new infrastructure (a scheduled job runner, or a queue + consumer) for a feature
  whose spec explicitly frames expiry as passive ("no admin action required to trigger the
  expiry") — the sweep is machinery that exists purely to keep a column truthful, not to serve
  any product behaviour the derived-state model doesn't already provide
- A missed, delayed, or failed sweep run creates exactly the staleness problem this option was
  meant to avoid, except now silently and system-wide (every reader sees a wrong value) rather
  than requiring any single reader to remember an extra `WHERE` clause
- The sweep interval becomes a tuning question with no natural answer (how promptly must
  "expired" become visible? every minute? every hour?) that the spec never asks for and that
  adds an operational parameter with no product-driven value
- Rejected: strictly more infrastructure and a new failure mode, for a correctness property the
  derived-state model already provides without it

### Option C — Reconcile-on-read only, no reconcile-on-write at create (rejected)

Keep `expired` fully derived everywhere, including at invite-create — never physically flip a
stale `pending` row's status, and rely solely on computing effective status at read time.

**Pros:**
- Simplest possible model: exactly one rule (`expiresAt <= now()` implies `expired`), applied
  uniformly, with no special-cased write path

**Cons:**
- Breaks AC-1.4/AC-1.5 at the database layer: the partial-unique index's predicate
  (`WHERE status='pending'`) can only see the physical column, not the derived effective value
  — a dead-but-physically-`pending` row would keep blocking a legitimately fresh invitation for
  that email until *something* eventually flips its stored status, which under this option is
  nothing at all
- Rejected: the derived-state model is correct for every read-only consumer, but the
  partial-unique index is a hard database-level constraint that cannot evaluate a computed
  expression the way application code can — this option would silently violate a locked
  acceptance criterion

## Consequences

**Positive:**
- Zero new operational surface: no cron, no queue, no scheduled-job monitoring/alerting for
  this feature — one less moving part than a comparable expiring-token feature would typically
  need
- Effective state is always instantaneously correct wherever it's computed — there is no window
  in which a reader sees a stale `pending` value past the 72-hour mark, unlike a sweep-based
  design bounded by its polling interval
- Establishes a **reusable, schedulerless expiry pattern** for any future Operai feature with a
  similarly time-bounded, unaccepted-by-default record — named in the plan as a candidate reuse
  for the Refund app's future approval-request expiry, without committing to that reuse here

**Negative / trade-offs:**
- Any future direct SQL query, report, or admin tool that reads `Invitation.status` without
  also checking `expiresAt` will silently misclassify a dead invitation as `pending` — the
  correctness of "what does pending mean" is spread across every consumer rather than
  centralised in one column
- The partial-unique index's correctness now depends on the invite-create transaction
  performing its reconcile-on-write step *before* the insert, inside the same transaction — a
  future refactor that moves or skips that step would silently reopen the exact bug Option C
  was rejected for

**Risks:**
- **Inconsistent effective-status computation across call sites.** If the `status=='pending' &&
  expiresAt<=now()` check is duplicated ad hoc in multiple places (list endpoint, detail
  endpoint, landing page, hook query) instead of going through one shared helper, a drift
  between implementations (e.g. `<=` vs `<`) could make one surface disagree with another about
  whether a given invitation is expired. Mitigation: implement the effective-status computation
  as a single shared function/query fragment reused by every consumer, not re-derived per
  call site.
- **Reconcile-on-write omitted or run outside the transaction.** If the stale-row flip at
  invite-create is not atomic with the insert (e.g. run as a separate statement outside the
  transaction, or skipped under a code path that bypasses the shared invite-create helper), the
  partial-unique index could still incorrectly block a fresh invitation for an email whose only
  prior invitation is dead. Mitigation: the reconcile-on-write step lives inside the same
  `withAudit`/transaction wrapper as the insert, exercised directly by the AC-1.5 test.
- **A permanently-`pending`-looking row with no natural cleanup.** Because a dead invitation's
  physical status may never be rewritten until someone next touches that email (list it, revoke
  it, or re-invite it), the `invitation` table can accumulate rows that read `pending` at the
  storage layer indefinitely. Mitigation: accepted as a low-severity data-hygiene cost, not a
  correctness issue (every product-facing surface computes effective status correctly
  regardless); a future retention/cleanup pass on old invitations is a separate, unscheduled
  concern, not required by this spec.

## Compliance notes

- GDPR/nLPD impact: low — this decision concerns state-computation mechanics, not what personal
  data is stored; the underlying `Invitation.email` retention/lifecycle is governed by the
  broader invitation feature, unaffected by whether `expired` is derived or stored
- Data residency: not applicable — no new storage location or cross-border transfer is
  introduced by this decision
- Audit trail: not required for this decision specifically — the *derivation* of `expired` is
  not itself an admin action and is not audited; the admin-triggered transitions that do write a
  physical status (create, resend, revoke) are already covered by ADR-0007's `audit_log`
  mechanism as described in ADR-0012

This decision is part of the same `specs/006-user-invitations` plan as ADR-0012 (invitation
activation hooks + soft-delete lifecycle), which this ADR's reconcile-on-write step feeds
directly: ADR-0012's `user.create.after` activation match relies on this ADR's
`status='pending' AND expiresAt>now()` filter to correctly exclude a lazily-expired invitation.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
