# 0048 — `auth` mints its own notify service credential in process under the reserved client id `auth`, instead of calling its own `POST /system/service-token` or keeping the shared token

**Date:** 2026-10-13
**Status:** Accepted
**Deciders:** wellD (decided by the user at the specs/016 plan gate)
**Project:** Operai

---

## Context

Spec 016 moves every `notify-api` caller from the shared `NOTIFY_INTERNAL_TOKEN` to a scoped
service JWT and retires the shared token (building on ADR-0044). One caller is awkward: `auth`
is the issuer of those credentials (`POST /system/service-token`, ADR-0044) and also a caller of
`notify-api`, because it sends invitation emails through `POST /system/emails` (ADR-0011,
`auth/src/lib/notify.ts`). Every other caller needs a client secret to prove to `auth` that it
may receive a token. `auth` already holds the signing key, so the question (the open question in
spec 016, AC-1.4) is how `auth` obtains the credential it presents to `notify-api`.

## Decision

We will have `auth` mint its own credential in process, through the same signer the endpoint
uses (`signWithAuth(auth)`, better-auth's rotating key published at `/auth/jwks`), with fixed
claims `sub="system:auth"`, `aud=SERVICE_AUDIENCE`, `scope="emails.send"` and the endpoint's
300 s lifetime. The client id `auth` is reserved: a `SERVICE_CLIENTS` entry with that id makes
`auth` refuse to start.

1. **One code path.** The claim-building and signing code is extracted from
   `serviceToken.routes.ts` into a single function that both the endpoint and the new
   `auth/src/system/selfServiceToken.ts` call, so the two cannot drift in claims, audience or
   lifetime.
2. **Injected signer.** The self-mint provider takes its signer as a dependency and is wired in
   `auth/src/index.ts`, for the reason documented at the top of `serviceToken.routes.ts`:
   sibling test files `mock.module("../auth/auth.config")`, so a module importing it directly
   behaves differently depending on file order.
3. **Caller behaviour.** `sendInvitationEmail` takes the token from the provider (cached,
   refreshed 60 s before expiry, like every other caller) and sends `Authorization: Bearer`. A
   mint failure is returned as `{ status: "failed" }`, exactly like a failed send today, and
   never rolls back the invitation.
4. **Reserved id.** `auth` is rejected at `SERVICE_CLIENTS` parse time, with the same
   refuse-to-start posture as an unknown scope.
5. **`SERVICE_AUDIENCE` becomes required in `auth`.** It was required only when
   `SERVICE_CLIENTS` was set; production has had it since specs/015.

## Failure shape

A principal that holds the means to issue a credential is made to *authenticate to itself* with
a separate secret, or is left on a weaker shared credential because "it is the special case".
Both are the same mistake: the identity of the issuer is not modelled as an identity. The first
variant adds a secret that proves nothing, since the party verifying it is the party holding it,
and puts a network hop and a shared resource budget in the way of a path the issuer controls.
The second variant keeps the long-lived, unattributable credential alive for exactly one
holder, so it is never retired.

The reserved id is the mirror image. Once an issuer's own principal (`system:auth`) exists
without a secret, any externally configurable registry that can name that principal lets
whoever holds that entry's secret mint tokens indistinguishable from the issuer's own. A
principal that is minted without a credential check must be unreachable through the path that
mints with one.

It recurs wherever a component is both issuer and consumer of a trust mechanism: a service that
signs tokens and also calls a resource server, an identity service that is also a client of its
own API, a gateway that issues and checks its own session or ticket tokens (for example
notify-api's own SSE tickets, ADR-0008), or a future issuer of any scoped credential. It also
recurs in the symmetric direction, inbound versus outbound: the issuer verifying its own
tokens, and any operator-editable allowlist or client table that can name a principal the code
already creates implicitly. Recognise it by asking, for any credential an issuer presents: *is
there a secret here that only proves the holder is itself, and can any configurable entry
collide with an identity the code mints on its own?*

## Options considered

### Option A — In-process self-mint under a reserved client id (chosen)

Described above.

**Pros:**
- No extra hop on the invitation path and no dependence on `auth` reaching itself over HTTP
- No secret that exists only so the signer can prove it may sign
- Does not consume the token endpoint's per-address rate limit, which plan risk R-1 already
  flags as tight with three external callers
- The shared token is retired for every holder, `auth` included (spec US-5)
- `sub="system:auth"` and scope `emails.send` make `auth` attributable and narrowly scoped in
  `notify-api`'s caller log, like every other caller

**Cons:**
- A second place that mints a service token. Mitigated by the shared extracted function and a
  contract test signing with the real better-auth plugin and verifying against its JWKS
- `system:auth` has no secret to rotate or revoke: it is revoked only by a code change or by
  removing the scope from `notify-api`'s accepted set
- The reserved id is an extra rule operators must know; a collision is a startup refusal, not a
  silent override
- `SERVICE_AUDIENCE` becomes mandatory for `auth` even when `SERVICE_CLIENTS` is empty

### Option B — `auth` calls its own `POST /system/service-token` over loopback HTTP with its own `SERVICE_CLIENTS` entry (rejected)

**Pros:**
- Every caller, `auth` included, uses an identical path and an identical client library
- No reserved id and no second minting site

**Cons:**
- An extra HTTP hop on the invitation path, with a failure mode (self-call) that does not
  otherwise exist
- Introduces a secret whose only purpose is letting the holder of the signing key prove to
  itself that it may sign; the verifier is the holder, so the secret adds no assurance
- Spends the endpoint's rate limit on traffic that never needed it

### Option C — `auth` keeps `NOTIFY_INTERNAL_TOKEN` for itself (rejected)

**Pros:**
- No new code in `auth`

**Cons:**
- The shared token could never be retired, against spec 016 US-5 and the hard stop in ADR-0040
- A leak from any holder, now only `auth`, still yields arbitrary email over wellD's Resend
  domain with no attribution or scope
- Leaves two trust mechanisms on `/system/emails` permanently

## Consequences

**Positive:**
- Every `notify-api` caller authenticates as itself; `notify-api` can drop the shared-token
  path (spec 016 AC-5.1)
- Invitation sending gets no new network dependency and no new secret
- `auth` shows up as `caller=system:auth` in the `[system-auth]` log line

**Negative / trade-offs:**
- Two minting sites share one function, so any change to claims must go through it
- The self-mint scope is fixed in code (`emails.send`); widening it is a code change reviewed
  as such, which is the intent

**Risks:**
- **Reserved-id regression.** If the `auth` check were dropped from `SERVICE_CLIENTS` parsing,
  an operator-defined client could mint tokens indistinguishable from `auth`'s own. Mitigation:
  a unit test asserting the parse error for id `auth` (spec 016 AC-2.6).
- **Drift between endpoint and self-mint.** Mitigated by the shared function; the contract test
  pins `sub`, `scope` and `aud`.
- **Test-order fragility** from importing `auth.config` directly. Mitigated by the injected
  signer, wired in `src/index.ts`.
- **Token or mint failure at send time** is handled as a failed send (best-effort, ADR-0011
  posture); the invitation stays created and resend is the retry path.

## Compliance notes

- GDPR/nLPD impact: none. This changes how `auth` authenticates to `notify-api`, not what data
  is sent.
- Data residency: unaffected; the call remains EU-to-EU.
- Audit trail: not required beyond standard access logs. Tokens must never be logged.

This decision extends ADR-0044 (the minting mechanism) to the issuer itself and is part of
spec 016's retirement of the shared token begun by ADR-0040's hard stop.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
