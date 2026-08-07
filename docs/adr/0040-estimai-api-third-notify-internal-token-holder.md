# 0040 — `estimai-api` becomes the third holder of `NOTIFY_INTERNAL_TOKEN` — ADR-0011's escalation trigger fires a second time and is again deferred, with a hard stop recorded

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

ADR-0011 introduced `NOTIFY_INTERNAL_TOKEN`, a shared secret gating `notify-api`'s
internal-only `/system/*` routes, with `auth` as its sole holder (triggering `POST
/system/emails`). ADR-0011's own Risks section named **"a second internal caller"** as one of
the explicit triggers for revisiting that static-shared-secret design in favour of a scoped,
self-issued service JWT (its rejected Option C). ADR-0017 was that trigger firing for the
first time: `refund-api` became the second holder, calling the newly-added `POST
/system/notifications` to notify an employee of a decision on their request. ADR-0017
recorded the trigger firing explicitly, chose to defer Option C for schedule/coupling
reasons, and — critically — did **not** itself name a hard stop for a third occurrence.

Spec 013 (US-7) needs the same mechanism a third time: when an owner grants or removes a
collaborator, the affected user must receive an in-app notification (AC-7.1/AC-7.2) via
`notify-api`'s existing SSE/in-app channel (ADR-0009), triggered cross-user (ADR-0017's
`recipientId`-carrying `/system/notifications`, not the self-only user-JWT
`POST /notifications`). `estimai-api` has no existing trust relationship with `notify-api` at
all — this is a new integration, not a reuse of an existing one.

Tripping the same named trigger a third time, silently, is exactly the drift ADR-0017 warned
against when it wrote "this ADR records the trigger explicitly so a third internal caller...
is unambiguously the point at which Option C should be built rather than deferred a second
time." This ADR is that record for the third occurrence — and it does not soften the
deferral into a non-decision.

## Decision

