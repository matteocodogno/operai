# 0006 — Operai suite frontend composition via Module Federation

**Date:** 2026-07-09  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

Operai is becoming a multi-tool suite: EstimAI ships today, a reimbursement tool
("refund-ui") is next, and ReviewAI/RetroAI/ProposAI are planned. Today each tool is an
independent Vite/React SPA with its own header, its own sign-in redirect, and its own
entry point (`estimai-ui` today). As tools are added this fragments the product: users
have no single place to land, no consistent chrome, and would authenticate separately
per tool, and every new tool duplicates cross-cutting concerns (identity, session,
theme, navigation) instead of inheriting them.

Spec `specs/003-suite-shell` requires a single shell that owns the shared chrome and
the authenticated session and hosts each tool (AC-1.1–AC-1.5, AC-2.1–AC-2.5), a sidebar
to switch between tools with shareable, reload-safe URLs (AC-3.1–AC-3.3), EstimAI
running inside that shell with zero regression (AC-4.1–AC-4.3), a Refund stub proving
the pattern works for a second independently-built tool (AC-5.1–AC-5.3), and graceful
degradation when one tool fails to load (AC-6.1). This is a frontend-only feature: no
backend, database, or API-contract changes.

## Decision

We will compose the Operai suite frontends with **Module Federation**: a new **shell
host** application owns the shared chrome (header/sidebar/footer) and the single
authenticated session, and loads each tool as a runtime-federated **remote**.

**Topology — host-owns-chrome-and-session; remotes are path-mounted self-contained
apps.** The shell runs one TanStack Router with a pathless `_authed` session guard,
reusing `estimai-ui`'s existing `authClient.getSession()` → redirect-to-hosted-sign-in
pattern (ADR-0002), and a catch-all route per tool (`/estimai/*`, `/refund/*`) that
lazily mounts the remote's exposed root component. Each remote exposes a root component
running its **own** inner TanStack Router configured with a `basepath` (`/estimai`,
`/refund`), with **no** auth guard and **no** suite chrome of its own — the shell
guarantees a session exists before mounting a remote, and owns the chrome for the whole
suite.

**Plugin:** `@module-federation/vite` — the Module Federation team's official Vite
plugin (MF2 runtime) — over `@originjs/vite-plugin-federation`, chosen for active React
19 / modern-Vite support and a runtime API needed for graceful remote-load failure
(AC-6.1). Vite 8 compatibility with this plugin is new and unproven; it is an explicit
early risk gated by a walking-skeleton first implementation task, not assumed here (see
Risks).

**Shared singletons:** `react`, `react-dom`, `@tanstack/react-router`, and `better-auth`
are declared `shared: { singleton: true }` across the shell and every remote. A second
React copy across the federation boundary breaks hooks/context, so single-instance
sharing is mandatory, not an optimisation.

**Shared session singleton:** the shell **exposes** `shell/session` — the in-memory-JWT
`apiFetch`, the `authClient` wrappers (`getSession`/`useSession`/`signOut`), and the
trusted-origin Bearer guard, extracted from `estimai-ui/src/lib/api.ts` and
`authClient.ts`. Remotes **import** `shell/session` instead of holding their own copy,
so the ADR-0001 in-memory JWT is cached **once** for the whole suite and sign-out
clears it suite-wide (AC-2.3, AC-2.4). This makes the module-federation graph
bidirectional — the host consumes remote apps, and remotes consume `shell/session` —
which MF2 supports. The lower-effort fallback, if the bidirectional wiring proves
fiddly during implementation, is documented rather than silently taken: each remote
keeps its own `apiFetch`. Correctness still holds (same session cookie yields the same
token), but sign-out only guarantees the cookie is gone — a remote's already-cached JWT
stays valid until expiry, which is the same "no revocation at resource server"
trade-off already accepted in ADR-0005.

**Design tokens (AC-1.3):** the DM Sans / DM Mono / Syne fonts, Tailwind 4 `@theme`
tokens, and CSS variables currently defined in `estimai-ui` are extracted to a single
shared tokens stylesheet imported by the shell and every remote, so the suite renders
in one consistent design system regardless of which remote is mounted.

