# 0005 — JWT resource-server verification via remote JWKS

**Date:** 2026-07-03  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai — EstimAI

---

## Context

`estimai-api` must authenticate every request. The Operai `auth` service is the
single identity provider for the suite: it issues RS256-signed JWTs (via `jose`,
private key `JWT_PRIVATE_KEY`) and exposes a JWKS endpoint at
`/.well-known/jwks.json` (key ID `operai-auth-rs256-v1`, `Cache-Control: max-age=3600`).
The `iss` claim equals `BETTER_AUTH_URL`; the `sub` claim is the user's database id.

`estimai-api` has no better-auth instance and no session cookie of its own. It is the
first **resource server** in the monorepo — a service that consumes the JWT issued by
`auth` but never issues tokens. It must verify the JWT on every request, scope every
database query to the verified `sub`, and reject unauthenticated requests before any
data is touched (AC-4.2). Fetching or mutating an estimate that the caller does not
own must return 404 — not 403 — to prevent existence leakage / IDOR (AC-4.1).

## Decision

We will implement a `jwtMiddleware` in `estimai-api/src/auth/jwt.middleware.ts` that:

1. Reads the `Authorization: Bearer <jwt>` header; missing or malformed header →
   `401 Unauthorized` (RFC 7807 Problem JSON). No DB access occurs.
2. Verifies the RS256 signature with `jose` `jwtVerify`, keying against a
   **`createRemoteJWKSet`** instance constructed once at module scope from
   `AUTH_JWKS_URL`. The verifier is configured with `{ issuer: AUTH_ISSUER,
   algorithms: ['RS256'] }` — algorithm is pinned; `alg: none` and HS256 algorithm
   confusion are rejected.
3. On any verification failure (expired token, bad signature, wrong issuer, wrong
   algorithm, unknown `kid`) → `401 Unauthorized` (RFC 7807). No DB access occurs.
4. On success: `c.set('userId', payload.sub)` and `c.set('email', payload.email)`.
   Every repository call uses `where: { userId }` derived exclusively from this
   context value — never from a request body or path parameter.

Fetching or mutating an estimate not owned by the caller is handled by the `userId`
predicate in the Prisma query: "not yours" and "does not exist" are indistinguishable,
both surfacing as `404 Not Found`. No `403 Forbidden` is ever returned for ownership
failures.

`createRemoteJWKSet` caches the fetched public keys in memory and refetches only when
an unknown `kid` is encountered. It honours the `Cache-Control: max-age=3600` header
on the JWKS response. The instance is created once at module initialisation; no
per-request JWKS fetch occurs in the steady state.

This establishes the **canonical JWKS-consumer pattern** for all future Operai
resource services.

## Options considered

### Option A — Remote JWKS verification with `jose createRemoteJWKSet` (chosen)

The resource server fetches the public key set from `auth`'s JWKS endpoint at startup
(and on unknown `kid`). Verification uses the RS256 public key; the private key never
leaves the `auth` service.

**Pros:**
- Asymmetric design is preserved end-to-end: `estimai-api` only ever holds the public
  key (via JWKS); a compromise of `estimai-api` does not expose the signing key
- Key rotation is handled transparently: when `auth` rotates to a new `kid`, the
  first request carrying the new `kid` triggers a JWKS refetch; no `estimai-api`
  deployment is needed
- `jose` is already a dependency of `auth`; no new ecosystem dependency
- `createRemoteJWKSet` caches keys in memory and honours `max-age`; JWKS availability
  is needed only at startup and on key rotation — not on every request

**Cons:**
- `estimai-api` has a hard runtime dependency on `auth` JWKS availability: if `auth`
  is unreachable and no keys are cached yet, all requests fail closed (401/503)
- The JWKS URL (`AUTH_JWKS_URL`) must be configured in `estimai-api`'s env vars and
  must be reachable from the deploy environment

### Option B — Symmetric secret / HMAC verification (rejected)

Share a secret between `auth` and `estimai-api`; verify with `HS256`.

**Pros:**
- No network dependency on `auth` at verification time — the secret is local
- Simpler implementation (no JWKS fetch)

**Cons:**
- Directly contradicts the RS256 asymmetric design chosen for the suite: `auth`
  signs with RS256; adding HS256 verification requires issuing a different token
  class or a separate signing path
- Sharing a secret between two services means a compromise of `estimai-api` exposes
  the ability to forge tokens — the threat model worsens
- Rejected: incompatible with the RS256 JWT design and worsens the security posture

### Option C — Embed the RS256 public key as a static env var (rejected)

Configure `estimai-api` with the PEM-encoded public key directly (no JWKS fetch).

