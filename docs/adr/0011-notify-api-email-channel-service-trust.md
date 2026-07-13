# 0011 — notify-api email as a second delivery channel, with a shared-secret auth→notify-api service-to-service trust

**Date:** 2026-07-14  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

Spec `specs/006-user-invitations` requires inviting a person who has never signed in and
therefore has no `User` row, no `sub`, and no in-app notification inbox to land in — the
invite (and its resend) must reach them by email, sent via Resend (a locked Constraint), and
written bilingually (Italian + English, CLAUDE.md's i18n rule and AC-2.1). The same spec's
Constraint also locks *where* this lives: "invite/resend email is delivered as a SECOND
channel of the existing notify-api service (specs/005), NOT a new, separate service" — no new
service is introduced for this feature.

This creates two problems `notify-api` did not previously have to solve. First, every existing
`notify-api` capability (ADR-0009) addresses a **`sub`** — the in-app/SSE channel persists a
`Notification` row and pushes to one signed-in user's stream, verified via the ADR-0005 JWKS
pattern with `aud` enforced per ADR-0010. An invitee has no `sub` at all; the new channel must
address a **raw email string**, a fundamentally different addressing model that must not leak
into or corrupt the existing in-app path. Second, the caller triggering the send is `auth`, not
a signed-in end user acting on their own behalf — there is no end-user JWT to forward, because
the "user" being emailed doesn't exist yet, and `auth` itself has no `sub` of its own to be
verified against `notify-api`'s existing `jwtMiddleware`. This is the suite's first
service-to-service (not user-to-service) call, a shape none of ADR-0005/0008/0009/0010
addressed.

## Decision

We will give `notify-api` a second channel implementation addressing raw email addresses via
Resend, and trigger it from `auth` via a **dedicated internal endpoint authenticated by a
shared secret token**, deliberately outside the ADR-0005 user-JWT/JWKS pattern.

1. **Channel abstraction.** `notify-api/src/channels/` gains two implementations behind a
   small internal interface: `inApp` (today's behaviour, unchanged — addresses a `sub`,
   persists a `Notification`, publishes to SSE) and `email` (new — addresses a raw email
   address, renders a bilingual template, sends via Resend, and records an `EmailDelivery`
   row: `to`, `template`, `status` (`queued`/`sent`/`failed`), `providerId`, `error`). The
   existing user-JWT `POST /notifications` route uses `inApp` unchanged; nothing about the
   in-app addressing model (recipient = verified `sub`) is touched or reused by `email`.
2. **`POST /system/emails`** — a new, internal-only endpoint, mounted on its own router with
   its own `internalTokenMiddleware`, checking a header (`X-Internal-Token`) against
   `NOTIFY_INTERNAL_TOKEN` (a strong, random, 1Password-sourced shared secret, identical value
   configured in both `auth` and `notify-api`). This is **not** `jwtMiddleware` — it verifies no
   JWT, no `sub`, no `aud`, and issues no session. Symmetrically, `jwtMiddleware`-protected
   routes never accept the internal token, and `/system/*` never accepts a user JWT — the two
   auth mechanisms are mutually exclusive by route, not layered.
3. **`auth` triggers the send synchronously** from the invite-create / resend handler
   (`src/lib/notify.ts`), after the invitation row is committed: `POST /system/emails
   {to, template, data}`. `auth` owns *when* an email is due (invitation lifecycle decisions);
   `notify-api` owns *delivery* (Resend call, template rendering, `EmailDelivery` log) —
   `notify-api` stays invitation-agnostic, matching the existing seam where it never contains
   another tool's business logic (ADR-0009).
4. **Templates are fixed and bilingual, inputs are escaped.** The only variable inputs to a
   template are `to`, `inviteUrl`, `inviterName`, `expiresAt` — no free-form HTML, no
   admin-supplied subject/body, no reply-to injection surface. This is the deliberate mitigation
   for the trust boundary this decision creates (see Consequences).
5. **This is a conscious, narrow departure from ADR-0005's resource-server pattern.** Every
   other Operai resource-server route (`estimai-api`, and `notify-api`'s own user-facing
   routes) verifies a caller's identity via JWKS-verified Bearer JWT. `/system/emails` verifies
   no identity at all — only that the caller holds a shared secret. This is intentional: the
   traffic is system/transactional, not on behalf of any authenticated end user, and forcing it
   through the JWKS path would require inventing an identity that doesn't exist (see Options
   considered, Option C, for the alternative that was weighed and deferred rather than chosen).

