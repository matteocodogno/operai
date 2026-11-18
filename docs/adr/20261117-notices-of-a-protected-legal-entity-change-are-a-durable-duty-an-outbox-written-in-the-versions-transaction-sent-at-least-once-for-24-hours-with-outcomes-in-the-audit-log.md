# 20261117 — Notices of a protected change to a legal entity are a durable duty: outbox rows written in the version's own transaction, a dispatcher in auth that claims them with leases and `SKIP LOCKED`, retries for 24 hours, and every outcome in the audit log

**Date:** 2026-11-17  
**Status:** Accepted — plan amendment "after security review" of specs/20261117-legal-entities (approved by the owner 2026-11-17 with tasks T51–T71); owner decisions in spec US-9: OQ-11 (handed over within 60 seconds, first retry within 5 minutes, given up after 24 hours, the give-up in the audit log), OQ-12 (release order) and AC-9.14 ("the duty to send is kept together with the version"). Plan ADR candidate 5. **Amends** ADR 20261105-auth-pushes-admin-notifications (its escalation trigger fires) and **departs from** ADR 20260716-system-notifications-cross-user-trigger §4 (best effort, no retry) for this one notice. **Amended 2026-11-18** by ADR 20261118-a-notice-identifies-its-author-by-the-account-email-captured-in-the-versions-transaction-and-that-address-is-the-one-personal-value-a-notice-carries: point 3 ("The rows hold no value") now has one exception, the author's account email in `authorEmail`, captured in the version's transaction; the open note on N1 is closed (the notice names the account email, never the display name); the GDPR line's "Notices name the actor by display name" no longer holds.  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

Security review F1 (specs/20261117-legal-entities/security-review.md, medium) found that one signed-in manager can change a legal entity's IBAN, and so redirect payments printed on every document of the suite, with nobody else told. The owner's answer is spec US-9: when a protected detail (legal name, VAT number, IBAN) changes, the other managers, the administrators, the actor and an optional outside mailbox are told in the notification centre and by email (AC-9.7 to AC-9.15). The notice is the one control that still works when a valid session has been abused (the owner declined step-up sign-in, dual control and a delay, spec Non-goals), so a notice that can be lost is a control that fails exactly when it is needed.

The suite's two existing precedents for "auth tells someone" are both fire-and-forget after commit. ADR 20261105-auth-pushes-admin-notifications has `auth` post to notify-api after the access-request row is committed, never awaited, every failure caught and logged. ADR 20260716-system-notifications-cross-user-trigger §4 makes the send "best-effort, not transactional with the decision" and names a queued retry only as "a named future improvement, not committed". For an access request that is right: the request stays visible on its screen. Here a restart between commit and send, or a notify-api outage, would drop the only alert, and nothing would show that it was dropped.

ADR 20261105-auth-pushes-admin-notifications also wrote an escalation trigger: "`auth` raising a second kind of notice, or any origin other than `admin`, revisits this ADR rather than widening the binding quietly". This is the second kind of notice.

## Decision

We will keep the duty to tell people as rows in `auth`'s database, written in the same transaction that stores the version, and send them from a dispatcher in `auth` that claims due rows with `FOR UPDATE SKIP LOCKED` under a 60-second lease, retries each failure for up to 24 hours after the version was stored, and writes every first failure, late success and give-up to the audit log. A notify-api failure never reaches the save. Origin `admin`, the scopes of `system:auth` and the binding of ADR 20261105-auth-pushes-admin-notifications are unchanged.

(Plan, G1 points 1–4 and 8, G3, G4, G6; `auth/src/legalEntities/notices/duty.ts`, `recipients.ts`, `dispatcher.ts`, `content.ts`, migration `auth/prisma/migrations/20261117160000_legal_entity_notices`; tasks T58, T59.)

