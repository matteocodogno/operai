---
spec: 002
status: approved
---

# Plan: Auth integration in estimai-ui

## Architecture

Two surfaces change: **estimai-ui** gains an auth layer (session state, route
guard, HTTP client with interceptor, user menu), and **auth** gains a hosted
sign-in page. No other service is touched; no data model changes.

### estimai-ui (new auth layer)

The UI currently has no HTTP code at all, so the HTTP client is introduced by
this feature and every future backend call goes through it.

1. **`src/lib/authClient.ts`** — better-auth client (`createAuthClient` from
   `better-auth/react`) pointed at `VITE_AUTH_URL`. Provides `useSession()`
   (reactive user/session state), `signOut()`, and the token endpoint. Chosen
   over a hand-rolled client because the auth service IS better-auth — the
   client stays protocol-compatible across better-auth upgrades for free.
2. **JWT handling** — the RS256 JWT is fetched from the existing
   `GET /auth/token` (cookie-authenticated) and cached **in memory** (module
   scope), not in localStorage/sessionStorage: the 7-day session cookie is the
   durable credential; the JWT is a derived, re-fetchable artifact, and keeping
   it out of storage shrinks the XSS-exfiltration surface. Satisfies the
   "store the JWT" constraint (stored client-side, in memory).
3. **`src/lib/api.ts`** — `apiFetch(input, init)`: a thin `fetch` wrapper
   (the "interceptor"):
   - ensures a JWT is cached (fetches `/auth/token` if not), adds
     `Authorization: Bearer <jwt>`;
   - on **401**: drops the cached JWT, re-fetches `/auth/token` once (session
     may have outlived the JWT), retries the request once;
   - on second 401: clears auth state and redirects to the sign-in page with
     the current location as `redirect` param (AC-4.1/4.2).
   No axios — zero-dependency fetch wrapper matches the codebase's lean style.
4. **Route guard** — a new layout route `_authed` wrapping ALL existing routes
   (`/`, `/estimates`, `/estimates/$estimateId`, `/share`). Its `beforeLoad`
   resolves the session (better-auth `getSession`, cookie-based); if absent →
   full-page redirect to `<AUTH_URL>/sign-in?redirect=<current absolute URL>`.
   AC-1.1 demands *no app content* for anonymous visitors, which a layout-route
   guard guarantees structurally.
5. **`src/components/UserMenu.tsx`** — presentational (name/avatar + sign-out
   item), receives `user` and `onSignOut` as props per the "components don't
   compute" convention; rendered from the pages' headers. Sign-out calls
   `authClient.signOut()` then hard-redirects to the sign-in page (AC-5.2).
6. **Unsaved-work survival (AC-4.3)** — requires no new mechanism: edits are
   already written synchronously to localStorage on change
   (`lib/projects.ts:saveProjectData`), and the 401 redirect never clears
   localStorage. The e2e test pins this behaviour.
7. **Config** — `VITE_AUTH_URL` via `import.meta.env` (first env var in the UI);
   add `estimai-ui/.env.example` and a Vercel env var note.

### auth (hosted sign-in page — in scope per spec)

8. **`src/signin/` feature directory** (matches the routes-by-feature
   convention): `GET /sign-in` returns a server-rendered HTML page (Hono JSX)
   in the Operai design system (DM Sans/Syne, dark ink, purple accent) with
   "Continue with Google" / "Continue with GitHub" buttons. Each button posts
   to the existing better-auth endpoint `POST /auth/sign-in/social` with
   `{ provider, callbackURL }` via a small inline script and follows the
   returned OAuth `url`.
9. **Redirect-target validation** — `redirect` query param is accepted only if
   its origin is in `ALLOWED_ORIGINS` (reusing the validated env list);
   otherwise it falls back to a new `UI_HOME_URL` env var (EstimAI home —
   AC-1.3). This closes the open-redirect hole that a naive `redirect` param
   would create.
10. **OAuth failure display (AC-2.3)** — better-auth redirects back with
    `?error=<code>`; `/sign-in` renders a human-readable message above the
    buttons and keeps both buttons active for retry.
11. **Test-only session-mint endpoint** (amendment 2026-06-25, drift from T9) —
    the auth service gains a non-interactive endpoint that mints a session
    cookie for a seeded test user, used solely to make headless e2e possible
    (real OAuth cannot run headlessly). It is **hard-gated off in production**
    (`NODE_ENV !== 'production'`, and only enabled under an explicit
    `ENABLE_TEST_AUTH` flag); when the gate is off it does not exist (404/403).
    This adds **no** production attack surface and does **not** introduce a
    password sign-in path — production sign-in stays Google/GitHub OAuth only,
    preserving AC-2.1 and ADR-002. It is a test seam, not a product feature.

### Decisions worth an ADR (offer after approval)

- **ADR-001**: JWT stored in memory + refresh-on-401, never in web storage.
- **ADR-002**: sign-in UI hosted by the auth service (one page serves all
  future Operai tools), not duplicated per frontend.

## Data model

No changes. better-auth's existing tables (`user`, `session`, `account`,
`jwks`) already cover everything; the sign-in page is stateless.

## API contracts

