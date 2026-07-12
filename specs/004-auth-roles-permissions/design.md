---
spec: 004
status: draft
---

# Design: Authorization — roles, departments & fine-grained permissions

Component library in use: **Tailwind CSS 4** utility classes driven by the shared
`shell/tokens.css` `@theme` block (DM Sans / DM Mono / Syne, dark-ink palette + light
override) — no headless/Mantine/MUI component kit anywhere in the repo. Every existing
screen (shell, estimai-ui) is hand-built markup + Tailwind utilities + a handful of local,
hand-rolled patterns (table via TanStack Table, modal via a `role="dialog"` + focus-trap
`useEffect`, no `react-error-boundary`/`react-modal`/etc.). **admin-ui inherits this same
approach** — no new dependency is justified by this feature. Per ADR-0006, `admin-ui` is a
**new federated remote** that consumes `shell/tokens.css` + `shell/session` at runtime but
cannot *import* components from `shell/` or `estimai-ui/` (separate builds/bundles) — so
even a component that is conceptually "the same as" an existing one must be re-authored as
its own file inside `admin-ui`. Reuse in this design therefore means two different things,
called out explicitly per entry:
- **Reuse (shared)** — literally the same component instance, still resides in `shell/`,
  imported/rendered unchanged (Sidebar, Header, ShellLayout, RemoteMount, tokens.css…).
- **Reuse (ported pattern)** — a new file inside `admin-ui`, but a near-verbatim copy of an
  existing shell/estimai-ui component's markup, props shape, states, and a11y contract
  (ConfirmDeleteModal, ToastBanner, SkeletonListRows). Counted as NEW in the file-count
  ratio (it's a new file admin-ui must ship and maintain) but explicitly *not* a novel
  design — implementation should copy, not reinvent.

---

## Flows

Each flow lists entry → steps → success/error exits, with US/AC references.

### F1 — Bootstrap admin, first sign-in (US-6)
1. A fresh deployment has `BOOTSTRAP_ADMIN_EMAIL` configured (plan, no UI).
2. That person signs in via the existing hosted sign-in page (ADR-0002) — unchanged screen.
3. On session creation, the `auth` service's `databaseHooks.user.create.after` assigns
   `employee` (AC-6.3) and, because the email matches, also `admin` (AC-6.1) — no UI step.
4. Shell loads `/authz/me`; `apps` now includes `admin` (among others) → **Sidebar shows an
   "Admin" entry** (AC-7.2) with no manual DB edit required anywhere in the path.
5. Clicking "Admin" mounts `admin-ui`, landing on **Screen A1 (Roles list)**.

*No dedicated screen — this flow is entirely: existing sign-in page → existing Sidebar →
existing RemoteMount. The only observable UI change is the Admin entry appearing, covered by
F7 below.*

### F2 — Admin manages roles (US-1, US-2, US-3)
Entry: Sidebar → Admin → **Screen A1 (Roles list)**.
1. Admin sees system roles (`employee`, `admin`, `accounting`, `hr` — AC-6.2) and any custom
   roles (AC-2.4), each tagged `System` or not.
2. **Create:** "+ New role" → **Modal M1 (Create role)** (name, description) → `POST
   /admin/roles` → `201` → navigate to **Screen A2 (Role editor)** for the new id, empty
   rule set (AC-1.1, AC-2.4).
   - Error: `409` duplicate name → inline field error on the modal, modal stays open.
3. **Rename:** inline edit on Screen A1 or a field on Screen A2 → `PATCH /admin/roles/:id`
   → list/header updates (AC-1.1).
4. **Compose rules (the hard part, AC-2.1–2.3):** on Screen A2, "+ Add rule" opens the
   **Rule composer** (inline row, not a separate modal — see Screen A2 below):
   a. Pick **Resource** from a catalog-driven, app-grouped select (`GET /admin/catalog`,
      AC-3.1) — only resources some app has declared are selectable (AC-2.1/3.2 by
      construction: the client cannot render an off-catalog option).
   b. Pick **Action** — options are exactly that resource's catalog actions; resets when
      Resource changes.
   c. **Conditions** panel updates to show only the condition controls the chosen action's
      `supportedConditions` allows (AC-2.3): an *Ownership* radio group (Any records / Own
      records only — AC-2.2) if `"ownership"` is supported, and *Attribute* checkboxes
      (Entity / Department / Job title — AC-2.3) for whichever of those three appear in
      `supportedConditions`. If none apply, the panel shows "No conditions apply to this
      action."
   d. "Add" appends the composed rule to the role's in-progress rule list (client-side
      draft); "Save rules" persists the whole set via `PUT /admin/roles/:id/rules`
      (AC-2.1–2.3).
   - Error: `422` (off-catalog pair, or a condition not in `supportedConditions` — should be
     unreachable via the UI's own choices, but the catalog can drift between page-load and
     save) → inline banner above the rule list: "One or more rules reference a permission
     that no longer exists — reload the catalog and try again," with a "Reload catalog"
     action (AC-3.2).