**Deploy:** three independent Vercel projects — `shell`, `estimai-ui`, `refund-ui`. The
shell resolves each remote's `remoteEntry.js` URL **per environment (preview/prod) at
runtime** — not build-baked — via MF's dynamic-remote runtime, so a remote redeploys
without rebuilding the shell or any other remote (AC-5.3). `estimai-ui`'s former
standalone URL is repointed into the shell so the shell becomes the single entry point
(AC-4.3). Remote origins must be added to: the shell's CSP, the `auth` service's
`ALLOWED_ORIGINS`, and the `apiFetch` trusted-origin allowlist; remotes must send
permissive CORS on `remoteEntry.js`.

## Options considered

### Option A — Module Federation with a shell host + path-mounted remotes (chosen)

A dedicated shell host owns chrome and session at runtime; each tool is built, deployed,
and versioned independently and loaded into the shell as a federated remote.

**Pros:**
- Every future Operai tool inherits the shell's chrome, session, and design tokens
  instead of rebuilding them — the cost of adding tool N+1 is a remote entry, not a new
  header/auth/theme implementation
- One authenticated session, one sign-out, for the entire suite (AC-2.1–AC-2.4) — the
  in-memory JWT (ADR-0001) is held once, in `shell/session`, not duplicated per tool
- Tools deploy and redeploy independently (separate Vercel projects, separate
  `remoteEntry.js`) with no shell or sibling-remote rebuild required (AC-5.3)
- A single running chrome instance persists across tool switches with no
  remount/flicker (AC-1.2), which a multi-SPA approach cannot provide without a
  meta-framework or iframe boundary

**Cons:**
- Introduces a new build/runtime mechanism (Module Federation) not previously used
  anywhere in the monorepo, with real early technical risk (Vite 8 support — see Risks
  R1)
- The federation graph is bidirectional (host consumes remote apps; remotes consume
  `shell/session`), which is more complex to reason about and test than a one-directional
  host→remote graph
- Cross-origin runtime code loading (`remoteEntry.js`) is a new security surface
  requiring CSP/CORS/allowlist discipline across three services (shell, `auth`,
  `apiFetch`)
- Nested TanStack Routers (host + per-remote, each with its own `basepath`) must be
  coordinated carefully to avoid fighting over browser history (see Risks R3)

### Option B — Separate SPAs + a shared UI/design-system package, no federation (rejected)

Each tool remains its own independently deployed SPA. Common chrome, auth-guard logic,
and design tokens are extracted into a shared npm/pnpm workspace package that each SPA
imports at build time; there is no shell host and no runtime code federation.

This was the reviewer's recommendation on cost/complexity grounds. The user explicitly
overrode it and chose Module Federation; it is recorded here for completeness and
honesty about the trade-off made.

**Pros:**
- Lower build, versioning, and infrastructure complexity — no new federation plugin,
  no runtime remote-loading mechanics, no bidirectional module graph
- Fully decoupled deploys with no runtime coupling between tools: a broken tool build
  cannot affect another tool's runtime, since there is no shared host process loading
  it
- Familiar mechanism (a shared workspace package built and versioned like any other
  dependency) — no new class of production incident to learn

**Cons:**
- No single running shell instance: each tool re-mounts its own chrome on every
  navigation between tools, so AC-1.2 (chrome persists, no reload/flicker) cannot be
  met without page navigation
- Shared state — most importantly the authenticated session — has to cross tool
  boundaries via redirects, cookies, or storage rather than a single shared runtime
  module; sign-out and session-refresh guarantees are weaker and more manual per tool
- Every new tool still needs its own bootstrap wiring (guard, chrome mount points),
  even if the underlying components are shared — the suite still feels like N apps
  glued together rather than one product

Rejected per explicit user decision in favor of a single runtime shell, despite the
lower-complexity profile.

### Option C — A single unified monolith SPA with a route/section per tool (rejected)

All tools live in one codebase, one build, one Vite app, with tools as top-level route
sections.

**Pros:**
- Simplest possible shell: one router, one build, no federation mechanism at all
- Trivial to keep chrome and session consistent, since there is only one process

**Cons:**
- Couples all tools into a single build and a single deploy: shipping a Refund-only
  change requires rebuilding and redeploying EstimAI too, and vice versa — directly
  defeats independent tool delivery (AC-5.3 could not be met)
- A build or dependency failure in one tool can block release of every other tool
- Contradicts the suite's stated goal of tools evolving and shipping independently
  (ReviewAI/RetroAI/ProposAI arriving on their own timelines)

