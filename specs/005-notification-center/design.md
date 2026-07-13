---
spec: 005
status: draft
---

# Design: Notification center

## Panel-vs-page decision (read this first)

**Decision: full route page only (`/notify`), no bell-anchored dropdown/popover.**

The plan (`plan.md` "Shell changes") already commits to this at the wiring level: `Bell.tsx`'s
`onClick` navigates to `/notify`; there is no panel-open state anywhere in the shell's
described component set. This design ratifies that as the correct call, for reasons beyond
"the plan said so":

1. **Every existing federated remote in this suite mounts through the router's `<Outlet/>`
   inside `<main>`** (`RemoteMount.tsx`, ADR-0006). There is no existing mechanism for a
   remote to render as a floating, bell-anchored overlay outside that content region. Building
   one would be a new federation pattern invented for one feature, not a reuse of the suite's
   established mounting contract — exactly the kind of architecture-level move this stage
   should not make unilaterally.
2. Every AC in US-2/US-3 ("the notification center opens and displays their notifications",
   "opening the notification center marks...read") is satisfied by a page navigation; nothing
   in the spec requires a quick-glance popover.
3. `UserMenu`'s dropdown is the suite's only existing anchored-popover pattern, and it is
   shell-owned chrome with no remote content inside it (a static sign-out menu) — it is not
   evidence that remote-backed dropdowns are an established pattern here.
4. A full-page model also happens to cleanly resolve an ambiguity in AC-3.2 vs AC-3.3 (see
   **Gaps found**, below) — "closed and reopened" and "navigated away and back" collapse into
   the same event when there is no separate panel-open/panel-closed state to track.

Because `/notify` is reachable only from the bell (deliberately not in the sidebar's
permission-gated `TOOLS` list, per plan.md), and the shell's chrome (header incl. bell,
sidebar, footer) persists across every route including `/notify` (`ShellLayout`'s `<Outlet/>`
model), "leaving the center" is just navigating to another tool via the sidebar or the browser
back button — there is no dedicated "close" control to design.

## Flows

Each flow cites the US/AC it satisfies.

### Flow 1 — Bell reflects unread state passively (US-1: AC-1.1–1.6)
1. Shell mounts (any route) → `Bell` renders beside `ThemeToggle` in the header, on every
   route including inside EstimAI/Refund/Admin (AC-1.1).
2. On first mount, the shared SSE manager (shell/session) opens its connection and seeds the
   count from `GET /notifications/unread-count`. Bell shows nothing while that first read is
   in flight (see **Screens & states → Bell → states**) then either no badge (AC-1.3) or the
   formatted count (AC-1.2/1.6).
3. Another app raises a notification for this user while any tab is open → the SSE
   `notification` event increments the shared count → every open tab's `Bell` badge updates
   within ~2s, no reload (AC-1.4, AC-1.5).
4. Count crosses from 9 to 10 → badge switches from "9" to "9+" (AC-1.6, and see the
   **Gaps found** note on the exact 9/10 boundary).

### Flow 2 — Open the center from the bell (US-2: AC-2.1–2.4, entry from US-1)
1. User activates `Bell` (click or Enter/Space while focused) → router navigates to `/notify`.
2. `notify-ui` mounts fresh (its own inner router, per plan.md) → its root page renders its
   `<h1>` immediately and takes programmatic focus (see Accessibility) while `GET
   /notifications` is in flight → **Loading** state.
3. Response resolves:
   - Items present → **Populated** state, newest-first (AC-2.3), each item showing title,
     body/preview, timestamp, read/unread affordance, severity, origin app (AC-2.2).
   - Zero items ever received → **Empty** state (AC-2.4).
   - Request fails → **Error** state with Retry.
4. In parallel with step 3 (not blocking the render): the page captures the set of item ids
   that are unread (`readAt: null`) in the response, calls `resetUnreadCount()` (shell/session
   — instant local badge clear in this tab) and then `POST /notifications/mark-all-read`
   (server truth + `unread-reset` broadcast to sibling tabs) — this is Flow 3, triggered by
   the same page load.

