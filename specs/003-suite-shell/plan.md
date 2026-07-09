---
spec: 003
status: approved
---

# Plan: Operai suite shell (Module Federation)

## Architecture

A frontend-only feature. No backend, database, or API-contract changes: the `auth`
service, `estimai-api`, and every reused endpoint stay exactly as they are. What changes
is how the frontends are composed and where cross-cutting concerns (session, chrome)
live.

### New / touched components

| Component | Change |
|---|---|
| `shell/` (new Vite host app) | Owns the shared chrome (header/sidebar/footer), the single session guard, and tool navigation. Loads each tool as a runtime-federated remote. Exposes a shared session/runtime module to the remotes. |
| `estimai-ui/` (existing → becomes a remote) | Exposes its app as a federated module; drops its own auth guard and suite-level chrome (header logo/About/avatar/theme); keeps tool-level UI (My Estimates nav, save-status). Consumes the shell's session module. Keeps a dev/test-only standalone bootstrap. |
| `refund-ui/` (new stub remote) | Minimal placeholder tool exposed as a federated module; consumes the shell session; proves a second independently-built/deployed remote. |
| `auth` service | No code change; add the shell's origin to `ALLOWED_ORIGINS` (config only). |
| `estimai-api` | No change. |

### Topology (the shape, and why)

**Host-owns-chrome-and-session; remotes are path-mounted self-contained apps.**

- The **shell host** runs one TanStack Router. A pathless `_authed` guard resolves the
  session **once** (reusing the exact `authClient.getSession()` → redirect-to-hosted-sign-in
  pattern from `estimai-ui/src/router.tsx`, ADR-0002). Inside the guard it renders the
  chrome and a catch-all route per tool (`/estimai/*`, `/refund/*`) that lazily loads the
  remote's exposed component and mounts it in the content area.
- Each **remote** exposes a root component that runs **its own inner router configured with
  a `basepath`** (`/estimai`, `/refund`). The remote does **not** run an auth guard and does
  **not** render suite chrome — the shell guarantees a session before mounting and owns the
  chrome. This keeps `estimai-ui`'s internal routing (list ↔ editor ↔ share) almost
  unchanged (rebased under a prefix), minimizing regression surface (AC-4.1).
- Rejected alternative — *host statically composes remote route subtrees into one router*:
  TanStack Router needs its route tree statically known at build time; composing routes
  across a federation boundary fights that and couples builds. Rejected.
- Rejected alternative — *separate SPAs + shared UI package* (no federation): explicitly
  overruled by the user in favor of Module Federation (see Constraints / ADR-0006).

### Module Federation mechanics

- **Plugin:** `@module-federation/vite` (the Module Federation team's official Vite plugin,
  MF2 runtime) rather than `@originjs/vite-plugin-federation` — it has active React 19 /
  modern-Vite support and a runtime API for dynamic remotes and error handling (needed for
  US-6). **Vite 8 compatibility is an explicit early risk — see Risks R1.**
- **Shared singletons** (MF `shared`, `singleton: true`, `requiredVersion` from each
  package.json): `react`, `react-dom`, `@tanstack/react-router`, `better-auth`. A second
  React copy across the boundary breaks hooks/context, so single-instance is mandatory and
  asserted in the walking-skeleton task.
- **Shared session/runtime singleton:** the shell **exposes** `shell/session` — the
  in-memory-JWT `apiFetch`, `authClient` wrappers (`getSession`/`useSession`/`signOut`), and
  the trusted-origin Bearer guard — extracted from the current `estimai-ui/src/lib/api.ts` +
  `authClient.ts`. Remotes import `shell/session` instead of holding their own copy, so the
  ADR-0001 in-memory JWT is cached **once** for the whole suite and sign-out clears it
  suite-wide (AC-2.3, AC-2.4). This makes the host↔remote graph bidirectional (host consumes
  remote apps; remotes consume `shell/session`), which MF2 supports.
  - *Lower-effort fallback if bidirectional init proves fiddly:* each remote keeps its own
    `apiFetch`. Correctness holds (same cookie → same token) but sign-out only guarantees the
    cookie is gone; a remote's already-cached JWT stays valid until expiry (the accepted
    "no revocation at resource server" tradeoff, ADR-0005). Recommended target is the shared
    singleton; fallback is documented so it is a decision, not a surprise.
- **Design tokens (AC-1.3):** the DM Sans/DM Mono/Syne fonts + Tailwind 4 `@theme` tokens +
  CSS variables currently in `estimai-ui/src/index.css` are extracted to a single shared
  tokens stylesheet imported by the shell and every remote, so chrome and remotes render in
  one design system. (Exact packaging resolved at the design stage.)

### Chrome ownership (AC-4.2, resolved open questions)

- **Shell header:** suite logo, About dropdown/dialog, user avatar/menu (+ sign-out), theme
  toggle. These move out of `estimai-ui`'s `Header`/`UserMenu`/`LogoMenu`/`AboutModal` into
  the shell (largely a lift-and-shift of components built in the recent EstimAI header work).