Rejected: independent deployability is a hard requirement, not a nice-to-have.

### Option D — Host statically composes remote route subtrees into one shared router (rejected)

The shell would import each remote's route tree at build time and merge it into a
single TanStack Router instance, rather than mounting an opaque remote root component
behind a catch-all route.

**Pros:**
- A single, fully-typed route tree across the whole suite; TanStack Router's
  type-safe route generation would cover remote routes too

**Cons:**
- TanStack Router needs its route tree statically known at build time; composing
  routes across a federation boundary (where remotes are resolved at runtime, per
  environment) directly fights that design
- Couples the shell's build to every remote's route definitions, reintroducing the
  build-time coupling Module Federation exists to avoid

Rejected: incompatible with TanStack Router's build-time route-tree model and with the
runtime-resolved remote URLs this ADR requires (see Deploy).

## Consequences

**Positive:**
- Every future Operai tool (ReviewAI, RetroAI, ProposAI, and beyond) inherits the
  shell's chrome, session, and design tokens instead of re-implementing them — adding a
  tool becomes "expose a root component + basepath," not "build a header and an auth
  guard"
- One authenticated session and one sign-out for the entire suite (US-2): the in-memory
  JWT (ADR-0001) lives once, in `shell/session`
- Tools deploy independently: `refund-ui` (or any future remote) can ship without
  rebuilding or redeploying the shell or EstimAI (AC-5.3)
- The shared chrome persists across tool switches with no remount/flicker (AC-1.2),
  giving the suite a genuinely single-product feel

**Negative / trade-offs:**
- Module Federation is a new build/runtime mechanism in the monorepo; the team takes on
  its learning curve, its plugin ecosystem risk (see R1), and its debugging model
  (runtime remote resolution vs. build-time imports)
- The federation graph is bidirectional (host↔remote via `shell/session`), which is
  more complex to test and reason about than the simpler host→remote-only shape; the
  documented fallback (each remote keeps its own `apiFetch`) exists specifically because
  this direction may prove harder than expected
- Cross-origin runtime code loading introduces a new security surface (CSP/CORS/
  allowlist across shell, `auth`, and every remote) that a same-origin single-SPA
  approach would not have

**Risks:**
- **Vite 8 × `@module-federation/vite` compatibility (highest risk).** Vite 8 is very
  new; MF plugin support may lag behind it. Mitigation: the first implementation task
  is a walking skeleton (shell host + one trivial remote + shared React singleton)
  building and running on the pinned Vite 8, gating all further work. Fallback: pin
  Vite to the latest MF-supported minor for the shell/remotes, or switch to
  `@originjs/vite-plugin-federation`.
- **Duplicate React / singleton skew.** Two React instances across the federation
  boundary break hooks and context. Mitigation: `shared: { singleton: true }` for
  `react`/`react-dom`/`@tanstack/react-router`/`better-auth`, with React identity
  asserted in the walking-skeleton task and checked in CI.
- **TanStack Router host/remote history coordination.** Nested routers (host router +
  per-remote router with a `basepath`) can fight over browser `history`/URL, breaking
  deep-linking (AC-3.2, AC-3.3). Mitigation: the host owns browser history; remotes use
  `basepath` against the same history object; deep-link and reload behaviour is
  validated in the walking skeleton before wider migration work proceeds.
- **EstimAI regression during migration (AC-4.1).** Removing EstimAI's own auth guard
  and suite-level chrome, and rebasing its internal routing under a `basepath`, is
  invasive to an app already in production. Mitigation: `estimai-ui` keeps a standalone
  dev/test-only bootstrap so the existing Vitest + Playwright suites keep running
  unchanged and remain the regression gate throughout the migration.
- **Cross-origin remote loading (CORS/CSP) + token-origin allowlist.** Loading
  `remoteEntry.js` cross-origin and attaching Bearer tokens across shell/remote origins
  requires CORS on every remote's `remoteEntry.js`, remote origins in the shell's CSP,
  in `auth`'s `ALLOWED_ORIGINS`, and in the `apiFetch` trusted-origin guard. Mitigation:
  enumerate all origins per environment up front and add them to each allowlist; this
  feature is flagged security-sensitive and gets a dedicated owasp-reviewer pass.
- **Vercel per-environment remote-URL wiring.** Wrong per-environment remote URLs cause
  the shell to load stale or missing remotes. Mitigation: remote URLs are injected via
  runtime env vars (not build-baked); preview and prod resolution is verified
  independently before each remote's deploy is trusted.
