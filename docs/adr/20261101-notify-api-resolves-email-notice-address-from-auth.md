# 20261101 — An email notice is addressed by user id: notify-api looks the address up in auth when it sends

**Date:** 2026-11-01
**Status:** Accepted (specs/20261101-crm-notifications; the product owner chose this option) Amended 2026-11-17 by ADR 20261117-notify-api-system-routes-protect-against-repeats-by-a-caller-scoped-idempotency-key-and-bind-a-template-to-its-caller-with-closed-typed-data (an address is also resolved from `recipientId` on the new email route, not only for `email: true` on `/system/notifications`; `users.contact` and its audience are unchanged).
**Deciders:** wellD
**Project:** Operai

---

## Context

The CRM hands work from one person to another: an estimate to a technician, a deal to a new
owner, a task to a colleague. specs/20261101-crm-notifications notifies the recipient in the app and, for the
handovers they must act on, by email too.

Each channel takes a different kind of recipient:
- **In-app** (ADR 20260713-notification-center-standalone-service-shell-seam/0017): an auth user id.
- **Email** (ADR 20260714-notify-api-email-channel-service-trust/0021): a raw address supplied by the caller. auth supplies it for
  invitations, and refund-api supplies the address it stored on the request.

crm-api stores only auth user ids. The one way it can read addresses today is the user
directory, which is gated by `deal:manage` (ADR 20261006-user-directory-endpoint-capability-gated/0053). That gate does not fit here:
- a technician marking an estimate ready holds only `crm:access`, yet must trigger an email
  to the salesperson;
- every later tool with the same need would repeat the lookup and handle addresses it does
  not otherwise need.

## Decision

1. **The caller names the recipient by id and asks for an email notice.**
   `POST /system/notifications` gains `email: true`. The caller never sends an address, so
   it cannot choose one.
2. **notify-api resolves the address when it sends.**
   - It calls a new auth endpoint, `POST /system/users/contact`, with one `userId`, and gets
     `{id, email, name}` for an active user or 404 for an unknown or soft-deleted one.
   - It keeps no copy. The address appears only in the existing `email_delivery` row.
   - A user deactivated since the event gets no email.
3. **notify-api becomes a service client of auth**, `system:notify-api`, with a new scope
   `users.contact` that only it holds. The endpoint:
   - accepts only a service JWT with that scope, verified like the `/system` routes of
     notify-api;
   - returns one user per call;
   - is rate-limited;
   - logs the caller and whether the user was found, never the id or the address.

   auth verifies service tokens it signed itself in process. It builds a `jose` local key set
   from `auth.api.getJwks()` (the keys served at `/auth/jwks`) on every call, so key rotation
   needs no restart. It pins RS256, the issuer and `aud = SERVICE_AUDIENCE`. better-auth's own
   `verifyJWT` is not used, because it expects the base URL as audience.
4. **An email notice needs `emails.send` as well as `notifications.push`** (one scope per
   capability, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired). A push-only client cannot start sending emails by setting a flag.
5. **The email is built from the notification it accompanies.** The new template
   `notification_notice` carries:
   - the notification's title and text, escaped;
   - a link to `APP_BASE_URL` plus the notification's relative link;
   - the name of the tool that sent it.

   It is English, and it cannot be reached through `/system/emails`, where the caller
   supplies the address.
6. **Best effort, after the in-app row.**
   - If the lookup or the send fails, the notification still stands, and the response
     reports `emailStatus: failed` (or `skipped` for an inactive user or an unconfigured
     group).
   - The caller's own action is never rolled back (ADR 20260716-system-notifications-cross-user-trigger).

## Alternatives considered

- **crm-api looks the address up and calls `/system/emails`.** The technician case needs a
  lookup that `deal:manage` does not allow, so this would mean a new capability-free path to
  addresses inside crm-api. Every tool would repeat it, and every tool would handle
  addresses. Rejected.
- **Give crm-api the `users.contact` scope instead.** It moves the same fact endpoint to a
  service that has no use for addresses beyond emailing them, and the next tool would need
  the scope too. Rejected in favour of the one service that sends the email.
- **notify-api keeps a synced copy of users' addresses.** A copy goes stale: it keeps
  emailing a deactivated user until it is resynced, and it needs a sync mechanism that the
  suite avoids (ADR 20260714-invitation-lifecycle-derived-expiry-state). Rejected.
- **A batch lookup.** notify-api handles one notification per request. A batch endpoint
  would also make bulk harvesting of addresses cheaper. Rejected.
- **Email both languages, or pick the recipient's.** The owner chose English, like the refund
  emails (specs/20261101-crm-notifications O2).

## Consequences

- **Positive:**
  - Any tool gets email notices for free: it sets `email: true` and holds `emails.send`.
  - No tool besides auth and notify-api ever handles a colleague's address for this.
  - A deactivated user stops receiving email at once.
- **Negative:**
  - notify-api now depends on auth for email notices, which adds a hop and a failure mode.
    It is contained: the in-app notification is unaffected, and the failure is visible in
    `emailStatus` and the logs.
  - auth gets a second fact endpoint about people, after the directory (ADR 20261006-user-directory-endpoint-capability-gated). It is
    bounded by a scope only notify-api holds, one user per call, and a rate limit.
  - auth's `SERVICE_CLIENTS` gains two entries (`crm-api`, `notify-api`). env-doctor checks
    their scopes.
- **Escalation trigger:** a second client asking for `users.contact`, or a need to batch.
  Revisit this ADR rather than extending the scope's audience quietly.
