# 0014 — refund-api as the suite's first authorization-enforcing resource server: Bearer-authed `auth GET /authz/resolve` + epoch-keyed cache + local condition evaluation

**Date:** 2026-07-16
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

ADR-0007 built the suite's whole authorization model — roles, ABAC conditions, the
`perm_epoch` JWT claim, the immediate-revocation `GET /authz/me` — but explicitly scoped
**per-app, per-record enforcement** out of that decision: "Each consuming app (EstimAI now,
Refund and others later) enforces view/edit/delete/approve against these claims in its own
spec." `GET /authz/me` itself is session-cookie-gated (better-auth's own session), because it
was built for the shell (a browser client that already holds that cookie) — a resource server
holding only a Bearer JWT has no session cookie to present.

Spec `specs/007-refund-service` is the trigger ADR-0007 deferred to: AC-5.4/6.4/7.5 all demand
**API-level denial**, not just UI hiding — a non-`accounting` user hitting `/review/*` directly,
or an out-of-scope user deep-linking a request, must be refused by `refund-api` itself, with no
reliance on `refund-ui` ever having rendered a gate. `refund-api` is a plain ADR-0005 JWKS
resource server today (identity only, like `estimai-api`); it has no notion of roles,
permissions, or conditions at all. Building that notion requires either duplicating the
resolver's role/department/condition logic inside `refund-api` (a second, divergent
implementation of ADR-0007's hand-rolled resolver) or giving a Bearer-only caller a way to reach
the one resolver `auth` already has.

## Decision

We will add a new, Bearer-authed `auth GET /authz/resolve` endpoint that lets a resource server
resolve the caller's own effective permissions live, and have `refund-api` gate every route on
it — realizing ADR-0007's deferred resource-server enforcement rather than reimplementing the
resolver a second time.

1. **`auth GET /authz/resolve`** is a sibling of `GET /authz/me`, authenticated the same way
   every other resource-server call already is: the caller's Bearer JWT, which `refund-api`
   forwards verbatim (not a new service credential — the same RS256 token the end user already
   presented to `refund-api`, itself already verified there per ADR-0005/0010). `auth` verifies
   that same token itself (pinned `alg:RS256`, `iss`, `aud` — it holds the signing keypair, so
   this is a local verification, not a remote-JWKS round trip against itself) and returns the
   **caller's own** resolution only, mirroring `/authz/me`'s "never an arbitrary user's" guard:
   `{ sub, epoch, permissions[], entity, jobTitle }`. The added `entity`/`jobTitle` — the
   caller's own attribute values, not present in `/authz/me`'s response — are the one deliberate
   widening beyond that endpoint, made safe by being (a) the caller's own data, (b) delivered
   only over an already-authenticated channel, and (c) still never embedded in the JWT itself.
2. **`refund-api`'s new `authzMiddleware`** runs after `jwtMiddleware` (identity + `aud`,
   ADR-0005/0010) on every route, calls `/authz/resolve` with the forwarded token, and caches the
   response in-process keyed by `(sub, perm_epoch)` — the epoch read off the caller's own verified
   JWT. A grant change bumps `perm_epoch` at `auth`; the caller's *next refreshed* token carries
   the new epoch, which is a cache-key miss at `refund-api`, forcing a fresh resolve. A short hard
   TTL (default 30 s) sits alongside the epoch key as a **liveness backstop**: because `refund-api`
   re-fetches from `auth` on every cache miss (never reconstructs permissions from the JWT
   itself), the TTL bounds worst-case staleness for a grant change to 30 seconds even before the
   caller's own token has rolled to a new epoch — tighter than, and independent of, how promptly
   any individual client refreshes its token. `c.var.authz = { permissions, entity }` is set for
   route handlers.