- **Shell footer:** legal link, version, company info (AC-1.5).
- **Shell sidebar:** tool switcher listing EstimAI + Refund, active tool indicated (US-3).
- **Stays in EstimAI:** the "My Estimates" navigation and the save-status indicator (they are
  tool-scoped, not suite-scoped).

### Deploy (Vercel)

Three independent Vercel projects: `shell`, `estimai-ui`, `refund-ui`. Each remote publishes
a `remoteEntry.js` + assets; the shell is configured with each remote's URL **per environment**
(preview/prod) via env vars and MF's dynamic-remote runtime, so a remote can be redeployed
without rebuilding the shell or the other remotes (AC-5.3). `estimai-ui`'s former standalone
URL is repointed (redirect/rewrite) into the shell so the shell is the single entry point
(AC-4.3). Remote origins must send permissive CORS for `remoteEntry.js`, be added to the
shell CSP, be added to `auth`'s `ALLOWED_ORIGINS`, and be included in the `apiFetch`
trusted-origin allowlist.

### New ADR required

**ADR-0006 — Operai suite frontend composition via Module Federation.** Captures: MF chosen
over separate-SPAs+shared-package (per Constraints); `@module-federation/vite` + MF2; the
host-owns-chrome/session, remotes-as-path-mounted-apps topology; shared-singleton strategy
(React et al. + the `shell/session` JWT singleton); and the per-env dynamic-remote deploy
model. This ADR governs how every future Operai tool (refund-ui and beyond) joins the suite.
_I'll offer to invoke the adr-writer agent to draft it._

## Data model

No changes. No new tables, no migrations. Identity/session remain owned by `better-auth`
in the `auth` service; the shell reuses the existing session cookie + `GET /auth/token` +
JWKS. Roles/groups are a **separate spec** and explicitly out of scope here.

## API contracts

No new or changed REST endpoints. The relevant contracts are the **federation module
contract** and the **reused auth endpoints**.

### Federation contract (sketch)

```
shell (host)
  remotes:  estimai → <ESTIMAI_REMOTE_URL>/remoteEntry.js
            refund  → <REFUND_REMOTE_URL>/remoteEntry.js
  exposes:  ./session        # apiFetch, authClient wrappers, JWT singleton, trusted-origin guard
            ./tokens.css      # shared design tokens (or a shared import target)
  shared:   react, react-dom, @tanstack/react-router, better-auth  (singleton: true)

estimai-ui (remote)
  exposes:  ./App             # root component; inner TanStack Router with basepath '/estimai'; no auth guard, no chrome
  consumes: shell/session, shell tokens
  shared:   (same singletons)

refund-ui (remote)
  exposes:  ./App             # placeholder page; basepath '/refund'
  consumes: shell/session, shell tokens
  shared:   (same singletons)
```

Remote URLs are environment variables resolved at runtime (not build-baked) so previews and
prod point at the right remote deploys.

### Reused auth endpoints (unchanged)

- `GET <AUTH_URL>/sign-in?redirect=<abs-url>` — hosted sign-in (ADR-0002); shell guard
  redirects here when `getSession()` is empty.
- `authClient.getSession()` / `useSession()` — session resolution (cookie-based).
- `GET <AUTH_URL>/auth/token` — cookie-authenticated RS256 JWT; cached in-memory (ADR-0001)
  now in the shared `shell/session` module.
- `authClient.signOut()` — suite-wide sign-out; clears the shared JWT cache + redirects.
- Resource servers (`estimai-api`) keep verifying via `<AUTH_URL>/auth/jwks` (ADR-0005),
  no change.

## Test strategy

Every spec AC maps to at least one test level. Shell unit/component tests use Vitest +
Testing Library (mirroring `estimai-ui`); cross-app behavior uses Playwright with the
existing seeded-session helper (`e2e/helpers/seedSession.ts`).

