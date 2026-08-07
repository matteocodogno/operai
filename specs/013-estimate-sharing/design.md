---
spec: 013
status: draft
---

# Design: Estimate sharing — invite registered EstimAI users to collaborate on an estimate

## Grounding

Reviewed before drafting: `estimai-ui/src/EstimatorApp.tsx` (toolbar/tab layout, CSS-variable
tokens in `index.css`), `src/components/{ActivityTable,SummaryTable,ParametersPanel,Header,
ToastBanner,ConfirmDeleteModal,WarningBadge,TemplatePicker}.tsx`, `src/pages/{EstimatesPage,
EstimatePage,SharedEstimatePage}.tsx`, `src/context/EstimatorContext.tsx`, `src/lib/
{shareUrl,estimatesApi}.ts`, `shell/src/components/Bell.tsx` + `lib/notifications.ts`, and the
comparable patterns already shipped in `refund-ui` (`EntityBadge`, `ErrorBanner`, `strings.ts`)
and `admin-ui` (`InviteUserModal`, `GuardrailDialog`, `ErrorBanner`, `PermissionDenied`).
estimai-ui has **no component library** beyond its own hand-rolled vocabulary + Tailwind 4
utility classes against the `--ink/--acc/--org/--red/…` tokens in `index.css` — reuse means
reusing *these* components and *this* visual language, not importing a design system.

