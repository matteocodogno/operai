# 0035 — Third-party app-access lookup: a decision endpoint, not a fact endpoint, on the forwarded-caller-JWT trust model

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

Spec `specs/013-estimate-sharing` (US-1) requires `estimai-api` to answer a question nothing
in the suite answers today: *is this email address an active Operai user who holds EstimAI
app access?* AC-1.1 needs a positive answer to create a collaborator grant; AC-1.2 requires
that the two possible negative causes — "no such Operai account" and "account exists but
lacks EstimAI access" — be **indistinguishable by any observable difference in the response**
(message text, HTTP status, or timing). Every existing authorization endpoint in the suite
(`auth GET /authz/me`, `GET /authz/resolve`, ADR-0007/ADR-0014) answers only about the
**caller's own** effective permissions; none resolves a **third party's**.

Two trust models were available for the new lookup: forward the caller's own Bearer JWT
(the pattern ADR-0014 established for `refund-api → auth`), or mint a **new** internal shared
token on the ADR-0011/ADR-0017 pattern. The choice matters beyond this feature — it fixes how
every future "ask `auth` about someone else" requirement gets built.

## Decision

We will add `auth POST /authz/app-access-check`, authenticated by the caller's own forwarded
Bearer JWT (`bearerJwtMiddleware`, reused verbatim), and have it return a **boolean eligibility
decision**, never a fact about the target account's existence or access state.

