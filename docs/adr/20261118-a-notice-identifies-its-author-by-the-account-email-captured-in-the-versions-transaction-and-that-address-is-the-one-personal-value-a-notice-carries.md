# 20261118 — A notice identifies its author by the account email captured in the version's transaction, and that address is the one personal value a notice carries

**Date:** 2026-11-18  
**Status:** Accepted (owner, 2026-11-18) — owner decision of 2026-11-18 recorded in specs/20261117-legal-entities/tasks.md (`d1da2ecc`), spec amendment D9 (`269090f1`: AC-9.11, AC-9.12, AC-9.16, OQ-14 to OQ-16), plan "Amendment 2026-11-18 — D9" (J1–J12), closing security-review-2.md N1 and qe-report.md O-1. Plan ADR candidate D9-1. **Amends** ADR 20261117-notices-of-a-protected-legal-entity-change-are-a-durable-duty-an-outbox-written-in-the-versions-transaction-sent-at-least-once-for-24-hours-with-outcomes-in-the-audit-log (point 3 "The rows hold no value", its open note on N1, its GDPR line) and ADR 20261117-notify-api-system-routes-protect-against-repeats-by-a-caller-scoped-idempotency-key-and-bind-a-template-to-its-caller-with-closed-typed-data (point 7, its GDPR line "No address is added to any request").  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

A notice of a protected change to a legal entity (legal name, VAT number, IBAN) exists so that other people can see that something was changed and by whom. The first design named the author by `createdByName`, read at send time. Security re-review N1 found that this is a display name its holder can edit (`POST /auth/update-user`), so the person whose change is being reported chooses the words that identify them, and the notice can say "Anna Rossi" about an account that is not Anna Rossi's. The owner decided on 2026-11-18 that the notice identifies the author by the **account email**, a value the holder cannot freely set (sign-in is by Google or GitHub only), and accepted that this makes the author's address the one personal value a notice carries. The history and the audit log are not part of this decision (OQ-16).

## Decision

We will store the author's account email on every `legal_entity_notice` row of a version (`authorEmail`, nullable, Tier 2), read from the `user` row inside the version's own transaction, and state it as content in the in-app body, the push text and the email; no display name appears anywhere in a notice, and the address is the only personal value a notice carries.

