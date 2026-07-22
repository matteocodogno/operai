---
id: 011
slug: refund-settings
status: in-progress
rigor: production
created: 2026-07-22
approved: 2026-07-22
---

# Refund settings: admin-managed accounting distribution email

## Problem

The single mailbox that receives the monthly compiled-batch email (specs/008, ADR-0021)
is today a startup environment variable, `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`, on
refund-api. Changing it requires a code deploy and ops/infrastructure access, and its
current value is invisible to the accounting admins who actually own the refund process
and would know if it's wrong or stale. Because this single address controls where
financial batch data (a signed deep link covering every employee in that batch) is
delivered, a wrong or missing value is a real misdirection/loss risk that today only an
engineer touching `.env` files can see or fix. wellD wants this to be an
admin-managed setting, viewable and editable in the Admin tool's Refund tab, with a
record of who changed it and when.

## Domain language

Extends `specs/007-refund-service`, `specs/008-refund-monthly-processing`, and
`specs/009-mileage-rate`'s domain language unchanged except where amended below.

- **refund setting** — a named, persisted configuration value owned by refund-api that
  controls behavior of the refund process, editable by an authorized admin without a
  redeploy. This feature introduces exactly one refund setting (the next bullet) but the
  underlying store MUST be modeled to hold more refund settings later without rework —
  it is a settings store, not a single bespoke column bolted onto an unrelated table.
- **accounting distribution email** — the refund setting that replaces today's
  `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` env var: the single email address the compiled
  monthly batch email (specs/008 US-3, ADR-0021) is sent to. Exactly one address, never
  a list — this feature does not add multi-recipient or distribution-list support (see
  Non-goals). It has two states: **configured** (holds a syntactically valid email
  address) and **not configured** (no value has ever been set, or an admin has
  explicitly cleared it — see US-1, AC-1.4).
- **settings audit record** — an immutable record of one change to a refund setting's
  value, capturing who changed it, when, and its old and new value (US-5). The exact
  storage mechanism is an open question for the plan; the observable guarantee (US-5) is
  not.

**Supersession note:** this spec supersedes specs/008's Constraints characterization of
the accounting distribution address as a "deploy-configured", "env/config value" —
it becomes an admin-editable, persisted refund setting. specs/008's US-3 behavior
(AC-3.1–AC-3.5: automatic send on compile, visible delivery status, resend, single
recipient, signed short-lived link) is otherwise unchanged, except for where the address
itself now comes from (this spec) and the new unconfigured-blocks-send case this spec
introduces (US-2).

## User stories

### US-1: Admin views and updates the accounting distribution email

As an accounting admin, I want to view and change wellD's accounting distribution email
myself, directly in Admin > Refund, so that I don't need a redeploy or ops access to fix
or update where compiled batch emails go.

**Acceptance criteria:**
- AC-1.1: Given an authorized admin, when they open Admin > Refund, then they see the
  currently configured accounting distribution email, or a clear "not configured"
  indicator if none is set (Domain language).
- AC-1.2: Given an authorized admin enters a syntactically valid email address and
  saves, when the save completes, then the new value is persisted and is what's shown
  as the current value the next time the field is viewed (e.g. after a reload).
- AC-1.3: Given an authorized admin enters a value that is not a well-formed email
  address and attempts to save, then the attempt is rejected with a clear message
  identifying the problem, and the previously stored value (if any) is left unchanged.
- AC-1.4: Given an authorized admin clears the field and saves, when the save completes,
  then the setting transitions to explicitly "not configured" — clearing is a distinct,
  intentional action (US-1) from entering an invalid value (AC-1.3, which is rejected
  and changes nothing).
- AC-1.5: Given a setting change just saved (AC-1.2 or AC-1.4), then no redeploy,
  restart, or ops action against refund-api is required for it to take effect — the very
  next batch-email send or resend (US-2) already observes the newly saved value.

### US-2: Batch compile, email send, and mark-paid each respect the setting correctly