3. **Capability vs. condition are two different checks, split by where they're evaluated.**
   Route handlers first gate on **capability** — does the resolved permission set contain the
   grant at all (e.g. `request:review`) — denying with **403** if not (`/review/*` is
   capability-gated wholesale). Handlers then evaluate **conditions locally**, against the actual
   record: `auth`'s resolver persists and surfaces conditions (ownership, the entity attribute
   condition) but, per ADR-0007, never evaluates them against a record — that has always been the
   consuming app's job. `refund-api` evaluates `ownership:own` and the entity condition itself
   (entity scoping is ADR-0015); a record-level failure returns **404**, mirroring ADR-0005's
   "not yours = not found," never 403 (no existence leak).
4. **Auth outage fails closed.** If `/authz/resolve` is unreachable or errors, `refund-api` denies
   the request with **503** — it never falls back to an "allow" default. Every authorization-gated
   route now has a hard runtime dependency on `auth`'s availability; that dependency is accepted
   deliberately given this feature's financial-data weight (plan Risk R3), mitigated but not
   eliminated by the epoch-keyed cache (steady state adds zero extra hops after the first call per
   token).
5. **Permissions stay out of the JWT, unchanged from ADR-0007.** The token still carries only
   identity + `perm_epoch`; nothing about this decision embeds `refund`-specific grants in it.
   Doing so would reopen exactly the staleness failure ADR-0007's Option C was rejected for — now
   for a second app — and would couple the shared token's shape to every consuming app's own
   permission model instead of keeping it minimal and app-agnostic.

## Options considered

### Option A — Bearer-authed `/authz/resolve` + `(sub, perm_epoch)` cache + local condition evaluation, fail-closed (chosen)

Described above.

**Pros:**
- Reuses ADR-0005's Bearer/JWKS trust model end-to-end — the forwarded token is the same
  identity credential already verified at `refund-api`, so no new secret or credential type is
  introduced (unlike ADR-0011's service-to-service shared token)
- Realizes ADR-0007's explicitly deferred resource-server enforcement without duplicating its
  resolver — `auth` remains the single authority computing "what can this user do"
- Fail-closed on auth outage protects financial/PII data from a blanket-access failure mode
  during an availability incident
- The epoch-keyed cache with a TTL backstop bounds staleness tightly (≤30 s for a live grant
  change) independent of how promptly a client's own JWT rolls to a new epoch

**Cons:**
- Adds a network hop (`refund-api → auth`) per unique `(sub, perm_epoch)`, coupling
  `refund-api`'s request latency and availability to `auth`'s, only partially offset by caching
- Condition evaluation logic now lives independently inside `refund-api` (and will live
  independently inside every future resource server) rather than in one shared library — a
  future divergence in how two apps interpret the same condition type is possible (see Risks)

### Option B — Embed refund's resolved permissions directly in the JWT at mint time (rejected)

Resolve the caller's `refund` permissions at token-mint time and add them as JWT claims,
avoiding any resource-server round trip.

**Pros:**
- Zero extra network round trip per request — the token is self-contained

**Cons:**
- Directly reopens ADR-0007 Option C's rejection (fat permission claims defeat AC-4.3's
  immediate-revocation requirement): a revoked grant would remain valid in an already-issued
  token for up to 7 days
- Couples the shared, cross-app JWT's shape to `refund`'s specific permission model; a second
  app doing the same thing compounds token size and cross-app coupling
- Rejected on the same staleness grounds ADR-0007 already settled, now for a second app

### Option C — Fail-open on an auth outage (rejected)

Default to "allow" if `/authz/resolve` cannot be reached, so a transient `auth` incident does
not also take down `refund-api`.

**Pros:**
- Higher `refund-api` availability during an `auth` incident — a temporary authorization
  outage would not also block a legitimate submit/withdraw/review action

**Cons:**
- Grants blanket access to financial/PII data — including cross-entity accounting review and
  arbitrary approve/reject — to any caller for the duration of the outage, regardless of their
  actual permissions; unacceptable for a regulated-sector-adjacent feature (plan Security
  section)
- Rejected outright: the availability gain does not remotely justify the exposure; 503
  fail-closed (Option A) is the only posture consistent with the plan's own security weighting

### Option D — `auth` evaluates conditions against the record itself, returning allow/deny (rejected)

