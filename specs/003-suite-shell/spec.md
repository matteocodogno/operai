---
id: 003
slug: suite-shell
status: approved
rigor: production
created: 2026-07-09
approved: 2026-07-09
---

# Operai suite shell (Module Federation)

## Problem

Operai is becoming a suite of tools (EstimAI today, a reimbursement app next), but
each tool is an independent SPA with its own header, its own sign-in redirect, and its
own entry point. Users have no single place to land, no consistent chrome, and would
have to authenticate separately per tool. As we add tools this fragments the product
and duplicates cross-cutting concerns (identity, session, theme, navigation). We need a
single shell that owns the shared chrome and the authenticated session and hosts each
tool, so the suite feels like one product and every new tool inherits the shell instead
of rebuilding it.

## User stories

### US-1: One suite entry with shared chrome
As a signed-in Operai user, I want a single suite entry with a persistent shared
header, sidebar, and footer, so that every tool looks and feels like one product.

**Acceptance criteria:**
- AC-1.1: Given a signed-in user, when they open the suite, then a persistent shared
  chrome (header, left sidebar, footer) is displayed around the active tool's content.
- AC-1.2: Given the user moves between tools, when a different tool becomes active,
  then the shared chrome stays mounted and unchanged (the header/sidebar/footer do not
  reload or flicker) and only the content area swaps.
- AC-1.3: Given the suite design system, when any tool is displayed inside the shell,
  then its typography and color palette match the suite's design system, so remotes
  are visually consistent with the chrome and with each other.
- AC-1.4: Given the shell header, when it renders, then it contains the suite logo, an
  About control (a dropdown opening an About dialog), the signed-in user's avatar/menu,
  and a theme toggle.
- AC-1.5: Given the shell footer, when it renders, then it contains a link to legal
  information, the version, and company information.

### US-2: Sign in once for the whole suite
As a signed-in user, I want to authenticate once at the shell, so that every tool I
open is already authenticated without a separate sign-in.

**Acceptance criteria:**
- AC-2.1: Given an unauthenticated visitor, when they open any suite URL, then they are
  redirected to the central hosted sign-in and see none of the suite's content.
- AC-2.2: Given the visitor completes sign-in, when they return, then they land in the
  shell with an established session, and opening a tool (EstimAI) makes authenticated
  backend calls succeed without any further sign-in prompt.
- AC-2.3: Given a signed-in user opens a tool, when that tool loads inside the shell,
  then the tool consumes the shell's session and does not perform its own independent
  sign-in redirect.
- AC-2.4: Given a signed-in user, when they sign out from the shell, then the session
  is terminated for the whole suite (a subsequent authenticated call is rejected) and
  the user is returned to the sign-in page.
- AC-2.5: Given a signed-in user, when they reload any suite page, then their session
  persists and they are not asked to sign in again.

### US-3: Switch between tools from the sidebar
As a signed-in user, I want a sidebar listing the available Operai tools, so that I can
move between them from one place.

**Acceptance criteria:**
- AC-3.1: Given the shell, when it renders, then the sidebar lists the available tools —
  EstimAI and Refund (Rimborsi) — with the currently active tool visually indicated.
- AC-3.2: Given the user selects a tool in the sidebar, when the tool loads, then it is
  shown in the shell's content area and the browser URL reflects the active tool, so the
  location is shareable and survives a reload.
- AC-3.3: Given a URL that points directly at a specific tool, when the shell loads that
  URL, then the correct tool is shown directly without first showing a different tool.
- AC-3.4: Given a returning signed-in user, when they open the suite at its bare root,
  then they are taken to the tool they most recently used; on a first visit with no prior
  tool, they land on EstimAI as the default.

### US-4: EstimAI runs inside the shell with no regression
As an EstimAI user, I want EstimAI to behave exactly as before now that it runs inside
the shell, so that nothing I rely on breaks.

