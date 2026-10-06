# 0044 — `inventory-api`, the fourth notify caller, gets a scoped `auth`-minted service JWT instead of `NOTIFY_INTERNAL_TOKEN` — ADR-0040's hard stop is honoured, and ADR-0011's Option C is built in client-credentials form

**Date:** 2026-10-06
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

Spec 015 (hardware inventory) adds a new backend, `inventory-api`, which must push cross-user
in-app notifications (for example an employee confirming or declining an assigned asset)
through `notify-api POST /system/notifications` (ADR-0017). Today that route is gated only by
the shared `NOTIFY_INTERNAL_TOKEN` (ADR-0011), held by `auth`, `refund-api` (ADR-0017) and
`estimai-api` (ADR-0040). `inventory-api` would be the **fourth** holder.

ADR-0040 recorded a hard stop for exactly this event: a fourth internal caller, or any suspected
leak, "builds Option C ... rather than extending the shared-secret model further", and the next
team "does not get to re-litigate whether to defer again". At the spec 015 plan interview
(2026-10-06) the user chose to honour that commitment inside this feature, for the new caller
only. The notification is triggered by an ordinary employee who holds no catalog capability, so
the usual forwarded-user-JWT trust model (ADR-0014/0035) has nothing to authorize against.

## Decision

We will add `POST /system/service-token` to `auth` (client-credentials) that mints a
5-minute RS256 service JWT, and make `notify-api`'s `/system/notifications` accept either the
legacy `X-Internal-Token` or that JWT; `inventory-api` uses only the JWT and never holds
`NOTIFY_INTERNAL_TOKEN`.

1. **Token issuance (`auth`).** The caller presents `clientId` + `clientSecret`, verified
   against a per-client entry in a new `SERVICE_CLIENTS` env map (constant-time compare).
   Unknown client and wrong secret return the **identical** 401 body. The route is
   rate-limited. The response is a 5-minute RS256 JWT signed with `auth`'s existing keypair:
   `sub="system:inventory-api"`, `aud=SERVICE_AUDIENCE`, `scope="notifications.push"`.
2. **A distinct audience.** `SERVICE_AUDIENCE` is a new value, different from `AUTH_AUDIENCE`
   (ADR-0010). A service token is therefore never accepted on a user route, and a user JWT is
   never accepted on a system route. This extends ADR-0010's audience scoping to
   system traffic.
3. **Verification (`notify-api`).** `/system/notifications` accepts **either** the legacy
   `X-Internal-Token` **or** `Authorization: Bearer <service JWT>`, the latter verified through
   the existing JWKS (ADR-0005) pinned to RS256 + issuer with `audience: SERVICE_AUDIENCE`, plus
   a `scope` check for `notifications.push`. `/system/emails` is unchanged: it still accepts
   only the legacy token, and the new scope does not grant it. `ORIGIN_APPS` gains `"inventory"`.
4. **Client behaviour (`inventory-api`).** The token is cached in memory (never persisted,
   never logged) and refreshed 60 s before expiry. The push remains best-effort, sent after the
   transaction commits, and never throws (ADR-0017 posture); a failure to obtain a token is
   handled exactly like a failed push.
5. **Scope of this change.** `auth`, `refund-api` and `estimai-api` **keep** the shared token.
   Migrating them is a named follow-up, not part of this feature. Its trigger: the next time
   any of those three callers' notify integration is touched for any reason, or **any suspected
   leak of `NOTIFY_INTERNAL_TOKEN`** — which, per ADR-0040, forces the migration outright and
   cannot be deferred. Absent either event the follow-up has no date; it is recorded as a
   debt, not scheduled work.

## Failure shape

A shared credential that identifies no one and limits nothing: every holder can do everything
the credential can do, a leak from any one holder compromises all the others' capability, and
each new holder silently widens that set. The mistake is not "using a secret" but granting a
new principal an **unattributable, unscoped, long-lived** credential because reuse is cheaper
than building identity for it — and repeating that deferral each time a named escalation
trigger fires.

It recurs wherever one service authenticates to another: any new internal caller of a
`/system/*` route (inbound to `notify-api` today, but equally outbound from `notify-api` to a
future service, or between two future backends); any new route added to `notify-api` that is
mounted behind the "either credential" check without its own scope (the symmetric
mistake: a *scoped* token silently reaching a route it was never meant for, such as email);
and the mirror-image audience error, where a system token is accepted on a user route or a
user token on a system route. Recognise it by asking, for any service-to-service call: *which
principal is this, what is the narrowest thing it may do, how long does the proof live, and can
I revoke it without touching other callers?* If any answer is "everyone / everything / forever /
no", this shape is present.

## Options considered

### Option A — `auth`-minted scoped service JWT via client-credentials, coexisting with the legacy token (chosen)

Described above.

**Pros:**
- Honours ADR-0040's hard stop as written, with no fourth deferral
- The caller is identified (`sub="system:inventory-api"`), scoped (`notifications.push` only,
  not email), time-bounded (5 minutes) and individually revocable (remove its `SERVICE_CLIENTS`
  entry)
- Reuses the existing keypair, JWKS endpoint and `jwtMiddleware` verification path; no new
  signing key to manage
- The dedicated `aud` makes user and system tokens mutually non-interchangeable
- Additive: the three legacy callers are untouched, so there is no four-service
  coordination effort blocking this feature

**Cons:**
- A per-client secret is still a secret. It is mitigated, not eliminated: it is scoped to one
  client, yields only short-lived single-scope tokens, and is individually revocable —
  unlike the shared token, whose leak is unscoped and cannot be revoked per caller