As accounting, I want batch compilation and mark-as-paid to keep working no matter what,
and the compiled batch's email to go only to whatever the accounting distribution email
currently points to — or to be clearly refused if nothing is configured — so a
misconfigured or missing address never silently loses or misdirects payroll data, and
never blocks the rest of the monthly process.

**Acceptance criteria:**
- AC-2.1: Given the accounting distribution email is NOT configured (Domain language),
  when an authorized accounting/`refund-admin` user compiles a monthly batch (specs/008
  US-1), then compilation completes exactly as it does when the setting IS configured —
  request selection, batch/PDF creation, and audit recording (specs/008, ADR-0019) are
  entirely unaffected by the setting's configured/not-configured state.
- AC-2.2: Given the accounting distribution email is NOT configured, when the system
  attempts to send a batch's compilation email — whether automatically right after
  compile (specs/008 AC-3.1) or via an explicit resend (specs/008 AC-3.3) — then no
  email is sent, and the batch's visible delivery status (specs/008 AC-3.2) clearly
  states the specific reason ("Set the accounting distribution email in Admin > Refund
  first", or equivalent copy) — distinguishable to the viewer from an ordinary delivery
  failure (e.g. notify-api/Resend being unreachable).
- AC-2.3: Given the accounting distribution email IS configured, when the system sends a
  batch's compilation email (automatic or resend), then it is sent to exactly that
  configured address — never a value baked in at a previous deploy, and never to more
  than the single configured address (specs/008 AC-3.4 unchanged).
- AC-2.4: Given a batch whose compilation email could not be sent because the setting
  was unconfigured at the time (AC-2.2), when an admin subsequently configures the
  accounting distribution email (US-1) and an authorized user triggers a resend
  (specs/008 AC-3.3), then the email is sent to the newly configured address — an
  earlier unconfigured state does not permanently block that batch's email.
- AC-2.5: Given a `compiled` batch whose compilation email could not be sent due to an
  unconfigured setting (AC-2.2), when an accounting or `refund-admin` user marks it as
  paid (specs/008 US-4), then the mark-as-paid action succeeds exactly as specs/008
  AC-4.2 already allows when delivery has failed for any other reason — an
  unconfigured/blocked email is never a barrier to marking a batch paid.

### US-3: Only an authorized admin can view or change the setting

As wellD, we want the accounting distribution email to be viewable and changeable only
by admins authorized to manage refund settings, enforced by the server and not merely
hidden in the UI, so that a misconfiguration can't be caused — accidentally or
otherwise — by anyone else, and so that its current value isn't exposed to users who
have no business seeing where financial data gets emailed.

**Acceptance criteria:**
- AC-3.1: Given a user who lacks the capability required to manage refund settings, when
  they attempt to view or change the accounting distribution email — whether through
  admin-ui or by calling the underlying API directly — then the attempt is denied by the
  server. The exact capability/permission that gates this (a new catalog entry vs. reuse
  of an existing one) is an open question for the plan (see Open questions); what is NOT
  open is that some server-side authorization check is mandatory, never satisfied by
  UI-only hiding (mirrors specs/009 AC-4.6's posture for mileage-rate management).
- AC-3.2: Given a user who lacks the capability required to manage refund settings, when
  they view Admin > Refund, then the accounting-distribution-email section is not shown
  to them at all — mirroring the existing mileage-rate section's capability-gated
  visibility (specs/009 AC-4.6), a denied capability is invisible, not merely disabled.

### US-4: Cutover from env var to setting is deliberate, not a silent gap

As wellD ops, we want the switch from the env var to the admin-managed setting to happen
without a moment where compiled-batch email silently goes nowhere or to a stale address,
and without leaving orphaned configuration behind.

**Acceptance criteria:**
- AC-4.1: Given refund-api starts up after this feature ships, then it does NOT read,
  require, or validate `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — or any environment
  variable — for the accounting distribution email; startup succeeds with no such
  variable present in the environment at all.
- AC-4.2: Given the value of `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` configured in
  production at the moment this feature is deployed, then its disposition — whether it
  is seeded as the initial stored setting value at deploy time, or the setting starts
  "not configured" and an admin sets it post-deploy via the UI (US-1) — is a decision
  the plan must make explicit (see Open questions); whichever is chosen, it MUST be a
  deliberate, documented step, never an implicit "whatever the migration happens to
  leave behind."
- AC-4.3: Given any period between this feature's deploy and the accounting distribution
  email being (re-)configured by an admin — whether that period is zero because of
  seeding (AC-4.2) or nonzero — then batch compilation and mark-as-paid continue to work
  throughout it (AC-2.1, AC-2.5), and any compilation email attempted during that window
  follows AC-2.2's blocked-send behavior exactly — there is no third, silent-failure
  outcome.

### US-5: Setting changes are auditable

As wellD, we want every change to the accounting distribution email recorded with who
changed it, when, and its old and new value, so that a financial-data-routing
misconfiguration is always traceable to a specific actor and moment, consistent with the
suite's governed-audit posture (ADR-0018, ADR-0022, ADR-0024).

**Acceptance criteria:**
- AC-5.1: Given an authorized admin changes the accounting distribution email — setting
  it for the first time, changing it to a different value, or clearing it (AC-1.2,
  AC-1.4) — when the change is saved, then an audit record is created capturing the
  actor, the timestamp, the old value (or "not configured" if there was none), and the
  new value (or "not configured" if cleared).
- AC-5.2: Given a recorded settings-change audit record, then it can never be edited or
  deleted by any user, including an admin — mirroring the suite's existing
  immutable-audit posture (ADR-0018, ADR-0022, and specs/009's ADR-0024 pattern for
  non-request-scoped records).
- AC-5.3: Given an authorized admin, when they open the audit history for the
  accounting distribution email, then they see the chronological list of every change to
  it (who, when, old value, new value).
- AC-5.4: Given an admin submits a save whose value is identical to the setting's
  current value (a no-op), then no new audit record is created — audit history reflects
  actual value transitions only.

## Non-goals

- **Multiple distribution addresses or a distribution list.** Exactly one address, as
  today (ADR-0021) — this feature only changes where that one address is stored and
  edited, never how many there can be.
- **General per-entity or per-user settings.** The two entities (WellD CH, WellD Italia,
  specs/007) are not involved here — the accounting distribution email is suite-wide,
  exactly like the env var it replaces; this feature does not introduce entity- or
  user-scoped configuration of any kind.
- **Moving any other environment variable into the settings store.** Only
  `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` moves. `AUTH_AUDIENCE`, `NOTIFY_INTERNAL_TOKEN`,
  `REFUND_S3_*`, `REFUND_APP_BASE_URL`, and every other refund-api env var are entirely
  untouched.
- **Changing how notify-api delivers email (ADR-0011), or the signed-link email design
  itself (ADR-0021).** The template, the deep-link-not-attachment design, the
  best-effort/never-blocks-compilation posture (specs/008 AC-3.1), and the
  short-lived-presigned-GET pattern (specs/008 AC-3.5) are all unchanged — only the
  *source* of the recipient address changes.
- **A general multi-setting management UI.** The Refund tab gains one field for one
  setting; a generic "add/list/edit any setting" screen is out of scope even though the
  underlying store must be extensible (Domain language) — that extensibility is a data
  concern for the plan, not a UI deliverable here.
- **Retroactively resending, or changing the audit trail of, batches compiled before
  this feature shipped.** Cutover behavior (US-4) governs only what happens going
  forward from deploy.

## Constraints

*Facts already established by the codebase/prior specs, captured verbatim for the plan,
not elaborated here.*

- `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` is currently validated at startup in
  `refund-api/src/lib/env.ts`, read at batch-compile time in
  `refund-api/src/batches/batches.routes.ts`, and used to build the notify-api call in
  `refund-api/src/lib/notifyEmail.ts`. notify-api delivers the actual email via Resend
  (ADR-0011); refund-api triggers the send via the internal, non-user-JWT
  `POST /system/emails` call authenticated by the shared `NOTIFY_INTERNAL_TOKEN`
  (ADR-0011, ADR-0021).
- specs/008/ADR-0021 established that the recipient address is **snapshotted onto the
  batch at compile time** (`recipientEmailSnapshot`) and that a resend
  (specs/008 AC-3.3) reuses "the same configured accounting distribution address"
  without re-running compilation. This feature's shift from a fixed env var to a
  live-editable setting interacts with that existing snapshot mechanism — whether
  send/resend continues to use the batch's frozen snapshot, or now always re-resolves
  the live current setting at send time (which AC-2.4 requires for a
  previously-blocked batch), is an open question for the plan (see Open questions).
- Authorization is hand-rolled RBAC/ABAC in `auth` (ADR-0007): a per-app catalog
  declares (resource, action, supportedConditions); refund-api enforces it live
  (ADR-0014). The refund catalog (`auth/src/authz/catalogs/refund.ts`) already declares
  a global, non-entity-scoped `rate` resource (`read`/`manage` actions, no
  `supportedConditions`) for mileage-rate admin (specs/009, ADR-0023).
- admin-ui's Refund tab already exists (route `/rates`, capability-gated on `rate:read`,
  renamed from "Mileage Rates" to "Refund" on 2026-07-21) and already calls refund-api
  directly via `shell/session`'s `apiFetch` + a shell-owned `getRefundApiBaseUrl()`
  (specs/009, ADR-0023) rather than through `auth`'s admin API.
- refund-api has an append-only, DB-level-immutable financial/authorization audit trail
  (`RefundAuditEntry`, ADR-0018, extended by ADR-0022) and a separate self-auditing
  pattern already used for a non-request-scoped record (`MileageRate`, ADR-0024,
  specs/009) — the reusable prior art this feature's audit mechanism (US-5) is chosen
  from at the plan stage.
- specs/009's mileage-rate history and this feature's setting are both refund-api-owned,
  non-entity-scoped, admin-governed configuration living in the same Refund tab, but are
  otherwise independent features — this spec does not require or assume any shared
  schema, endpoint, or permission with mileage rates beyond what the plan explicitly
  chooses to reuse (see Open questions).

## Open questions

- [ ] Settings storage shape: a typed singleton row dedicated to this one setting, or a
  generic key/value refund-settings table (required to be extensible per Domain
  language's "refund setting" definition — more settings must be addable without
  rework)? — owner: architect (plan)
- [ ] The capability that gates read/update of the accounting distribution email: a new
  `settings`/`config`-shaped catalog permission, or reuse of the existing `rate:manage`
  capability (both would be global, non-entity-scoped, per ADR-0023's precedent)? —
  owner: architect (plan)
- [ ] The audit mechanism for US-5: a new `AuditAction` value on the existing
  `RefundAuditEntry` (ADR-0018/0022 pattern) vs. a dedicated self-auditing settings
  table mirroring `MileageRate` (ADR-0024) vs. some other structured, queryable record —
  owner: architect (plan)
- [ ] Whether admin-ui reads/writes the setting via a new refund-api endpoint, or an
  extension of the existing rates surface — owner: architect (plan)
- [ ] The exact 4xx response shape (status code, Problem JSON `type`/`detail`) refund-api
  returns when a batch-email send/resend is attempted while the setting is unconfigured
  (AC-2.2) — owner: architect (plan)
- [ ] Whether the existing per-batch `recipientEmailSnapshot` compile-time-freeze
  mechanism (specs/008/ADR-0021, see Constraints) is retained as-is (with AC-2.4's
  "later-configured value reaches a previously-blocked batch" achieved by re-snapshotting
  on resend), or replaced by always resolving the LIVE current setting value at every
  send/resend, never freezing a per-batch copy — owner: architect (plan)
- [ ] Cutover disposition of the currently-deployed production value of
  `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` (AC-4.2): seed it as the initial setting value
  as part of the deploy/migration, or deploy with the setting unconfigured and require
  an admin to set it post-deploy (accepting the AC-4.3 blocked-send window)? — owner:
  architect (plan) + ops
