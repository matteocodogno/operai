---
spec: 003
generated: 2026-07-09
---

# Tasks: Operai suite shell (Module Federation)

Three tracks fan out after the federation skeleton (T2, the R1 gate):
**shell-chrome** (T3–T11), **estimai-migration** (T12–T14), **refund-stub** (T15) —
they converge at the e2e gate (T16). Deploy/security/regression/close follow.

- [ ] T1: Scaffold the `shell/` host app (Vite 8, React 19, TanStack Router, Tailwind 4) — refs: AC-1.1 (enabler) — deps: none
  - touch: `shell/` (new: package.json, vite.config.ts, tsconfig, src/main.tsx, src/index.css, eslint/prettier mirrored from estimai-ui)
  - done when: `pnpm --dir shell build` and `pnpm --dir shell dev` both succeed and serve a bare page

- [ ] T2: Federation walking skeleton — **R1 GATE** — refs: AC-5.3, AC-6.1 (federation mechanism) — deps: T1
  - touch: `shell/vite.config.ts` (@module-federation/vite host), a minimal throwaway/seed remote, `shell/src` mount point
  - done when: the shell loads a remote's exposed component at runtime AND a test/log asserts a single shared React instance (no duplicate). If this fails on Vite 8, apply the plan's R1 fallback (pin Vite or switch plugin) and record it. **Blocks T12/T15.**

- [ ] T3: Extract shared design tokens into `tokens.css` (DM Sans/DM Mono/Syne, CSS vars, Tailwind `@theme`) — refs: AC-1.3 — deps: T1
  - touch: `estimai-ui/src/index.css` (source), new shared tokens stylesheet exposed by `shell` (`./tokens.css`), imported by shell
  - done when: the shell renders with the Operai fonts/palette from the shared token file (no visual divergence from EstimAI)

- [ ] T4: Extract the shared session runtime → `shell/session` (apiFetch, authClient wrappers, in-memory JWT singleton, trusted-origin guard) — refs: AC-2.2, AC-2.4 (ADR-0001) — deps: T2
  - touch: `estimai-ui/src/lib/api.ts` + `authClient.ts` (source of truth), new `shell/src/lib/session.ts` exposed via MF; port the existing api unit tests
  - done when: ported unit tests pass for the refresh-retry circuit and the trusted-origin Bearer guard; the module is exposed as `shell/session`

- [ ] T5: Shell layout (header/sidebar/content/footer regions, landmark roles, skip-to-content link), desktop-only — refs: AC-1.1 — deps: T1, T3
  - touch: `shell/src/components/ShellLayout.tsx`
  - done when: a component test asserts `banner`/`nav`/`main`/`contentinfo` landmarks, a skip-to-content link, and an `<Outlet/>` content region render

- [ ] T6: Relocate header chrome into the shell — LogoMenu, UserMenu, ThemeToggle (extracted), AboutModal + suite-level `appInfo` — refs: AC-1.4 — deps: T4, T5
  - touch: `shell/src/components/{LogoMenu,UserMenu,ThemeToggle,AboutModal}.tsx`, `shell/src/lib/appInfo.ts`, `shell/src/hooks/useTheme.ts`
  - done when: ported component tests pass; header shows suite logo, About dropdown/dialog, avatar/menu (+ sign-out via `shell/session`), theme toggle; About shows the suite (Operai) name/version

- [ ] T7: Sidebar / tool switcher (EstimAI + Refund; active via route; roving-tabindex + arrow keys; `aria-current`) — refs: AC-3.1, AC-5.1 — deps: T5, T9
  - touch: `shell/src/components/Sidebar.tsx`
  - done when: a component test asserts both tool entries, the active item marked from the route, and arrow-key/roving-tabindex keyboard navigation

- [ ] T8: Shell footer (legal link, version, company info; normal document flow) — refs: AC-1.5 — deps: T5
  - touch: `shell/src/components/Footer.tsx`
  - done when: a component test asserts the legal link, version string, and company info; footer is not `position: fixed`

- [ ] T9: Shell router + pathless `_authed` session guard + tool routes `/estimai/*`, `/refund/*` mounting remotes; chrome stays mounted across switches — refs: AC-1.2, AC-2.1, AC-2.5, AC-3.2, AC-3.3 — deps: T4, T5, T11
  - touch: `shell/src/router.tsx`, `shell/src/main.tsx`
  - done when: guard-redirect test (no session → `<AUTH_URL>/sign-in?redirect=…`, ported from estimai-ui router.test); deep-link to `/refund` and `/estimai/...` resolves the right tool first paint; switching tools does not remount the chrome

- [ ] T10: Root-landing redirect — `/` → most-recently-used tool (`localStorage['operai_last_tool']`, fallback EstimAI); write the key on each tool switch — refs: AC-3.4 — deps: T9
  - touch: `shell/src/router.tsx` (root `beforeLoad`), sidebar/route change handler
  - done when: integration test — no key → lands on EstimAI; key set to `refund` → lands on Refund