## Options considered

### Option A — Dedicated internal endpoint, shared service-secret auth (chosen)

Described above: `POST /system/emails`, its own router, its own `internalTokenMiddleware`,
`NOTIFY_INTERNAL_TOKEN` as the sole credential.

**Pros:**
- Zero new authentication mechanism to design from scratch — a shared secret over an
  internal-only endpoint is the simplest correct primitive for "one trusted backend calls
  another," and is easy to reason about (one env var, one middleware, one route group)
- Does not touch or complicate the existing JWKS verifier at all — `jwtMiddleware` (ADR-0005)
  and the new `internalTokenMiddleware` never share code paths, so there is no risk of a
  system-trust bug leaking into the user-JWT verification logic or vice versa
- Matches the actual trust relationship: this is `auth` (a trusted backend) calling
  `notify-api` (another trusted backend) about a third party who is not yet a user — not an
  end user acting through a delegated credential

**Cons:**
- Introduces a new kind of secret (`NOTIFY_INTERNAL_TOKEN`) that must be provisioned,
  rotated, and kept out of logs — a manual operational responsibility the JWKS pattern doesn't
  have (JWKS keys rotate via the existing key-pair mechanism, not a shared value across two
  services)
- The entire trust boundary collapses to "only `auth` holds the token" — there is no scoping,
  no expiry, and no revocation short of rotating the secret and redeploying both services (see
  Risks)

### Option B — Forward the admin's end-user JWT (rejected)

Have `auth` attach the acting admin's own Bearer JWT to the call to `notify-api`, and have
`notify-api` verify it the normal ADR-0005 way.

**Pros:**
- No new secret, no new middleware — reuses the exact JWKS verification path every other
  route already uses

**Cons:**
- Wrong trust semantics: the actual recipient of the email is a third-party address, not the
  admin's `sub` — but `notify-api`'s entire in-app addressing model derives the recipient from
  the verified JWT's `sub`. Forwarding the admin's token would either require inventing a
  special case where `sub` is ignored in favour of a request-body address (silently punching a
  hole through the "recipient = verified identity" invariant the in-app channel depends on), or
  misusing the admin's own identity as if *they* were the notification's subject
- Conflates "an admin is signed in and acting" with "a system send is due" — any admin-scoped
  token reaching this endpoint could trigger arbitrary-address sends under cover of a routine
  API call, widening the blast radius of a leaked admin token beyond what admin scope should
  mean
- Rejected: solves the wrong problem (delegated end-user authorization) for a call that is not
  end-user-initiated in the sense the JWKS pattern models

### Option C — `auth` self-issues a scoped service JWT (`sub="system:auth"`, dedicated `aud`, `scope="email.send"`), verified via the existing JWKS (rejected for v1, named as future hardening)

`auth` mints its own short-lived JWT off the same RS256 keypair it already uses for user
sessions, with a system `sub` and a distinct audience/scope claim; `notify-api` verifies it via
the same `createRemoteJWKSet` call its `jwtMiddleware` already uses (ADR-0005), with an
additional scope check.

**Pros:**
- No new secret at all — reuses the existing signing keypair and JWKS endpoint, so there is
  nothing new to rotate or leak outside the key-management story the suite already has
- Fits cleanly alongside ADR-0010's audience scoping: a dedicated `aud` value for
  system/transactional traffic is a natural extension of the same mechanism, not a parallel one
- More auditable in principle: a scoped, short-lived, signed token is closer to
  least-privilege than an indefinitely-valid shared secret

**Cons:**
- Forces a second, distinct verification path into `notify-api`'s middleware: its current
  `jwtMiddleware` hard-requires an `email` claim and treats `sub` as the recipient — a system
  token satisfies neither, so a separate route/middleware would be needed *anyway*, giving up
  most of the "no new code path" benefit this option would otherwise have
- Requires `auth` to mint tokens for itself (a new code path distinct from user-session
  issuance) and requires coordinating a new `aud`/`scope` convention across two services before
  this one feature can ship — more design and rollout surface than the feature's schedule
  justified
- Rejected for v1, not on security grounds but on coupling/timing grounds: the shared-token
  route achieves the same isolation with less new surface today. **Recorded as the intended
  future hardening path** — if the suite later wants system-to-system calls to be scoped,
  short-lived, and revocable the way user sessions are, this is the direction to take, and this
  ADR should be revisited when that trigger fires (a second internal caller, a compliance
  requirement for token expiry on all inter-service calls, or a security-review finding against
  the static-secret model)

