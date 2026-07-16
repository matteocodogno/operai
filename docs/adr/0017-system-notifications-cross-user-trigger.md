# 0017 — Server-to-server in-app notification trigger: `POST /system/notifications` reuses the ADR-0011 internal-token trust for a second internal caller

**Date:** 2026-07-16
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`notify-api`'s only in-app raise path today, the user-JWT `POST /notifications` (ADR-0009),
derives the recipient exclusively from the caller's own verified JWT `sub` — a deliberate
OWASP A01 (broken access control) mitigation: no caller, however privileged, can direct an
in-app notification at anyone but themselves through that route. ADR-0009 named this as a
seam, reserving (but not implementing) an inert `recipient` field specifically because Refund's
future cross-user flows were already anticipated. Spec `specs/007-refund-service` is that
trigger: AC-3.6 requires that when an accounting user decides a request, the *employee* who
submitted it — a different user than the one making the API call — is actively notified. No
mechanism exists today for one authenticated party to push an in-app notification at a specific,
different user.

Separately, ADR-0011 already solved a structurally similar problem for **email** (`auth`
triggering a send to a non-authenticated invitee) via a dedicated internal endpoint gated by a
shared secret (`NOTIFY_INTERNAL_TOKEN`) — but until now that secret has had exactly one holder
(`auth`), and ADR-0011's own Risks section named **"a second internal caller"** as one of the
explicit triggers for revisiting its static-shared-secret design in favor of a scoped,
self-issued service JWT (its rejected Option C). `refund-api`'s need here is precisely that
trigger firing for the first time.

## Decision

We will add `POST /system/notifications` to `notify-api`'s existing internal-token-gated
`/system/*` route group, structurally mirroring `/system/emails`, and have `refund-api` call it
— reusing the same `NOTIFY_INTERNAL_TOKEN` secret and `internalTokenMiddleware` convention —
after committing an approve/reject decision, while deliberately choosing **not** to revisit
ADR-0011's shared-secret trust model for this second caller, despite that ADR having named this
exact trigger.

1. **New route, same trust mechanism.** `POST /system/notifications` lives in
   `notify-api/src/system/` alongside `/system/emails`, under the identical
   `internalTokenMiddleware` (`X-Internal-Token` header, constant-time compare against
   `NOTIFY_INTERNAL_TOKEN`, ≥32 chars, 1Password-sourced). This is not a new secret or a new
   middleware — `auth` and `refund-api` now both hold and present the same shared token to reach
   any `/system/*` route.
2. **Routes through the existing `inApp` channel, unmodified.** Unlike `/system/emails` (which
   exercises the `email` channel, addressing a raw address), `/system/notifications` exercises
   the same `inAppChannel.send` the user-JWT `POST /notifications` already uses — persisting a
   `Notification` row and pushing over SSE — but with the recipient taken directly from the
   trusted internal request body (`recipientId`) rather than derived from a caller JWT's `sub`.
   This realizes ADR-0009's reserved `recipient` field for its first real use, with zero changes
   to the channel implementation itself.
3. **The user-JWT `POST /notifications` route is explicitly NOT extended to accept a `recipient`
   parameter.** Cross-user targeting is reachable only through the internal-token-gated route,
   never through any path accepting an end user's own Bearer JWT. This preserves OWASP A01
   self-only semantics on every user-facing route exactly as ADR-0009 shipped it — the two auth
   mechanisms remain mutually exclusive by route (ADR-0011's invariant): `jwtMiddleware`-protected
   routes never accept the internal token, and `/system/*` never accepts a user JWT.
4. **Best-effort, not transactional with the decision.** `refund-api` calls
   `POST /system/notifications` after the approve/reject decision is committed (its own database
   transaction has already closed). A failed or unreachable call is logged and does **not** roll
   back, block, or retry synchronously — the decision itself, recorded in `refund-api`'s own
   database, remains the source of truth; the employee always sees the outcome on their next
   `GET /requests/:id` regardless of push delivery (mirrors the DB-source-of-truth pattern
   `notifications.repo` already established in specs/005).
5. **Deliberately reuses ADR-0011's shared-secret model rather than escalating to Option C.**
   ADR-0011 explicitly named a second internal caller as the trigger for revisiting its
   static-shared-secret design. That trigger has now fired. This ADR records the fact and
   chooses, for this feature, to extend the existing mechanism rather than build the escalation
   now — for the same coupling/schedule reasons ADR-0011 originally deferred it (see Options
   considered, Option C).

## Options considered

### Option A — Reuse `NOTIFY_INTERNAL_TOKEN` across both internal callers, new route under the same middleware, best-effort send (chosen)

Described above.

**Pros:**
- Realizes ADR-0009's reserved cross-user `recipient` seam on its very first real trigger, with
  no breaking change to `raiseNotification`'s existing signature or to any existing caller of
  `POST /notifications`
- Reuses a proven, already-shipped mechanism (ADR-0011) rather than inventing a third
  `notify-api` trust model — minimizes new surface for a security-sensitive feature under the
  plan's own schedule pressure (Risk R1, which explicitly schedules both new cross-service seams
  as early spikes)