1. **Captured at store time, in the transaction.** `recordNoticeDuty` reads `tx.user.findUnique({ where: { id: actorUserId }, select: { email: true } })` after `appendVersion`, under the entity lock, and `createMany` writes the one value on every row of the version (person rows and the outside row), so the rows cannot disagree. It is not read from the session (Better Auth's cookie cache can be up to 5 minutes old) and not at send time (a change of the address, or a deletion of the account, during the 24-hour retries would change what the notice says). Stored verbatim, never lowercased; an empty string or a missing row is `null`. The capture never fails the save: the one CHECK is `"authorEmail" IS NULL OR "authorEmail" <> ''`.
2. **Where it lives.** A nullable column on `legal_entity_notice` by a new additive migration (the applied migration is not edited), no backfill (only protected changes have notice rows; the import never reaches the duty, AC-9.16). Written once at capture, **cleared once (to NULL) at the terminal status** (`delivered` / `given_up`), never otherwise updated: the dispatcher nulls it in the same update that sets the terminal status, and its other updates set status columns only (tested). Migration `20261118120000_legal_entity_notice_author_email_clear` enforces this with a trigger (an UPDATE may change the column only to NULL, and only on a row terminal after the update) and the CHECK `"status" = 'pending' OR "authorEmail" IS NULL` *(amended 2026-11-18 by T88, security delta D9-1; first written as "never updated")*. It is **not** on `legal_entity_version` (Tier 1 append-only: the address could never be corrected or erased, and the version's SELECT list is read by letterhead-api and crm-api) and not in a separate author table.
3. **One rule for an address.** `noticeAuthorEmail = z.string().email().max(320)`, exported by `content.ts`, the rule of notify-api's `ToSchema`. An address that fails it, or `null`, is stated as "no email address on record" and logs `legal_entity_notice_author_email_unusable` with ids and no value (reading R-D9a); it never falls back to a display name. The copy names the account, not a person ("Change saved by the account …").
4. **notify-api.** `legal_entity_change` `data` stays a `strictObject`: `actorName` is removed (sent, it is a 400), `actorEmail` is required, an email of at most 320 characters or `null`. The template HTML-escapes it, prints it as text with no `mailto:`, and has no name fallback. Subject and title stay closed values; the address is in the body only. A 400 does not echo the value.
5. **Where the address may and may not appear.** Allowed: the in-app body and the push text, the email body and its request `data` (outside mailbox included), the notification notify-api stores, the Resend payload, the outbox column. Never: an auth or notify-api log line, an audit entry, an idempotency key, an error message (`safeErrorText` only for a failed save). A procedure that erases an account's personal data must also cover notify-api's stored notifications (and a still-pending `legal_entity_notice` row); none exists today.
6. **Release.** notify-api (push 1) accepts `actorEmail` before auth (push 2) sends it, replacing the member outright (no transition accepting both). New auth against an old notify-api cannot happen in the planned order, and if it does the dispatcher retries and then gives up with audit entries.

## Failure shape

**A record meant to tell others who did something takes the "who" from a field the subject of the record controls, so the subject writes their own attribution.** Nothing errors and the record looks well formed; it simply cannot be trusted at the one moment it is needed, when the actor is not who the account says. The same record is also wrong if the "who" is looked up later from a mutable source (it drifts between the event and the telling), or is copied into a store that can never be corrected.

Where else this shape can appear, including the mirror-image positions:

- **Attribution on the write side and on the read side.** An audit entry, a history row, a receipt, a "last modified by" label, a log line: ask whether the identifying value comes from something the person can edit (display name, avatar text, a free "signed by" field) and whether it was fixed at the event or resolved when someone looks.
- **Capture early and late.** A value read at send time, view time or export time follows later edits and deletions; a value captured from a cached session follows the cache. The right moment is the event's own transaction, from the authoritative row.
- **Where the captured copy goes.** An immutable table makes a personal value permanent; a mutable outbox row can be corrected and erased. Put a personal copy where the data-protection duty can still be met, and keep it out of tables that other services' reads select from.
- **An exception to "carries no value".** A record that promised to hold no value now holds one. The exception must be a named, closed list (here: one address, in content only) with sentinel tests in both directions: the allowed places contain it, and every other place (logs, audit, keys, errors, 400 bodies) does not. A second personal value is a new decision, not a precedent.
- **Sender and receiver.** The receiver's schema must refuse the old member and require the new one; the old member must not survive in either direction of a skewed deploy.
- **The same person in the other records.** The history and the audit log still show the display name (OQ-16). A new surface that quotes the author must pick the account email or the name deliberately, and must not mix them in one sentence.

## Options considered

### Option A — Capture the account email on the notice rows in the version's transaction (chosen)

**Pros:** fixed with the version like the recipients; the holder cannot rewrite it; Tier 2, so correctable and erasable; written only on protected changes; the dispatcher works per row with no join at send time.  
**Cons:** the address is copied 2N+1 times per protected change; a personal value now sits in a table that promised none; it appears in push text on a lock screen (accepted by the owner, AC-9.12).

### Option B — `createdByEmail` on `legal_entity_version` (rejected)

**Pros:** one record of the version and its author.  
**Cons:** Tier 1 append-only: never correctable or erasable; written on every save; one SELECT-list change would leak it into `GET /system/legal-entities`, read by letterhead-api and crm-api.

### Option C — Read `user.email` by `createdByUserId` at send time (rejected)

**Pros:** no new column.  
**Cons:** the notice changes if the address is changed or the account deleted during the 24-hour retries; a retry does not send the same words.

### Option D — A table `legal_entity_notice_author`, one row per noticed version (rejected)

**Pros:** one copy instead of 2N+1.  
**Cons:** a table, a foreign key and a Tier 2 surface for a few dozen bytes; the per-row copy from one value already cannot disagree (tested).

### Option E — The session's `user.email` (rejected)

**Pros:** no read.  
**Cons:** up to 5 minutes stale (cookie cache).

### Option F — Keep the display name, strip it (rejected)

**Pros:** no new personal value.  
**Cons:** it is exactly what N1 found: the holder edits it. Stripping controls and bidi characters does not make it true.

### Option G — Resolve the author's email in notify-api by id (rejected)

**Pros:** auth sends no address.  
**Cons:** needs a new lookup and a policy for it; send-time resolution has Option C's drift. Not needed: the address is content, captured once.

## Evidence

- specs/20261117-legal-entities/plan.md, "Amendment 2026-11-18 — D9", J1–J13; tasks T78–T89 (T88: the terminal clear, D9-1) (T79 and T82 notify-api, push 1; T80, T81, T83 auth, push 2; T86 OWASP delta; T87 owner early check R26).
- Tests per plan J8: sentinel display name `D9 Sentinel Display Name` absent everywhere; sentinel address `d9-sentinel-author@operai.test` only in the allowed places and never in logs, audit entries, titles, subjects or 400 bodies; address and name changed and actor soft-deleted after the store, the notice still states the captured address; no update of a row names `authorEmail` except the terminal clear to NULL (T88).
- specs/20261117-legal-entities/security-review-2.md N1; qe-report.md O-1.

## Consequences

**Positive:**
- The notice's attribution cannot be rewritten by the person it reports on
- A retry sends the same words for 24 hours
- The version table, the history and the service reads are unchanged

**Negative / trade-offs:**
- One more personal value in a store that was a no-value store, and in push text and email
- The notice states what the account says, not who used it (spec Non-goal); the copy says "account"
- Two surfaces name the author differently: the notice by account email, the history and the audit log by name

**Risks:**
- **An address that fails the shared rule** would make notify-api refuse the email channel. `content.ts` applies the rule first (R-D9a); T87 counts failing production `user` rows (expected 0), recording the count only.
- **Rows written by a pre-D9 build** (development, CI, e2e databases) read `null`. Production never runs a pre-D9 notice build (T48 depends on T80 and T81).
- **Erasure.** No account-erasure procedure exists; when one is written it must cover notify-api's stored notifications (and a still-pending notice row; terminal rows hold no address since T88).
- **Scope creep.** Another value that identifies a person entering a notice needs its own decision.

## What this does NOT change

- **Recipient addressing is by `recipientId`.** auth still puts no recipient's address in a request; notify-api resolves it (ADR 20261101-notify-api-resolves-email-notice-address-from-auth). The author's address is content, never addressing, and the only address in a request is that content plus the outside mailbox's `to`. ADR 6's rejected Option E (auth sending addresses for recipients) stays rejected.
- **History and audit keep the name** (OQ-16): `legal_entity_version.createdByName`, the history and the `legal_entity.*` audit entries are unchanged. The notice code stops reading `createdByName`.
- Recipients, schedule, leases, keys, reasons, the audit outcomes of the dispatcher, the closed IBAN-tail rule, and AC-9.16 (imports never reach the duty).

## Escalation triggers

This decision is revisited when any of these happens:

- an account-erasure or retention procedure is written (it must cover the column and notify-api's notifications);
- a notice, or a second durable notice, is wanted to carry another personal value;
- sign-in methods are added that let an account hold an unverified or user-chosen email;
- the history and audit log are changed to stop showing the display name (OQ-16), or the owner wants one identifier everywhere.

## Compliance notes

- GDPR / data-protection impact: medium (was low). One personal value is now stored on `legal_entity_notice` and sent to notify-api, the push provider and Resend as content. Storage on `legal_entity_notice` is limited to the sending window: the address is cleared when the row reaches `delivered` or `given_up`, at most 24 hours after capture (T88, D9-1). notify-api's stored notification (`body`, `bodyIt`) still holds the address; its retention is a separate item. The address never reaches logs, audit entries or keys. No erasure procedure exists yet (see Risks).
- Data residency: no new third party and no new data flow (auth already calls notify-api, which already sends through Resend); Resend and push providers now receive the author's address in content, to be confirmed against the residency position of ADR 20260714-notify-api-email-channel-service-trust.
- Audit trail: required for the notice outcomes and unchanged (ADR 20261117-notices-of-… Tier 2 `audit_log`); the address is deliberately not in it.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