1. **Trust model: forwarded caller JWT, no new secret.** `estimai-api` forwards the calling
   owner's already-verified Bearer token to `auth`. `auth` verifies it the same way every
   other resource-server call is verified (JWKS, `iss`, `aud`) and additionally requires the
   **caller** to themselves hold `(appId, "access")` — resolved via the existing
   `resolveEffectivePermissions`, no new catalog permission, no seed change. A soft-deleted
   caller (residual JWT, ADR-0012) is rejected 403. Rejected the internal-shared-token
   alternative (ADR-0011's pattern) explicitly: it would put a new inbound service-trust
   surface on the identity service itself — the single service where a leaked static secret
   is most consequential — and would make the endpoint unattributable and un-rate-limitable
   precisely where per-caller limits are the primary anti-abuse control. A third static shared
   secret, while ADR-0011's "second internal caller" escalation trigger is already twice-fired
   (see ADR-0017 and ADR-0040), would have been indefensible.
2. **The catch this trust model creates: the endpoint is directly callable by any end user
   holding their own token.** CORS is not a control against a non-browser `curl`. If the
   endpoint returned facts ("no such user" vs. "user exists, no EstimAI access"), AC-1.2's
   anti-enumeration property would be defeated for anyone technical enough to bypass the UI.
3. **Resolution: return a decision, not a fact.**
   ```
   POST /authz/app-access-check → { "eligible": true, "userId": "…" }
                                 → { "eligible": false }   ← BOTH negative causes, byte-identical
   ```
   The two negative causes (no such user; user exists but lacks `(appId,"access")`; a
   soft-deleted target — `deletedAt IS NULL` is an explicit predicate, not an implicit
   consequence of absence) collapse into one shape **at the source**. This makes AC-1.2's
   property hold no matter who calls the endpoint or by what route; `estimai-api`'s own
   generic-ization of the 422 (ADR-0037/plan) is then a second layer, not the only one.
4. **Timing mitigation: equalised work path + dual response floors — the suite's first
   rate limiter.** Two negative-path branches must cost the same:
   - The email probe uses a parameterised `WHERE lower(email) = $1 AND "deletedAt" IS NULL
     LIMIT 1` against a new functional index (`CREATE INDEX user_email_lower_idx ON "user"
     (lower(email))`), so hit and miss are both single index probes — a `mode: "insensitive"`
     Prisma filter (which emits `ILIKE` and cannot use the index) is deliberately not used.
   - `resolveEffectivePermissions` runs on **every** path, including no-such-user, against a
     fixed non-existent sentinel id, so both `findMany`s always execute; the result is
     discarded on that path.
   - `auth` floors every `eligible: false` response to `APP_ACCESS_CHECK_FLOOR_MS` (default
     150 ms); `estimai-api` independently floors its whole generic-rejection response to
     `SHARE_LOOKUP_FLOOR_MS` (default 300 ms), covering the round trip. Both are quantised
     constants. The success path is not floored — positive/negative distinction is permitted
     by design (a share either happens or it doesn't).
   - **Rate limiting** — the suite has none anywhere today. A small in-process sliding-window
     limiter (`Map<sub, timestamps[]>`, no new dependency): `estimai-api POST
     /estimates/{id}/collaborators` at 20/10min per caller `sub`, counted on every attempt
     (success, duplicate, self, and generic rejection alike — counting only failures would
     leave a valid-email prober unthrottled), applied **before** the `auth` call so it also
     shields `auth`; `auth POST /authz/app-access-check` at 40/10min per caller `sub`, so
     `estimai-api`'s limit binds first in the normal flow while the directly-callable surface
     is still independently protected. Both return `429` + `Retry-After`.
5. **`POST`, not `GET`.** The probed email never enters a URL, an access log, or a `Referer`
   header.

"Timing-identical" is implemented, and tested, as *quantised to a fixed floor with an
equalised work path* — bit-exact timing identity is not achievable on a networked service;
this is the honest, testable reading of AC-1.2.

## Options considered

### Option A — Forwarded caller JWT + decision-not-fact response + equalised work + dual floors + first-ever rate limiter (chosen)

Described above.

**Pros:**
- Introduces no new credential at all — reuses the exact Bearer/JWKS trust model ADR-0005/
  ADR-0014 already established
- The caller is attributable (`sub` on the token), enabling per-caller rate limiting and
  audit — impossible with a shared token, where every caller looks identical
- Directly callable by an end user with their own token is treated as a given, not a
  vulnerability to paper over — the decision-not-fact response makes that irrelevant to
  AC-1.2's guarantee
- Confines the enumeration surface to people who already hold EstimAI app access (the caller
  gate), inside a company where the same information could be learned by asking a colleague

**Cons:**
- Adds a genuine new attack surface at `auth`: a directly-reachable, third-party-probing
  endpoint, however boolean-gated — a first for the identity service
- The timing floor adds fixed latency (150–300 ms) to every negative response, a real UX
  cost paid to preserve the anti-enumeration property
- In-process rate limiting is per-instance; a future horizontal scale-out of `auth` or
  `estimai-api` multiplies the effective limit by replica count (named in Risks, not solved
  here)

### Option B — Internal shared token (ADR-0011/ADR-0017 pattern), fact-returning response (rejected)

Provision a new `AUTH_INTERNAL_TOKEN`, callable only by `estimai-api`'s backend, returning
whatever the underlying query finds.

**Pros:**
- No end-user-facing surface at all — the endpoint would not be directly reachable by a
  browser-held JWT, sidestepping the "any technical user can curl it" problem entirely
- Simpler response shape — no need to engineer indistinguishability, since only a trusted
  backend ever sees the result

**Cons:**
- Puts a new inbound service-trust surface on `auth` itself — the one service in the suite
  where a leaked static secret is the most consequential compromise
- Unattributable: one shared secret means every call looks identical, so per-caller rate
  limiting (the primary anti-abuse control here) becomes structurally impossible
- Would be the **third** static shared secret in the suite while ADR-0011's own named
  escalation trigger ("a second internal caller") has already fired once (ADR-0017) and is
  about to fire again for an unrelated reason (ADR-0040) — stacking a third on top for a
  directly-user-triggerable lookup was judged indefensible
- Rejected: the trust-surface and unattributability costs outweigh the simplicity gain

### Option C — Facts, with UI-level obfuscation only (rejected)

Return the true underlying facts (`{exists: false}` vs. `{exists: true, hasAccess: false}`)
and rely on `estimai-ui` to render one generic message regardless.

**Pros:**
- Simplest possible endpoint contract; no timing engineering needed inside `auth`

**Cons:**
- AC-1.2 requires the property hold for "anyone inspecting network traffic," not just the
  rendered UI — a fact-returning response defeats the property for any technical user, and
  the endpoint is directly callable per Decision point 2
- Collapsing at the UI layer instead of the source means every future consumer of this
  endpoint would have to remember to re-implement the same obfuscation — a single missed
  caller reopens the leak
- Rejected: fails the acceptance criterion as written, not merely a worse implementation

## Consequences

**Positive:**
- AC-1.2's anti-enumeration property holds at the **source**, independent of any caller's
  discipline — the strongest place to enforce it
- No new secret is added to the suite; the credential surface stays exactly RS256/JWKS
- Establishes the reusable pattern for any future "ask `auth` about a third party"
  requirement: forwarded caller JWT, caller-gated on holding the relevant app's `access`,
  decision-shaped response, equalised work + floor, per-caller rate limit
- The suite's first rate limiter now exists as a small, reusable in-process primitive for
  future anti-abuse needs

**Negative / trade-offs:**
- Every negative response pays a fixed 150–450 ms combined latency cost (`auth`'s floor plus
  `estimai-api`'s own floor on top)
- `auth` now has a directly end-user-reachable endpoint whose entire design goal is resisting
  probing — a new class of surface for that service to maintain correctly forever (the
  anti-enumeration contract test is the tripwire, per the plan's test strategy)
- In-process rate limiting and the sentinel-resolve equalisation add real code paths that
  must be kept correct under future refactors — a bug in either silently reopens the timing
  or the enumeration channel

**Risks:**
- **Residual timing signal.** Even with the fixed floor and equalised work, a determined
  attacker with a very large sample could in principle detect a sub-jitter signal (plan
  Risk R1). Mitigation: decision-not-fact is the primary control (there is no fact to leak
  from the source); the floor and equalised work are defence-in-depth, not the sole
  guarantee. Accepted residual: an authorised EstimAI user can learn "colleague X does/
  doesn't have EstimAI access" — the same thing they could learn by asking.
- **Per-instance rate limiting.** Both `auth` and `estimai-api` run single-instance on
  Railway today; horizontal scale-out would multiply the effective limit by replica count.
  Named, not solved — a shared store (Redis or similar) is the escalation path if either
  service scales out.
- **Fixed-floor latency masking a real outage.** If `auth`'s underlying query genuinely
  slows down, the floor could mask early symptoms of degraded database performance until
  the floor itself is exceeded. Mitigation: standard latency/error-rate monitoring on `auth`
  remains the primary signal; the floor only clamps the *fast* path.

## Compliance notes

- GDPR/nLPD impact: low — the endpoint processes an email address transiently (never
  persisted, never logged — `POST` specifically to keep it out of URLs/access logs/
  `Referer`) purely to answer a yes/no eligibility question; no new personal data is stored.
- Data residency: unaffected — both `auth` and `estimai-api` deploy to an EU region; the
  call is EU-to-EU.
- Audit trail: not required for the lookup itself (a read, gated and rate-limited, not a
  mutation); the resulting collaborator grant, if any, is `estimai-api`'s own record
  (ADR-0036).

This decision builds on ADR-0005 (the Bearer/JWKS trust model reused for the forwarded
token) and ADR-0014 (the forwarded-caller-JWT pattern for resource-server-to-`auth` calls,
here extended for the first time to a question about a third party rather than the caller's
own permissions). It explicitly rejects extending ADR-0011/ADR-0017's internal-shared-token
model to a third use, on the grounds that the model's blast radius is already stretched
thin — see ADR-0040 for the decision that did, deliberately, extend it a third time for an
unrelated, lower-stakes purpose.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