### Flow 3 — Opening the center marks unread as read (US-3: AC-3.1–3.4)
1. Continues from Flow 2 step 4. The captured unread-id set becomes this viewing session's
   "was-unread" set — used only to render the affordance in step 2 below, never sent anywhere.
2. The list renders using that captured set: items in it get the "was-unread" affordance
   (AC-3.2); everything else renders as plain-read.
3. `Bell`'s badge is already zero in this tab (from `resetUnreadCount()`); sibling
   tabs/devices zero out when their SSE connection receives `unread-reset` (AC-3.1).
4. User leaves `/notify` (sidebar click, browser back) and later returns → `notify-ui`
   remounts → Flow 2 runs again from a clean slate: a fresh `GET /notifications`, a fresh
   captured set (now, by construction, only notifications that arrived since the previous
   visit — the previous batch is already `readAt`-set and carries no affordance) (AC-3.3).
5. User clicks the explicit **"Mark all as read"** control at any point while viewing the
   list: the captured "was-unread" set is cleared immediately client-side (every "New" tag
   disappears without waiting for a network round-trip) and `POST
   /notifications/mark-all-read` fires again — a harmless no-op server-side since step 1
   already marked everything read (AC-3.4).

### Flow 4 — Follow a notification's link (US-2 link-out: AC-2.5)
1. User activates an item that carries a `link` (its whole row is a real link — see
   Accessibility) while viewing the populated list.
2. Router navigates to `link.href` (a relative in-suite path — see Security note below).
3. No additional "mark as read" call happens here — the item was already transitioned to
   read the moment the center opened (Flow 3, step 1), consistent with AC-2.5's "the
   notification is already read at this point."

### Flow 5 — Time-sensitive toast (US-5: AC-5.1–5.6)
1. Any app raises a notification with `toast: true` while the user's suite is open (any tab).
2. `notify-api` persists it (durable regardless of toast) and pushes a `notification` SSE
   event carrying `toastWorthy: true`.
3. The SSE manager, in the tab(s) currently open, forwards the event to `ToastHost` → a toast
   appears in whichever app that tab currently has mounted (AC-5.1), stacked above any other
   currently-visible toast.
4. No user action → toast auto-dismisses after its severity's timeout (AC-5.2).
   User dismisses early → toast disappears immediately, does not reappear (AC-5.3).
5. Either way, the notification is already durably in the center in the correct unread state
   (AC-5.4) — dismissing/auto-dismissing/clicking a toast never calls any read-state endpoint;
   only opening `/notify` does (Flow 3). This is a deliberate separation: toast lifecycle and
   read-state lifecycle are independent axes.
6. Not flagged toast-worthy → step 3 never happens for that event; the notification still
   lands in the center only (AC-5.5).
7. User had the suite closed when it was raised, opens it later → on (re)connect the SSE
   manager does not replay past events (SSE is not a durable log — see plan.md R3/R5); no
   toast appears for it, but it is present, correctly unread, when `/notify` is next opened
   (AC-5.6).

### Flow 6 — Raise capability (US-4: AC-4.1–4.5) — no UI surface
This is a library/API capability (`raiseNotification()` in `shell/session`, called by other
apps' own code) consumed programmatically, not through any screen a human operates. The only
user-visible consequence is the notification later appearing via Flow 1/2/5. **Flagging per
the quality bar: AC-4.1–4.5 have no UI surface in this design — they are fully discharged by
plan.md's API contract and the `raiseNotification()` seam.** Validation failures (AC-4.5,
missing title/body → 400) surface to the *raising app's own code*, not to the recipient's UI;
each app author is responsible for handling that error in their own call site (out of scope
for a suite-wide design — no shared UI for it exists to design against).

