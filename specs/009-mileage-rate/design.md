---
spec: 009
status: draft
---

# Design: Mileage rate — computed amounts for travel-km expense lines

This feature touches three UI surfaces across two federated frontends:

1. **refund-ui** — the employee mileage line (`ExpenseLineComposer` / `ExpenseLineRow`,
   Screen R2 "draft").
2. **refund-ui** — accounting review (`ExpenseLineRow` `review`/read-only-family modes,
   Screen A2).
3. **admin-ui** — a NEW "Mileage Rates" screen (roles/departments/users' sibling section).

All three build on components already read in full for this design (paths cited below are
exact, from the current codebase, not assumed).

---

## Flows

### F1 — Employee drafts a `travel-km` expense line (US-1, US-2)

Entry point: Screen R2 (`RequestDetailPage`, `draft` status) — either `ExpenseLineComposer`
(new line) or an `ExpenseLineRow` in `edit` mode, expanded.

1. Employee sets **Expense type** to "Travel — mileage (km)" (`travel_km`).
2. The moment `requiresKm(type)` flips true (existing `lib/expenseTypes.ts` logic, unchanged):
   - The **Amount** and **Currency** inputs disappear from the field grid — not disabled
     (AC-1.1).
   - The existing **km** field appears, exactly as today (unchanged behavior, AC-1.4's
     `km > 0` rule and its help text are untouched — Non-goals).
   - A NEW **mileage breakdown** region appears in the space the Amount/Currency fields
     vacated, showing the entity's currency (derived, not chosen — AC-1.6) and a live
     "enter distance to calculate" prompt.
3. Employee enters/edits **km** → a debounced (`GET /rates/effective?entity=&date=`) live
   recompute renders `km × rate = amount`, all three numbers together, never the amount
   alone (AC-1.2, AC-1.8).
4. Employee changes **Entity** or **Date** → the same recompute re-fires against the new
   (entity, date) pair and the breakdown updates live (AC-1.3, AC-2.4). The **Currency**
   readout (a `CurrencyBadge`) updates immediately with the entity, on the client, with no
   network round-trip (AC-1.6).
5. If no rate is in effect for the resolved (entity, date) pair, the breakdown region
   instead shows a persistent, non-error "no rate configured" message identifying the
   entity (AC-2.2) — the line can still be saved/added in this state (see "Add/Done enable
   condition" below); only request *submission* is blocked (F2).
6. Save path is unchanged: composer "Add expense line" → `POST .../lines`; row "Done"/
   blur-outside-row → `PUT .../lines/:lineId` (existing `commit()`/debounced-autosave
   machinery in `ExpenseLineRow.tsx`, untouched). The travel_km line's request body omits
   amount/currency; the server computes and returns the authoritative figure on the next
   read (plan.md "Existing request/line/review responses").

**Add/Done enable condition (behavior spec, feeds `lib/lineDraft.ts`'s
`isLineDraftComplete`):** for `travel_km`, "complete" becomes date + type + motivo + entity
+ `km > 0` present — amount/currency are dropped from the completeness check (they no
longer exist as fields), and **`rateInEffect` is deliberately NOT part of completeness** —
a line with no rate configured yet is a valid, saveable draft (AC-2.2's blocked state is a
submission-time gate, not a save-time one, mirroring how an admin might add a rate for a
past date after the employee already started the line).

Success exit: line saved, breakdown visible and live. Error exits: `GET /rates/effective`
network/5xx failure → inline error text in the breakdown region (see Screens & states);
save failure → the existing inline `row-${id}-error`/`composer-error` `role="alert"` text
(unchanged mechanism).

### F2 — Employee submits a request with a blocked or invalid mileage line (US-1 AC-1.4, US-2 AC-2.2)

Entry point: Screen R2, "Submit for review" button.

This flow needs **no new frontend logic** beyond F1: `RequestDetailPage.tsx`'s existing
submit-error handling (`SubmitValidationApiError` → `err.offendingLineIds` →
`SubmitValidationSummary` items, `label = "${line.date} · ${line.motivo}"`) already
generically maps *any* offending line id to a jump link (`RequestDetailPage.tsx:294-304`).
The submit route's extended precondition (plan.md: "resolves each travel_km line's
effective rate; if any is not in effect … or `km ≤ 0` … fails `422` with
`fields.offendingLineIds`") slots into this unchanged mechanism — a blocked mileage line
and an incomplete non-mileage line surface identically at the page level (a banner +
jump-to-line link), while the *specific reason* is explained on the line itself by F1 step
5's persistent message. Success exit: submit succeeds, all lines including mileage ones
transition to their frozen/snapshotted values (F3). Error exit: `SubmitValidationSummary`
renders with one entry per offending line; clicking a link scrolls/focuses that row
(existing `registerRef`/jump mechanism, unchanged).

### F3 — Snapshot / withdraw / resubmit (US-3)

Entry point: any `draft` → `submitted` transition, or `submitted+` → `withdraw` → `draft`.

This is almost entirely a data-flow guarantee (Decision 1, plan.md) with a thin UI
consequence: once a request has ever reached `submitted`, its travel_km lines' amounts are
frozen and are rendered via the read-only/review-family `ExpenseLineRow` modes (F4) — no
live recompute UI is shown there at all (no breakdown "calculating" state, just the fixed
figure + applied-rate detail). If the request is withdrawn back to `draft` (007's existing
withdraw action, unchanged UI), the line reverts to `edit` mode and F1's live-recompute
breakdown reappears automatically (nothing to build — it is simply `ExpenseLineRow`
rendering in `edit` mode again, driven by `line.mileage.snapshotted === false`). No new
screen or component; call out for QE: a withdrawn line must visibly go from "frozen figure,
no breakdown" back to "live breakdown, may show blocked" — a state transition worth an
explicit e2e/component test per plan.md's test strategy, not a new design element.

### F4 — Accounting reviews a request containing mileage lines (US-6 AC-6.1, AC-6.4)

Entry point: Screen A2 (`ReviewDetailPage`), any status (`submitted`/`approved`/
`rejected`/`paid`) — `ExpenseLineRow` in `review`, `readOnly`, or `readOnlyApproved` mode.

1. Accounting opens a request; every line renders via the existing per-status mode mapping
   (unchanged — see `ReviewDetailPage.tsx`'s doc comment).
2. For a `travel_km` line with a non-null `mileage.appliedRate` (i.e., submitted under this
   feature, not a legacy pre-feature line), `summaryCore`'s `<dl>` gains one additional
   `<dt>/<dd>` pair — "Rate applied" — showing the per-km value and its `validFrom` date,
   positioned immediately after "Requested"/"Approved" (AC-6.4). This renders in **every**
   mode `summaryCore` is used in (`edit` collapsed, `readOnly`, `readOnlyApproved`,
   `review`) — so the applied rate is visible however the line is being viewed, not just
   during active review.
3. For a legacy line (`mileage.appliedRate === null`, pre-feature submitted travel_km —
   Risk R3), the extra `<dt>/<dd>` pair is simply omitted — the amount renders exactly as
   it always has, no rate breakdown, no error, no placeholder (graceful degradation, per
   plan.md's explicit mitigation).
4. Accounting's approved-total input (`review` mode) is **completely untouched** — same
   input, same write-on-blur-if-changed logic, same default-prefill — it sits below the new
   "Rate applied" line exactly as it already sits below `summaryCore` today (AC-6.1: the
   computed amount is never a ceiling/floor).

No new screen. This is a pure additive change to one shared render fragment
(`summaryCore` in `ExpenseLineRow.tsx`).

### F5 — Admin adds a new mileage rate entry (US-4, US-5)

Entry point: admin-ui, "Mileage Rates" section (new `/rates` route), reached via
`SectionNav`.

1. Admin with `rate:read` opens the section; sees two independent per-entity tables (WellD
   CH, WellD Italia — AC-2.3's independence is reflected structurally, not just logically)
   each listing that entity's full rate history, newest fields first per the API's own
   ordering (`entries[]`, oldest→newest — table renders in that same order, top to bottom),
   with the entry that is `inEffectToday` visually flagged (AC-4.1, AC-4.3).
2. Admin with `rate:manage` additionally sees a "+ Add rate entry" button under each
   entity's table (entity-scoped, not a single shared form — avoids the class of mistake
   where an admin picks the wrong entity from a dropdown for an irreversible action).
3. Clicking it opens `AddRateEntryModal`, entity pre-set and shown read-only in the modal
   header. Admin enters a positive per-km rate and a valid-from date (past, present, or
   future — no restriction in the UI, mirroring AC-4.8/AC-4.4).
4. Submit → `POST /rates` (via NEW `ratesApi.ts`, cross-origin to refund-api per plan.md's
   chosen call path). On success: modal closes, the entity's table reloads and the new row
   appears in its chronological position; if its `validFrom` is on/before today it may also
   become the new `inEffectToday` entry (table re-flags accordingly). On `422` (AC-4.5):
   field-level error under the offending field (rate value or valid-from), modal stays
   open, nothing persisted — mirrors `CreateRoleModal`'s 409→field-error mapping exactly.
5. There is **no** edit or delete affordance anywhere in this screen — not a disabled
   button, no button at all (AC-4.7) — the table simply has no "Actions" column, mirroring
   `AuditPage.tsx`'s own precedent for a non-mutable record type.

### F6 — Admin (or any `rate:read`-only user) views rate history / audit (US-4 AC-4.1/4.3, US-5 AC-5.3)

Same screen as F5, no separate audit page. **Design decision:** since `GET /rates`' `entries[]`
already carries `createdByEmail`/`createdAt` per plan.md's own contract, and both AC-4.1
("history") and AC-5.3 ("audit") read that identical payload, F6 is satisfied by the SAME
table F5 renders — "Added by" and "Added on" columns are always visible, not hidden behind
a second tab. This is a plan-aligned simplification (plan.md literally annotates the `GET
/rates` response as serving AC-5.3 too), not a scope cut.

### F7 — A user without `rate:read`/`rate:manage` reaches Mileage Rates (US-4 AC-4.6)

Two independent gates, mirroring the pattern the outer `shell` (tool-level) and admin-ui
(section-level, existing on every other screen) already establish — this feature adds a
**third, finer-grained layer** to that same lineage:

- **Proactive:** the "Mileage Rates" `SectionNav` entry itself is omitted entirely if the
  caller's resolved permissions (`GET /authz/me`, already fetched by admin-ui) lack
  `rate:read`. This is admin-ui's **first** capability-driven proactive UI hide (see Gaps
  below — every existing admin-ui screen only reacts to a 403, it never pre-hides based on
  known permissions).
- **Reactive (defense in depth / race condition):** if the route is reached anyway (direct
  URL, a stale nav render, a permission just revoked mid-session), `GET /rates` returns
  `403` and the page swaps in the existing `PermissionDenied` component, exactly like
  `RolesPage.tsx`'s `listState.status === 'forbidden'` branch.
- The "+ Add rate entry" button is separately gated on `rate:manage` (see F5 step 2) — a
  `rate:read`-only caller sees the tables but no add affordance anywhere.

---

## Screens & states

### Screen R2 (refund-ui, existing, MODIFIED) — draft request detail, `travel_km` line

State machine of the new **mileage breakdown region** (inside `ExpenseLineComposer` and
`ExpenseLineRow`'s expanded `edit` mode) — this is the state inventory for the NEW
`MileageAmountField` component (see Component inventory):

| State | Trigger | Rendered content |
|---|---|---|
| **Idle** | `travel_km` selected, km not yet entered or entity/date missing | Muted prompt: "Enter a distance to calculate the amount." + the entity-derived `CurrencyBadge` |
| **Calculating** | km/entity/date changed, debounced fetch in flight | Last-known breakdown stays visible (no flicker/blank), with a small muted "Calculating…" annotation — never blanks a previously computed value while waiting |
| **Computed** | `GET /rates/effective` returns `inEffect: true` | Full breakdown: `{km} km × {rate} {currency}/km = {formatMoney amount}` (AC-1.8, all three together) |
| **Blocked** | `GET /rates/effective` returns `inEffect: false` | Persistent (not error-triggered) message: "No mileage rate configured yet for {entity}." — `role="status"`, amber/`--org` tone (this is a policy-configuration gap, not a user mistake, so it is NOT `role="alert"`); the amount area shows "—" |
| **Fetch error** | network/5xx on `GET /rates/effective` | `role="alert"` red text: "Could not calculate the mileage amount. Try again." — retried automatically on the next km/entity/date edit (no dedicated Retry button; the field is live, editing anything re-triggers the fetch) |

Same states apply identically whether the field is inside `ExpenseLineComposer` (adding a
new line) or `ExpenseLineRow`'s expanded `edit` mode (editing an existing draft line, incl.
a legacy AC-1.7 line the moment it's opened).

**Collapsed summary (`ExpenseLineRow` `edit` mode, not expanded):** the existing
`summaryCore` fragment already renders `{km} km` inline next to the badges — for
`travel_km` this gains a trailing `× {rate} {currency}/km` annotation in the same span, and
the existing "Requested" `<dd>` shows the live computed amount (or an em-dash "—" while
blocked) via the unchanged `formatMoney` call.

### Screen A2 (refund-ui, existing, MODIFIED) — review / decided request detail, `travel_km` line

No new state machine — `summaryCore`'s existing four render branches (`edit` collapsed,
`readOnly`, `readOnlyApproved`, `review`) each gain one conditional `<dt>/<dd>` pair:

| Condition | Rendered |
|---|---|
| `line.mileage !== null && line.mileage.appliedRate !== null` | `<dt>Rate applied</dt><dd>{rate} {currency}/km · valid from {validFrom}</dd>` |
| `line.mileage !== null && line.mileage.appliedRate === null` (legacy, R3) | nothing extra — amount renders exactly as before this feature |
| `line.mileage === null` (non-`travel_km`) | nothing extra — unaffected, AC-1.5 |

### Screen ADM-1 (admin-ui, NEW) — "Mileage Rates" (`/rates`, `MileageRatesPage.tsx`)

Layout: page heading "Mileage Rates" + two independent sections, one per entity
(`🇨🇭 WellD CH` / `🇮🇹 WellD Italia`), each its own heading + table + "+ Add rate entry"
button — mirrors `RolesPage.tsx`'s "heading row + table" shape, doubled per-entity.

| State | Trigger | Rendered content |
|---|---|---|
| **Loading (L)** | initial mount / retry | `SkeletonListRows` under each entity heading (one `GET /rates` call populates both) |
| **Forbidden** | `GET /rates` → 403, or nav-tab reached without `rate:read` | `PermissionDenied` in place of both tables (see Gaps: needs a rate-specific `message` prop) |
| **Error (Err)** | `GET /rates` → non-403 failure | `ErrorBanner` + Retry (existing `reloadToken` pattern) — replaces both tables |
| **Empty (per entity)** | entity has zero entries | "No rate configured yet for {entity}." + (if `rate:manage`) "+ Add rate entry" repeated inline — mirrors `RolesPage.tsx`'s empty-state CTA-repeat convention. *Optional copy enhancement (not required by any AC, flagged not designed-in):* naming that employees will see a blocked line until a rate is added, to connect this admin screen to F1's blocked state — left to the caller/PO to decide whether to include. |
| **Populated (P)** | entries exist | Table: Rate / Valid from / Added by / Added on / Status columns (no Actions column — AC-4.7); the `inEffectToday` row carries the `RateInEffectBadge` in the Status column (glyph+text, never color-only) |

### Modal ADM-M1 (admin-ui, NEW) — "Add rate entry" (`AddRateEntryModal.tsx`)

Triggered from ADM-1's per-entity "+ Add rate entry" button (visible only with
`rate:manage`). Structurally clones `CreateRoleModal.tsx`'s shell (backdrop, `role="dialog"`,
header/body/footer, Escape=Cancel, Tab-trap over the field list).

| State | Trigger | Rendered content |
|---|---|---|
| Idle / filling | modal opens | Entity shown read-only in the header (e.g. "Add rate entry — WellD CH"); Rate per km field (empty, focused on mount); Valid-from field (empty, no default — an admin should not accidentally accept "today" for a policy decision) |
| Field error | `422`, or client-side pre-check | `role="alert"` text under the offending field: "Enter a rate greater than 0." / "Enter a valid date." — modal stays open, values retained |
| General error | any other failure (network/500) | `role="alert"` text above the footer buttons: "Could not add this rate entry. Try again." |
| Submitting | form submitted, request in flight | Both fields + Cancel disabled; submit button label swaps to "Adding…" (mirrors `CreateRoleModal`'s "Creating…") |
| Success | `201` | Modal closes; focus returns to the entity's "+ Add rate entry" button (new focus-return behavior — see Accessibility); the entity's table reloads and shows the new row |

---

## Component inventory

### refund-ui

Library in use: **Tailwind CSS 4** + hand-rolled components, no headless-UI/component
library (confirmed via `package.json`); colors/fonts via CSS custom properties consumed
from the federated `shell` (`var(--text)`, `var(--acc)`, etc.), never Tailwind's own
palette classes.

| Element | Reuse / NEW | Source |
|---|---|---|
| `travel_km` type switch (hide/show fields) | REUSE | `refund-ui/src/lib/expenseTypes.ts` — `requiresKm()`, unchanged; extended usage to also gate amount/currency visibility |
| Entity select, Date field, Motivo field, km field | REUSE | `ExpenseLineComposer.tsx` / `ExpenseLineRow.tsx` — unmodified markup |
| Entity chip | REUSE | `EntityBadge.tsx` — unmodified |
| Currency chip (now derived, not selected) | REUSE | `CurrencyBadge.tsx` — unmodified, just fed a server/entity-derived value instead of a user selection |
| Money formatting | REUSE | `lib/money.ts` `formatMoney(cents, currency)` — unmodified |
| Draft completeness gate ("Add"/"Done" enable) | REUSE (modified) | `lib/lineDraft.ts` `isLineDraftComplete` — logic extended per F1's "Add/Done enable condition"; no new file |
| Page-level submission-blocked banner + jump links | REUSE (unmodified) | `SubmitValidationSummary.tsx` + `RequestDetailPage.tsx`'s existing `offendingLineIds` → items mapping — needs zero code change (F2) |
| Per-line inline error text convention | REUSE | existing `role="alert"` `<p>` pattern (e.g. `composer-error`, `row-${id}-error`) — same convention for the new fetch-error state |
| Field appear/disappear a11y announcement | REUSE (pattern) | `kmStatus` `aria-live="polite"` technique in both files — same technique, new region, for rate-availability transitions |
| `summaryCore`'s `<dl>` money-row convention | REUSE | `ExpenseLineRow.tsx` — extended with one new conditional `<dt>/<dd>` pair (F4) |
| **Live `km × rate = amount` breakdown, with Idle/Calculating/Computed/Blocked/Error states** | **NEW** | `MileageAmountField.tsx` (new file, `refund-ui/src/components/`) — no existing component combines a live-recomputed, read-only, multi-part monetary breakdown with a persistent (non-error) blocked state; every existing money display in this app is either a plain formatted value or an editable input, never both derived-and-explained. Used inside `ExpenseLineComposer` and `ExpenseLineRow`'s expanded `edit` mode. |
| `GET /rates/effective` client | **NEW** (non-visual) | `lib/ratesApi.ts` (or added to existing `lib/refundApi.ts` — implementation's call) — mirrors the existing `lib/requestsApi.ts`/`lib/reviewApi.ts` fetch+`ApiError` convention |
| Client-side preview computation (`km × rate`, rounding) | **NEW** (non-visual) | `lib/computeMileageAmountCents.ts` — implements Decision 3's round-half-up rule client-side for the live preview only (server value always wins on save/read, per plan.md Risk R1) |
| Rate display formatting (`"0,70 CHF/km"`) | **NEW** (non-visual, tiny) | a small formatter mirroring `formatMoney`'s comma-decimal convention, for the per-km rate — needed by both the breakdown (F1) and the review "Rate applied" display (F4) |

**Reuse ratio (refund-ui): 9 reused pieces (components/logic/patterns) to 1 new visual
component**, plus 3 small new non-visual lib files that carry no independent UI surface.

### admin-ui

Library in use: **Tailwind CSS 4** + hand-rolled components (confirmed, matches
refund-ui's posture) — **no shared component library between refund-ui and admin-ui**;
each app hand-rolls its own version of similar shapes (badges, modals, tables) — this
design follows admin-ui's own house style throughout, not refund-ui's, per the brief.

| Element | Reuse / NEW | Source |
|---|---|---|
| Nav integration | REUSE (modified) | `SectionNav.tsx` — one new entry in the `SECTIONS` array, conditionally rendered on `rate:read` (see Gaps: first proactive capability check in this app) |
| Route registration | REUSE (pattern) | `router.tsx` — one new flat sibling route, identical shape to `/roles`/`/departments`/`/users` |
| Table markup | REUSE (pattern, hand-rolled per page like every sibling) | `RolesPage.tsx` / `AuditPage.tsx`'s `<table>` + `<th scope="col">` + row recipe — no shared `Table` component exists in this app to import, so `MileageRatesPage.tsx` clones the identical Tailwind/CSS-variable recipe, as every other admin-ui list page already does |
| Loading state | REUSE | `SkeletonListRows.tsx` — unmodified |
| Error state | REUSE | `ErrorBanner.tsx` — unmodified |
| Forbidden state | REUSE (needs a small extension) | `PermissionDenied.tsx` — currently hardcoded, no `message` prop; needs one added so this screen's copy can be section-specific ("…manage mileage rates") rather than the generic "You no longer have admin access." (flagged in Gaps, not a new component) |
| Modal shell (backdrop/dialog/header/footer/focus-trap/Escape) | REUSE (pattern, cloned like every sibling modal) | `CreateRoleModal.tsx` — structurally identical shell; `AddRateEntryModal.tsx` is a new file but not a new *pattern* |
| Field-level error convention | REUSE | `role="alert"` + `aria-invalid` + `aria-describedby` pairing, identical to `CreateRoleModal.tsx`'s Name field |
| Date input | REUSE (cross-app pattern) | native `<input type="date">`, no picker library — this app has no existing date field, but refund-ui's identical convention (`ExpenseLineComposer.tsx`) is the one to mirror, consistent with the suite-wide no-date-library posture |
| Cross-service API client shape | REUSE (pattern) | `lib/adminApi.ts` — `ratesApi.ts` mirrors its base-URL-from-shell, `getJson`/`sendJson`, `ApiError`/RFC 7807 handling exactly (plan.md's explicit instruction) |
| "In effect" pill shape (glyph+text+color) | REUSE (pattern, not the component itself — different domain) | `InvitationStatusBadge.tsx` / `SystemBadge.tsx` — same visual recipe, new small component because neither existing badge is reusable across domains (one is invitation-status-specific, one is a fixed "System" label) |
| **`MileageRatesPage.tsx`** | **NEW** | no existing page covers this domain; closest siblings (`RolesPage`/`DepartmentsPage`) are single-table, this is two independent tables + two gated add-actions |
| **`AddRateEntryModal.tsx`** | **NEW** | closest precedent (`CreateRoleModal`/`CreateDepartmentModal`) doesn't fit: needs an entity-locked (not editable) header, a positive-decimal rate field, a backdatable/future-dated date field, and framing that this action is irreversible (AC-4.7) — different enough fields/constraints to warrant its own file, same shell |
| **`RateInEffectBadge.tsx`** | **NEW** (small) | no existing badge fits this domain (invitation status ≠ system-role ≠ "currently in effect"); clones the established glyph+text+color recipe |
| **`ratesApi.ts`** | **NEW** (non-visual) | new cross-service caller — plan.md's explicit, deliberate architecture decision (admin-ui calling refund-api directly, not proxied through auth) |

**Reuse ratio (admin-ui): 8 reused patterns/components to 3 new visual components**, plus 1
new non-visual lib file. (`getRefundApiBaseUrl()` on `shell/session` and the `PermissionDenied`
`message` prop are small extensions to files outside this design's direct scope — shell
infra and an existing component respectively — flagged, not designed here.)

---

## Accessibility

### refund-ui — `MileageAmountField` (F1)

- The breakdown region is a live region: `role="status" aria-live="polite"` (not
  `alert` — a routine recompute is not an error). The announced text updates **only when
  the settled (post-debounce) computed value actually changes**, not on every keystroke —
  otherwise a screen-reader user drafting a line would hear "Calculating…" spam on every
  digit typed. This mirrors the existing `kmStatus` region's "announce the outcome, not
  every intermediate keystroke" discipline.
- The **Blocked** state uses `role="status"` too (informational — a config gap, not a user
  error), distinct from the **Fetch error** state's `role="alert"` (assertive — something
  actually failed and needs attention). This distinction matters: conflating the two would
  make routine "not configured yet" states interrupt a screen-reader user's flow the way a
  real error should.
- The computed amount is never a bare number — always routed through `formatMoney`
  (currency-suffixed) and the new rate formatter (`"0,70 CHF/km"`, unit-suffixed), matching
  `money.ts`'s own documented rule: "never a bare number a screen reader could misread as
  unitless."
- Because the Currency `<select>` disappears for `travel_km` (AC-1.6), there is no orphaned
  label/id to worry about — `CurrencyBadge`'s existing markup already carries its own
  visible + programmatically-readable text (`<span>{label}</span>`), so the currency stays
  announced even though it is no longer an interactive control.
- The **km** field's existing `aria-required`/`aria-describedby` help-text pairing is
  unchanged (Non-goals) — no new a11y work needed there.

### refund-ui — review display (F4)

- The new "Rate applied" `<dt>/<dd>` pair uses the same visible-text convention as every
  other `summaryCore` row — no icon-only, no color-only signal, no hover-reveal (this app
  has no tooltip/popover primitive — confirmed absent — so an always-visible pair is both
  the accessible choice and the only one consistent with existing conventions).
- Legacy (null `appliedRate`) lines simply omit the pair — no "N/A" placeholder needed,
  avoiding a confusing announcement for a case that will only exist for pre-feature data.

### admin-ui — Mileage Rates screen (F5/F6/F7)

- Each entity's table needs a name a screen-reader table-navigation command can announce —
  `aria-labelledby` pointing at that entity's own `<h3>` heading (e.g.
  `aria-labelledby="rates-welld_ch-heading"`), since two `<table>`s share the page and
  neither should be ambiguous when jumped to directly.
- `<th scope="col">` on every header cell, matching `RolesPage.tsx`/`AuditPage.tsx`
  verbatim; no Actions column exists (append-only) so there is no `sr-only "Actions"` cell
  to add here (mirrors `AuditPage.tsx`'s own precedent for a non-mutable row type).
- `RateInEffectBadge` pairs a glyph (e.g. ✓) with visible text ("In effect") — never
  color-only, per admin-ui's own explicit house rule (documented in `SystemBadge.tsx`'s
  comment: "colour is never the only signal").
- `AddRateEntryModal`: identical contract to `CreateRoleModal.tsx` — `role="dialog"
  aria-modal="true" aria-labelledby="{id}-title"`, focus lands on the Rate field on mount
  (the form's natural first control), Tab is trapped over the field list, Escape cancels.
  Every field has an explicit `<label htmlFor>`; every field error is `role="alert"` +
  `aria-invalid` + `aria-describedby` pointing at the matching `<p id>`, exactly as
  `CreateRoleModal.tsx`'s Name field already does.
- **New focus-management behavior** (not present in any existing admin-ui "create" modal,
  because every existing one navigates away on success): on successful `POST /rates`, the
  modal closes and focus must be explicitly returned to the entity-scoped "+ Add rate
  entry" button that opened it (captured via a ref, the same technique `ExpenseLineRow.tsx`
  already uses for its own Edit-button-refocus-on-collapse). Without this, focus would
  silently land on `<body>` after the modal unmounts — a real regression versus every
  sibling create-flow, which instead lands the user on a new page/editor.
- **Proactive `SectionNav` hiding is new territory for this app** (flagged again here
  because it's an a11y-relevant decision, not just a visibility one): every existing
  admin-ui screen is reachable via its nav tab and only reveals `PermissionDenied` reactively
  after a 403. Hiding the tab outright for a caller who lacks `rate:read` is more correct
  UX (no dead-end click) but means such a caller gets no explanation via the nav itself —
  the reactive `PermissionDenied` path (F7) remains the fallback explanation if the route is
  reached by URL, so no caller is left without any explanation, just a different one
  depending on entry path.

---

## Gaps, decisions, and questions for the caller

- **`PermissionDenied.tsx` (admin-ui) has no `message` prop today.** Every other admin-ui
  screen shares the identical generic "You no longer have admin access" copy because the
  gate has always been the whole-tool 403 boundary; this is the first *section-level* 403
  in the app, and the generic copy would misleadingly suggest total admin lockout. A small
  prop addition is needed — flagging it here rather than silently deciding it's out of
  scope, since it's a one-line, low-risk extension to an existing component, not a new one.
- **Proactive, permission-driven UI hiding is new territory in admin-ui.** Every existing
  screen only reacts to a 403 that already happened; nothing today conditionally hides a
  nav entry based on `GET /authz/me`'s already-resolved permissions. This design asks for
  exactly that (SectionNav entry + "+ Add rate entry" button), which is a reasonable, small
  extension of an existing capability the app already fetches but doesn't yet consume for
  UI decisions — flagged so the frontend-dev/architect know this is genuinely new plumbing,
  not a copy-paste.
- **admin-ui has no `strings.ts`** (unlike refund-ui). Every sibling screen
  (Roles/Departments/Users/Audit) hardcodes copy inline in JSX. This design follows that
  same house convention for `MileageRatesPage`/`AddRateEntryModal`/`RateInEffectBadge`
  (all copy listed inline above) rather than unilaterally introducing a centralization
  pattern for one feature — that would make admin-ui internally inconsistent (one screen
  centralized, four not). This is a pre-existing gap against CLAUDE.md's suite-wide "no
  hardcoded strings… i18n from day one" mandate, predating this feature — worth a call
  from the PO/architect on whether to address it suite-wide, but not something this
  feature should unilaterally fix in isolation.
- **No explicit error-field-name contract for `POST /rates` 422** in plan.md (unlike
  submit's documented `fields.offendingLineIds` shape). This design assumes the response
  distinguishes a rate-value problem from a valid-from problem (needed to route the error
  to the correct field per AC-4.5's "clear message"); worth the architect/backend-dev
  confirming the exact `fields.*` key names before `AddRateEntryModal` is implemented.
- **Rate history ordering (AC-4.1 "ordered chronologically") is ambiguous on direction.**
  This design follows the API's own stated order (`entries[]`, oldest→newest) rather than
  reversing to newest-first (which `AuditPage.tsx` uses for its own, unrelated audit list)
  — flagging the choice explicitly since either reading satisfies the AC's literal text.
- **Every AC has a UI surface except:** AC-2.1/AC-2.3 (pure resolution-logic correctness,
  observable only through the breakdown/blocked states F1 already covers, not a separate
  affordance); AC-3.1 (a *non-event* — the guarantee is that nothing visibly changes under
  a rate update, so there is nothing to design beyond F3's already-covered transition);
  AC-4.7/AC-5.2 (enforced at the DB, surfaced in the UI only as an absence — no
  edit/delete control anywhere, already covered); AC-6.2/AC-6.3 (`SubtotalsPanel`/batch PDF
  already aggregate by currency with no type-awareness — confirmed unaffected, no UI
  change needed or proposed).
- **Optional, not-designed-in enhancements flagged but intentionally left out** of the
  screens above (scope creep guard, not silently added): (1) an inline "preview" summary
  inside `AddRateEntryModal` echoing the parsed rate/date before the irreversible submit —
  would help catch typos before a permanent append, but no AC asks for it; (2) copy in
  ADM-1's empty state cross-referencing the employee-side blocked message — nice
  cross-surface empathy, not required by any AC. Both are one-paragraph additions if the
  caller wants them; neither is assumed above.