**Acceptance criteria:**
- AC-4.1: Given EstimAI running inside the shell, when a user exercises any existing
  EstimAI capability (create/edit/list/delete estimates, exports, sharing), then it
  behaves identically to the standalone app and the existing EstimAI test suite passes.
- AC-4.2: Given the shell owns suite-level chrome, when EstimAI runs inside it, then the
  suite-level controls now provided by the shell header (logo, About dropdown/dialog,
  user avatar/menu and sign-out, theme toggle) and the top-level tool navigation are not
  duplicated inside EstimAI's own content area; tool-specific controls (e.g. "My
  Estimates", the save-status indicator) remain part of EstimAI.
- AC-4.3: Given the shell is the single entry point, when a user navigates to EstimAI's
  former standalone URL, then they are taken into the shell (EstimAI is reachable only
  through the shell).

### US-5: A Refund stub proves multi-remote navigation
As wellD, we want a placeholder Refund tool wired into the shell as a second,
independently built remote, so that the multi-tool federation pattern is proven before
the reimbursement app is built.

**Acceptance criteria:**
- AC-5.1: Given the sidebar, when it renders, then a Refund (Rimborsi) entry is present
  alongside EstimAI.
- AC-5.2: Given the user selects Refund, when it loads, then a minimal placeholder tool
  is displayed inside the shell, authenticated by the shell session (it renders content
  only for a signed-in user).
- AC-5.3: Given Refund and EstimAI are separately built tools, when the Refund tool is
  changed and redeployed, then it updates in the shell without rebuilding or redeploying
  EstimAI.

### US-6: A failing tool does not break the suite
As a signed-in user, I want the suite to stay usable if one tool fails to load, so that
one tool's outage does not take down the whole product.

**Acceptance criteria:**
- AC-6.1: Given a tool that fails to load (network error or load failure), when the user
  selects it, then the shell shows a clear error state in the content area while the
  chrome and the other tools remain usable (no blank/broken whole-suite screen).

## Non-goals

- Roles, groups, and role-gated navigation (employee vs accounting) — a separate spec;
  the v1 sidebar lists tools without filtering by role.
- The actual reimbursement domain (requests, expense lines, approvals) — later specs;
  v1 ships only a placeholder Refund remote.
- Monthly PDF compilation and email — a later spec.
- Any change to backends (estimai-api, refund-api) or moving backends into federation —
  this is a frontend shell only.
- Changes to the sign-in page or adding auth providers — the existing central hosted
  sign-in is reused as-is.
- A visual redesign — the suite keeps the existing design system; no new look.
- Offline support and server-side rendering.
- Responsive / mobile layout of the shell chrome — v1 is desktop-first; the shell's
  header, sidebar, and footer target desktop, and mobile chrome for the suite is deferred
  to a later spec. (EstimAI's own content is unchanged; only the new suite chrome is
  desktop-only.)

## Constraints

_Technical decisions provided by the user; recorded verbatim, to be worked out in the plan._

- Frontend composition uses **Module Federation**, chosen explicitly over a
  separate-SPAs + shared-UI-package approach — capture this decision in an ADR.
- Implemented with **Vite module federation**, **React 19**, **Tailwind CSS 4**, and
  **TanStack Router**.
- Reuse the existing central hosted sign-in and RS256 JWT / JWKS from the auth service
  (ADR-0001, ADR-0002, ADR-0005).
- Keep the **DM Sans / DM Mono / Syne** design system consistent across all remotes.
- Lives inside the existing **operai monorepo**.
- Deploys on **Vercel**.
- Rigor tier: **production**.

## Open questions

None — both questions raised during review were resolved and folded into the acceptance
criteria:
- Footer contents → AC-1.5 (legal link, version, company info).
- Shell header contents → AC-1.4 (logo, About dropdown/dialog, avatar/menu, theme toggle)
  and AC-4.2 (what EstimAI stops rendering vs. keeps). The About dialog is a suite-level
  control owned by the shell; "My Estimates" and the save-status indicator stay in EstimAI.
