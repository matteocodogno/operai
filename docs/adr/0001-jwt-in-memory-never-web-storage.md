# 0001 — JWT stored in memory, never in web storage

**Date:** 2026-06-07  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai — EstimAI

---

## Context

`estimai-ui` integrates with the Operai auth service (better-auth, RS256 JWT). The
auth service issues a 7-day session cookie via better-auth and exposes
`GET /auth/token` (cookie-authenticated) which returns a signed RS256 JWT. The UI
must attach that JWT as a `Bearer` token on every outgoing request to Operai backend
services (via `src/lib/api.ts`, per spec 002 plan).

The spec requires the JWT to be stored client-side so an interceptor can attach it
without a round-trip on every request. The question is where: persistent web storage
(`localStorage`/`sessionStorage`) or an in-memory variable.

The application's security surface must be kept minimal: the Operai tool handles
client-sensitive consulting data, and any XSS vulnerability in the React application
would be the primary threat vector for credential theft.

## Decision

We will cache the RS256 JWT in a module-scope in-memory variable inside
`src/lib/api.ts`. The variable is populated by calling `GET /auth/token` on demand
(first request, or after the cache is cleared). It is never written to
`localStorage`, `sessionStorage`, `IndexedDB`, or any other browser-persistent
storage. The 7-day session cookie managed by better-auth is the sole durable
credential.

The `apiFetch` wrapper in `src/lib/api.ts` must implement the following refresh
protocol:

1. If no JWT is cached, fetch `GET /auth/token` (cookie-authenticated); cache the
   result; attach `Authorization: Bearer <jwt>` to the outgoing request.
2. On a **401** response: clear the cached JWT; fetch `GET /auth/token` once (the
   session cookie may have outlived a previously cached JWT); retry the original
   request exactly once with the new JWT.
3. On a second **401**: clear auth state and perform a full-page redirect to
   `<VITE_AUTH_URL>/sign-in?redirect=<current absolute URL>`.

A hard page reload clears the in-memory cache; this triggers a single silent
re-fetch of `GET /auth/token` before the first authenticated request completes.
No user-visible action is required as long as the session cookie is still valid.

## Options considered

### Option A — JWT cached in module-scope memory (chosen)

The JWT lives only in the JavaScript heap of the current page. It is gone on tab
close or page reload.

**Pros:**
- XSS cannot exfiltrate the JWT to an external origin via `localStorage.getItem`
  or `sessionStorage.getItem` — the token is not reachable from arbitrary injected
  script once the module closure is established
- The session cookie (the durable credential) is already `HttpOnly`; in-memory JWT
  caching means no credential class is readable from script at rest
- Re-fetching on reload is a single cheap authenticated request; UX impact is
  imperceptible on a fast connection

**Cons:**
- Hard reload costs one extra network round-trip to `GET /auth/token` before the
  first API call
- In-memory state does not survive across tabs without a shared worker (not needed
  here; each tab independently re-fetches)

### Option B — JWT persisted in `localStorage`

**Pros:**
- Survives hard reloads and tab close/reopen without a network request
- Simpler retrieval logic (synchronous read, no async fetch on first use)

**Cons:**
- `localStorage` is readable by any JavaScript on the same origin; an XSS
  vulnerability (malicious ad, compromised npm dependency, DOM injection) can
  exfiltrate the JWT synchronously before any CSP or monitoring fires
- The JWT is an RS256-signed bearer credential; exfiltration gives an attacker
  server-recognized identity for the full JWT lifetime
- Rejected on security grounds

### Option C — JWT persisted in `sessionStorage`

**Pros:**
- Scoped to the browser tab; does not persist across tab close

**Cons:**
- Still readable from script on the same origin via `sessionStorage.getItem` —
  the XSS exfiltration attack is identical to Option B
- Marginally narrower blast radius (single tab) but provides no meaningful
  additional protection for an attacker who has already achieved script execution
- Rejected on the same security grounds as Option B

## Consequences

**Positive:**
- The XSS-exfiltration surface for the JWT is eliminated; an attacker with script
  execution can call `fetch('/auth/token')` themselves but cannot silently harvest
  a pre-existing stored token
- The auth interceptor logic is straightforward: one async in-memory getter with a
  refresh-retry circuit
- Future JWT lifetime changes (shorter, or per-request rotation) are absorbed by
  the refresh-retry protocol with no storage migration required

**Negative / trade-offs:**
- Every cold page load incurs one `GET /auth/token` request before the first
  authenticated API call completes; this adds one RTT of latency on initial render
  of authenticated content
- Multi-tab isolation: each tab maintains its own JWT cache; a forced revocation
  (e.g. sign-out in another tab) is detected only on the next 401, not proactively
  (acceptable given the session cookie is the authoritative credential)

**Risks:**
- **Production cookie-domain misalignment (plan risk 2):** If the Vercel UI domain
  (`estimai.operai.io`) and the auth service domain (`auth.operai.io`) cannot share
  a registrable parent domain, the `SameSite=None; Secure` cookie required for
  credentialed cross-origin `GET /auth/token` calls may be blocked by browsers
  enforcing third-party cookie restrictions. Mitigation: decide production hostnames
  before implementation ends. Fallback: bearer-only mode where the JWT is held in
  memory and re-login is required on hard refresh (degrades UX, not security).
- **JWT/session lifetime drift:** The JWT lifetime and session TTL are both 7 days
  today, but the session TTL refreshes on activity while a cached in-memory JWT does
  not. The refresh-retry interceptor absorbs any future divergence; this path must
  be covered by unit tests.

## Compliance notes

- GDPR/nLPD impact: low — keeping the JWT out of persistent storage reduces the
  data footprint retained on user devices; no personal data is written to disk as a
  result of this decision
- Data residency: not applicable (client-side only)
- Audit trail: not required for this decision

---

*This ADR was generated during a cc-sdd session. Review and amend before committing.*
