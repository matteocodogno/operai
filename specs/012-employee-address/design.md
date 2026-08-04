---
spec: 012
status: draft
---

# Design: Employee address — admin-managed, autocomplete-assisted capture

Component library in use: **Tailwind CSS 4** utility classes driven by the shared
`shell/tokens.css` `@theme` block (DM Sans / DM Mono / Syne, dark-ink palette + light
override) — no headless/Mantine/MUI component kit anywhere in the repo (confirmed by reading
`admin-ui/src/**`, `shell/src/**`; `specs/004-auth-roles-permissions/design.md` established
this posture for admin-ui and nothing since has changed it). Every existing screen is
hand-built markup + Tailwind utilities + a handful of local, hand-rolled patterns (modal via
`role="dialog"`/`role="alertdialog"` + focus-trap `useEffect`, table via a semantic
`<table>`, no `react-aria`/`downshift`/`react-modal`/etc.). This feature inherits that
approach on both remotes it touches.

This feature spans **two** federated remotes (plan.md "Architecture → Shape"), so, per
`specs/004-auth-roles-permissions/design.md`'s established convention, "reuse" means three
different things, called out explicitly per entry below:
- **Reuse (shared)** — the same component/module instance, imported unchanged. Either
  literally the same file within one remote (e.g. `admin-ui`'s existing input styling reused
  within the same `UserDetail.tsx`), or a genuinely shared federated module (`shell/session`,
  `shell/tokens.css`) imported by a remote at runtime.
