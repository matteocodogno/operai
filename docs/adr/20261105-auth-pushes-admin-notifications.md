# 20261105 — auth pushes admin notifications: `system:auth` gains `notifications.push`, bound to origin `admin`

**Date:** 2026-11-05
**Status:** Accepted (specs/20261105-signup-gate) Amended 2026-11-17 by ADR 20261117-notices-of-a-protected-legal-entity-change-are-a-durable-duty-an-outbox-written-in-the-versions-transaction-sent-at-least-once-for-24-hours-with-outcomes-in-the-audit-log (its escalation trigger, a second kind of notice from `auth`, fired; the access-request notice itself stays best-effort and the origin `admin` binding is unchanged).
**Deciders:** wellD
**Project:** Operai

---

## Context

ADR 20261105-access-only-by-invitation-waiting-list puts people on a waiting list. Admins must learn of a new request, in the app and by
email, or a colleague waits because nobody looked. The event happens in `auth` (the sign-up
gate), and the recipients are the effective admins, which `auth` already computes. ADR 20261013-auth-mints-own-service-credential-in-process/0049
made `auth` a notify-api caller for email only (`emails.send`), with origin bindings per client.
ADR 20261101-notify-api-resolves-email-notice-address-from-auth lets a caller set `email: true` on `/system/notifications` so notify-api resolves the
address from `auth` itself.

## Decision

We decided that `system:auth` gains the scope `notifications.push` (`SELF_SERVICE_SCOPES` becomes
`["emails.send","notifications.push"]`) and notify-api's `SERVICE_ORIGIN_BINDINGS["system:auth"]`
becomes `["admin"]`, **amending ADR 20261013-auth-mints-own-service-credential-in-process/0049's "auth: email only"**. For each active effective
admin `auth` posts `/system/notifications` with `originApp: "admin"`, a relative link to the
access-requests screen and `email: true`; it sends no address. The calls start after the request row
is committed, are not awaited by the sign-in, and every failure is caught and logged
(`auth.access_request_notify_failed`).

## Failure shape

**A side effect of the primary action becoming able to block, undo or leak through it.** A
notification hung off a security-relevant flow can slow the refusal page, roll back the record it
announces, or carry data (here, addresses) the sender has no other reason to handle. A second
shape is a credential that quietly grows: a service principal gains a capability for one feature
and the scope, origin binding or audience is widened to "whatever is convenient".

Where else this shape can appear, including mirror-image positions:

- **Sender and receiver.** The caller must not place recipient addresses in requests when the
  receiver can resolve them by id (ADR 20261101-notify-api-resolves-email-notice-address-from-auth); the same applies to any new template or channel.
- **Grant and use.** A new scope must come with its origin binding in the same change; a scope with
  no binding, or a binding wider than the one tool the notice belongs to, is the defect.
- **Success and failure paths.** Every best-effort notice needs a test that its failure leaves the
  triggering record and the user-facing result unchanged, and that a repeat of the trigger does not
  notify again.
- **Inbound and outbound.** Anything `auth` receives from the unauthenticated (a name typed at a
  provider) and then sends onward is plain text, escaped by the receiver's template.

## Options considered

### Option A — `notifications.push` for `system:auth`, origin `admin`, `email: true` (chosen)
**Pros:** in-app and email in one call; no addresses leave `auth`; reuses ADR 20261101-notify-api-resolves-email-notice-address-from-auth and ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired's
one-scope-per-capability model; the notice belongs to the Admin tool and is raised as such.
**Cons:** `auth` is now both a push caller and the address resolver for notify-api (a loop of
calls, contained by best effort); a wider scope on the identity service's own principal.

### Option B — An email-only template through `/system/emails`
**Cons:** the user asked for in-app too; `auth` would put admin addresses into requests it should
not need to build. Rejected.

### Option C — A new origin app `auth`
**Cons:** the work happens in the Admin tool, so the notice belongs under `admin`; a new origin
adds a binding and a UI label for no benefit. Rejected.

## Consequences

**Positive:**
- Admins get an in-app notification and an email per new request, linking to Admin > Users > Access requests.
- `auth` handles no admin addresses for this feature.

**Negative / trade-offs:**
- One more scope and binding to keep in env-doctor and tests (notify-api: `system:auth` may raise
  `admin`, not other origins).
- One notice per request, not per attempt (a repeat while pending is silent); copy is English only
  like every `notification_notice` (ADR 20261101-notify-api-resolves-email-notice-address-from-auth).

**Risks:**
- notify-api deploys after `auth`: pushes get 403 until it does. Accepted, since delivery is best
  effort and the request is visible on the screen anyway.
- Escalation trigger: `auth` raising a second kind of notice, or any origin other than `admin`,
  revisits this ADR rather than widening the binding quietly.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