All on the auth service. New:

```
GET /sign-in?redirect=<absolute-url>&error=<code>     → 200 text/html
  redirect: optional; origin must be ∈ ALLOWED_ORIGINS, else ignored
  error:    optional; when present an error banner is rendered
```

Existing better-auth endpoints consumed by the UI (no changes, documented as
the contract the interceptor relies on):

```
GET  /auth/get-session                  (cookie)  → 200 { user, session } | 200 null
GET  /auth/token                        (cookie)  → 200 { token: "<RS256 JWT>" }
                                                  → 401 Problem JSON (no session)
POST /auth/sign-in/social  { provider: "google"|"github", callbackURL }
                                                  → 200 { url: "<provider OAuth URL>" }
POST /auth/sign-out                     (cookie)  → 200 { success: true }
```

Error shape everywhere: RFC 7807 Problem JSON (already the service-wide
convention via `app.onError`).

UI-side interceptor contract: every `apiFetch` request carries
`Authorization: Bearer <jwt>`; 401 → refresh-retry once → redirect to
`/sign-in` with `redirect=<current URL>`.

## Test strategy

New tooling: **vitest** in estimai-ui (unit/component; first test runner in the
package — also a prerequisite for future quality gates), **bun test** in auth
(built-in), **Playwright** e2e against the locally running stack. Real-provider
OAuth cannot run headlessly in CI, and the auth service exposes no password
sign-up to mint a session non-interactively — so e2e obtains a session via a
**dev/test-only session-mint endpoint in the auth service** (gated off in
production, see Architecture item 11). The Playwright seeded-session helper
(`90f7d70`) calls that endpoint, takes the returned session cookie, and injects
it into the browser context before exercising the guarded app. The live
Google/GitHub OAuth round trip remains covered by the manual QE pass (T12), not
by automated e2e.

| AC | Behaviour | Level |
|---|---|---|
| AC-1.1 | anonymous visit → sign-in, no app content | unit (guard beforeLoad) + e2e |
| AC-1.2 | post-login → originally requested page | e2e (seeded session) |
| AC-1.3 | direct sign-in visit → home after login | unit (redirect fallback) + e2e |
| AC-2.1 | both providers offered | integration (bun test: GET /sign-in HTML contains both buttons) |
| AC-2.2 | OAuth completes, session survives reload | e2e (seeded) + manual QE with real providers |
| AC-2.3 | abandoned/failed OAuth → message + retry | integration (`?error=` renders banner) + manual QE |
| AC-3.1 | requests carry token header | unit (apiFetch injects Authorization) |
| AC-3.2 | token identifies correct user | integration (token from /auth/token verifies against JWKS, `sub`/`email` match session user) |
| AC-4.1 | 401 → redirect to sign-in | unit (interceptor: refresh-retry then redirect) |
| AC-4.2 | re-login → back to prior page | e2e (expire session, trigger 401, sign in, assert location) |
| AC-4.3 | unsaved work survives the round trip | e2e (edit → force 401 → re-login → assert estimate content) |
| AC-5.1 | header shows name/avatar | component (UserMenu renders user props) + e2e |
| AC-5.2 | sign-out ends session, app redirects | e2e |

Coverage check: 13/13 ACs mapped. ✓

## Risks

1. ~~Open sign-up~~ — **decided 2026-06-06**: intentional. Any Google/GitHub
   account may sign in; the wall provides identity, not access restriction.
   A domain allowlist remains a cheap future addition (better-auth hook) if
   the decision changes.
2. **Cross-origin cookies in production.** Locally (5173 ↔ 3001) credentialed
   CORS works; in production the Vercel UI domain and the auth service domain
   must allow third-party-cookie-free flows — i.e. share a registrable parent
   domain (e.g. `estimai.operai.io` + `auth.operai.io`) with
   `SameSite=None; Secure` (or `crossSubDomainCookies`).
   → Early check: decide production hostnames before implementation ends; if a
   shared parent is impossible, fall back to bearer-only (token in memory,
   re-login on hard refresh) — degrades UX, not security.
3. **Real-OAuth e2e is not automatable.** → Mitigated in the test strategy:
   seeded-session e2e + a scripted manual QE checklist for the live providers.
4. **JWT/session lifetime mismatch** (JWT 7d == session 7d today, but session
   TTL refreshes on activity while a cached JWT doesn't). → The refresh-retry
   interceptor absorbs any future divergence; unit-tested explicitly.
5. ~~/share behind the wall~~ — **decided 2026-06-06**: confirmed. `/share`
   stays behind login like every other route; recipients of share links must
   sign in (any Google/GitHub account suffices, per decision 1).
6. **Test-auth endpoint reachable in production = critical auth bypass**
   (amendment 2026-06-25). The dev/test session-mint endpoint (Architecture
   item 11) would let anyone mint a session for the seeded user if it ever
   shipped enabled — a complete authentication bypass.
   → Mitigation: hard environment gate (`NODE_ENV !== 'production'` AND explicit
   `ENABLE_TEST_AUTH`), plus an automated test asserting the endpoint returns
   404/403 when the gate is off. The owasp-reviewer must verify this gate when
   the endpoint lands.
