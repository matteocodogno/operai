---
spec: 20261117
status: draft
---

# Design: Legal entities — one registry of the group's companies, for every tool

Inputs: `spec.md` (approved, amendments D1–D6), `plan.md` (approved), and the UI as it is in this worktree:
`admin-ui`, `crm-ui` (Settings, offer wizard), `letterheads-ui` (configurator, history) and `operai-ui`.
The product is an existing one with a design system, so there is **no Visual direction section** (the system wins;
nothing new in colour, type or icons).

Mockups are visual-companion content fragments under `.forge/design/20261117-legal-entities/content/`
(git-ignored, as is the whole `.forge/design/`). They use the suite's real tokens (`operai-ui/src/styles/tokens.css`),
dark by default, light and Italian in one screen. They were checked for well-formed markup only; they were not
opened in a browser in this run (no server was started, as instructed).

## Decisions the owner is asked to make (three comparison screens) and what is decided

| # | Question | Options | Recommended | Mockup |
|---|---|---|---|---|
| Q1 | Page structure | A overview + one page per entity · B one page with an entity switcher | **A** | `compare-1-page-structure.html` |
| Q2 | How the address is typed | A one text area per language (the CRM habit) · B four line inputs per language | **A** | `compare-2-address-entry.html` |
| Q3 | What a person can do after a 409 (AC-2.6) | A load the newer version, discard mine (letterheads) · B reapply my changes onto the newer version, with "discard" as the second button | **B** | `compare-3-conflict-handling.html` |

Everything below assumes the recommendations. If Q1 = B, the cards of S1 become the badges on the entity tabs and the
per-entity header moves under the tabs; S2–S8 are unchanged. If Q2 = B, only the address `Field`s change (the API
contract is the same, `address.it: string[]`). If Q3 = A, the conflict banner has the one action and the typed values
must stay visible some other way (AC-2.6 says "keeping what they typed"; A alone is weaker than the spec).

Decided here (no owner choice needed, reversible): status labels (below), list order, one-tab strip for a manager,
no confirmation step on an IBAN change (see Scope creep), the freshness sentence after a save.

## Project UI system (discovered, not assumed)

Library in use: **`@operai/ui`** (the suite's own design system, ADR 20261031, consumed as source) with token
utilities on **Tailwind v4** (`text-soft`, `bg-ink-mid`, `border-rule`, `font-mono`); no Mantine/MUI/shadcn. Rules read:
`operai-ui/docs/design-system.md`, `building-pages.md`. Conventions that bind this design: pages never render
`<main>`/h1 (the shell and `ToolLayout` do); every control in `Field`; statuses as `Badge` glyph + text; a section the
person may not open is left out of the DOM; copy only in the app's `strings` (en + it, `noHardcodedStrings` and
parity tests); no colour, border or radius from utilities on a library component; "a pattern used by two apps lives
in the library — never copy a component from another app".

## Routes (admin-ui inner router, mounted at `/admin`)

| Route | Screen | Notes |
|---|---|---|
| `/legal-entities` | S1 overview | section tab "Legal entities" (after Users, before the end-anchored Audit) |
| `/legal-entities/$entity` (`?view=history`) | S2–S5 entity page, **Details \| History** `Tabs` | `$entity` ∈ `welld_it`, `welld_ch`; anything else → the existing `NotFoundPage` (the name is not echoed) |
| `/legal-entities/$entity/versions/$n` | S6 version view | `$n` a whole number ≥ 1; unknown → "This version does not exist" state |
| index `/` | redirect | to the first section the person may use (`/roles` for an administrator, `/legal-entities` for a manager-only person); a hidden section's URL redirects there too (plan decision 5) |

## Flows

Each flow is one user goal; ids are used by the screens and tests below.

| Flow | Goal and steps | Exits | AC |
|---|---|---|---|
| **F1 Reach the page** | Signed-in person holding `legal-entity:manage` for ≥ 1 entity → sidebar shows **Admin** (derived `apps`) → admin-ui resolves its sections (skeleton tabs) → lands on the first one. A manager-only person lands on Legal entities; an administrator on Roles. A hidden section's URL redirects. | no grant: no Admin tool; admin without the grant: no Legal entities tab; `manageable` read fails: warning Banner + Retry in place of the page | AC-4.3, plan dec. 5 |
| **F2 See both entities** | Open Legal entities → two cards (entities the person may change first) with status, key values, version, who/when → Edit / View / History | load failed (Retry); 403 → `PermissionDenied`; entity not moved (version 0) | AC-1.1, AC-4.3, AC-7.3 |
| **F3 Change the details and save** | Edit details → change values (IBAN typed any way) → Save as version n+1 → success status "Version n+1 saved. Every tool uses it within a minute." → form reloaded from the saved answer (IBAN grouped) | refused (F4), no-op (F5), conflict (F6), grant lost (403), network/5xx (Retry) | AC-1.1, 1.4, 1.5, 2.1 |
| **F4 A refused save** | Save → 422 `invalid_legal_entity` with every problem → error summary announced + focus on the first refused control (page order) → person corrects → Save again. Typed values are kept; nothing was stored | — | AC-1.2, 1.3, 1.4, 8.1 |
| **F5 A save that changes nothing** | Only blanks/case/spaces differ → 200 `created: false` → polite "Nothing changed. These details are already version n." and the normalised values; no new version. An untouched form never sends: Save is `aria-disabled` with its reason | — | AC-2.1 |
| **F6 Two people edit the same entity** | Save with a stale base → 409 `version_conflict` → warning Banner (who saved the newer version, when, which values) with **Reapply my changes to version n** and **Discard my changes and load version n**; Save is aria-disabled until one is chosen. Reapply merges per value and flags values both changed | read of the newer version fails: Banner keeps both actions and says so; Retry | AC-2.6 |
| **F7 Read an entity I may not change** | Open a read-only entity → same page, values as facts, persistent info Banner saying why there are no controls, History tab still there | — | AC-4.2, 4.3 |
| **F8 See the history** | History tab → versions newest first: number (+ Current badge, "Restored from version m"), who ("System" for version 1), when, which values changed → Open / Restore | loading, empty (version 0), failed + Retry (rows kept) | AC-2.2, 2.7, 7.2 |
| **F9 Open a version** | Open → version view: heading takes focus, read-only values, banner with Back to history and (manager) Restore this version. Opening the current version goes to Details | version does not exist (404) → state with Back; failed load + Retry | AC-2.3 |
| **F10 Restore a version** | Restore (row or version view) → confirm dialog naming the new version number and the values that will change → Confirm → success: back on Details, heading focused, status "Version n created from version m" | refused: the version fails today's rules → inline error in the dialog (422) and, from the version view, Restore is aria-disabled with the reason; conflict (409) → history reloaded behind the dialog; 403 → dialog error, page turns read-only | AC-2.4, 2.5, D4 |
| **F11 Fix a moved entity** | Overview shows Incomplete / Needs correction → Edit → form opens with a persistent (non-announced) warning listing what is missing and what is out of limits, each value marked in place → fill/correct → Save → entity becomes Complete | save refused again (F4) | AC-7.1–7.3 |
| **F12 CRM Settings points to the page** | CRM Settings, each entity card: a note where the legal fields were; a link for a person who may manage that entity, a sentence for everyone else | link target missing/permission lost: the page's own redirect | AC-6.1 (D5) |
| **F13 CRM refuses an offer** | Generate (or preview, edit/revise) for an incomplete entity → 409 `legal_entity_incomplete` → Banner naming the entity and the missing details, where to fill them (Open Legal entities for a manager, "ask an administrator" otherwise); nothing created | registry unreadable → 503 banner with Retry | AC-6.3, 5.5 |
| **F14 Preview in the configurator** | Letterheads configurator → preview shows the entity's real details in the preview language; empty values in the missing look; a source line with a link for a manager | registry unreadable → warning in the preview slot, every detail shown as missing, form and Save unaffected | AC-5.4 (5.5 for documents) |