Have `/authz/resolve` (or a new record-aware variant) accept the record's own attributes
(e.g. a request's line entities) and return a yes/no decision, rather than raw
permissions+conditions for local evaluation.

**Pros:**
- Removes condition-evaluation logic from `refund-api` entirely — a single authority both
  resolves and evaluates

**Cons:**
- Requires `auth` to understand `refund`'s domain model (lines, per-line entities, the
  "at-least-one-line-matches" predicate) — exactly the coupling ADR-0007 point 6 already
  rejected by scoping per-app enforcement out of `auth`
- Would need a bespoke request/response contract per app's record shape, undermining the
  catalog's app-declared genericity (ADR-0007 point 7)
- Rejected: ADR-0007 already fixed condition *evaluation* as the consuming app's job; this ADR
  extends that boundary to a real resource server rather than crossing it

### Option E — `refund-api` calls the existing session-cookie `GET /authz/me` (rejected)

Reuse `/authz/me` as-is instead of building a new endpoint.

**Pros:**
- No new endpoint to design, build, or secure

**Cons:**
- Infeasible as stated: `/authz/me` is authenticated by a better-auth session cookie, which a
  server-to-server (Bearer-only) caller never holds; there is no cookie to forward
- Rejected: not a workable option, not merely a worse one

## Consequences

**Positive:**
- `refund-api` becomes the suite's first backend besides `auth` itself to enforce role +
  condition permissions server-side — establishing the concrete pattern (Bearer-forwarded
  resolve call, epoch-keyed cache, local condition evaluation, fail-closed) every future Operai
  resource server needing authorization will reuse
- No new trust mechanism is introduced — the forwarded Bearer JWT is the same credential
  already verified at `refund-api`, keeping the suite's authentication story to exactly one
  primitive (RS256/JWKS) even as authorization gets real teeth
- Fail-closed-by-default protects financial data specifically during the failure mode (an
  `auth` outage) most likely to otherwise be exploited or to cause a silent over-grant

**Negative / trade-offs:**
- Every authorization-gated `refund-api` request now has a hard runtime dependency on `auth`'s
  availability; an `auth` incident degrades `refund-api` entirely (503 on every authorized
  route), not just `auth`'s own surface — an availability-for-security trade wellD accepted
  given the financial-data weight of this feature
- Condition-evaluation logic (ownership, entity) is `refund-api`'s own code, not a shared
  library — a second future resource server implementing the same condition type independently
  could evaluate it subtly differently without any test catching the divergence
- The 30 s TTL is a global default with no per-permission tuning; a workload needing tighter
  freshness than 30 s, or willing to trade more `auth` load for it, would need this ADR revisited

**Risks:**
- **`auth` availability becomes a single point of failure for `refund-api`'s entire authorized
  surface** (plan Risk R3). Mitigation: epoch-keyed in-process cache keeps steady-state traffic
  at zero extra hops after the first call per token; latency/availability is measured before
  production traffic; fail-closed is the accepted trade-off, not treated as a defect to later
  "fix" by fail-open.
- **Divergent condition evaluation across future resource servers.** Because ADR-0007 keeps
  evaluation decentralized by design, two apps could interpret the same condition type
  (`ownership`, `entity`) differently. Mitigation: shared test vectors / a contract test suite
  per condition type is named as a future improvement; not committed by this ADR, tracked as a
  risk to revisit if a second resource server (beyond `refund-api`) ships.
- **Fail-closed as a denial-of-service surface.** Because every gated route now 503s on an
  `auth` outage, an attacker able to degrade `auth`'s availability gains a way to deny
  `refund-api` entirely. Mitigation: this is an accepted trade-off (financial-data confidentiality
  over blanket availability), not a gap; `auth`'s own availability posture (out of this ADR's
  scope) is the primary control.

## Compliance notes

- GDPR/nLPD impact: low — `entity`/`jobTitle` (organizational, not special-category attributes)
  now transiently flow to a second service via `/authz/resolve`'s response, already resolved to
  the shell client per ADR-0007; here they are consumed server-side, over an authenticated
  channel, held only for the 30 s cache window, never persisted by `refund-api`.