- **Reuse (ported pattern)** — a near-verbatim re-authoring of an existing component's
  markup/props/a11y contract into a NEW file, forced by the Module Federation boundary
  (ADR-0006: `admin-ui` cannot import `shell`'s or another remote's source, and `shell`
  cannot import `admin-ui`'s).
- **NEW** — no existing precedent to port from anywhere in the suite.

Both `admin-ui` and `shell` already exist with established conventions (unlike
specs/004-auth-roles-permissions, which designed admin-ui from nothing) — this feature is an
**extension** of two mature screens (`UserDetail.tsx`, and the shell's chrome/`UserMenu`),
not a new tool. The autocomplete combobox is this feature's one genuinely novel UI pattern;
everything else traces to an existing screen.

> **Amendment (this revision):** the Country field was originally designed as free text. That
> was a real defect against the approved plan's own data contract — see "Country control —
> resolved design↔plan mismatch" below for the full problem statement and resolution. Country
> is now a typeahead select reusing the same combobox primitive the Street/address field
> introduces, not a plain input. Every section below (Flows, Screens & states, Component
> inventory, Accessibility, i18n) reflects the corrected design.

---

## Flows

Each flow lists entry → steps → success/error exits, with US/AC references.

### F1 — Admin views an employee's stored address (US-1, AC-1.1)
Entry: Admin tool → Users → a user row → **Screen C2 (User detail)**, scrolled to the new
**Address** section.
1. `AddressSection` mounts, resolves the caller's capability (see F4 — this happens first,
   synchronously, from the already-cached `usePermissions()`), then fetches `GET
   /admin/users/:id/address`.
2. **Populated:** the currently-persisted formatted address renders as a plain read line
   ("Current address: …") above the editable fields, which are pre-filled from the same
   response (AC-1.1). The Country control's closed/idle state shows the persisted code's
   localized name (e.g. "Switzerland" / "Svizzera" for `CH`).
3. **None:** the read line shows "No address on file" (Domain language's exact phrase) and
   every field renders empty, ready for entry — the Country control's closed/idle state shows
   its placeholder.
4. Error: see Screen states — `ErrorBanner` + Retry, matching every other section's fetch
   failure.

### F2 — Admin sets or changes an address, with suggestion assistance (US-1, US-2, US-3;
AC-1.2, AC-1.4, AC-2.1–2.6, AC-3.1–3.4)
Entry: continues from F1, admin is on the Address section with the form visible.
1. Admin starts typing into the **Street** field (the one field that doubles as the
   Google-backed suggestion combobox — see "Screens & states" for why this field
   specifically).
2. Below 3 characters: nothing happens (AC-2.1's "at least a few characters" — plan.md's
   contract fixes this at 3).
3. At ≥3 characters, after 300 ms of idle typing, a request goes to Google Places (New),
   lazy-loaded on first focus of the field (plan.md "browser-direct" decision). Three
   outcomes:
   - **Suggestions returned:** a `listbox` popup appears below the field (max 5, CH/IT
     ranked first via `locationBias` — AC-2.4). Admin can keep typing (supersedes the
     in-flight request), arrow-navigate, or click.
   - **No suggestions found (AC-3.1):** the popup stays closed; a small muted helper caption
     appears once the request genuinely completes with zero results: "No matching
     suggestions — you can still enter the address by hand below." Fields stay fully
     editable.
   - **Service down/slow/rate-limited (AC-3.2):** the popup never appears, no caption, no
     error, no lingering spinner — the field simply behaves like a plain text input. See
     "Screens & states" and "Accessibility" for the deliberate distinction from the case
     above. Note this cannot happen to the **Country** control at all — see "Country control"
     below; Country is the field this design specifically insulates from Google's
     availability.
4. **Selecting a suggestion (AC-2.2, AC-2.5):** a Place Details fetch resolves the full
   address; every structured field (street, house number, postal code, city, region) and the
   coordinates populate, and the **Country** control's value updates programmatically to the
   alpha-2 code Google returned (`country → shortText`), displayed via the same localized-name
   lookup the control always uses (see "Country control"). Focus management: if `houseNumber`
   came back empty (a known Google gap for route-level predictions, plan.md R9), focus moves
   there so the admin's next keystroke fills the one thing still missing; otherwise focus
   stays on the Street field, now showing the selected street name.
5. **Hand-editing after selection (AC-2.3, AC-2.6):** admin edits any populated field —
   including re-typing the Street field without picking a new suggestion, or changing the
   Country control's selection. The moment any of the six structured values diverges from the
   snapshot captured at selection time, the captured coordinates are dropped from what will
   be submitted — see "Screens & states" for the **visible** treatment this design
   deliberately chooses (not silent).
6. **Manual entry only (AC-3.3, AC-3.4):** admin never opens or selects from the Street
   suggestion list at all — every field is typed/picked by hand, including Country via its
   own always-available typeahead (never Google-backed — see "Country control"). Save behaves
   identically to a suggestion-assisted save, except no coordinates are ever attached.
7. Admin clicks **Save address**.
   - **All four required fields present (country, city, street, house/building number):**
     `PUT /admin/users/:id/address` → `200` → the read line above the form updates to the new
     formatted address; the audit history panel (F5) gains a new row.
   - **One or more of the four required fields missing (AC-1.4):** `422` → each named field
     gets an inline, field-associated error (including the Country control's filter `<input>`
     if country is the one missing); Save re-enables; nothing is persisted; the in-progress
     edit is preserved exactly as typed (no reset — mirrors Screen C2's existing
     roles/departments guardrail-preserves-the-edit convention, `UserDetail.tsx`'s own
     documented behavior).
   - **Unexpected failure (network/500):** a single non-field error line appears near Save,
     mirroring `attributesError`'s existing convention on this same page.

### F3 — Admin clears a previously-set address (US-1, AC-1.3)
Entry: continues from F1, an address is currently on file.
1. Admin clicks **Clear address** (a plain secondary action, not styled as destructive red —
   see "Screens & states" for the confirm-before-clear decision and its justification).
2. Fields visually empty and become non-interactive — including the Country control, which
   returns to its closed/idle placeholder state and cannot be opened while a clear is
   pending; an inline line appears: "Address will be cleared when you save." with an **Undo**
   action.
3. Admin clicks **Save address** (the same button, now acting on the pending-clear state) →
   `PUT { address: null }` → `200` → the read line reverts to "No address on file", fields
   re-enable and stay empty, ready for a fresh entry. The audit panel gains a new row showing
   old value → "no address on file" (AC-5.1).
   - Or admin clicks **Undo** first → fields restore to their pre-clear values (including the
     Country control's prior selection), re-enable, no request is ever sent.

### F4 — Non-capable admin never sees the section at all (US-4, AC-4.1, AC-4.2)
Entry: any user who reaches **Screen C2** (reachable today by anyone whose `apps` includes
`admin` per the shell's tool-access guard — not necessarily the full `admin` role; see "Gaps"
for why this matters).
1. `AddressSection` reads `usePermissions().roles` (the shell's already-cached permission
   result, `shell/session`) synchronously on mount — no network call of its own for this
   check.
2. `roles.includes('admin')` false → the section renders **nothing** — not a disabled form,
   not a "you don't have access" message, literally absent from the DOM (AC-4.2's "invisible,
   not disabled"). No `GET /admin/users/:id/address` call is ever made for such a viewer —
   there is nothing to fetch for a section that doesn't exist.
3. `roles.includes('admin')` true → the section renders and fetches as in F1.
4. Defense in depth (AC-4.1): even if a stale client somehow rendered the section (e.g. a
   revoked-mid-session admin, race with the shell's per-navigation revalidation — the exact
   precedent `specs/004-auth-roles-permissions/design.md` Screen E1 documents for this same
   page), the server's `requireAdmin` still denies with `403`, surfaced as the same
   generic-failure line described in F2 step 7's "Unexpected failure" case — this is not a
   new state, it reuses the existing save/fetch error path.

### F5 — Admin views an employee's address change history (US-5, AC-5.3)
Entry: continues from F1, on the Address section, below the form.
1. A read-only **history panel** lists every `user.address.set` audit entry for this
   employee (`GET /admin/audit?targetType=user&targetId=<id>&action=user.address.set`),
   newest first: who changed it, when, old value → new value (each rendered as its formatted
   string, or "No address on file").
2. **Empty:** "No address changes recorded yet." — the realistic default for most employees
   at feature launch.
3. No edit/delete affordance anywhere on this panel — immutability-by-convention (AC-5.2) is
   enforced by omission, exactly like `specs/004-auth-roles-permissions/design.md`'s Screen
   D1 (Audit log) already establishes for this same reason on the same page's Users section.

### F6 — Employee views their own address, read-only (US-6, AC-6.1–6.4)
Entry: any signed-in user → **UserMenu** (avatar, top-right chrome) → **"My profile"** → shell
route `/account` → **AccountScreen**.
1. `AccountScreen` fetches `GET /me/address` (self-scoped, no `:id` — AC-6.4 by construction).
2. **Populated:** the formatted address renders as plain text (AC-6.1).
3. **None:** "No address on file" (identical copy to F1's admin-side empty state).
4. **Fetch failure:** a distinct error state — never conflated with "no address on file" (an
   explicit plan.md test requirement) — with Retry.
5. At no point does this screen render an `<input>`, a `<select>`, a combobox, a suggestion
   popup, or a submit control (AC-6.2) — see "Screens & states" for the literal DOM
   guarantee. An employee who spots an error must contact an admin (spec Non-goals) — a short
   line says so.
6. AC-6.3/AC-6.4 have no UI surface at all — they are server-side guarantees (no write verb
   at `/me/address`, no `:id` parameter to name a colleague) with nothing to design on this
   screen; confirmed intentional, not a gap (mirrors `specs/004-auth-roles-permissions/
   design.md`'s treatment of its own US-4).

---

## Screens & states

Legend: **L**oading, **Abs**ent (AC-4.2 — not rendered at all), **E**mpty ("no address on
file"), **P**opulated, **Edit** (the always-visible editable form, pre-filled), **Err**or
(RFC 7807).

### Screen C2 extension — `AddressSection` (mounted into the existing User detail screen)

**Purpose:** the entire admin-facing capture/edit/clear/history surface (US-1, US-2, US-3,
US-5), gated per US-4.

**Structural decision — no separate view/edit toggle.** Unlike a "click to edit" pattern,
`AddressSection` mirrors this same page's existing Attributes block: a short **read line**
showing the currently-persisted formatted address (or "No address on file") sits above an
**always-editable** form pre-filled from that same value. This is deliberate, not a
simplification for its own sake: AC-1.1 asks for the persisted value to be visible in
formatted form, and the existing Attributes/Roles/Departments sections on this exact page
already use "always-editable, explicit Save" rather than a toggle — introducing a
view/edit-mode switch here would be the one section on the page that behaves differently for
no AC-driven reason. The read line updates only on a successful save (never as the admin
types), so it always reflects the source of truth, distinct from the live, in-progress form
state below it.

- **Abs (AC-4.2):** `usePermissions().roles` lacks `admin` → nothing renders. No
  `data-testid="address-section"` node exists in the DOM at all (this exact test id, and this
  exact absence, is what plan.md's own AC-4.2 test asserts — `queryByTestId('address-section')`
  must be `null`).
- **L:** the section's own fetch (`GET /admin/users/:id/address`) is in flight — reuses
  `SkeletonListRows` (1–2 rows), matching how the rest of Screen C2 already renders its
  initial load, with an `aria-live="polite"` sr-only "Loading address…" announcement.
- **E (no address on file):** read line = "No address on file"; every field empty, Country
  control shows its placeholder; **Clear address** button is not shown (nothing to clear) —
  only **Save address** is present, and it stays disabled until at least one field has
  content (mirrors `AddRateEntryModal`'s `canSubmit` pattern).
- **P (address on file):** read line = the formatted address; fields pre-filled, Country
  control shows the persisted code's localized name; both **Save address** and **Clear
  address** are present.
- **Edit — idle, untouched:** the form as loaded (E or P above), no pending change.

**Street / address-search combobox sub-states (Google-backed, async):**
- **Typing below the minimum threshold:** Street field has 1–2 characters. Visually
  identical to idle; no request fired, no popup, no loading indicator (AC-2.1's "at least a
  few characters" — plan.md fixes the threshold at 3).
- **Suggestions loading:** ≥3 characters, 300 ms idle elapsed, request in flight (≤3000 ms
  cap, plan.md). A small, non-blocking "Searching…" caption appears near the field (muted
  `--soft` text, not a full-field skeleton) — the field itself stays focused and fully
  typable; further typing aborts this request and restarts the debounce (plan.md's
  "in-flight supersession"), which is exactly why the indicator must never disable the field.
- **Suggestions returned:** a `role="listbox"` popup renders below the field, up to 5
  `role="option"` rows (each showing the prediction's main + secondary text), keyboard- and
  mouse-operable (see Accessibility). The Google attribution mark renders inside this popup,
  always, whenever it is open (see "Google attribution" below) — **the Street popup only**;
  the Country popup (below) never carries it, since Country's data isn't sourced from Google.
- **No suggestions found (AC-3.1):** popup stays closed; caption: "No matching suggestions —
  you can still enter the address by hand below." Every field stays editable; Save is
  unaffected.
- **Suggestion service down/slow/rate-limited (AC-3.2):** popup stays closed, **no caption,
  no error, no lingering "Searching…"** — indistinguishable from an ordinary text field to a
  sighted user. This is the one state in this feature that is deliberately
  under-communicative — see "Accessibility" for why, and for how it differs from the "no
  suggestions found" state above despite looking identical. This state is **only possible for
  the Street field** — see "Country control" for why Country cannot enter an equivalent state.
- **Suggestion selected:** popup closes; all mapped fields populate, including the Country
  control (programmatically, without opening its own popup); focus moves to `houseNumber` if
  it came back empty, otherwise stays on Street (plan.md R9's tested behavior). The
  coordinate-status line (below) switches to "captured."

**Country control sub-states (local, synchronous, never Google-backed — see "Country
control" for the full rationale):**
- **Closed / idle:** shows the currently-selected country's localized name, or the
  placeholder "Search for a country…" if none is set.
- **Open / filtering:** as the admin types a name (in any language they reach for —
  "Svizzera", "Switzerland", "Suisse"), the popup updates **synchronously**, on every
  keystroke, filtering the bundled ~249-entry ISO 3166-1 list by localized display name — no
  debounce, no network round trip, no loading state, because there is nothing to wait on.
- **No match:** the popup shows a single muted "No matching country" row rather than closing
  silently. Unlike Street's AC-3.1 case, there's no "did the service even try" ambiguity to
  preserve for Country — an unmatched query is always a typo or an unrecognized name form
  (e.g. "Holland" vs. "Netherlands"), so a direct, always-present message is simply the honest
  answer.
- **Selected:** popup closes, the control displays the chosen name; the field's value is the
  alpha-2 code. Reachable either by the admin picking a row here, or programmatically when a
  Street suggestion is selected (see F2 step 4).
- **There is deliberately no "loading" and no "service down" state for this control** — that
  absence is the entire point of building it this way (see "Country control" below).

**Shared save/validation/clear states (apply across the whole form):**
- **Validation failure naming the missing field(s) (AC-1.4):** after a `422`, each field
  named in `missingFields` gets `aria-invalid="true"`, a red border, and its own inline
  `role="alert"` message ("This field is required.") directly beneath it — mirrors
  `AddRateEntryModal`'s per-field error convention exactly, and applies identically whether
  the missing field is a plain input (City, Street, House number) or the Country combobox's
  filter `<input>`. Postal code and Region never receive this treatment (they cannot appear
  in `missingFields`, per plan.md's contract). There is deliberately **no** separate summary
  banner restating the server's prose — the per-field alerts already name exactly what's
  wrong, and a second `role="alert"` region repeating the same information would
  double-announce it to screen-reader users (see Accessibility).
- **Save in flight:** **Save address** shows "Saving…" + the same small spinner glyph
  `ConfirmDeleteModal`/`AddRateEntryModal` already use; both **Save address** and **Clear
  address** are disabled for the duration (mirrors `attributesSaving`'s existing behavior on
  this page).
- **Save succeeded:** no toast, no success banner — mirrors this page's existing
  Attributes/Roles/Departments convention of simply re-rendering the updated value (the read
  line above the form updates; the history panel, F5, gains a row). Silence-on-success here
  is consistent with the rest of the page, not a new omission.
- **Save failed (non-validation):** a single `role="alert"` line near the Save button,
  mirroring `attributesError`'s existing pattern verbatim; the in-progress edit is untouched.
- **Pending clear (F3):** fields shown emptied and `disabled` (including the Country
  control, which cannot be opened); inline text "Address will be cleared when you save." + an
  **Undo** button that restores the pre-clear values and re-enables the fields, no request
  sent. Save while in this state submits `{address: null}`.
- **Fields hand-edited after a selection (AC-2.3/AC-2.6, the coordinate-staleness call):** the
  moment any of the six structured values (including the Country control's selection)
  diverges from its post-selection snapshot, a small status line beneath the field group
  updates live: **"Location coordinates: cleared — address edited after selecting a
  suggestion."** This design deliberately makes the staleness **visible**, not silent — see
  the standalone note below this table for the full justification. Nothing else about any
  field changes; every field stays exactly as editable as before.

**Confirm-before-clear — the call, and why.** No modal. Clicking **Clear address** does not
delete anything by itself — it queues the clear (fields visually empty + disabled + an inline
"will be cleared when you save" notice with an **Undo**), and the destructive part only
happens on the deliberate, separate **Save address** click, which is the same explicit-Save
gate every other edit on this section (and every other section on this page) already requires.
Reasons this is enough, and a `ConfirmDeleteModal`-style blocking dialog is not warranted:
1. **It is genuinely reversible in the moment** — Undo restores the exact pre-clear values
   with no request ever sent, unlike `ConfirmDeleteModal`'s irreversible-once-confirmed
   actions (deleting a user/role).
2. **It stays reversible after the fact** — the previous value is preserved forever in the
   audit history panel (F5, AC-5.3), so "clearing" never actually destroys the record the way
   deleting a user does.
3. **Consistency with this page's own established pattern** — `specs/011-refund-settings`
   (cited verbatim in this feature's spec Constraints as the precedent to mirror) already
   treats "save a null value" as an ordinary save, not a delete; reserving the heavier
   `ConfirmDeleteModal` machinery for genuinely irreversible actions (whole-user deletion, the
   one other place it's used on this exact page) keeps that dialog's weight meaningful instead
   of diluting it with a second, lower-stakes use.
4. Two deliberate actions (Clear, then Save) are still required before anything is sent —
   that sequencing is itself the confirmation, just inline rather than in a dialog.

**The coordinate-staleness visibility call (AC-2.3/AC-2.6).** plan.md's `coordinatesForSave`
pure function silently computes `(null, null)` when a hand-edit invalidates the snapshot — but
that is a **data** contract, not a UI one, and the plan does not specify whether the admin is
ever told. This design's call: **visible, via a small, calm status line — never silent, and
never an error.**
- **Why not silent:** an admin who deliberately picked a suggestion (visible effort — opening
  a popup, choosing a row) and then makes one small hand-correction (e.g. fixing a typo the
  suggestion got wrong, or overriding the auto-filled Country) would otherwise have no way to
  discover that their earlier, correct selection quietly stopped contributing coordinates to
  the save. Silence here reads as a latent bug report waiting to happen ("I picked a real
  address from the list, why does the saved record have no coordinates?") — exactly the kind
  of state Non-goals+AC-2.6 anticipate will happen (any hand-edit at all triggers it, not just
  a big rewrite).
- **Why not an error/warning treatment:** nothing has actually gone wrong, and coordinates
  have zero downstream consequence in this feature (spec Non-goals; plan.md R7) — a `role=
  "alert"`, a red border, or a blocking dialog would overstate the stakes and train admins to
  ignore alerts on this page. A quiet, `aria-live="polite"` status line (never asserted,
  never focus-stealing) matches the actual stakes: informational, not actionable, not urgent.
- **Net effect:** the line reads "Location coordinates: captured from suggestion." right
  after a selection, flips to "…cleared — address edited after selecting a suggestion." the
  instant any field (including Country) diverges, and reads "No coordinates on file." when no
  selection has ever been made (AC-3.4's manual-only path) — always present, always accurate,
  never alarming.

### History panel (part of `AddressSection`, F5)
- **L:** shares the section's own `SkeletonListRows` loading, or its own smaller skeleton if
  the address fetch resolves first — either is acceptable; both fetches are independent so a
  slow audit query must never block the form above it from becoming usable.
- **E:** "No address changes recorded yet."
- **P:** a compact list (not necessarily a full paginated `<table>` like Screen D1's — this
  is scoped to one employee, realistically a handful of rows) — Changed by / Changed on /
  Previous → New, each value rendered through the same `formatAddress`-shaped string the read
  line above uses (or "No address on file").
- **Err:** its own small inline error + Retry, independent of the form's own error state — a
  history-fetch failure must never block editing/saving the address itself.

### `AccountScreen` — shell route `/account` (US-6)
- **L:** a short `aria-live="polite"` sr-only announcement ("Loading your address…") plus a
  minimal inline loading treatment — a full `SkeletonListRows`-style block is overkill for one
  line of text; the closest in-repo visual precedent is `RemoteMount`'s own
  `RemoteLoadingFallback` spinner (shell-local already, no cross-remote import needed).
- **E (no address on file):** "No address on file." — literally the same string as F1's
  admin-side empty state (AC-6.1 "mirroring AC-1.1's display").
- **P (address on file):** the formatted address, rendered as plain text — same visual
  register as `UserDetail.tsx`'s existing read-only Identity block (name/email, no inputs),
  the closest in-repo precedent for "a labeled value with zero interactivity."
- **Err (fetch failure):** **distinct from E** — plan.md is explicit this must never collapse
  into "no address on file." Ports `RemoteMount`'s `RemoteErrorFallback` visual language
  (`role="alert"`, `border-org`/`bg-org/10`/`text-org`, a bordered "Retry" button) — the only
  existing shell-local error+retry pattern, scoped here to the content area exactly as
  `RemoteMount` already scopes its own.
- **Read-only guarantee (AC-6.2), stated as a literal DOM constraint:** within this screen's
  address region, there is no `<input>`, `<select>`, `<textarea>`, `[contenteditable]`,
  `<button type="submit">`, nor any element carrying `role="listbox"`/`role="combobox"` —
  zero, not "disabled." This is a hard constraint on the implementation, not a suggestion:
  plan.md's own AC-6.2 test asserts exactly this query returns nothing. A closing line of
  static text — "Contact an admin to update this." — is the entire extent of any
  "affordance" this screen offers.
- A short trailing note names the screen accurately: this route's nav entry is labeled "My
  profile" (see below) but today renders only the address — see "Gaps" for why that label is
  slightly ahead of the content, and how this design keeps that honest (a "Home address"
  section heading inside the screen, not implying a broader profile that doesn't exist yet).

### `UserMenu` addition (shell chrome)
- One new `role="menuitem"` entry, **"My profile"**, added to the existing dropdown between
  the identity block and "Sign out" — a real `<Link to="/account">`, not a `<button>` with a
  manual navigate call, so it participates in normal link semantics (open-in-new-tab,
  keyboard activation) the same way every other in-suite navigation does.
- No new states here beyond what `UserMenu.tsx` already has (open/closed, outside-click and
  Escape close it) — this is strictly one more row in an existing list.

---

## Country control — resolved design↔plan mismatch (amendment)

**The mismatch, as originally flagged in this document's first draft and confirmed by the
orchestrator against the approved plan.** plan.md's `EmployeeAddress.countryCode` carries a
hard `CHECK ("countryCode" ~ '^[A-Z]{2}$')` at the database level (plan.md line 240, mirrored
by the Prisma comment on line 178) and the API schema validates the identical
`/^[A-Z]{2}$/` shape after upper-casing (plan.md line 440). A plain free-text Country
input — this document's original design — would `422` on every human-typed country name
("Italia", "Switzerland", "Suisse") the instant Google's suggestions aren't the source, which
is exactly the AC-3.1/AC-3.2 degraded manual-entry path the spec requires to always work,
never block. That was a genuine defect against the approved plan's own data contract, not a
stylistic preference, and it is corrected here rather than deferred to QE.

**Resolution — decided by the orchestrator, binding for implementation.** Country becomes a
**typeahead select over a bundled, static ISO 3166-1 alpha-2 list**, not a free-text input.

1. **Interaction model.** The admin types a country NAME, in whatever language they reach
   for — "Svizzera", "Switzerland", "Suisse" are all plausible depending on the admin — and
   the control filters a fixed, in-bundle list of the ISO 3166-1 alpha-2 codes by localized
   display name, matching case-insensitively. The underlying value the form (and the eventual
   `PUT` payload) carries is always the 2-letter code — the admin never sees or types the code
   itself, only picks a name from a list.
2. **Offline-by-construction — this is the point, not a side effect.** The country list and
   its match logic ship in the `admin-ui` bundle; there is no network call, no
   debounce-then-fetch, no dependency on Google Places at all. This is load-bearing: Country
   is the one required field (AC-1.4) with no free-text escape hatch — its value is
   constrained by a DB `CHECK`, unlike City/Street/House number, which accept any non-blank
   string — so it is also the one field that MUST remain fully operable when Google is
   unreachable (AC-3.2) or returns nothing (AC-3.1). A free-text input satisfies neither
   constraint (it "works" but silently produces unsaveable garbage); a Google-backed lookup
   would defeat AC-3.2 by construction, since the one field with no escape hatch would then be
   exactly the field taken down by the outage the spec calls out by name. A local, bundled
   list is the only shape consistent with both constraints at once.
3. **Label source — already in the codebase; nothing new to author.** Option labels come from
   `Intl.DisplayNames({ type: 'region' }, { locale })`, the exact API plan.md already
   specifies server-side (`auth/src/profile/address.format.ts`, line 313) for rendering the
   `formatted` string's country segment. `admin-ui` calls the same standard, widely-supported
   browser Web API client-side, using the locale this feature's own `addressCopy.ts`
   heuristic already resolves (`it`/`en`). There is no 249×2 string table to hand-author or
   maintain — the **codes** are a static constant (`["AD","AE",…,"ZW"]`, generated once from
   ISO 3166-1 and committed alongside `addressCopy.ts`); the **names** are computed, not
   stored. **Defensive fallback** (mirrors plan.md R8's "never throws" posture for the same
   API used server-side): if `Intl.DisplayNames` is unavailable in the admin's browser, or
   returns `undefined` for a given code, that option's label falls back to the raw alpha-2
   code — degraded, never broken, never blocking a save.
4. **When an address suggestion is selected (AC-2.2/AC-2.5).** Google's Place Details
   response already carries the country as an alpha-2 `shortText` (plan.md's
   component-mapping table: `countryCode ← country → shortText`). The control's value updates
   programmatically to that code, and its displayed label updates via the same
   `Intl.DisplayNames` lookup used everywhere else — indistinguishable from the admin having
   picked it themselves, with no separate confirmation step. Changing the Country control
   afterward (hand-typing a different name, or re-selecting) is a hand-edit like any other
   field for **AC-2.6** purposes: it invalidates the coordinate snapshot exactly like editing
   City or Street would (Country is one of the six structured values `coordinatesForSave`,
   plan.md, compares), and the coordinate-staleness status line updates accordingly (see
   "Screens & states").
5. **Does it reuse the Street combobox primitive? Yes — the same primitive, two consumers,
   not a second implementation.** This is the strongly preferred shape, and this design
   adopts it without reservation. The WAI-ARIA combobox contract this document specifies in
   full for Street (role/listbox/option/`aria-activedescendant`/keyboard set — see
   "Accessibility") is identical for Country; the *only* differences are the data source
   (synchronous local array-filter vs. a debounced remote fetch) and what a selection writes
   back (one code+label, vs. a full set of address components plus coordinates). Building a
   second, parallel combobox implementation for Country would duplicate roughly a dozen
   a11y-load-bearing behaviors (keyboard navigation, `aria-activedescendant` wiring, the
   live-region result-count announcement, Escape/Tab handling) for zero UX benefit and a real
   ongoing cost (two things to keep in sync instead of one, in a repo where this is already
   the *first* ARIA combobox — doubling it doubles the risk of the two drifting apart over
   time). The primitive is therefore one small, internally-parameterized building block
   inside `AddressSection.tsx` (plan.md's file list adds no separate file for it, so it stays
   internal rather than becoming its own component file), parameterized by:
   - `getOptions(query): Option[] | Promise<Option[]>` — a synchronous array-filter for
     Country, a debounced Google fetch for Street;
   - `onSelect(option): void` — writes back one code+label for Country; writes back the full
     structured-component set plus coordinates for Street.

   Everything else — popup rendering, keyboard handling, ARIA wiring, the result-count live
   region, the "no match"/"no results" caption slot — is shared, unforked code between the
   two call sites.

---

## Component inventory

Two remotes, so entries are grouped by which one they live in. "Reuse (shared)" = same file
imported unchanged (possibly across the federation boundary via `shell/session`/
`shell/tokens.css`, which is how cross-remote reuse is *supposed* to happen per ADR-0006).
"Reuse (ported pattern)" = a new file, but a close copy of an existing component's contract.

### `admin-ui` — `AddressSection` (single new file, per plan.md's file list; the combobox
primitive and the history panel are internal sub-structure within it, not separate files)

| Element | Reuse / NEW | Source pattern (path) |
|---|---|---|
| Section container (`border-t pt-4`, `<h3>` legend) | **Reuse (shared)**, same file | `admin-ui/src/pages/UserDetail.tsx`'s existing Attributes/Roles/Departments blocks — literally the same styling convention, same file |
| Plain text inputs (House number, Postal code, City, Region) + the input-box styling reused by both combobox fields' filter boxes (Street, Country) | **Reuse (shared)** | `UserDetail.tsx`'s `jobtitle-input`/`entity-select` styling (border/bg/color via `var(--rule)`/`var(--ink-mid)`/`var(--text)`) |
| Save button | **Reuse (shared)** | `UserDetail.tsx`'s `save-attributes-button` (same disabled/saving states, same classes) |
| Field-level validation error (AC-1.4) | **Reuse (ported pattern)** | `admin-ui/src/components/AddRateEntryModal.tsx`'s Rate/Valid-from field error convention (`aria-invalid` + `aria-describedby` + `role="alert"` paragraph) — applies identically to a plain input or a combobox's filter input |
| Non-field save error | **Reuse (shared)** | `UserDetail.tsx`'s `attributesError`/`rolesError` inline paragraph pattern |
| Initial-load skeleton | **Reuse (shared)** | `admin-ui/src/components/SkeletonListRows.tsx`, already used elsewhere on this same screen |
| **Combobox primitive — parameterized, TWO consumers** (Street/address: async, Google-backed, debounced; Country: synchronous, local, bundled ISO list) | **NEW** (one implementation) | **The genuine novelty of this feature.** No `role="listbox"`/`role="combobox"`/`aria-activedescendant` anywhere in this repo today (confirmed by search across `admin-ui`, `shell`, `refund-ui`, `notify-ui`, `estimai-ui`) — this is the suite's first true ARIA combobox, and it is deliberately built ONCE and reused for both fields (see "Country control" above for the reuse decision and justification) rather than forked. Cannot be a plain `<select>` for Street (free-text + async suggestions); per plan.md's rejected-alternatives analysis it must NOT be Google's `PlaceAutocompleteElement` web component either (fights this repo's "every interactive element is a native `<button>/<select>/<input>/<a>`" posture) — a native `<input>` plus a hand-built `<ul role="listbox">` popup, exactly as plan.md's "Which API surface" section already commits to for Street; Country adopts the identical shell |
| Option/suggestion row (`role="option"` `<li>`) | **NEW**, shared markup, two visual variants | No precedent. Street's variant shows two-line main+secondary text (Google's `structuredFormat`); Country's variant is single-line (just the localized name) — same `role="option"` element, same keyboard/selection wiring, different content template |
| Status/empty captions ("Searching…", "No matching suggestions", "No matching country") | **NEW**, shared placement/mechanism, per-consumer copy | No precedent. Same slot in the popup for both consumers; Street can show "Searching…" (async) and "No matching suggestions" (AC-3.1); Country never shows "Searching…" (nothing to wait on) and always shows "No matching country" rather than closing silently — see "Country control" for why that's the right asymmetry |
| Clear address + pending-clear inline notice + Undo | **NEW**, small | No existing "queue a destructive edit inline, confirm via the normal Save button" pattern in-repo — closest analog is `AddRateEntryModal`'s irreversibility *notice* (text only, no undo); this adds the undo affordance because, unlike a rate entry, a clear is reversible until Save |
| Coordinate-staleness status line | **NEW**, small | No existing "quiet, `aria-live` informational status tied to a derived value" pattern in-repo; closest analog in spirit (not markup) is `specs/005-notification-center`'s `aria-live` status-vs-alert split |
| History panel (audit-for-one-employee list) | **NEW**, but a narrowed reuse of Screen D1's shape | `admin-ui/src/pages/AuditPage.tsx` — same data shape (`GET /admin/audit`, now filtered), same "who/when/before/after, zero mutate affordance" content model, deliberately NOT the same paginated `<table>` component (a single employee's history is small; a full page-level table + `Pagination` would be disproportionate) |
| Google attribution mark | **NEW** (a sourced asset, not built) — **Street/address popup only, never the Country popup** | See "Google attribution" below — this is Google's own required mark, not an in-repo design, and it must not appear next to the local, non-Google Country list |
| Bundled ISO 3166-1 alpha-2 code list | **NEW**, data only, no UI | A static constant, generated once, committed alongside `addressCopy.ts` (see "Country control" above) — not fetched, not hand-authored per string |

**admin-ui ratio:** 5 elements reused (shared) : 1 ported pattern : 7 NEW (the combobox
primitive is counted once even though it serves two fields, per the reuse decision above —
counting it twice would misrepresent a deliberate anti-duplication choice as two separate
builds).

### `shell` — `AccountScreen` (new file) + `UserMenu` (extended)

| Element | Reuse / NEW | Source pattern (path) |
|---|---|---|
| Route registration (`/account`, child of `shellRoute`, no `beforeLoad` access guard) | **Reuse (shared)**, structural pattern | `shell/src/router.tsx`'s existing `notifyRoute` — same shape, same reasoning (every signed-in user must reach it regardless of app grants), already the precedent plan.md cites |
| Read-only value display ("Current address" / "No address on file") | **Reuse (shared)**, styling convention | `admin-ui/src/pages/UserDetail.tsx`'s read-only Identity block (name/email, no inputs) — same visual register, ported as a convention (not a file import, cross-remote) |
| Loading treatment | **Reuse (shared)** | `shell/src/components/RemoteMount.tsx`'s `RemoteLoadingFallback` spinner — already shell-local, no boundary to cross |
| Error + Retry treatment | **Reuse (shared)** | `shell/src/components/RemoteMount.tsx`'s `RemoteErrorFallback` — same `role="alert"`/border/Retry-button shape, already shell-local |
| "My profile" `UserMenu` entry | **Reuse (shared)**, additive | `shell/src/components/UserMenu.tsx`'s existing `role="menuitem"` row pattern (currently only "Sign out") — one more row, same convention |
| `AccountScreen` itself (composition of the above) | **NEW**, but every part it's built from is reused | No existing shell-owned *data* screen (today the shell only renders chrome + `NoAccessScreen`, a zero-fetch empty state) — plan.md's own "honest trade-off" callout; the screen is new, its parts are not |

**shell ratio:** 5 elements reused (shared) : 0 ported patterns : 1 NEW composition (which is
itself assembled entirely from reused parts — the lowest-risk possible shape for "the shell's
first data screen"). Unchanged by this amendment — the Country fix is entirely within
`admin-ui`.

---

## Accessibility

**Target: WCAG 2.2 Level AA**, matching this suite's established target
(`specs/001-estimate-persistence/design.md`, `specs/005-notification-center/design.md`).

- **The Street/address combobox — the hard part.** Implements the WAI-ARIA **combobox with a
  listbox popup** pattern precisely (this repo's first instance, so precision matters more
  than usual):
  - The `<input>` carries `role="combobox"`, `aria-expanded` (true only while the popup is
    open), `aria-controls` pointing at the popup's `id`, and `aria-autocomplete="list"`.
  - The popup is a real `<ul role="listbox" id="…">`; each suggestion is a `<li role="option"
    id="…">` with a stable, predictable id (e.g. `address-suggestion-{index}`).
  - **DOM focus never leaves the `<input>`.** Keyboard highlighting moves via
    `aria-activedescendant` on the input, updated to the highlighted option's id — this is
    the WAI-ARIA-correct alternative to moving real focus into the list, and it is what makes
    "keep typing while suggestions are open" work at all.
  - **Keyboard contract (2.1.1 Keyboard — nothing here is mouse-only, satisfying the
    explicit "selection must never be mouse-only" requirement):** `ArrowDown`/`ArrowUp` move
    `aria-activedescendant` (wrapping at the ends); `Home`/`End` jump to the first/last
    option; `Enter` selects the currently active option (equivalent to a click); `Escape`
    closes the popup without altering the typed text or selection; `Tab` closes the popup and
    moves focus onward normally (it does not select the active option — an explicit `Enter`
    or a click is always required to select, so a focus-out can never silently apply an
    unintended suggestion).
  - **Screen-reader announcement of result count (4.1.3 Status Messages):** a visually-hidden
    `aria-live="polite"` region, separate from the listbox itself, announces "5 suggestions
    available" (or the actual count) the moment a request resolves with results, and "No
    matching suggestions" for the AC-3.1 empty-result case. **It is deliberately never
    updated for the AC-3.2 service-down case** — see the dedicated note below.
  - **The active option is announced via `aria-activedescendant`**, not a second live region
    — per WAI-ARIA authoring practices this is how assistive technology is expected to
    discover the current selection candidate as the admin arrow-navigates; a redundant live
    announcement on every arrow press would be noisy.
  - **On selection**, focus stays programmatically on the `<input>` (never moved into the now
    -closed popup), except for the one deliberate exception already described in F2/Screens
    (`houseNumber` gets real focus when Google returned no house number) — a genuine UX aid,
    not an accessibility violation, since it still lands on a labeled, keyboard-reachable
    `<input>`.
- **The Country combobox — the identical contract, restated concretely, not left as "same as
  above."** Same `role="combobox"`/`role="listbox"`/`role="option"` structure,
  `aria-activedescendant`-driven highlighting, and the exact same keyboard set
  (`ArrowUp`/`ArrowDown`/`Home`/`End`/`Enter`/`Escape`/`Tab`) — a screen-reader or
  keyboard-only admin operates it with muscle memory carried over from Street. Two concrete
  differences, both because the data source is local and synchronous rather than remote:
  - The result-count live region updates **immediately** on every keystroke (no debounce to
    wait for) — "12 countries match" down to "1 country matches" as the query narrows, or "No
    matching country" — still `aria-live="polite"`, never assertive, never focus-stealing,
    exactly the same politeness level as Street's for consistency even though the update is
    instant.
  - There is no "Searching…" announcement and no equivalent of the AC-3.2 silent-degrade
    state, because there is nothing asynchronous to announce and no third-party service that
    can go down — this control's defining accessibility property (and its defining UX
    property, see "Country control" above) is that it has one fewer failure mode than Street
    by construction, not by omission.
  - `<label for>` "Country" applies to the filter `<input>` exactly as every other field's
    label does; because Country is one of the four AC-1.4-required fields, a missing
    selection is announced through the same `aria-invalid`/`aria-describedby`/`role="alert"`
    field-error contract described below — no special-casing for being a combobox rather than
    a plain input.
- **"Service unavailable" is announced by NOT announcing anything — a deliberate parity
  decision, not an oversight.** AC-3.2 requires that no error be surfaced that treats the
  suggestion feature's unavailability as blocking. This design extends that requirement to
  assistive technology specifically: the same `aria-live="polite"` region used for result
  counts is simply **never updated** when a Street request fails, times out, or is
  rate-limited — no message fires, `role="alert"` is never used for this case, and focus is
  never moved or stolen. A sighted admin sees an ordinary text field; a screen-reader user
  hears silence, exactly matching what the sighted admin sees, rather than being told about a
  problem they cannot do anything about and that the visual design intentionally hides from
  everyone else. This is the concrete answer to "how the service-unavailable state is
  announced without stealing focus": it is announced by design as *nothing*, not as a
  quiet-but-present message — the two are different, and this design picks the former
  deliberately, for parity between sighted and non-sighted admins. **This state cannot occur
  for the Country control at all** (see above), which is the accessibility payoff of the
  Country-control resolution just as much as it is the functional one.
- **Validation errors (AC-1.4) are associated with their fields per 1.3.1/4.1.2/3.3.1:** each
  of the four required inputs — City, Street, House number, and Country — gets
  `aria-invalid="true"` and `aria-describedby` pointing at its own `role="alert"` `<p id="…">`,
  identical contract to `AddRateEntryModal`'s existing Rate/Valid-from fields, so assistive
  technology announces exactly which field failed and why, immediately, without the admin
  having to locate a separate summary. No second, redundant alert region duplicates this
  information (see "Screens & states").
- **Coordinate-staleness status line:** `aria-live="polite"`, never `role="alert"` — it is
  informational, not urgent (see the dedicated justification above), and must never steal
  focus from whatever field the admin is actively editing.
- **Clear/Undo flow:** the "Address will be cleared when you save." notice and the Undo
  button appear in an `aria-live="polite"` region so the state change is announced without
  interrupting; the disabled fields (including the Country control) carry
  `aria-disabled="true"` (not a bare `disabled` attribute alone) so their reason for being
  non-interactive is discoverable, same convention `UserDetail.tsx`'s own "Delete user"
  self-guard button already uses on this page.
- **`AccountScreen` read-only guarantee (AC-6.2), stated for a11y specifically:** because
  there is no interactive element at all in the address region, there is nothing to keyboard
  -trap or label — the entire region is `aria-live` or static text. The one thing this screen
  must get right is the **absence** itself, which is why "Screens & states" states it as a
  literal DOM query, not a description.
- **Contrast (1.4.3):** every new color reuses the existing token palette verbatim — no new
  colors. The coordinate-status line and "No matching suggestions"/"No matching
  country"/"Searching…" captions use `--soft` (already validated ≥4.5:1 in both themes per its
  existing usage across the repo); field errors reuse `--red`/`--org` exactly as
  `AddRateEntryModal`/`ErrorBanner` already do.
- **Keyboard operation, generally (2.1.1, 2.4.7 Focus Visible):** every element is a native
  `<button>`/`<select>`/`<input>`/`<a>` except the two combobox popups, which are the one
  deliberate, fully-specified exception described above — matching
  `specs/004-auth-roles-permissions/design.md`'s existing posture verbatim (that document is
  the source of the "every new interactive element is native" rule this feature's own plan.md
  quotes).
- **Postal-code and Region plain-text fields:** each has an explicit `<label htmlFor>` (never
  placeholder-as-label), matching every existing field on this page.

---

## i18n

Per CLAUDE.md ("no hardcoded UI strings… Italian and English at minimum") and the spec's
Constraints (verbatim: "any user-facing copy this feature adds… follows the suite's existing
i18n convention"). `admin-ui` has no i18n runtime today (plan.md **R11**, a pre-existing,
app-wide gap this feature does not create or fix) — its `addressCopy.ts` module (plan.md's
file list) holds `{ it, en }` pairs per key, the exact shape `auth/src/invite/invite.routes.ts`
already uses server-side. Selection heuristic (a plan gap this design fills, since plan.md
specifies the module's shape but not how a locale is chosen): `navigator.language` starting
with `"it"` selects `it`, everything else falls back to `en` — a stateless, one-line
heuristic scoped to this feature's own copy, not a general i18n runtime (out of scope, see
Gaps). `shell`'s `AccountScreen` copy follows the same heuristic for consistency, even though
`shell` itself also has no i18n runtime today.

**Country names are NOT i18n keys.** Every option label in the Country control is produced at
runtime by `Intl.DisplayNames({ type: 'region' }, { locale })` (see "Country control" above)
— there is no hand-authored `{it, en}` pair per country, and nobody should add one. The only
country-related i18n keys are the handful of chrome strings below (label, placeholder,
no-match, result-count) — never the 249 country names themselves.

| Key | English | Italian |
|---|---|---|
| `address.sectionTitle` | Address | Indirizzo |
| `address.currentLabel` | Current address: {formatted} | Indirizzo attuale: {formatted} |
| `address.none` | No address on file | Nessun indirizzo registrato |
| `address.field.street` | Street | Via |
| `address.field.houseNumber` | House/building number | Numero civico |
| `address.field.postalCode` | Postal code | CAP |
| `address.field.city` | City | Città |
| `address.field.region` | Region / canton / state (optional) | Regione / cantone / stato (opzionale) |
| `address.field.country` | Country | Paese |
| `address.field.requiredMark` | (required) | (obbligatorio) |
| `address.field.requiredError` | This field is required. | Questo campo è obbligatorio. |
| `address.save` | Save address | Salva indirizzo |
| `address.saving` | Saving… | Salvataggio… |
| `address.saveError` | Couldn't save this address. Try again. | Impossibile salvare l'indirizzo. Riprova. |
| `address.clear` | Clear address | Cancella indirizzo |
| `address.clearPending` | Address will be cleared when you save. | L'indirizzo sarà cancellato al salvataggio. |
| `address.clearUndo` | Undo | Annulla |
| `address.suggest.searching` | Searching… | Ricerca in corso… |
| `address.suggest.noResults` | No matching suggestions — you can still enter the address by hand below. | Nessun suggerimento trovato — puoi comunque inserire l'indirizzo manualmente qui sotto. |
| `address.suggest.resultCount` | {n} suggestions available | {n} suggerimenti disponibili |
| `address.suggest.noResultsAnnounce` | No matching suggestions | Nessun suggerimento trovato |
| `address.country.placeholder` | Search for a country… | Cerca un paese… |
| `address.country.noMatch` | No matching country | Nessun paese corrispondente |
| `address.country.resultCount` | {n} countries match | {n} paesi corrispondenti |
| `address.coords.captured` | Location coordinates: captured from suggestion. | Coordinate geografiche: acquisite dal suggerimento. |
| `address.coords.cleared` | Location coordinates: cleared — address edited after selecting a suggestion. | Coordinate geografiche: rimosse — indirizzo modificato dopo la selezione di un suggerimento. |
| `address.coords.none` | No coordinates on file. | Nessuna coordinata geografica registrata. |
| `address.history.title` | Address history | Cronologia indirizzo |
| `address.history.empty` | No address changes recorded yet. | Nessuna modifica all'indirizzo registrata finora. |
| `address.history.columns.changedBy` | Changed by | Modificato da |
| `address.history.columns.changedOn` | Changed on | Modificato il |
| `address.history.columns.previous` | Previous | Precedente |
| `address.history.columns.new` | New | Nuovo |
| `address.loading` | Loading address… | Caricamento indirizzo… |
| `account.menuLabel` | My profile | Il mio profilo |
| `account.sectionTitle` | Home address | Indirizzo di casa |
| `account.loading` | Loading your address… | Caricamento del tuo indirizzo… |
| `account.error` | Couldn't load your address. | Impossibile caricare il tuo indirizzo. |
| `account.retry` | Retry | Riprova |
| `account.contactAdmin` | Contact an admin to update this. | Contatta un amministratore per aggiornarlo. |

**Not in the copy module — deliberately English-only:** the Google attribution mark's text
("Powered by Google"), per Google's branding requirements (see next section) — trademark
strings of this kind are conventionally not localized by the integrator.

---

## Google attribution

**The plan does not mention Google's attribution requirement anywhere in its ~1000 lines** —
confirmed by reading plan.md in full (its "Google Maps autocomplete" section covers API
surface, keying, quota, and request parameters in detail, but never the display requirement).
This is flagged in "Gaps" below as a plan omission the architect/PO should be aware of; this
design section fills the gap rather than silently building around a plan-invented answer,
since attribution is a **hard requirement of Google's own terms**, not a UX nicety: when Place
Autocomplete predictions are displayed without an accompanying Google Map (exactly this
feature's situation — plan.md explicitly rejects showing a map, and the spec's Non-goals
forbid one), Google's Places API terms require the "Powered by Google" attribution to be
shown alongside the predictions. **This section is unchanged by the Country-control
amendment** — Country's data is a bundled, static, non-Google ISO list, so no Google
attribution ever applies to it (see "Screens & states" and the component-inventory table
above, both updated to state this explicitly so nobody copies the mark to the wrong popup).

- **Placement:** inside the Street/address suggestion popup itself (the `role="listbox"`
  container), as a persistent footer row — visible every time that popup is open, not only
  after a selection, and not detachable from the suggestions it's attributing. **Never** in
  the Country popup.
- **Asset:** Google's official "Powered by Google" logo (light/dark variants, since this
  suite ships both a dark-ink default theme and a light override) — this must be sourced from
  Google's own Maps Platform branding guidelines/asset kit, **not fabricated** as repo-styled
  text. This is a small, concrete piece of devops/frontend-dev follow-up this design flags
  rather than invents.
- **Never localized, never restyled** beyond swapping the light/dark variant to match the
  active theme — Google's terms govern its presentation, not this repo's design system.
- **Not shown anywhere else** — it has no reason to appear on the read line, the history
  panel, `AccountScreen`, or the Country popup, none of which render live Google data.

---

## Gaps, scope notes & drift (report to PO/architect — not designed around)

1. **Google attribution is entirely absent from plan.md.** Places API (New) terms require the
   "Powered by Google" mark whenever predictions are shown outside a Google Map — true here
   by construction (plan.md explicitly rejects a map). This design specifies where the mark
   goes (inside the Street/address suggestion popup, persistent footer, never the Country
   popup) but the plan itself never acknowledges the requirement, and the asset must be
   sourced from Google's branding kit, not built from scratch. **Route to architect:** add an
   explicit line item for this in the Google Maps setup section of `infra/README.md` alongside
   the referrer/quota/API-restriction steps already documented there.
2. **~~No country-list data source exists anywhere in this repo, and the plan doesn't supply
   one.~~ RESOLVED (this revision).** The first draft of this design left Country as a plain
   free-text input specifically to avoid inventing a 195-entry data source with no plan.md
   backing — but that choice turned out to conflict with plan.md's own `CHECK
   ("countryCode" ~ '^[A-Z]{2}$')` constraint (a free-typed country name simply cannot satisfy
   it, breaking exactly the AC-3.1/AC-3.2 manual-entry guarantee the spec requires). The
   orchestrator resolved this directly: Country is now a typeahead select over a bundled,
   static ISO 3166-1 alpha-2 code list, with labels derived (not hand-authored) via
   `Intl.DisplayNames` — the same API plan.md already uses server-side. Full resolution,
   rationale, and the reuse-of-the-Street-combobox decision are in "Country control — resolved
   design↔plan mismatch" above. No further architect input needed on this point; recorded
   here purely for the audit trail (mirrors plan.md's own "AC-5.2 resolution" documentation
   style).
3. **AC-4.2's "hide, don't disable" rule has no existing precedent on this exact page — and
   this feature does not retroactively apply it to the sections next to it.** Today's
   Attributes/Roles/Departments blocks on `UserDetail.tsx` do not hide themselves for a
   caller whose `apps` includes `admin` via some narrower, non-`admin`-role permission (e.g. a
   `rate:manage` grant) but who lacks the literal `admin` role — they simply render and would
   presumably fail server-side (`403`) on Save today, a gap AC-4.1 of *this* spec technically
   already covers for those fields' underlying routes (`requireAdmin`), but no design work
   before this feature ever added a client-side hide for it. This feature's `AddressSection`
   is the *first* section on this page to implement the hide-if-uncapable pattern (Flow F4).
   **Route to PO/architect:** decide whether Attributes/Roles/Departments should be
   retroactively updated to match — out of this feature's scope either way, flagged so it
   isn't mistaken for an oversight in this design.
4. **`AccountScreen`'s nav entry, "My profile," is broader than what the screen currently
   shows.** Only the address (US-6's sole ask) is rendered. This design keeps the label as-is
   (plan.md's own choice, and a reasonable one for a route that may grow) but titles the
   in-screen section "Home address" specifically, so nothing on the screen implies a fuller
   profile exists yet. Not a defect — noted so a future profile-expanding feature has an
   obvious place to add sections rather than needing to rename the entry point.
5. **No AC asks for a map or geographic visualization anywhere** (spec Non-goals, explicit) —
   confirmed no screen in this document renders one, including the coordinate-status line,
   which is text-only by design.
6. **Every US/AC maps to a flow or state in this document; no UI was added that isn't asked
   for.** The one place this design goes slightly beyond the spec's literal text is the
   coordinate-staleness status line (AC-2.6 only requires the *data* to be dropped, not that
   the admin be told) — justified at length above as the deliberate, minimal-footprint choice
   that best serves AC-2.3's "never locks, always editable" spirit without inventing a new
   screen or dialog.

---

## Summary for the record

- **Flow count:** 6 (F1 admin views, F2 admin sets/edits with suggestions, F3 admin clears,
  F4 non-capable admin blocked, F5 admin views history, F6 employee self-view).
- **Screens/states:** 1 extended screen (`AddressSection` on Screen C2, with ~14 shared/
  Street-specific states spanning Abs/L/E/P/Edit sub-states/Err, plus 4 Country-specific
  sub-states: closed/idle, open/filtering, no-match, selected), 1 sub-panel (history), 1 new
  shell screen (`AccountScreen`, 4 states), 1 chrome addition (`UserMenu` entry).
- **Component ratio:** `admin-ui` — 5 reused (shared) : 1 ported pattern : 7 NEW (the
  combobox primitive is built once and counted once, serving both the Street and Country
  fields — see the reuse decision below). `shell` — 5 reused (shared) : 0 ported : 1 NEW
  composition assembled entirely from reused parts. Unchanged from the prior revision on the
  `shell` side; the `admin-ui` NEW count moved from 6 to 7 (the Country-specific caption/copy
  variants and the bundled ISO list are now itemized) while the *combobox itself* stays a
  single entry precisely because it is not duplicated.
- **Country control reuses the Street combobox primitive — one accessible component, two
  consumers.** Decided and justified in "Country control — resolved design↔plan mismatch"
  above: identical ARIA contract (role/listbox/option/`aria-activedescendant`/keyboard set),
  differing only in data source (local synchronous filter vs. debounced Google fetch) and
  what a selection writes back. A second, parallel implementation was rejected as pure
  duplication of a dozen a11y-load-bearing behaviors for zero UX benefit, in a repo where this
  is already the first-ever ARIA combobox.
- **Coordinate-staleness call (AC-2.3/AC-2.6):** **visible**, via a calm `aria-live="polite"`
  status line, never silent and never styled as an error — justified in "Screens & states"
  above (admin transparency for a real, if consequence-free, data change). Changing the
  Country control after a suggestion selection counts as a hand-edit for this rule exactly
  like any other field.
- **Clear-address call (AC-1.3):** **no modal**; an inline queue-then-Save-to-confirm flow
  with Undo, reusing the page's existing explicit-Save gate as the actual confirmation step —
  justified above (genuinely reversible until Save, permanently recoverable via audit
  history afterward, consistent with the specs/011 precedent the spec's own Constraints cite).
- **Service-down vs. no-results call (AC-3.1 vs AC-3.2):** visually and audibly distinguished
  for Street — AC-3.1 gets a calm helper caption + a "no results" announcement; AC-3.2 gets
  **nothing at all**, deliberately, for sighted/screen-reader parity and to honor "no error
  surfaced" literally. **This distinction does not exist for Country**, which cannot go down
  and always shows a direct "no match" state — the functional and accessibility payoff of the
  Country-control resolution.
- **Top a11y hotspot:** the shared combobox primitive — this suite's first genuine ARIA
  combobox pattern (no in-repo precedent), fully specified above (roles,
  `aria-activedescendant`, keyboard contract, live-region split between "announce a result,"
  "announce nothing," and Country's "announce instantly, always").
- **Gaps/drift routed to PO/architect:** (1) Google attribution missing from plan.md
  entirely — still open, unaffected by this revision, (2) the country-list gap flagged in the
  prior revision is **now resolved** within this document itself (see "Country control"
  above) — recorded for the audit trail, no further architect input needed, (3) AC-4.2's
  hide-not-disable pattern has no precedent and is not retroactively applied to this page's
  other sections, (4) `AccountScreen`'s "My profile" label is broader than its current
  single-section content. No scope creep found in the other direction — every screen/state in
  this document traces to at least one AC, and AC-6.3/AC-6.4 correctly have no UI surface
  (server-only guarantees).