- [ ] T11: Content-area remote boundary — loading state + error boundary/failed state + retry (MF runtime error handling) — refs: AC-6.1 — deps: T2
  - touch: `shell/src/components/RemoteMount.tsx` (or equivalent boundary)
  - done when: integration test — a forced remote-load failure shows an in-place error + retry while chrome and the other tool stay usable; a loading state renders while resolving

- [ ] T12: Expose `estimai-ui` as a federated remote — MF config, expose `./App`, rebase inner TanStack Router to `basepath: '/estimai'`, keep a dev/test-only standalone bootstrap — refs: AC-4.1 — deps: T2
  - touch: `estimai-ui/vite.config.ts`, `estimai-ui/src/router.tsx`, a new remote entry + retained standalone `main.tsx`
  - done when: `estimai-ui` builds a `remoteEntry.js`; the standalone dev bootstrap still runs; the existing test suite passes

- [ ] T13: `estimai-ui` consumes `shell/session` and drops its own `_authed` guard/redirect — refs: AC-2.3, AC-4.1 — deps: T4, T12
  - touch: `estimai-ui/src/router.tsx` (remove guard), `estimai-ui/src/lib/api.ts`/`authClient.ts` (delegate to `shell/session`)
  - done when: mounted with a present session, the remote performs no sign-in redirect of its own; unit asserts the remote router has no `_authed` guard

- [ ] T14: EstimAI chrome dedup (AC-4.2) — remove `LogoMenu`/`UserMenu`/theme from `EstimatorApp`'s `Header`; remove logo + `UserMenu` from `EstimatesPage`; trim `SharedEstimatePage`'s logo; keep tool-scoped controls — refs: AC-4.2 — deps: T6, T12
  - touch: `estimai-ui/src/components/Header.tsx`, `pages/EstimatesPage.tsx`, `pages/SharedEstimatePage.tsx`
  - done when: component tests assert the suite-level controls are gone and tool-scoped ones (project name, save-status, My Estimates, Import/+New, read-only badge) remain; existing suites pass

- [ ] T15: Scaffold `refund-ui/` remote (Vite 8 + MF), consume `shell/session` + tokens, `basepath: '/refund'`, minimal authed placeholder screen — refs: AC-5.1, AC-5.2, AC-5.3 — deps: T2, T4
  - touch: `refund-ui/` (new app), expose `./App`, placeholder page
  - done when: `refund-ui` builds a `remoteEntry.js`; the placeholder renders only for a signed-in user when selected in the shell; a `refund-ui`-only rebuild changes its remote without rebuilding the shell/EstimAI

- [ ] T16: Cross-app e2e (Playwright, seeded session) — refs: AC-1.2, AC-1.3, AC-2.2, AC-2.5, AC-3.2, AC-3.3, AC-5.2, AC-6.1 — deps: T6, T7, T8, T9, T10, T11, T13, T14, T15
  - touch: `shell/e2e/*` (reuse `estimai-ui/e2e/helpers/seedSession.ts`)
  - done when: e2e green for: chrome persists on switch; remotes render in the shared design system; an authed backend call succeeds; session persists on reload; URL reflects tool + reload-safe + deep-link; refund placeholder authed-only; failing-tool graceful

- [ ] T17: Vercel deploy wiring — 3 projects; per-env runtime remote URLs; repoint EstimAI's standalone URL into the shell; add new origins to `auth` `ALLOWED_ORIGINS` + shell CSP + `apiFetch` trusted-origins — refs: AC-4.3, AC-5.3 — deps: T12, T15
  - touch: `shell/vercel.json`, `estimai-ui/vercel.json`, `refund-ui/vercel.json`, env config, `auth` `ALLOWED_ORIGINS` (config only)
  - done when: a preview deploy loads the shell + both remotes via per-env URLs; the old EstimAI URL redirects into the shell; a refund-only redeploy is reflected without rebuilding others

- [ ] T18: EstimAI regression gate — full `estimai-ui` Vitest + Playwright pass, standalone and in-shell — refs: AC-4.1 — deps: T14
  - touch: none (CI/verification)
  - done when: the entire existing EstimAI test suite passes against the migrated app in both bootstraps

- [ ] T19: owasp-reviewer pass (security = YES) — refs: AC-2.1, AC-2.3, AC-2.4 (security) — deps: T17
  - touch: none (review; fixes land as follow-up edits to the flagged files)
  - done when: owasp-reviewer verdict PASS (or all findings resolved) on: CSP/remote-origin pinning, token-origin allowlist, sign-out completeness, open-redirect on the guard's `redirect` param, CORS posture on `remoteEntry.js`

- [ ] T20: Close the feature — all gates green (QE PASS + fresh `eval-report.md` + owasp), then `/wellforge:done` flips spec status → done — refs: — (process) — deps: T16, T17, T18, T19
  - touch: `specs/003-suite-shell/` status
  - done when: `/wellforge:done` verifies the production done-gate and sets `status: done`