### Flow 7 — Persistence and account scoping (US-6: AC-6.1–6.3) — no distinct interaction
Also not a distinct interaction flow: it is a guarantee about what Flow 2's `GET
/notifications` returns (always the caller's own data, unchanged by reload/device, per
`sub`-scoping) and about `signOut()`'s existing cache-clearing behavior (already extended, per
plan.md, to close the SSE connection too). The only design-relevant consequence: **the center
must never render from a client cache that could survive a sign-out/sign-in swap** — Flow 2
always fetches fresh on mount, never restores from `localStorage`/module state left over from
a previous user, satisfying AC-6.3 by construction.

## Screens & states

### Bell (shell header chrome)

Sits in `Header.tsx`'s existing `flex items-center gap-3` cluster, between `ThemeToggle` and
`UserMenu` — grouping the two small icon-buttons together, with the (differently-shaped)
avatar/identity control last:

```
[LogoMenu] ...................... [ThemeToggle] [Bell] [UserMenu]
```

- **Shape/chrome**: a `w-7 h-7 rounded-full border border-rule` circular button, matching
  `ThemeToggle`'s exact sizing so the pair reads as one control family. Icon: a simple
  stroke-line bell glyph (new SVG, following `Sidebar.tsx`'s existing icon convention —
  `viewBox 0 0 24 24`, `stroke="currentColor"`, `strokeWidth 1.75`, `aria-hidden`), not an
  emoji glyph — `ThemeToggle` uses text glyphs for a 3-state cycle icon, but a line-art bell
  reads more clearly at 14–16px than an emoji bell would across platforms/fonts.
- **Zero unread** (AC-1.3): plain circular icon button, no badge element rendered at all
  (not a badge showing "0" — literally absent from the DOM, so it can't be picked up by
  screen readers as a stray "0").
- **1–9 unread** (AC-1.2/1.6): a small pill badge overlaps the top-right of the circle
  (`absolute -top-1 -right-1`), showing the exact digit.
- **10+ unread** (AC-1.6, plan's confirmed interpretation): badge shows `"9+"`.
- **Badge color**: `bg-acc` (the suite's brand accent), not `bg-red`. Reasoning: `--red` is
  already the suite's reserved "something is wrong / destructive" color (delete buttons,
  error banners, error toasts — see Component inventory). An unread count is neutral/positive
  information, not an error state, so reusing `--red` here would misrepresent it and dilute
  `--red`'s existing meaning. `--acc` reads as "suite is drawing your attention," consistent
  with how `--acc` is already used for active-nav-item and focus-ring semantics elsewhere.
- **Live update (AC-1.4/1.5)**: the badge is `position: absolute`, so its appearance/count
  change never reflows `ThemeToggle`/`UserMenu` beside it. On the 0→N transition (badge
  appearing) it fades/scales in over ~150ms; on N→M (count changing while already visible)
  the digit cross-fades rather than the whole pill flashing. **Respect
  `prefers-reduced-motion: reduce`**: skip both transitions, badge simply appears/updates
  instantly — this is a new convention for the codebase (no existing component honors
  reduced-motion), introduced here because this is the suite's first *unprompted*,
  live-updating visual change (everything else animates in direct response to a click).
- **Hover/active/focus**: hover mirrors `ThemeToggle` (`hover:border-acc/50 hover:text-acc`).
  Focus adds an explicit `focus-visible:ring-2 focus-visible:ring-acc/50` (mirroring
  `UserMenu`'s ring) — `Bell` is a real `<Link>` (see Accessibility), and the ring must be
  visible even though `ThemeToggle` next to it doesn't currently show one explicitly.

### Notification center page (`/notify`, rendered by `notify-ui`)

Page chrome: a simple root (comparable to `AdminShell` but with no sub-navigation — this is a
single, flat screen, not a sectioned tool) — an `<h1>Notifications</h1>` plus the explicit
"Mark all as read" control in the header row, then the list body below.

- **Loading** (first mount, `GET /notifications` in flight):
  - `<h1>` renders immediately (so focus-on-mount has a target even before data arrives).
  - Skeleton rows in the body (new local port of `SkeletonListRows`'s pattern — see
    Component inventory), with the same `sr-only aria-live="polite"` loading announcement
    convention as `EstimatesPage`/`RemoteMount`.
- **Populated**: newest-first list (AC-2.3). Each row shows (AC-2.2):
  - severity icon (aria-hidden) + sr-only severity label
  - title (bold when "was-unread" this session, regular otherwise)
  - body/detail (or a truncated preview with the full text available via the row itself —
    there is no separate "detail" screen/dialog in v1; the row *is* the detail, matching the
    spec's "body/detail (or a preview of it)" phrasing)
  - origin-app tag (small muted mono label, e.g. "EstimAI")
  - a `<time dateTime="2026-07-13T09:14:00Z" title="13 Jul 2026, 09:14">2m ago</time>` —
    relative label for scannability, exact ISO 8601 timestamp in `dateTime` (semantic) and a
    human-formatted absolute time in `title` (available on hover/inspection) — satisfies
    AC-2.2's "a timestamp" without forcing a choice between relative-only (loses precision)
    and absolute-only (harder to scan a long list)
  - "was-unread" affordance (see next bullet) — not present on plain-read rows
  - optional link/action: when present, the entire row is a real `<Link to={link.href}>`
    rendering `link.label` as its call-to-action text (AC-2.5, AC-4.3); when absent, the row
    is a static (non-interactive) container
- **"Was-unread" affordance** (AC-3.2), designed to not rely on color alone:
  1. A visible small text tag reading **"New"** to the left of the title (not just a colored
     dot) — `--acc`-colored, `1px solid` pill, tiny (`text-[10px]`)
  2. The title renders at a heavier font-weight (`font-semibold` vs `font-normal`)
  3. A `2px` `--acc`-colored left border accent on the row
  4. A visually-hidden `"New: "` prefix inside the row's accessible text, read before the
     title by assistive tech (so the cue survives even for AT users who don't perceive the
     tag/weight/border visually) — the sr-only version is the mechanism that actually
     satisfies "not reliant on color alone" for screen-reader users; (1)–(3) are three
     different *visual* channels (text, weight, border) so no single CSS property carries the
     entire signal for sighted users either
  Plain-read rows render none of the above — same layout, no tag/no bold/no left border.
- **Empty** (AC-2.4) — a user who has never received a notification. Recipe reused from
  `EstimatesPage`'s empty state (icon + `font-disp` heading + muted description,
  centered) — new local composition (cross-remote import is not possible per ADR-0006, so
  this is a fresh implementation of the same recipe, not a shared component): "Nothing here
  yet" / "You'll see notifications from EstimAI, Refund, and the rest of the suite here as
  they happen." No CTA button — there is no action to take from an empty notification list.
- **Error** (list fetch failed): `role="alert"` banner, `border-org/40 bg-org/10 text-org`
  (the suite's existing alert idiom — `ErrorBanner`/`RemoteMount`'s error fallback), message +
  Retry button that re-fires `GET /notifications`.
- **"Mark all as read" control**: always visible in the header row, always enabled (never
  disabled/hidden based on current unread count — AC-3.4 explicitly wants it available even
  when it would be a no-op). On click: clears the local "was-unread" set immediately (every
  "New" tag disappears without waiting on the network) and fires `POST
  /notifications/mark-all-read` for server-side correctness.

### Toast (`ToastHost`, shell-chrome overlay)

- **Position**: fixed, top-right of the viewport, above whichever remote is currently
  mounted (`ToastHost` lives in `ShellLayout`, sibling to `<main>`, so it overlays every tool
  uniformly — same "one shell-owned host" reasoning plan.md already gives). Top-right is
  chosen specifically to avoid two existing bottom-right fixtures already established in the
  suite (`EstimatesPage`'s "+ New Estimate" FAB) and the footer strip along the bottom edge.
- **Stacking**: newest toast appears at the top of the stack, existing toasts shift down.
  Visually capped at ~4 simultaneously visible (given each auto-dismisses within
  6–10s, overflow beyond that is an edge case, not a primary design target) — a 5th
  concurrent toast is deferred (queued) rather than overflowing the viewport.
- **Anatomy** (per severity), directly reusing `ToastBanner`'s established visual recipe
  (border-left accent + tinted background + a subtle "×" dismiss) generalized to 4 variants
  and a floating/stacked container instead of a single persistent inline strip:

  | Severity | Icon (aria-hidden) | Accent token | ARIA live semantics |
  |---|---|---|---|
  | info | ⓘ (info glyph) | `--acc` | `role="status"` (polite) |
  | success | ✓ | `--grn` | `role="status"` (polite) |
  | warning | ⚠ | `--org` | `role="alert"` (assertive) |
  | error | ✕ | `--red` | `role="alert"` (assertive) |

  Reasoning for the polite/assertive split: `role="alert"`+assertive interrupts whatever the
  screen reader is currently announcing, which is appropriate for warning/error (the whole
  point of a time-sensitive alert is to interrupt) but would be needlessly disruptive for
  routine info/success pings — mirrors ordinary toast-library convention, and directly
  satisfies the brief's "role/aria-live... by severity, not color-only."
- **Content**: icon, title (bold), body, optional action (the notification's `link.label` as
  a real link/button — navigates to `link.href`, then dismisses that toast; does **not** call
  any read-state endpoint — see Flow 5 step 5), a dismiss "×" button.
- **Auto-dismiss** (AC-5.2): every severity auto-dismisses (the AC does not carve out an
  exception for error, unlike `ToastBanner`'s existing "the 413 toast does not auto-dismiss"
  precedent, which belongs to a different, unrelated feature) — 6s for info/success, 8s for
  warning, 10s for error (longer for the more consequential ones, but always finite).
  **Pauses on hover/keyboard focus** (WCAG 2.2.1, "timing adjustable" — a good-practice
  addition the brief's "toasts must be accessible" calls for even though no AC states it
  explicitly) and resumes on blur/mouse-leave.
- **Manual dismiss** (AC-5.3): the "×" button is a real, keyboard-focusable `<button
  aria-label="Dismiss notification">`; Escape while a toast (or its action link) has focus
  also dismisses it, mirroring the Escape-to-cancel convention already used by
  `AboutModal`/`ConfirmDeleteModal`.
- **Entrance/exit motion**: slide/fade in from the top on appearance, fade out on dismiss —
  collapses to instant show/hide under `prefers-reduced-motion: reduce` (same posture as the
  Bell badge).

## Component inventory

Library in use: hand-rolled components + Tailwind CSS 4, styled from `shell/tokens.css`'s
shared `@theme`/CSS-custom-property design tokens (no Mantine/MUI/etc. — this is a bespoke,
already-adopted system). Two authoring conventions coexist in the repo and both are legitimate
to keep using: Tailwind utility classes with the `@theme`-derived color classes (`text-org`,
`border-rule`, `bg-acc/20`, …) where the consuming remote is compiled through the shell's
single Tailwind sheet (shell + estimai-ui), and inline `style={{ color: 'var(--x)' }}` +
generic layout utilities where it isn't (admin-ui's own build never processes
`shell/tokens.css`'s `@theme` block, so its components read the raw CSS custom properties
instead — see `ConfirmDeleteModal.tsx`'s documented reasoning). `notify-ui` is a clone of
`admin-ui` per plan.md, so its new components should follow **admin-ui's** convention
(inline `style` + `var(--x)`), while shell-owned pieces (`Bell`, `ToastHost`) follow
**shell's own** convention (Tailwind color-utility classes), matching each one's actual build.

| Element | Source | Reuse / NEW |
|---|---|---|
| Bell button chrome (circular icon button sizing/border/hover) | `shell/src/components/ThemeToggle.tsx` | **Reuse** (identical class recipe: `w-7 h-7 rounded-full border border-rule text-muted hover:border-acc/50 hover:text-acc transition-colors`) |
| Bell glyph (SVG bell icon) | new | **NEW** — no existing bell/notification glyph in the icon set; follows `Sidebar.tsx`'s existing stroke-icon convention (viewBox/stroke/aria-hidden), so the *style* is reused even though the specific glyph is new |
| Unread-count badge (pill overlay) | new | **NEW** — no existing numeric-badge-on-icon-button component; nearest relative is `WarningBadge` (icon+tooltip) which is a different shape (no count, no live update) and lives in estimai-ui (cannot cross-import per ADR-0006) |
| Focus ring on Bell | `shell/src/components/UserMenu.tsx` (`focus-visible:ring-2 focus-visible:ring-acc/50`) | **Reuse** |
| Bell active-link mechanics (real `<Link>`, not `<button>`) | `shell/src/components/Sidebar.tsx` (`<Link>` entries) | **Reuse** of the pattern (real anchor for navigation, not a `<button>`/`<div>`) |
| `ToastHost` container (fixed overlay, mounted once in `ShellLayout`) | new | **NEW** — the suite's first floating/stacked toast surface; `ToastBanner` (estimai-ui) is a single persistent *inline* banner with no stacking, no auto-dismiss timer, no portal — a genuinely different shape, not a drop-in reuse |
| Toast visual recipe (border-left accent strip, tinted background, "×" dismiss, `role="alert"`) | `estimai-ui/src/components/ToastBanner.tsx` | **Reuse of the recipe**, generalized to 4 severities + `role="status"`/`"alert"` split + stacking (new local implementation inside `ToastHost`, since `ToastBanner` itself isn't shaped for stacking/auto-dismiss and can't be imported cross-remote anyway) |
| Severity icon/color mapping (info/success/warning/error → icon+token) | new | **NEW** table, but built entirely from existing tokens (`--acc`/`--grn`/`--org`/`--red`) — same *pattern* as `healthWarnings.ts`'s `WARNING_META` (code → icon/colorClass/copy lookup), not importable (different domain, different remote) |
| `NotificationCenterPage` root (`<h1>` + header-row action + list) | new | **NEW** page, shaped like `AdminShell`/`EstimatesPage`'s header-row-plus-content layout (reused *pattern*, not code) |
| Programmatic heading focus on mount | `admin-ui/src/pages/NotFoundPage.tsx`, `shell/src/components/NoAccessScreen.tsx`, `admin-ui/src/components/PermissionDenied.tsx` | **Reuse** of the established "entry-point page focuses its own `<h1>` via `tabIndex={-1}; ref.current?.focus()`" convention |
| List loading skeleton | `admin-ui/src/components/SkeletonListRows.tsx` / `estimai-ui/src/components/SkeletonListRows.tsx` | **Reuse of the recipe** — a third, local port (same precedent: admin-ui's copy is already documented as a "near-verbatim re-authoring" of estimai-ui's, because cross-remote import isn't possible) |
| List error banner + Retry | `admin-ui/src/components/ErrorBanner.tsx` / `EstimatesPage`'s inline list-error block | **Reuse of the recipe**, new local port |
| Empty state (icon + heading + description, centered) | `estimai-ui/src/pages/EstimatesPage.tsx` (its "Ready to estimate your first project?" empty state) | **Reuse of the recipe**, new local composition with feature-appropriate copy |
| `NotificationItem` row (severity, title, body, origin tag, `<time>`, was-unread affordance) | new | **NEW** — no existing row shape carries this exact field set; layout recipe borrows `EstimatesPage`'s list-row spacing/border/hover treatment (`rounded-md border border-rule bg-ink-soft hover:border-acc/40`) |
| Whole-row real `<Link>` for items with an action | `Sidebar.tsx`/`SectionNav.tsx`'s "always a real anchor for navigation" convention | **Reuse of the convention**, deliberately *improving* on `EstimatesPage`'s existing row pattern (a `<div onClick>` paired with a separate keyboard-accessible "Open" button) — here the whole row itself is the real, natively keyboard-operable anchor, so there's no div/button split to maintain |
| "Mark all as read" button | `admin-ui/src/components/Pagination.tsx` / `EstimatesPage`'s header-row button styling (bordered text button) | **Reuse** of the button recipe |
| `<ul role="list">` list-semantics guard | new (but a well-known cross-browser fix-up, not a novel pattern) | **NEW** usage in this codebase — flagged because `list-style: none` (Tailwind's preflight) strips list semantics in Safari/VoiceOver; explicit `role="list"`/`role="listitem"` restores it |

**Reuse/NEW ratio: 12 reuse (recipe or literal) : 5 NEW** (Bell glyph, unread badge, `ToastHost`
container, severity icon/color table, `NotificationItem` row — the five genuinely new shapes;
everything else either reuses an exact class recipe or a well-established structural pattern
already used at least twice elsewhere in the repo).

## Accessibility

- **Bell**:
  - Rendered as a real `<Link to="/notify">` (navigation, not a disclosure widget) — no
    `aria-expanded`/`aria-haspopup` (those apply to `UserMenu`'s dropdown, not this button;
    see the panel-vs-page decision above for why no popover exists to describe).
  - Accessible name: a static `aria-label="Notifications"` on the link itself (the badge's
    digit content is `aria-hidden` — decorative for sighted users, not meant to be read as
    part of the button's name every time it renders, which would make the name change on
    every SSE update and confuse repeated-visit navigation).
  - Unread-count *changes* are additionally announced via a separate `sr-only
    aria-live="polite"` region next to (not inside) the button, updated to e.g. "3 unread
    notifications" (or removed entirely at 0) whenever the count changes — so a screen-reader
    user gets the same near-real-time awareness (AC-1.4/1.5) a sighted user gets from the
    badge appearing, without the button's own name/role being re-announced on every push.
  - Keyboard: native anchor — Tab reaches it in normal document order (between `ThemeToggle`
    and `UserMenu`), Enter activates it. No custom key handling needed.
- **Notification center page**:
  - `<h1>Notifications</h1>` takes programmatic focus on mount (`tabIndex={-1}`, `.focus()`
    in a `useEffect`) — the established repo-wide convention for pages reached by
    navigation rather than in-page state change (`NotFoundPage`, `NoAccessScreen`,
    `PermissionDenied`), so assistive tech announces "Notifications" immediately after the
    bell activation, without a manual "skip to heading" step.
  - No focus trap and no ESC-to-close: this is an ordinary route, not a modal/popover — ESC
    has no special meaning here (native browser/OS behavior applies, if any).
  - `<ul role="list">` / native `<li>` for the list; `role="list"` guards against Safari/
    VoiceOver's list-semantics-stripping behavior when `list-style: none` is applied (Tailwind
    preflight resets it by default).
  - Each row's accessible text order: sr-only `"New: "` prefix (only on was-unread rows) →
    severity sr-only label (e.g. `"Severity: warning"`) → title → body → origin app → time.
    Rows with a link are wrapped in a single `<Link>` so the entire row is one operable,
    natively-tabbable unit (Tab moves row-to-row for linked rows only; non-linked rows are
    static content, read but not a tab stop — consistent with "don't make non-interactive
    content focusable").
  - Loading/populated/empty transition all keep the same `aria-live="polite"` sr-only
    announcement convention already used by `EstimatesPage`/`RemoteMount`/`Pagination`
    ("Loading your notifications" → "N notifications loaded" / "No notifications yet").
  - Error state: `role="alert"` (assertive — a failed fetch is worth interrupting for, same
    posture as every other error banner in the repo).
  - "Mark all as read": a real `<button>`, always focusable/operable regardless of whether
    it's currently a no-op (never `disabled` — a disabled-but-visible control is a common
    trap for keyboard/AT users; per AC-3.4 it must remain a harmless, always-available
    no-op, so it should never appear broken/unavailable).
- **Toasts** (`ToastHost`):
  - `role="status"` (info/success, polite) vs `role="alert"` (warning/error, assertive) — see
    Screens & states table above; never conveyed by color alone (icon + text label always
    present; the sr-only sequence reads icon-label → title → body → action, if any).
  - Every toast's dismiss "×" is a real, keyboard-focusable `<button aria-label="Dismiss
    notification">`; Escape while any part of the toast has focus dismisses it (mirrors
    `AboutModal`/`ConfirmDeleteModal`'s Escape convention).
  - Auto-dismiss timer **pauses on hover or keyboard focus**, resumes on blur/mouse-leave
    (WCAG 2.2.1 timing-adjustable) — otherwise a screen-reader or keyboard user who tabs onto
    a toast to read/act on it could have it vanish out from under them mid-interaction.
  - New toasts must not steal focus (a toast popping in while the user is mid-task in
    EstimAI/Refund/Admin should never yank keyboard focus away from what they're doing) —
    only its live-region role announces it; focus only moves if the user deliberately Tabs
    to it.
- **Motion**: Bell badge appearance/update and toast entrance/exit both respect
  `prefers-reduced-motion: reduce` (instant, no transition) — a new convention for this
  codebase (nothing else here currently branches on it), introduced specifically because these
  are this feature's *unprompted* visual changes (everything else in the suite today animates
  in direct, expected response to a user's own click).
- **Color is never the sole signal**: severity (icon + sr-only label, not just a colored dot),
  was-unread (text tag + font-weight + border, not just an accent color), and toast urgency
  (role/aria-live split, not just color) each carry at least one non-color channel, per the
  brief's explicit requirement.

## Gaps found (spec/plan, not designed around)

1. **AC-3.2 vs AC-3.3 tension on "reopened without an intervening reload."** AC-3.2 says the
   was-unread affordance survives when the center "stays open, or is reopened without an
   intervening reload"; AC-3.3 says it is cleared when the center is "closed and reopened."
   Read literally, these conflict for the exact case of leaving and returning to the center
   within the same tab session (no browser reload) — 3.2 says keep it, 3.3 says clear it.
   **This design resolves it by treating every navigation *to* `/notify` as a fresh viewing
   session** (Flow 3, step 4): under the locked page-only architecture (see decision above),
   there is no distinct "panel toggled closed then reopened, still same page" event separate
   from "navigated away and back" — the two ACs' scenarios collapse into one real event, and
   this design picks AC-3.3's outcome for it (fresh capture per visit), because that is also
   the natural, no-extra-plumbing behavior of component-local React state remounting on route
   re-entry. AC-3.2's clause most plausibly reads as protecting the "the page is still
   mounted, nothing navigated away" case, which this design honors literally. **Recommend the
   PO/architect confirm this reading**, or amend AC-3.2's wording — it reads as if it were
   drafted with a togglable panel in mind (where "reopen without reload" is a real, distinct
   event from "navigate away"), which the locked page-only shape doesn't have.
2. **AC-1.6 / Constraint 6's "1 through 9... 9 or more" overlap at exactly 9** was already
   flagged by plan.md as needing PO confirmation (it adopted "1–9 exact, 10+ → 9+"). This
   design follows the plan's interpretation without re-litigating it, but the confirmation is
   still outstanding as of this writing — flagging so it isn't lost between plan and
   implementation.
3. **AC-4.5's "rejected and reported back to the raising app"** has no suite-wide UI to design
   against (Flow 6) — each app author's own code is responsible for surfacing that 400 to
   its own user, in its own app's idiom. Worth the architect/PO noting this explicitly
   somewhere (a raising-app integration guide?) so a future app author doesn't assume
   `notify-api` silently handles it.
4. **No scope creep introduced.** One tempting addition was deliberately *not* designed in:
   giving `Bell` an "active" visual state (à la `Sidebar`'s `activeProps`) when the user is
   currently on `/notify`. No AC asks for it, and `/notify` isn't in the sidebar's tool set to
   begin with, so there's no existing "which section am I in" convention this would even be
   completing. Noting it here as a candidate polish item for a later pass, not as part of this
   design.
