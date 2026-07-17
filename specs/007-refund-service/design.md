---
spec: 007
status: draft
---

# Design: Refund service (Rimborsi) — expense requests, expense lines & accounting review

Component library in use: **Tailwind CSS 4** utility classes driven by the shared
`shell/tokens.css` `@theme` block (DM Sans / DM Mono / Syne, dark-ink palette + light
override) — confirmed by reading `refund-ui/src/App.tsx` (the existing placeholder already
imports `shell/tokens.css` as a side-effect and styles via `var(--text)`/`var(--soft)`/
`var(--disp)`, exactly like `estimai-ui`/`admin-ui`), `refund-ui/package.json` (no Mantine/
MUI/Chakra/shadcn dependency anywhere), and `specs/004-auth-roles-permissions/design.md` +
`specs/006-user-invitations/design.md`, both of which this document treats as binding
precedent: hand-built markup + Tailwind utilities + a handful of shared, hand-rolled
components (`ErrorBanner`, `SkeletonListRows`, `ConfirmDeleteModal`, `GuardrailDialog`,
`PermissionDenied`, `Pagination`, glyph+text+color badges). Confirmed token names from
`shell/src/styles/tokens.css`: `--acc`/`--acc-hi`/`--acc-lo` (purple AI accent), `--grn`
(success/approved), `--org` (amber/needs-attention), `--red` (destructive/rejected),
`--soft`/`--muted` (secondary text), `--rule` (borders), `--ink`/`--ink-soft`/`--ink-mid`
(surface layers), `--disp`/`--mono`/`--body` (Syne/DM Mono/DM Sans).

`refund-ui` cannot import source files from `admin-ui` or `estimai-ui` across the Module
Federation boundary (ADR-0006) — only `shell/session` (`useSession`, `apiFetch`) and
`shell/tokens.css` are genuinely shared federated modules. Every other "reuse" below is a
**ported pattern**: a new file in `refund-ui/src/components/` that closely copies an
existing component's markup/props/a11y contract, exactly as `admin-ui` already did for
`estimai-ui`'s `ConfirmDeleteModal`/`SkeletonListRows`, and as `specs/006` did again within
`admin-ui` itself. Three reuse categories, matching `specs/004`/`specs/006`'s own vocabulary:
- **Reuse (shared)** — the same federated module instance (`shell/session`, `shell/tokens.css`).
- **Reuse (ported pattern)** — a new file in `refund-ui`, unavoidable across the boundary,
  that copies an existing component's contract near-verbatim.
- **Reuse (ported, extended)** — a ported pattern that also gains a new prop/variant this
  feature needs (e.g. `ConfirmDeleteModal`'s ported copy gaining a non-destructive `tone`).

---

## Flows

Each flow lists entry → steps → success/error exits, with US/AC references. Employee flows
(F1–F4) and accounting flows (F5–F6) are described separately; F7 is the cross-reference to
the notification push, which has no new UI of its own.

### F1 — Employee composes a refund request (US-1: AC-1.1–1.7)

Entry: **Screen R1 (My requests)** → "+ New request".
1. `/refund/requests/new` immediately calls `POST /requests` (no body) and redirects to
   `/refund/requests/$id` on success (AC-1.1: created `draft`, visible only to its owner, not
   yet queued) — mirrors `estimai-ui/src/pages/EstimatesPage.tsx`'s `handleNew` (create →
   navigate to the detail route) except as its own route rather than a button handler, since
   plan.md lists `/refund/requests/new` as a distinct route. A brief centered spinner covers
   the round trip; on failure, an inline message with "Try again" / "Back to my requests" (no
   retry-token machinery needed — a single POST, not a re-fetchable list).
2. **Screen R2 (draft, editable)** renders: a header (status badge = Draft), the
   **`ExpenseLineComposer`** ("+ Add expense line"), zero or more **`ExpenseLineRow`**s, the
   **`SubtotalsPanel`**, and Submit / Delete-request actions.