5. **Delete:** "Delete role" on Screen A2 → if `isSystem` the button is disabled with a
   tooltip ("System roles can't be deleted") — client-side guardrail mirroring the server's
   `422`; for a custom role, opens **Dialog D1 (confirm delete)** → `DELETE
   /admin/roles/:id` → back to Screen A1 (AC-1.1).
   - Error: if the disabled-button guardrail is ever bypassed (stale UI state) the `422`
     surfaces as a **Dialog D2 (guardrail blocked)** instead of silently failing.

### F3 — Admin manages departments (US-1)
Entry: Sidebar-equivalent admin nav → **Screen B1 (Departments list)**.
1. Create → **Modal M2** (name, description) → `POST /admin/departments` → **Screen B2
   (Department detail)** (AC-1.2).
   - Error: `409` duplicate name → inline field error.
2. On Screen B2: **"Roles conferred"** — multi-select of existing roles (from Screen A1's
   data) → `PUT /admin/departments/:id/roles` (AC-1.2, "members inherit the department's
   roles").
   - Error: `422` unknown role (stale multi-select) → inline banner, re-fetch roles.
3. On Screen B2: **"Members"** panel lists users currently in the department and lets the
   admin add/remove members — see the drift note under Gaps: the plan's contract table has
   no department-scoped member list/add endpoint, only the user-scoped `PUT
   /admin/users/:id/departments`. Designed against the assumption that `GET
   /admin/departments/:id` embeds a `members` list; **flagged, not assumed correct** (see
   "Gaps, scope notes & drift").
4. Delete → **Dialog D1** → `DELETE /admin/departments/:id` → back to Screen B1.

### F4 — Admin manages users (US-1, US-6 guardrail)
Entry: admin nav → **Screen C1 (Users list)**.
1. Search/filter by name or email (client-side query param `?q=`, see Gaps — not in the
   plan's contract table) → `GET /admin/users` (paginated).
2. Select a user → **Screen C2 (User detail)**: identity (name/email, read-only), `entity`
   (select: WellD CH / WellD Italia), `jobTitle` (text), assigned roles (direct), assigned
   departments.
3. **Set attributes:** edit `entity`/`jobTitle` → Save → `PATCH /admin/users/:id` (AC-2.3
   depends on these being set for attribute-conditioned rules to mean anything).
4. **Assign/revoke roles or departments:** multi-select → Save → `PUT
   /admin/users/:id/roles` or `.../departments` (AC-1.3, AC-1.4). Effective immediately
   (AC-4.3) — no separate "publish" step; the epoch bump + live `/authz/me` is invisible to
   the admin UI, just described in a short "Effective immediately" hint near Save.
   - **Guardrail (AC-6.4):** if this save would remove the last `admin`-holding user's admin
     role/department, the request returns `422`. Because the client cannot always know this
     in advance (the last admin's admin-ness might come transitively through a department),
     this is caught **after** Save attempt and shown as **Dialog D2 (guardrail blocked)**:
     "This is the last administrator — removing this role would leave nobody able to manage
     access. Assign another admin first." No silent retry; the in-progress edit is preserved
     so the admin can adjust and retry.

### F5 — Create a custom role (US-2, AC-2.4)
Same screens as F2 steps 1–4 (Screen A1 → Modal M1 → Screen A2 rule composer). No separate
flow/screen — a custom role IS just a role with `isSystem:false`, and Screen A2 renders
identically for both (system roles simply can't be deleted/renamed if the plan later
restricts renaming system roles — the spec only forbids *delete* of system roles, so rename
is left enabled for both per AC-1.1's plain reading).

### F6 — View audit history (US-5)
Entry: admin nav → **Screen D1 (Audit log)**.
1. Paginated, reverse-chronological list: timestamp, actor, action (e.g. `role.create`,
   `user_role.revoke`), target, summary (AC-5.1, AC-5.2).
2. Expand a row → shows the `data` before/after diff.
3. No edit/delete affordance anywhere on this screen — immutability (AC-5.3) is enforced by
   omission, not a disabled button (a disabled button would incorrectly imply mutation is
   *sometimes* possible).

### F7 — Non-admin reaches the Admin tool (US-1, AC-1.5)
Two independent layers, both designed:
1. **Shell layer (primary, US-7 mechanism):** a non-admin's `/authz/me.apps` doesn't include
   `admin` → Sidebar never renders the Admin entry (AC-7.1) → and the shell's tool-route
   guard blocks a typed/deep-linked `/admin/...` URL, redirecting to the user's
   default/permitted tool or **Screen S1 (shell `/no-access`)** if they have no apps at all
   (AC-7.3/7.4, shared with F8).
2. **admin-ui/API layer (defense in depth, AC-1.5's literal ask — "attempt to call its
   management APIs"):** if a session's admin access is revoked *while admin-ui is already
   mounted* (race with the shell's per-navigation revalidation), the next `/admin/*` call
   returns `403`. admin-ui renders **Screen E1 (Permission denied, in-place)** instead of a
   raw error or a crash — same in-place-failure philosophy as `RemoteMount`'s error boundary,
   but for an authorization failure rather than a load failure.

### F8 — Employee with zero app access (US-7, AC-7.4)
Entry: sign-in completes, shell loads `/authz/me`, `apps: []`.
1. Root `/` redirect (existing `resolveLastToolPath` logic) has nothing to redirect to —
   **Screen S1 (`/no-access`)** renders directly instead of any tool.
2. Chrome (Header/Footer, per ShellLayout's AC-1.2 "chrome must not remount") stays mounted
   — the user can still sign out via the existing UserMenu, see the existing About dialog,
   toggle theme — only the tool content area shows the empty state.
3. If access is later granted and the user refreshes/navigates, the guard resolves the new
   `apps` set (AC-7.5) and either lands them on a real tool or keeps showing Screen S1 if
   still empty.

---

## Screens & states

Legend: **L**oading, **E**mpty, **P**opulated, **Err**or (RFC 7807), **403** permission
denied, **G**uardrail-blocked.

### Screen A1 — Roles list
- **Purpose:** browse all roles; entry point to create/edit/delete (AC-1.1).
- **Key elements:** table (Name, Description, System badge, rule count, Edit/Delete
  actions); "+ New role" button.
- **L:** skeleton rows (ported `SkeletonListRows` pattern).
- **E:** shouldn't realistically occur (4 seed roles always exist post-bootstrap, AC-6.2) —
  still designed defensively: "No roles yet" + "+ New role" (never a dead end).
- **P:** sortable by name; System roles show a lock glyph + "System" badge (not delete-able,
  AC-1.1 implicitly protects seed roles from accidental removal) and a disabled Delete
  button with `title="System roles can't be deleted"`.
- **Err:** RFC 7807 `detail` in a `role="alert"` banner + Retry (mirrors
  `EstimatesPage`'s list-error pattern).
- **403:** Screen E1 in place of the table (only reachable per F7's race-condition path).

### Screen A2 — Role editor / rule builder (hardest screen)
- **Purpose:** name/description edit + build the role's rule set from the catalog
  (AC-2.1–2.4).
- **Key elements:**
  - Header: role name (inline-editable text), description, System badge if applicable,
    Delete button (disabled + tooltip if System).
  - **Rule list:** each existing rule shown as a row — Resource·Action (e.g. "estimate ·
    edit") + condition badges ("Own records" / "Entity" / "Department" / "Job title") +
    a Remove "×". Mirrors `ActivityTable`'s row-based feel (label + right-aligned meta +
    trailing delete) without the drag/keyboard-grid machinery that table doesn't need here.
  - **Rule composer** ("+ Add rule", expands inline, collapses on Add/Cancel):
    - Resource `<select>`, grouped by app (`<optgroup label="EstimAI">`, etc.), sourced from
      `GET /admin/catalog` (AC-3.1). Only catalog resources appear (AC-2.1).
    - Action `<select>`, re-populated (and reset) whenever Resource changes; only that
      resource's catalog actions appear (AC-2.1, AC-3.2 — an off-catalog pair simply cannot
      be constructed via this UI).
    - Conditions `<fieldset>` with a `<legend>Conditions</legend>`:
      - Ownership: `role="radiogroup"`, "Any records" (default) / "Own records only"
        (AC-2.2) — rendered only if the selected action's `supportedConditions` includes
        `"ownership"`.
      - Attribute: up to three checkboxes (Entity / Department / Job title — AC-2.3),
        rendered only for the entries present in `supportedConditions`.
      - If `supportedConditions` is empty for the chosen action (e.g. `access`), the
        fieldset shows a single muted line: "This action has no conditions."
    - "Add rule" (disabled until Resource + Action are both chosen) appends to the draft
      list; "Cancel" collapses the composer without adding.
  - Footer: "Save rules" (persists the whole draft list via `PUT /admin/roles/:id/rules`) /
    "Discard changes".
- **L:** skeleton while `GET /admin/roles/:id` + `GET /admin/catalog` resolve.
- **E:** zero rules yet — the rule list area shows "No rules yet — every user with this role
  has no permissions until you add one," never blocking the composer itself.
- **P:** rule list + composer as above.
- **Err:** catalog fetch failure → the whole rule-composer is disabled (can't build rules
  against data that failed to load) with a `role="alert"` banner + Retry, but the existing
  rule list (if already loaded) still renders read-only.
- **G/Err on save:** `422` (stale catalog reference, AC-3.2) → inline banner above the rule
  list, "Reload catalog" action; draft is preserved so nothing typed is lost.

### Screen B1 — Departments list
- **Purpose:** browse/create/delete departments (AC-1.2).
- **States:** L/E/P/Err mirror Screen A1 exactly (same list pattern, no System-role
  equivalent — departments have no seed/system distinction requiring protection beyond the
  seed `hr` department, which the spec explicitly says "has no special default powers" —
  i.e. it's an ordinary, deletable department, so no lock badge here).

### Screen B2 — Department detail
- **Purpose:** name/description, roles conferred, members (AC-1.2).
- **Key elements:** name/description (inline-editable), "Roles conferred" multi-select +
  Save, "Members" panel (list + add/remove — see Gaps note on the missing department-scoped
  member endpoint).
- **L/E/P/Err:** standard; **E** for Members = "No members yet" with an "Add member" action
  that opens a user-search picker (reuses the Users-list search pattern, not a new pattern).

### Screen C1 — Users list
- **Purpose:** search/browse users (AC-1.3, AC-1.4 entry point).
- **Key elements:** search input (name/email), paginated table (Name, Email, Entity, Job
  title, role/department chip counts), row → Screen C2.
- **L:** skeleton rows. **E:** "No users match your search" (search-scoped empty state,
  distinct copy from a true zero-users case, which can't happen post-sign-in since every
  signed-in user gets `employee`, AC-6.3). **P:** as above, with pagination controls
  (Previous/Next, "Page N of M", each button `aria-disabled` at the bounds). **Err:**
  standard RFC 7807 banner + Retry.

### Screen C2 — User detail
- **Purpose:** view/edit one user's attributes, roles, departments (AC-1.3, AC-1.4, AC-2.3
  attribute targets, AC-6.4 guardrail surface).
- **Key elements:** identity header (name/email/avatar, read-only), `entity` select,
  `jobTitle` text, "Direct roles" multi-select, "Departments" multi-select, Save.
- **L/E/P/Err:** standard.
- **G:** guardrail-blocked save (AC-6.4) → **Dialog D2**, described in F4. The in-progress
  edit (the multi-select's pending state) is NOT reset when the dialog is dismissed, so the
  admin can immediately adjust (e.g. keep `admin` checked) and retry Save.

### Screen D1 — Audit log
- **Purpose:** read-only chronological review (AC-5.1–5.3).
- **Key elements:** paginated table (Timestamp, Actor, Action, Target, Summary), row
  expand → before/after diff. No mutate affordance anywhere (enforces AC-5.3 by omission).
- **L/E/P/Err:** standard; **E** = "No authorization changes recorded yet" (only possible
  immediately post-bootstrap, before the admin does anything).

### Dialog D1 — Confirm delete (role / department)
- Ported pattern from `estimai-ui/ConfirmDeleteModal` (idle / deleting / error states,
  Cancel-default-focus, Escape = Cancel, focus-trapped Tab). Per the prompt's a11y bar for
  this feature specifically, re-authored here with `role="alertdialog"` rather than
  `role="dialog"` (see Accessibility section for why) — otherwise identical contract.

### Dialog D2 — Guardrail blocked (system-role delete race, last-admin removal)
- **New** dialog shape: single message + single "OK" acknowledgement (no "proceed anyway" —
  the action is genuinely blocked server-side, there is no override). `role="alertdialog"`,
  `aria-describedby` on the message, default focus on "OK". Distinct from D1 because there is
  no destructive action to confirm — only a fact to acknowledge.

### Screen E1 — Permission denied (in-place, admin-ui)
- **Purpose:** an admin API call returns `403` after admin-ui is already mounted (the F7 race
  case). Renders in place of the affected screen's content — chrome/nav around it stays
  intact, mirroring `RemoteMount`'s "a failure here only replaces the content subtree"
  philosophy, applied to authorization instead of load failure.
- **Content:** "You no longer have admin access. If this is unexpected, contact your
  administrator." No Retry button (retrying won't change a `403` — unlike a network error,
  this is a deliberate state); the correct recovery is navigating away, which the still-live
  shell chrome allows.

### Screen S1 — Shell `/no-access`
- **Purpose:** AC-7.4 — a user with zero app access sees a clear, non-broken state.
- **Content:** centered heading ("No apps available yet"), one line of explanation ("Ask
  your administrator to grant you access to a tool."), no dead-end — the surrounding
  chrome (Header/Footer) remains fully interactive per ShellLayout's persistent-chrome
  design. Rendered inside the shell's existing `<main>` (no new landmark).
- **A11y:** heading receives focus on mount (mirrors `ShellLayout`'s skip-link-target
  pattern) so screen-reader users landing here immediately hear it, and it's the natural
  next thing after the `_authed` guard's session resolution — nothing to visually load, so
  no separate loading state.

---

## Component inventory

Library in use: **Tailwind CSS 4 + shared `shell/tokens.css` design tokens** (no component
kit). "Reuse (shared)" = same file, imported unchanged. "Reuse (ported pattern)" = a new
admin-ui file that must closely copy an existing component's markup/props/a11y contract
(unavoidable — admin-ui cannot import across the federation boundary, ADR-0006).

| Element | Reuse / NEW | Source pattern (path) |
|---|---|---|
| Sidebar tool entry filtering (US-7) | **Reuse (shared)**, data-only change | `shell/src/components/Sidebar.tsx` — filter `TOOLS` by `usePermissions().apps` before render; no markup change |
| "Admin" tool icon in the rail | **Reuse (shared)**, additive | `shell/src/components/Sidebar.tsx`'s `TOOL_ICONS` map — one new `ToolId: 'admin'` entry, same icon convention |
| Tool-route guard (US-7 deep-link block) | **Reuse (shared)**, logic-only | `shell/src/router.tsx`'s existing `_authed`/`beforeLoad` guard pattern — add an `access`-check `beforeLoad` per tool route, same shape as the session check already there |
| Shell chrome (Header/Footer/ShellLayout/LogoMenu/UserMenu/ThemeToggle/AboutModal) | **Reuse (shared)**, unchanged | `shell/src/components/*` — none of this feature's flows touch chrome except the Sidebar filter above |
| RemoteMount (mounts `admin/App`) | **Reuse (shared)**, unchanged | `shell/src/components/RemoteMount.tsx` — admin-ui is mounted exactly like estimai/refund, no new loading/error boundary needed at the shell layer |
| `shell/tokens.css` (fonts/palette) | **Reuse (shared)**, federated import | `shell/src/styles/tokens.css` — admin-ui imports it exactly as refund-ui does (`import 'shell/tokens.css'`) |
| Screen S1 (`/no-access`) | **NEW** | No existing full-page empty state at the *shell* level (EstimatesPage's empty state is app-internal, lives in a different remote) — new but trivial markup, mirrors EstimatesPage's centered icon+heading+body layout conventions |
| admin-ui inner router (basepath `/admin`) | **NEW**, structural | Mirrors `estimai-ui/src/router.tsx`'s `createAppRouter(basepath)` factory — same shape, new routes |
| admin-ui secondary nav (Roles/Departments/Users/Audit tabs) | **NEW** | No precedent for a *nested* section-switcher in this repo; closest analog is EstimatesPage's own in-content `<header>` bar (not a landmark), reused as the layout precedent, not the markup |
| Roles list table (Screen A1) | **NEW** | Mirrors `EstimatesPage`'s populated-list-row pattern (row + actions, not a full data-grid) |
| Departments list table (Screen B1) | **NEW** | Same as above |
| Users list table + search + pagination (Screen C1) | **NEW** | List pattern from EstimatesPage; pagination itself has **no existing precedent anywhere in the repo** (EstimatesPage's list is unpaginated) — genuinely new primitive, needed because `GET /admin/users` is paginated per the plan |
| Pagination control (shared within admin-ui) | **NEW** | Justification: first paginated list in the codebase; built once, reused by Users list and Audit log |
| Audit log table + row-expand diff (Screen D1) | **NEW** | Table-with-`<th scope="col">` convention ported from `ImportOfferModal`'s results table; row-expand-to-diff has no precedent (new) |
| Role editor / rule composer (Screen A2) | **NEW** | The hardest screen — no existing rule-builder anywhere; row list styling mirrors `ActivityTable`'s row+trailing-delete feel, field grouping mirrors `ParametersPanel`'s card-row layout, condition fieldset is genuinely new (nothing in-repo builds a cascading, catalog-constrained form) |
| Resource/Action catalog picker (within A2) | **NEW** | No cascading-select precedent in-repo |
| Condition badges (Own/Any, Entity/Dept/JobTitle chips) | **NEW**, small | Mirrors `WarningBadge`'s glyph-or-icon-plus-text convention (never color alone) |
| System-role badge/lock | **NEW**, small | Same badge convention as above |
| Create-role / Create-department modal (M1/M2) | **NEW** | Small name+description dialog; structurally simpler than, but modeled on, `ConfirmDeleteModal`'s dialog shell (backdrop, `role`, header/body/footer, Escape) |
| Confirm-delete dialog (D1) | **Reuse (ported pattern)** | `estimai-ui/src/components/ConfirmDeleteModal.tsx` — same props/states, `role="alertdialog"` instead of `role="dialog"` (see Accessibility) |
| Guardrail-blocked dialog (D2) | **NEW** | No existing "blocked, acknowledge-only" dialog shape in-repo (D1's shape assumes a proceed action always exists) |
| Permission-denied in-place state (E1) | **NEW** | Conceptually close to `RemoteMount`'s error fallback (in-place, chrome-preserving) but for a `403` rather than a load failure — different trigger, different copy, no Retry |
| RFC 7807 error banner (list/save errors) | **Reuse (ported pattern)** | `estimai-ui/src/components/ToastBanner.tsx` + `EstimatesPage`'s inline `role="alert"` + Retry banner — same shape |
| List loading skeleton | **Reuse (ported pattern)** | `estimai-ui/src/components/SkeletonListRows.tsx` — same shape, reused for Roles/Departments/Users/Audit lists |
| User-search picker (Department members "Add member") | **NEW**, but reuses Screen C1's search+list, not a new pattern | Composed from the Users-list search input + row-select, not a fresh design |

**Ratio:** ~9 shell components/behaviors reused unchanged (Sidebar filter, tool-route guard,
RemoteMount, ShellLayout, Header, Footer, LogoMenu, UserMenu, ThemeToggle, AboutModal,
tokens.css — chrome is essentially untouched) : **~20 NEW files in admin-ui** (of which 3 —
ConfirmDeleteModal, ToastBanner, SkeletonListRows — are near-verbatim ports, not novel
designs; the remaining ~17, led by the rule composer and pagination, are genuinely new
because admin-ui is a fresh remote with no prior screens). This ratio is expected and
correct for a brand-new tool — the goal was never "reuse admin-ui components that don't
exist yet," it was "match the existing system's conventions so the new ones don't look or
behave like a foreign tool," which every NEW entry above does by citing its source pattern.

---

## Accessibility

- **Data tables (Roles/Departments/Users/Audit — A1/B1/C1/D1):** semantic `<table>` with
  `<th scope="col">` (per `ImportOfferModal`'s existing convention); column-header sort
  controls are real `<button>`s carrying `aria-sort="ascending"|"descending"|"none"`, not
  clickable `<div>`s. Pagination controls (`Previous`/`Next`) are real buttons,
  `aria-disabled="true"` (not just visually dimmed) at the bounds, with an `aria-live="polite"`
  region announcing "Showing 21–40 of 63" on page change — mirrors the existing
  `aria-live="polite"` loading-announcement convention (`EstimatesPage`, `RemoteMount`).
- **Rule composer (Screen A2 — the hotspot):** the whole composer is a `<fieldset>` per
  logical group (`Resource & action`, `Conditions`) with a `<legend>`, so screen-reader users
  get "Conditions" announced once instead of per-checkbox. Every control has an explicit
  `<label htmlFor>` (no placeholder-as-label). The Ownership control is a true
  `role="radiogroup"` with `aria-labelledby` pointing at "Ownership"; the Attribute
  checkboxes are a `<fieldset><legend>Attribute conditions</legend>`. When Resource changes
  and Action resets, and when Action changes and the Conditions panel's available controls
  change, an `aria-live="polite"` status line announces what changed (e.g. "Action reset.
  Conditions available: ownership, entity.") — without this, a screen-reader user has no way
  to notice the Conditions panel just silently changed shape. The `422` stale-catalog banner
  is `role="alert"` (assertive, appears without user action) same as every other inline
  error in this design.
- **Confirmation / guardrail dialogs (D1/D2):** both use `role="alertdialog"` (not plain
  `role="dialog"`) — per WAI-ARIA authoring practices, `alertdialog` is the correct role when
  a dialog interrupts to demand acknowledgement of something consequential (destructive
  delete, or a hard authorization guardrail), which describes every dialog this feature adds;
  this is a deliberate refinement over `ConfirmDeleteModal`'s existing `role="dialog"`, scoped
  to admin-ui's own copy — **not** a retroactive change to estimai-ui's original (out of this
  feature's scope; flagged as a minor consistency note, not drift). Both dialogs: full Tab
  focus trap, Escape triggers the safe action (Cancel for D1, OK for D2 — D2 has no unsafe
  action to escape *to*), default focus on the safe/only action, backdrop click matches
  Escape's behavior. D1's "Delete" button is only ever reachable via explicit Tab/click, never
  auto-focused (mirrors `ConfirmDeleteModal`'s existing "Cancel is the safe default").
- **Guardrail-blocked save (AC-6.4) inline path:** when the *pre-emptive* client-side guard
  fires (disabled Delete on a System role) the disabled button still carries a `title` AND an
  `aria-disabled="true"` with a visually-hidden explanation, not just a bare CSS `disabled`
  state with a mouse-only tooltip.
- **Permission-denied / no-access states (E1, S1):** the heading receives programmatic focus
  on mount (`tabIndex={-1}; ref.current?.focus()`, same technique `ShellLayout` already uses
  for its skip-link target) so assistive tech announces the state immediately rather than
  requiring the user to explore the page to discover why nothing loaded. Text-only status
  (no color-only signal — the existing repo convention already established by `WarningBadge`
  and `ImportOfferModal`'s glyph+text status badges is followed for every condition/system
  badge this feature adds).
- **Keyboard operation, generally:** every new interactive element is a native
  `<button>`/`<select>`/`<input>`/`<a>` — no custom-widget-from-a-`<div>` anywhere in this
  design, matching the existing codebase's posture (Sidebar's roving-tabindex is the one
  place custom keyboard handling exists, and this feature's only touch to it is a data
  filter, not new interaction logic).
- **Contrast:** all new UI reuses the existing token palette verbatim (no new colors
  introduced) — System/condition badges use `--org` (amber) and `--acc`/`--grn` exactly as
  `WarningBadge`/`StatusBadge` already do, which are already validated at ≥ 4.5:1 in both
  themes per those components' existing usage.

---

## Gaps, scope notes & drift (report to PO/architect — not designed around)

1. **Missing department-member endpoint (blocks Screen B2's "Members" panel as designed).**
   The plan's admin API table has `GET/PATCH/DELETE /admin/departments/:id` and `PUT
   /admin/departments/:id/roles`, but no way to **list** or **add/remove** a department's
   members from the department side — only `PUT /admin/users/:id/departments` (user-scoped).
   AC-1.2 ("admin creates a department **and adds users to it**, then those users appear as
   members") reads as a department-centric action. This design assumes `GET
   /admin/departments/:id` will embed a `members` array and that Screen B2's "Add member"
   picker will call the *existing* user-scoped endpoint per selected user — but that's a
   client-side workaround for a server contract gap, not a confirmed API shape. **Route to
   architect:** either confirm `GET /admin/departments/:id` returns embedded members, or add
   `GET /admin/departments/:id/users`.
2. **No effective-permissions preview for an admin viewing another user (AC-1.3/AC-1.4/AC-4.2
   verification surface).** The only live effective-permissions endpoint in the plan is
   `GET /authz/me`, scoped to the *caller's own* session (by design, per the plan's security
   section — "`/authz/me` only ever returns the caller's own permissions"). This means Screen
   C2 (User detail) can show *assigned* roles/departments but **cannot** show the *resolved*
   (resource, action, conditions) set for someone else the way AC-4.2's union/dedup logic
   would produce it — an admin has no in-product way to verify "does this user now actually
   have edit on estimate" without impersonation or a DB query. This is a real usability gap
   for an authorization admin tool but is **not designed around here** per instructions — no
   screen assumes an endpoint that doesn't exist. **Route to architect:** consider a narrow
   admin-only `GET /admin/users/:id/permissions` (or extend `GET /admin/users/:id`) if this
   verification capability is wanted; if intentionally deferred, note it as a known v1
   limitation rather than a silent gap.
3. **User search/filter isn't in the plan's contract.** `GET /admin/users` is documented as
   "paginated" only; Screen C1 assumes a `?q=` (or similar) query param for name/email search
   since browsing an unfilterable, possibly-large user list is a poor admin experience. Low
   risk to add, but **flagged** since it's not literally in the plan.
4. **No AC asks for a standalone "Catalog" admin screen**, and none is designed — `GET
   /admin/catalog` is consumed only as data inside the Screen A2 rule composer (AC-3.1's
   literal ask: "available to build rules from"). Deliberately avoided adding a
   browse-the-catalog screen as scope creep since no AC calls for admins to manage or browse
   catalog entries directly (catalogs are declared by apps in code, not edited via UI).
5. **AC-4.1–4.4 (US-4) have no UI surface by design** — they're API/claims-shape
   requirements ("verifiable by inspecting token claims or the auth session/permissions
   response"), not a screen. Confirmed intentional, not a gap: no screen in this document
   claims to satisfy US-4 directly; Screen C2's role/department assignment is how an admin
   *causes* AC-4.2's union to be exercised, but verifying the union itself is gap #2 above.
6. **Rename-lock for system roles is not required by any AC** — only *delete* of a system
   role is blocked (AC-1.1/AC-6.2 say seed roles must be "editable by admins," which this
   design reads as rename/description-edit remaining open). Flagging so this isn't quietly
   over-restricted during implementation: don't disable the name field for System roles.

---

## Summary for the record

- **Flow count:** 8 (F1 bootstrap, F2 roles+rules, F3 departments, F4 users+guardrail, F5
  custom role [shares F2's screens], F6 audit, F7 non-admin blocked, F8 zero-access empty
  state).
- **Screens/dialogs:** 12 (A1, A2, B1, B2, C1, C2, D1 audit list, S1) + 4 dialogs/states (D1
  confirm-delete, D2 guardrail, E1 permission-denied, plus modals M1/M2 folded into A1/B1).
- **Component ratio:** ~9 shell components reused unchanged : ~20 new admin-ui files (3 of
  which are near-verbatim ports of existing patterns, not novel designs).
- **Top a11y hotspots:** the rule composer's dynamic conditions panel (Screen A2, needs
  `aria-live` status announcements on Resource/Action change), the two guardrail dialogs'
  `alertdialog` treatment, and the two "nothing to show" states (E1/S1) needing focus moved
  to their heading on mount.
- **Drift/gaps to route to PO/architect:** (1) missing department-member list/add endpoint,
  (2) no admin-facing effective-permissions preview for a third-party user (only
  `/authz/me`, caller-scoped), (3) user search/filter not in the plan's contract, all
  detailed above. No scope creep found in the other direction — every screen in this
  document traces to at least one AC, and both US-4 and the "declare catalog" half of US-3
  correctly have no dedicated screen.
