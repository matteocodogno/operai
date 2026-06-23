# 0002 — Sign-in page hosted centrally by the auth service

**Date:** 2026-06-07  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai — EstimAI

---

## Context

Spec 002 requires a sign-in/up page offering Google and GitHub OAuth. Operai is a
multi-tool suite — EstimAI is the first tool, with ReviewAI, RetroAI, and ProposAI
planned. Each tool is a separate frontend (separate Vite/React application, separate
deploy). The auth service (Bun + Hono, better-auth) is the single identity provider
for the entire suite.

A sign-in page must exist before any tool can establish a user session. The question
is where that page lives: embedded in each frontend, or served once by the auth
service.

The auth service already owns the OAuth provider configuration (Google, GitHub
credentials, `callbackURL` routing) and the session lifecycle. Adding more OAuth
providers or changing provider settings in the future is a single-service change.

## Decision

We will serve the sign-in page from the auth service as a server-rendered HTML
response at `GET /sign-in` (Hono JSX). The page renders in the Operai design system
(DM Sans, DM Mono, Syne typefaces; dark ink palette; purple AI accent) and offers
"Continue with Google" and "Continue with GitHub" buttons.

The endpoint must:

- Accept an optional `?redirect=<absolute-url>` query parameter. The origin of the
  value must be present in the `ALLOWED_ORIGINS` environment variable; any value
  failing that check is silently discarded and `UI_HOME_URL` is used as the
  post-login destination. This closes the open-redirect attack vector.
- Accept an optional `?error=<code>` query parameter. When present, a human-readable
  error banner is rendered above the OAuth buttons; both buttons remain active for
  retry (AC-2.3). The error codes are those better-auth appends to the callback URL
  on OAuth failure.
- Each OAuth button posts to the existing better-auth endpoint
  `POST /auth/sign-in/social` with `{ provider, callbackURL }` via a minimal inline
  script, then follows the returned OAuth `url` for the provider redirect.

Frontend applications (starting with `estimai-ui`) redirect unauthenticated visitors
to `<VITE_AUTH_URL>/sign-in?redirect=<current absolute URL>` and require no OAuth
UI logic of their own.

The implementation lives in a new `src/signin/` feature directory in the auth
service, following the existing routes-by-feature convention.

## Options considered

### Option A — Sign-in page hosted by the auth service (chosen)

One centrally-served HTML page handles sign-in for every Operai tool.

**Pros:**
- Adding or removing an OAuth provider (or updating provider credentials) is a
  single change in the auth service, immediately reflected for all tools
- No duplication of OAuth button logic, redirect-validation logic, or Operai design
  system assets across N frontend projects
- The auth service is the natural owner of sign-in UI: it already owns the session
  cookie, the provider config, and the `callbackURL` routing
- Consistent branding across the suite is structurally guaranteed — there is only
  one page to keep up to date
- Frontend bundles stay free of OAuth UI code; the route guard reduces to a redirect

**Cons:**
- The auth service gains a small HTML-serving responsibility that goes slightly
  beyond a pure API service boundary
- Hono JSX server-rendering is a new pattern in the codebase; the team must keep it
  consistent with the existing routes-by-feature structure
- The page must be styled to match the Operai design system without relying on the
  Vite/Tailwind pipeline used by the frontends; CSS must be inlined or served as a
  static asset

### Option B — Sign-in page embedded in each frontend (estimai-ui first)

Each Vite/React application renders its own sign-in route.

**Pros:**
- Fits naturally into the existing React/TanStack Router setup; styled with the same
  Tailwind pipeline as the rest of the UI
- No new server-rendering pattern in the auth service

**Cons:**
- OAuth provider buttons, redirect-validation logic, and `?error=` handling must be
  duplicated in every future Operai tool (ReviewAI, RetroAI, ProposAI)
- Provider or credential changes require coordinated updates across all frontend
  projects and their separate deploys
- The auth service's `callbackURL` must be parameterised per frontend, making
  provider configuration more complex
- Rejected because the duplication cost grows with each new tool and the auth
  service already owns the full sign-in context

## Consequences

**Positive:**
- A single sign-in page serves the entire Operai suite; future tools are connected
  by adding their origin to `ALLOWED_ORIGINS` and pointing their route guard at
  `<AUTH_URL>/sign-in`
- Provider changes (credential rotation, adding a third provider) are one-service,
  one-deploy operations
- Frontend applications contain no OAuth UI code and are simpler to test in
  isolation (the route guard is a pure redirect, mockable without a real OAuth flow)
- Open-redirect protection is centralised once; no per-frontend implementation risk

**Negative / trade-offs:**
- The auth service is no longer a pure JSON API; it now serves HTML for at least one
  route. This is an intentional and bounded exception — the `src/signin/` directory
  is isolated and the rest of the service remains API-only
- CSS for the sign-in page cannot use the Tailwind 4 pipeline from `estimai-ui`;
  styles must be authored separately (inlined `<style>` block or a static CSS file
  served by Hono). The Operai design tokens (colours, font stacks) must be kept in
  sync manually with any future design-system updates

**Risks:**
- **Design drift:** If the Operai design system evolves (new accent colour,
  typography update), the auth service's sign-in page must be updated separately
  from the frontend projects. Mitigation: treat the sign-in page CSS as part of the
  Operai design-system changelog; update it alongside any frontend design token
  changes.
- **CSP and asset delivery:** Hono JSX with inline scripts must be compatible with
  the Content Security Policy applied to the auth service. The OAuth redirect script
  is a `<script>` block; a nonce-based CSP must include it, or it must be moved to
  a served static file. Assess during implementation.

## Compliance notes

- GDPR/nLPD impact: low — the sign-in page does not persist user data; it is a
  stateless HTML response that initiates an OAuth handoff. Session state is managed
  by better-auth's existing `session` table, already in scope
- Data residency: CH/EU compliant — the auth service is deployed to an EU region
  (Railway EU); the sign-in page is served from the same host
- Audit trail: not required for the sign-in page itself; better-auth logs session
  creation events at the session table level

---

*This ADR was generated during a cc-sdd session. Review and amend before committing.*
