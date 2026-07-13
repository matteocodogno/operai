# 0010 — Enforce JWT `aud` (audience) across the auth issuer and all resource servers

**Date:** 2026-07-13  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

ADR-0005 established the suite's resource-server pattern: `auth` issues RS256 JWTs, and each
resource server verifies them against `auth`'s remote JWKS, pinning `issuer` and `algorithms`.
At the time, ADR-0005 explicitly deferred audience (`aud`) verification: "there is only one
resource server (`estimai-api`), so there is no cross-service token-replay risk today," with an
explicit trigger — "before a second resource service goes to production, coordinate with the
`auth` service to set `aud` on issued tokens." ADR-0007 (authorization) later reinforced that
the deferral was intentional and specifically kept the admin API *inside* `auth` (rather than
as its own resource server) precisely "so that this feature does not create a second consumer
of JWKS-verified bearer tokens" — leaving the trigger still gated on "the first real second
resource server (`refund-api`)" (ADR-0007 §5).

Spec `specs/005-notification-center` introduces `notify-api`, a new independent JWKS resource
server verifying the same `auth`-issued tokens the same way `estimai-api` does. This is, in
fact, **the first real second JWKS resource server** — arriving before `refund-api`, which the
prior two ADRs had assumed would be the trigger. Because both `estimai-api` and `notify-api`
trust the same issuer and the same signing keys, and neither historically checks `aud` (the
claim does not exist on issued tokens yet), a JWT minted for one is today structurally valid at
the other: a token obtained to call `estimai-api` could be replayed against `notify-api`
(and vice versa) with no code change required by an attacker. The deferred trigger from
ADR-0005/ADR-0007 has now fired.

## Decision

We will set and verify an `aud` (audience) claim on every JWT issued by `auth`, closing the
cross-service replay gap before `notify-api` reaches production, rather than deferring again.

1. **`auth` stamps an `audience` claim** on every JWT it mints via the better-auth `jwt`
   plugin's `definePayload` hook (the same hook ADR-0007 already uses to keep claims minimal —
   `email`, `name`, `image`, `perm_epoch`; `audience` is added alongside these, `sub` remains
   unchanged). The claim identifies **which resource server(s)** a given token is valid for.
   v1 issues a single suite-wide audience value shared by every current resource server
   (`estimai-api`, `notify-api`) — the goal of this decision is closing the *unscoped* replay
   gap (any resource server accepting any suite-issued token with no audience check at all),
   not yet building a fully per-service audience partition. Narrowing to distinct per-service
   audiences (so a token minted for `estimai-api` is *rejected* at `notify-api`) is an explicit
   follow-up, not solved by this ADR (see Consequences).
2. **Every resource server verifies `audience` explicitly.** Both `estimai-api`'s and
   `notify-api`'s `jwtMiddleware` (ADR-0005's `jose.jwtVerify` call) add
   `audience: env.AUTH_AUDIENCE` to the existing `{ issuer, algorithms: ['RS256'] }`
   verification options — mirroring the exact code shape ADR-0005 already documented under its
   "Deferred hardening" section:

   ```typescript
   await jwtVerify(token, JWKS, {
     issuer: env.AUTH_ISSUER,
     audience: env.AUTH_AUDIENCE,
     algorithms: ["RS256"],
   });
   ```

   `AUTH_AUDIENCE` becomes a **required** env var (validated at startup per the existing
   `src/lib/env.ts` convention) in both `estimai-api` and `notify-api`, and its value must
   match what `auth` stamps.
3. **Claim name: `aud`, value convention: `AUTH_AUDIENCE`.** The env var name is shared across
   `auth` (which sets it) and every resource server (which verifies it) so a single
   misconfigured value fails loudly (JWKS verification rejects the token, `401`) rather than
   silently accepting a mismatched audience.
4. **Rollout ordering matters.** `auth` must ship the `audience` claim and both resource
   servers must be able to accept it **before** either resource server flips on audience
   verification — turning on verification against tokens that don't yet carry the claim would
   reject every request. The rollout is: (a) `auth` starts stamping `audience` on newly issued
   tokens (existing unexpired tokens lack it), (b) resource servers deploy with verification
   *logging* a mismatch but not yet rejecting (a short bridge window bounded by the existing
   7-day token lifetime), (c) once the 7-day window has fully elapsed since (a), resource
   servers flip verification to enforcing. This mirrors how a claim-shape rollout would need to
   be sequenced against any stateless verifier with no revocation mechanism (ADR-0005's
   accepted trade-off).