## Consequences

**Positive:**
- `notify-api` gains a bilingual, transactional email channel without any of its existing
  in-app/SSE logic, addressing model, or JWKS verification being touched — the two channels are
  fully isolated in the code (separate implementations behind one interface) and in trust model
  (user JWT vs. internal token)
- `auth` gets a clean, narrow way to trigger a system email without needing to model itself as
  an authenticated "user" of `notify-api` — the shape matches the actual relationship (trusted
  backend to trusted backend)
- Establishes the pattern for **every future system/transactional send** in the suite: any
  future service needing to trigger notify-api on behalf of a non-authenticated recipient (a
  password-reset-style flow, a Refund submission reminder to someone not yet in Operai, etc.)
  reuses `/system/emails` and the internal-token convention rather than inventing its own

**Negative / trade-offs:**
- The entire trust boundary is "only `auth` holds `NOTIFY_INTERNAL_TOKEN`." Unlike the JWKS
  pattern (ADR-0005), there is no per-call identity, no expiry, and no revocation mechanism
  short of rotating the secret and redeploying both services — a strictly weaker security
  property than every other cross-service call in the suite today
- A new secret exists that must be provisioned via 1Password, kept out of application logs,
  and never exposed on a public ingress — one more piece of operational discipline alongside
  the JWT keypair and `AUTH_AUDIENCE`
- `notify-api` now has two structurally different authentication mechanisms (JWKS Bearer,
  shared internal token) living side by side, which must be kept strictly non-overlapping by
  route — a future contributor adding a route could, by mistake, mount it under the wrong
  middleware

**Risks:**
- **Leaked-token blast radius (plan Risk R2).** A leaked `NOTIFY_INTERNAL_TOKEN` lets an
  attacker send arbitrary email over wellD's Resend domain (phishing risk against the sending
  domain's reputation) — this is the whole trust boundary, with no secondary control.
  Mitigation: internal-network-only exposure (Railway private networking, never public
  ingress), a strong CSPRNG-generated token stored only in 1Password, never logged by either
  service (mirrors the suite's existing method+path+status-only logging posture), and no
  reply-to/HTML-injection surface — only `to`/`inviteUrl`/`inviterName`/`expiresAt` are variable
  and all are escaped into fixed bilingual templates. An OWASP pass on `/system/emails` is
  scheduled per the plan's Security section.
- **No token expiry or automatic rotation.** A static secret has no built-in freshness
  guarantee, unlike the 7-day JWTs the rest of the suite issues. Mitigation: treat rotation as a
  manual 1Password + redeploy operation if compromise is suspected; Option C above is the named
  escalation path if this becomes an unacceptable posture.
- **Cross-route middleware confusion.** A future route added to `notify-api` could accidentally
  be mounted so that it accepts both a user JWT and the internal token, or neither correctly.
  Mitigation: the two middlewares live in clearly separate router groups (`/system/*` vs.
  everything else) with a contract test asserting `/system/emails` rejects a valid user JWT and
  every user-facing route rejects the internal token.

## Compliance notes

- GDPR/nLPD impact: low — the email body carries no client/estimate PII, only the invitee's own
  address, the invite link, the inviter's name, and the expiry timestamp; `EmailDelivery` logs
  delivery status, not email content, and the internal token itself is never logged
- Data residency: unaffected by this decision itself — invitation data at rest stays in EU
  Postgres (Railway EU, consistent with `notify-api`'s existing ADR-0009 deployment); Resend is
  used as the transactional MTA, with its EU sending region preferred where available
- Audit trail: invitation create/resend/revoke actions are recorded in `auth`'s `audit_log`
  (ADR-0007's mechanism) independently of this decision; the email-send outcome itself
  (`sent`/`failed`) is recorded in `notify-api`'s `EmailDelivery` table, not the audit log — it
  is a delivery record, not an authorization-relevant event

This decision builds on ADR-0005 (JWT resource-server verification via remote JWKS — the
pattern this endpoint deliberately departs from, for system/transactional traffic only; every
other `notify-api` route is unaffected), ADR-0008 (SSE stream authentication — another instance
of `notify-api` layering a narrow, purpose-specific credential alongside its main JWKS
pattern), ADR-0009 (notify-api as a standalone service — the channel this ADR extends), and
ADR-0010 (JWT `aud` enforcement — Option C above would have extended that same mechanism to
system traffic; this ADR chose not to, for now).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
