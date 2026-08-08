---
spec: 001
status: draft
---

# Design: Estimate persistence API

## Flows

### Flow 1 — Save an estimate (US-1, AC-1.1 / AC-1.2 / AC-1.3 / AC-1.4)

Entry point: user is editing an estimate in the EstimatorApp (`/estimates/$estimateId`).

Steps:
1. Any field change (name, author, params, releases, activities) fires the auto-save
   effect in `EstimatorProvider` (currently debounced via `saveTimer`).
2. The effect calls `estimatesApi.create` (POST) on first save, or `estimatesApi.update`
   (PUT) on subsequent saves, passing `{ name, author, content: { params, releases, acts } }`.
3. While the request is in-flight, the Header save indicator shows "Saving…" (replaces the
   existing "✓ Saved" slot — same `aria-live="polite"` region).
4. On success (201 / 200): save indicator transitions to "✓ Saved" for 2 s then fades out
   (existing behaviour, already implemented in `Header`). The returned `id` is stored so
   subsequent saves use PUT.
5. On network failure (AC-1.3): save indicator shows "Save failed" in `--color-org`
   (amber). In-memory state is untouched. A retry happens on the next edit-triggered
   debounce cycle.
6. On 413 (AC-1.4): a toast banner appears above the editor content area: "Estimate too
   large to save (X MB). Maximum is 1 MB. Your work is safe in this tab." In-browser state
   is not cleared.

Success exit: indicator shows "✓ Saved"; user continues editing.
Error exit (AC-1.3): indicator shows "Save failed"; work preserved; retry on next change.
Error exit (AC-1.4): toast banner; work preserved; no retry (payload would still be too large).

### Flow 2 — List and reopen estimates (US-2, AC-2.1 / AC-2.2 / AC-2.3)

Entry point: user navigates to `/estimates` (via "My Estimates" button in Header, or directly).

Steps:
1. `EstimatesPage` mounts; fires `estimatesApi.list` (GET /estimates).
2. While loading: skeleton list (3 placeholder rows) replaces the estimate rows area;
   header actions remain usable.
3. On success with items (AC-2.1): list renders sorted by `updatedAt` descending, each row
   showing name and formatted date. Row actions (Open, Duplicate, Export JSON, Delete)
   remain as-is.
4. On success with empty array (AC-2.3): existing empty state renders unchanged — "Ready to
   estimate your first project?" with "+ New estimate" and "Load example" CTAs. No error
   shown.