**Pros:**
- No network dependency on `auth` at runtime; verification is always local
- Simpler operational setup: no `AUTH_JWKS_URL` needed

**Cons:**
- Key rotation requires a coordinated `estimai-api` env-var update and redeploy —
  manual and error-prone
- Misses the established JWKS pattern and forecloses a consistent rotation story for
  future resource services
- Rejected: key rotation cost and inconsistency with the JWKS endpoint `auth` already
  exposes and caches at `max-age=3600`

### Option D — Return 403 for not-owned resources (rejected)

Return `403 Forbidden` when a valid JWT holder requests an estimate they do not own,
to distinguish "authenticated but not authorised" from "not found".

**Pros:**
- Semantically more precise: the caller is authenticated; the resource exists but
  access is denied

**Cons:**
- Leaks existence: a `403` on `GET /estimates/{id}` tells the caller that an estimate
  with that id exists, just not for them — an IDOR information disclosure
- AC-4.1 requires that user B receives none of user A's data and the attempt is
  rejected; a 403 returns information about user A's estimate (its existence)
- Rejected: existence leak; the `userId` predicate in the Prisma query already makes
  "not owned" and "not found" structurally indistinguishable; 404 is correct

## Consequences

**Positive:**
- Every unauthenticated or invalid-token request is rejected before touching the DB;
  the DB is never called for an unverified identity (AC-4.2)
- Ownership is enforced entirely in the repository layer via `where: { userId }`;
  there is no separate authorisation check that could be accidentally skipped
- The JWKS pattern is documented here as the template for ReviewAI, RetroAI, and
  ProposAI resource services — future services copy `jwt.middleware.ts` and set their
  own `AUTH_JWKS_URL`/`AUTH_ISSUER` env vars
- Key rotation in `auth` does not require a coordinated `estimai-api` deployment

**Negative / trade-offs:**
- `estimai-api` will not serve any requests until at least one JWKS fetch has
  succeeded; a cold-start race between `estimai-api` and `auth` will cause transient
  401s until keys are cached
- A health endpoint (`GET /health`) must report JWKS readiness so the orchestrator
  can hold traffic until keys are loaded

**Risks:**
- **JWKS unavailability after initial cache.** If `auth` restarts with a new `kid`
  and `estimai-api`'s cached keys are stale, the refetch may temporarily fail if
  `auth` is mid-deploy. `jose`'s `createRemoteJWKSet` will retry on the next unknown
  `kid` request. Mitigation: deploy `auth` before `estimai-api`; health-check `auth`
  JWKS before routing production traffic to `estimai-api`.
- **Algorithm confusion (`alg: none` / HS256 downgrade).** Without explicit algorithm
  pinning, a crafted JWT with `alg: none` could bypass signature verification in
  some libraries. Mitigation: `jwtVerify` is called with `{ algorithms: ['RS256'] }`
  explicitly; no other algorithm is accepted.
- **`sub`-derived `userId` contract.** If the `auth` service changes the `sub` claim
  from user db-id to another identifier, all ownership queries break silently (data
  becomes inaccessible, not corrupted). Mitigation: the integration test
  `T-JWKS-identity` (spec 001 test strategy) mints a real JWT, calls `POST
  /estimates`, then asserts that `GET /estimates/{id}` for a different user returns
  404 — this catches any `sub` contract drift.

## Deferred hardening

**Audience (`aud`) claim verification** is not implemented in this middleware. The `auth`
service does not currently set an `aud` claim, and there is only one resource server
(`estimai-api`), so there is no cross-service token-replay risk today.

Once a second Operai resource service ships (ReviewAI, RetroAI, ProposAI, or any other),
all resource servers will share the same issuer and signing key — a JWT minted for one
will be structurally valid on another. **Trigger:** before a second resource service goes
to production, coordinate with the `auth` service to set `aud` on issued tokens and
update this middleware to verify it:

```typescript
await jwtVerify(token, JWKS, {
  issuer: env.AUTH_ISSUER,
  audience: env.AUTH_AUDIENCE,   // e.g. "estimai-api"
  algorithms: ["RS256"],
});
```

`AUTH_AUDIENCE` would become a required env var in each resource service. Until then,
do not add audience verification — the `auth` service does not set the claim and doing
so would break every request.

## Compliance notes

- GDPR/nLPD impact: low — JWT verification is a security control; no personal data
  is persisted or logged as part of this middleware. The `sub` (user id) is used only
  as a DB query predicate and is not written to application logs
- Data residency: not applicable to the verification mechanism itself; the JWKS
  endpoint is hosted by the `auth` service in an EU region
- Audit trail: not required for this decision; session-level audit is owned by
  better-auth in the `auth` service

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