Language (AC-8.2) is not a flow: every string below exists in en and it and follows the shell's language.

## Screens & states

Notation: **S** = screen, state lists are exhaustive for the screen. Mockups are referenced with `> mockup:`.

### S1 Overview — `/legal-entities` (F1, F2, F11)

Purpose: both entities at a glance; where to go to change or read them.
Key elements: `PageHeader` (h2 "Legal entities" + one-line description); one `Card` per entity (title h3 = entity name as in
`strings.common.entities`; right side: status `Badge` and, when not changeable, a "Read-only" `Badge` with a lock
glyph); `FactList` of legal name, VAT, IBAN (grouped, `font-mono`), address IT, address EN; a muted line "Version n ·
saved by X · date" (or "moved from the CRM by the system"); buttons **Edit details** (primary, `sm`, only for a
changeable entity) or **View details** (secondary), and **History** (secondary). Order: entities the person may change
first, then the others in the fixed order welld_it, welld_ch.

Status badge (one place, `legalEntityStatus()`):

| Registry says | Badge | Extra lines on the card |
|---|---|---|
| `version ≥ 1`, `complete`, no `invalid` | **Complete** (success, check-circle) | — |
| `complete: false` | **Incomplete** (warning, alert) | "Missing: …" + "Offers and contracts for this entity are refused until they are filled in." (AC-6.3); and "To correct before the next save: …" when `invalid` is also non-empty |
| `complete: true`, `invalid` non-empty | **Needs correction** (warning, alert) | "To correct before the next save: …" (these still print as moved, AC-7.5) |
| `version: 0` | **Not moved yet** (muted, clock) | one sentence; no Edit; History shows its empty state |

Wording note: AC-7.3 says the page marks such an entity "incomplete"; the design separates "missing a required value"
from "holds a value today's rules refuse" because only the first stops offers. See DR-6.

States: loaded · loading (hidden live "Loading the legal entities…" + two skeleton cards) · load failed (warning Banner +
Retry) · entity not moved · 403 (existing `PermissionDenied`, focus on its heading).
> mockup: `.forge/design/20261117-legal-entities/content/legal-entities-overview-manager-ch.html`
> mockup: `.forge/design/20261117-legal-entities/content/legal-entities-overview-states.html`
> mockup: `.forge/design/20261117-legal-entities/content/compare-1-page-structure.html` (open question Q1)
> mockup: `.forge/design/20261117-legal-entities/content/light-theme-italian-overview-refused-history.html` (light + Italian)

### S2 Entity page — Details, a changeable entity (F3–F6)

Purpose: change the details of one entity.
Frame: `PageHeader` (back link "Legal entities", h2 = entity, status Badge, description "Version n · saved by X · date")
→ `Tabs` **Details | History** (`?view=history`) → page body.
Body (form, one `Card` per group, every control in `Field`, label above, hint and error below):
- **Company** — Legal name (required), VAT number (required), IBAN (optional, `font-mono`; hint: spaces and lower case
  are fine, it is saved without spaces and shown in groups of four).
- **Address** — Italian and English side by side from `md` (stacked below), one text area each (Q2), required, hint "One
  line per row, up to 4 lines of 120 characters. Both languages are required."