- **Session cookie sharing across shell/remote/auth origins.** If the shell, the
  remotes, and the `auth` service cannot share a registrable parent domain, the
  `SameSite=None; Secure` cookie required for credentialed `GET /auth/token` calls may
  be blocked by browser third-party-cookie restrictions — the same class of risk as
  ADR-0001's risk 2. Mitigation: decide production hostnames with a shared registrable
  parent before implementation ends; fallback is bearer-only mode with re-login on hard
  refresh (degrades UX, not security).

## Compliance notes

- GDPR / nLPD impact: low for the composition mechanism itself — no new personal data
  is collected, stored, or logged as a result of moving to a federated shell. However,
  the new **runtime cross-origin code loading** (`remoteEntry.js`) is a supply-chain
  and security surface: a compromised or misconfigured remote origin means arbitrary
  script execution inside the shell's authenticated context. This requires a pinned CSP
  allowlist of remote origins and integrity discipline on every remote deploy pipeline.
  This feature is marked security-sensitive in `specs/003-suite-shell/plan.md`, and an
  owasp-reviewer pass is scheduled in parallel with QE, covering CSP/remote-origin
  pinning, the token-origin allowlist, sign-out completeness, open-redirect protection
  on the shell's guard, and CORS posture on remote entries.
- Data residency: unchanged — this is a frontend composition decision only; the `auth`
  service and `estimai-api` keep their existing EU deployment (Railway EU) with no
  change to where data is processed or stored.
- Audit trail: not required for this decision; session-level audit remains owned by
  better-auth in the `auth` service, unchanged.

This decision builds directly on: ADR-0001 (in-memory JWT, never web storage — now
centralised once in `shell/session`), ADR-0002 (hosted sign-in page — reused as-is by
the shell's `_authed` guard), and ADR-0005 (JWT resource-server verification via remote
JWKS — the accepted "no revocation at resource server" trade-off this ADR's session
fallback explicitly relies on).

---

## Addendum (2026-07-10) — Remote CSS strategy: one shell-owned Tailwind sheet

### Context

The suite uses Tailwind CSS v4 (`@tailwindcss/postcss`). Tailwind v4's JIT emits **only
the utility classes a given build actually uses**, and emits them into cascade layers
(`@layer utilities { … }`). The first federated implementation had every remote import its
own compiled stylesheet at its exposed root (`estimai-ui/src/App.tsx` did
`import './index.css'`) so that its utility classes would travel with the federated module.

This put **two full Tailwind sheets on the shell's page** once a remote mounted: the
shell's and the remote's. Both declare the same layer, `@layer utilities`, and CSS merges
same-named layers from different stylesheets **in stylesheet (DOM) order**. So whichever
Tailwind sheet appeared *later* had its plain utilities (`.flex`, `.hidden`, …) win over
the *earlier* sheet's **variant** utilities (`sm:hidden`, `hover:*`, `focus:*`) at equal
specificity. Concretely: an element with `class="flex sm:hidden"` stayed `display: flex`
at narrow widths because the later sheet's `.flex` overrode the earlier sheet's
`.sm\:hidden`. This surfaced as the **duplicate/again-broken header** and unreliable
responsive/hover/focus behaviour in EstimAI inside the shell — and it affects *every*
variant utility, so it could not be whack-a-moled class by class.

### Decision

**One Tailwind sheet for the whole suite, owned by the shell.**

1. The shell's stylesheet (`shell/src/index.css`) `@source`-scans every remote's source:
   `@source "../../estimai-ui/src"; @source "../../refund-ui/src";`. The shell's single
   Tailwind build therefore generates **every remote's** utility classes too — from the
   shared `@theme` token block, which lives in `shell/src/styles/tokens.css`.
2. A federated remote's **exposed root ships no Tailwind of its own** in-shell:
   `estimai-ui/src/App.tsx` no longer imports `index.css` (matching `refund-ui/src/App.tsx`,
   which already relied on the shell's Tailwind and only imports `shell/tokens.css` at
   runtime for the palette CSS vars). With no second sheet, there is no cross-sheet layer
   merge and variant utilities behave correctly.