- Data residency: unaffected — both `auth` and `refund-api` deploy to an EU region (Railway EU),
  so this adds no new cross-region hop.
- Audit trail: not applicable to authorization *resolution* itself (a read, not a mutation); the
  underlying grants remain covered by ADR-0007's `audit_log`. `refund-api`'s own domain audit
  trail (the decisions this authorization gates) is a separate decision — ADR-0018.

This decision builds directly on ADR-0005 (JWT resource-server verification via remote JWKS —
the Bearer trust model this ADR reuses rather than replaces, and the ownership-404 denial
pattern this ADR extends to condition failures generally), ADR-0007 (the RBAC/ABAC model,
`perm_epoch` claim, and explicitly deferred resource-server enforcement side this ADR realizes),
and ADR-0010 (`aud` claim enforcement — `refund-api` is now a confirmed second/third real
resource server requiring `AUTH_AUDIENCE`, the trigger ADR-0010 was written for).

---

## Addendum (2026-07-16): key source correction

**Correction, discovered during spec 007's T1 implementation.**

Decision point 1 above states that, when verifying the forwarded Bearer token for
`GET /authz/resolve`, `auth` checks it "against env.JWT_PUBLIC_KEY... it holds the
signing keypair, so this is a local verification, not a remote-JWKS round trip against
itself." **That premise is incorrect.**

Per ADR-0005's own dated correction (2026-07-05), tokens issued by `GET /auth/token` are
signed by better-auth's own **rotating, DB-managed keypair**, published with a dynamic
`kid` at better-auth's built-in **`/auth/jwks`** endpoint. `env.JWT_PUBLIC_KEY` /
`JWT_PRIVATE_KEY` back a *separate, unrelated* static keypair served at the custom
`/.well-known/jwks.json` route (`kid: operai-auth-rs256-v1`) — that keypair does **not**
sign `/auth/token` tokens and cannot verify them. `auth` therefore has no static
"signing keypair it holds" to check the forwarded Bearer token against directly; the env
keypair was never in the signing path for real tokens.

**Shipped correction (T1).** `GET /authz/resolve`'s Bearer-token verification follows the
same JWKS-consumer pattern ADR-0005 established for every other resource server: it
verifies against **`/auth/jwks`** (fetched in-process, cached ~60s, refetched on an
unknown `kid`), pinning `alg: RS256` + `iss` + `aud` — identical in shape to how
`estimai-api`, `notify-api`, and `refund-api` itself verify tokens minted for them. The
only thing distinguishing this from an ordinary resource-server verifier is that the
fetch target happens to be `auth`'s own JWKS endpoint rather than another service's:
`auth` is, for this one endpoint, also a client of its own public-key publication.

Nothing else in the original Decision changes: `/authz/resolve` still returns only the
caller's own resolution, is still Bearer-authed with no new credential type introduced,
and the epoch-keyed cache, capability/condition split, and `refund-api`'s fail-closed
posture are all unaffected. Only the "which keys does `auth` check the token against"
premise in point 1 was wrong — corrected here, not rewritten there.

**Consequence for every resource server.** `AUTH_JWKS_URL` must point at `/auth/jwks` in
every service that verifies suite-issued Bearer tokens — `estimai-api`, `notify-api`,
`refund-api`, and, per this addendum, `auth`'s own `/authz/resolve` verifier — never at
`/.well-known/jwks.json`. Already reflected in `refund-api`'s `.env.example`.

Cross-reference: ADR-0005 (JWT resource-server verification via remote JWKS — the pattern
this addendum aligns `/authz/resolve`'s verifier with; see that ADR's own 2026-07-05
correction for the original discovery of the `/auth/jwks` vs `/.well-known/jwks.json`
split, and its still-open "orphaned `/.well-known/jwks.json`" tech-debt note, which this
addendum reinforces rather than newly raises).

Status unchanged: **Accepted**.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