- `auth` gains a new internet-adjacent-in-principle endpoint (rate-limited, uniform 401) and a
  new env map (`SERVICE_CLIENTS`) and value (`SERVICE_AUDIENCE`), both of which must be added
  to `tools/env-doctor`'s manifest
- `notify-api` now has two accepted credential types on one route, which is a larger surface to
  keep correct than either alone
- Option C as ADR-0011 wrote it assumed `auth` itself was the caller, self-issuing a token. Here
  the caller is another service, so `auth` becomes a token issuer *for others* and a client
  secret is needed to authenticate to it. That is a different, heavier shape than ADR-0011
  imagined, built because the caller changed, not because the design was wrong
- Signing a non-user token with a system `sub` and a different `aud` through better-auth's jwt
  plugin is unproven (plan Risk R-4)

### Option B — Become the fourth holder of `NOTIFY_INTERNAL_TOKEN` (rejected)

**Pros:**
- Zero new code; the fastest path

**Cons:**
- Forbidden by ADR-0040's hard stop
- Blast radius grows to four services: a leak from any one of four deployments yields arbitrary
  email over wellD's Resend domain and arbitrary in-app push, with no attribution or scoping

### Option C — Forward the acting user's JWT to `notify-api` (ADR-0014/0035 model) (rejected)

**Pros:**
- No new secret; the caller identity is a real user

**Cons:**
- The confirm/decline notification is triggered by an ordinary employee holding no capability,
  so `notify-api` would have nothing to authorize a cross-user push against; accepting a
  user JWT for it would let any user push to any recipient (ADR-0017's self-only rule for the
  user route exists to prevent exactly that)

### Option D — A keypair per calling service, with `notify-api` trusting several JWKS (rejected)

**Pros:**
- Each service signs for itself; no client secret exchanged with `auth`

**Cons:**
- ADR-0040 names the **existing** JWKS as the verification path
- Multiplies key management: one keypair to generate, store, rotate and publish per caller, plus
  a multi-issuer trust configuration in `notify-api`

### Option E — A separate prerequisite spec migrating all four callers first (considered, not chosen)

**Pros:**
- Leaves no mixed state; one coherent trust model across all callers

**Cons:**
- Would block hardware notifications on a larger, four-service coordination effort
- Not chosen by the user at the plan interview. It remains the shape of the named follow-up

## Consequences

**Positive:**
- ADR-0040's commitment is kept at the first occasion it applies, not softened
- `inventory-api` never holds `NOTIFY_INTERNAL_TOKEN`; the shared token's holder set stays at
  three
- The pattern (client-credentials issuer in `auth`, scope-checked verification in the resource
  service) is reusable by any future internal caller

**Negative / trade-offs:**
- The suite runs **two** service-trust mechanisms side by side on `/system/notifications` until
  the follow-up lands
- ADR-0040's blast-radius statement is **unchanged** for `auth`, `refund-api` and `estimai-api`:
  a leak of the shared token still compromises email and in-app push from any of those three
  deployments. This ADR narrows nothing for them
- One more cross-service env contract (`SERVICE_CLIENTS`, `SERVICE_AUDIENCE`, the
  `inventory-api` client id/secret) to keep consistent

**Risks:**
- **R-4: better-auth's jwt plugin may not sign a non-user token** with a system `sub` and a
  different `aud`. Fallback: sign directly with `jose` using `JWT_PRIVATE_KEY`, the same key
  the JWKS publishes. Either way the `kid` and algorithm must match the JWKS so `notify-api`
  verifies without a new trust path.
- **Credential confusion.** The "either credential" check could be copied onto a route that
  should not accept a service token, or the scope check omitted. Mitigation: contract tests
  asserting `/system/emails` rejects a service JWT, `/system/notifications` rejects a user JWT
  (wrong `aud`) and a service JWT lacking `notifications.push`, and every user route rejects
  the service JWT.
- **Client-secret leak.** Mitigation: the secret lives only in 1Password and the deploy
  environment, never logged; blast radius is one scope on one client; revoke by removing the
  `SERVICE_CLIENTS` entry (outstanding tokens expire within 5 minutes).
- **Credential-stuffing / enumeration of client ids on `/system/service-token`.** Mitigation:
  identical 401 for unknown client and wrong secret, rate limiting, constant-time comparison.
- **The follow-up never happens.** Like ADR-0040's hard stop, the migration trigger is a
  documentation commitment, not a technical control. Mitigation: the trigger is stated
  concretely above, and any suspected leak forces it.
- **Best-effort delivery drops a notification** on a `notify-api` or `auth` outage, identical in
  shape to ADR-0017's accepted risk; the underlying record in `inventory-api` stays
  authoritative.

## Compliance notes

- GDPR/nLPD impact: none added by this decision — it changes how a caller authenticates, not
  what data is sent. The notification payload content is governed by spec 015.
- Data residency: unaffected; `auth`, `notify-api` and `inventory-api` are all EU-region and
  every call is EU-to-EU.
- Audit trail: not required for token issuance beyond standard access logs. The token and
  client secret must never be logged.

This decision realises ADR-0040's hard stop for a fourth caller. It builds ADR-0011's Option C
in a client-credentials form, and extends ADR-0010's audience scoping to system traffic. It does
**not** supersede ADR-0011, ADR-0017 or ADR-0040 for the three legacy holders, whose posture
remains as those ADRs state.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