3. `tokens.css` is promoted to the **single owner of the suite's global base CSS**: the
   `@theme` tokens *and* the shared `@layer base` (form-control resets for
   `input`/`select`/`button`, the `input[type=number]` mono face, and the scrollbar
   styling) now live there, so in-shell every remote inherits identical chrome and form
   controls from the one owner instead of from its own copy.
4. A remote's own `src/index.css` (imported only by its `src/main.tsx`) is kept **only for
   its standalone dev/test build**, where there is no shell sheet — it must stay in sync
   with `tokens.css` (the base rules are duplicated there deliberately for that path).

### Consequences

- **Positive:** the cross-sheet cascade class of bug is eliminated by construction (there
  is one sheet). The design system is genuinely centralised — a token or base-rule change
  in `tokens.css` reaches all remotes. Less CSS ships in-shell (no duplicated Tailwind
  preflight/utilities per remote).
- **Cost / discipline:** the shell must `@source` each new remote's `src/` when it's added
  (a one-line edit, and its absence is visible — the remote renders unstyled in-shell).
  The base rules live in two places for standalone builds (`tokens.css` and each remote's
  `index.css`) and must be kept in sync; the file header comments call this out.
- **Verified** (2026-07-10) against the real assembled shell (build + preview, seeded
  session): exactly one Tailwind sheet on the page with EstimAI mounted; a synthetic
  `flex sm:hidden` element computes `display: none` (the variant wins); EstimAI's palette
  utilities (e.g. `bg-ink-soft`) resolve to real colours generated by the shell's sheet.
  Full unit suites (estimai 81, shell 71, refund 5) and the shell e2e (30/30) stay green.

---

## Addendum (2026-07-13) — Cross-remote navigation without a full reload

### Context

specs/005-notification-center's T15 fix (AC-2.5) made a notification's link render as a
real `<a href>` instead of a TanStack Router `<Link>`, because a remote's own inner
router cannot resolve a path outside its own `basepath` — this ADR already established
that `@tanstack/react-router` is a shared MF *library* singleton across remotes, not a
shared router *instance* (see "Shared singletons" above). That fix was correct but
incomplete: a plain anchor means every click, including an ordinary unmodified
left-click meant to stay in the app, triggers a full document navigation — the browser
has no way to know the target lives inside the same federated suite.

### Decision

The SHELL is the only place a single top-level router instance exists that spans every
remote's basepath (`/estimai`, `/refund`, `/admin`, `/notify`, …), so cross-remote
navigation must be routed through it. `shell/session` (already the suite's shared
session/runtime seam, per this ADR's "Shared session singleton" section) now also
exposes `navigateSuite(to)`: a remote calls it with an in-suite absolute path, and it
invokes the shell's own `router.navigate({ to })` — registered once, from
`shell/src/main.tsx`, into a module-scope registry (`registerSuiteNavigate`), the same
"register a callback, invoke it later" shape already used for `onSignOut` in
`session.ts`, chosen specifically to avoid a session↔router import cycle. A remote (e.g.
`notify-ui`'s `NotificationItem`) keeps the real `<a href>` — untouched, so
middle-click/ctrl-click/cmd-click/"open in new tab" all still work exactly as a native
anchor — but intercepts a plain, unmodified left-click, calls `preventDefault()`, and
calls `navigateSuite(link.href)` instead, producing an in-app client-side transition
with no full reload. `navigateSuite` falls back to `window.location.assign(to)` if
nothing has registered yet (e.g. a stray call before the shell has mounted), which still
reaches the right place via a full reload rather than doing nothing.

### Consequences

- **Positive:** cross-remote navigation (a notification's link today; any future
  remote-to-remote link tomorrow) is a real client-side transition, not a full page
  reload, without requiring a shared router *instance* across the federation boundary —
  the shell's router stays the single source of truth for routing, and remotes never
  need their own copy of it.
- **Cost:** every remote that wants this behavior must import `navigateSuite` from
  `shell/session` and wire its own click-interception guard (the "which click counts as
  a plain click" logic — `button !== 0`/`metaKey`/`ctrlKey`/`shiftKey`/`altKey` — is
  duplicated per call site rather than centralized in one component, since each remote
  renders its own markup).
- **Verified:** `shell`'s unit suite covers `navigateSuite`'s registered-callback and
  `window.location.assign` fallback paths; `notify-ui`'s `NotificationItem` tests cover a
  plain left-click calling `navigateSuite` and a modified click leaving the anchor's
  native behavior alone.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