- **Contacts line** — Italian and English single-line inputs, optional, hint with an example, limit 200.
- **Save bar** (sticky, the letterheads `SaveBar` pattern): status text with icon ("Unsaved changes. Every tool uses a
  saved version within a minute." / "No changes"), **Save as version n+1**. Save is `aria-disabled` (not `disabled`)
  while there is nothing to save, a conflict is open or a save runs; its reason is a hidden description.
- The browser validates nothing (auth owns the rules, plan decision 10); the only client work is trimming for the
  dirty check and, on blur, grouping the IBAN cosmetically (never while typing).

States (all in one page, mutually exclusive on the banner slot above the form):
1. **clean** (loaded, nothing typed; Save aria-disabled, "No changes");
2. **dirty** (Save available);
3. **saving** (`busy`, "Saving…", ignores clicks, controls not disabled so focus is not lost);
4. **saved** — compact success Banner (polite, auto-dismiss 3 s) "Version n saved. Every tool uses it within a minute."; focus stays on Save;
5. **no-op** — polite info "Nothing changed. These details are already version n, so no new version was made."; fields re-rendered normalised;
6. **refused** — error summary (below) + focus on the first refused control;
7. **conflict** — warning Banner with the two actions (Q3);
8. **grant lost (403)** — danger Banner "You can no longer change {entity}. Your changes were not saved. The details are now read-only." and the page becomes S4;
9. **could not save (network/5xx/503)** — warning Banner + Retry, values and base version kept;
10. **leaving with changes** — `ConfirmDialog tone="danger"` "Leave without saving?" (Cancel = "Keep editing", focused first) on Back, tab change, section change and a router blocker + `beforeunload`.

The **error summary** is the letterheads `ErrorSummary` (lifted into `@operai/ui`, see inventory): assertive `danger`
Banner, title "Nothing was saved. n values need your attention.", hint, then one button per problem in page order
("{Value}: {what to do}") that moves focus to its control. Each refused control is `aria-invalid` and described by
its own error (`Field error`); the sentence is the same in both places. Problem → sentence (by `reason`, never by the
server's wording): `required` "Enter the {value}." · `too_long` "Too long: at most {limit} characters, you have {n}." ·
`too_many_lines` "Too many lines: at most 4, you have {n}." · `line_break` "Use one line: remove the line break." ·
`control_character` "Remove the special character (a tab or control character)." · `iban_format` "An IBAN starts with
two letters and two digits, then letters and digits only." · `iban_check_digits` "The check digits do not match.
Check it for a typing mistake." An address problem with `line` says "Line 2 of the Italian address: …" in the summary.

> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-form-editing.html`
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-form-refused.html`
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-form-conflict.html`
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-form-outcomes.html` (saved, no-op, 403, could not save, leave dialog)
> mockup: `.forge/design/20261117-legal-entities/content/compare-2-address-entry.html` (open question Q2)
> mockup: `.forge/design/20261117-legal-entities/content/compare-3-conflict-handling.html` (open question Q3)

**Conflict behaviour (Q3 = B).** The 409 carries only `currentVersion`; the page then reads the current details
(`GET /legal-entities/{entity}`) and the history (for who/when/which values) and shows the banner. **Reapply** merges per
value over the seven values (legal name, address IT, address EN, VAT, IBAN, contacts IT, contacts EN) using three
values: what the person loaded (base), what they typed, what version n holds: only I changed → mine; only they changed →
theirs; both changed → mine, flagged with their value and a "Use theirs" link; neither → same. The base becomes n, Save is
enabled again. Focus goes to the first flagged value, or to Save when none; the polite status says how many values were
flagged. **Discard** replaces the form with version n (confirm-less, because the banner already says what is lost).

### S3 Entity page — Details, an entity moved incomplete or out of limits (F11)

Same page as S2, opened on a record version 1 imported. Differences: a persistent warning Banner (`live="off"`, not
announced on load) "These details are incomplete" (or "Some values need correcting") listing the missing and the
refused values in words and saying what it means for offers (AC-6.3); each affected control is `aria-invalid` with a
static, described-by sentence ("Not filled in. Enter the VAT number." / "The check digits do not match. … (Kept as moved
from the CRM.)"); values shown exactly as moved (D3, never repaired silently); Save aria-disabled until something changes,
then the normal refusal flow (S2 state 6) applies to anything still wrong. Version line says "moved from the CRM by the system".
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-form-incomplete-moved.html`

### S4 Entity page — Details, read-only (F7)

Same frame; no form, no bar. A persistent info Banner (`live="off"`) "You can read these details but not change them. An
administrator grants who may change {entity}." replaces disabled controls (nothing is a disabled input). Values in
`FactList`s inside the same three cards; required-but-empty values say "Not filled in" with an alert glyph, optional empty
ones "Empty". An incomplete/needs-correction Banner is shown as in S3 with the wording "until someone who may change them
fills them in". History tab present. Also the state of a changeable page after a 403 (S2 state 8) and of a not-moved entity
(no form; the S1 sentence). Heading, badges and tabs identical to S2.
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-readonly.html`

### S5 History tab (F8)

`VersionTable` (lifted, built on `DataTable`), caption "Versions of {entity}": columns **Version** (row header; Current
badge on the highest; "Restored from version m" under a restored one), **Saved by** (the person's name as stored at the
save; **System** for the move), **Saved on** (`<time dateTime>`), **What changed** (value names in words from
`changedFields`; for a restore "Same details as version m" + beneath "Changed: …"; for version 1 "Moved from the CRM"),
**Actions** (**Open** on every row, **Restore** on every row but the current, only when the person may change this
entity). A read-only entity's history is readable (the API allows any covered entity) and shows Open only. Row buttons
carry row-specific names ("Open version 3", "Restore version 3").
States: loaded (manager) · loaded (read-only) · loading (hidden live "Loading the history…" + skeleton rows) · empty
(`StatePanel` "No versions yet", version 0) · failed (warning Banner + Retry; previous rows stay).
The list is unpaged (a registry of two entities; plan returns every version). Revisit only if an entity passes a few hundred versions.
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-history.html`

### S6 Version view — `/legal-entities/$entity/versions/$n` (F9, F10)

`PageHeader` (back "History", h2 "{entity} — version n", "Not current" badge) → `VersionBanner` (lifted; info,
`live="off"`; its heading "Viewing version n (read-only)" takes focus on arrival; saved by/when; "The current version
is m.") with **Back to history** and, for a person who may change the entity, **Restore this version** (primary) → the
same three cards as S4 (values only; no input, no Save). Opening the current version redirects to Details.
States: restorable · **restore blocked** (the version's own answer says `complete: false` or `invalid` non-empty: Restore
is `aria-disabled`, focusable, described by "This version cannot be restored: {missing and invalid values}. Restoring it would
make {entity} incomplete again." — D4) · loading · version not found (404 `version_not_found`: `StatePanel` + Back) · failed (Banner + Retry).
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-version-view.html`

### S7 Restore dialog (F10)

`ConfirmDialog tone="primary"`, title "Restore version n?", body "This creates version m+1 with the same details as version n
and makes it the current one. Version m and the rest of the history stay as they are." and a second line "Compared with the
current version, these change: {values}." (so a payment-detail change is visible before it is made; computed from the two
versions the page holds). Confirm "Restore version n"; busy "Restoring…" (not dismissible). States: confirm · busy ·
**refused** (422: inline assertive error "Version n cannot be restored" naming what is missing/invalid; the dialog stays
open; Cancel is the way out) · **conflict** (409: inline "A newer version was saved meanwhile…", history reloaded behind it,
the next Confirm uses the new base) · **forbidden/failed** (403 → "You can no longer change {entity}", page turns S4; 5xx
→ "Version n was not restored. Nothing changed. Try again."). On success: dialog closes, Details tab, h2 focused, compact success
"Version m+1 created from version n".
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-restore-dialog.html`

### S8 Admin navigation by capability (F1)

The shell is unchanged: its sidebar shows **Admin** from the derived `apps`. Inside admin-ui `SectionNav` (`TabNav`,
`aria-label` "Admin sections") lists what the person may use: Roles, Departments, Users when they hold `admin:access`
(`usePermissions().permissions`); **Legal entities** when `GET /legal-entities/manageable` is non-empty; Audit pinned to the
end for `admin:access`. A manager-only person sees one tab (kept so the tool looks and navigates the same for everyone and the
`nav` landmark stays); the index redirects to it. Because a manager-only person has no `admin:access`, the index waits for
`manageable` before redirecting: skeleton tabs + hidden live "Loading…". States: manager-only · administrator with the grant ·
administrator without it (no tab) · resolving · `manageable` failed (warning Banner + Retry in the page slot; no redirect to
a page that would 403).
> mockup: `.forge/design/20261117-legal-entities/content/admin-nav-by-capability.html`

### S9 CRM Settings — entity card (F12)

`EntityProfileForm` loses Legal name, Address, VAT number and IBAN (and their limits/strings); it keeps place of issue and the
two standard-terms fields. A compact info `Banner` (`live="off"`) opens each entity card: "Legal name, address, VAT number and IBAN
are kept in Legal entities, not here." with an **Open Legal entities** link-button (external icon) when `GET /legal-entities/manageable`
lists that entity (a plain `<a href="/admin/legal-entities/{entity}">`, as `LetterheadNotice` does for Letterheads); otherwise the
sentence "…are kept on the Legal entities page (Admin). An administrator keeps them." and no link (D5). `SettingsPage`
descriptions say "issuer details" already; the "Not set up yet. Offers … cannot be generated until it is." line (`settings.notSet`)
must change if generation no longer needs a profile row (DR-5). States: manager link · note only · (the form's own states unchanged).
> mockup: `.forge/design/20261117-legal-entities/content/crm-settings-legal-entity-note.html`

### S10 CRM refusal notices (F13)

New `LegalEntityNotice` beside `LetterheadNotice`, same rules. 409 `legal_entity_incomplete` (+ `entity`, `missing[]`):
- **generate / edit / revise**: `danger` Banner (assertive), title "The legal details of {entity} are incomplete", body "No offer was created. Missing: {values in words}. Fill them in on the Legal entities page, then try again." + **Open Legal entities** only for a person who may manage that entity; else "Ask an administrator who keeps the Legal entities page to fill them in.";
- **preview pane** (both preview routes, try-preview): the same words as a compact polite `warning` Banner, without "No offer was created";
- 503 `legal_entities_unavailable`: `danger` Banner "The legal details could not be read" + "No offer was created: no offer number was used and the draft is unchanged. Try again in a moment." + Retry (same shape as the existing `layoutUnavailable`). Designed because it is the CRM-visible consequence of AC-5.5; no AC names its wording.
`missing[]` values map to words (`legalName` "Legal name", `address.it` "Address (Italian)", `address.en` "Address (English)", `vatNumber` "VAT number"); an unknown value is shown as received. Strings to change: `offers.errors.profileMissing`, `offerWizard.preview.profileMissing` (both say the legal name is set in CRM Settings, now false), and `offerFailure()` gains the new codes.
> mockup: `.forge/design/20261117-legal-entities/content/crm-offer-refused-legal-entity-incomplete.html`

### S11 Letterheads configurator preview (F14)

`PreviewPane`'s sentence "Sample document with sample company data. Nothing here is read from the CRM or any other tool." (now
false) becomes: "The company details (name, address, VAT number, IBAN, contacts) are the real ones from Legal entities, in the
preview language. The body of the page is sample text." followed, for a person who may manage that entity, by a link "Edit them in
Legal entities", otherwise "An administrator keeps them in Legal entities." Under it a one-line **legend** of the missing style:
the ⟦Label⟧ mark on the existing `paper-mark` yellow and "A detail that is not filled in yet." The pages stay the service's picture
inside `PagePreview`; an empty value prints its label in the missing look and its conditional segment is kept (AC-5.4, engine's job).
States: complete entity · entity with empty values (missing look) · registry unreadable (`issuerDetails: "unavailable"`: warning
Banner + "Try again" in the `PagePreview` slot, every detail shown as missing; form and Save unaffected) · the existing loading/failed/refused states, unchanged.
Not designed (scope creep, see below): a notice that an incomplete entity makes the CRM refuse offers.
> mockup: `.forge/design/20261117-legal-entities/content/letterheads-preview-real-details.html`

## Component inventory

Library in use: **`@operai/ui`** (operai-ui/src/index.ts), Tailwind token utilities. "Reuse" cites the component; "LIFT" is
a pattern that exists in letterheads-ui and now has a second consumer, so the library rule requires it to move to
`@operai/ui` (with a story and a test) rather than be copied; "NEW" has no equivalent.

### Reused as is

| Element | Component |
|---|---|
| Tool frame, section tabs | `ToolLayout`, `TabNav` + `tabLinkClassName` (`admin-ui/src/components/AdminShell.tsx`, `SectionNav.tsx`, modified to be capability-driven) |
| Page title, back link, status, actions | `PageHeader` (+ `Icon arrow-left`, `.link`) |
| Details / History views | `Tabs` + `tabPanelProps` |
| Entity cards, form groups | `Card` |
| Read-only values | `FactList` |
| Every control | `Field` + `focusFirstInvalid` (the letterheads/CRM refusal focus helper) |
| Buttons, link-buttons | `Button`, `buttonClassName` |
| Status, read-only mark | `Badge` + `Icon` (check-circle, alert, lock, clock, pencil, eye, external, arrow-left, refresh — all exist) |
| Messages | `Banner` (info, success compact, warning, danger; `live="off"` for persistent notes) |
| History table | `DataTable` (inside the lifted `VersionTable`) |
| Confirmations | `ConfirmDialog` (restore, leave) |
| Empty / denied | `StatePanel`; admin-ui `PermissionDenied`, `ErrorBanner`, `SkeletonListRows` |
| Loading text | `VisuallyHidden live`, `SkeletonRows` |
| Dates, language | `formatDateTime`, `selectStrings` / `resolveLocale` |
| Preview pages | `PagePreview`, `RadioGroupField` (unchanged in letterheads-ui) |
| Entity labels | `strings.common.entities` in admin-ui; `strings.badges.entity` in crm-ui |
| Fetching | admin-ui's `apiFetch`/`ApiError` conventions (`lib/adminApi.ts`) for a new `lib/legalEntitiesApi.ts` |
| Link-for-managers pattern | crm-ui `LetterheadNotice` (model for S9, S10) |
| Retry/refusal flow | CRM `EntityProfileForm`'s `focusFirstInvalid` + banner fallback |

### LIFT into `@operai/ui` (first lift of letterheads-ui patterns; admin-ui is the second consumer)

| Component | From | Why it is the right shape to lift |
|---|---|---|
| `ErrorSummary` | `letterheads-ui/src/components/ErrorSummary.tsx` | Presentational already; only its strings (`strings.problem.summaryTitle/summaryHint`) and the `Problem` type are app-owned. Library form: `{ title, hint, items: [{ id, text }], onGo }`, assertive `danger` Banner with a button per item. |
| `VersionTable` | rows/columns of `HistoryPanel.tsx` | The table (version + Current badge + "restored from", who, when, what changed, Open/Restore) is identical in both apps; the fetching hook, `strings` and the restore flow are not. Library form: `{ caption, rows: [{ version, current, restoredFrom, savedBy, savedAt, changed, … }], labels, canRestore, onOpen, onRestore }`. |
| `VersionBanner` | the banner half of `HistoryPanelVersion.tsx` | Heading that takes focus, who/when, Back and Restore actions; the history fetch stays in the app. |

Decision for the owner/planner (R13): letterheads-ui is still mid-spec (specs/20261116-letterhead-service). Recommended order:
build the three in `@operai/ui` from the letterheads code, use them in admin-ui now, and move letterheads-ui onto them in a
later change as thin adapters (design-system D-06). The alternative — admin-ui builds its own on `DataTable` — repeats
about 150 lines and breaks "never copy a component". `RestoreDialog` is **not** lifted: it calls the app's API, and its
confirmation is already the library's `ConfirmDialog`.

### NEW (app compositions; no new primitive, no new token, no new icon)

| Element | Where | Justification: nothing in `@operai/ui` or the apps fits because… |
|---|---|---|
| `LegalEntitiesPage` + `LegalEntityCard` (S1) | admin-ui | domain page: status mapping, ordering by capability |
| `LegalEntityPage` (S2–S5 host: frame, tabs, banner slot, leave guard) | admin-ui | one host for four states of one record |
| `LegalEntityForm` + `AddressField` | admin-ui | the form itself; `AddressField` is a thin text-area-per-language `Field` pair |
| `LegalEntityFacts` | admin-ui | `FactList` plus "Not filled in"/"Empty" rendering shared by S1, S4, S6 |
| `LegalEntityHistory` (S5), `LegalEntityVersionPage` (S6) | admin-ui | bind the lifted components to the registry API |
| `RestoreDialog` (S7) | admin-ui | composes `ConfirmDialog`; owns the restore call and its four refusals |
| `ConflictBanner` + `mergeOnConflict()` (pure) | admin-ui | Q3; composes `Banner`; the merge is a pure function with its own tests |
| `legalEntityStatus()`, `problemSentence()`, `valueName()` | admin-ui `lib/` | the single mappings from API answers to badge/sentence/word |
| `lib/legalEntitiesApi.ts` | admin-ui | typed client of the plan's routes |
| `LegalEntityNotice` (S10) + `useCanManageLegalEntity(entity)` | crm-ui | sibling of `LetterheadNotice`; different sentences and gate |
| `LegalEntitySettingsNote` (S9) | crm-ui | the note row; uses the same hook |
| `useCanManageLegalEntity` (same hook, own copy: apps cannot share a hook through `shell/session`) | letterheads-ui | gate for the preview link |

Ratio: **29 reused** (22 `@operai/ui` components/helpers + 7 in-repo pieces) : **3 lifted** into the library : **12 app-composition rows** (about 19 units of code), **0 new primitives, 0 new tokens, 0 new icons**. Every NEW row is a composition of reused parts.

Changed existing: admin-ui `router.tsx` (three routes, index redirect by capability), `SectionNav` (capability-driven),
`strings/*` (new `legalEntities` area; `audit.description` mentions "legal entity changes" too — the Audit tab already
shows the new `legal_entity.*` rows without other change); crm-ui `EntityProfileForm`, `SettingsPage`, `offerErrors.ts`,
the two `profileMissing` strings, `ServicePreview`/wizard notice slots; letterheads-ui `PreviewPane` text and legend.
Not touched: shell, the role editor (it renders `legal-entity:manage` and its `entity` condition from the catalog), `AuditPage`.

## Copy keys (AC-8.2) — admin-ui `strings/legalEntities.ts`, en · it

Same shape as the other areas: `en`, `it: typeof en`; the parity test and `noHardcodedStrings` cover it. Italian uses the
spec's vocabulary ("Società del gruppo"). Functions take counts/names, never concatenate in components.

| Key | English | Italian |
|---|---|---|
| `nav.legalEntities` | Legal entities | Società del gruppo |
| `overview.heading` / `description` | Legal entities / The legal details every tool prints on its documents, kept once for the whole group. | Società del gruppo / I dati legali che ogni strumento stampa sui suoi documenti, tenuti una sola volta per tutto il gruppo. |
| `status.complete` · `incomplete` · `needsCorrection` · `notMoved` · `readOnly` | Complete · Incomplete · Needs correction · Not moved yet · Read-only | Completa · Incompleta · Da correggere · Non ancora portata · Sola lettura |
| `card.missing(list)` | Missing: {list}. Offers and contracts for this entity are refused until they are filled in. | Mancano: {list}. Le offerte e i contratti di questa società sono rifiutati finché non sono compilati. |
| `card.toCorrect(list)` | To correct before the next save: {list}. | Da correggere prima del prossimo salvataggio: {list}. |
| `card.version(n, who, when)` | Version {n} · saved by {who} · {when} | Versione {n} · salvata da {who} · {when} |
| `card.moved(when)` | Version 1 · moved from the CRM by the system · {when} | Versione 1 · portata dal CRM dal sistema · {when} |
| `card.notMoved` | The details have not been moved into the registry yet. They can be edited once the move has run. | I dati non sono ancora stati portati nel registro. Si potranno modificare dopo il trasferimento. |
| `card.edit` · `view` · `history` | Edit details · View details · History | Modifica i dati · Vedi i dati · Cronologia |
| `value.legalName` · `vat` · `iban` · `addressIt` · `addressEn` · `contactsIt` · `contactsEn` | Legal name · VAT number · IBAN · Address (Italian) · Address (English) · Contacts line (Italian) · Contacts line (English) | Ragione sociale · Partita IVA · IBAN · Indirizzo (italiano) · Indirizzo (inglese) · Riga contatti (italiano) · Riga contatti (inglese) |
| `value.notFilled` · `empty` | Not filled in · Empty | Non compilato · Vuoto |
| `form.group.company` · `address` · `contacts` | Company · Address · Contacts line | Società · Indirizzo · Riga contatti |
| `form.ibanHint` | Spaces and lower case are fine; it is saved without spaces and shown in groups of four. Optional. | Spazi e maiuscole/minuscole non contano; viene salvato senza spazi e mostrato a gruppi di quattro. Facoltativo. |
| `form.addressHint` | One line per row, up to 4 lines of 120 characters. Both languages are required. | Una riga per rigo, fino a 4 righe di 120 caratteri. Servono entrambe le lingue. |
| `form.contactsHint` | Printed on the letterhead, for example phone and email. Up to 200 characters. Optional. | Stampata sulla carta intestata, per esempio telefono ed email. Fino a 200 caratteri. Facoltativa. |
| `bar.dirty` · `clean` · `saving` · `save(n)` | Unsaved changes. Every tool uses a saved version within a minute. · No changes · Saving… · Save as version {n} | Modifiche non salvate. Ogni strumento usa una versione salvata entro un minuto. · Nessuna modifica · Salvataggio… · Salva come versione {n} |
| `bar.nothingToSave` · `reloadFirst` (hidden reasons) | There is nothing to save. · A newer version exists. Choose how to continue. | Non c'è nulla da salvare. · Esiste una versione più recente. Scegli come proseguire. |
| `saved(n)` · `noop(n)` | Version {n} saved. Every tool uses it within a minute. · Nothing changed. These details are already version {n}, so no new version was made. | Versione {n} salvata. Ogni strumento la usa entro un minuto. · Nulla è cambiato. Questi dati sono già la versione {n}, quindi non è stata creata una nuova versione. |
| `refused.title(n)` · `hint` | Nothing was saved. {n} values need your attention. · Correct them and save again. Select one to go to it. | Non è stato salvato nulla. {n} valori richiedono la tua attenzione. · Correggili e salva di nuovo. Scegline uno per andarci. |
| `problem.required(v)` · `tooLong(limit, n)` · `tooManyLines(n)` · `lineBreak` · `controlChar` · `ibanFormat` · `ibanCheck` | Enter the {v}. · Too long: at most {limit} characters, you have {n}. · Too many lines: at most 4, you have {n}. · Use one line: remove the line break. · Remove the special character (a tab or control character). · An IBAN starts with two letters and two digits, then letters and digits only. · The check digits do not match. Check it for a typing mistake. | Inserisci {v}. · Troppo lungo: al massimo {limit} caratteri, ne hai {n}. · Troppe righe: al massimo 4, ne hai {n}. · Usa una sola riga: togli l'a capo. · Togli il carattere speciale (una tabulazione o un carattere di controllo). · Un IBAN inizia con due lettere e due cifre, poi solo lettere e cifre. · Le cifre di controllo non corrispondono. Controlla di non aver sbagliato a digitare. |
| `problem.line(lang, k, text)` | Line {k} of the {lang} address: {text} | Riga {k} dell'indirizzo {lang}: {text} |
| `conflict.title` · `body(who, when, values)` · `reapply` · `discard` | A newer version was saved · {who} saved version {n} on {when} (changed: {values}) while you were editing. Your changes are still in this form but were not saved. · Reapply my changes to version {n} · Discard my changes and load version {n} | È stata salvata una versione più recente · {who} ha salvato la versione {n} il {when} (cambiato: {values}) mentre modificavi. Le tue modifiche sono ancora in questo modulo ma non sono state salvate. · Riapplica le mie modifiche alla versione {n} · Scarta le mie modifiche e carica la versione {n} |
| `conflict.applied(n, flagged)` · `alsoChanged(who, theirs)` · `useTheirs` · `takenFromTheirs` | Your changes were applied to version {n}. {flagged} to review, then save as version {m}. · Also changed in version {n} by {who}: “{theirs}”. Yours is kept. · Use theirs · Taken from version {n} (you had not changed it). | Le tue modifiche sono state applicate alla versione {n}. {flagged} da controllare, poi salva come versione {m}. · Cambiato anche nella versione {n} da {who}: «{theirs}». Il tuo valore è mantenuto. · Usa il suo · Preso dalla versione {n} (non l'avevi cambiato). |
| `lost.title(entity)` · `body` | You can no longer change {entity} · Your changes were not saved. The details are now read-only. | Non puoi più modificare {entity} · Le tue modifiche non sono state salvate. I dati sono ora in sola lettura. |
| `saveFailed.title` · `body` | The details could not be saved · Nothing changed. Your changes are still here. Try again. | Non è stato possibile salvare i dati · Nulla è cambiato. Le tue modifiche sono ancora qui. Riprova. |
| `leave.title` · `body(entity)` · `keep` · `discard` | Leave without saving? · Your changes to {entity} have not been saved and will be lost. · Keep editing · Discard changes | Uscire senza salvare? · Le tue modifiche a {entity} non sono state salvate e andranno perse. · Continua a modificare · Scarta le modifiche |
| `readOnly.note(entity)` | You can read these details but not change them. An administrator grants who may change {entity}. | Puoi leggere questi dati ma non modificarli. Un amministratore stabilisce chi può modificare {entity}. |
| `incomplete.title` · `body(list, entity)` · `toCorrect.title` | These details are incomplete · Missing: {list}. Offers and contracts for {entity} are refused until they are filled in and saved. | Questi dati sono incompleti · Mancano: {list}. Le offerte e i contratti di {entity} sono rifiutati finché non sono compilati e salvati. |
| `history.caption(entity)` · `version` · `savedBy` · `savedAt` · `changed` · `actions` | Versions of {entity} · Version · Saved by · Saved on · What changed · Actions | Versioni di {entity} · Versione · Salvata da · Salvata il · Cosa è cambiato · Azioni |
| `history.current` · `restoredFrom(m)` · `sameAs(m)` · `system` · `moved` · `open(n)` · `restore(n)` · `empty` | Current · Restored from version {m} · Same details as version {m} · System · Moved from the CRM · Open version {n} · Restore version {n} · No versions yet | Corrente · Ripristinata dalla versione {m} · Stessi dati della versione {m} · Sistema · Portata dal CRM · Apri la versione {n} · Ripristina la versione {n} · Nessuna versione |
| `version.title(n)` · `body(who, when, current)` · `back` · `restore` · `notCurrent` | Viewing version {n} (read-only) · Saved by {who} on {when}. The current version is {current}. · Back to history · Restore this version · Not current | Stai guardando la versione {n} (sola lettura) · Salvata da {who} il {when}. La versione corrente è la {current}. · Torna alla cronologia · Ripristina questa versione · Non corrente |
| `version.blocked(list, entity)` · `notFound` | This version cannot be restored: {list}. Restoring it would make {entity} incomplete again. · This version does not exist. | Questa versione non può essere ripristinata: {list}. Ripristinarla renderebbe di nuovo incompleta {entity}. · Questa versione non esiste. |
| `restore.title(n)` · `body(n, next, current)` · `changes(list)` · `confirm(n)` · `busy` · `done(next, n)` | Restore version {n}? · This creates version {next} with the same details as version {n} and makes it the current one. Version {current} and the rest of the history stay as they are. · Compared with the current version, these change: {list}. · Restore version {n} · Restoring… · Version {next} created from version {n} | Ripristinare la versione {n}? · Questo crea la versione {next} con gli stessi dati della versione {n} e la rende quella corrente. La versione {current} e il resto della cronologia restano come sono. · Rispetto alla versione corrente cambiano: {list}. · Ripristina la versione {n} · Ripristino in corso… · Versione {next} creata dalla versione {n} |
| `restore.refused(n)` · `conflict` · `failed(n)` | Version {n} cannot be restored: {list}. Nothing changed. · A newer version was saved meanwhile. The history was reloaded; check it and try again. · Version {n} was not restored. Nothing changed. Try again. | La versione {n} non può essere ripristinata: {list}. Nulla è cambiato. · Nel frattempo è stata salvata una versione più recente. La cronologia è stata ricaricata; controllala e riprova. · La versione {n} non è stata ripristinata. Nulla è cambiato. Riprova. |
| `load.failed` · `sections.loading` · `sections.failed` | The legal entities could not be loaded · Loading… · The sections could not be loaded | Non è stato possibile caricare le società del gruppo · Caricamento… · Non è stato possibile caricare le sezioni |

crm-ui and letterheads-ui add their own keys the same way (`settings.legalNote`, `settings.legalNoteLink`, `settings.legalNoteAdmin`,
`offerWizard.legalEntity.*`, `preview.sourceLine`, `preview.sourceLink`, `preview.sourceAdmin`, `preview.legend`,
`preview.unavailableTitle/Body`): English as in S9–S11, Italian by the same vocabulary ("Società del gruppo"; "Apri Società del gruppo").

## Accessibility (AC-8.1, AC-8.2) — WCAG 2.1 AA

Targets for the suite's automated check: axe (A/AA) on S1 (loaded, loading, failed, not moved), S2 (clean, dirty, refused,
conflict), S3, S4, S5 (both variants, empty), S6 (restorable, blocked), S7 (three variants), S8 (four variants), S9, S10 and S11,
each in dark and light and in Italian once. Test ids use the page prefix `admin-legal-…` (building-pages § 7).

**Keyboard-only path (E2E):** Admin tool → Legal entities tab → Edit details → Tab through Legal name … Save → refused:
focus lands on the first refused control, the summary buttons are the second way in → correct → Save → "Saved" status read,
focus still on Save → History tab (arrow keys) → Open version → heading focused → Restore this version → dialog (Cancel
focused; Escape closes; Tab trapped) → Confirm → h2 focused, success status. Conflict: Reapply by keyboard, focus to the first flagged value.

Per screen:
- **S1** One h2 (PageHeader), h3 per card; Badge = glyph + words; "Read-only" is words + lock glyph, not colour; missing values have text + alert glyph; buttons carry the entity in their accessible name ("Edit details of WellD CH") because two identical buttons repeat.
- **S2/S3 form** Every control has a visible label (no placeholder-only); required = `aria-required` + `*` (aria-hidden); hints and errors are `aria-describedby`; **language of parts**: Italian controls carry `lang="it"`, English `lang="en"` (WCAG 3.1.2) and `spellcheck` follows it; IBAN input `spellCheck=false`, `autoComplete="off"`, grouped only on blur (never while typing, so the caret and a screen reader's echo do not jump); the status text is not a live region (outcomes have their own banners); Save is `aria-disabled` + hidden reason (focusable, never `disabled`); the sticky bar must not cover the focused control (scroll-margin on controls); reflow at 320 px: single column, bar wraps.
- **Refusal (hotspot)** Summary = `role="alert"` Banner, announced once; focus moves to the first refused control in page order after the summary has mounted (letterheads' order of effects: summary first, then `focusFirstInvalid`), so a screen reader hears "n values need your attention" then the control with its label and error; each summary item is a real button naming the value and the remedy; errors never carry colour alone (alert glyph + words); the same sentence in summary and field.
- **Moved incomplete (S3)** persistent notes are `live="off"` and static `aria-describedby`; opening the page does not announce an alert.
- **Conflict** assertive banner (a 409 is time-critical); after Reapply, focus to the first flagged value, polite status "n values to review"; flagged values are described by "Also changed in version n by …".
- **S5 table** caption, `scope` headers, version as row header; times in `<time>`; row buttons named per row; the table region is keyboard-scrollable (DataTable); the Current badge is text.
- **S6/S7** Version heading focused on arrival; Restore aria-disabled keeps its reason readable; dialog = `ConfirmDialog` (`alertdialog`, focus Cancel, trap, Escape, focus returns to the row's Restore button on cancel; on success focus goes to the page h2 because the row may be gone).
- **S8** `nav` landmark named "Admin sections" next to the shell's tool nav; a hidden section is absent, not disabled; `aria-current="page"` from the router `Link`; a redirect from a hidden URL changes the page without announcement (same as every admin-ui navigation today).
- **S9–S11** Notes are `live="off"` (read in place); refusals follow the Letterhead notice: danger = assertive, preview = polite; the missing look is words + ⟦ ⟧ glyphs + yellow, never yellow alone; **the preview page's text alternative must contain the same ⟦Label⟧ marks** (DR-4); the link is a real `<a>` with the destination in its name.
- Contrast: only token pairs the library already measured (`*-text` tokens for tones as text; `--soft` for secondary text, never `--muted`); the `paper-mark` pair is 11.1:1.
- Motion: none added (skeletons and spinner are the library's, already `prefers-reduced-motion` aware).

## Coverage: ACs and surfaces

| AC | Surface |
|---|---|
| AC-1.1 | S1, S2 (both entities, all values, both languages) |
| AC-1.2–1.4 | S2 refusal (F4); S3 |
| AC-1.5 | S2 "saved" status with the minute (the propagation itself is not UI) |
| AC-2.1 | S2 no-op; version numbering on the Save button |
| AC-2.2, 2.3, 2.4 | S5, S6, S7 |
| AC-2.6 | S2 conflict |
| AC-4.2, 4.3 | S4, S8, S1 |
| AC-5.4 | S11 |
| AC-6.1 | S9 |
| AC-6.3 | S10 (and S1/S3 say the same on the entity) |
| AC-7.3 | S1, S3 |
| AC-8.1, 8.2 | Accessibility, Copy keys |

**ACs with no UI surface** (nothing to design): AC-1.1 as data model, AC-2.5 (audit row; the existing Audit tab shows it), AC-2.7
(immutability), AC-3.1–3.4 (API), AC-4.1 (catalog; the role editor renders it generically), AC-5.1–5.3, AC-5.5 for documents
(letterhead service), AC-6.2 and 6.4 (documents), AC-7.1, 7.2, 7.4, 7.5 (the move; its report is the operator's, not a screen). AC-7.2's "System" attribution is shown in S5.

**UI added that no AC asks for (kept, minimal, and listed so it can be struck):** the freshness sentence after a save (AC-1.5/3.3 as
words); the leave guard (S2 state 10); the "not moved yet" state (a window of the release order); the 403-lost and could-not-save
states; the CRM 503 notice (S10); the unavailable preview notice (plan sequence "Configurator preview"); the "Compared with the
current version, these change: …" line in the restore dialog.

**Scope creep found and not designed (owner to decide):**
1. A confirmation step or an extra "you are changing the account payments go to" warning when the IBAN changes (R1 payment redirection). The restore dialog's change list and the audit/history give a trace; a stronger gate is a product decision.
2. Showing the registry's current values or its Incomplete status inside CRM Settings, or in the configurator beyond the missing look.
3. Marking in the version view which values that version changed, or a side-by-side comparison of two versions (AC-2.2 asks only for the names of changed values in the list).
4. Notifying other managers of an IBAN change (plan R1, outside this spec).

## Drift (spec/plan gaps found while designing; not designed around)

| # | Finding | Proposed amendment |
|---|---|---|
| **DR-1** | The version list (`GET /legal-entities/{entity}/versions`) carries no per-version `complete`/`invalid`, so the history table cannot show that a Restore will be refused (D4) before the person tries; only the version view (single version answer) can. AC-2.4 is still met (the 422 shows in the dialog). | Optional: add `restorable: boolean` (or `complete` + `invalidCount`) to each list item, computed by the same `rules.ts`. If not added, S5 keeps Restore on every non-current row. |
| **DR-2** | crm-ui and letterheads-ui must know whether *this person* may manage *this entity* to choose link vs sentence (AC-6.1/D5, S10, S11). The plan lists their changes but no such read; `apps ∋ admin` is not enough (a person with `admin:access` but no grant would get a link that redirects to Roles) and the browser must not evaluate the `entity` condition (plan decision 5c). | Add to the crm-ui and letterheads-ui tasks: `useCanManageLegalEntity(entity)` = `GET {auth}/legal-entities/manageable` via `shell/session` `apiFetch`, cached per session, failing closed (no link). The route already exists in the plan. |
| **DR-3** | Conflict (AC-2.6, Q3 = B) needs the current details and the newer version's author after a 409; the 409 body carries only `currentVersion`. | None needed if the page reads `GET /legal-entities/{entity}` and the versions list after the 409 (both exist). Stated so the task does not expect more in the 409. |
| **DR-4** | AC-5.4 and the plan say an empty value prints its label "in the missing look" in the preview picture, but nothing says the page's **text alternative** (`PreviewPage.text`, letterhead AC-8.6) also marks it; as drawn only, a screen-reader user cannot tell a real value from a missing one. The CRM wizard already uses ⟦Label⟧ (its design D-19). | Plan/engine: in preview mode a missing value appears in `text` as ⟦Label⟧ (same glyphs, closed label set in both languages), and the drawn mark uses `--paper-mark`. |
| **DR-5** | Plan: "new refusals replacing 409 `entity_profile_missing`". If generation no longer needs a CRM profile row, `settings.notSet` ("Offers for this entity cannot be generated until it is") and `offers.errors.profileMissing` / `offerWizard.preview.profileMissing` ("the legal name … is not set. Set it in CRM Settings") become false; the LetterheadCard/upload copy (`templates…profileMissing`, "Save the entity profile before uploading") stays true. | Plan: state whether `entity_profile_missing` survives; the design assumes the legal-name case moves wholly to `legal_entity_incomplete` and lists the three strings to change. |
| **DR-6** | AC-7.3 calls an entity with only a refused-but-present value "incomplete". Only a missing required value stops offers (AC-6.3); an out-of-limit value still prints (AC-7.5). Calling both "Incomplete" would say offers are refused when they are not. | Spec wording: "marks it incomplete or in need of correction". The design uses **Incomplete** (missing required) and **Needs correction** (only out-of-limit values), both blocking nothing but a save of a still-wrong value. |
| **DR-7** | Plan decision 5 redirects a hidden section's URL silently. A manager-only person who follows an old bookmark to `/admin/roles` lands on Legal entities with no explanation. | Optional, low: a polite info line on the first landing ("You can use Legal entities here"). Not designed. |
| **DR-8** | The audit tab description says it lists authorization changes only; it will also list `legal_entity.*` rows. | One-line copy change in `strings/audit.ts` (en + it); no screen change. |

## Open questions

- [ ] Q1 page structure (A recommended) — owner: wellD
- [ ] Q2 address entry (A recommended) — owner: wellD
- [ ] Q3 conflict handling (B recommended) — owner: wellD
- [ ] Lift the three letterheads-ui patterns into `@operai/ui` now and migrate letterheads-ui later (recommended), or build admin-ui's own (R13 coordination) — owner: planner
- [ ] DR-1 … DR-8 above — owner: architect/PO