5. **This decision supersedes ADR-0005's "Deferred hardening" section** (the `aud`
   sub-section specifically; the access-token-lifetime and orphaned-JWKS-endpoint items in that
   same section are untouched and remain deferred on their own separate triggers) and
   **fulfils the trigger ADR-0007 §5 named** ("gated on the first real second resource server
   (`refund-api`)" — `notify-api` turned out to be that trigger instead). Both ADR-0005 and
   ADR-0007 should be read with this ADR as the record of that trigger firing; neither older
   ADR's other content is invalidated.

## Options considered

### Option A — Suite-wide shared `aud` value, verified by all resource servers (chosen)

Described above: one `audience` claim value, set by `auth`, checked for presence/correctness
(not yet per-service uniqueness) by every resource server.

**Pros:**
- Closes the concrete, present risk — a token with **no** audience claim, or an audience value
  that doesn't match what a resource server expects, is rejected outright, which is the gap
  that exists today (no `aud` check at all)
- Minimal, mechanical change: one `definePayload` addition in `auth`, one `audience` option
  addition per resource server's already-existing `jwtVerify` call — no new infrastructure,
  no schema change, no new endpoint
- Directly implements the exact code shape ADR-0005 pre-documented for this trigger, so there
  is no design ambiguity about how to wire it
- Fulfils both ADR-0005's and ADR-0007's explicitly named deferred trigger, keeping this
  monorepo's ADR trail internally consistent (a documented trigger that actually fires, acted
  on, and cross-referenced)

**Cons:**
- Does not yet prevent replay **between** `estimai-api` and `notify-api` specifically — a
  token minted under the shared audience is still valid at both, because v1 uses one audience
  value for the whole suite rather than one per service. The unscoped-token risk (any
  suite token working anywhere) is closed; the cross-service-scoped risk (an
  estimai-api-purposed token working at notify-api) is not, in v1
- Requires a coordinated, sequenced rollout across three services (`auth`, `estimai-api`,
  `notify-api`) rather than a single-service change — more moving parts to land correctly than
  a change confined to one repo

### Option B — Distinct per-resource-server `aud` values from day one (rejected for v1, noted as follow-up)

`auth` would mint tokens with a resource-server-specific audience — e.g. requiring the client
to know in advance which service it's calling and request/receive a scoped token — and each
resource server would only accept its own value.

**Pros:**
- Fully closes the cross-service replay risk immediately: a token scoped to `estimai-api`
  is provably rejected by `notify-api` and vice versa
- Matches the strictest common interpretation of `aud` in OAuth2/OIDC-style architectures

**Cons:**
- `auth`'s current token-issuance model mints one JWT per session, used by whichever service
  the client happens to call next (the client doesn't declare an intended audience up front,
  and nothing in the current architecture asks it to) — introducing per-service scoping would
  require either minting multiple tokens per session (one per resource server, requested
  on-demand) or the client declaring intent at token-request time, both of which are real
  design changes beyond "add an `aud` check" and were not scoped or time-permitted alongside
  shipping `notify-api`
- Deferred, not rejected outright: this is recorded as the natural next hardening step once the
  suite has enough resource servers that unscoped-but-audience-checked tokens become an
  unacceptable risk (see Consequences); v1 intentionally ships the simpler shared-audience
  version now rather than blocking `notify-api` on a larger token-issuance redesign

### Option C — Continue deferring `aud` verification (rejected)

Ship `notify-api` without any audience check, repeating ADR-0005's original deferral once more
now that a second resource server genuinely exists.

**Pros:**
- No coordinated three-service change required; `notify-api` ships on the exact same
  `jwtMiddleware` shape as `estimai-api`, with zero new env vars
- No rollout-sequencing risk (the claim-shape bridge window described in Decision item 4)

**Cons:**
- Both ADR-0005 and ADR-0007 explicitly named this exact moment — a second real resource
  server going to production — as the trigger to stop deferring; continuing to defer here
  would mean the documented trigger fired and was ignored, undermining the practice of writing
  triggers into ADRs at all
- The replay risk is not hypothetical once `notify-api` exists: a token obtained via any
  legitimate suite flow (e.g. a token cached for `estimai-api` calls) is, today, silently
  valid against `notify-api` too, and neither service can currently tell the difference
- Rejected: the whole point of recording a trigger in ADR-0005/ADR-0007 was to act on it when
  it fired, not to defer indefinitely

## Consequences