1. **The duty is a row, written with the version.** `recordNoticeDuty` runs inside `withAudit`, under the entity's advisory lock, right after the version insert, and only when `changedFields` meets `PROTECTED_FIELDS = legalName, vatNumber, iban` (`protectedChanged`, `rules.ts`). One `legal_entity_notice` row per person and channel (`in_app`, `email`) and one `email` row for the outside mailbox (recipient `"outside"`, the address never stored); `@@unique (entity, version, recipient, channel)` makes a second row impossible. A rollback leaves no row; a failure to write the rows fails the save like any database error (500, nothing stored). That is the price of "kept together with the version", stated in the plan, and it is not a delivery failure.
2. **Recipients are fixed at store time.** Computed inside the transaction, so a role removed between store and send does not silence a recipient: managers of that entity (`legal-entity:manage`, confirmed by `resolveEffectivePermissions` and `coveredEntities`), effective administrators (`getEffectiveAdminUserIds`, whether or not they hold the permission), the actor as a receipt, and the outside mailbox when `LEGAL_ENTITY_NOTICE_EMAIL` is set at that moment. A protected change with no recipient at all writes `legal_entity.notice_no_recipients` in the same transaction (AC-9.15).
3. **The rows hold no value.** No name, address, VAT number, IBAN or outside address appears in a row, an audit entry, a log line, a key or the stored notification. Content is rebuilt from the immutable versions n and n−1 at send time (`content.ts`), so a retry sends the same words, and the only values an email may carry are the two IBAN tails (see ADR 20261117-notify-api-system-routes-protect-against-repeats-by-a-caller-scoped-idempotency-key-and-bind-a-template-to-its-caller-with-closed-typed-data).
4. **The dispatcher.** `startNoticeDispatcher()` in `src/index.ts` (never when `NODE_ENV === "test"`, timer unref'd) sweeps on start and every 15 s on every replica; the save also `kick()`s it after commit, with `void`, never awaited. A sweep claims up to 25 due rows in one statement that sets `leaseUntil = now + 60 s` and `attempts + 1`, using `FOR UPDATE SKIP LOCKED`, so two replicas or a kick and a sweep never take the same row, and a lease that ran out frees a row whose owner crashed. Rows are sent four at a time with a 5 s timeout each; one recipient's or one channel's failure never delays another's call. Two channels are two rows and two notify-api calls (not `email: true` on one call, ADR 20261101-notify-api-resolves-email-notice-address-from-auth's shape), so a failed email is retried without repeating the in-app call.
5. **Retries and the end.** A failure is retried at +1, +3, +5, +10 and +20 minutes, then every 30, never later than `createdAt + 24 h` (the version's transaction time); at that time the row is `given_up`. A pending row found past 24 h with no attempt is given up as `expired`. The reasons are a closed set (`notify_unreachable`, `notify_refused`, `notify_error`, `recipient_inactive`, `email_not_configured`, `outside_address_unset`, `recipient_deleted`, `expired`). A person deleted after the store is never sent to (`recipient_deleted`, given up at once); an unset outside address at send time is `outside_address_unset`.
6. **Every outcome is audited, in the same transaction as the row's update.** `legal_entity.notice_failed` (the first failure of a row only), `legal_entity.notice_delivered` (success of a row that had failed), `legal_entity.notice_given_up`, `legal_entity.notice_no_recipients`; Tier 2, `actorUserId: null`, data `{ version, recipient: "person"|"outside", userId?, channel, reason?, at }`. The sweep logs `legal_entity_notice_overdue` with the count of rows pending for more than 5 minutes.
7. **At-least-once, made safe by the receiver.** A timeout after notify-api committed is ambiguous, so every call carries `legal-entity-notice:<row id>` and notify-api answers a repeat with the first result (the receiver-side rule is in the sibling ADR, above).
8. **Not for imports.** The CRM copy (`import.ts`, action `import`) never reaches this code (AC-9.16): the writer accepts only `save | restore`, `import.ts` does not import it, and a test reads both.
9. **What this ADR does not change.** The access-request notice of ADR 20261105-auth-pushes-admin-notifications, the refund decision notice of ADR 20260716-system-notifications-cross-user-trigger and every other `/system/notifications` caller stay best-effort. This is a departure for one notice with a reason (the control must survive the abuse it guards against), not a new default.

## Failure shape

**A control whose whole value is that it fires after something went wrong is attached to its trigger by a path that can be lost without anyone noticing.** The record of the event commits; the promise to tell people about it lives only in the memory of a process, or in a call that a restart, a timeout or a downstream outage drops. Nothing errors, the save looks successful, and the one person who would have caught the abuse never hears. The mirror failure is making the signal part of the action so strongly that the downstream service's trouble blocks or rolls back the primary action.

Where else this shape can appear, including the mirror-image positions:

- **Commit and send.** The promise must be written in the same transaction as the fact (a row, not a callback); it must never be an in-memory queue, a `setTimeout`, or a call made before commit (a notice of a version that then rolls back). Recognise it by asking: if the process is killed one millisecond after commit, who still knows a message is owed?
- **Sender and receiver.** At-least-once delivery without a receiver that recognises repeats produces duplicates; "exactly once" built on the sender alone cannot see an ambiguous timeout. Any new durable send needs both halves.
- **Compute recipients early and late.** Recipients chosen at send time can be silenced by the very change they should hear of (a role removed in between); chosen at store time they can be stale about people who left (a deleted person must be skipped at send time). Decide each, and write both rules.
- **Success and failure of the duty itself.** A failure of the receiving service must not reach the primary action; a failure of the sender's own database must (the duty and the fact stand or fall together). Do not blur the two.
- **Silent end of the retries.** A duty that is given up must leave a record someone can find; a retry loop that just stops is the same loss as no retry.
- **Other durable duties.** A second kind of notice, a webhook to another system, a mail on an approval: each is a candidate for the same outbox, or a stated reason why best effort is enough there (access requests: the screen shows the request).
- **Leaking the thing being protected.** A row, a log line, an audit entry or a key that copies the sensitive value turns the safety net into a second copy of the data.

## Options considered

### Option A — Outbox rows in the version's transaction, an in-process dispatcher with leases, retries to 24 h, audited outcomes (chosen)

Described above.

**Pros:**
- The duty and the version stand or fall together (AC-9.14), including across a crash, a restart and a rollout
- No new service or dependency; works with several replicas of `auth`
- Notify-api trouble cannot change what the save answers
- Every row ends `delivered` or `given_up`, with an audit entry

**Cons:**
- `auth` gets a table, a timer, and a transaction that does more on a protected save (recipients are computed under the entity lock; only protected saves pay, risk R17)
- A write failure of the duty rows fails the save
- A dispatcher that stops leaves notices waiting (mitigated by the sweep on start and the overdue log, risk R16)

### Option B — The suite's usual fire-and-forget after commit (rejected)

As `signup/notifyAdmins.ts`, ADR 20261105-auth-pushes-admin-notifications and ADR 20260716-system-notifications-cross-user-trigger §4.

**Pros:**
- Nothing new in `auth`; the save never depends on the notice

**Cons:**
- A restart between commit and send loses the notice and nothing shows it; there is no retry. Contradicts AC-9.14.

### Option C — A queue service (rejected)

**Pros:**
- Standard shape for durable delivery

**Cons:**
- None exists in the suite; a new deployed dependency for one notice

### Option D — Compute recipients at send time (rejected)

**Pros:**
- Always current

**Cons:**
- A role removal between store and send would silence a recipient, which is the attack AC-9.10 guards against

### Option E — One call with `email: true` for both channels (rejected)

The shape of ADR 20261105-auth-pushes-admin-notifications.

**Pros:**
- One call per recipient

**Cons:**
- A failed email can only be retried by repeating the in-app call, and its `skipped` hides the reason

### Option F — Deduplicate in `auth` only (rejected)

**Pros:**
- No change in notify-api

**Cons:**
- `auth` cannot see an ambiguous outcome after a timeout

## Evidence

- QE (specs/20261117-legal-entities/qe-report.md, executed on compose Postgres, no real email): AC-9.7 all 9 rows `delivered` at attempt 1 when read 12 s after the save; AC-9.14 notify-api down leaves the save's answer 201 with the same shape, retries at +1 and +3 minutes, give-up at +25 h on an injected clock, `kill -9` durability, no duplicate through 3 attempts; AC-9.15 9 `notice_failed` (first failure only), 9 `notice_delivered`, 9 `notice_given_up`, none holding a value.
- Tests: `auth/src/legalEntities/notices/duty.test.ts` (rows in the version's transaction, a forced failure after the insert leaves no version, audit or row; the import writes none), `dispatcher.test.ts` (injected clock and fake notify-api over HTTP; two dispatchers on one database make one call per row; the committed-transaction group uses the local-host guard of F4), `recipients.test.ts`.
- Security re-review (security-review-2.md, T70): PASS WITH NOTES; no value found in a notice's records, rows, logs or keys.

## Consequences

**Positive:**
- A protected change is told to the people who can undo it, even through a restart or an outage of notify-api, and a notice that cannot be delivered is visible in the audit log within 24 hours
- The save's answer does not depend on notify-api
- A later durable notice reuses the table's shape

**Negative / trade-offs:**
- A suite with two postures for "auth tells someone": best effort (access requests, refund decisions) and durable (this). A reader must check which applies.
- `auth` owns a timer and a state machine (`pending`, `delivered`, `given_up`). There is no cleanup job: a few rows per protected change.
- Push text is English only: notify-api's push sends the English title and body (reading R-a, risk R20); the centre shows the reader's language.

**Risks:**
- **The dispatcher stops** (crash loop, bug): notices wait. Mitigation: sweep on start, `legal_entity_notice_overdue` log, every row ends in an audited state within 24 hours (R16). T71 (release step 7) confirms the path in production.
- **Order of release.** An old notify-api answering 400 to the new template is retried, so no order loses a notice (plan G15); between push 1 and push 2 a save by an administrator stores no notice, and only administrators hold the grant then (OQ-12).
- **What the notice cannot defend (security-review-2.md N4, decided by the owner, not a defect).** Against a stolen administrator session, the attacker can soft-delete or demote the other recipients before the change, because recipients are fixed at store time; the actor still gets the receipt, and the outside mailbox, when `LEGAL_ENTITY_NOTICE_EMAIL` is set, is outside the suite's reach. Its reach therefore depends on that variable: the release log records whether it is set and that the first notice was read there (T71, step 7), and `legal-entity:manage` is not granted outside the `admin` role before that.
- **The actor's name in the notice is a display name its holder can probably change** (security-review-2.md N1, an owner decision left open when this ADR was written). Not decided here.
- **`LEGAL_ENTITY_NOTICE_EMAIL` mistyped** fails silently to the person; validated as an email at startup and failures are audited (R21).
- **In-memory limiters per replica** bound the volume an abused session can cause (10 protected changes per 10 minutes per person, times N replicas; R18).

## Escalation triggers

This decision is revisited when any of these happens:

- a second durable notice is wanted in `auth` or another service: lift the table and dispatcher into shared code rather than copy them;
- a queue or job runner is adopted in the suite (compare ADR 20261104-durable-job-runner-work-queued-state-derived): decide whether this outbox moves onto it;
- another origin than `admin`, or another scope for `system:auth`: ADR 20261105-auth-pushes-admin-notifications still says to revisit rather than widen quietly;
- the owner wants Italian push text or a shorter first-retry time (AC-9.14 and R-a are owner readings).

## Compliance notes

- GDPR / data-protection impact: low. The rows hold user ids, an entity and a version number; the outside address is read from the environment at send time and never stored. Notices name the actor by display name (see N1) [amended 2026-11-18: by account email, see the Status line] and carry at most the last 4 characters of an IBAN.
- Data residency: no new third party and no new data flow: `auth` already calls notify-api, which already sends through Resend (ADR 20260714-notify-api-email-channel-service-trust); the notice adds a content class (a change of a legal detail, without its values), not a recipient of data.
- Audit trail: required, and provided (Tier 2 `audit_log`, ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level). The notice rows themselves are Tier 2 and carry no immutability trigger, because the dispatcher updates them; the immutable record is the version.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