We will reuse `NOTIFY_INTERNAL_TOKEN` and `notify-api`'s existing `POST
/system/notifications` for `estimai-api`'s grant/removal notifications, making `estimai-api`
the token's **third** holder — and we record, explicitly, both the reasoning for deferring
Option C again and a concrete hard stop for the *next* occurrence.

1. **Mechanism: verbatim reuse, no new trust surface.** `estimai-api/src/lib/notify.ts` calls
   `notify-api POST /system/notifications` with `X-Internal-Token: NOTIFY_INTERNAL_TOKEN`, a
   contract copied from `refund-api/src/lib/notify.ts` — same header, same shared secret, same
   payload shape, same **never-throws** guarantee. No new endpoint, no new middleware, no new
   secret is introduced by this feature.
2. **Sent after commit, best-effort, non-blocking.** The notify call fires only after the
   grant/removal database transaction has already committed; a failure is logged and never
   rolls back the grant — the collaborator sees the estimate in their list on their next load
   regardless of push delivery (AC-7.1's push is additive, mirroring ADR-0017's own posture
   for `refund-api`).
3. **The deliberate choice: reuse, not escalate, for this feature.** Building Option C
   (scoped, self-issued service JWTs — `auth`'s rejected alternative from ADR-0011, still
   unbuilt after ADR-0017) now would mean coordinating a new `aud`/`scope` convention across
   **four** services (`auth`, `refund-api`, `estimai-api`, `notify-api`) for one best-effort
   notification feature — disproportionate to this feature's actual security weight, which
   sits elsewhere: the enumeration-oracle risk of ADR-0035's eligibility lookup, not the
   notification push. Deferring again is a considered trade, not an oversight.
4. **The hard stop, stated plainly and not softened.** A **fourth** internal caller of
   `NOTIFY_INTERNAL_TOKEN`, or **any suspected leak** of the token, does not get a fourth
   deferral. Either event **builds Option C** — scoped, self-issued service JWTs verified via
   `notify-api`'s existing JWKS `jwtMiddleware` plus a scope check — rather than extending the
   shared-secret model further. This is a commitment recorded here, not merely a suggestion:
   the next team to face this decision does not get to re-litigate whether to defer again:
   they build it.
5. **Deployment discipline, explicitly extended to `estimai-api`.** `estimai-api`'s Railway
   deployment must carry the same operational discipline `auth` and `refund-api` already do
   for this token: private networking only for the `notify-api` call, the token sourced only
   from 1Password, never logged, never reaching a public ingress. This is not new policy — it
   is ADR-0011's original discipline, extended to a third service, and stated explicitly here
   so it is not assumed rather than verified.
6. **Blast radius, named honestly.** A leaked `NOTIFY_INTERNAL_TOKEN` today compromises the
   compromise of **three** services' worth of capability: arbitrary email over wellD's Resend
   domain (ADR-0011's original risk) **and** arbitrary in-app push impersonating any suite
   app's origin (ADR-0017's addition), reachable now via a leak of **any one of three**
   services' deployment (`auth`, `refund-api`, or `estimai-api`), not just one. This is
   strictly larger than what ADR-0017 accepted, and is recorded as such rather than
   re-described as unchanged.

## Options considered

### Option A — Reuse `NOTIFY_INTERNAL_TOKEN` as the third holder, defer Option C again, record a hard stop for a fourth (chosen)

Described above.

**Pros:**
- Zero new secret, zero new middleware, zero new trust surface — realizes ADR-0009's
  reserved cross-user `recipient` seam and ADR-0017's `/system/notifications` route exactly
  as they were built to be reused
- Ships this feature's notification requirement without a multi-service coordination effort
  (a new `aud`/`scope` convention across four services) that is disproportionate to the
  feature's actual risk profile — the real security weight of spec 013 is the eligibility
  lookup (ADR-0035), not this notification
- The employee/collaborator's core experience never depends on this call succeeding — the
  grant is authoritative in `estimai-api`'s own database regardless of notification delivery
- Unlike ADR-0017 (which recorded the trigger firing but left the "what happens on the
  *next* one" question open), this ADR closes that gap explicitly with a named, non-optional
  hard stop

**Cons:**
- The named ADR-0011 escalation trigger has now fired **twice** without being acted on —
  deferring a second time measurably weakens the credibility of "trigger conditions" as a
  governance mechanism if they can always be deferred again without consequence (mitigated
  only by this ADR's explicit hard-stop commitment for the *next* occurrence)
- Blast radius grows a third time: three separate services' deployments, any one of which
  leaking the token compromises the same combined email+in-app capability
- No per-caller attribution or scoping exists even now — `estimai-api`'s copy of the token
  can technically reach `/system/emails` too, and vice versa for the other two holders;
  nothing in `notify-api`'s middleware distinguishes callers by identity

### Option B — Escalate to Option C now: scoped, self-issued service JWTs (rejected for this feature, reaffirmed as the eventual direction)

Build ADR-0011's originally-rejected Option C immediately: `estimai-api` (and, while at it,
`auth`/`refund-api`) mint short-lived JWTs with a system `sub`, a dedicated `aud`, and a
`scope` claim, verified by `notify-api` via its existing JWKS path plus a scope check.

**Pros:**
- Finally resolves the twice-fired trigger properly — each caller becomes individually
  identified, scoped, and time-bounded, closer to least-privilege than an indefinitely valid
  shared secret
- No new secret at all, reusing the existing signing keypair and JWKS infrastructure the
  suite already operates

**Cons:**
- Requires coordinating a new `aud`/`scope` convention across **four** services
  simultaneously (or, if scoped to only new callers, leaves the two existing holders
  unmigrated — an inconsistent halfway state that arguably makes the token's true trust
  boundary *harder*, not easier, to reason about)
- `notify-api`'s current `jwtMiddleware` hard-requires an `email` claim and treats `sub` as
  the recipient — a system token satisfies neither, so a distinct route/middleware is needed
  regardless, exactly as ADR-0011 and ADR-0017 both already found — meaning this is real,
  non-trivial new engineering, not a drop-in swap
- Rejected for *this* feature on the same coupling/schedule grounds ADR-0011 and ADR-0017
  both gave — but the case for building it keeps getting stronger with each additional
  caller, and this ADR is explicit that the case is now strong enough that a fourth caller
  does not get the same deferral

### Option C — Provision a distinct token per caller (`ESTIMAI_NOTIFY_TOKEN`), still shared-secret, no scoping (rejected)

Give `estimai-api` its own secret, distinct from `auth`'s and `refund-api`'s, so `notify-api`
can at least attribute which caller made a given request via which token was presented.

**Pros:**
- Enables coarse attribution in logs/audits without the full complexity of Option B

**Cons:**
- `internalTokenMiddleware` today does a single constant-time compare against one configured
  value; supporting multiple valid tokens is itself a real change to its contract, for a
  half-measure
- Attribution without **scoping** buys little: nothing stops `estimai-api`'s distinct token
  from also reaching `/system/emails`, or `auth`'s from reaching `/system/notifications` —
  none of the three tokens would be restricted to the route it's actually meant for
- This is exactly the option ADR-0017 already considered and rejected (there, as "Option B")
  for the second-caller case, for the same reasons; nothing about a third caller changes that
  calculus
- Rejected for the same reasons as before: doesn't resolve the named concern any more
  completely than a single shared secret, while adding provisioning overhead now

## Consequences

**Positive:**
- Realizes AC-7.1/AC-7.2's notification requirement with zero new trust infrastructure,
  keeping this feature's actual engineering effort focused on its real security-sensitive
  surface (the eligibility lookup, ADR-0035)
- The deferral is recorded honestly, with an explicit, non-negotiable hard stop for the next
  occurrence — this ADR does not let "we'll reconsider later" become an indefinitely
  renewable excuse the way a bare re-deferral would
- The employee/collaborator's outcome visibility never depends on notification delivery
  succeeding — the grant/removal itself, recorded in `estimai-api`'s own database, remains
  authoritative

**Negative / trade-offs:**
- `NOTIFY_INTERNAL_TOKEN`'s trust boundary is now measurably weaker than ADR-0011 originally
  described a second time over: three services, not two, hold a secret that reaches every
  `/system/*` route with no scoping between them
- The blast radius of a leak is now "compromise of any one of three services' deployment
  environments" rather than one or two — a materially larger attack surface for the same
  static-secret mechanism
- A fourth feature needing the same integration will force the Option C build this ADR
  defers — that work is not eliminated, only postponed again, and is now overdue in spirit
  even if not yet in trigger-count

**Risks:**
- **The hard stop is a documentation commitment, not a technical control.** Nothing in code
  prevents a future team from adding a fourth caller and, under the same schedule pressure
  that motivated this deferral, deferring again despite this ADR's explicit language.
  Mitigation: this ADR states the commitment as plainly as possible specifically to remove
  ambiguity for that future decision; enforcement is a matter of engineering discipline and
  code/architecture review, the same as any other named-but-unenforced convention in this
  monorepo (e.g. CLAUDE.md's own conventions).
- **Widened shared-secret blast radius**, as described above. Mitigation: unchanged from
  ADR-0011/ADR-0017 — internal-network-only exposure (no public ingress for `estimai-api`'s
  call to `notify-api`), CSPRNG-sourced token stored only in 1Password, never logged by any
  of the three holders; an `owasp-reviewer` pass is scheduled per the plan's Security section,
  explicitly covering this trust edge.
- **Cross-route middleware confusion, now with three services' routes to keep straight.** A
  future route added to `notify-api` could be mounted so it accidentally accepts both a user
  JWT and the internal token. Mitigation: the plan's test strategy includes a mutual-exclusion
  test asserting the collaborator routes reject `X-Internal-Token` and accept only a user
  JWT, and that `estimai-api` never exposes an inbound `/system/*` route of its own — the same
  discipline ADR-0011/ADR-0017 established, now explicitly extended and tested for the third
  holder.
- **Best-effort delivery silently drops a notification** under a `notify-api` outage,
  identical in shape to ADR-0017's accepted risk. Mitigation: unchanged — the grant/removal
  itself is authoritative; failures are logged for after-the-fact investigation; no queued
  retry is committed here.

## Compliance notes

- GDPR/nLPD impact: low — the notification payload carries an estimate **name** (a title,
  not content) and the granted/removed access level into `notify-api`'s database; both
  services are EU-region. This is a deliberate, recorded widening of what leaves
  `estimai-api` (plan Risk R9) — the alternative (a nameless notification) would not satisfy
  AC-7.1's "identifying the estimate." The name is truncated to 120 characters before it
  leaves `estimai-api`.
- Data residency: unaffected — `estimai-api` and `notify-api` are both EU-region; this is an
  EU-to-EU call, consistent with every other cross-service flow this feature introduces.
- Audit trail: not applicable to the notification send itself — an ordinary best-effort
  application event, not an authorization-relevant one, consistent with ADR-0009/ADR-0017's
  existing stance. The underlying grant/removal it follows from lives in `estimai-api`'s own
  `EstimateCollaborator` table (ADR-0036), which — unlike `refund-api`'s financial audit
  trail (ADR-0018) — is deliberately **not** append-only or audited (plan Risk R10, spec
  Non-goals).

This decision reuses ADR-0011 (the internal-token service-to-service trust model and its
named, still-unbuilt Option C escalation path) and ADR-0017 (the first trigger of ADR-0011's
"second internal caller" escalation, whose `POST /system/notifications` route and payload
contract this ADR reuses verbatim, and whose own deferral this ADR extends rather than
revisits). It knowingly trips the same named trigger a **third** time and, unlike ADR-0017,
commits explicitly to not deferring a fourth.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
