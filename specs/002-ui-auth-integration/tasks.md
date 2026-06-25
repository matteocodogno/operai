---
spec: 002
generated: 2026-06-07
---

# Tasks: Auth integration in estimai-ui

> Synced 2026-06-07 against spec.md: the only spec change was the status
> transition `approved → in-progress` (no story/AC changes) — task list verified
> unchanged, 13/13 ACs still covered.

BE track (T1–T3) and FE track (T4–T8) have no mutual deps and may run in parallel.

- [x] T1: Serve hosted sign-in page with Google/GitHub buttons — refs: US-2, AC-2.1 — deps: none
  - touch: `auth/src/signin/signin.routes.ts` (new), `auth/src/index.ts`
  - done when: bun test asserts `GET /sign-in` returns 200 HTML containing both a
    Google and a GitHub sign-in control, each wired to `POST /auth/sign-in/social`
    with the matching provider; page uses Operai design tokens (DM Sans/Syne, dark
    ink, purple accent)

- [x] T2: Validate `redirect` param and wire post-login return — refs: US-1, AC-1.2, AC-1.3 — deps: T1
  - touch: `auth/src/signin/signin.routes.ts`, `auth/src/lib/env.ts`, `auth/.env.example`
  - done when: bun tests assert (a) a `redirect` whose origin is in
    `ALLOWED_ORIGINS` is passed through as the OAuth `callbackURL`, (b) a foreign
    or missing `redirect` falls back to `UI_HOME_URL`, (c) `UI_HOME_URL` is
    validated at startup like every other env var

- [x] T3: Render OAuth failure banner with retry — refs: US-2, AC-2.3 — deps: T1
  - touch: `auth/src/signin/signin.routes.ts`
  - done when: bun test asserts `GET /sign-in?error=<code>` renders a
    human-readable message and both provider buttons remain present and active

- [ ] T4: Set up vitest in estimai-ui — refs: enabling infra for AC-3.1, AC-4.1 (unit ACs) — deps: none
  - touch: `estimai-ui/package.json`, `estimai-ui/vite.config.ts` (or `vitest.config.ts`)
  - done when: `pnpm test` runs vitest and a trivial sample test passes locally

- [ ] T5: Add auth client and environment config — refs: US-2, AC-2.2 — deps: none
  - touch: `estimai-ui/src/lib/authClient.ts` (new), `estimai-ui/.env.example` (new), `estimai-ui/package.json`
  - done when: with the auth service running locally and a signed-in session,
    `authClient.getSession()` resolves the user; `VITE_AUTH_URL` is read from
    `import.meta.env` with no hardcoded URL in source

- [ ] T6: Implement JWT cache + apiFetch interceptor — refs: US-3, US-4, AC-3.1, AC-3.2, AC-4.1 — deps: T4, T5
  - touch: `estimai-ui/src/lib/api.ts` (new), `estimai-ui/src/lib/api.test.ts` (new)
  - done when: vitest asserts (a) `apiFetch` attaches `Authorization: Bearer <jwt>`
    to every request, (b) on 401 it re-fetches `/auth/token` once and retries,
    (c) on second 401 it redirects to the sign-in URL with the current location as
    `redirect`; integration test verifies a real `/auth/token` JWT against the
    JWKS endpoint and that its `sub`/`email` match the session user

- [ ] T7: Guard all routes behind an `_authed` layout route — refs: US-1, AC-1.1 — deps: T5
  - touch: `estimai-ui/src/router.tsx`, `estimai-ui/src/router.test.tsx` (new)
  - done when: vitest asserts the layout `beforeLoad` redirects unauthenticated
    visitors to `<AUTH_URL>/sign-in?redirect=<current absolute URL>` for `/`,
    `/estimates`, `/estimates/$estimateId`, and `/share`, and renders nothing of
    the app before the session check resolves

- [ ] T8: Add UserMenu with sign-out to the app header — refs: US-5, AC-5.1, AC-5.2 — deps: T5
  - touch: `estimai-ui/src/components/UserMenu.tsx` (new), `estimai-ui/src/components/Header.tsx`, `estimai-ui/src/EstimatorApp.tsx`, `estimai-ui/src/pages/EstimatesPage.tsx`
  - done when: component test asserts UserMenu renders the `user` prop's
    name/avatar and calls `onSignOut` on click; UserMenu receives data only via
    props (no computation/fetching inside, per project convention); sign-out
    invokes `authClient.signOut()` then redirects to the sign-in page

- [ ] T9: Set up Playwright e2e with seeded-session helper — refs: enabling infra for AC-1.1 (e2e ACs) — deps: T2, T6, T7
  - touch: `estimai-ui/e2e/` (new), `estimai-ui/package.json`, helper that seeds a
    better-auth session against the local auth service
  - done when: `pnpm e2e` runs Playwright against the locally running UI + auth
    service and a smoke test signs in via the seeded session and loads the
    estimates list

- [ ] T10: e2e — login wall and post-login return — refs: US-1, US-2, AC-1.1, AC-1.2, AC-1.3, AC-2.2 — deps: T9
  - touch: `estimai-ui/e2e/login-wall.spec.ts` (new)
  - done when: e2e asserts (a) anonymous visits to `/`, `/estimates`, and `/share`
    land on the sign-in page with zero app content rendered, (b) signing in from a
    deep-link redirect returns to that page, (c) opening sign-in directly lands on
    home after login, (d) the session survives a full page reload

- [ ] T11: e2e — 401 round trip, work survival, identity, sign-out — refs: US-4, US-5, AC-4.1, AC-4.2, AC-4.3, AC-5.1, AC-5.2 — deps: T8, T9
  - touch: `estimai-ui/e2e/session-expiry.spec.ts` (new)
  - done when: e2e asserts (a) an expired/invalidated session causes the next API
    call to redirect to sign-in, (b) re-login returns to the page the user was on,
    (c) estimate edits made before the redirect are intact after re-login,
    (d) the header shows the signed-in user's name/avatar, (e) sign-out ends the
    session and any navigation redirects to sign-in

- [ ] T12: Manual QE pass — live OAuth round trips — refs: US-2, AC-2.2, AC-2.3 — deps: T3, T8
  - touch: `specs/002-ui-auth-integration/qe-checklist.md` (new)
  - done when: the checklist (real Google sign-in, real GitHub sign-in,
    abandoned/denied OAuth showing the error banner and allowing retry) is
    executed against the locally running stack and each item is recorded
    pass/fail with date and tester

- [ ] T13: Close out — gates green, spec done — refs: closing task — deps: T1–T12
  - touch: `specs/002-ui-auth-integration/spec.md`
  - done when: `pnpm lint` and `pnpm build` pass in estimai-ui, `bun run typecheck`
    and bun tests pass in auth, vitest and Playwright suites pass, every task
    above is checked, and spec 002 status is set to `done`
