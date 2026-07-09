---
spec: 003
status: draft
---

# Design: Operai suite shell (Module Federation)

Scope reminder: this is a chrome/composition feature. No new visual design system —
the shell and both remotes render in the existing DM Sans/DM Mono/Syne, dark-ink,
purple-accent Operai palette (`estimai-ui/src/index.css`). Every flow below cites the
US/AC it satisfies; anything without a citation is flagged separately as a gap.

**Constraint — desktop-only v1 shell chrome.** Per the amended spec (added as an
explicit non-goal), the shell's own chrome (header, sidebar, footer) targets desktop
viewports only in this pass. No collapsed/icon-rail sidebar, no mobile drawer, no
responsive header breakpoints are designed here. This does **not** touch EstimAI's own
content — its existing internal mobile layout (`Header.tsx`'s `hidden sm:flex` /
`flex sm:hidden` split, which stays largely as-is minus the relocated pieces) is
unaffected, since that's tool-scoped content, not shell chrome.

## Flows

### Flow 1 — Unauthenticated visitor → hosted sign-in → shell landing
_US-2, AC-2.1, AC-2.2, AC-2.5_

1. Entry: visitor opens any suite URL (`/`, `/estimai`, `/refund`, or a deep link).
2. The shell's pathless `_authed` guard resolves the session before rendering any
   chrome. No session → **success exit is a full-page redirect**, not a shell screen:
   the browser navigates to `<AUTH_URL>/sign-in?redirect=<current-url>`. The visitor
   sees **none** of the suite's chrome or content while this resolves (AC-2.1) —
   there is a brief blank/loading instant while `getSession()` awaits; see Screens
   ("Guard-pending state").
3. Visitor completes sign-in at the hosted page (out of scope — reused as-is,
   ADR-0002) and is returned to the original URL.
4. The guard re-resolves, finds a session, and mounts the shell chrome. If the
   original URL named a specific tool, that tool loads directly (Flow 3); if it was
   the bare root, the root-landing redirect applies first (Flow 2). Any
   authenticated call the resolved tool makes succeeds with no further sign-in
   prompt (AC-2.2).
5. Reload at any point after this: guard re-resolves from the session cookie: same
   result, no repeated sign-in (AC-2.5).

Error exit: `getSession()` itself errors (network failure talking to `auth`) — treated
as "no session" per the existing `estimai-ui` guard precedent; redirects to sign-in
rather than hanging. No distinct UI is designed for this because the visitor never
reaches shell-rendered content — it's a guard-level concern, not a content-area concern
(see Decisions & resolved gaps: "guard-pending state has no spec'd loading UI").

### Flow 2 — Root landing: redirect to the most-recently-used tool
_US-3, AC-3.4_

1. Entry: a signed-in user's request resolves to the shell's bare root path `/` (not
   a specific tool path).
2. The shell reads a shell-owned, tool-agnostic persistence key
   (`localStorage['operai_last_tool']`), written every time a tool switch completes
   (Flow 3, step 4).
3. If the key holds a recognized tool id, the shell redirects to that tool's mount
   path (`/estimai` or `/refund`).
4. If the key is absent, unreadable, or holds an unrecognized value (first visit,
   cleared storage, a future-removed tool), the shell falls back to EstimAI
   (`/estimai`) as the default.
5. **This is a redirect, not a new suite home/launcher screen** — the user never sees
   an intermediate "choose a tool" page. The content area goes straight to the
   loading state (Flow 4) for the resolved tool.
6. Success exit: the browser URL updates to the resolved tool's path, so a later
   reload of `/` recomputes the same redirect and the tool's own URL is what ends up
   bookmarked/shared.

### Flow 3 — Switch tools from the sidebar
_US-3, AC-1.2, AC-3.1, AC-3.2, AC-3.3_

1. Entry: signed-in user is on any suite screen; the sidebar (always visible in the
   persistent chrome) lists **EstimAI** and **Refund (Rimborsi)**, with the currently
   active tool visually indicated (AC-3.1).
2. User clicks (or keyboard-activates, see Accessibility) the inactive tool's entry.
3. The browser URL changes to that tool's mount path (`/estimai/...` or `/refund`);
   the sidebar's active indicator moves to the newly selected entry; the content area
   shows the loading state (Flow 4) and then the tool (AC-3.2). Header, sidebar and
   footer DOM nodes are not remounted or reflowed during this — only the content area
   swaps (AC-1.2).