| AC | Level | Test |
|---|---|---|
| AC-1.1 chrome present | component | Shell layout renders header + sidebar + footer around an `<Outlet/>` |
| AC-1.2 chrome persists on tool switch | e2e | Switch `/estimai`↔`/refund`; assert header/sidebar DOM nodes are not remounted (stable node identity) and no full reload |
| AC-1.3 design consistency | e2e + design review | Remotes render with shared fonts/palette; visual check at design stage; unit: shared tokens stylesheet is imported by remote entry |
| AC-1.4 header contents | component | Shell `Header` shows logo, About control, avatar/menu, theme toggle |
| AC-1.5 footer contents | component | Shell `Footer` shows legal link, version, company info |
| AC-2.1 unauth → sign-in | integration | Shell `_authed` guard: no session → redirect to `<AUTH_URL>/sign-in?redirect=…` (mirror `estimai-ui` router.test) |
| AC-2.2 authed calls succeed | e2e | Seeded session → open EstimAI → an authenticated `estimai-api` call succeeds with no sign-in prompt |
| AC-2.3 remote no own redirect | integration | Mount `estimai` remote with a present session; assert remote performs no sign-in redirect; unit: remote router has no `_authed` guard |
| AC-2.4 suite-wide sign-out | e2e | Seeded session → sign out in shell → `getSession()` is null and a subsequent authed call is rejected (mirror spec 002 AC-5.2) |
| AC-2.5 session persists on reload | e2e | Seeded session → reload → still authenticated |
| AC-3.1 sidebar lists tools + active | component | Shell `Sidebar` lists EstimAI + Refund; active item marked from the route |
| AC-3.2 select tool, URL reflects, reload-safe | e2e | Click a tool → content swaps, URL updates, reload lands on same tool |
| AC-3.3 deep-link to a tool | e2e / integration | Load `/refund` (and `/estimai/estimates/:id`) directly → correct tool shown first paint |
| AC-4.1 EstimAI no regression | regression | Existing `estimai-ui` Vitest + Playwright suites pass against the migrated app (standalone dev bootstrap + inside shell) |
| AC-4.2 no duplicated chrome | component | `estimai-ui`: `EstimatorApp` no longer renders header logo/About/avatar/theme; shell provides them |
| AC-4.3 standalone URL → shell | integration/deploy | Old EstimAI URL redirects into the shell (config assertion / e2e) |
| AC-5.1 refund entry present | component | Shell `Sidebar` includes a Refund entry |
| AC-5.2 refund placeholder authed | e2e | Seeded session → select Refund → placeholder renders; unauthenticated → no content |
| AC-5.3 independent redeploy | integration/CI | Rebuild only `refund-ui`; shell picks up new `remoteEntry.js` without an EstimAI/shell rebuild (separate build outputs + runtime remote URL) |
| AC-6.1 failing tool graceful | integration | Force a remote-load failure (bad remote URL / MF runtime error) → shell shows an error state in the content area; chrome + other tool still work |

An AC with no row here is a plan bug — none remain.

## Risks

- **R1 — Vite 8 + `@module-federation/vite` compatibility (highest).** Vite 8 is very new;
  MF plugin support may lag. *Early check:* the **first task is a walking skeleton** — shell
  host + one trivial remote + shared React singleton building and running on the pinned Vite
  8. If it fails: pin Vite to the latest MF-supported minor for the shell/remotes, or switch
  to `@originjs/vite-plugin-federation`. This gate must pass before the EstimAI migration
  starts.
- **R2 — Duplicate React/singleton skew.** Two React instances break hooks/context.
  Mitigation: `shared singleton` + assert `React` identity in the skeleton; CI check that the
  shared graph resolves one copy.
- **R3 — TanStack Router host/remote history coordination.** Nested routers with `basepath`
  can fight over `history`/URL, breaking deep-linking (AC-3.2/3.3). Mitigation: host owns
  browser history; remotes use `basepath` against the same history; validate deep-link +
  reload in the skeleton before wider work.
- **R4 — EstimAI regression during migration (AC-4.1).** Removing its guard/chrome and
  rebasing routing is invasive. Mitigation: keep a standalone dev/test bootstrap so the full
  existing Vitest + Playwright suites keep running; migrate in small steps; the suites are the
  regression gate.
- **R5 — Cross-origin remote loading (CORS/CSP) + token-origin allowlist.** Loading
  `remoteEntry.js` cross-origin and attaching Bearer tokens needs CORS on remotes, remote
  origins in the shell CSP, in `auth` `ALLOWED_ORIGINS`, and in the `apiFetch`
  trusted-origin guard. Mitigation: enumerate all origins per env up front; add to each
  allowlist; covered by the security pass (below).
- **R6 — Vercel multi-project remote-URL wiring.** Wrong per-env remote URLs → shell loads
  stale/missing remotes. Mitigation: runtime env-injected remote URLs (not build-baked);
  verify preview and prod resolve independently.
- **R7 — Session cookie across shell/remote origins.** If shell and remotes/auth are on
  origins that cannot share the session cookie, credentialed `GET /auth/token` may be blocked
  (same class as ADR-0001 risk 2). Mitigation: decide production hostnames (shared registrable
  parent) before implementation ends.

## Security

**Security-sensitive: YES.** This feature is the authentication/session boundary for the
whole suite and introduces cross-origin runtime code loading. Sensitive aspects:

- **Runtime loading of remote code** (`remoteEntry.js`) — a compromised or misconfigured
  remote origin means arbitrary script execution in the shell (supply-chain surface). Requires
  a pinned CSP allowlist of remote origins and integrity discipline.
- **Bearer token / in-memory JWT handling** moves into the shared `shell/session` module —
  the trusted-origin guard (ADR-0001) must be preserved and extended to the new origins.
- **Single sign-out correctness** (AC-2.4) and **open-redirect** protection on the shell
  guard's `redirect` param (ADR-0002 allowlist) must hold.
- Reuses RS256 JWT / JWKS (ADR-0005) unchanged.

Per the WellForge convention, a **YES** schedules an **owasp-reviewer pass in parallel with
QE**. Focus: CSP/remote-origin pinning, token-origin allowlist, sign-out completeness,
open-redirect on the guard, and CORS posture on remote entries.