Federation note (ADR-0006) carried over from admin-ui/refund-ui precedent: estimai-ui cannot
import components across the remote boundary, so "reuse" of a pattern seen in `admin-ui`/
`refund-ui` (e.g. `InviteUserModal`'s dialog shell) means re-implementing the same shape
locally, not an import. Called out per-component below.

## Flows

### US-1 — Owner adds a collaborator (AC-1.1–1.6)
Entry: toolbar **Collaborators** button (owner only) → CollaboratorsDialog opens →
**Add collaborator** form (email + level) always visible above the list for the owner →
submit → success: row appears, email field clears, focus returns to email field, live region
announces "*{email} added as {level}*" (AC-1.1) → dialog stays open (add-another is the
common case: a lead sharing with two colleagues in a row). Failure exits: generic 422
(AC-1.2), 409 already-collaborator (AC-1.3), 422 self (AC-1.4), 503 auth-unavailable, 429
rate-limited — all inline under the email field, form re-enabled, nothing added to the list.
A collaborator opening the dialog never sees the add form at all (AC-1.5 is enforced
server-side; the UI simply never renders a control that would 403) — see "Viewer/collaborator
mode" screen below. AC-1.6 (stranger, 404) has no dialog surface — it's the existing
"estimate not found" redirect already in the router loader, unchanged.

### US-2 — Collaborator finds shared estimates in their list (AC-2.1–2.3)
Entry: `/estimates` (existing route, no new entry point) → list now unions owned + shared
rows → a shared row carries an `AccessLevelBadge` ("Editor"/"Viewer") that an owned row never
has (AC-2.2) → owner identity renders next to it via `formatIdentity` (active name / "Former
wellD member" / "Unknown wellD member" — AC-10.5) → clicking **Open** behaves identically to
an owned row. Empty state: only shown when the *combined* list is `[]` (AC-2.3 falls out of
using the union length, not a new condition).

### US-3 — Access level governs capability (AC-3.1–3.3)
Entry: opening any estimate → `EstimatePage`'s loader already fetched `EstimateFull` incl.
`access` → `EstimatorProvider` derives one `canEdit = access !== 'viewer'` boolean → every
mutating control in the tree reads that one flag (see "Viewer mode" below) → exports/link
share are unconditional or every access level (AC-3.1). Owner-only actions (delete estimate,
manage collaborators, AC-3.3) check `access === 'owner'` — the *same* flag family, not a
second ad hoc check per screen.

### US-4 — Conflict detected, recovered (AC-4.1–4.4)
Entry: any save (manual autosave tick) → `estimatesApi.update` sends `If-Match` → server
returns 409 (or 428 for a pre-rollout tab) → `EstimatorContext`'s autosave effect catches
`ConflictError`, enters `conflict` state, **stops scheduling further autosaves** (AC guard),
and leaves `name/author/params/releases/acts` untouched → `ConflictBanner` replaces the
toast zone → user picks **Reload latest** (route invalidate → `EstimatorProvider` remounts on
the new `version` key, discarding only what was never saved and was superseded) or **Save as
a copy instead** (creates a new estimate the user owns from their current in-memory content,
navigates there, original tab's unsaved edits now live safely under a new id) → conflict
state clears either way. AC-4.4's two-tabs-same-owner case is the *same* flow — the banner
doesn't know or care whether the other writer was the same person in another tab or a
collaborator.

### US-5 — Owner manages/revokes access (AC-5.1–5.4)
Entry: CollaboratorsDialog, owner mode → each row has a level `<select>` (Viewer/Editor) and
a **Remove** action → level change is optimistic-with-rollback-on-error, no confirmation (US-5
frames this as routine, reversible) → Remove opens the generalized confirm modal ("Remove
collaborator?") → confirm → row disappears, live region announces removal (AC-5.1/5.2). No
owner row ever appears in this list (AC-5.4 — structurally impossible per AC-1.4, so nothing
to filter client-side).

### US-6 — Collaborator leaves (AC-6.1–6.2)
Entry: CollaboratorsDialog, collaborator/member mode → single **Leave this estimate** action
→ confirm modal ("Leave this estimate?") → confirm → estimate disappears from the user's own
`/estimates` list on next load; if they're currently inside the estimate, nothing forces them
out immediately (matches AC-5.3's next-request posture) but the toolbar chip's Leave action
is now the origin, not the owner's Remove. An owner never sees this action (AC-6.2) — the
dialog mode is derived from `access`, not a separate flag.

### US-7 — Notification on grant/removal (AC-7.1–7.3)
No new estimai-ui screen. The recipient's existing shell **Bell** (`shell/src/components/
Bell.tsx`, ADR-0009) picks up the push exactly as it does for refund-api's decision
notifications — unread badge increments, `/notify` lists the new entry with the copy
specified below, and (grant only) its link deep-links to `/estimai/estimates/{id}`. No
component changes needed in `notify-ui`; only the payload copy is new, and it is authored
**server-side** in `estimai-api` (mirroring `refund-api/src/lib/notify.ts`'s precedent of
inline strings, not `estimai-ui`'s `strings.ts` — see i18n section).

### US-8 — Link share stays untouched and distinct
See "Toolbar composition decision" below — this is the flow the whole toolbar layout serves.
`SharedEstimatePage` itself needs **zero** changes (AC-8.1/8.2); it is guarded by the existing
regression test asserting it performs no `apiFetch` call, confirmed unaffected by this design.

### US-9 — Delete cascades (AC-9.1)
No new UI. `ConfirmDeleteModal`'s existing copy ("… will be permanently deleted") on
`EstimatesPage` is unchanged; the plan's cascade is a DB-level `onDelete: Cascade`, invisible
to the deleting owner. The only UI-visible effect is on the *other* end: a former
collaborator's next list load simply no longer shows the row — no error, no toast, it's just
gone (same as any other estimate that stopped existing).

### US-10 — Orphaned estimate (AC-10.1–10.5)
No dedicated screen — this is a *rendering rule* that applies everywhere an owner identity or
an owner-only control would otherwise appear: `formatIdentity` renders the placeholder
(AC-10.5) and every owner-gated control (Delete, Collaborators-as-owner, Remove/level-change
rows) is simply absent for every remaining user, because they all key off the same
`access === 'owner'` check that is now permanently false for everyone. See "Orphaned estimate"
row in the screen inventory.

## Toolbar composition decision (US-8)

**Decision: two separate, differently-shaped toolbar entries — never a shared button, never a
dropdown with two "modes."**

```
Owner:        [ ⤴ Share link ]  │  [ 👥 Collaborators (3) ]  │  [ Client ] [ PDF ]  │  [ Excel ]  │  [ ? ]
Collaborator: [ ⤴ Share link ]  │  [ 👥 Shared by Marco R. · Editor ]  │  [ Client ] [ PDF ]  │  [ Excel ]  │  [ ? ]
```

The existing **Share** button is relabelled **"Share link"** with its icon (⤴), color
(`text-acc`/`border-acc/30`), click handler (`buildShareUrl` + clipboard), and copied-state
feedback (✓ Copied!) all **unchanged** — AC-8.1 requires the behavior untouched, and "Share
link" is a strict superset of the old label's meaning, not a reinterpretation. A new
**"Collaborators"** control sits in its own group, separated by the toolbar's existing
divider convention (`<div className="w-px h-4 bg-rule mx-0.5" />`, already used between every
other logical group), with a **different glyph** (👥, a people icon — never the export arrow),
a **different visual treatment** (neutral `border-rule`/`text-muted` rather than the accented
`border-acc` styling Share link uses — it is not an export action, it shouldn't look like one),
and a numeric badge only when count > 0 (mirrors the tab bar's existing warning-count pill,
`bg-white/20`-on-active / `bg-org/20`-on-inactive convention, recolored neutral here since this
isn't a warning).

**Why two entries, not one button with two modes.** A single "Share ▾" control that opens a
menu with "Share a link" / "Manage collaborators" items would force the user to already
understand the distinction the spec is trying to protect (AC-8.2: "a recipient can't mistake
'I have a link' for 'I'm a collaborator'") *before* they can act on it — they'd have to read
and correctly interpret two menu items under one ambiguous parent label at the exact moment
they're deciding what to do. Worse, nesting both under one entry point visually implies they
are two flavors of the same action ("sharing"), when they are opposites on every axis that
matters: no-account vs. account-required, ephemeral snapshot vs. live persistent grant,
anonymous vs. attributable, revocable vs. not. Two always-visible, differently-labelled,
differently-iconed buttons let the user pick the right one by reading a label once, with no
menu to open and no taxonomy to learn first. The toolbar is already crowded — but "crowded"
is a spacing problem (solved by the existing divider + compact `py-1 px-2.5 text-[11px]`
button sizing already used for every other toolbar control, which this reuses verbatim) and
must not be solved by collapsing two conceptually distinct actions into one, which would
re-introduce exactly the confusion US-8 exists to prevent.

**Collaborator's view.** A collaborator (viewer or editor) sees the same slot occupied by a
non-actionable-looking **chip**, not a button styled like the owner's: "Shared by {owner} ·
{level}" in a rounded-pill, muted style (matches `ActivityTable`'s release-filter pill
convention: `rounded-full border text-[11px]`). Clicking it opens the same `CollaboratorsDialog`
component in its read-only **member mode** (see below) — a collaborator can always see who
owns the estimate and their own level, and leave, but never sees anyone else's grant (the API
itself 403s `GET …/collaborators` for a non-owner, so the UI never has that data to show —
AC's deliberate "collaborators don't see each other" stance, mirrored not overridden).

**Flagged, not literally AC-required:** the numeric "(3)" collaborator-count badge and the
"Shared by X · Level" chip's *visibility inside the editor itself* (as opposed to only on the
estimates list) are not spelled out by any single AC — they realize plan.md's own explicit
delegation ("a new, separate 'Collaborators' entry alongside it (owner) / 'Shared with you'
chip (collaborator)... the exact composition, labels and iconography are design.md's call").
Nothing here goes beyond that delegation; flagged so the caller can prune the count badge if
it's judged unnecessary polish.

## Screens & states

### S1 — Toolbar (both modes)
Purpose: entry point for both sharing mechanisms + existing exports. States: owner / editor
collaborator / viewer collaborator (chip content and CollaboratorsDialog mode differ; export
buttons and Share link identical across all three — AC-3.1).

### S2 — CollaboratorsDialog, owner mode
Purpose: add/list/change-level/remove collaborators (US-1, US-3.3, US-5).
- **Loading** — dialog opens, list not yet fetched: header + add form render immediately
  (they need no data beyond `estimateId`), the list area shows `SkeletonListRows` (existing
  component, reused verbatim).
- **Loaded, empty** — add form + "No collaborators yet. Add a colleague by email above."
  (muted, italic, matches `SummaryTable`'s "No activities assigned" empty-row tone).
- **Loaded, populated** — add form above; below, one row per collaborator: email (as typed,
  the stored snapshot — plan's deliberate choice), `AccessLevelBadge`, level `<select>`,
  Remove "×". The owner's own identity renders as a **non-list** header line above the form:
  "You (owner)" — never inside the collaborator rows (AC-5.4: structurally can't be, and the
  UI doesn't even pretend to check).
- **Add: submitting** — email input + level select disabled, button reads "Adding…", spinner
  matches `ConfirmDeleteModal`'s existing spin treatment.
- **Add: error — generic (422 `collaborator_not_eligible`)** — inline under the email field,
  form re-enabled. Copy is deliberately uninformative about *why* (AC-1.2): "That address
  can't be added as a collaborator. Collaborators must be Operai users who already have
  EstimAI access." (verbatim server `detail`, not paraphrased — paraphrasing risks
  accidentally leaking a distinguishing nuance between the two collapsed causes).
- **Add: error — already a collaborator (409)** — distinct copy naming the existing level and
  a same-page action that scrolls to and focuses that row's level `<select>`: "Already a
  collaborator ({level}). → Update their access below instead." (AC-1.3 — the one case that
  *is* allowed to be specific).
- **Add: error — self (422 `cannot_share_with_self`)** — "You can't add yourself as a
  collaborator on your own estimate." A client-side check against the signed-in user's own
  email short-circuits the common case before any request fires; the server's post-lookup
  check (an alias address) still needs the same message on the rare round trip.
- **Add: error — rate-limited (429)** — "Too many attempts. Try again in a few minutes." Add
  button stays disabled for a short client-side cool-down (no live countdown — the exact
  `Retry-After` isn't worth surfacing precisely for a 20-per-10-min ceiling nobody hits by
  accident).
- **Add: error — auth unavailable (503, fail-closed)** — a **visibly different** message from
  the generic 422, on purpose: this is an infra problem, not a statement about the target
  address, and conflating the two would make an owner think a valid colleague is ineligible.
  "Can't check eligibility right now. Try again shortly." No Retry button needed inline — the
  Add button itself is already the retry.
- **Remove: confirm** — generalized `ConfirmDeleteModal` ("Remove collaborator?" / "{email}
  will lose access to this estimate immediately." / Remove).
- **Remove: in-flight / error** — same modal, `isDeleting`/`errorMessage` states (verbatim
  existing contract).
- **Level change: in-flight** — the row's `<select>` disables during the PATCH; optimistic UI
  is *not* used (a silent level change that later fails would be confusing for an
  access-control control specifically) — the select shows the previous value until the PATCH
  resolves, then updates.
- **Level change: error** — small inline text under that row only: "Could not update this
  collaborator's access. Try again." — scoped to the row, not a whole-dialog banner, since
  every other row is unaffected.
- **Load error** (the initial `GET …/collaborators` itself fails, e.g. network) — replaces the
  list area with the existing `ErrorBanner`-style pattern (message + Retry), ported the same
  way `admin-ui`'s `ErrorBanner` ports `EstimatesPage`'s inline list-error strip — the add form
  above it stays usable independent of the list's failure.

### S3 — CollaboratorsDialog, collaborator/member mode
Purpose: show a collaborator who owns them and their own level; offer Leave (US-6).
No add form, no other collaborators' rows (the API never returns them to a non-owner — the UI
has nothing to hide, there's simply nothing to fetch). Content: "Shared with you by {owner}"
(via `formatIdentity`), "Your access: {Viewer|Editor}" (`AccessLevelBadge`), one **Leave this
estimate** action.
- **Default** — as above.
- **Leave: confirm** — generalized `ConfirmDeleteModal` ("Leave this estimate?" / "You will
  lose access immediately and it will disappear from your estimates list." / Leave).
- **Leave: in-flight / error** — same modal states.
- **Owner orphaned (AC-10.5)** — "Shared with you by Former wellD member" — Leave still works
  (leaving is never owner-gated).

### S4 — ConflictBanner
Purpose: US-4's non-dismissable recovery surface, replaces the toast zone.
- **409 (version conflict), attributable** — "{Name} saved changes to this estimate since you
  opened it." + reassurance line "Your edits below are safe and still visible — nothing has
  been overwritten." + primary **Reload latest** + secondary **Save as a copy instead**.
- **409, unattributable** (`lastModifiedBy` identity resolution failed — best-effort per plan)
  — same shape, generic "Someone else saved changes to this estimate since you opened it."
- **428 (stale client, no version yet)** — different framing since there's no "who": "This tab
  needs to reload — reload to keep saving your changes here." Same two actions.
- **Header save-indicator, suppressed** — while conflicted, `Header`'s save-status span
  (normally cycling `Saving…`/`✓ Saved`/`Save failed`) shows a fourth state: "Not saving —
  reload to continue" (`text-org`, matches the existing error-tone color), so the user isn't
  left wondering why edits stop producing the familiar "✓ Saved" feedback.
- Entering conflict clears any prior `saveError`/`showSavedToast` — the banner has the zone
  exclusively; it never stacks with the ordinary save toast.
- Resolving (either action) removes the banner and restores normal Header/toast behavior.

### S5 — Viewer mode (single `canEdit` gate)
Purpose: R5's "one rule, not twelve." `EstimatorContext` computes exactly one boolean —
`canEdit = access !== 'viewer'` — and every mutating control in the tree reads *that* prop,
never re-derives its own notion of "am I allowed." Table of every affected control:

| Component | Prop gained | Owner/editor (`canEdit`) | Viewer (`!canEdit`) |
|---|---|---|---|
| `ActivityTable` | `readOnly` | unchanged | text/number cells become `readOnly` (not `disabled` — stays focusable/AT-readable, browser blocks typing); `<select>` cells (Profile, Release) render as plain text spans in the same grid column (no native `readOnly` on `<select>`); drag handle renders empty, non-interactive; per-row delete "×" cell renders empty (column kept for grid-template stability, not removed); "+ Add Activity" (both the header button and the footer row button) absent; the "＋ New release…" option is omitted from the Release column's option list entirely (it's a mutation route into `addRel`) |
| `ParametersPanel` | `readOnly` | unchanged | every number input becomes `readOnly` |
| `Header` | `readOnly` | unchanged | name input becomes `readOnly`; the save-status span is omitted entirely (nothing ever autosaves, so there's nothing to report — not shown blank) |
| `SummaryTable` | `readOnly` | unchanged | release name/FTE inputs become `readOnly`; the "+ Release" pill and each release's "×" delete button are absent |
| Toolbar (`EstimatorApp`) | derives from context | Share link/Client/PDF/Excel unaffected either way (AC-3.1) | identical — exports are never gated |
| `TemplatePicker` | replaced, not gated | shown when `acts.length === 0` | never shown — see below |

**Empty-activities viewer state.** When a viewer opens an estimate with zero activities, they
must not see `TemplatePicker` (its entire contract — "pick a template or start blank" — is a
content-creation flow a viewer cannot use). Replaced by a small new inline state (not a
modal): centered text, same `TemplatePicker`-adjacent spacing, "No activities in this estimate
yet." — no call to action, because there is none available to a viewer.

**Why not a second, simplified read-only table (like `SharedEstimatePage`'s
`ReadOnlyActivityTable`).** `SharedEstimatePage` already has its own deliberately-simplified
read-only table for the *anonymous link-share* case, and it stays that way (AC-8.1/8.2:
untouched). Collaborator viewer mode is different: AC-3.1 requires a viewer to see *identical
computed values* to the owner, in the *same* rich view (epic grouping, collapse, drag-handle
row, warning badges, keyboard grid navigation for reading) — building a second simplified
table would both duplicate ~500 lines of table logic and risk the two silently diverging.
`readOnly` as a prop on the existing `ActivityTable` is the one-flag rule applied at the
component level, not just the context level.

### S6 — Estimates list (US-2)
- **Loading** — unchanged (`SkeletonListRows`).
- **Error** — unchanged (existing inline retry banner).
- **Empty** — unchanged copy and CTA, but the *condition* changes: shown only when owned +
  shared combined `.length === 0` (AC-2.3).
- **Populated, mixed** — owned rows unchanged (no badge, Delete "×" present). Shared rows gain:
  `AccessLevelBadge` ("Editor"/"Viewer" — its mere presence *is* the "shared" indicator,
  AC-2.2, so no separate "Shared" word-badge is needed alongside it — one chip carries both
  facts) and the owner's identity via `formatIdentity` in the existing `author · date` meta
  line's position (e.g. "Marco Rossi · 12 Aug 2026" in place of the free-text `author` field,
  which stays for owned rows exactly as today). Delete "×" is **absent** for any row where
  `access !== 'owner'` (AC-3.3) — never rendered-then-disabled, since a disabled control still
  invites a click-and-wonder-why interaction the spec doesn't want to teach.
- **Orphaned-estimate row (AC-10.4/10.5)** — a collaborator's shared row where the owner is
  soft-deleted: `formatIdentity` renders "Former wellD member" in the identity slot (never
  blank, never a raw id, never implying an active account); Delete "×" was already absent for
  this row (it's not owned by the viewer regardless of orphan status) — orphaning changes
  nothing about *this* row's controls, only the identity text.

### S7 — Link-share view (US-8, regression surface only)
`SharedEstimatePage` unchanged: no collaborator list, no access-level indicator beyond the
existing plain-text `author` field (AC-8.2). Explicitly verified as a **non-change** by this
design, not a new screen — listed here only so the inventory is complete per the "every state
above must appear" instruction.

## Component inventory

Library in use: **no component library** — hand-rolled components + Tailwind 4 against
`index.css`'s `--ink/--acc/--org/--red/--grn/--soft/--muted` tokens (see Grounding). "Reuse"
below means reusing these existing files/patterns.

| Element | Verdict | Existing component / pattern | Why |
|---|---|---|---|
| "Share link" toolbar button | **REUSE** | `EstimatorApp.tsx`'s existing Share button | Label text change only (AC-8.1: behavior untouched) |
| "Collaborators" trigger / "Shared by X" chip | **NEW** (small, inline in `EstimatorApp.tsx`, no dedicated file) | closest analog: the release-filter pill in `ActivityTable.tsx` (`rounded-full border text-[11px]`) for the chip's shape | No existing toolbar element expresses "owner action with a count badge" vs. "read-only member chip" as one slot with two renderings |
| `CollaboratorsDialog.tsx` (owner add/list/manage) | **NEW** | dialog shell/a11y **pattern** reused from `admin-ui/InviteUserModal.tsx` (live-queried Tab trap, default-focus-on-email, `role="dialog"`) and `ConfirmDeleteModal.tsx` (backdrop, header/body/footer layout) — reimplemented locally, not imported (ADR-0006 federation boundary) | No existing component combines an email+level add form with a live per-row list+actions; `InviteUserModal` is add-only (no list) |
| `CollaboratorsDialog.tsx`, member mode | **NEW** (same file, second render branch) | n/a | Distinct enough content (no form, no list, one Leave action) to be a real second mode, not a prop tweak on an unrelated component |
| Collaborator row (email, level select, remove) | **NEW** (sub-part of `CollaboratorsDialog.tsx`, not its own file) | — | Small enough not to warrant its own component file per suite convention (`SummaryTable.tsx`'s inline `Th`/`Td` helpers are the same-file precedent) |
| `AccessLevelBadge.tsx` (Viewer/Editor chip) | **NEW**, small | pattern ported from `refund-ui/EntityBadge.tsx` (glyph + text + color, never color-only) | No existing chip expresses an access level; reused across S2/S3/S6 rather than reinventing per screen |
| Remove-collaborator / Leave-estimate confirm | **EXTEND** | `ConfirmDeleteModal.tsx` | Generalize hardcoded "Delete estimate?" title/body into `title`/`bodyText`/`confirmLabel` props (default = today's exact copy, so `EstimatesPage`'s existing call site is untouched); same Cancel/Confirm + focus-trap + Escape shape fits Remove and Leave verbatim |
| `ConflictBanner.tsx` | **NEW** | visually echoes `ToastBanner.tsx`'s strip (`px-5.5 py-2 border-l-2`, `role="alert"`) but is a **new component**, not an extension of it | `ToastBanner`'s contract (message + optional single dismiss) can't express two action buttons or "never auto-dismiss, never user-dismiss" without breaking its two existing call sites (save error/success toasts) |
| `ActivityTable.tsx` viewer mode | **EXTEND** | itself | New `readOnly` prop; see S5 table. Chosen over a second read-only table (see S5 rationale) |
| `ParametersPanel.tsx` viewer mode | **EXTEND** | itself | New `readOnly` prop |
| `Header.tsx` viewer mode | **EXTEND** | itself | New `readOnly` prop |
| `SummaryTable.tsx` viewer mode | **EXTEND** | itself | New `readOnly` prop |
| Viewer empty-activities state | **NEW**, small, inline in `EstimatorApp.tsx` | adjacent to `TemplatePicker.tsx`'s layout/spacing | `TemplatePicker`'s whole contract is content creation — wrong verb for a viewer; a text-only state needs no component file |
| `EstimatesPage.tsx` row, shared indicator + owner identity | **EXTEND** | itself | Conditional `AccessLevelBadge` + `formatIdentity` call + conditional Delete button, same row markup otherwise |
| `formatIdentity(identity)` helper | **NEW**, small utility (`src/lib/identity.ts`) | pattern ported from `refund-ui/strings.ts`'s `ownerDisplay()` helper | One function, reused by S2/S3/S4/S6 so "active name / deleted placeholder / unknown placeholder" is decided in exactly one place — the same "single rule" discipline R5 asks for `canEdit`, applied to identity rendering |
| Bell / `/notify` rendering of grant/removal notifications | **REUSE**, unchanged | `shell/src/components/Bell.tsx`, `notify-ui/src/components/NotificationItem.tsx` | Generic title/body/severity/link renderer already handles any `originApp`; no estimai-specific rendering needed (ADR-0009) |

**Reuse/EXTEND/NEW summary:** 1 pure REUSE (Share link relabel) + 1 unchanged-external-reuse
(Bell/NotificationItem) + 6 EXTEND (ActivityTable, ParametersPanel, Header, SummaryTable,
ConfirmDeleteModal, EstimatesPage row) + 6 NEW (CollaboratorsDialog incl. its member mode,
AccessLevelBadge, ConflictBanner, the toolbar trigger/chip, the viewer empty state, the
`formatIdentity` helper) — of the 6 NEW, 3 are small/inline additions with no dedicated
component file (toolbar chip, empty state, helper function), so only 3 are genuinely new
standalone UI components (`CollaboratorsDialog`, `AccessLevelBadge`, `ConflictBanner`), each
justified above against what already exists in-repo.

## Accessibility

**CollaboratorsDialog (S2/S3).** `role="dialog" aria-modal="true" aria-labelledby`. Focus trap
queried live over every currently-enabled focusable element (InviteUserModal's technique, not
ConfirmDeleteModal's fixed-two-button one — the set of focusables changes as rows are
added/removed). Default focus: the email input in owner mode (the natural first action);
the dialog heading (via `tabIndex={-1}` + programmatic focus, `PermissionDenied.tsx`'s
technique) in member mode, since there's no input to land on. Escape closes the dialog, unless
a nested confirm (Remove/Leave) is open, in which case Escape closes only that layer first —
matches `ConfirmDeleteModal`'s existing Escape semantics. Every row's Remove button carries
`aria-label="Remove {email}"` (not a bare "×") so screen-reader users don't have to infer whose
row they're on from surrounding DOM order. A visually-hidden `aria-live="polite"` region inside
the dialog (separate from any inline error text, which is `role="alert"`) announces
async-outcome text: "{email} added as {level}", "{email} removed", "{email}'s access changed to
{level}" — mirrors `Bell.tsx`'s existing pattern of keeping an always-mounted live region
adjacent to, not inside, the interactive element it describes, so repeated actions reliably
re-announce across browsers. Inline field errors (generic 422, 409, self, rate-limit,
503) are `role="alert"` (assertive — the user is mid-action and needs to know now), matching
`ToastBanner`'s error convention. Contrast: reuses `--org` (rate-limit/503/generic-field-error
text) and `--red` (Remove/Leave's destructive confirm button) at the same ratios
`ConfirmDeleteModal.tsx`'s existing doc comment already verifies (≥5.5:1 AA on `--ink-soft`).

**ConflictBanner (S4).** `role="alert"` (assertive — an unsaved-work risk is exactly the kind
of thing that must interrupt, unlike the existing success toast's `role="status"`). **Never**
rendered with a dismiss "×" — this is the component's core behavioral difference from
`ToastBanner` and must not be "fixed" by adding one later. "Reload latest" is the visually
primary button (solid/accented); "Save as a copy instead" is secondary (ghost/outlined) so
keyboard/AT users encounter the safer, non-destructive-feeling default first in DOM/tab order.
Both buttons are real `<button>`s reachable by Tab from wherever focus currently sits in the
editor — the banner does not steal focus on appear (unlike a modal), since the user may be
mid-keystroke in a cell and forcibly moving focus would itself risk losing an in-progress edit.

**Viewer mode (S5).** The rule stated once, tested once: mount the editor as a viewer and
assert **zero** enabled mutating control anywhere in the tree (R5's own named early check).
`readOnly` (not `disabled`) is used everywhere an HTML input/textarea supports it specifically
*for* accessibility: a `disabled` control is pulled out of both the Tab order and (in most
AT/browser combinations) has a degraded accessible-value read; `readOnly` keeps the element
focusable and its value normally exposed while blocking edits at the DOM level as a
belt-and-braces UI mirror of the server's real 403 enforcement. `<select>` elements (Profile,
Release columns) have no native `readOnly`, so they render as plain text in read-only mode
rather than a `disabled` (tab-order-breaking) `<select>` — same information, same column
position, genuinely reachable/readable by AT as ordinary text content.

**Estimates list (S6).** `AccessLevelBadge` follows `EntityBadge`'s established rule: glyph +
text together, never color alone (a colorblind or screen-reader user must get the same
information a sighted color-only signal would give). Suggested glyphs: ✎ (pencil) for Editor,
👁 (eye) for Viewer — both `aria-hidden`, with the visible text label ("Editor"/"Viewer")
carrying the actual accessible name, matching `EntityBadge`'s flag-emoji-plus-label shape.

**Orphaned-identity rendering.** `formatIdentity`'s "Former wellD member"/"Unknown wellD
member" placeholders are real, readable text — never an empty string, a raw cuid, or a
`title`-only tooltip a screen-reader user could miss; this is the same "never blank, never
raw, never misleadingly-active" bar AC-10.5 sets, applied consistently at the one function
that owns it.

## i18n — all new copy, IT + EN

Per CLAUDE.md's "no hardcoded UI strings" rule and this feature's own plan.md precedent
(`src/strings.ts`, new file, EN-typed-for-a-future-locale exactly as `refund-ui/src/strings.ts`
shipped it — see plan's Frontend section "Scope note"). Suite-wide runtime IT switching does
not exist yet anywhere (plan.md already flags this as an existing, unresolved gap, not
something this feature silently absorbs) — the IT column below is the translation pair the
design calls for; wiring an actual locale switch is out of this feature's scope, unchanged
from the plan's own stated posture.

**estimai-ui `src/strings.ts` (new keys, under a new `sharing` + `conflict` + `estimatesList`
namespace):**

| Key | EN | IT |
|---|---|---|
| `sharing.toolbar.shareLink` | Share link | Condividi link |
| `sharing.toolbar.shareLinkCopied` | Copied! | Copiato! |
| `sharing.toolbar.collaborators` | Collaborators | Collaboratori |
| `sharing.toolbar.collaboratorsWithCount(n)` | Collaborators ({n}) | Collaboratori ({n}) |
| `sharing.toolbar.sharedByChip(owner, level)` | Shared by {owner} · {level} | Condiviso da {owner} · {level} |
| `sharing.dialog.title` | Collaborators | Collaboratori |
| `sharing.dialog.ownerRowLabel` | You (owner) | Tu (proprietario) |
| `sharing.dialog.emailLabel` | Email | Email |
| `sharing.dialog.emailPlaceholder` | colleague@welld.ch | collega@welld.ch |
| `sharing.dialog.levelLabel` | Access level | Livello di accesso |
| `sharing.dialog.levelViewer` | Viewer | Lettore |
| `sharing.dialog.levelViewerHint` | Can view and export, not edit | Può visualizzare ed esportare, non modificare |
| `sharing.dialog.levelEditor` | Editor | Editor |
| `sharing.dialog.levelEditorHint` | Can edit like you — except manage collaborators or delete | Può modificare come te — tranne gestire i collaboratori o eliminare |
| `sharing.dialog.addButton` | Add collaborator | Aggiungi collaboratore |
| `sharing.dialog.addingButton` | Adding… | Aggiunta in corso… |
| `sharing.dialog.emptyState` | No collaborators yet. Add a colleague by email above. | Nessun collaboratore. Aggiungi un collega tramite email qui sopra. |
| `sharing.dialog.removeAction(email)` | Remove {email} | Rimuovi {email} |
| `sharing.dialog.removeConfirmTitle` | Remove collaborator? | Rimuovere il collaboratore? |
| `sharing.dialog.removeConfirmBody(email)` | {email} will lose access to this estimate immediately. | {email} perderà immediatamente l'accesso a questa stima. |
| `sharing.dialog.removeConfirmButton` | Remove | Rimuovi |
| `sharing.dialog.addedAnnouncement(email, level)` | {email} added as {level} | {email} aggiunto come {level} |
| `sharing.dialog.removedAnnouncement(email)` | {email} removed | {email} rimosso |
| `sharing.dialog.levelChangedAnnouncement(email, level)` | {email}'s access changed to {level} | Accesso di {email} cambiato in {level} |
| `sharing.dialog.leaveAction` | Leave this estimate | Abbandona questa stima |
| `sharing.dialog.leaveConfirmTitle` | Leave this estimate? | Abbandonare questa stima? |
| `sharing.dialog.leaveConfirmBody` | You will lose access immediately and it will disappear from your estimates list. | Perderai immediatamente l'accesso e la stima sparirà dal tuo elenco. |
| `sharing.dialog.leaveConfirmButton` | Leave | Abbandona |
| `sharing.dialog.sharedWithYouBy(owner)` | Shared with you by {owner} | Condivisa con te da {owner} |
| `sharing.dialog.yourAccessLevel(level)` | Your access: {level} | Il tuo accesso: {level} |
| `sharing.errors.notEligible` | That address can't be added as a collaborator. Collaborators must be Operai users who already have EstimAI access. | Questo indirizzo non può essere aggiunto come collaboratore. I collaboratori devono essere utenti Operai già abilitati a EstimAI. |
| `sharing.errors.alreadyCollaborator(level)` | Already a collaborator ({level}). → Update their access below instead. | Già collaboratore ({level}). → Modifica il suo accesso qui sotto. |
| `sharing.errors.cannotShareWithSelf` | You can't add yourself as a collaborator on your own estimate. | Non puoi aggiungere te stesso come collaboratore sulla tua stessa stima. |
| `sharing.errors.rateLimited` | Too many attempts. Try again in a few minutes. | Troppi tentativi. Riprova tra qualche minuto. |
| `sharing.errors.authUnavailable` | Can't check eligibility right now. Try again shortly. | Impossibile verificare l'idoneità in questo momento. Riprova a breve. |
| `sharing.errors.invalidEmail` | Enter a valid email address. | Inserisci un indirizzo email valido. |
| `sharing.errors.genericAddFailed` | Could not add this collaborator. Try again. | Impossibile aggiungere il collaboratore. Riprova. |
| `sharing.errors.genericRemoveFailed` | Could not remove this collaborator. Try again. | Impossibile rimuovere il collaboratore. Riprova. |
| `sharing.errors.genericLevelChangeFailed` | Could not update this collaborator's access. Try again. | Impossibile aggiornare l'accesso del collaboratore. Riprova. |
| `sharing.errors.loadFailed` | Could not load collaborators. | Impossibile caricare i collaboratori. |
| `sharing.identity.deleted` | Former wellD member | Ex membro wellD |
| `sharing.identity.unknown` | Unknown wellD member | Membro wellD sconosciuto |
| `sharing.emptyActivitiesViewer` | No activities in this estimate yet. | Nessuna attività in questa stima. |
| `conflict.title409(name)` | {name} saved changes to this estimate since you opened it. | {name} ha salvato modifiche a questa stima da quando l'hai aperta. |
| `conflict.title409Unknown` | Someone else saved changes to this estimate since you opened it. | Qualcun altro ha salvato modifiche a questa stima da quando l'hai aperta. |
| `conflict.title428` | This tab needs to reload to keep saving your changes here. | Questa scheda deve essere ricaricata per continuare a salvare qui. |
| `conflict.reassurance` | Your edits below are safe and still visible — nothing has been overwritten. | Le tue modifiche qui sotto sono al sicuro e ancora visibili — nulla è stato sovrascritto. |
| `conflict.reloadButton` | Reload latest | Ricarica l'ultima versione |
| `conflict.saveAsCopyButton` | Save as a copy instead | Salva come copia |
| `conflict.savingSuspended` | Not saving — reload to continue | Salvataggio sospeso — ricarica per continuare |
| `estimatesList.accessEditor` | Editor | Editor |
| `estimatesList.accessViewer` | Viewer | Lettore |

**`estimai-api`-authored notification copy** (server-side, mirrors `refund-api/src/lib/
notify.ts`'s inline-EN precedent — not part of `estimai-ui/src/strings.ts`, since it's
constructed and sent by the backend, never rendered from frontend copy):

| Event | EN title / body | IT title / body |
|---|---|---|
| Granted (AC-7.1) | "New collaborator access" / "{ownerNameOrColleague} gave you {level} access to '{estimateName}'." | "Nuovo accesso da collaboratore" / "{ownerNameOrColleague} ti ha dato accesso {level} a '{estimateName}'." |
| Removed, owner-initiated (AC-7.2) | "Access removed" / "You no longer have access to '{estimateName}'." | "Accesso rimosso" / "Non hai più accesso a '{estimateName}'." |

`{level}` renders as "editor"/"viewer" lower-case mid-sentence (EN) or "editor"/"lettore" (IT).
`{ownerNameOrColleague}` falls back to "A colleague" / "Un collega" if the owner's own identity
resolution is unavailable at send time — notifications never block on that lookup (best-effort,
per ADR-0017/R6).

## Gaps and questions found in spec/plan

- **No literal AC requires an in-editor "shared by" indicator** (only the toolbar composition
  and viewer-mode gating are literally required); the chip described here directly realizes
  plan.md's own explicit delegation of "the exact composition, labels and iconography" to this
  document, so it is filled-in, not invented scope. Flagging per the design brief's instruction
  regardless, so the caller can prune the collaborator-count badge specifically if it's judged
  unnecessary.
- **ACs with no UI surface** (verified as intentionally backend-only, not missed): AC-1.6
  (stranger 404 — existing "not found" redirect, unchanged), AC-4.3 (concurrent-save race —
  the *loser* of the race just sees the ordinary conflict banner; nothing distinguishes "raced"
  from "was simply stale"), AC-5.3 (no live disconnect — an absence, nothing to render), AC-9.1
  (cascade delete — invisible to the deleting owner; the *effect* on former collaborators is
  covered under S6/US-9 above, not a new screen), AC-10.1 (owner soft-delete itself — no
  estimai-ui surface at all, purely a backend/`auth` event), the "no notification" half of
  AC-7.3 (an absence).
- **Plan ambiguity, resolved here, worth confirming with architect/backend-dev**: the plan's
  `EstimateListItem`/`EstimateFull` shapes give `owner: null | {status, name}` — `null` when
  `access === 'owner'` (i.e., the field is absent/null for your own rows). `formatIdentity`
  as designed handles `null` as "don't render an owner line at all" (owned rows keep their
  existing `author` free-text field in that slot, unchanged) — confirm this reading matches
  intended backend behavior before implementation, since a `null` that instead meant "unknown"
  would collide with the `status: "unknown"` case this design treats differently (no owner
  line vs. an explicit "Unknown wellD member" placeholder are visually different outcomes).
- **`ConfirmDeleteModal` generalization is a cross-cutting change** — extending it for Remove/
  Leave touches the one component `EstimatesPage`'s existing delete flow also depends on;
  flagging so tasks.md sequences the prop-generalization as its own reviewable unit before the
  two new call sites land, rather than bundling it invisibly into the collaborator-dialog task.
