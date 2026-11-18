# 20261117 — notify-api's system routes protect against repeats with a caller-scoped idempotency key (a partial unique index for notifications, a `sent`-only one for emails, the same key passed to Resend), and an email template can be bound to its caller, addressed by user id, and fed only closed typed data

**Date:** 2026-11-17  
**Status:** Accepted — approved plan amendment "after security review" of specs/20261117-legal-entities (2026-11-17), owner decisions AC-9.12 (no value of a detail leaves auth in a notice beyond an IBAN's last 4 characters) and AC-9.14 (no recipient gets two notices on one channel for one version, retries included). Plan ADR candidate 6. **Amends** ADR 20260714-notify-api-email-channel-service-trust (a template open to every caller, addressed by `to`, no repeat protection) and ADR 20261101-notify-api-resolves-email-notice-address-from-auth (an address is resolved from a user id only for `email: true` on `/system/notifications`). **Amended 2026-11-18** by ADR 20261118-a-notice-identifies-its-author-by-the-account-email-captured-in-the-versions-transaction-and-that-address-is-the-one-personal-value-a-notice-carries: point 7's bounded actor name `actorName` becomes `actorEmail` (an email of at most 320 characters or null, content only); the GDPR line "No address is added to any request" now has one exception, the author's address as content. Addressing by `recipientId` is unchanged.  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

The durable notice of a protected legal-entity change (ADR 20261117-notices-of-a-protected-legal-entity-change-are-a-durable-duty-an-outbox-written-in-the-versions-transaction-sent-at-least-once-for-24-hours-with-outcomes-in-the-audit-log) is sent at least once: a timeout after notify-api committed is ambiguous, so `auth` must be able to retry. Only the receiver can make that retry safe. Today it cannot: `POST /system/notifications` and `POST /system/emails` have no repeat protection, so a retried call is a second notification, a second push and a second email.

Three more facts shape the receiving side:

- **Any holder of `emails.send` can send any template.** ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired gave one scope per capability, so the callers (`auth`, `refund-api`) are told apart from the push-only services. It did not tell templates apart: a new template that carries the text of a legal-entity change would be sendable by every holder. A generic "caller-supplied text" template would let any `emails.send` holder mail arbitrary text from wellD's domain.
- **`/system/emails` takes a raw address.** ADR 20261101-notify-api-resolves-email-notice-address-from-auth keeps addresses out of callers by resolving them in notify-api, but only through `email: true`, which is one call for both channels. The notice needs the email as its own call (to retry one channel without the other) and addressed by person.
- **A notice must not carry a value.** AC-9.12 says the only value that may leave `auth` is an IBAN's last 4 characters. The sender is tested for it; the receiver can enforce it too.

## Decision

We will give both `/system/*` routes an optional `idempotencyKey` scoped to the calling service's `sub`, and give `/system/emails` a per-template policy: the template `legal_entity_change` can be sent only by `system:auth`, is the only one that accepts `recipientId` (notify-api then resolves the address from `auth`), and takes a strict, closed `data` shape that cannot hold a value beyond an IBAN's last 4 characters. Every other template behaves as before.

(Plan, G1 points 3 and 5, G4 "notify-api migration", G5; `notify-api/prisma/migrations/20261117100000_system_idempotency`, `src/system/emails.routes.ts` (`EMAIL_TEMPLATE_POLICY`), `emails.schemas.ts` (`LegalEntityChangeDataSchema`), `emailTemplates.ts`, `src/channels/email.channel.ts`; tasks T56, T57.)

1. **The key.** `idempotencyKey` is 1 to 200 characters, `^[A-Za-z0-9._:-]+$`, and the pair is `(callerSub, idempotencyKey)` with `callerSub` taken from the verified service token (`serviceSub`), never from the body, so two callers never share a key space and a key is not an oracle for another caller's traffic. The sender builds it from a row id (`legal-entity-notice:<row id>`) and puts no value in it.
2. **Notifications.** `notification` gains `callerSub` and `idempotencyKey`, a partial unique index `(callerSub, idempotencyKey) WHERE idempotencyKey IS NOT NULL` (hand-written, Prisma cannot express it), and a CHECK that a key never exists without its caller. First call: 201 as today. A repeat, or a concurrent call that loses the unique race and reads the winner: **200** with the stored notification; nothing is published, pushed or mailed again.
3. **Emails.** `email_delivery` gains the same two columns, an ordinary index, and a partial unique index on `(callerSub, idempotencyKey) WHERE idempotencyKey IS NOT NULL AND status = 'sent'`: at most one `sent` delivery per pair, while failed attempts may repeat. A repeat after a `sent` attempt answers 200 with the same `deliveryId` and sends nothing, and it answers **before** any address lookup, so a user who became inactive since cannot undo a delivered send. After `failed` attempts alone, the send is tried again.
4. **Resend sees the key too.** The channel passes `<sub>:<key>` to Resend as its idempotency key through the SDK's own option (`emails.send(payload, { idempotencyKey })`, resend 6.17.2; a pair over 256 characters is hashed, not truncated). Resend keeps keys for 24 hours, the same window as the retries; notify-api's own record has no expiry. A Resend refusal of a reused key is a soft `failed`, never a throw.
5. **A template policy table.** `EMAIL_TEMPLATE_POLICY` maps a template to the `callers` that may send it and to `allowRecipientId`. A caller outside the list gets 403 `template_not_allowed` and nothing is written. `recipientId` for a template that does not allow it is a 400 (`recipient_id_not_allowed`), so no other caller gains "mail any user by id". A template absent from the table is open to every `emails.send` holder and takes `to` only, as before.
6. **Addressing.** `legal_entity_change` takes exactly one of `to` and `recipientId`. `to` is for the outside mailbox, which has no user id. With `recipientId`, notify-api resolves the address from `auth` as ADR 20261101-notify-api-resolves-email-notice-address-from-auth does, so `auth` still puts no person's address in a request. An inactive user is 200 `skipped` / `recipient_inactive`; a failed lookup is `failed` / `contact_lookup_failed`; an unset email-notice group (or `APP_BASE_URL`) is `skipped` / `not_configured`; none of these has an address, so none writes a delivery row. The response `status` gains `skipped` and an optional closed `reason`.
7. **Closed, typed data.** `LegalEntityChangeDataSchema` is a `strictObject`: the entity (`welld_it | welld_ch`), `action` and `restoredFrom`, a bounded actor name (the sender strips controls and bidi characters, the template does it again and escapes), `storedAt`, `version`, `protectedChanged` and `otherChanged` as unique names from closed lists, and `iban` as `{ old, new }` of `none | set | tail(last4 ^[A-Z0-9]{4}$)`, present if and only if the IBAN changed. There is no member that can hold a legal name, VAT number, address, contacts line or more than 4 IBAN characters, and an extra member is a 400. The link is built by notify-api from its own `APP_BASE_URL` and the closed entity. The email is English for everyone (AC-9.13).
8. **Rejected: a generic text template, and auth sending addresses.** See Options.

## Failure shape

**A retry, or a second party that can reach the same door, produces an effect that only the receiver is positioned to prevent.** A sender that cannot tell "did not arrive" from "arrived and the answer was lost" must repeat, so the receiver must recognise the repeat; and a door guarded only by "you hold the capability" lets every holder do everything the capability can express, including things that were built for one caller. The effect is silent: two emails, a message from the company's domain with text nobody reviewed, an address looked up for someone who was never meant to be mailed.

Where else this shape can appear, including the mirror-image positions:

- **Sender and receiver.** At-least-once on one side needs a receiver that recognises the repeat on the other; deduplication in the sender alone cannot see an ambiguous outcome. Any new internal route that creates a side effect (a mail, a push, a webhook, a charge) and may be retried needs the same pair.
- **Key scope.** A key that is global, or taken from the request body for the caller, can be replayed or probed across callers; scope it by the authenticated caller. A key that is unique over failures too would block the retry it exists for; a uniqueness that covers only the successful outcome (`sent`) is the shape for "try again until it works".
- **Check and act.** A repeat must be answered before any step whose outcome may have changed since the first call (a lookup of a user who is inactive now), or the second answer can undo the first.
- **Capability and caller.** A scope says which capability; it does not say which caller may use which template or shape. Every new template, route variant or addressing mode (here, by user id) needs its own statement of who may use it, with the default being "nobody else".
- **Free text and closed data.** A template that accepts caller-written text turns the service into a sender of arbitrary mail from its domain; the mirror is a template whose `data` can carry a sensitive value because nothing forbids a member. Enforce the closed shape at the receiver as well as the sender, and strictly (unknown members refused).
- **Outbound as well as inbound.** The same key reaches the provider (Resend): an internal dedup that the provider does not share can still double-send after a crash between the provider's accept and the local record.
- **Inbound and outbound addresses.** Addressing by id keeps addresses out of callers; any new route that makes a caller hold a list of addresses it does not otherwise need is the same defect.

## Options considered

### Option A — Caller-scoped key with partial unique indexes, Resend key, a policy table, closed typed data (chosen)

Described above.

**Pros:**
- A retry is safe whatever the sender saw (timeout, crash, lost answer)
- No other `emails.send` holder can send the template, address by id, or learn from a key
- AC-9.12 is enforced by the receiver as well as the sender
- Additive: nullable columns, new indexes; a deploy can roll back by ignoring the columns; callers that send no key behave as before

**Cons:**
- notify-api grows a policy table and a closed template that knows about a legal-entity change (it is the one template that does; the generic route stays domain-agnostic)
- Two repeat rules (notifications unique over all rows with a key, emails over `sent` only) to keep in mind
- If the SDK had not taken the key, a crash between Resend's accept and the local record could produce one duplicate email (plan R15); resend 6.17.2 takes it, so the window is covered for 24 hours

### Option B — Accept rare duplicates (rejected)

**Pros:**
- Nothing to build

**Cons:**
- Contradicts AC-9.14

### Option C — Deduplicate in `auth` only (rejected)

**Pros:**
- No change in notify-api

**Cons:**
- `auth` cannot see an ambiguous outcome after a timeout

### Option D — A generic template with caller-supplied text (rejected)

**Pros:**
- No template per notice

**Cons:**
- Any `emails.send` holder could mail arbitrary text from wellD's domain: a phishing surface

### Option E — `auth` sends persons' addresses to `/system/emails` (rejected)

**Pros:**
- No lookup in notify-api

**Cons:**
- Against ADR 20261101-notify-api-resolves-email-notice-address-from-auth and ADR 20261105-auth-pushes-admin-notifications: `auth` would put admin and manager addresses in requests it should not need to build

### Option F — `email: true` on `/system/notifications` for the email channel (rejected)

**Pros:**
- Already exists

**Cons:**
- One call carries both channels, so a failed email can only be retried by repeating the in-app call, and its `skipped` hides the reason

## Evidence

- Tests: `notify-api/src/system/notifications.idempotency.test.ts`, `notifications.repo.idempotency.test.ts` (concurrent repeat loses the race and reads the winner), `emails.idempotency.test.ts` (repeat after `sent` sends nothing; after `failed` sends again; key not shared across callers), `emails.routes.test.ts` (403 `template_not_allowed` and nothing written; `recipientId` for another template is 400), `src/channels/email.channel.resend.test.ts` (the key reaches Resend as `Idempotency-Key` through the SDK option; no header without a key; a Resend refusal of a key is a soft failure), `emailTemplates.test.ts` and `notifications.schemas.test.ts`.
- QE (specs/20261117-legal-entities/qe-report.md, AC-9.13 and 9.14): no duplicate through 3 attempts; email in English including the outside mailbox.
- Security re-review (T70, security-review-2.md): the key scoping, the template binding, `recipientId` limited to the template and the strict `data` were reviewed and found sound; the one note on them, N7 (info), is the key-only repeat rule in Risks below.

## Consequences

**Positive:**
- Any future system caller that must retry gets the same protection by sending a key
- A template that must be sent by one service can say so in one table entry
- AC-9.12 holds at the receiver: a bug or a compromised `auth` cannot mail a legal name through this template

**Negative / trade-offs:**
- Another per-template policy to remember when adding a template; the default (open, `to` only) is the old behaviour, so a template that should be bound must be added to the table deliberately
- notify-api now depends on `auth` for a second address lookup path (ADR 20261101-notify-api-resolves-email-notice-address-from-auth's `users.contact`, unchanged; its escalation trigger "a second client asking for `users.contact`" is not tripped, since the caller is still notify-api)
- Keys are kept without expiry in notify-api, so the table grows by a few rows per protected change

**Risks:**
- **Push text.** A repeat answers 200 and raises no second push; the push channel's own limits (English text, plan R20) stay as they were.
- **A repeat is recognised by its key alone, not by its request** (security-review-2.md N7, info, no action). The same key with another recipient or other content gets the first result and sends nothing, and `email: true` on a repeated notification is never acted on. The key is built from a unique row id; if another caller ever reuses keys, compare a hash of the payload on a repeat.
- **Release order.** notify-api is in the first push, before `auth` sends the new template; an old notify-api answers 400 and `auth` retries (plan G15).

## Escalation triggers

This decision is revisited when any of these happens:

- a second template needs a `callers` binding or `recipientId` addressing: decide whether the policy table stays in code or becomes configuration, and whether `recipientId` is still limited to one template;
- a route outside `/system/*` needs repeat protection;
- Resend stops honouring idempotency keys, or keeps them for less than the retry window;
- a caller needs a key space across services.

## Compliance notes

- GDPR / data-protection impact: low. No address is added to any request [amended 2026-11-18: one exception, the author's address as content, see the Status line]; the delivery row keeps the address as it did before; keys carry a row id and no value. The email carries names of changed details and at most the last 4 characters of an IBAN.
- Data residency: compliant; no new third party (Resend was already the email provider, ADR 20260714-notify-api-email-channel-service-trust).
- Audit trail: not required by this ADR; the audit of the notice is in ADR 20261117-notices-of-a-protected-legal-entity-change-are-a-durable-duty-an-outbox-written-in-the-versions-transaction-sent-at-least-once-for-24-hours-with-outcomes-in-the-audit-log.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