- The employee's outcome visibility never depends on the notification succeeding — the decision
  on `refund-api`'s own database is authoritative; the push is additive, matching AC-3.2/3.3's
  guarantee that `GET /requests/:id` always reflects the true outcome

**Cons:**
- ADR-0011's trust boundary is now measurably weaker than originally described (see
  Consequences) — two services, not one, hold the secret that can reach every `/system/*` route
- Delivery is soft, not hard: a failed push is silently swallowed from the employee's immediate
  perspective, resting entirely on the read-path fallback

### Option B — A distinct token per internal caller (rejected for v1)

Provision a second secret (e.g. `REFUND_NOTIFY_TOKEN`) alongside `NOTIFY_INTERNAL_TOKEN`, so
`/system/*` requests can at least be attributed to a specific caller.

**Pros:**
- Would let logs/audits distinguish which internal caller made a given request

**Cons:**
- `internalTokenMiddleware` today does a single constant-time compare against one configured
  value; supporting multiple valid tokens is a real (if small) change to its contract
- Attribution without **scoping** buys little: nothing today would stop `refund-api`'s token
  from also reaching `/system/emails`, or vice versa — a half-measure that doesn't resolve
  ADR-0011's named concern any more completely than reusing a single secret does, while adding
  provisioning overhead now
- Rejected for v1: doesn't earn its complexity over Option A given neither option provides real
  isolation

### Option C — Escalate to ADR-0011's Option C: a self-issued, scoped service JWT (rejected for this feature, named as the live escalation path)

Have `auth` and `refund-api` each mint a short-lived JWT off the existing signing keypair with a
system `sub` (e.g. `system:refund-api`), a dedicated `aud`, and a `scope` claim (e.g.
`notification.send`), verified by `notify-api` via its existing JWKS `jwtMiddleware` plus an
added scope check.

**Pros:**
- No new secret at all — reuses the existing signing keypair and JWKS endpoint
- Each caller is now individually identified and scoped, with tokens that expire — closer to
  least-privilege than an indefinitely valid shared secret
- This is the exact direction ADR-0011 named as the intended future hardening once a second
  internal caller appeared — which has now happened

**Cons:**
- `notify-api`'s current `jwtMiddleware` hard-requires an `email` claim and treats `sub` as the
  recipient — neither of which a system token satisfies, so a distinct route/middleware would be
  needed regardless, giving up most of the "no new code path" benefit this option would otherwise
  have (the same reasoning ADR-0011 gave originally)
- Requires coordinating a new `aud`/`scope` convention across **three** services (`auth`,
  `refund-api`, `notify-api`) before this feature's decision-notification flow can ship — more
  design and rollout surface than the plan's schedule (Risk R1: spike both new seams first, then
  proceed to domain work) justified
- Rejected for this feature, for the same coupling/timing reasons ADR-0011 originally deferred
  it — but the case for building it is now measurably stronger (two real callers, not a
  hypothetical); named explicitly as the live escalation path (see Risks)

### Option D — Extend the user-JWT `POST /notifications` route to accept an optional `recipient`, gated by a notify-api-side permission check (rejected)

Add a `recipient` field to the existing user-facing route, permitted only for callers holding
some new notify-api-recognized permission.

**Pros:**
- Avoids a second internal-only route entirely