3. Adding a line (AC-1.2): the composer collects Date (defaults to today, editable), Expense
   type (`<select>`, no default — starts on a "Select a type…" placeholder so the employee
   always makes an explicit, deliberate choice for a field this consequential), Motivo,
   Requested amount, Entity (`<select>`, also no default, same reasoning — a request may mix
   entities, so guessing one would be actively wrong some of the time), and, **only once
   Expense type = `travel-km`**, a `km` field (required, must be `> 0`) — for every other
   type the `km` input is not rendered at all, not merely disabled (AC-1.2's "inapplicable —
   not shown/not required"). "Add line" stays disabled until every field required for the
   current type is valid (mirrors `admin-ui/src/components/InviteUserModal.tsx`'s
   submit-disabled-until-valid convention) — only then does it fire `POST
   /requests/:id/lines`, since the endpoint requires the full line object in one call (no
   endpoint accepts a partial/empty line). On success the new line appears as a persisted
   `ExpenseLineRow`; the composer resets and stays open for rapid successive adds (mirrors
   `ActivityTable.tsx`'s "+ Add Activity" always staying reachable, but validated-first here
   because the API, unlike EstimAI's local state, requires complete data up front).
4. Editing an existing line: each `ExpenseLineRow` buffers its own fields in local draft state
   exactly like `ActivityTable.tsx`'s `EpicCell`/`MLCell` (value diverges from the committed
   line until blur/Enter, so mid-edit re-renders never fight the input) — but commits as ONE
   `PUT /requests/:id/lines/:lineId` carrying the whole line object when focus leaves the row
   (not per-keystroke, not per-field), since the endpoint's contract is "same [shape] as
   POST." Changing Expense type away from `travel-km` drops `km` from the next PUT payload
   (the API rejects `km` present for any other type).
5. Attaching receipts (AC-1.3): once a line exists, its row exposes an **`AttachmentList`** +
   "+ Attach files" (hidden multi-file `<input type="file">`, same trigger-button convention
   as `estimai-ui/src/pages/EstimatesPage.tsx`'s `fileInputRef`/"↑ Import JSON"). Each selected
   file is rejected client-side first if it fails the known constraints (≤10 MiB,
   `application/pdf`/`image/jpeg`/`image/png` — plan.md "Limits") with an inline per-file
   error, never silently dropped; otherwise it enters a per-file three-phase upload (mint →
   direct PUT to the presigned EU bucket URL → confirm), rendered with a live state
   (queued/uploading/stored/failed) exactly as `ImportOfferModal.tsx`'s phase machine
   generalized to per-item instead of per-modal. A stored attachment gets a "×" Remove
   (`DELETE …/attachments/:aid`, draft-only, no confirm — low-stakes, easily re-attached).
6. Deleting a line: an inline "×" per row, no confirm modal (mirrors
   `ActivityTable.tsx`/`EstimatesPage.tsx`'s own row-delete "×" — a draft line is cheap,
   reversible working state, same judgment call those two components already make).
7. Deleting the whole draft request: "Delete request" → **`ConfirmDeleteModal`** (ported, own
   copy) — "Delete this draft request and its N expense line(s)? This cannot be undone." →
   `DELETE /requests/:id` → navigate to Screen R1.

### F2 — Employee submits, withdraws, and re-edits before a decision (US-2: AC-2.1–2.5)

Entry: Screen R2 (draft).
1. "Submit for review" — if the draft has zero lines (AC-1.5), the button is disabled and an
   inline note explains why ("Add at least one expense line before submitting.") rather than
   allowing a doomed API call. With ≥1 line, click → `POST /requests/:id/submit`.
   - **200** → status flips to `submitted`; every editing control (composer, row fields,
     attach/remove, line delete, request delete) disappears — the screen re-renders in its
     **read-only "pending" variant** (AC-2.1); an `aria-live="polite"` confirmation
     ("Submitted — now awaiting accounting's decision") fires and focus moves to the status
     heading (same focus-on-transition technique `PermissionDenied.tsx`/
     `ImportOfferModal.tsx` already use in this suite).
   - **422** (AC-1.6, incomplete lines) → a **`SubmitValidationSummary`** banner lists exactly
     the offending line ids the response body names, each entry a jump link that scrolls to
     and focuses the corresponding `ExpenseLineRow` — the draft stays fully editable, nothing
     is lost.
2. "Withdraw" (visible only while `submitted` and not yet decided, AC-2.2) — no confirm modal:
   withdraw is corrective, not destructive (nothing is lost, the request simply becomes
   editable again), mirroring `specs/006`'s explicit "resend isn't destructive → no dialog"
   reasoning for an analogous low-stakes reversible action. → `POST /requests/:id/withdraw` →
   **200** flips the screen back to the editable draft variant, `aria-live` announces
   "Withdrawn — back to draft," focus moves to the heading.
   - **409** (already decided — a race between the employee and accounting) → **`GuardrailDialog`**
     (ported, unchanged shape): "This request has already been decided and can no longer be
     withdrawn." → acknowledging reloads the request so the screen shows the real, current
     (decided, read-only) state.
3. A decided (`approved`/`rejected`) request renders NO edit/submit/withdraw/delete controls
   at all (AC-2.3) — not disabled-and-explained, but genuinely absent, because none of those
   actions is ever possible again for this record; this mirrors `AuditPage`'s
   "immutability enforced by omission" convention (specs/006), not `RolesPage`'s
   disabled-for-self convention (which is for an action that's sometimes possible elsewhere).
   Any stale-UI attempt that somehow still reaches the API (double-tab, back-button) surfaces
   the server's `409` via the same `GuardrailDialog` as step 2.
4. A `rejected` request's detail (AC-2.4) offers a plain "+ New request" link (same route as
   F1's entry point) — never an in-place edit or resubmit, and deliberately NOT a
   "duplicate this request's lines" convenience (see Gaps #3: that's spec-permitted but not
   spec-required, and this design does not invent it).
5. Any user other than the owning employee (and not an in-scope `accounting` user) hitting
   `/refund/requests/$id` for someone else's request (AC-2.5) gets the record-level **NF
   ("not found")** state described under Screen R2 below — never a screen that confirms the
   request exists but access is denied.

### F3 — Employee tracks status and outcome (US-3: AC-3.1–3.6)

Entry: Screen R1, or the `link.href` inside the notify-center push (F7).
1. Screen R1 lists every request the employee owns, in any status, with at minimum status +
   last-updated date (AC-3.1) — never another employee's requests (server-enforced via
   `sub`-scoping, ADR-0005; the UI has no cross-employee affordance to even attempt).
2. Opening a request shows the read-only detail variant matching its status:
   - `submitted` — a `RequestStatusBadge` reading "Awaiting decision" (glyph ⏳, `--acc`) so it
     never reads as `approved`/`rejected` (AC-3.4).
   - `approved` — each line shows **both** its requested amount and its final approved total
     (AC-3.2), the `SubtotalsPanel` shows both figures per currency, and the
     **`MonthlyProcessingNote`** renders (AC-4.1/AC-4.2, see F4).
   - `rejected` — the **rejection motivation** renders in a highlighted note block (AC-3.3),
     plus the "+ New request" link from F2 step 4.
3. Mixed-entity requests (AC-3.5) always render the `SubtotalsPanel` as two independent
   per-currency cards (see Component inventory) — there is no code path that sums them into a
   single figure; the panel renders one card per entity **present** in the API's `subtotals[]`
   array, never a synthesized zero-value card for an entity with no lines, so a single-entity
   request visibly has exactly one subtotal, not one-plus-an-empty-placeholder.

### F4 — Employee understands monthly processing (US-4: AC-4.1–4.2)

No dedicated screen — a cross-reference. The **`MonthlyProcessingNote`** (fixed copy, no
date/amount, per AC-4.1's explicit ban on promising a cutoff or a paycheck figure) renders
only inside an `approved` request's detail (F3 step 2); it is structurally absent — not
hidden, not empty — from every `draft`/`submitted` render path (AC-4.2), so there is no state
where the note could accidentally leak onto a pending request.

### F5 — Accounting works the entity-scoped queue (US-5: AC-5.1–5.6)

Entry: **Screen A1 (Review queue)**, `/refund/review`.
1. Lists every `submitted` request with ≥1 line in the caller's entity scope (AC-5.1/5.5/5.6
   — entity-scope evaluation is entirely server-side, per plan.md's "at least one line
   matches" predicate; the UI renders exactly what `GET /review/requests` returns). Each row:
   requesting employee, submission date, and a compact per-currency subtotal preview (to
   "prioritize," AC-5.1) — reusing the same subtotal-formatting logic as `SubtotalsPanel`, just
   condensed to one line instead of full cards.
2. `draft`/`approved`/`rejected` requests never appear (AC-5.2) — including a request that was
   `submitted` then withdrawn (AC-5.3): the queue is a live server query, so the next load
   simply reflects its absence; no client-side "was this withdrawn?" logic exists or is needed.
3. A user without `request:review` at all (AC-5.4) never reaches a populated queue — `GET
   /review/requests` 403s and the screen renders **`PermissionDenied`** (ported, unchanged) in
   place of the table, no Retry (a 403 here is not transient).
4. Clicking a row navigates to Screen A2.

### F6 — Accounting inspects, sets approved totals, and decides (US-6/US-7: AC-6.1–6.6, AC-7.1–7.6)

Entry: Screen A1 row, or a deep link.
1. **Screen A2 (Review detail)** shows every line of the request in full (AC-6.1/6.5) —
   including lines for an entity outside the deciding user's own scope; there is no
   client-side filtering of lines by scope, matching the API's own "whole-request" contract.
   Each line renders read-only date/type/motivo/requested-amount/entity/km (where
   applicable) plus its `AttachmentList`, here in **download-only** mode (AC-6.2): clicking an
   attachment mints a short-lived presigned GET (`GET …/attachments/:aid/url`) and opens it —
   no upload/remove affordances render here at all (this is accounting's read surface, not the
   employee's write surface, even though both reuse the same `ExpenseLineRow`/`AttachmentList`
   shapes in different modes).
2. Each line additionally shows an editable **approved-total input**, visually pre-filled with
   that line's requested amount as its default (AC-7.1) — but the client does **not** eagerly
   `PUT` that unedited default; a write only fires once the accounting user actually changes
   the value and the field blurs (see Gaps #4 — this avoids generating an
   `approved_total_set` audit row, AC-8.1, for lines nobody actually touched, and keeps the
   audit trail meaning "a human changed this," not "every line, touched or not"). The
   accounting user may lower, raise, or zero any line independently.
3. The `SubtotalsPanel` on this screen shows requested totals per currency while the request
   is still `submitted` (approved figures don't exist yet); once decided it shows both, exactly
   as the employee sees it (AC-6.6, mirrors AC-3.5).
4. **Approve** → **`ApproveDialog`** (ConfirmDeleteModal's shell, ported + recolored `--grn`
   instead of `--red` — see Component inventory) — "Approve this request? Approved totals
   become final the moment you confirm, and the employee is notified immediately." → confirm →
   `POST /review/requests/:id/approve` → **200**: per-line totals finalize (defaulting
   server-side to the requested amount for any line left untouched, AC-7.2), the employee is
   pushed a notification (F7); the accounting user is returned to Screen A1 (the queue has one
   fewer row) with an `aria-live` confirmation ("Approved — {employee}'s request") — a
   deliberate navigate-back-to-queue choice for a role that typically works through several
   requests in a row (see Gaps #5).
5. **Reject** → **`RejectDialog`** (NEW — see Component inventory): the same confirm shell,
   but with an embedded, **required** motivation `<textarea>` inside the body; the confirm
   button stays disabled until the textarea is non-empty (client-side, mirrors
   `InviteUserModal`'s disabled-until-valid submit), with the server's `422` (AC-7.3) as
   defense-in-depth if it's ever reached anyway. Confirm → `POST /review/requests/:id/reject
   {motivation}` → **200**: same notify-and-return-to-queue behavior as Approve.
6. **409** on either action (AC-7.4 — someone else decided it first, or a stale double-click) →
   `GuardrailDialog`: "This request was already decided and can no longer be changed." →
   acknowledging returns to Screen A1 (a fresh queue load naturally drops the now-decided row).
7. A deep link to a request outside the caller's entity scope entirely (AC-6.4) — `GET
   /requests/:id` 404s — renders the same record-level **NF** state as F2 step 5, never a
   "permission denied" message (that would confirm the record exists, which the API
   deliberately avoids leaking, AC-6.4/ADR-0005).
8. A decided request opened via Screen A2 (from the queue's history, or a stale link) renders
   the exact same read-only detail an employee would see on their own approved/rejected
   request (AC-6.3) — accounting's "inspect a past decision" need is met by the SAME read-only
   render path F3 already built, not a second one.

### F7 — Decision triggers a notification (US-3: AC-3.6) — cross-reference, no new UI

No dedicated screen. Once refund-api records an `approve`/`reject` decision, it calls
`notify-api`'s internal `POST /system/notifications` (plan.md), which persists + SSE-pushes an
in-app notification the shell's existing bell/`ToastHost`/notify-ui already render (ADR-0009,
`specs/005-notification-center`). The notification's `link.href` points at
`/refund/requests/:id`, landing the employee straight on Screen R2's decided-read-only variant
(F3 step 2). This flow exists purely so AC-3.6 has an explicit trace here; refund-ui adds
nothing to the bell/toast machinery itself — see `specs/005-notification-center/design.md` for
that surface's own accessibility contract.

---

## Screens & states

Legend: **L**oading, **E**mpty, **P**opulated, **Err**or (RFC 7807), **PD** permission-denied
(403, capability entirely absent), **NF** not-found (404, record-level ownership/scope
denial — deliberately worded so as not to confirm the record exists), **RO** read-only variant.

### Screen R1 — My requests (`/refund/requests`, NEW)

- **Purpose:** entry point for every employee flow — browse own requests, start a new one.
- **Key elements:** heading, "+ New request" button (top-right, same placement/style as
  `RolesPage`'s "+ New role" / `EstimatesPage`'s "+ New estimate"), a flat list of request
  rows (status badge, last-updated date, a short subtotal preview) — **no pagination
  control**: `GET /requests` returns a bare array in plan.md's contract (unlike admin-ui's
  Users/Audit lists), so this screen renders every row it gets, not a paginated slice (flagged
  explicitly in Gaps #6 so frontend-dev doesn't reach for `Pagination` from the admin-ui
  precedent where it doesn't apply).
- **L:** `SkeletonListRows` (ported, own copy), with the same `aria-live="polite"` "Loading
  your requests" sr-only announcement `EstimatesPage.tsx` uses.
- **E:** true first-time zero-requests state — onboarding copy + "+ New request" CTA (mirrors
  `EstimatesPage.tsx`'s "Ready to estimate your first project?" empty state, adapted:
  "Ready to submit your first expense request?").
- **P:** the row list described above; each row opens Screen R2.
- **Err:** `ErrorBanner` (ported, own copy) + Retry.
- **PD:** an employee whose `refund:access`/`request:read` grant was revoked (or never made —
  Constraints: refund access is never automatic) sees `PermissionDenied` (ported, unchanged) in
  place of the list — no Retry, mirrors admin-ui's Screen E1 posture exactly (a 403 here isn't
  transient).

### Screen R2 — Draft composer / request detail (`/refund/requests/new` redirect + `/refund/requests/$id`, NEW)

One route, several render variants driven entirely by `status`:
- **`draft` (editable):** `ExpenseLineComposer`, `ExpenseLineRow` list (each with its own
  `AttachmentList` in upload/remove mode), `SubtotalsPanel` (requested-only), Submit /
  Delete-request actions. **E** (zero lines yet): "No expense lines yet — add one to get
  started," distinct copy from the AC-1.5 submit-blocked message (that one only fires on a
  submit *attempt*, this one is passive/informational).
- **`submitted` (RO, "pending"):** every editing control absent (not disabled — see F2 step
  3); `RequestStatusBadge` = "Awaiting decision"; Withdraw is the only action.
- **`approved` (RO):** each line shows requested + approved; `SubtotalsPanel` shows both;
  `MonthlyProcessingNote` renders; "+ New request" is NOT offered here (only on `rejected` —
  an approved request needs no corrective follow-up).
- **`rejected` (RO):** rejection-motivation note block; "+ New request" link (F2 step 4).
- **L:** `SkeletonListRows` (ported) while the request loads.
- **Err:** `ErrorBanner` + Retry, for a genuine network/5xx failure on `GET /requests/:id`.
- **NF:** the request doesn't exist, or the caller is neither its owner nor an in-scope
  `accounting` user (AC-2.5) — a neutral "This request doesn't exist or you don't have access
  to it," with a link back to Screen R1. Deliberately NOT phrased as "permission denied"
  (would confirm existence — AC-6.4's leak-avoidance applies symmetrically to the employee
  side via AC-2.5, same 404 semantics per plan.md's denial table).
- **G (guardrail-blocked):** a 409 race on submit/withdraw/delete surfaces `GuardrailDialog`
  (F2 steps 2–3).

### Screen A1 — Review queue (`/refund/review`, NEW)

- **Purpose:** accounting's entity-scoped worklist.
- **Key elements:** heading, entity-scope hint if useful ("Showing requests for your scope" —
  optional copy, not an AC requirement), a flat list of queue rows (employee, submitted date,
  subtotal preview) — again **no pagination** (plan.md's `GET /review/requests` is also a bare
  array).
- **L:** `SkeletonListRows` (ported).
- **E:** "Nothing awaiting your decision right now." — distinct from the PD state below;
  this is a real, successful, empty result, not a denial.
- **P:** the row list; each row opens Screen A2.
- **Err:** `ErrorBanner` + Retry.
- **PD:** a signed-in user with no `request:review` grant at all (AC-5.4 — the common case,
  since most Operai users are plain employees) sees `PermissionDenied` (ported, unchanged), no
  Retry. This is reachable via direct URL even though the shell's own top-level nav already
  hides the entry point for non-accounting users (plan.md: "the shell nav item is likewise
  gated") — refund-ui's own internal chrome (see Component inventory, `RefundShell`)
  deliberately always renders a "Review queue" link regardless of the caller's role, precisely
  so this defense-in-depth PD state is the thing that actually enforces the boundary, not
  client-side guesswork about who holds `accounting` (see Gaps #7 for the reasoning).

### Screen A2 — Review detail (`/refund/review/$id`, NEW)

- **Purpose:** inspect a full request and record a decision.
- **Key elements (`submitted`, decidable):** full read-only line list + `AttachmentList` in
  download-only mode, per-line approved-total inputs (default-shown, write-on-change only —
  F6 step 2), `SubtotalsPanel` (requested-only until decided), Approve / Reject actions.
- **RO (`approved`/`rejected`, AC-6.3):** identical render to Screen R2's own
  `approved`/`rejected` variant (F6 step 8) — no approved-total inputs, no Approve/Reject.
- **L:** `SkeletonListRows`.
- **Err:** `ErrorBanner` + Retry.
- **NF:** entity-scope mismatch (AC-6.4) or a genuinely nonexistent id — same neutral copy and
  reasoning as Screen R2's NF state.
- **G:** a 409 decision race → `GuardrailDialog` (F6 step 6).

### `RefundShell` (root layout, NEW — mirrors `AdminShell`)

A minimal wrapper: heading ("Rimborsi"/"Refund" — see Accessibility for the bilingual note),
a small two-item nav ("My requests" | "Review queue"), and an `<Outlet/>`. No suite chrome
duplicated (Header/UserMenu/bell/ThemeToggle) — that already wraps refund-ui from the shell
(ADR-0006), same rationale `AdminShell`'s own doc comment gives. No auth guard here either —
the shell's `_authed` guard already runs before refund-ui mounts at all; a per-request/per-app
`refund:access` guard, if ever added at the shell level, is out of this document's scope
(refund-api's own 403/404 responses are the actual enforcement boundary regardless — see
Screen A1's PD note).

---

## Component inventory

| Element | Reuse / NEW | Source pattern (path) |
|---|---|---|
| `shell/session` (`useSession`, `apiFetch`) | **Reuse (shared)** | Federated module, already used by `refund-ui/src/App.tsx` |
| `shell/tokens.css` | **Reuse (shared)** | Federated CSS import, already used by `refund-ui/src/App.tsx` |
| `ErrorBanner` | **Reuse (ported pattern)** | `admin-ui/src/components/ErrorBanner.tsx` |
| `SkeletonListRows` | **Reuse (ported pattern)** | `admin-ui/src/components/SkeletonListRows.tsx` |
| `ConfirmDeleteModal` | **Reuse (ported pattern)** | `admin-ui/src/components/ConfirmDeleteModal.tsx` — used as-is for "Delete request" |
| `GuardrailDialog` | **Reuse (ported pattern)** | `admin-ui/src/components/GuardrailDialog.tsx` — 409-race, genuinely-blocked cases |
| `PermissionDenied` | **Reuse (ported pattern)** | `admin-ui/src/components/PermissionDenied.tsx` |
| `ApproveDialog` | **Reuse (ported, extended)** | `ConfirmDeleteModal`'s shell, ported + a new non-destructive `tone="positive"` variant (`--grn` confirm button instead of hardcoded `--red`) — the same kind of backward-compatible prop extension `specs/006` already applied to this component's `body` prop |
| `RejectDialog` | **NEW** | No in-repo dialog combines a destructive confirm with an embedded required-field form; `ConfirmDeleteModal`'s shell (backdrop/trap/Escape/focus) + `InviteUserModal`'s disabled-until-valid submit, composed |
| `RequestStatusBadge` | **NEW, small** | Glyph+text+color convention ported from `InvitationStatusBadge.tsx`/`SystemBadge.tsx` — 4 variants (draft/submitted/approved/rejected) |
| `EntityBadge` (WellD Italia·EUR / WellD CH·CHF chip) | **NEW, small** | Glyph+text+color convention ported from `ConditionChip.tsx` |
| `ExpenseLineComposer` | **NEW** | Disabled-until-valid pattern ported from `InviteUserModal.tsx`; type-driven conditional field is genuinely new (no existing form in-repo shows/hides a field based on another field's value) |
| `ExpenseLineRow` | **NEW** | Local-draft-commit-on-blur technique ported from `ActivityTable.tsx`'s `EpicCell`/`MLCell`, generalized from one cell to a whole multi-field row with a single full-payload `PUT` |
| `AttachmentList` / per-file upload state | **NEW** | Trigger-button convention ported from `EstimatesPage.tsx`'s hidden-file-input pattern; the phase-state-machine shape ported from `ImportOfferModal.tsx` (offer/importing/results → generalized to per-file queued/uploading/stored/failed); the two-phase presigned-direct-to-bucket upload mechanics themselves have no precedent anywhere in-repo |
| `AttachmentDownloadLink` (accounting's read-only mode) | **NEW, small** | Click → mint presigned GET → open; no existing "mint a signed URL on click" affordance in-repo |
| `SubtotalsPanel` | **NEW, small** | Loosely mirrors `SummaryTable.tsx`'s "By Specialist Profile" per-category card grid shape; content (never-blended per-currency requested/approved) is new |
| `SubmitValidationSummary` | **NEW, small** | No existing multi-item validation-summary-with-jump-links exists in-repo; borrows `ErrorBanner`'s alert-toned shell |
| `MonthlyProcessingNote` | **NEW, tiny** | Fixed-copy informational banner — borrows `ErrorBanner`'s banner layout but in a neutral (`--acc`/`--soft`) tone, not alert-toned, since it's not an error |
| Per-line approved-total input | **NEW, small** | Styled like admin-ui's labelled numeric/text attribute inputs (`UserDetail.tsx`), but per-row with a row-identity `aria-label` |
| `formatMoney(cents, currency)` (lib, not a component) | **NEW** | Directly answers plan.md's R7 risk ("single shared cents↔display formatter, unit-tested per currency") |
| `EXPENSE_TYPES` constant (12 types, id + IT/EN labels) | **NEW** (lib) | Drives `ExpenseLineComposer`/`ExpenseLineRow`'s type `<select>`; single source for the domain-language table in spec.md |
| Screen R1 row | **NEW, small** | Ported convention from `EstimatesPage.tsx`'s list-row shape (name/status+meta + row actions) |
| Screen A1 row | **NEW, small** | Same row shape as R1, different columns (employee, date, subtotal preview) |
| `RefundShell` root layout | **NEW** | Ported convention from `AdminShell.tsx` (heading + small nav + `<Outlet/>`, no chrome duplication) |
| `Pagination` | **Not applicable** | `GET /requests`/`GET /review/requests` are bare arrays in plan.md's contract — no page/pageSize params exist to drive it (see Gaps #6) |

**Ratio:** 5 reused-or-extended (2 shared federated modules + `ErrorBanner`/
`SkeletonListRows`/`GuardrailDialog`/`PermissionDenied`/`ConfirmDeleteModal` ported, plus
`ApproveDialog`'s extension) : **~16 NEW** files/elements (`RejectDialog`,
`RequestStatusBadge`, `EntityBadge`, `ExpenseLineComposer`, `ExpenseLineRow`,
`AttachmentList`+upload machinery, `AttachmentDownloadLink`, `SubtotalsPanel`,
`SubmitValidationSummary`, `MonthlyProcessingNote`, the approved-total input,
`formatMoney`, `EXPENSE_TYPES`, both row shapes, `RefundShell`). This NEW-heavy ratio is
expected and matches `specs/004`'s own precedent (~9:20) for the same reason: like admin-ui
before `specs/004`, `refund-ui` today is only a proof-of-concept placeholder (`src/App.tsx`)
— this is its first real screen set, standing up a domain (expense lines, type-driven fields,
receipt upload, per-currency subtotals) with no close analog anywhere else in the suite. Every
NEW entry above cites the closest in-repo convention it borrows its shape from rather than
inventing an unrelated visual idiom.

---

## Accessibility

- **Forms (composer + line rows):** every field has an explicit `<label htmlFor>` — no
  placeholder-as-label (Date, Expense type, Motivo, Requested amount, Entity, km). Field
  errors (client-side format checks, and the server's `422` line-validation detail) are wired
  via `aria-invalid`/`aria-describedby` into a single per-field error slot, mirroring
  `CreateRoleModal.tsx`'s `nameError` contract. The `km` field, when shown, carries
  `aria-required="true"` and a `min="1"` / "must be greater than 0" association matching
  AC-1.2 exactly.
- **Type-driven field visibility:** the `km` field's appearance/disappearance on Expense-type
  change is announced via a small `aria-live="polite"` status line inside the composer
  ("Mileage field added — km is required for travel by car" / removed), the same technique
  `RoleEditor.tsx`'s condition-fieldset uses for its own catalog-driven Action-reset
  announcements — a sighted user sees the field appear, a screen-reader user needs the same
  information stated, not just visually implied.
- **Approved-total inputs (Screen A2):** each carries a full, disambiguating
  `aria-label="Approved total for {date} · {motivo} · {currency}"` (mirrors admin-ui's
  `aria-label="Resend invitation to {email}"` convention for a list of otherwise-identical
  controls) — a screen-reader user tabbing through N approved-total inputs by role needs each
  one's row identity restated on the control itself.
- **Keyboard operation:** every interactive element is a native `<button>/<select>/<input>/
  <textarea>/<a>` (this repo's stated a11y posture, `UserDetail.tsx`'s own doc comment).
  Deliberately **not** building `ActivityTable.tsx`'s custom grid keyboard-nav (arrow-key/Tab
  cell hopping) — no AC here asks for drag-reorder or a spreadsheet-dense multi-column grid;
  native Tab order through each `ExpenseLineRow`'s fields, in document order, is sufficient
  and avoids inventing interaction complexity no requirement calls for.
- **Focus management on state transitions:** submit, withdraw, approve, and reject each move
  focus to the screen's status heading immediately after the transition completes (the same
  `tabIndex={-1}` + `ref.current?.focus()` technique `PermissionDenied.tsx` uses for its own
  mount), so a screen-reader user is told the state changed the moment it does, rather than
  having to re-explore the page to discover it.
- **Reject-motivation required-field semantics:** the `<textarea>` inside `RejectDialog` has
  `aria-required="true"`; the Confirm button stays disabled (not merely erroring on click)
  until it's non-empty — a screen-reader/keyboard user tabbing to a disabled control gets an
  immediately-legible reason via the dialog's own instructional text, rather than submitting
  and receiving a late error. The server's `422` (AC-7.3) is defense-in-depth surfaced in the
  same error slot the dialog already reserves for a network/5xx failure.
- **Attachments:** upload state changes (queued → uploading → stored/failed) are announced via
  an `aria-live="polite"` region per file, mirroring `ImportOfferModal.tsx`'s existing
  results-announcement convention; a failed upload's reason (oversize / wrong type / network)
  renders inline, associated with that file's row, never only as a vanished item.
- **Notification / toast a11y:** refund-ui renders **no toasts of its own** for
  submit/withdraw/approve/reject — only `aria-live="polite"` inline confirmations (the same
  anti-toast-for-consequential-state posture `specs/006`'s Panel N3/`InvitationsPage.tsx`
  already establish: "never a toast that could be missed"). The actual cross-user push
  (AC-3.6) is entirely the shell's `ToastHost`/bell/notify-ui (`specs/005-notification-center`,
  ADR-0009) — its own accessibility contract already covers that surface; this document adds
  nothing to it and duplicates none of it.
  - **Amendment (2026-07-17, post-close):** the "no toasts of its own" rule above is scoped to
    the **lifecycle** actions (submit/withdraw/approve/reject) and still holds for them. A
    later cross-app change added **debounced auto-save** of draft expense-line edits with a
    transient, auto-dismissing **"Changes stored" success toast** (and an error toast on
    failure) via a ported `ToastBanner` — a *content-app auto-save* feedback posture, distinct
    from the consequential-lifecycle-state rule. Auto-save/its toast never applies to the
    lifecycle actions, which keep their inline `aria-live` confirmations.
- **Color/contrast:** `RequestStatusBadge` and `EntityBadge` both follow this repo's
  glyph+text+color convention — color is never the only signal (same rule `SystemBadge.tsx`,
  `WarningBadge.tsx`, `InvitationStatusBadge.tsx`, and `ConditionChip.tsx` all state
  explicitly).
- **Money formatting:** `formatMoney` always renders two decimals with an explicit currency
  label (never a bare number a screen reader could misread as unitless), consistent with
  CLAUDE.md's "all numbers displayed to the user must be rounded" rule.
- **Bilingual IT/EN copy:** CLAUDE.md mandates "no hardcoded strings that appear in the UI —
  use constants or i18n from day one," but — per `specs/006/design.md`'s own gap note #4 — no
  i18n infrastructure exists anywhere in the suite today (`estimai-ui`/`admin-ui` are both
  English-only in practice). `refund-ui` is a brand-new remote, so it is the first real
  opportunity to actually stand up bilingual copy rather than inherit the debt again — but
  `plan.md` does not select a mechanism (a lightweight dictionary vs. `react-i18next` vs.
  something else) or add a task for it. This design assumes every user-facing string in the
  components above (including the 12 expense-type labels, which spec.md already gives in
  English-identifier + Italian-source-form-label pairs) is sourced from a single
  `EXPENSE_TYPES`-shaped dictionary keyed for both locales, not inlined JSX text — but the
  choice of i18n *library* is a plan/architecture decision this document defers (see Gaps #1).

---

## Gaps, scope notes & drift (report to PO/architect — not designed around)

1. **No i18n mechanism is selected anywhere in plan.md**, despite CLAUDE.md's "i18n from day
   one" mandate and this being a brand-new remote well-positioned to finally satisfy it. This
   design assumes a dictionary-driven approach (see Accessibility) but does not pick a library
   — flagging for architect/backend-dev/frontend-dev to decide before implementation, since it
   affects every screen above, not just refund-ui.
2. **No UI audit-trail viewer is designed for US-8**, unlike `admin-ui`'s `AuditPage` for
   specs/004's own audit log. This is intentional, not an oversight: no AC in spec.md asks for
   a UI surface over `RefundAuditEntry` rows — US-8's ACs are entirely about the record being
   captured and being immutable, not about anyone browsing it in-app. Flagging so PO can
   confirm this is acceptable for v1 (an audit-viewer would be pure scope creep against the
   current AC set, not something this design should quietly add).
3. **AC-2.4's optional "duplicate this request's lines into a new draft" convenience is
   explicitly NOT designed here** — a `rejected` request's detail only offers a plain
   "+ New request" link (F2 step 4), not a pre-filled duplicate. Spec.md is explicit this
   affordance is "not excluded … but not required either" — this is a deliberate, reported
   scope boundary, not scope creep in either direction; PO can request it as a follow-up if
   the manual re-entry proves painful in practice.
4. **The "write approved-total only on an actual edit, not eagerly for the pre-filled
   default" behavior (F6 step 2) is this design's interpretation, not something plan.md states
   explicitly.** Plan.md says approve-time finalization "default[s] to the requested amount
   for any line left untouched" server-side, which is consistent with the client never having
   written anything for an untouched line — but this should be confirmed against refund-api's
   actual contract once built (does `GET` on a fresh line return `approvedTotalCents: null`,
   and does the UI's locally-computed default ever risk drifting from what approve-time
   actually finalizes to?). Flagging for backend-dev/architect to confirm the read/write
   contract matches this assumption.
5. **Auto-navigating accounting back to the queue after Approve/Reject (F6 steps 4–5) is a
   designer judgment call, not AC-mandated.** An alternative — staying on the decided
   request's now-read-only detail — is equally defensible (lets the accounting user
   double-check what they just recorded). Flagging for PO/QE to confirm the chosen
   "return-to-queue" behavior matches how accounting actually expects to work through a batch
   of requests.
6. **Neither `GET /requests` nor `GET /review/requests` is paginated in plan.md's API
   contract** (both are bare arrays, unlike admin-ui's Users/Audit lists which carry `{items,
   page, pageSize, total}`). This design renders both lists in full and explicitly does not
   reach for the `Pagination` component admin-ui already has, since there's no `page`/
   `pageSize` parameter to drive it. If either list is expected to grow large in real use
   (a company-wide expense queue, or years of an employee's own history), that's a latent gap
   in the plan's contract, not something this design should silently paper over with
   client-side pagination of a full result set — flagging for architect.
7. **`RefundShell`'s internal "Review queue" nav link is shown unconditionally, regardless of
   whether the signed-in user actually holds `request:review`** (Screen A1's PD note). This is
   a deliberate choice: refund-ui has no cheap, ADR-0007-compliant way to know a caller's
   permissions client-side (the JWT deliberately carries no permissions, and `GET
   /authz/resolve`/`GET /authz/me` are resource-server/session-cookie-gated seams this
   feature's plan does not expose to `refund-ui` itself) — so the *suite-level* nav entry
   (shell) is the actual UX-hiding mechanism per plan.md ("the shell nav item is likewise
   gated"), while refund-ui's own internal tab is allowed to be a harmless dead end for a
   non-accounting user, caught cleanly by `PermissionDenied`. Flagging so this isn't read as
   an oversight if a future reviewer expects refund-ui itself to hide the tab.

---

## Summary for the record

- **Flow count:** 7 (F1 compose, F2 submit/withdraw/re-edit, F3 track status/outcome, F4
  monthly-processing cross-reference [no new UI], F5 accounting queue, F6 inspect/decide, F7
  notification cross-reference [no new UI]) — every flow traces to at least one US/AC; no AC
  was found with no UI surface at all (US-8's audit trail is the one US whose ACs are
  deliberately UI-less, per Gaps #2, not an oversight).
- **Screens:** R1 (My requests), R2 (draft composer / request detail, 4 status-driven
  variants), A1 (Review queue), A2 (Review detail, 2 status-driven variants), plus the
  `RefundShell` root layout — all NEW (this is refund-ui's first real screen set).
- **Reuse/NEW ratio:** ~5 reused-or-extended : ~16 NEW (see Component inventory) — higher
  NEW-share than `specs/006`'s ~6:10 (that feature extended an already-conventioned admin-ui
  section), comparable in kind to `specs/004`'s ~9:20 baseline (also a green remote's first
  real screens) — expected for a domain (expense lines, type-driven fields, receipt upload,
  per-currency subtotals) with no close existing analog in this suite.
- **Top a11y hotspots:** the type-driven `km` field's live-announced appearance/disappearance,
  the per-line approved-total inputs' row-identity `aria-label`s at accounting-queue scale, the
  required-motivation `RejectDialog`'s disabled-until-valid confirm, and the multi-file
  attachment upload's per-file `aria-live` state machine.
- **Gaps/drift routed to PO/architect:** (1) no i18n mechanism selected despite the mandate,
  (2) no audit-trail UI designed (deliberately, US-8 asks for none), (3) AC-2.4's optional
  duplicate-lines affordance deliberately not built, (4) the approved-total
  write-only-on-edit behavior is this design's interpretation of plan.md, needing
  backend-dev/architect confirmation, (5) return-to-queue-after-decision is a judgment call,
  not AC-mandated, (6) neither employee nor accounting list is paginated in the plan's API
  contract — a latent scale gap, not a client-side workaround this design invents, (7)
  `RefundShell`'s internal nav intentionally does not hide the Review-queue tab client-side,
  relying on `PermissionDenied` + the shell's own suite-level nav gating instead.

---

## Amendment — 2026-07-17: draft composer, summary rows + confirm-on-delete

Post-close user-reported UX fix. In Screen R2's `draft` variant, every already-added
`ExpenseLineRow` rendered in `edit` mode as a **full editable field form identical to the
"Add expense line" composer** — Date/Type/Motivo/Amount/Entity/Currency all live inputs,
always open — so a user could not visually tell the input form (the composer) apart from the
already-committed lines below it. This amendment **supersedes** two pieces of this document's
original text:

1. **F1 step 4** ("Editing an existing line") and the Screen R2 `draft` bullet in the Screens
   section, which described `edit` mode as always rendering the full field form. It now
   defaults to a **compact read-only summary row** — date, type, motivo, `formatMoney` amount,
   `EntityBadge`/`CurrencyBadge`, and a small "N files" attachment indicator (no upload UI) —
   with native **Edit**/**Delete** buttons. Clicking **Edit** expands that one row inline into
   the exact field layout this document originally specified (same blur-commit-as-one-PUT
   semantics, same type-driven `km` field, same full `AttachmentList`); a **Done** button
   collapses it back to the summary, explicitly re-using the same `commit()` blur-outside uses
   (a click on a button living inside the row's own container never satisfies the "focus left
   the row" check on its own, so this call is what keeps "Done just collapses" from silently
   dropping an unsaved edit). A new "Expense lines (N)" heading sits above the list, making the
   already-distinct composer card unambiguous now that committed lines no longer look like more
   copies of it. The `readOnly`/`readOnlyApproved`/`review` renders (Screen R2's
   `submitted`/`approved`/`rejected` variants and Screen A2) already used this same compact,
   summary-shaped presentation pre-amendment — they are unchanged in behavior, just now
   explicitly documented as sharing one presentation with `edit` mode's collapsed row.
2. **F1 step 6** ("Deleting a line") and **AttachmentList's "×" Remove** (F1 step 5), both of
   which specified no confirm modal — reasoning that a draft line/attachment is "cheap,
   reversible working state." The user asked for the safety net back: both now open a
   `ConfirmDeleteModal` (same ported component `ConfirmDeleteModal`/`AttachmentList` already
   use elsewhere in this feature — namespaced `testIdPrefix`s, e.g.
   `row-{lineId}-delete-confirm-*` / `attachment-remove-confirm-{attachmentId}-*`) naming the
   line (type + motivo) or file before it actually deletes/removes. The `title` hover tooltip
   on each trigger button is retained as a secondary affordance, not a replacement.

No API/contract change — both amendments are purely client-side interaction changes to
`refund-ui`'s `ExpenseLineRow`/`AttachmentList`/`RequestDetailPage`.