4. On a successful switch, the shell writes the selected tool's id to
   `operai_last_tool` so a later bare-root visit (Flow 2) returns here.
5. Success exit: tool is shown, URL is shareable and reload-safe (reloading
   `/estimai/estimates/3` lands directly back on that screen, still inside the shell
   chrome, not a bare EstimAI page — AC-3.2, AC-3.3).
6. Deep-link variant: user (or a shared link) opens `/refund` or
   `/estimai/estimates/$id` directly. The shell must resolve and mount the correct
   tool as the **first** paint of the content area — the user must never see EstimAI
   flash before Refund loads, or vice versa (AC-3.3).

### Flow 4 — Remote loading and remote load failure
_US-6, AC-6.1_

1. Entry: shell has a session and needs to mount a tool's federated remote (on first
   load of that tool, or on switching to it per Flow 2 or Flow 3).
2. **Loading state:** content area shows a loading state scoped to the content area
   only — chrome stays interactive (user can still open the About dialog, toggle
   theme, or click a different sidebar entry, which aborts this load and starts the
   other tool's).
3. **Success exit:** remote resolves → its root component mounts in the content area.
4. **Failure exit (AC-6.1):** remote fails to load (network error fetching
   `remoteEntry.js`, or an MF runtime error). The content area shows a clear,
   in-place error state — chrome and the sidebar remain fully usable, and selecting
   the *other* tool from the sidebar works normally (one tool's outage does not take
   down the suite). The error state offers a retry action (re-attempt the same
   remote) since transient network failures are the most likely cause.

### Flow 5 — Sign out from the shell
_US-2, AC-2.4_

1. Entry: signed-in user opens the avatar/user menu in the shell header (relocated
   `UserMenu`) and selects "Sign out".
2. The shell terminates the session suite-wide: the shared session module's JWT cache
   is cleared and `authClient.signOut()` runs, clearing the session cookie.
3. Success exit: user is returned to the sign-in page. A subsequent authenticated call
   (from any tool, if somehow still mounted) is rejected (AC-2.4) — mirrors the
   existing EstimAI sign-out precedent (`EstimatorApp.tsx`'s `handleSignOut`).

### Flow 6 — EstimAI runs inside the shell with no chrome duplication or regression
_US-4, AC-4.1, AC-4.2, AC-4.3_

1. Entry: user reaches `/estimai/...` (via Flow 1, 2, 3, or a former standalone
   EstimAI URL).
2. AC-4.3: a former standalone EstimAI URL does not render a second, independent
   EstimAI app — it is redirected into the shell (deploy/redirect concern, not a
   distinct screen; see Decisions & resolved gaps).
3. Inside the shell, EstimAI's own list ↔ editor ↔ share navigation
   (`/estimates` → `/estimates/$id` → `/share`) works exactly as before, just rebased
   under `/estimai` — no change in interaction (AC-4.1).
4. What EstimAI stops rendering: its own logo/About dropdown, its own avatar/sign-out
   menu, its own theme toggle — all now provided once by the shell header (AC-4.2).
   This dedup is **confirmed in scope on both of EstimAI's header surfaces** — not
   just `EstimatorApp.tsx`'s `Header`, but also `EstimatesPage.tsx`'s own separate
   inline header (drops its logo image + `UserMenu`) and a trim of
   `SharedEstimatePage.tsx`'s header (drops its small static logo mark). See Screens
   and Component inventory.
5. What EstimAI keeps: the "My Estimates" navigation control and the save-status
   indicator (tool-scoped, not suite-scoped), plus each page's remaining tool-specific
   actions ("Import JSON", "+ New estimate", "Save to My Estimates", the read-only
   badge).
6. Success exit: every existing EstimAI capability (create/edit/list/delete estimates,
   exports, sharing) behaves identically, and the existing Vitest/Playwright suites
   pass unchanged against the migrated app (AC-4.1 — a test-strategy concern, not a
   design one, noted here only because it bounds what must visually stay the same).

### Flow 7 — Refund stub proves the second remote
_US-5, AC-5.1, AC-5.2, AC-5.3_

1. Entry: signed-in user selects "Refund (Rimborsi)" from the sidebar (present
   alongside EstimAI per AC-5.1).
2. The Refund remote loads (Flow 4's loading/error states apply identically — Refund
   is not special-cased).
3. Success exit: a minimal placeholder screen renders inside the shell's content area,
   authenticated by the shell's session — it renders content only because the shell
   already guaranteed a session before mounting it; there is no separate Refund
   sign-in path to design (AC-5.2).
4. AC-5.3 (independent redeploy of `refund-ui` without rebuilding the shell or
   EstimAI) has no UI surface — it's a deploy-topology guarantee, not a screen or
   interaction. Flagging so it isn't mistaken for a missing design.

### Flow 8 — About dialog
_US-1, AC-1.4_

1. Entry: user clicks the suite logo in the shell header, opening the `LogoMenu`
   dropdown (relocated as-is).
2. User selects "About" → the relocated `AboutModal` opens, now describing the
   **suite** (Operai), not a single tool — see Screens for the content change this
   implies.
3. Exit: click outside, Escape, or the "×" close button dismisses it — identical
   interaction to the existing EstimAI About dialog.

## Screens & states

### Shell chrome (persistent across all tools)

Purpose: the single header/sidebar/footer frame that AC-1.1 requires, mounted once
and never remounted while switching tools (AC-1.2). Desktop-only in v1 (see
Constraint above) — every state below assumes a desktop viewport; no
mobile/collapsed variant is designed.

- **Header** (AC-1.4): suite logo (opens `LogoMenu` → About), user avatar/menu
  (relocated `UserMenu` — name/email + sign-out), theme toggle (relocated inline
  markup from `Header.tsx`, extracted into its own control). No project-name field,
  no "My Estimates" button, no save-status indicator here — those are EstimAI-scoped
  and stay in EstimAI's own in-content top bar (Flow 6).
  - State: header only ever renders in its signed-in form — the shell guarantees a
    session before any chrome mounts, so there is no "signed-out header" state to
    design.
- **Sidebar** (US-3): lists EstimAI and Refund (Rimborsi). States: **active** (current
  route's tool, `aria-current="page"`), **inactive**, **hover**, **keyboard-focus**
  (visible focus ring, see Accessibility). No nested items, no role-based filtering
  (explicit non-goal) — a flat two-item list today, built to accept more tools later
  without a redesign. Desktop-only: no icon-rail-collapsed or drawer state.
- **Footer** (AC-1.5): legal-information link, version string, company information
  (wellD). Renders in **normal document flow** at the bottom of the content column —
  not `position: fixed`/sticky — so it does not overlap or compete with EstimAI's own
  fixed bottom-right shortcuts hint, which remains tool-scoped and unchanged (see
  "EstimAI inside the shell" below; this resolves the earlier collision concern with
  no layout trade-off needed). Static, no loading/error state — it renders from
  build-time constants, not a network call.
- **About dialog** (AC-1.4, Flow 8): modal, reused from `AboutModal.tsx` as-is
  structurally. Content changes: title/description move from "EstimAI ... part of the
  Operai suite" to "Operai ... " (the suite itself), version becomes the shell's
  version, not EstimAI's. This is a copy/content change carried by the relocated
  `appInfo.ts`, not a new component.

### Root path `/`

No dedicated screen — `/` never renders anything of its own. It resolves via the
root-landing redirect (Flow 2) to either the most-recently-used tool or the EstimAI
fallback, and the content area goes straight to that tool's loading state.

### Content area (per-tool, swaps on navigation)

- **Loading state** (Flow 4): a scoped, content-area-only loading treatment while a
  remote's `remoteEntry.js` resolves. Chrome remains interactive throughout.
- **Loaded state**: the active remote's root component, rendered full-bleed inside
  the content area, no chrome of its own.
- **Failed state** (AC-6.1): a clear in-place error message ("Refund couldn't load."
  or tool-specific equivalent) plus a retry action, confined to the content area;
  chrome and sidebar stay fully operational, and switching to the other tool works.
  Visually this can draw on the existing alert idiom already in the codebase
  (`ToastBanner`'s left-accent/alert-role treatment, `EstimatesPage`'s inline
  `role="alert"` + Retry button) — not reused components verbatim (they're page-level,
  this is federation-boundary-level) but the same visual language, so the suite feels
  consistent even in a fault state.

### Refund (Rimborsi) placeholder (AC-5.2)

A minimal, authed-only placeholder screen: a heading identifying the tool, a short
"coming soon" / proof-of-concept message, and nothing else — no forms, no data, per
the explicit non-goal ("actual reimbursement domain ... later specs"). It renders only
because the shell already established a session; there is no separate empty/error/
loading state beyond Flow 4's generic ones (this screen itself has no data fetch).

### EstimAI inside the shell — what changes on existing screens

These are **existing** EstimAI screens whose header surface shrinks under AC-4.2; not
new designs, but the reduction needs to be explicit so nothing is missed. Both
surfaces below are **confirmed in scope** for this feature (not a future follow-up):

- **Editor (`EstimatorApp.tsx`'s `Header`)**: drops `LogoMenu`, `UserMenu`, and the
  theme toggle. Keeps: project-name field, save-status indicator, "My Estimates"
  button. (Matches the amended plan's chrome-ownership table directly.)
- **My Estimates list (`EstimatesPage.tsx`)**: this page renders its **own**, separate
  inline header (plain logo `<img>` + `UserMenu` + "Import JSON" + "+ New estimate") —
  distinct from `EstimatorApp`'s `Header`. Under AC-4.2 this also loses its logo image
  and `UserMenu` (both now suite-scoped, shell-provided); it keeps "Import JSON" and
  "+ New estimate" (tool-scoped actions).
- **Shared estimate view (`SharedEstimatePage.tsx`)**: keeps its read-only badge,
  estimate name/author, "Save to My Estimates", and "My Estimates" nav button (all
  tool-scoped). Its small static logo mark (`<img>`, not a `LogoMenu` dropdown) is
  removed as part of this feature's chrome-dedup pass, to avoid visual double-branding
  next to the shell's own logo.
- **Existing floating shortcuts hint** (`EstimatorApp.tsx`'s `<footer className="fixed
  bottom-0 right-0 ...">`, the "⇧? shortcuts" hint): this is **not** the AC-1.5 suite
  footer — it's a tool-scoped, `position: fixed` decorative hint that stays with
  EstimAI, unchanged. Since the shell footer renders in normal document flow (not
  fixed), the two do not visually collide; no layout rework is needed here.

### Guard-pending state (Flow 1, step 2)

Momentary state between "shell requested" and "either redirected to sign-in or chrome
mounted." No spec'd design exists for this instant (see Decisions & resolved gaps) —
recommend a minimal, brand-neutral blank/loading treatment (e.g., the ink background
with no flash of unstyled content) rather than designing new loading UI no AC asks
for.

## Component inventory

Component library in use: **Tailwind CSS 4** (utility classes, `@theme` tokens) with
hand-built React components — no Mantine/MUI/Chakra/shadcn (confirmed via
`estimai-ui/package.json` and every component under `estimai-ui/src/components/`).
The new `shell/` and `refund-ui/` apps must follow the same convention (per
`docs/adr/0006`, they share the design tokens) — no new UI library is being
introduced.

| Element | Reuse / NEW | Source |
|---|---|---|
| Suite logo dropdown (opens About) | **Reuse**, relocate | `estimai-ui/src/components/LogoMenu.tsx` → `shell/src/components/LogoMenu.tsx`, wiring only |
| User avatar/menu (name, email, sign-out) | **Reuse**, relocate | `estimai-ui/src/components/UserMenu.tsx` → `shell/src/components/UserMenu.tsx`, as-is |
| About dialog | **Reuse**, relocate + re-copy | `estimai-ui/src/components/AboutModal.tsx` + `estimai-ui/src/lib/appInfo.ts` → `shell/`; component structure unchanged, `appInfo.ts` values change from EstimAI-level to suite-level (Operai name/description/version) |
| Theme toggle control | **Reuse**, extract | `useTheme.ts` hook + the inline toggle-button markup currently in `Header.tsx` (lines 28–37) → `shell/src/hooks/useTheme.ts` + a small dedicated `ThemeToggle` file; same interaction, just given its own component boundary since it's shell-owned, not tool-owned |
| Design tokens (fonts, CSS vars, Tailwind `@theme`) | **Reuse**, extract | `estimai-ui/src/index.css` → a shared tokens stylesheet imported by shell + both remotes (per plan's federation contract, `shell` exposes `./tokens.css`); no new visual design. Packaging mechanism is a build/architecture concern, intentionally left open here (see Decisions & resolved gaps, item 5) |
| EstimAI in-content top bar (project name, save-status, "My Estimates") | **Reuse**, reduced | `estimai-ui/src/components/Header.tsx`, minus the pieces that move to the shell |
| EstimAI list-view inline header (Import JSON, + New estimate) | **Reuse**, relocate/remove parts | `estimai-ui/src/pages/EstimatesPage.tsx`'s own header block — **remove** its logo `<img>` and `UserMenu` instance (now shell-provided), **keep** "Import JSON" and "+ New estimate". Confirmed in scope for AC-4.2 (see Decisions, item 4) |
| Shared-estimate view header (read-only badge, name, save-to-mine, My Estimates nav) | **Reuse**, trim | `estimai-ui/src/pages/SharedEstimatePage.tsx`'s own header block — **remove** its small static logo mark; **keep** everything else. Confirmed in scope for AC-4.2 (see Decisions, item 4) |
| Shell layout (header + sidebar + content + footer regions, skip-to-content link, landmark roles) | **NEW** | No persistent multi-region app-shell exists anywhere in the codebase today — EstimAI is a single sticky-header column. Required to host AC-1.1/AC-1.2. Desktop-only in v1. |
| Sidebar / tool switcher | **NEW** | No sidebar or tool-navigation component exists in the codebase. Required for US-3. Desktop-only in v1 — no collapsed/drawer variant. |
| Shell footer (legal link, version, company info) | **NEW** | No `<footer>` with this content exists — EstimAI's only `<footer>` is the tool-scoped fixed shortcuts hint, a different thing entirely (see Screens). Renders in normal flow (not fixed). Required for AC-1.5. |
| Content-area remote boundary (loading + failed states around a federated remote) | **NEW** | The federation-boundary loading/failure concept has no existing analog — EstimAI's async states (`EstimatesPage`'s `ListState`) are page-level data-fetch states, not "is the remote module itself available" states. Required for AC-6.1 and the loading transition in Flow 3/4. |
| Refund placeholder screen | **NEW** | A new tool by definition; minimal content, no existing analog. Required for US-5. |

**Ratio: 8 reuse (relocated/extracted/trimmed) : 5 NEW.**

Root-landing redirect logic (AC-3.4, Flow 2) is not a UI component — it's routing/
guard logic (read `operai_last_tool`, redirect) and is not counted in this table.

## Accessibility

- **Landmarks**: header → `<header role="banner">`; sidebar → `<nav aria-label="Tool
  navigation">`; content area → `<main>`; footer → `<footer role="contentinfo">`. Only
  one `banner`/`contentinfo` pair for the whole document — EstimAI's own tool-scoped
  `<footer>` (the fixed shortcuts hint) must **not** compute as a second contentinfo
  landmark; since it renders nested inside the shell's `<main>`, this holds
  automatically per the HTML sectioning-root rule (a `<footer>` nested in `<main>` is
  not a top-level contentinfo landmark). This is a landmark-correctness note, not a
  layout-collision one — the two footers also don't visually overlap, since the shell
  footer is in normal flow and EstimAI's hint stays fixed bottom-right (see Screens).
- **Skip-to-content link**: none exists today (confirmed — no skip link anywhere in
  `estimai-ui/src`). New requirement introduced by the shell's persistent chrome: a
  visually-hidden-until-focused "Skip to content" link as the first focusable element,
  targeting the content area, so keyboard/screen-reader users don't have to tab
  through the sidebar on every tool switch.
- **Sidebar keyboard operation**: roving `tabindex` (one stop in the sidebar's tab
  order; Up/Down or Left/Right arrow keys move focus between EstimAI/Refund entries),
  Enter/Space activates. Active tool indicated both visually and via
  `aria-current="page"` (not color alone — contrast/color-blind safe per existing
  palette conventions). Desktop-only in v1: no touch-target-size adjustments or
  mobile-specific focus/tap considerations are in scope; the keyboard requirements
  above apply regardless.
- **Focus management on tool switch**: when the content area finishes loading a newly
  selected tool, move focus to the tool's main heading (or the content-area container
  if no heading is available yet) so screen-reader users land in the new content
  rather than staying stranded on the sidebar item they just activated. Mirrors the
  `EstimatePage`'s existing pattern of forcing a fresh render via a `key` on
  navigation-triggered content changes. This applies identically to the root-landing
  redirect (Flow 2) — focus lands in the resolved tool's content, not on a
  redirect-in-progress sidebar item.
- **Remote-load error announced** (AC-6.1): the failed state must be a `role="alert"`
  (or an `aria-live="assertive"` region), matching the existing `ToastBanner` /
  `EstimatesPage` error-alert convention already in the codebase, so screen-reader
  users are told immediately, without needing to discover the error visually.
- **Loading state announced**: a polite `aria-live` region (`aria-live="polite"`,
  visually-hidden text, e.g. "Loading Refund…") mirroring `EstimatesPage`'s existing
  `<p className="sr-only" aria-live="polite">Loading your estimates</p>` pattern —
  consistent with how the codebase already announces async loads.
- **Existing dropdown ARIA reused as-is**: `LogoMenu` and `UserMenu` already implement
  `aria-haspopup="menu"`, `aria-expanded`, `role="menu"`/`role="menuitem"`,
  click-outside + Escape-to-close. Relocating them to the shell must preserve this
  exactly — no new interaction pattern needed here.
- **Focus-visible rings**: reuse the existing `focus-visible:ring-2
  focus-visible:ring-acc/50` convention (seen in `UserMenu`/`LogoMenu` trigger
  buttons) for every new interactive element in the shell (sidebar items, skip link,
  retry button, theme toggle) so the whole suite has one consistent focus language.
- **Contrast**: no new colors are introduced (design tokens are reused as-is), so no
  new contrast risk — but the new failed-state alert and the loading-state text must
  be checked against both the dark (`--color-org`/`--color-red` on `--color-ink`) and
  light theme variants already defined in `index.css`, since neither exists in the
  palette today for a "whole tool failed" context specifically (only per-row/per-toast
  contexts do).

## Decisions & resolved gaps

All five items originally flagged during design have been resolved by the caller; the
spec and plan have been amended to match. Recorded here so the decisions are visible,
not silently dropped:

1. **RESOLVED — Root landing (AC-3.4).** The bare `/` redirects to the user's
   most-recently-used tool, persisted client-side in
   `localStorage['operai_last_tool']` and written on every successful tool switch,
   falling back to EstimAI on first visit or an unrecognized value. It is a redirect,
   not a new suite home/launcher screen. See Flow 2.
2. **RESOLVED — Responsive scope.** v1 shell chrome is desktop-only (now an explicit
   spec non-goal). No mobile/collapsible chrome states are designed for the header,
   sidebar, or footer. EstimAI's own content-area responsiveness is unchanged and out
   of this feature's scope.
3. **RESOLVED — Footer/shortcuts-hint collision.** The shell footer renders as a
   normal in-flow (non-fixed) page footer, so it does not collide with EstimAI's
   fixed, tool-scoped "⇧? shortcuts" hint, which stays exactly as it is today. No
   layout rework needed.
4. **RESOLVED — `EstimatesPage` chrome duplication.** Confirmed real and in scope:
   `EstimatesPage.tsx`'s inline header (logo image + `UserMenu`) and a trim of
   `SharedEstimatePage.tsx`'s header (its small static logo mark) are both chrome-dedup
   work under AC-4.2, alongside the previously-identified `EstimatorApp.tsx`/
   `Header.tsx`. Listed explicitly in the Component inventory so the tasks stage picks
   them up.
5. **RESOLVED — Design-token packaging.** Correctly a build/architecture concern (how
   the shared tokens stylesheet is exposed/consumed across the federation boundary),
   not a UX decision. Left out of this document's scope, as originally noted; no
   change needed here.

No AC in the spec is without a UI surface *except* the explicitly non-visual ones
already called out inline (AC-2.3 — no independent redirect, a behavioral absence;
AC-3.4 — a redirect decision, Flow 2, consistent with AC-4.3's treatment below;
AC-4.3 — a redirect/rewrite, not a screen; AC-5.3 — independent redeploy, a deploy
guarantee; AC-1.3 — a cross-cutting consistency property verified across every screen
above, not a screen of its own).