**Cons:**
- `notify-api` has no notion of `refund`'s role/entity authorization model and would need to
  reimplement or query refund-specific business rules ("is this caller allowed to notify this
  employee") just to guard one field — exactly the domain-agnostic boundary ADR-0009 established
  and this ADR should not cross
- That authorization decision is already correctly made by `refund-api` itself (it just decided
  the outcome) — pushing recipient-selection authority to the already-privileged system caller,
  rather than teaching `notify-api` a second app's authorization rules, is the correct boundary
- Rejected: reopens a settled architectural boundary for no benefit

### Option E — Make the send synchronous/transactional with the decision (rejected)

Block the approve/reject HTTP response on `notify-api`'s response, or attempt a distributed
transaction spanning both services' databases.

**Pros:**
- Would guarantee the notification is sent (or the whole operation visibly fails) at
  decision time

**Cons:**
- `notify-api` is a separate service and database; a true distributed transaction isn't
  available across them
- Blocking the decision response on a third service's availability would make `refund-api`'s
  core financial workflow fail whenever `notify-api` has a bad moment, for a notification that is
  additive, not authoritative, per the decision's own source-of-truth status
- Rejected: wrong trade-off for an additive, best-effort side effect

## Consequences

**Positive:**
- Realizes ADR-0009's reserved cross-user `recipient` seam on its first real trigger, exactly as
  designed
- Reuses a proven mechanism instead of inventing a third `notify-api` trust model, minimizing new
  surface for a security-sensitive feature under schedule pressure
- The employee's outcome visibility never depends on the notification succeeding — matches this
  plan's own AC-3.2/3.3 guarantee

**Negative / trade-offs:**
- ADR-0011's trust boundary is now measurably weaker than originally described: "only `auth`
  holds the token" is no longer true — `refund-api` now also holds `NOTIFY_INTERNAL_TOKEN`,
  doubling the set of services whose compromise lets an attacker call **any** `/system/*` route
  (both `/system/emails` and `/system/notifications`), not just the one this ADR adds
- No per-caller scoping exists: `refund-api`'s copy of the token can technically reach
  `/system/emails`, and `auth`'s copy could technically call `/system/notifications` — nothing in
  the middleware distinguishes callers by identity, only by possession of the shared secret
- A failed notification is silently swallowed from the employee's immediate perspective
  (best-effort, no retry-until-success) — the "push" guarantee in AC-3.6 is soft, not hard,
  resting entirely on the read-path fallback

**Risks:**
- **Widened shared-secret blast radius.** A leaked `NOTIFY_INTERNAL_TOKEN` now compromises both
  the email channel (arbitrary email over wellD's Resend domain, ADR-0011's original risk) and
  the in-app channel (arbitrary in-app notification/SSE push, impersonating any origin app) — a
  strictly larger blast radius than ADR-0011 accepted alone. Mitigation: the same posture as
  ADR-0011 (internal-network-only exposure, never public ingress; CSPRNG-generated token,
  1Password-only, never logged), now explicitly extended to a second service's deployment
  (`refund-api`'s Railway EU environment must carry the same operational discipline as `auth`'s);
  an owasp-reviewer pass is scheduled per the plan's Security section covering this route by
  name.
- **The named ADR-0011 escalation trigger has fired without being acted on.** Choosing to defer
  Option C again means the suite now has two internal callers sharing one secret with no expiry,
  revocation, or scoping — the risk ADR-0011 flagged as the reason to eventually move to scoped
  service JWTs is now realized in practice, not just in principle. Mitigation: this ADR records
  the trigger explicitly so a third internal caller, a compliance finding, or a suspected leak is
  unambiguously the point at which Option C should be built rather than deferred a second time.
- **Cross-route middleware confusion**, inherited from ADR-0011 and now doubled in surface (two
  internal routes instead of one). Mitigation: both `/system/*` routes share one router group and
  one contract test asserting each rejects a valid user JWT and every user-facing route
  (including the existing `POST /notifications`) rejects the internal token.
- **Best-effort delivery silently drops a notification** under a `notify-api` outage precisely
  when accounting is actively processing decisions (e.g. a batch of approvals). Mitigation:
  logged failures are visible in `refund-api`'s own logs for after-the-fact investigation; a
  queued-retry mechanism is a named future improvement, not committed here, consistent with the
  plan's Risk R5 acceptance.

## Compliance notes

- GDPR/nLPD impact: low — the notification payload (title/body/link per the plan's shape)
  carries no attachment content or full financial detail, only a status summary and a link back
  into `refund-ui` where the authenticated employee can view the full, already access-controlled
  detail; `recipientId` is an internal user identifier, not exposed externally.
- Data residency: unaffected — `notify-api`'s database remains Railway EU (ADR-0009), and this
  is a same-region service-to-service call.
- Audit trail: not applicable to the notification send itself (an ordinary application event,
  not an authorization-relevant one, per ADR-0009's existing stance); the decision it follows
  from is covered by ADR-0018's audit trail.

This decision builds directly on ADR-0009 (notification center + the reserved cross-user
`recipient` seam this ADR activates) and ADR-0011 (the internal-token service-to-service trust
model reused verbatim, and the specific future-hardening trigger — a second internal caller —
this ADR knowingly trips without resolving).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
