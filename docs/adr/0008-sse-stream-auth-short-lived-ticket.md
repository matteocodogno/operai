# 0008 — SSE stream authentication via a short-lived, single-use ticket

**Date:** 2026-07-13  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

Spec `specs/005-notification-center` requires near-real-time delivery (≈2s) of unread-count
updates and toast-worthy events to every open tab/device of a signed-in user, over
Server-Sent Events (Constraint: "the near-real-time push transport is Server-Sent Events, not
WebSocket" — a product decision already made in the spec). `notify-api` is a JWKS resource
server following the ADR-0005 pattern for its REST endpoints: every request carries an
`Authorization: Bearer <jwt>` header, verified against the `auth` service's JWKS.

The browser's `EventSource` API — the standard client for consuming an SSE stream — **cannot
set custom request headers**. There is no way to attach `Authorization: Bearer <jwt>` to an
`EventSource` connection. The ADR-0005 Bearer/JWKS pattern therefore cannot reach
`GET /notifications/stream` as-is, but the stream still must be scoped to exactly one `sub`
(AC-6.2/6.3 — no cross-user leakage) and must not reopen a new authentication surface that
undermines the suite's existing security posture (ADR-0001's in-memory-JWT discipline, and
ADR-0005's stateless-verifier design).

## Decision

We will authenticate the SSE handshake with a **short-lived, single-use stream ticket**,
minted over the normal Bearer/JWKS path and consumed once by the stream endpoint:

1. **`POST /notifications/stream-ticket`** — a standard `jwtMiddleware`-protected endpoint
   (ADR-0005: RS256 + issuer pinned, `sub` derived from the verified JWT). On success it
   mints an opaque ticket, stores `{ sub, expiresAt }` keyed by the ticket in a server-side
   store, and returns `{ ticket, expiresIn: 30 }` (TTL ≈30 seconds).
2. The client (the shell's SSE connection manager in `shell/session`) calls this endpoint via
   `apiFetch` — the same trusted-origin, in-memory-JWT path used for every other Operai API
   call — then opens `EventSource({notifyBase}/notifications/stream?ticket=<t>)`.
3. **`GET /notifications/stream`** is deliberately *not* behind `jwtMiddleware` — it receives
   no `Authorization` header. It instead validates the `ticket` query parameter: unknown,
   expired, or already-used → `401 Unauthorized` (RFC 7807 Problem JSON) and the stream never
   opens. On success the ticket is immediately marked consumed (single-use) and the stream is
   opened scoped to the ticket's bound `sub`.
4. A fresh ticket is minted for **every** (re)connect — including reconnects after a dropped
   connection or after `MAX_STREAM_DURATION` (~30 min) forces the server to close a
   long-running stream. Minting requires a currently-valid JWT, so a signed-out or
   session-expired user cannot re-establish a stream (this is the closest a pure JWKS
   verifier — with no revocation list — can get to revoking a live connection; see ADR-0005's
   accepted no-revocation trade-off, which this inherits and does not attempt to solve).

The only credential that ever appears in a URL is the ticket: opaque, bound to one `sub`,
usable exactly once, and valid for ≈30 seconds. The long-lived (7-day, ADR-0005) JWT never
enters a URL, server access log, browser history entry, or `Referer` header.

v1's ticket store is an in-process `Map<ticket, { sub, expiresAt }>` — correct only for a
single `notify-api` instance (see Consequences/Risks; Railway is pinned to `numReplicas: 1`
for v1, tracked as spec `005`'s Risk R2).

## Options considered

### Option A — Short-lived, single-use stream ticket (chosen)

Described above: mint via Bearer/JWKS on the normal REST path, consume once at stream open.

**Pros:**
- The long-lived 7-day JWT never enters a URL — the worst-case leakage surface (server
  access logs, browser history, `Referer` header, proxy logs) is bounded to a ≤30s,
  single-use, opaque value, which is close to worthless if it leaks
- Reuses the existing ADR-0005 Bearer/JWKS verification path for the mint step — no new
  authentication mechanism is introduced, only a narrow-purpose, short-lived credential
  layered on top of it
- Forces re-ticketing on every reconnect, which doubles as the closest thing to
  connection-level revocation a stateless JWKS verifier can offer: a signed-out user cannot
  mint a new ticket and therefore cannot re-establish a stream

**Cons:**
- Adds one extra network round-trip before every stream (re)connect (mint, then connect)
- Requires a new server-side state store (the ticket map) — `notify-api` is no longer purely
  stateless at the process level for this one endpoint, unlike every other ADR-0005-pattern
  resource-server route
- The v1 in-process ticket store does not work across multiple `notify-api` replicas (a
  ticket minted by instance A is invisible to instance B) — explicitly deferred, not solved,
  by this ADR (see Consequences)

### Option B — Long-lived JWT as a query parameter (rejected)

`EventSource('{notifyBase}/notifications/stream?token=<7-day-jwt>')`, verified the same way
as the Bearer header would be, just read from the query string instead.

**Pros:**
- Zero extra round-trip — the existing JWT (already cached in-memory per ADR-0001) is used
  directly, no new mint endpoint or ticket store needed
- No new server-side state

**Cons:**
- Puts a **7-day-valid credential** in a URL: it lands in server access logs, browser
  history, and the `Referer` header of any subsequent same-tab navigation, and potentially in
  intermediate proxy logs. A single leaked stream URL is a full week of API access under that
  user's identity
- Directly contradicts the spirit of ADR-0001 (never let the long-lived credential land
  somewhere it can be exfiltrated or persisted outside the in-memory cache) even though
  ADR-0001 is about web storage specifically — a URL is an equally durable and more widely
  logged leak vector
- Rejected: unacceptable credential-exposure blast radius for a suite that will carry
  regulated-sector client data (data-residency rules already documented for the suite)

### Option C — Session cookie via `EventSource(..., { withCredentials: true })` (rejected)

Have `notify-api` accept the better-auth session cookie directly, the way the hosted sign-in
flow does, instead of a Bearer JWT.

**Pros:**
- `EventSource` natively supports sending cookies with `withCredentials: true` — no new
  ticket mechanism, no query-string credential at all
- No new mint endpoint

**Cons:**
- Breaks the ADR-0005 pure-resource-server pattern: `notify-api` has no session store and no
  better-auth instance of its own; consuming the session cookie would require it to either
  share the `auth` service's session database or make an authenticated call to
  `GET /auth/get-session` on every stream open — reintroducing exactly the shared-session
  coupling ADR-0005 deliberately avoided by making resource servers pure JWKS verifiers
- Reintroduces the fragile cross-origin `SameSite=None` third-party-cookie dependency
  already flagged as a risk in ADR-0006 (R7/session-cookie-sharing) — browser
  third-party-cookie restrictions could silently block the stream in exactly the deployment
  topology (shell origin, remote origin, `notify-api` origin all different) this suite uses
- Rejected: reopens a coupling and a cross-origin fragility this suite's architecture has
  already deliberately moved away from

## Consequences

**Positive:**
- No long-lived credential ever appears in a URL, log line, browser history entry, or
  `Referer` header — the worst-case leak is a ≤30s single-use opaque value
- The mint step reuses the existing, already-audited ADR-0005 Bearer/JWKS verification path;
  no parallel authentication mechanism to secure and maintain
- Establishes the **canonical SSE/streaming authentication pattern** for the Operai suite:
  any future streaming feature (ReviewAI, RetroAI, ProposAI, or a future Refund real-time
  need) mints a scoped ticket the same way rather than inventing its own transport auth
- Re-ticketing on reconnect gives a practical (if imperfect) revocation lever for a stateless
  JWKS verifier that otherwise has none

**Negative / trade-offs:**
- One extra request/response round-trip before every (re)connect, adding latency to stream
  establishment (bounded — the ticket TTL is only 30s, so this must complete fast)
- `notify-api` now holds one piece of server-side, in-process state (the ticket map) for this
  endpoint only — every other route in the service remains stateless per ADR-0005
- The client (shell SSE connection manager) must handle the two-step mint-then-connect
  sequence and retry/re-mint on ticket expiry or connection drop, rather than a single
  `EventSource` construction

**Risks:**
- **Single-instance ticket-store correctness (inherited from spec 005 Risk R2).** The v1
  in-process `Map` is correct only when `notify-api` runs as exactly one replica; a second
  replica splits mint↔connect affinity (a ticket minted by instance A is unknown to instance
  B) and breaks the handshake non-deterministically. Mitigation: v1 pins `numReplicas: 1` in
  `notify-api`'s `railway.json` (asserted by an early check), and `publish()`/the ticket store
  are both designed behind an interface so a shared backing store — **Postgres
  `LISTEN`/`NOTIFY`** for fan-out, a shared ticket table (or Redis) for the ticket store — can
  be swapped in without an application rewrite when horizontal scaling is needed. **Trigger:**
  before `notify-api` is scaled beyond one replica.
- **Ticket replay within the TTL window.** A ticket is meant to be single-use, but a race
  between two near-simultaneous stream-open requests for the same ticket could both observe
  "not yet consumed" before either marks it consumed. Mitigation: the consume-and-check must
  be a single atomic operation (e.g. `Map.delete` returning the prior value, or an equivalent
  atomic get-and-delete against the future shared store) — not a separate read then write.
- **Reconnect storm cost.** A flaky network could cause frequent re-ticket + reconnect
  cycles, each hitting the mint endpoint. Mitigation: standard client-side backoff in the SSE
  connection manager; the mint endpoint is cheap (no DB write beyond the ticket map) so this
  is a latency/noise concern, not a data-integrity one.
- **Ticket TTL vs. clock skew.** A ≈30s TTL is tight; server/client clock skew or slow network
  round-trips could cause a freshly-minted ticket to appear expired by the time the stream
  request arrives. Mitigation: TTL is deliberately generous relative to expected round-trip
  time (a mint + connect sequence normally completes in well under a second); revisit the TTL
  value if this proves too tight in practice, not the mechanism itself.

## Compliance notes

- GDPR/nLPD impact: low — the ticket carries only an opaque identifier and a `sub` (already
  an existing identity claim under ADR-0005); it is not persisted beyond its ≈30s TTL and is
  never logged in application logs (mirrors the `auth`/`estimai-api` logging posture: method +
  path + status only)
- Data residency: not applicable to the authentication mechanism itself; `notify-api` (and
  therefore the ticket store) is hosted in an EU region (Railway `europe-west4`), consistent
  with the suite's existing data-residency rule
- Audit trail: not required for this decision; ticket mint/consume is a transport-security
  mechanism, not a business event

This decision builds directly on ADR-0005 (JWT resource-server verification via remote
JWKS — the mint endpoint follows that pattern verbatim; the stream endpoint's ticket-based
auth is a narrowly-scoped exception to it, not a replacement of it for the rest of
`notify-api`'s routes).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