5. On list fetch error: error banner replaces the list body ("Could not load your estimates.
   Check your connection and refresh.") with a Retry button.
6. User clicks "Open" or the row body: navigates to `/estimates/$estimateId`; the route
   beforeLoad guard calls `estimatesApi.get` (or the router loader does) to confirm the
   estimate exists (owned); on 404 redirects to `/estimates`.
7. EstimatePage mounts; `EstimatorProvider` initialises state from the API response body
   (`content.params`, `content.releases`, `content.acts`); all computed values (PERT,
   Expected, Elapsed) derive from `useEstimator` as before (AC-2.2).

Success exit: editor loaded with persisted content.
Error exit: route guard catches 404/401 → redirect to `/estimates`.

### Flow 3 — Delete an estimate (US-3, AC-3.1 / AC-3.2)

Entry point: user is on `/estimates`; clicks the "×" delete button on a row.

Steps:
1. A confirm dialog (`ConfirmDeleteModal`) opens, showing: "Delete 'Acme API'? This
   cannot be undone." with two actions: "Delete" (destructive, `--color-red`) and "Cancel".
2. AC-3.2: user clicks "Cancel" — modal closes; estimate row unchanged; no API call made.
3. AC-3.1: user clicks "Delete" — button shows a spinner; `estimatesApi.delete` is called
   (DELETE /estimates/{id}); on 204 the modal closes and the list refreshes (item gone).
4. On delete error (network, unexpected 5xx): modal stays open; an inline error message
   appears inside the modal: "Delete failed. Try again." The Delete button re-enables.

Success exit: item removed from list; list re-renders.
Error exit: modal open with inline error; item still present.

### Flow 4 — Size-limit rejection (AC-1.4)

Entry point: auto-save triggers while editing an unusually large estimate.

Steps:
1. PUT (or POST) returns 413 with Problem JSON: `detail` contains human-readable sizes.
2. Save indicator transitions to "Save failed" (amber).
3. A dismissible toast banner appears in the editor (see Screen: EstimatorApp — toast zone)
   using the `detail` string from the Problem response: "Estimate too large to save (X MB).
   Maximum is 1 MB. Your work is safe in this tab."
4. No local data cleared. No auto-retry (the payload cannot shrink automatically).
5. User dismisses the toast or reduces activities; on the next edit the save cycle restarts.

Note: This flow is a sub-path of Flow 1 (save failure), called out separately because the
user message and retry behaviour differ from network failure.

### Flow 5 — One-time import of local estimates (US-5, AC-5.1 / AC-5.2 / AC-5.3 / AC-5.4)

Entry point: user signs in (or first page load in a fresh session) with legacy
`estimai_project_*` keys present in localStorage and at least one of those not yet in
their account.

Detection (in `EstimatesPage` or a top-level authed layout effect):
- Check `loadProjects()` (from `lib/projects.ts`) for any `estimai_project_*` keys.
- Check a session-scoped flag (`sessionStorage.getItem('import_offer_dismissed')`) — if
  set, skip the offer (AC-5.3).
- If local estimates exist and flag is not set: show `ImportOfferModal`.

Steps (accept path, AC-5.1 / AC-5.2 / AC-5.4):
1. `ImportOfferModal` renders with: title "Import your local estimates", a count badge ("3
   estimates found"), explanatory text, and two primary actions: "Import all" (accent) and
   "Skip" (muted/outline).
2. User clicks "Import all": button shows spinner; modal body transitions to an in-progress
   view ("Importing 3 estimates…" with a progress indicator).
3. `POST /estimates/import` is called with all local estimates mapped to
   `{ localId, name, author, content }`.
4. Response arrives (200 with `results[]`).
5. AC-5.4 (partial failure): `ImportResultsView` renders inside the modal (replaces the
   progress view), showing a per-estimate status table: name, status badge
   ("Imported" in green / "Failed" in amber + truncated error reason). A summary line:
   "2 of 3 imported successfully. 1 failed." Close button becomes available.
6. Local `estimai_project_*` keys are NOT removed regardless of outcome (AC-5.4).
7. The list page refreshes (re-fetches GET /estimates) to reflect newly imported estimates.
8. No session dismissal flag is set on accept — offer does not re-appear because the local
   keys are now accounted for (or the user can re-import if needed on a future session by
   not setting the dismissed flag; this is an implementation detail — the spec only
   mandates AC-5.3 for decline).

Steps (decline path, AC-5.1 / AC-5.3):
1. User clicks "Skip": modal closes immediately.
2. `sessionStorage.setItem('import_offer_dismissed', '1')` is set.
3. Local estimates are untouched.
4. For the remainder of the session, `EstimatesPage` mount-effect checks the flag and skips
   showing the offer.

Success exit (full import): all items show "Imported"; list refreshed; modal closeable.
Success exit (partial): per-estimate results shown; list refreshed; user can close.
Decline exit: modal closed; flag set; no nag for session.

---

## Screens & states

### Screen A: EstimatesPage (`/estimates`)

**Purpose:** List all saved estimates, provide entry to the editor, and host the
one-time import offer.

**Key elements (unchanged from current):**
- Sticky header with logo, "Import JSON" file button, "+ New estimate" button, UserMenu.
- Empty state card (AC-2.3) — reused as-is; triggered when API returns `[]`.
- Estimate list rows: name, author dot date, Open / Duplicate / Export / Delete actions.
- FAB "+ " (floating action button) when list is non-empty.

**New states layered on top:**

| State | Trigger | UI |
|---|---|---|
| Loading | GET /estimates in-flight on mount | Skeleton: 3 placeholder rows (rounded rects at `bg-ink-mid` opacity-50, animated pulse) replacing the list body; header actions still usable |
| List load error | GET /estimates returns non-2xx or network error | Error banner (amber, `--color-org`) replacing list body; "Could not load your estimates." + Retry button |
| Empty (no estimates) | GET /estimates returns `[]` | Existing empty state card — no change |
| Populated list | GET /estimates returns items | Existing list rows with name + formatted `updatedAt` (AC-2.1) — no change in layout, only data source changes |
| Delete in-progress | DELETE called after confirm | Row's "×" button shows inline spinner; row not yet removed |
| Import offer | Session flag not set + local estimates exist | `ImportOfferModal` overlays the page |

**Loading state specifics:** The skeleton rows use `bg-ink-mid` with an animated pulse
(Tailwind `animate-pulse`) for the name and date line, matching the existing row layout
dimensions. Three rows are sufficient.

### Screen B: EstimatorApp (`/estimates/$estimateId`)

**Purpose:** Edit a single estimate; auto-save to the API.

**Key elements (unchanged from current):**
- `Header` with project name/author inputs, save indicator slot, "My Estimates" nav,
  `UserMenu`.
- `MetricsBar`, tab bar (Activities / Summary / Parameters), toolbar actions (Share, Export).
- `ActivityTable`, `SummaryTable`, `ParametersPanel`.

**New states layered on top:**

| State | Trigger | UI |
|---|---|---|
| Saving | PUT/POST in-flight (debounced) | Header save indicator: "Saving…" in `--color-soft` (replaces current "✓ Saved" logic; same `aria-live` region) |
| Saved | 200/201 response | Header: "✓ Saved" in `--color-grn` for 2 s then fades (existing behaviour) |
| Save failed (network) | Non-413 error on PUT/POST | Header: "Save failed" in `--color-org`; work preserved; retries on next edit |
| Save failed (413 too large) | 413 response | Header: "Save failed" in `--color-org` + dismissible toast banner below tab bar: amber left-border strip with Problem `detail` text and "×" dismiss |
| Not found on load | GET /estimates/{id} → 404 | Route guard redirects to `/estimates`; no editor renders |
| Loading on open | GET /estimates/{id} in-flight (router loader) | Existing page skeleton / spinner (the route can defer; this is an implementation choice — see gap note) |

**Toast zone:** A narrow strip (`px-5.5 py-2 border-l-2 border-org bg-org/10 text-sm
text-text`) immediately below the tab bar, above the main content area. Dismiss button
("×") on the right. Only one toast shown at a time; the 413 toast does not auto-dismiss
(it is a persistent warning requiring user action). Network-failure toasts may auto-clear
after a successful retry.

### Screen C: ConfirmDeleteModal

**Purpose:** Confirm destructive deletion of a saved estimate (AC-3.2).

**Key elements:**
- Modal shell reusing the `HealthWarningsModal` / `QrModal` pattern: `fixed inset-0 z-50
  flex items-center justify-center bg-black/60 backdrop-blur-sm`; inner panel `bg-ink-soft
  border border-rule rounded-lg shadow-2xl w-full max-w-sm mx-4 p-5`.
- Header row: title "Delete estimate?" with "×" close button.
- Body: "'{estimate name}' will be permanently deleted. This cannot be undone."
- Footer: two buttons side-by-side — "Cancel" (outline, `border-rule text-muted`) and
  "Delete" (`bg-red text-white` or `text-red border-red`).
- Deleting state: "Delete" button shows inline spinner text "Deleting…" and is disabled;
  "Cancel" is disabled.
- Inline error state: error message appears between body and footer in `text-org`.

**States:**

| State | Trigger | UI |
|---|---|---|
| Idle | Dialog open | Title, body text, Cancel + Delete buttons |
| Deleting | User confirms, DELETE in-flight | "Deleting…" spinner; both buttons disabled |
| Error | DELETE returns non-204 | Inline error text; Delete re-enabled; Cancel re-enabled |

**Note on current implementation:** The existing codebase uses `window.confirm()` for
delete confirmation in both `EstimatesPage` (estimate delete) and `EstimatorApp`
(release delete). This design replaces the `confirm()` call for estimate deletion only
with a proper modal (required for proper a11y focus management and keyboard trapping). The
release delete confirm in `EstimatorApp` is out of scope for this spec.

### Screen D: ImportOfferModal

**Purpose:** One-time offer to migrate legacy localStorage estimates to the account (US-5).

**Key elements:**
- Modal shell: same pattern as `ConfirmDeleteModal` (max-w-md for slightly more width).
- Offer view (initial):
  - Header: "Import your local estimates" + "×" close (= decline + set session flag).
  - Body: "{N} estimate(s) found in this browser that are not yet in your account. Import
    them now to access them from any device. Your local copies are always kept."
  - Optional name list: up to 3 names shown (`text-[11px] text-soft font-mono`); "+ N
    more" if there are more than 3.
  - Footer: "Import all" (accent primary button) | "Skip for now" (text button, `text-muted`).
- In-progress view (after "Import all"):
  - Header stays: "Importing estimates…"
  - Body: progress indicator — simple text "Importing {N} estimates…" with a Tailwind
    `animate-spin` spinner icon; close button hidden to prevent premature close during
    the request.
- Results view (after POST /estimates/import responds, AC-5.4):
  - Header: "Import complete" (or "Import finished" if partial failure).
  - Summary line: "{imported} of {total} imported successfully." (green if all, amber if
    partial).
  - Per-estimate results table: name column + status badge column.
    Status badge: "Imported" (`text-grn bg-grn/10`) or "Failed" (`text-org bg-org/10`).
    On "Failed" rows: a second line in `text-muted text-[11px]` with the truncated `error`
    string from the API.
  - Footer: "Close" button (accent outline).
  - Note: local copies always remain — no mention of deletion.

**States:**

| State | Trigger | UI |
|---|---|---|
| Offer | Modal open, no action yet | Name list, "Import all" + "Skip for now" |
| Importing | "Import all" clicked | Spinner, no close button |
| Results — all success | All `status: "imported"` | Green summary; table with "Imported" badges; Close |
| Results — partial failure | Mix of imported/failed | Amber summary; table with mixed badges + error hints; Close |
| Results — all failed | All `status: "failed"` | Amber "0 of N imported"; table with "Failed" + errors; Close |

---

## Component inventory

Library in use: **Tailwind CSS 4** (custom `@theme` tokens in `estimai-ui/src/index.css`)
with bespoke component patterns (no external component library — no Mantine, MUI, shadcn/ui, etc.).

| UI element | Existing component / pattern to reuse | Status |
|---|---|---|
| Modal shell (overlay + panel) | `HealthWarningsModal` / `QrModal` / `ShortcutsModal` — `fixed inset-0 z-50 bg-black/60 backdrop-blur-sm` pattern + inner panel | REUSE |
| Keyboard close (Escape) | `useEffect` + `window.addEventListener('keydown')` pattern in all three modals | REUSE pattern |
| Click-outside close | Backdrop `onClick={onClose}` + inner panel `onClick={e => e.stopPropagation()}` | REUSE pattern |
| Save indicator in Header | `Header.tsx` — existing `saveStatus` prop + `aria-live="polite"` span | REUSE (extend `saveStatus` type from `'idle' | 'saved'` to include `'saving' | 'error'`) |
| User menu in header | `UserMenu.tsx` | REUSE |
| Estimates list row | `EstimatesPage.tsx` — existing row layout with name/date/action buttons | REUSE (data source changes from localStorage to API) |
| Empty state | `EstimatesPage.tsx` — existing empty-state card | REUSE |
| Formatted date helper | `formatDate()` in `EstimatesPage.tsx` — reads `updatedAt` ISO string | REUSE |
| Accent primary button style | `py-2 text-sm font-medium text-white bg-acc hover:bg-acc/90` (used on "+ New estimate") | REUSE pattern |
| Outline secondary button style | `border border-rule text-muted hover:text-text` (used across page) | REUSE pattern |
| Destructive button style | `text-red hover:border-red` (used on existing delete "×" button in EstimatesPage) | REUSE pattern |
| Skeleton list rows | None exists | NEW — justified: first async list load requires a loading affordance; the app has no existing loading skeleton pattern |
| `ConfirmDeleteModal` | None exists — current code uses `window.confirm()` | NEW — justified: `window.confirm()` is inaccessible (no focus trap, no keyboard navigation, no custom styling); a proper modal is required by the a11y requirements below |
| `ImportOfferModal` (offer + progress + results views) | None exists | NEW — justified: three-phase import flow (offer / in-progress / results with per-estimate table) is unique to US-5 and has no analogous existing component |
| Toast banner (save error / 413) | None exists | NEW — justified: the editor needs a non-blocking persistent error indicator for the 413 and network-save-failure paths; `alert()` would block editing and lose work |
| Saving/error states in `saveStatus` | `Header.tsx` — extend existing `saveStatus` prop | REUSE (extension, not new component) |

**Reuse / NEW ratio: 9 patterns reused, 4 new components** (SkeletonListRows,
ConfirmDeleteModal, ImportOfferModal, ToastBanner).

---

## Accessibility

### ConfirmDeleteModal

- **Focus trap:** On open, focus moves to the "Cancel" button (safe default — avoids
  accidental destruction). Tab cycles between Cancel and Delete only while the modal is
  open.
- **Keyboard:** Escape closes the modal (= Cancel; no delete). Enter on focused "Delete"
  triggers deletion.
- **ARIA:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to the modal
  title. The title "Delete estimate?" is the accessible name.
- **Announcement:** After successful delete and modal close, the estimates list should
  announce the removal. Since the list re-fetches and re-renders, screen-reader users
  naturally encounter the updated list. An `aria-live="polite"` region on the page (or on
  the list container) can announce "Estimate deleted." to supplement.
- **Contrast:** "Delete" button uses `--color-red` (#f55a5a on dark) — check against
  `--color-ink-soft` (#13131e): contrast ratio ~5.5:1, passing WCAG AA for normal text.

### ImportOfferModal

- **Focus trap:** On open, focus moves to "Import all" (the primary action). Tab cycles
  between "Import all" and "Skip for now" (and "×" close). While importing (in-progress
  view), all interactive elements are disabled; focus stays on the spinner area.
- **Keyboard:** Escape = Skip (dismiss + set session flag). During import, Escape is
  suppressed (close button hidden) to prevent mid-import abandonment.
- **ARIA:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on title. In-progress
  view: `aria-live="polite"` region announces "Importing complete. {N} of {M} imported."
  when results arrive. The per-estimate results table uses `<table>` with `<th scope="col">`
  for name and status columns.
- **Status badges:** Do not rely on colour alone. "Imported" badge shows a checkmark
  character; "Failed" badge shows "!" or "×" character in addition to colour.
- **Announcement of result:** The results view `aria-live` region fires once; does not
  repeat on tab focus.

### Save error toast (ToastBanner in EstimatorApp)

- **Placement:** Below the tab bar, above content — within the natural document flow,
  not a floating overlay, so it does not steal focus.
- **ARIA:** `role="alert"` (for errors) so screen readers announce immediately on insertion
  without requiring user navigation.
- **Dismiss:** "×" dismiss button has `aria-label="Dismiss"`. After dismiss, focus returns
  to the previously focused element.
- **Contrast:** Amber `--color-org` (#f5a623) text on `--color-org/10` background over
  `--color-ink` (#0d0d14): the text itself is displayed against near-black — contrast
  well over 4.5:1.

### EstimatesPage list

- **Loading state:** Skeleton rows are `aria-hidden="true"` (decorative); an
  `aria-live="polite"` region at the top of the list container announces "Loading your
  estimates" while loading and "N estimates loaded" when the list resolves.
- **List load error:** Error banner has `role="alert"`. Retry button is reachable by
  keyboard.
- **Row actions:** Existing "Open", "Duplicate", "Export JSON", "×" buttons already have
  `title` attributes. The "×" delete button should also have an explicit `aria-label="Delete
  '{estimate name}'"` to distinguish multiple delete buttons in the list (currently all
  "×" buttons are identical to screen readers).

### Header save indicator

- Already uses `aria-live="polite"`. The new "Saving…" and "Save failed" states are
  announced automatically by the existing mechanism.

---

## Gaps found in spec or plan

### Spec gaps (none blocking design, flagged for awareness)

**G-1 (spec, minor):** AC-5.3 says "the offer is not repeated on every page load within
the same session." The spec is silent on what happens in a *new* session on the same
browser if the user declined. The design defaults to showing the offer again on a new
session (sessionStorage is cleared on tab/window close) — which is the most natural
behaviour and does not violate any AC. No spec amendment required; implementation can
confirm this interpretation.

**G-2 (spec, minor):** AC-5.2 says "each local estimate appears in their account list
with content identical to the local version." There is no mention of `id` continuity
(local `estimai_project_*` IDs are random strings; the API assigns new CUIDs). This is
consistent with the plan's `localId` field in the import response (used only for
correlation in the results view), but the spec's phrasing could mislead. No design impact.

### Plan gaps (none blocking, one observation)

**G-3 (plan, implementation detail):** The plan states "router guards must not delete or
depend on localStorage estimates" (Risks section) and that the `estimateRoute` `beforeLoad`
guard moves to a server existence check. However, the plan does not specify what the
router loader shows while `GET /estimates/{id}` is in-flight. The design assumes a minimal
loading state (the page skeleton is effectively the empty `EstimatorApp` before context
loads) — this is an implementation detail but worth confirming with the frontend task so
no blank flash occurs.

**G-4 (plan, no API gap):** All five flows have corresponding endpoints in the plan's API
contract. No missing endpoint found.

**G-5 (scope creep check):** No UI has been designed beyond what the ACs require. Three
items were explicitly checked and excluded:
- Conflict / stale-write warning: non-goal (last-write-wins, spec §Non-goals). **Amended 2026-08-07 by
  `specs/013-estimate-sharing`** ([ADR-0038](../../docs/adr/0038-optimistic-concurrency-version-if-match-cas-amends-0004.md)):
  last-write-wins is no longer the posture — saves now require a `version`/`If-Match`
  precondition. This design remains accurate for what spec 001 shipped.
- Per-user quota display: non-goal.
- Removing local estimates after successful import: explicitly prohibited by AC-5.4.

**AC-4.1 / AC-4.2 (US-4 — privacy):** These ACs are enforced entirely server-side (JWT
verification + userId scoping). There is no new UI surface for US-4. This is correct and
intentional — logged-in users never see other users' data because the API returns 404 for
records they do not own.