**Positive:**
- The previously-open "any suite-issued token works at any resource server with zero audience
  check" gap is closed: a token missing the `audience` claim, or carrying an unrecognised one,
  is rejected by both `estimai-api` and `notify-api`
- ADR-0005's and ADR-0007's deferred-hardening trigger is resolved and cross-referenced,
  keeping the ADR trail an accurate record of what was deferred, why, and when it was acted on
- Every future Operai resource service inherits a working, already-proven `aud`-verification
  pattern from day one — the next new resource server (ReviewAI, RetroAI, ProposAI, or
  Refund's eventual `refund-api`) adds `AUTH_AUDIENCE` to its `jwtMiddleware` from the start,
  rather than needing its own retrofit
- The rollout sequencing documented here (claim-then-log-then-enforce, bounded by the 7-day
  token lifetime) becomes the template for any future claim-shape change to the shared JWT

**Negative / trade-offs:**
- v1's shared suite-wide audience value does **not** prevent a token obtained for one resource
  server from being replayed at another — only unscoped/unrecognised-audience tokens are
  rejected. This is a known, explicitly recorded gap, not an oversight (see Option B)
- The rollout requires a coordinated, correctly-sequenced deploy across three services
  (`auth`, `estimai-api`, `notify-api`); a mis-sequenced deploy (verification enabled before
  `auth` is stamping the claim) fails every request with `401` until corrected
- `AUTH_AUDIENCE` is now a required env var in two services (soon more), another value that
  must be kept consistent across environments (local/preview/production) alongside the
  existing `AUTH_ISSUER`/`AUTH_JWKS_URL` pair

**Risks:**
- **Mis-sequenced rollout causing suite-wide outage.** If a resource server starts enforcing
  `audience` before `auth` has been stamping it for the full token lifetime (7 days per
  ADR-0005), every still-valid pre-existing token will fail verification, effectively logging
  out every active session at once. Mitigation: the documented log-then-enforce bridge window
  (Decision item 4) is a hard prerequisite, not optional; the enforce-stage deploy is gated on
  the bridge window having fully elapsed since the claim-add deploy.
- **`AUTH_AUDIENCE` value drift across environments.** If `auth`'s stamped value and a
  resource server's expected value diverge (e.g. a typo in one environment's config), every
  request in that environment fails closed. Mitigation: treat `AUTH_AUDIENCE` as a single
  suite-wide constant documented alongside `AUTH_ISSUER`/`AUTH_JWKS_URL` in each service's
  `.env.example`, not a per-service bespoke value, until Option B's per-service scoping is
  undertaken.
- **False sense of cross-service isolation.** Because `aud` verification now exists, it would
  be easy to assume `estimai-api` and `notify-api` are fully isolated from each other's tokens
  — they are not yet (see Consequences). Mitigation: this ADR explicitly records the
  shared-audience limitation and names per-service audience scoping (Option B) as the next
  hardening step, gated on a trigger to be defined when a genuine need for service-level
  isolation arises (e.g. a resource server handling materially more sensitive data than the
  others).
- **Claim regression on existing consumers.** `estimai-api`'s `jwtMiddleware` currently
  expects `sub`+`email` and must continue to receive them unchanged; adding `audience`
  verification must not alter any other claim's shape. Mitigation: reuse ADR-0007's existing
  contract-test pattern (assert the minted token still yields `sub`+`email`+`perm_epoch`) and
  extend it to assert `audience` is present and correctly verified, run before merge in both
  resource servers.

## Compliance notes

- GDPR/nLPD impact: low — `audience` is a security-scoping claim, not personal data; it is not
  logged (mirrors the existing `sub`-not-logged posture from ADR-0005)
- Data residency: unaffected — this is a token-verification change with no new data storage or
  cross-border transfer; `auth`, `estimai-api`, and `notify-api` remain EU-hosted as already
  established
- Audit trail: not required for this decision; audience verification is a security control
  enforced per-request, not a business event requiring the ADR-0007 `audit_log`

This decision builds directly on, and formally resolves the deferred trigger recorded in,
ADR-0005 (JWT resource-server verification via remote JWKS — the "Deferred hardening" `aud`
sub-section is superseded by this ADR; the code shape it pre-documented is what ships here
unchanged) and ADR-0007 (authorization — §5's explicit note that keeping the admin API inside
`auth` avoided triggering this hardening ahead of schedule; `notify-api`, not `refund-api`, is
what ultimately triggered it). It also depends on ADR-0009 (`notify-api` as a standalone JWKS
resource service), whose existence is the concrete cause of this ADR.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
