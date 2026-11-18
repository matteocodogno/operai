---
spec: 20261117
status: approved
approved: 2026-11-18
---

# Design: Legal entities — one registry of the group's companies, for every tool

Inputs: `spec.md` (approved, amendments D1–D6), `plan.md` (approved), and the UI as it is in this worktree:
`admin-ui`, `crm-ui` (Settings, offer wizard), `letterheads-ui` (configurator, history) and `operai-ui`.
The product is an existing one with a design system, so there is **no Visual direction section** (the system wins;
nothing new in colour, type or icons).

Mockups are visual-companion content fragments under `.forge/design/20261117-legal-entities/content/`
(git-ignored, as is the whole `.forge/design/`). They use the suite's real tokens (`operai-ui/src/styles/tokens.css`),
dark by default, light and Italian in one screen. The files ending `-v2` show the layouts after the owner's decisions Q1=B and Q2=B;
older files without `-v2` that show an overview of cards or a textarea address are superseded and kept as evidence.
They were checked for well-formed markup only; they were not opened in a browser in this run. (The built screens and both dialogs were checked in a real browser by QE T45, qe-report.md section 8.)
The amendment after the security review (T51, below) adds `legal-entity-protected-change-confirm.html` (S12), `legal-entity-restore-protected-states.html` (S7 additions, the 429 state, S5 paging) and `legal-entity-notice-copy.html` (N1); same tokens, same checks.

## Decisions

**Owner decisions, 2026-11-17** (Q1 to Q3 answered on the comparison mockups and confirmed in the terminal: "ho sempre risposto B").
The remaining items were put to the owner as the designer's recommendation and not objected to; they are recorded as
"designer's recommendation, adopted 2026-11-17, owner may revisit before implementation". The screens below are written for these choices only.

| # | Question | Decision | By |
|---|---|---|---|
| Q1 | Page structure | **B**: one Legal entities page with the entities as tabs on top (status badge on the tab label), Details \| History under them; an entity is deep-linked with `?entity=` (`compare-1-page-structure.html`) | owner, 2026-11-17 |
| Q2 | How the address is typed | **B**: four line inputs per language, "Line 1" to "Line 4" (limits visible, focus on the exact line, per-line errors) (`compare-2-address-entry.html`) | owner, 2026-11-17 |
| Q3 | What a person can do after a 409 (AC-2.6) | **B**: reapply my changes onto the newer version, values both people changed flagged with "Use theirs"; **Discard my changes and load version n** is the second button (`compare-3-conflict-handling.html`) | owner, 2026-11-17 |
| DR-1 | Restore refused only after trying | The plan gets an optional per-version `restorable` flag on the versions list (the architect amends the plan; assumed). See S5 | designer's recommendation, adopted |
| DR-2 | CRM / letterheads need "may this person manage this entity" | crm-ui and letterheads-ui use `GET /legal-entities/manageable` through `useCanManageLegalEntity` (assumed) | designer's recommendation, adopted |
| DR-3 | Conflict needs newer version's author | No API change (the page reads the entity and the versions after the 409) | designer's recommendation, adopted |
| DR-4 | Preview text alternative for a missing value | An empty value shows as ⟦Label⟧ in the preview's text alternative (assumed) | designer's recommendation, adopted |
| DR-5 | `entity_profile_missing` | **Removed.** Generation is blocked only by 409 `legal_entity_incomplete`; the three crm-ui strings `settings.notSet`, `offers.errors.profileMissing`, `offerWizard.preview.profileMissing` are removed or replaced (the architect amends the plan; assumed) | designer's recommendation, adopted |
| DR-6 | "Incomplete" vs "Needs correction" | Kept: Incomplete = a required value is missing (blocks offers); Needs correction = only out-of-limit values (blocks nothing) | designer's recommendation, adopted |
| DR-7, DR-8 | Silent redirect of a hidden section; audit description | As proposed (DR-7 not designed; DR-8 one-line copy change) | designer's recommendation, adopted |

Consequences of Q1=B and Q2=B that the design had to settle (new, reversible, listed under accepted UI and in Drift DR-9 to DR-12): per-entity drafts so that switching tabs loses nothing (no leave dialog on tab changes);
three tab levels and their keyboard model; the version view living inside the History panel; the moved 5-line address shown with one input per stored line; the mapping of API address problems to line inputs; `?entity=` links from the CRM and the configurator.

Also decided here (reversible): status labels, one-tab strip for a manager, fixed tab order, the freshness sentence after a save.
(The earlier decision "no confirmation step on an IBAN change" is **withdrawn**: US-9 asks for one, S12, and for a notice, N1.)

**Amendment 2026-11-17 after the security review (task T51).** Scope is the owner-approved US-9 (AC-9.1–9.17), the plan's amendment G1–G16 and the follow-ups FU-1, FU-4, FU-7, FU-9; readings confirmed by the owner: push text English only, a 422 refusal comes before the confirmation, notice time in Europe/Zurich. Choices left to the designer, all reversible and recorded here so the owner can strike one:

| # | Decision | Why |
|---|---|---|
| DA-1 | S12 is a `ConfirmDialog tone="primary"` with **no acknowledge checkbox**, Cancel focused | the action is the one intended, red would suggest data loss; a field would take the initial focus off Cancel (AC-9.1) |
| DA-2 | The dialog shows what the **check** answered, never what was typed | AC-9.1 "as they would be stored"; the normalisation stays in auth only (plan decision 10) |
| DA-3 | Fail closed: if the check cannot be made, nothing is saved ("could not be checked" + Retry) | without it the page cannot know whether to ask; an unconfirmed protected change must not slip through |
| DA-4 | The empty side is **None** (capital, alone in a cell) in the dialogs; **none** (lower case, inside a sentence) in the notice | each reads as a word where it stands; both are the word for "none", never a blank |
| DA-5 | S12 and the restore dialog say that the other managers and the administrators are told | it is what AC-9.8 does; knowing it is a deterrent and an honest warning |
| DA-6 | Notice lines are whole sentences ending in a full stop; the author's account email appears only in the body, never in a title or a subject, and no display name appears anywhere in a notice | the centre may collapse line breaks; titles and subjects then hold closed values only (plan D9, J4) |
| DA-7 | The zone abbreviation (CET or CEST) comes from the offset, not from `Intl` | `Intl` prints "GMT+1" in several locales; the owner asked for the abbreviation |
| DA-8 | One footer in the email for every recipient | the template's data carries no recipient role; one sentence lists every reason |
| DA-9 | 429: warning banner with the wait in whole minutes and Retry, no countdown, Save stays available | a ticking number would be read out again and again; the server is the judge of when the wait is over |
| DA-10 | FU-4: `toCorrect.title` becomes "Some values need correcting" | S3's own wording; "these details" says the whole entity is wrong |
| DA-11 | FU-1: the overflow notice's title also loses "profile"; four bodies from two independent gates | the profile no longer holds the values; a person may open Letterheads without managing the entity, or the reverse |

The comparison mockups stay under `.forge/design/20261117-legal-entities/content/` as evidence.

## Project UI system (discovered, not assumed)

Library in use: **`@operai/ui`** (the suite's own design system, ADR 20261031, consumed as source) with token
utilities on **Tailwind v4** (`text-soft`, `bg-ink-mid`, `border-rule`, `font-mono`); no Mantine/MUI/shadcn. Rules read:
`operai-ui/docs/design-system.md`, `building-pages.md`. Conventions that bind this design: pages never render
`<main>`/h1 (the shell and `ToolLayout` do); every control in `Field`; statuses as `Badge` glyph + text; a section the
person may not open is left out of the DOM; copy only in the app's `strings` (en + it, `noHardcodedStrings` and
parity tests); no colour, border or radius from utilities on a library component; "a pattern used by two apps lives
in the library — never copy a component from another app".

## Routes (admin-ui inner router, mounted at `/admin`)

One page, one route; the entity, the view and an open version live in the query string, so every state can be linked.

| Route | Screen | Notes |
|---|---|---|
| `/legal-entities` | S1 page frame with entity tabs; S2–S5 entity panel | section tab "Legal entities" (after Users, before the end-anchored Audit) |
| `?entity=welld_it\|welld_ch` | which entity tab is selected | default: the first entity the person may change, else `welld_it`. Any other value (unknown, repeated, empty) is replaced by the default in the URL; the value is never echoed |
| `&view=details\|history` | Details or History tab of that entity | default `details`; any other value → `details` |
| `&view=history&version=<n>` | S6 version view, inside the History panel | `n` a whole number ≥ 1; anything else is dropped; a whole number with no such version → "This version does not exist" state. `version` without `view=history` is dropped |
| index `/` | redirect | to the first section the person may use (`/roles` for an administrator, `/legal-entities` for a manager-only person); a hidden section's URL redirects there too (plan decision 5) |

History handling: selecting an entity tab or a view tab **replaces** the entry (Back leaves the page, not the last tab);
opening or closing a version **pushes** one (Back returns from the version to the list). Links from other apps are plain
`<a href="/admin/legal-entities?entity=welld_ch">` (see S9, S11): they open the page on that entity's Details tab. A person
with no grant for that entity lands on the same tab read-only (S4); nothing about the grant is leaked in the URL.

## Flows

Each flow is one user goal; ids are used by the screens and tests below.

| Flow | Goal and steps | Exits | AC |
|---|---|---|---|
| **F1 Reach the page** | Signed-in person holding `legal-entity:manage` for ≥ 1 entity → sidebar shows **Admin** (derived `apps`) → admin-ui resolves its sections (skeleton tabs) → lands on the first one. A manager-only person lands on Legal entities; an administrator on Roles. A hidden section's URL redirects. | no grant: no Admin tool; admin without the grant: no Legal entities tab; `manageable` read fails: warning Banner + Retry in place of the page | AC-4.3, plan dec. 5 |
| **F2 See both entities at a glance** | Open Legal entities → the entity tab strip shows WellD IT and WellD CH with a status badge each (Complete / Incomplete / Needs correction / Not moved yet) and a Read-only mark when the person may not change that entity → the selected entity's panel header repeats them with the version line | load failed (Retry); 403 → `PermissionDenied`; entity not moved (version 0) | AC-1.1, AC-4.3, AC-7.3 |
| **F3 Change the details and save** | Select the entity tab → Details → change values (IBAN typed any way; address one line per input) → Save as version n+1 (the page first asks auth whether the save changes the legal name, VAT number or IBAN, F15) → success status "Version n+1 saved. Every tool uses it within a minute." → form reloaded from the saved answer (IBAN grouped, empty address lines closed up) | refused (F4), no-op (F5), conflict (F6), grant lost (403), too many saves (F17), network/5xx (Retry) | AC-1.1, 1.4, 1.5, 2.1, 9.5 |
| **F3b Switch while editing** | With unsaved changes, select the other entity tab, the History tab or open a version: **nothing is asked and nothing is lost**. Each entity keeps its own draft; the tab shows "Unsaved changes". Only leaving the page (section tab, a link out, Back off the page, reload/close) asks "Leave without saving?" and names the entities with unsaved changes | Keep editing / Discard changes | AC-1.1 (no data loss), design-added (see accepted UI) |
| **F4 A refused save** | Save → 422 `invalid_legal_entity` with every problem → error summary announced + focus on the first refused control (page order, down to the exact address line) → person corrects → Save again. Typed values are kept; nothing was stored | — | AC-1.2, 1.3, 1.4, 8.1 |
| **F5 A save that changes nothing** | Only blanks/case/spaces or empty address lines differ → 200 `created: false` → polite "Nothing changed. These details are already version n." and the normalised values; no new version. An untouched form never sends: Save is `aria-disabled` with its reason | — | AC-2.1 |
| **F6 Two people edit the same entity** | Save with a stale base → 409 `version_conflict` → warning Banner (who saved the newer version, when, which values) with **Reapply my changes to version n** and **Discard my changes and load version n**; Save is aria-disabled until one is chosen. Reapply merges per value (an address is one value of four lines) and flags values both changed with "Use theirs" | read of the newer version fails: Banner keeps both actions and says so; Retry | AC-2.6 |
| **F7 Read an entity I may not change** | Select its tab → same panel, values as facts, persistent info Banner saying why there are no controls, History tab still there | — | AC-4.2, 4.3 |
| **F8 See the history** | History tab → versions newest first, 50 at a time with **Show older versions** (S5): number (+ Current badge, "Restored from version m"), who ("System" for version 1), when, which values changed → Open / Restore (Restore disabled with a reason when the list says `restorable: false`) | loading, empty (version 0), failed + Retry (rows kept); older versions loading, failed + Retry | AC-2.2, 2.7, 7.2 |
| **F9 Open a version** | Open → the version view replaces the table inside the History panel (`&version=n`): heading takes focus, read-only values, banner with Back to history and (manager) Restore this version. Opening the current version goes to Details | version does not exist (404) → state with Back; failed load + Retry | AC-2.3 |
| **F10 Restore a version** | Restore (row or version view) → confirm dialog naming the new version number and the values that will change (and, when a protected detail differs, its Old / New rows, F16) → Confirm → success: back on Details of that entity, entity heading focused, status "Version n created from version m" | refused: the version fails today's rules → inline error in the dialog (422; normally prevented by the disabled Restore); conflict (409) → history reloaded behind the dialog; 403 → dialog error, that entity turns read-only | AC-2.4, 2.5, D4 |
| **F11 Fix a moved entity** | The tab shows Incomplete / Needs correction → Details → form opens with a persistent (non-announced) warning listing what is missing and what is out of limits, each value marked in place (a moved fifth address line or an over-long line on its own input) → fill/correct → Save → entity becomes Complete | save refused again (F4) | AC-7.1–7.3 |
| **F12 CRM Settings points to the page** | CRM Settings, each entity card: a note where the legal fields were; a link to `/admin/legal-entities?entity={entity}` for a person who may manage that entity, a sentence for everyone else | link target missing/permission lost: the page's own redirect | AC-6.1 (D5) |
| **F13 CRM refuses an offer** | Generate (or preview, edit/revise) for an incomplete entity → 409 `legal_entity_incomplete` → Banner naming the entity and the missing details, where to fill them (link `?entity=` for a manager, "ask an administrator" otherwise); nothing created | registry unreadable → 503 banner with Retry | AC-6.3, 5.5 |
| **F14 Preview in the configurator** | Letterheads configurator → preview shows the entity's real details in the preview language; empty values in the missing look; a source line with a `?entity=` link for a manager | registry unreadable → warning in the preview slot, every detail shown as missing, form and Save unaffected | AC-5.4 (5.5 for documents) |
| **F15 Confirm a protected change** | Save → Save busy "Checking…" while the page asks the read-only check → the answer lists the protected details this save changes (legal name, VAT number, IBAN, as stored, IBAN in groups of four) → **none** (an address or contacts change, an IBAN with other spacing or case, nothing at all): the save is sent at once, no dialog (AC-9.5, 9.17) → **some**: the S12 dialog names the entity and shows Old / New for each, Cancel focused → **Cancel, Escape or close**: nothing sent, the form stays as typed, focus back on Save (AC-9.2) → **Confirm**: the save is sent with the same body, the dialog stays busy until the answer, then the S2 outcome states apply (AC-9.3). A confirmation is never remembered: the next Save checks again | the check is refused (422 / 409 / 403 / 429): that state, no dialog (a rule refusal comes before the confirmation); the check fails (network, 5xx, 404): "could not be checked" + Retry, nothing saved; after Confirm: refused, conflict, grant lost, could not save, too many saves as in F3 | AC-9.1–9.3, 9.5, 9.6, 9.17 |
| **F16 Restore a protected change** | Restore (row or version view) → the dialog opens; if the page does not hold version n it reads it (loading) → change line, then for each protected detail that differs between the current version (Old) and version n (New) the same Old / New rows as S12, and the note that the others are told → Confirm → as F10. No protected detail differs: the dialog is as before and lists none | version n cannot be read: Confirm unavailable + reason + Retry; 429 inline; the F10 refusals unchanged | AC-9.4, 9.6, 9.17 |
| **F17 Too many saves** | A save, its check, or a restore answers 429 `too_many_requests` (plan G9; `Retry-After`) → warning banner in the form (S2 state 14) or inline error in the restore dialog naming the wait in whole minutes, values kept, nothing stored → the person waits, then presses Save (or Retry) again | no `Retry-After`: "a few minutes" | security review F3, plan G9 (no AC) |
| **F18 Read a change notice** | A protected change was stored → each recipient is told: in the notification centre in their language (English or Italian), by push in English if they enabled push, by email in English; the outside mailbox gets the email only → the text names the entity, who, save or restore (of which version), when (Europe/Zurich), the new version, the protected details by name, the IBAN's last 4 (old, new), the other names → the link opens `/admin/legal-entities?entity={e}&view=history` (sign-in as for any link) → the History tab: Open / Restore | a person who may not see the history is refused as usual; an administrator without the grant has no section and is redirected (DR-14) | AC-9.11–9.13 |

Language (AC-8.2) is not a flow: every string below exists in en and it and follows the shell's language.

## Screens & states

Notation: **S** = screen, state lists are exhaustive for the screen. Mockups are referenced with `> mockup:`; the `-v2` files are
the current layouts (Q1=B, Q2=B). The earlier overview-card mockups (`legal-entities-overview-*`,
`light-theme-italian-overview-refused-history`, `legal-entity-form-editing`, `-refused`, `-incomplete-moved`, `-readonly`,
`-history`, `-version-view`, `-conflict`) show the superseded option A layout and stay only as evidence; the compare-* files are the decision evidence.

### S1 Page frame and entity tabs — `/legal-entities` (F1, F2, F3b, F11)

Purpose: the one page for both entities; the tab strip is the glance. There is no overview screen of cards.
Key elements, top to bottom: the shell's tool title and the section `TabNav` (S8) → `PageHeader` (h2 "Legal entities" + one-line
description) → **entity `Tabs`** (tablist "Legal entities", two tabs in the fixed order WellD IT, WellD CH; label = entity name as in
`strings.common.entities` + status `Badge` + a "Read-only" `Badge` with a lock glyph when the person may not change it + an "Unsaved changes"
`Badge` while that entity has a draft) → the selected entity's panel (S2–S6). The strip wraps onto a second row at narrow widths and never scrolls sideways.

Status badge (one place, `legalEntityStatus()`, shown on the tab and in the panel header; the banner lines are in S3/S4):

| Registry says | Badge | Extra lines (in the panel, S3/S4) |
|---|---|---|
| `version ≥ 1`, `complete`, no `invalid` | **Complete** (success, check-circle) | — |
| `complete: false` | **Incomplete** (warning, alert) | "Missing: …" + "Offers and contracts for this entity are refused until they are filled in." (AC-6.3); and "To correct before the next save: …" when `invalid` is also non-empty |
| `complete: true`, `invalid` non-empty | **Needs correction** (warning, alert) | "To correct before the next save: …" (these still print as moved, AC-7.5) |
| `version: 0` | **Not moved yet** (muted, clock) | one sentence in the Details panel; no form; History shows its empty state |

Wording note: AC-7.3 says the page marks such an entity "incomplete"; the design separates "missing a required value" from "holds a value
today's rules refuse" because only the first stops offers (DR-6, kept by the owner).

Drafts: the page host keeps one unsaved draft per entity in memory (not in storage), so switching entity, view or opening a version never
loses typing; a draft is dropped on a successful save, on Discard, or when its entity turns read-only (403). The default selected entity is
the first one the person may change, else WellD IT.

States: loaded · loading (hidden live "Loading the legal entities…" + skeleton tabs and body) · load failed (warning Banner + Retry; no tabs) ·
entity not moved (per tab) · 403 (existing `PermissionDenied`, focus on its heading).
> mockup: `.forge/design/20261117-legal-entities/content/legal-entities-page-v2.html`
> mockup: `.forge/design/20261117-legal-entities/content/legal-entities-tabstrip-states-v2.html` (strip variants, 320 px wrap, unsaved mark)
> mockup: `.forge/design/20261117-legal-entities/content/compare-1-page-structure.html` (decision evidence: Q1=B)
> mockup: `.forge/design/20261117-legal-entities/content/light-theme-italian-v2.html` (light + Italian)

### S2 Entity panel — Details, a changeable entity (F3–F6)

Purpose: change the details of one entity.
Frame (inside the selected tab's panel): entity header (h3 = entity name, status Badge, description "Version n · saved by X · date") → view `Tabs`
**Details | History** (tablist "Views of {entity}") → body.
Body (form, one `Card` per group with an h4, every control in `Field`, label above, hint and error below):
- **Company** — Legal name (required), VAT number (required), IBAN (optional, `font-mono`; hint: spaces and lower case are fine, it is saved without spaces and shown in groups of four).
- **Address** — Italian and English side by side from `md` (stacked below). Each language is a `fieldset` whose legend is "Address (Italian)" / "Address (English)" (marked required) and holds **four single-line inputs labelled "Line 1" to "Line 4"** (Q2=B), each carrying `lang`.
  - **Required:** Line 1 of each language only (`aria-required`, `*`). Lines 2–4 are optional.
  - **Limits visible:** a shared hint "Up to 4 lines of 120 characters. An empty line is left out and the lines after it move up. Line 1 is required in both languages." and, beside each label, a small "n / 120" count (display only: it counts and never blocks or colours until a refusal or a moved over-limit value marks the line). `maxlength` is not set; the server refuses (plan decision 10).
  - **Blank-line rule:** an empty or blanks-only line is left out when saved and later lines move up (plan: "trimmed, blank lines removed"). The client sends the line values in input order, blanks included; after Save the form reloads from the answer, so the lines close up. A difference that is only empty lines or spaces is "nothing changed" (F5). Typing in Line 3 only is therefore accepted and saved as the first line; the hint says so, it is not an error.
  - **A moved address with more than 4 lines (D3), explicitly:** the form shows **one input per stored line** (`max(4, number of stored lines)`), so a moved 5-line address appears as Lines 1–5. Line 5 and beyond are marked invalid in place ("Too many lines: at most 4. Join it to a line above or remove it. (Kept as moved from the CRM.)"), values are shown exactly as moved, and the page never joins, truncates or reflows lines by itself. There is no "add a line" control; the extra inputs disappear after a save that leaves 4 or fewer lines. A moved line over 120 shows its real count and its own error on its own input.
  - **Wording for a moved value (FU-7, amendment).** The shared hint gains `address.movedHint(n)` when more than 4 lines are stored (also in every line's `aria-describedby`). The static in-place marker of **every** reason on a value that is still as moved ends "(Kept as moved from the CRM.)" (`problem.moved`), not only `too_many_lines`; once the person edits the value the marker goes and a refusal after Save uses the plain sentence. A required value that is missing says "Not filled in. Enter the {value}." (`problem.notFilled`). `AddressLinesField` takes a **note** slot (the conflict's "Also changed in version n by …" or the moved hint) shown under the shared hint and listed in every line's `aria-describedby`, so the focused line reads it.
- **Contacts line** — Italian and English single-line inputs, optional, hint with an example, limit 200.
- **Save bar** (sticky, the letterheads `SaveBar` pattern): status text with icon ("Unsaved changes. Every tool uses a saved version within a minute." / "No changes"), **Save as version n+1**. Save is `aria-disabled` (not `disabled`) while there is nothing to save, a conflict is open or a save runs; its reason is a hidden description. A press on Save first runs the **check** (S12), so "a save runs" includes it, and the button reads "Checking…" meanwhile. The bar belongs to the selected entity; the other entity's draft is untouched.
- The browser validates nothing (auth owns the rules, plan decision 10); the only client work is trimming for the dirty check, counting for the line counter, and, on blur, grouping the IBAN cosmetically (never while typing).

States (all in one panel, mutually exclusive on the banner slot above the form):
1. **clean** (loaded, nothing typed; Save aria-disabled, "No changes");
2. **dirty** (Save available; the tab shows "Unsaved changes");
3. **saving** (`busy`, "Saving…", ignores clicks, controls not disabled so focus is not lost);
4. **saved** — compact success Banner (polite, auto-dismiss 3 s) "Version n saved. Every tool uses it within a minute."; focus stays on Save;
5. **no-op** — polite info "Nothing changed. These details are already version n, so no new version was made."; fields re-rendered normalised;
6. **refused** — error summary (below) + focus on the first refused control;
7. **conflict** — warning Banner with the two actions (Reapply, Discard);
8. **grant lost (403)** — danger Banner "You can no longer change {entity}. Your changes were not saved. The details are now read-only." and the panel becomes S4 (draft dropped);
9. **could not save (network/5xx/503)** — warning Banner + Retry, values and base version kept;
10. **leaving the page with changes** — `ConfirmDialog tone="danger"` "Leave without saving?" (Cancel = "Keep editing", focused first), body names the entities with unsaved changes. Triggers: section tab or any link out of the page, Back/Forward off the page, a router blocker and `beforeunload`. **Never** triggered by entity tabs, view tabs or opening a version.
11. **checking** (amendment, S12) — Save busy ("Checking…", `aria-busy`), the bar says the same; controls stay enabled so focus is not lost; no dialog yet. Ends in state 12, in a normal save (state 3), or in the state the refusal names;
12. **confirming** (S12) — the confirmation dialog is open over the form; nothing is sent. Cancel, Escape and close return to state 2 with focus on Save;
13. **could not check** — warning Banner "The changes could not be checked" + Retry; nothing saved, values and base version kept;
14. **too many saves (429)** — warning Banner `saveFailed.tooManyTitle` with the wait in whole minutes and Retry; from a save or from its check; values kept; Save stays available (an early press gets a new 429 and a new wait).

The **error summary** is the letterheads `ErrorSummary` (lifted into `@operai/ui`, see inventory): assertive `danger`
Banner, title "Nothing was saved. n values need your attention.", hint, then one button per problem in page order
("{Value}: {what to do}") that moves focus to its control. Each refused control is `aria-invalid` and described by
its own error (`Field error`); the sentence is the same in both places. Problem → sentence (by `reason`, never by the
server's wording): `required` "Enter the {value}." · `too_long` "Too long: at most {limit} characters, you have {n}." ·
`too_many_lines` "Too many lines: at most 4, you have {n}." · `line_break` "Use one line: remove the line break." ·
`control_character` "Remove the special character (a tab or control character)." · `iban_format` "An IBAN starts with
two letters and two digits, then letters and digits only." · `iban_check_digits` "The check digits do not match.
Check it for a typing mistake."

**Address problems → an input** (`addressProblemTarget()`, pure, tested):

| API problem | Lands on | Summary sentence |
|---|---|---|
| `field: "address.it" \| "address.en"`, `line: k`, reason `too_long`, `line_break`, `control_character` | the input at position k (0-based, DR-9) of that language: "Line k+1" | "Line {k+1} of the {Italian\|English} address: {sentence}" |
| `required` (no `line`) | Line 1 of that language | "Line 1 of the {language} address: Enter the address." |
| `too_many_lines` (no `line`; only reachable from a moved address with more than 4 lines, since the form has four inputs otherwise) | the first input beyond the fourth ("Line 5") | "Line 5 of the {language} address: Too many lines: at most 4, you have {n}." |
| any other address reason without a `line` | Line 1 of that language | as above, with the reason's sentence |

Several problems on one language each get their own input and error; two problems on the same line show both sentences under it (errors are a list in the `Field`).
Focus after a refusal goes to the first refused control in page order: Company, then the Italian lines in order, then the English lines, then Contacts.

> mockup: `.forge/design/20261117-legal-entities/content/legal-entities-page-v2.html` (editing, 4 line inputs per language)
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-form-refused-v2.html` (per-line errors, summary naming lines)
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-form-conflict-v2.html` (conflict, after Reapply, flagged address)
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-form-outcomes.html` (saved, no-op, 403, could not save; its leave dialog now applies only to leaving the page)
> mockup: `.forge/design/20261117-legal-entities/content/compare-2-address-entry.html` (decision evidence: Q2=B)
> mockup: `.forge/design/20261117-legal-entities/content/compare-3-conflict-handling.html` (decision evidence: Q3=B)

**Conflict behaviour.** The 409 carries only `currentVersion`; the page then reads the current details
(`GET /legal-entities/{entity}`) and the history (for who/when/which values) and shows the banner. **Reapply** merges per
value over the seven values (legal name, address IT, address EN, VAT, IBAN, contacts IT, contacts EN; an address is **one value of up to four lines**, never merged line by line) using three
values: what the person loaded (base), what they typed, what version n holds: only I changed → mine; only they changed →
theirs; both changed → mine, flagged with their value and a "Use theirs" link (for an address it replaces all of that language's lines); neither → same. The base becomes n, Save is
enabled again. Focus goes to the first flagged value (its fieldset legend or control), or to Save when none; the polite status says how many values were
flagged (`conflict.applied` with the count phrase `conflict.flagged`, or `conflict.appliedClean` when nothing is flagged). When the newer version's changed values cannot be named, the banner uses `conflict.bodyNoList` instead of an empty "(changed: )". **Discard** replaces the form with version n (confirm-less, because the banner already says what is lost). The conflict is per entity: the other entity's draft is unaffected.

### S3 Entity panel — Details, an entity moved incomplete or out of limits (F11)

Same panel as S2, opened on a record version 1 imported. Differences: a persistent warning Banner (`live="off"`, not
announced on load) "These details are incomplete" (or "Some values need correcting") listing the missing and the
refused values in words and saying what it means for offers (AC-6.3); each affected control is `aria-invalid` with a
static, described-by sentence ("Not filled in. Enter the VAT number." / "The check digits do not match. … (Kept as moved
from the CRM.)"); a moved address of more than 4 lines or a moved line over 120 is marked on its own line input (S2, D3); values shown exactly as moved (D3, never repaired silently); Save aria-disabled until something changes,
then the normal refusal flow (S2 state 6) applies to anything still wrong. Version line says "moved from the CRM by the system". The tab strip carries the same
Incomplete / Needs correction badge, so the problem is visible from the other entity's tab too. The banner's title is "These details are incomplete" when a required value is missing and **"Some values need correcting"** when only out-of-limit values remain (FU-4: this settles `toCorrect.title`; the implementation's "These details need correction" is replaced, see Copy keys added by the amendment).
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-form-incomplete-moved-v2.html` (Incomplete IT with a 5-line address; Line 5 invalid)

### S4 Entity panel — Details, read-only (F7)

Same frame (entity header, view tabs); no form, no bar. A persistent info Banner (`live="off"`) "You can read these details but not change them. An
administrator grants who may change {entity}." replaces disabled controls (nothing is a disabled input). Values in
`FactList`s inside the same three cards (an address prints one line per row); required-but-empty values say "Not filled in" with an alert glyph, optional empty
ones "Empty". An incomplete/needs-correction Banner is shown as in S3 with the wording "until someone who may change them
fills them in". History tab present. Also the state of a changeable panel after a 403 (S2 state 8) and of a not-moved entity
(no form; the S1 sentence). Heading, badges and tabs identical to S2; the tab carries the Read-only mark.
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-readonly-v2.html`

### S5 History tab (F8)

`VersionTable` (lifted, built on `DataTable`), caption "Versions of {entity}": columns **Version** (row header; Current
badge on the highest; "Restored from version m" under a restored one), **Saved by** (the person's name as stored at the
save; **System** for the move), **Saved on** (`<time dateTime>`), **What changed** (value names in words from
`changedFields`; for a restore "Same details as version m" + beneath "Changed: …"; for version 1 "Moved from the CRM"),
**Actions** (**Open** on every row, **Restore** on every row but the current, only when the person may change this
entity; **Restore** is `aria-disabled`, focusable and described by "This version cannot be restored: it is missing a required value or holds one today's rules refuse. Open it to see which." when the list item says `restorable: false`, DR-1). A read-only entity's history is readable (the API allows any covered entity) and shows Open only. Row buttons
carry row-specific names ("Open version 3", "Restore version 3").
States: loaded (manager) · loaded (manager, with a non-restorable row) · loaded (read-only) · more available / loading more / loaded / more failed (below) · loading (hidden live "Loading the history…" + skeleton rows) · empty
(`StatePanel` "No versions yet", version 0) · failed (warning Banner + Retry; previous rows stay).
**Paging (amendment; plan G5 and G11, security review F3).** The table shows the newest 50 versions. While the answer carries `nextBefore`, a sentence ("Showing the 50 newest versions.") and the secondary `Button` **Show older versions** follow the table (the button is described by the sentence). Pressing it appends the next 50 to the same table; nothing already shown is replaced. States of the paging area:
- **more available**: sentence + button;
- **loading more**: the button is `aria-disabled`, busy and reads "Loading older versions…"; it keeps the focus; the rows stay;
- **loaded**: a polite hidden status ("50 older versions loaded."); **focus moves to the Open button of the first new row**; the sentence shows the new count while more remain; on the last page the button is removed and the sentence becomes "Showing all 130 versions.";
- **more failed**: the rows stay; a warning Banner "Older versions could not be loaded. The versions above are still shown." with **Retry** replaces the button, and focus moves to Retry (the button that had it is gone); a success continues as **loaded**;
- **one page** (50 versions or fewer): no sentence and no button, as before.

The loaded pages are kept while the History panel is mounted, so opening a version (S6) and coming back finds the same rows and Back returns focus to that row's Open; when that row is not loaded (a link straight to `&version=n` for an old version) focus goes to the table region. Open and Restore work on appended rows; a successful restore reloads from the first page. **Current** is on the first row of the first page. AC-2.2's "every version" is the union of the pages.
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-history-version-v2.html` (History tab, first block)
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-restore-protected-states.html` (paging: first page, loading more, failed, after the last page)

### S6 Version view — inside the History panel, `&view=history&version=n` (F9, F10)

The version view replaces the table inside the History panel (the letterheads `HistoryPanel` shape); the entity tabs, the entity header and any drafts stay in place.
`VersionBanner` (lifted; info, `live="off"`; its h4 "Viewing version n (read-only)" takes focus on arrival; saved by/when; "The current version
is m."; a "Not current" badge) with **Back to history** and, for a person who may change the entity, **Restore this version** (primary) → the
same three cards as S4 (values only; no input, no Save). Opening the current version goes to Details. Back to history clears `version` and returns focus to that row's **Open** button.
States: restorable · **restore blocked** (consistent with the history row's `restorable: false`; here the version's own answer says `complete: false` or `invalid` non-empty: Restore
is `aria-disabled`, focusable, described by "This version cannot be restored: {missing and invalid values}. Restoring it would
make {entity} incomplete again." — D4) · loading · version not found (404 `version_not_found`: `StatePanel` + Back) · failed (Banner + Retry).
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-history-version-v2.html` (second block)

### S7 Restore dialog (F10)

`ConfirmDialog tone="primary"`, title "Restore version n?", body "This creates version m+1 with the same details as version n
and makes it the current one. Version m and the rest of the history stay as they are." and a second line "Compared with the
current version, these change: {values}." (so a payment-detail change is visible before it is made; computed from the two
versions the page holds). Confirm "Restore version n"; busy "Restoring…" (not dismissible). States: confirm · busy ·
**refused** (422, now only a race since the history already disables a non-restorable row: inline assertive error "Version n cannot be restored" naming what is missing/invalid; the dialog stays
open; Cancel is the way out) · **conflict** (409: inline "A newer version was saved meanwhile…", history reloaded behind it,
the next Confirm uses the new base) · **forbidden/failed** (403 → "You can no longer change {entity}", page turns S4; 5xx
→ "Version n was not restored. Nothing changed. Try again."). On success: dialog closes, that entity's Details tab, the entity heading (h3) focused, compact success
"Version m+1 created from version n".
**Additions after the security review (AC-9.4, AC-9.6).** Below the change line the dialog gains, **only when a protected detail differs** between the current version (Old) and the version being restored (New), a block: `restore.protectedIntro(entity)` (what it is, and that the others are told), a one-line legend `restore.protectedLegend(current, n)`, and the same `ProtectedChangeList` as S12 (detail name, Old, New; empty = None; legal name and VAT number in full; IBAN in groups of four). When no protected detail differs the dialog is exactly as before and lists none. The change line and the block both come from the full details of the two versions (`ibanPrint` for the IBAN), so they appear together. New states:
- **loading the details**: the page does not hold version n (a restore from a row): a skeleton under the body, a hidden live "Loading the details of version n…", Confirm `aria-disabled` and described by that sentence (the library's opt-in `confirmDisabledReason`, T73: Confirm stays a focus stop, a press does nothing, the reason is its hidden description); Cancel, Escape and × work (this is not `busy`);
- **details could not be read**: an inline warning Banner `restore.detailsFailed(n)` with **Retry**; Confirm stays `aria-disabled` through `confirmDisabledReason`, described by the same sentence (fail closed: without both versions the page cannot tell whether a protected detail changes);
- **too many changes (429)**: an inline warning `restore.tooMany(minutes)`; Confirm stays available.

Keys and focus as before: Cancel first, Escape cancels, focus returns to the opening control; the protected block is inside the dialog's described content, so it is announced when the dialog opens.
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-restore-dialog.html`
> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-restore-protected-states.html` (protected block, loading, details failed, 429, and the form's 429 banner)

### S8 Admin navigation by capability (F1)

The shell is unchanged: its sidebar shows **Admin** from the derived `apps`. Inside admin-ui `SectionNav` (`TabNav`,
`aria-label` "Admin sections") lists what the person may use: Roles, Departments, Users when they hold `admin:access`
(`usePermissions().permissions`); **Legal entities** when `GET /legal-entities/manageable` is non-empty; Audit pinned to the
end for `admin:access`. This is **level 1 of three tab levels** on the Legal entities page (section links; then the entity tabs of S1; then the Details | History tabs of S2). A manager-only person sees one section tab (kept so the tool looks and navigates the same for everyone and the
`nav` landmark stays) and, below it, the entity tabs: they see both entities, the one they may change editable and the other read-only. The index redirects to it. Because a manager-only person has no `admin:access`, the index waits for
`manageable` before redirecting: skeleton tabs + hidden live "Loading…". States: manager-only · administrator with the grant ·
administrator without it (no tab) · resolving · `manageable` failed (warning Banner + Retry in the page slot; no redirect to
a page that would 403).
> mockup: `.forge/design/20261117-legal-entities/content/admin-nav-by-capability.html` (section level; the page below it is `legal-entities-page-v2.html`)

### S9 CRM Settings — entity card (F12)

`EntityProfileForm` loses Legal name, Address, VAT number and IBAN (and their limits/strings); it keeps place of issue and the
two standard-terms fields. A compact info `Banner` (`live="off"`) opens each entity card: "Legal name, address, VAT number and IBAN
are kept in Legal entities, not here." with an **Open Legal entities** link-button (external icon) when `GET /legal-entities/manageable`
lists that entity (a plain `<a href="/admin/legal-entities?entity={entity}">`, as `LetterheadNotice` does for Letterheads; it opens the page on that entity's tab); otherwise the
sentence "…are kept on the Legal entities page (Admin). An administrator keeps them." and no link (D5). `SettingsPage`
descriptions say "issuer details" already; the "Not set up yet. Offers … cannot be generated until it is." line (`settings.notSet`)
is **removed** (DR-5: `entity_profile_missing` no longer exists, so a missing profile row no longer blocks offers; only an incomplete legal entity does, and that is what the note above explains). States: manager link · note only · (the form's own states unchanged).
> mockup: `.forge/design/20261117-legal-entities/content/crm-settings-legal-entity-note.html`

### S10 CRM refusal notices (F13)

New `LegalEntityNotice` beside `LetterheadNotice`, same rules. 409 `legal_entity_incomplete` (+ `entity`, `missing[]`):
- **generate / edit / revise**: `danger` Banner (assertive), title "The legal details of {entity} are incomplete", body "No offer was created. Missing: {values in words}. Fill them in on the Legal entities page, then try again." + **Open Legal entities** (a link to `/admin/legal-entities?entity={entity}`) only for a person who may manage that entity; else "Ask an administrator who keeps the Legal entities page to fill them in.";
- **preview pane** (both preview routes, try-preview): the same words as a compact polite `warning` Banner, without "No offer was created";
- 503 `legal_entities_unavailable`: `danger` Banner "The legal details could not be read" + "No offer was created: no offer number was used and the draft is unchanged. Try again in a moment." + Retry (same shape as the existing `layoutUnavailable`). Designed because it is the CRM-visible consequence of AC-5.5; no AC names its wording.
`missing[]` values map to words (`legalName` "Legal name", `address.it` "Address (Italian)", `address.en` "Address (English)", `vatNumber` "VAT number"); an unknown value is shown as received. Strings removed or replaced (DR-5): `settings.notSet` (removed with S9), `offers.errors.profileMissing` and `offerWizard.preview.profileMissing` (both said the legal name is set in CRM Settings, now false; replaced by this notice). `offerFailure()` drops `entity_profile_missing` and gains `legal_entity_incomplete` and `legal_entities_unavailable`. The Letterhead card and upload copy that mentions saving the entity profile stays (it is about the profile row, still true).
> mockup: `.forge/design/20261117-legal-entities/content/crm-offer-refused-legal-entity-incomplete.html`

### S10b CRM letterhead overflow notice (FU-1; AC-6.3 surroundings, AC-8.2)

`LetterheadNotice problem="overflow"` (409 `letterhead_overflow`) still says a value is too long for the header or the footer, but its title called it a *profile* value and its body sent the person to CRM Settings. Every value the letterhead prints now lives in Legal entities, so: the title becomes "A legal detail of {entity} does not fit the letterhead's {frame}", and the body and actions follow **two independent gates**, `useCanManageLegalEntity(entity)` and the existing `useCanOpenLetterheads()`:

| May manage the entity | May open Letterheads | Body | Actions |
|---|---|---|---|
| yes | yes | `body` | **Open Legal entities** then **Open Letterheads** |
| yes | no | `bodyValueOnly` | **Open Legal entities** |
| no | yes | `bodyLetterheadOnly` | **Open Letterheads** |
| no | no | `bodyAskAdmin` | none |

The first action is a plain `<a href="/admin/legal-entities?entity={entity}">` link-button (accessible name `legalEntity.openNamed(entity)`), the second the existing Letterheads link. It stays a polite warning Banner in the pane and under Generate, never a dialog. Words in Copy keys added by the amendment (FU-1).


### S11 Letterheads configurator preview (F14)

`PreviewPane`'s sentence "Sample document with sample company data. Nothing here is read from the CRM or any other tool." (now
false) becomes: "The company details (name, address, VAT number, IBAN, contacts) are the real ones from Legal entities, in the
preview language. The body of the page is sample text." followed, for a person who may manage that entity, by a link "Edit them in
Legal entities" (to `/admin/legal-entities?entity={entity}`), otherwise "An administrator keeps them in Legal entities." Under it a one-line **legend** of the missing style:
the ⟦Label⟧ mark on the existing `paper-mark` yellow and "A detail that is not filled in yet." The pages stay the service's picture
inside `PagePreview`; an empty value prints its label in the missing look and its conditional segment is kept (AC-5.4, engine's job).
States: complete entity · entity with empty values (missing look) · registry unreadable (`issuerDetails: "unavailable"`: warning
Banner + "Try again" in the `PagePreview` slot, every detail shown as missing; form and Save unaffected) · the existing loading/failed/refused states, unchanged.
Not designed (scope creep, see below): a notice that an incomplete entity makes the CRM refuse offers.
The sample document's own first paragraph (letterhead-api engine, it and en) said the company's data were placeholders marked (SAMPLE), which the preview made false (FU-9). It now says the company's details in it are the real ones, that a detail not filled in yet is marked, and that the rest is sample text; words in Copy keys added by the amendment (FU-9). Real documents are unaffected.
> mockup: `.forge/design/20261117-legal-entities/content/letterheads-preview-real-details.html`

### S12 Protected-change confirmation, on Save (F15; AC-9.1–9.3, 9.5, 9.6, 9.17)

Purpose: before anything is stored, show the person exactly which of the three **protected details** (legal name, VAT number, IBAN) their save changes, old next to new, so a wrong paste or an unauthorised change is stopped while it can still be cancelled. The address, the contacts line and an IBAN typed with other spacing or case never ask (AC-9.5).

**How it runs (plan G1.7, G7).** Save → the page sends the form's `{ baseVersion, details }` to the read-only **check** (`POST …/versions/check`; same rules, same authorisation, writes nothing) → the answer's `protectedChanges[]` (`field`, `before`, `after`, as they would be stored; the IBAN in groups of four; `""` = empty) decides:

| Check answers | The page does | AC |
|---|---|---|
| `protectedChanges` empty (an address or contacts change, IBAN spacing or case only, or `outcome: "same"`) | sends the save at once, as before; no dialog | 9.5, 9.17 |
| one to three entries | opens the dialog below; sends nothing yet | 9.1 |
| 422 `invalid_legal_entity` | the refusal state (S2 state 6, summary + focus). **A rule refusal comes before the confirmation**: the dialog is only for a change that could be stored (owner reading R-b) | 9.3 |
| 409 `version_conflict` / 403 / 429 | the conflict, lost-grant and too-many-saves states of S2 (no dialog) | 9.3, 9.17 |
| network, 5xx, 404 (services updated one after the other) | S2 state 13 "could not be checked" + Retry; nothing saved (fail closed: without the check the page cannot know whether to ask) | — |

**The dialog** is the library's `ConfirmDialog` (`alertdialog`), **mounted beside the form, never inside it**: `ConfirmDialog` renders its own `<form>` and does not portal, so inside the page's `<form>` the forms nest and Confirm submits the browser's way (defect D3, ADR 20261118; a unit test asserts no nested `<form>`). It is **`tone="primary"`**: the action is the one the person meant to take, so a red button would only suggest data loss; the safeguard is the content and the focus, not the colour. **No acknowledge checkbox**: with a field in the dialog the library does not put the focus on Cancel, and AC-9.1 requires it there. Content, top to bottom:

1. Title `protected.title(entity)`: "Save these changes to WellD CH?" (names the entity).
2. `protected.intro`: what these details are and that a saved version is used within a minute; "check the new values".
3. The **list** (`ProtectedChangeList`, one `<li>` per changing detail, in the closed order legal name, VAT number, IBAN, and only those that change; its label `protected.listLabel` is an `sr-only` paragraph above the list, not an `aria-label` on it: an `aria-label` replaces the items in the dialog's computed description, and the description must hold each Old and New value, D3): the detail's name (`value.legalName`, `value.vat`, `value.iban`), then a `<dl>` with the visible labels **Old** and **New** (words, never colour or strike-through alone) and the value beside each. Old = the version the person is editing from; New = what would be stored. Legal name and VAT number in full (long values wrap, never truncate); the IBAN in **groups of four** in `font-mono` (CH93 0076 2011 6238 5295 7), wrapping between groups; an empty side is the word **None** (`protected.none`), never blank. The values are not prose: no `lang`.
4. `protected.told(entity)`: that the other people who manage the entity and the administrators are told once it is saved (it says what AC-9.8 does, so a person knows the change is visible to others).
5. Footer: **Cancel** (secondary, `protected.cancel`) and **Save as version n** (primary, `protected.confirm(n)`, names the version it creates). A close control (library) in the title row.

**Focus and keys (AC-9.1, 9.2, 9.6).** On open, focus is on **Cancel** (set explicitly), the content is announced (the title names it, the intro and the whole list are in the dialog's described content, so Old and New are read), Tab and Shift+Tab cycle inside, **Escape and the close control mean Cancel**. Cancel, Escape and close: nothing is sent (no version, no audit row, no notice), the form stays exactly as typed (the draft is in memory), focus returns to **Save**, the control that opened the dialog; no message is shown (the person cancelled). Confirm: the dialog stays open and **busy** ("Saving…"; the library's `ConfirmDialog` disables its buttons natively while `busy`, not `aria-disabled`, and ignores Escape and close, so it is not dismissible; orchestrator decision 2026-11-18, tasks.md) until the answer; then it closes and the form shows the outcome by the existing S2 states (4 saved, 5 no-op, 6 refused, 7 conflict, 8 grant lost, 9 could not save, 14 too many saves). Focus order after closing: it returns to Save first, then a refusal's own move (summary, first refused control) or a conflict banner wins; on success it stays on Save. **A confirmation is never remembered**: a refusal after Confirm (conflict, rule, grant) means the next Save checks again and asks again (AC-9.3); after a Reapply the Old column is the newer version's values, the base the person now edits from.

**States (all):** **checking** (S2 state 11) · **open** · **busy** (after Confirm) · closed into S2 states 4–9 and 14 · **check failed** (S2 state 13) · **cancelled** (back to S2 state 2, focus on Save). Narrow width: the dialog fills the width with a 16 px gutter; the body scrolls when three details do not fit, and the footer stays in view (if `ConfirmDialog` cannot do that at 320 × 568 it is a library gap for T60 to report, not a reason to cut content).

Why the dialog shows what the check answered and not what was typed: AC-9.1 says "as they would be stored" and AC-9.5 asks nothing for an IBAN with other spacing; the normalisation lives only in auth (plan decision 10), so the page never mirrors it.

> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-protected-change-confirm.html` (English dark and Italian light; the VAT number of a moved, incomplete entity filled in so its Old is None, the IBAN removed so its New is None; busy; checking and check failed)

Note on "emptied" values: a legal name or a VAT number cannot be emptied by a save, because they are required and a save without them is refused (422) before the dialog. "None" on the **New** side is therefore reachable only for the IBAN; "None" on the **Old** side for any of the three on a moved, incomplete entity. The dialog and the list handle an empty side generically, so a later rule change needs no design change.

### N1 The change notice: in-app (en, it), push, email (en) (F18; AC-9.11–9.13)

Not a screen: the words of a message the registry sends after a protected change is **stored**. Copy lives with its sender: the in-app texts in auth `notices/copy.ts` (en and it, parity-tested), the email in notify-api's `legal_entity_change` template (English only). The formats below are binding for T57 and T59.

**Closed slots (AC-9.12).** The only values a notice can contain: the entity (closed set, label), the **author's account email** (the address the account had when the version was stored, captured by auth in the version's transaction and shown verbatim as plain text, at most 320 characters, only in the body, never in a title or a subject; it is the one personal value a notice carries, and **no display name appears anywhere in a notice**; when the account had no email address, or the recorded one is not a valid address, the notice says so in words and states no name: reading R-D9a, plan J11), the date and time, two version numbers, **names** from two closed sets, and an **IBAN token**. Protected names: legal name, VAT number, IBAN. Other names: address (Italian), address (English), contacts line (Italian), contacts line (English). The IBAN token is a union, not a string: `none` (empty), `set` (a value of 8 characters or fewer: no character shown) or `tail` (the last 4 characters, shown as `…` followed by them, for example `…5957`). There is no function or key that takes a legal name, a VAT number, an address, a contacts line or a longer part of an IBAN.

**Time (owner reading R-d).** `notice.when` shows the version's stored time in **Europe/Zurich**: day (no leading zero), month in words in the notice's language, year, 24-hour time, then the zone's abbreviation and its name: `17 November 2026, 10:12 CET (Europe/Zurich)` · `1 July 2026, 11:12 CEST (Europe/Zurich)`; Italian `17 novembre 2026, 10:12 CET (Europe/Zurich)`. The abbreviation is **CET when the offset on that date is +01:00 and CEST when it is +02:00**; it is not taken from `Intl`'s short name (which gives "GMT+1" in several locales). No seconds.

**Lists.** Names are joined `a`, `b` and `c` in English (`a`, `b` e `c` in Italian), always in the closed order above. Lines that have nothing to say are left out: no IBAN lines unless the IBAN changed; no "Also changed" line when only protected details changed.

**In-app notice (title ≤ 200, body ≤ 2000, plain text, English as the base and Italian as the `it` variant, link to the entity's history).** The body is these lines joined with a line break; the centre may show breaks as spaces, so **every line is a whole sentence ending in a full stop**. The link is `/admin/legal-entities?entity=<e>&view=history`, its label `notice.open`.

| Key | English | Italian |
|---|---|---|
| `notice.entity.welld_it` · `welld_ch` | WellD IT · WellD CH | WellD IT · WellD CH |
| `notice.name.legalName` · `vatNumber` · `iban` | legal name · VAT number · IBAN | ragione sociale · partita IVA · IBAN |
| `notice.name.addressIt` · `addressEn` · `contactsIt` · `contactsEn` | address (Italian) · address (English) · contacts line (Italian) · contacts line (English) | indirizzo (italiano) · indirizzo (inglese) · riga contatti (italiano) · riga contatti (inglese) |
| `notice.title(entity, details)` (also the email subject) | Legal details of {entity} changed: {details} | Dati legali di {entity} modificati: {details} |
| `notice.lead(entity)` | The legal details of {entity} were changed. | I dati legali di {entity} sono stati modificati. |
| `notice.byAction.save(author)` | Change saved by the account {author}. | Modifica salvata dall'account {author}. |
| `notice.byAction.restore(from, author)` | Version {from} restored by the account {author}. | Versione {from} ripristinata dall'account {author}. |
| `notice.byAction.saveNoEmail` (replaces `notice.unknownActor`; used when there is no usable address) | Change saved by an account with no email address on record. | Modifica salvata da un account senza indirizzo email registrato. |
| `notice.byAction.restoreNoEmail(from)` (same) | Version {from} restored by an account with no email address on record. | Versione {from} ripristinata da un account senza indirizzo email registrato. |
| `notice.when(date)` | When: {date}. | Quando: {date}. |
| `notice.version(n)` | New version: {n}. | Nuova versione: {n}. |
| `notice.changed(list)` | Details changed: {list}. | Dati modificati: {list}. |
| `notice.ibanOld(token)` · `ibanNew(token)` | Old IBAN: {token}. · New IBAN: {token}. | IBAN precedente: {token}. · Nuovo IBAN: {token}. |
| `notice.none` · `notice.set` (the token words; a tail is `…` + 4 characters) | none · set (not shown) | nessuno · presente (non mostrato) |
| `notice.alsoChanged(list)` | Also changed: {list}. | Modificati anche: {list}. |
| `notice.access` | Only people who may see this history can open the link. | Solo chi può vedere questa cronologia può aprire il collegamento. |
| `notice.unexpected` | If you did not expect this change, open the history and restore the previous version if it is wrong. Then tell an administrator. | Se non ti aspettavi questa modifica, apri la cronologia e ripristina la versione precedente se è sbagliata. Poi avvisa un amministratore. |
| `notice.open` (link label) | Open the history | Apri la cronologia |

The slot `{author}` (renamed from `{actor}`) takes the address exactly as recorded, once, in the body of the in-app text, the push and the email. The words name the **account**, not a person: the notice states the address on record and does not prove who used it. There is no fallback to a name: with no address, or with one that is not a valid email address (reading R-D9a), the `…NoEmail` sentence is used instead of the `save`/`restore` one, and the rest of the notice is unchanged. The email rows below keep the same English words as `email.byAction.*` (English only).

Body order: lead · byAction · when · version · changed · ibanOld · ibanNew (only if the IBAN changed) · alsoChanged (only if any) · access · unexpected. Worked example (English): title "Legal details of WellD CH changed: IBAN"; body "The legal details of WellD CH were changed. Change saved by the account anna.rossi@welld.ch. When: 17 November 2026, 10:12 CET (Europe/Zurich). New version: 8. Details changed: IBAN. Old IBAN: …5957. New IBAN: none. Also changed: contacts line (English). Only people who may see this history can open the link. If you did not expect this change, open the history and restore the previous version if it is wrong. Then tell an administrator." A restore reads "Version 5 restored by the account anna.rossi@welld.ch." in the same place (Italian: "Versione 5 ripristinata dall'account anna.rossi@welld.ch."); with no address on record the same place reads "Change saved by an account with no email address on record." (Italian: "Modifica salvata da un account senza indirizzo email registrato."). The restore's "details changed" are the protected details that differ from the version it replaced.

**Push.** The push text is the notification's own **English title and body** (push carries no second language, owner reading R-a): the first words of the title say the entity and the details, the body starts with the lead, the author's account email and the time. It carries the author's email and the IBAN tails exactly as the body does (AC-9.11 allows them; see DR-17).

**Longest case (T51 done-when, recomputed for D9 / T78).** Three protected names, four other names, a **320-character author email** (the limit of `noticeAuthorEmail`; ASCII only by the rule, so 320 characters are 320 UTF-16 units), a restore, the largest version number (2147483647), a summer date, Italian (the longer language): the title is **71** characters (English 66) and the body **909** characters (English **854**), against limits of 200 and 2000. The address is in the body only, so the title is unchanged by it. The English push JSON `{v,id,title,body,originApp,href}` is **1092 bytes** by this count and about 1.6 KB with the plan's allowance for the envelope (plan J4), against notify-api's 3000-byte cap, so `shrink` never cuts the body and the address is never shown cut short. The address is the only free-text slot and appears once, in the body. With no address on record the body is shorter (622 Italian, 564 English). The margin also covers an entity label several times longer than today's.

**Email (English for every recipient, including the outside mailbox; subject + HTML body + button; same layout as `notification_notice`).**

| Key | English |
|---|---|
| `email.subject` | Legal details of {entity} changed: {details} (the same as `notice.title`; the subject carries closed values only, so it can never hold a line break or a value) |
| `email.heading` | The legal details of {entity} were changed |
| `email.byAction.save` · `restore` · `saveNoEmail` · `restoreNoEmail` (English only; replaces the template's "an unnamed user") | Change saved by the account {author}. · Version {from} restored by the account {author}. · Change saved by an account with no email address on record. · Version {from} restored by an account with no email address on record. (the address is HTML-escaped text, no `mailto:` link) |
| lines, one `<p>` row each with `<br>` between them | `email.byAction.*`, `notice.when`, `notice.version`, `notice.changed`, `notice.ibanOld`, `notice.ibanNew`, `notice.alsoChanged` (English column above, the same omissions) |
| `email.note` | This message names the details that changed. It does not show their values, except the last four characters of an IBAN. |
| `notice.unexpected` | If you did not expect this change, open the history and restore the previous version if it is wrong. Then tell an administrator. |
| `email.button` | Open the history of {entity} |
| `email.access` | The link asks you to sign in. Only people who may see this history can open it. |
| `email.footer` | Sent by Operai Admin. You receive this notice because you may manage this legal entity, you are an administrator, you made the change, or this mailbox is set to receive these notices. |

One footer for everyone: the template's data carries no recipient role, and one sentence that lists every reason is true for each recipient. The outside mailbox has no sign-in; `email.access` tells it so in plain words.

> mockup: `.forge/design/20261117-legal-entities/content/legal-entity-notice-copy.html` (in-app English, in-app Italian after a restore in a summer date, the email)

## Component inventory

Library in use: **`@operai/ui`** (operai-ui/src/index.ts), Tailwind token utilities. "Reuse" cites the component; "LIFT" is
a pattern that exists in letterheads-ui and now has a second consumer, so the library rule requires it to move to
`@operai/ui` (with a story and a test) rather than be copied; "NEW" has no equivalent.

### Reused as is

| Element | Component |
|---|---|
| Tool frame, section tabs (level 1) | `ToolLayout`, `TabNav` + `tabLinkClassName` (`admin-ui/src/components/AdminShell.tsx`, `SectionNav.tsx`, modified to be capability-driven) |
| Page title, entity header | `PageHeader` |
| Entity tabs (level 2) and Details / History views (level 3) | `Tabs` + `tabPanelProps`, used twice (one component; the tab label takes `Badge`s because `label` is a `ReactNode`) |
| Form groups (no entity overview cards any more) | `Card` |
| Read-only values | `FactList` |
| Every control, each address line | `Field` + `focusFirstInvalid` (the letterheads/CRM refusal focus helper); `fieldset`/`legend` as `RadioGroupField` does |
| Buttons, link-buttons | `Button`, `buttonClassName` |
| Status, read-only mark, unsaved mark (in the tab label) | `Badge` + `Icon` (check-circle, alert, lock, clock, external, arrow-left, refresh — all exist) |
| Messages | `Banner` (info, success compact, warning, danger; `live="off"` for persistent notes) |
| History table | `DataTable` (inside the lifted `VersionTable`) |
| Confirmations | `ConfirmDialog` (restore, leave the page) |
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
| `LegalEntitiesPage` (S1 host: URL state `entity`/`view`/`version`, entity tab strip with status marks, per-entity drafts, leave-the-page guard) + `useEntityDrafts` | admin-ui | no component hosts two records with independent drafts behind tabs |
| `LegalEntityPanel` (entity header, banner slot, view tabs) | admin-ui | one host for the four states of one record |
| `LegalEntityForm` | admin-ui | the form itself |
| `AddressLinesField` | admin-ui | a `fieldset` of 4 (or, for a moved address, more) single-line `Field`s with a legend, a shared hint and a per-line count; nothing in the library groups several `Field`s as one value |
| `LegalEntityFacts` | admin-ui | `FactList` plus "Not filled in"/"Empty" rendering and one-line-per-row addresses shared by S4 and S6 |
| `LegalEntityHistory` (S5), `LegalEntityVersionView` (S6, inside the History panel) | admin-ui | bind the lifted components to the registry API |
| `RestoreDialog` (S7) | admin-ui | composes `ConfirmDialog`; owns the restore call, its refusals and the protected-change block |
| `ProtectedChangeDialog` (S12) + `useProtectedSave()` (check, then dialog, then save) | admin-ui | composes `ConfirmDialog`; nothing owns "ask the server, maybe confirm, then send" |
| `ProtectedChangeList` | admin-ui | the Old / New rows shared by S12 and S7: a list of details, each a `dl` with two labelled values; `FactList` has one value per row and no paired labels |
| `ConflictBanner` + `mergeOnConflict()` (pure) | admin-ui | conflict handling; composes `Banner`; the merge is a pure function with its own tests |
| `legalEntityStatus()`, `problemSentence()`, `valueName()`, `addressProblemTarget()` | admin-ui `lib/` | the single mappings from API answers to badge/sentence/word/input |
| `lib/legalEntitiesApi.ts` | admin-ui | typed client of the plan's routes |
| `LegalEntityNotice` (S10) + `useCanManageLegalEntity(entity)` | crm-ui | sibling of `LetterheadNotice`; different sentences and gate; builds the `?entity=` link |
| `LegalEntitySettingsNote` (S9) | crm-ui | the note row; uses the same hook |
| `useCanManageLegalEntity` (same hook, own copy: apps cannot share a hook through `shell/session`) | letterheads-ui | gate for the preview link |

Ratio: **29 reused** (22 `@operai/ui` components/helpers + 7 in-repo pieces; the second `Tabs` level is the same component, the overview cards are gone) : **3 lifted** into the library : **15 app-composition rows** (about 20 units of code; the overview-card screen disappeared, the tab host with drafts and the per-line address field were added), **0 new primitives, 0 new tokens, 0 new icons**. Every NEW row is a composition of reused parts. The amendment after the security review (T51) adds two rows (`ProtectedChangeDialog`, `ProtectedChangeList`); the paging button, the 429 banners and the Retry actions are `Button` and `Banner` as they are, so the reuse ratio stands: 29 reused : 3 lifted : 15 new compositions (13 before the amendment).

Changed existing: `@operai/ui` `Tabs` and `TabNav` list styles (the strip may wrap onto a second row instead of scrolling; one layout property, story added, no token); admin-ui `router.tsx` (one route with `entity`/`view`/`version` search params, index redirect by capability), `SectionNav` (capability-driven),
`strings/*` (new `legalEntities` area; `audit.description` mentions "legal entity changes" too — the Audit tab already
shows the new `legal_entity.*` rows without other change); crm-ui `EntityProfileForm`, `SettingsPage`, `offerErrors.ts`,
the three DR-5 strings (`settings.notSet`, `offers.errors.profileMissing`, `offerWizard.preview.profileMissing`), `ServicePreview`/wizard notice slots; letterheads-ui `PreviewPane` text and legend.
Not touched: shell, the role editor (it renders `legal-entity:manage` and its `entity` condition from the catalog), `AuditPage`.

## Copy keys (AC-8.2) — admin-ui `strings/legalEntities.ts`, en · it

Same shape as the other areas: `en`, `it: typeof en`; the parity test and `noHardcodedStrings` cover it. Italian uses the
spec's vocabulary ("Società del gruppo"). Functions take counts/names, never concatenate in components.

| Key | English | Italian |
|---|---|---|
| `nav.legalEntities` | Legal entities | Società del gruppo |
| `page.heading` / `description` | Legal entities / The legal details every tool prints on its documents, kept once for the whole group. | Società del gruppo / I dati legali che ogni strumento stampa sui suoi documenti, tenuti una sola volta per tutto il gruppo. |
| `status.complete` · `incomplete` · `needsCorrection` · `notMoved` · `readOnly` | Complete · Incomplete · Needs correction · Not moved yet · Read-only | Completa · Incompleta · Da correggere · Non ancora portata · Sola lettura |
| `tabs.entities` · `tabs.views(entity)` · `tab.unsaved` · `tab.readOnly(entity)` (hidden) | Legal entities · Views of {entity} · Unsaved changes · {entity} is read-only | Società del gruppo · Viste di {entity} · Modifiche non salvate · {entity} è in sola lettura |
| `entity.toCorrect(list)` | To correct before the next save: {list}. | Da correggere prima del prossimo salvataggio: {list}. |
| `entity.version(n, who, when)` | Version {n} · saved by {who} · {when} | Versione {n} · salvata da {who} · {when} |
| `entity.moved(when)` | Version 1 · moved from the CRM by the system · {when} | Versione 1 · portata dal CRM dal sistema · {when} |
| `entity.notMoved` | The details have not been moved into the registry yet. They can be edited once the move has run. | I dati non sono ancora stati portati nel registro. Si potranno modificare dopo il trasferimento. |
| `views.details` · `views.history` | Details · History | Dati · Cronologia |
| `value.legalName` · `vat` · `iban` · `addressIt` · `addressEn` · `contactsIt` · `contactsEn` | Legal name · VAT number · IBAN · Address (Italian) · Address (English) · Contacts line (Italian) · Contacts line (English) | Ragione sociale · Partita IVA · IBAN · Indirizzo (italiano) · Indirizzo (inglese) · Riga contatti (italiano) · Riga contatti (inglese) |
| `value.notFilled` · `empty` | Not filled in · Empty | Non compilato · Vuoto |
| `form.group.company` · `address` · `contacts` | Company · Address · Contacts line | Società · Indirizzo · Riga contatti |
| `form.ibanHint` | Spaces and lower case are fine; it is saved without spaces and shown in groups of four. Optional. | Spazi e maiuscole/minuscole non contano; viene salvato senza spazi e mostrato a gruppi di quattro. Facoltativo. |
| `address.line(k)` · `address.count(n, limit)` | Line {k} · {n} / {limit} | Riga {k} · {n} / {limit} |
| `address.hint` | Up to 4 lines of 120 characters. An empty line is left out and the lines after it move up. Line 1 is required in both languages. | Fino a 4 righe di 120 caratteri. Una riga vuota viene tralasciata e le righe dopo salgono. La Riga 1 è obbligatoria in entrambe le lingue. |
| `problem.tooManyLinesMoved` | Too many lines: at most 4. Join it to a line above or remove it. (Kept as moved from the CRM.) | Troppe righe: al massimo 4. Uniscila a una riga sopra o eliminala. (Mantenuta com'era nel CRM.) |
| `form.contactsHint` | Printed on the letterhead, for example phone and email. Up to 200 characters. Optional. | Stampata sulla carta intestata, per esempio telefono ed email. Fino a 200 caratteri. Facoltativa. |
| `bar.dirty` · `clean` · `saving` · `save(n)` | Unsaved changes. Every tool uses a saved version within a minute. · No changes · Saving… · Save as version {n} | Modifiche non salvate. Ogni strumento usa una versione salvata entro un minuto. · Nessuna modifica · Salvataggio… · Salva come versione {n} |
| `bar.nothingToSave` · `reloadFirst` (hidden reasons) | There is nothing to save. · A newer version exists. Choose how to continue. | Non c'è nulla da salvare. · Esiste una versione più recente. Scegli come proseguire. |
| `saved(n)` · `noop(n)` | Version {n} saved. Every tool uses it within a minute. · Nothing changed. These details are already version {n}, so no new version was made. | Versione {n} salvata. Ogni strumento la usa entro un minuto. · Nulla è cambiato. Questi dati sono già la versione {n}, quindi non è stata creata una nuova versione. |
| `refused.title(n)` · `hint` | Nothing was saved. {n} values need your attention. · Correct them and save again. Select one to go to it. | Non è stato salvato nulla. {n} valori richiedono la tua attenzione. · Correggili e salva di nuovo. Scegline uno per andarci. |
| `problem.required(v)` · `tooLong(limit, n)` · `tooManyLines(n)` · `lineBreak` · `controlChar` · `ibanFormat` · `ibanCheck` | Enter the {v}. · Too long: at most {limit} characters, you have {n}. · Too many lines: at most 4, you have {n}. · Use one line: remove the line break. · Remove the special character (a tab or control character). · An IBAN starts with two letters and two digits, then letters and digits only. · The check digits do not match. Check it for a typing mistake. | Inserisci {v}. · Troppo lungo: al massimo {limit} caratteri, ne hai {n}. · Troppe righe: al massimo 4, ne hai {n}. · Usa una sola riga: togli l'a capo. · Togli il carattere speciale (una tabulazione o un carattere di controllo). · Un IBAN inizia con due lettere e due cifre, poi solo lettere e cifre. · Le cifre di controllo non corrispondono. Controlla di non aver sbagliato a digitare. |
| `problem.line(lang, k, text)` | Line {k} of the {lang} address: {text} (lang = Italian or English) | Riga {k} dell'indirizzo {lang}: {text} (lang = italiano o inglese) |
| `conflict.title` · `body(who, when, values)` · `reapply` · `discard` | A newer version was saved · {who} saved version {n} on {when} (changed: {values}) while you were editing. Your changes are still in this form but were not saved. · Reapply my changes to version {n} · Discard my changes and load version {n} | È stata salvata una versione più recente · {who} ha salvato la versione {n} il {when} (cambiato: {values}) mentre modificavi. Le tue modifiche sono ancora in questo modulo ma non sono state salvate. · Riapplica le mie modifiche alla versione {n} · Scarta le mie modifiche e carica la versione {n} |
| `conflict.applied(n, flagged)` · `alsoChanged(who, theirs)` · `useTheirs` · `takenFromTheirs` | Your changes were applied to version {n}. {flagged} to review, then save as version {m}. · Also changed in version {n} by {who}: “{theirs}”. Yours is kept. · Use theirs · Taken from version {n} (you had not changed it). | Le tue modifiche sono state applicate alla versione {n}. {flagged} da controllare, poi salva come versione {m}. · Cambiato anche nella versione {n} da {who}: «{theirs}». Il tuo valore è mantenuto. · Usa il suo · Preso dalla versione {n} (non l'avevi cambiato). |
| `lost.title(entity)` · `body` | You can no longer change {entity} · Your changes were not saved. The details are now read-only. | Non puoi più modificare {entity} · Le tue modifiche non sono state salvate. I dati sono ora in sola lettura. |
| `saveFailed.title` · `body` | The details could not be saved · Nothing changed. Your changes are still here. Try again. | Non è stato possibile salvare i dati · Nulla è cambiato. Le tue modifiche sono ancora qui. Riprova. |
| `leave.title` · `body(entities)` · `keep` · `discard` | Leave without saving? · Your changes to {entities} have not been saved and will be lost. · Keep editing · Discard changes | Uscire senza salvare? · Le tue modifiche a {entities} non sono state salvate e andranno perse. · Continua a modificare · Scarta le modifiche |
| `readOnly.note(entity)` | You can read these details but not change them. An administrator grants who may change {entity}. | Puoi leggere questi dati ma non modificarli. Un amministratore stabilisce chi può modificare {entity}. |
| `incomplete.title` · `body(list, entity)` · `toCorrect.title` | These details are incomplete · Missing: {list}. Offers and contracts for {entity} are refused until they are filled in and saved. | Questi dati sono incompleti · Mancano: {list}. Le offerte e i contratti di {entity} sono rifiutati finché non sono compilati e salvati. |
| `history.caption(entity)` · `version` · `savedBy` · `savedAt` · `changed` · `actions` | Versions of {entity} · Version · Saved by · Saved on · What changed · Actions | Versioni di {entity} · Versione · Salvata da · Salvata il · Cosa è cambiato · Azioni |
| `history.restoreBlocked` | This version cannot be restored: it is missing a required value or holds one today's rules refuse. Open it to see which. | Questa versione non può essere ripristinata: manca un valore obbligatorio o ne contiene uno che le regole attuali rifiutano. Aprila per vedere quale. |
| `history.current` · `restoredFrom(m)` · `sameAs(m)` · `system` · `moved` · `open(n)` · `restore(n)` · `empty` | Current · Restored from version {m} · Same details as version {m} · System · Moved from the CRM · Open version {n} · Restore version {n} · No versions yet | Corrente · Ripristinata dalla versione {m} · Stessi dati della versione {m} · Sistema · Portata dal CRM · Apri la versione {n} · Ripristina la versione {n} · Nessuna versione |
| `version.title(n)` · `body(who, when, current)` · `back` · `restore` · `notCurrent` | Viewing version {n} (read-only) · Saved by {who} on {when}. The current version is {current}. · Back to history · Restore this version · Not current | Stai guardando la versione {n} (sola lettura) · Salvata da {who} il {when}. La versione corrente è la {current}. · Torna alla cronologia · Ripristina questa versione · Non corrente |
| `version.blocked(list, entity)` · `notFound` | This version cannot be restored: {list}. Restoring it would make {entity} incomplete again. · This version does not exist. | Questa versione non può essere ripristinata: {list}. Ripristinarla renderebbe di nuovo incompleta {entity}. · Questa versione non esiste. |
| `restore.title(n)` · `body(n, next, current)` · `changes(list)` · `confirm(n)` · `busy` · `done(next, n)` | Restore version {n}? · This creates version {next} with the same details as version {n} and makes it the current one. Version {current} and the rest of the history stay as they are. · Compared with the current version, these change: {list}. · Restore version {n} · Restoring… · Version {next} created from version {n} | Ripristinare la versione {n}? · Questo crea la versione {next} con gli stessi dati della versione {n} e la rende quella corrente. La versione {current} e il resto della cronologia restano come sono. · Rispetto alla versione corrente cambiano: {list}. · Ripristina la versione {n} · Ripristino in corso… · Versione {next} creata dalla versione {n} |
| `restore.refused(n)` · `conflict` · `failed(n)` | Version {n} cannot be restored: {list}. Nothing changed. · A newer version was saved meanwhile. The history was reloaded; check it and try again. · Version {n} was not restored. Nothing changed. Try again. | La versione {n} non può essere ripristinata: {list}. Nulla è cambiato. · Nel frattempo è stata salvata una versione più recente. La cronologia è stata ricaricata; controllala e riprova. · La versione {n} non è stata ripristinata. Nulla è cambiato. Riprova. |
| `load.failed` · `sections.loading` · `sections.failed` | The legal entities could not be loaded · Loading… · The sections could not be loaded | Non è stato possibile caricare le società del gruppo · Caricamento… · Non è stato possibile caricare le sezioni |

crm-ui and letterheads-ui add their own keys the same way (`settings.legalNote`, `settings.legalNoteLink`, `settings.legalNoteAdmin`,
`offerWizard.legalEntity.*`, `preview.sourceLine`, `preview.sourceLink`, `preview.sourceAdmin`, `preview.legend`,
`preview.unavailableTitle/Body`): English as in S9–S11, Italian by the same vocabulary ("Società del gruppo"; "Apri Società del gruppo").

### Copy keys added by the amendment after the security review (T51)

All strings below are new unless marked **changes**. Same shape rules as above (`en`, `it: typeof en`; functions take counts and names; parity test and `noHardcodedStrings` cover them). "Retry" buttons reuse `common.retry` ("Retry" · "Riprova"); no key is added for them. The three value names in dialogs reuse `value.legalName`, `value.vat`, `value.iban`.

**S12 protected-change confirmation** (`protected.*`, admin-ui):

| Key | English | Italian |
|---|---|---|
| `protected.title(entity)` | Save these changes to {entity}? | Salvare queste modifiche a {entity}? |
| `protected.intro` | You are changing details that are printed on every offer and contract. Every tool uses the saved version within a minute. Check the new values before you save. | Stai modificando dati che vengono stampati su ogni offerta e contratto. Ogni strumento usa la versione salvata entro un minuto. Controlla i nuovi valori prima di salvare. |
| `protected.told(entity)` | Once saved, the other people who manage {entity} and the administrators are told of this change. | Dopo il salvataggio, le altre persone che gestiscono {entity} e gli amministratori vengono informati della modifica. |
| `protected.listLabel` | Details that change | Dati che cambiano |
| `protected.old` · `protected.new` | Old · New | Precedente · Nuovo |
| `protected.none` | None | Nessun valore |
| `protected.confirm(n)` | Save as version {n} | Salva come versione {n} |
| `protected.cancel` | Cancel | Annulla |
| `protected.checking` (Save label and bar text while the check runs) | Checking… | Verifica in corso… |
| `protected.checkFailed.title` | The changes could not be checked | Non è stato possibile verificare le modifiche |
| `protected.checkFailed.body` | Nothing was saved. The page could not check whether these changes need your confirmation. Your changes are still here. Try again. | Non è stato salvato nulla. La pagina non ha potuto verificare se queste modifiche richiedano la tua conferma. Le tue modifiche sono ancora qui. Riprova. |

**S7 restore additions** (`restore.*`):

| Key | English | Italian |
|---|---|---|
| `restore.protectedIntro(entity)` | This restore changes details that are printed on every offer and contract. Once restored, the other people who manage {entity} and the administrators are told of it. | Questo ripristino modifica dati che vengono stampati su ogni offerta e contratto. Dopo il ripristino, le altre persone che gestiscono {entity} e gli amministratori ne vengono informati. |
| `restore.protectedLegend(current, n)` | Old is the current version ({current}). New is version {n}. | Precedente è la versione corrente ({current}). Nuovo è la versione {n}. |
| `restore.loadingDetails(n)` (hidden live text, and Confirm's reason) | Loading the details of version {n}… | Caricamento dei dati della versione {n}… |
| `restore.detailsFailed(n)` (inline warning, and Confirm's reason) | The details of version {n} could not be read, so the restore cannot be checked. Nothing was restored. Try again. | Non è stato possibile leggere i dati della versione {n}, quindi il ripristino non si può verificare. Non è stato ripristinato nulla. Riprova. |

**429 too many saves** (`saveFailed.*`, `restore.*`, `wait.*`; the wait is `Retry-After` in seconds, rounded **up** to whole minutes, at least 1; no header: the "no wait" sentence):

| Key | English | Italian |
|---|---|---|
| `wait.minutes(n)` | 1 minute · {n} minutes | 1 minuto · {n} minuti |
| `saveFailed.tooManyTitle` | Too many saves in a short time | Troppi salvataggi in poco tempo |
| `saveFailed.tooMany(minutes)` | Nothing was saved and your changes are still here. Wait about {minutes}, then try again. | Non è stato salvato nulla e le tue modifiche sono ancora qui. Aspetta circa {minutes}, poi riprova. |
| `saveFailed.tooManyNoWait` | Nothing was saved and your changes are still here. Wait a few minutes, then try again. | Non è stato salvato nulla e le tue modifiche sono ancora qui. Aspetta qualche minuto, poi riprova. |
| `restore.tooMany(minutes)` | Too many changes in a short time. Nothing was restored. Wait about {minutes}, then try again. | Troppe modifiche in poco tempo. Non è stato ripristinato nulla. Aspetta circa {minutes}, poi riprova. |
| `restore.tooManyNoWait` | Too many changes in a short time. Nothing was restored. Wait a few minutes, then try again. | Troppe modifiche in poco tempo. Non è stato ripristinato nulla. Aspetta qualche minuto, poi riprova. |

**S5 history paging** (`history.*`):

| Key | English | Italian |
|---|---|---|
| `history.more` | Show older versions | Mostra le versioni meno recenti |
| `history.loadingMore` | Loading older versions… | Caricamento delle versioni meno recenti… |
| `history.moreFailed` | Older versions could not be loaded. The versions above are still shown. | Non è stato possibile caricare le versioni meno recenti. Quelle qui sopra restano visibili. |
| `history.moreLoaded(n)` (hidden polite status) | 1 older version loaded. · {n} older versions loaded. | 1 versione meno recente caricata. · {n} versioni meno recenti caricate. |
| `history.showing(n)` (while more exist) | Showing the {n} newest versions. | Sono mostrate le {n} versioni più recenti. |
| `history.showingAll(n)` (after the last page, when the table has more than one page) | Showing all {n} versions. | Sono mostrate tutte le {n} versioni. |

**FU-4** (**changes** `toCorrect.title`): "These details need correction" / "Questi dati vanno corretti" is replaced by **Some values need correcting** / **Alcuni valori vanno corretti**. Reason: S3 always said so; "these details" suggests the whole entity is wrong when it is only some values; and the title is a sentence about the values the body then lists ("To correct before the next save: …"). The badge keeps "Needs correction" (a state, not a sentence).

**FU-7 admin-ui string gaps** (T37, T38) and **T39's** (`history.*`, `version.*`):

| Key | English | Italian |
|---|---|---|
| `problem.moved(sentence)` (**changes**: the suffix is no longer part of `problem.tooManyLinesMoved`; it is added to the in-place marker of **every** reason on a value that is still as moved) | {sentence} (Kept as moved from the CRM.) | {sentence} (Valore mantenuto com'era nel CRM.) |
| `problem.tooManyLinesMoved` (**changes**: without the suffix; wrapped by `problem.moved`) | Too many lines: at most 4. Join it to a line above or remove it. | Troppe righe: al massimo 4. Uniscila a una riga sopra o eliminala. |
| `problem.notFilled(v)` (the static marker of a required value missing on a moved entity; the refusal after a save keeps `problem.required`) | Not filled in. Enter the {v}. | Non compilato. Inserisci {v}. |
| `address.movedHint(n)` (the 5th-line hint: added under the shared hint, and in every line's `aria-describedby`, when the stored address has more than 4 lines) | This address was moved from the CRM with {n} lines. Only 4 can be saved: join the extra lines to the ones above, or remove them. | Questo indirizzo è stato portato dal CRM con {n} righe. Se ne possono salvare solo 4: unisci le righe in più a quelle sopra, oppure eliminale. |
| `conflict.flagged(count)` (the count phrase for `conflict.applied`) | 1 value · {count} values | 1 valore · {count} valori |
| `conflict.appliedClean(n, next)` (nothing flagged) | Your changes were applied to version {n}. Nothing to review: save as version {next}. | Le tue modifiche sono state applicate alla versione {n}. Non c'è nulla da controllare: salva come versione {next}. |
| `conflict.bodyNoList(who, n, when)` (the list of changed values is empty: a newer version whose changes the page cannot name; replaces the empty "(changed: )") | {who} saved version {n} on {when} while you were editing. Your changes are still in this form but were not saved. | {who} ha salvato la versione {n} il {when} mentre modificavi. Le tue modifiche sono ancora in questo modulo ma non sono state salvate. |
| `history.openLabel` · `history.restoreLabel` (the visible words of the row buttons; their accessible names stay `history.open(n)`, `history.restore(n)`, which start with the visible word, WCAG 2.5.3) | Open · Restore | Apri · Ripristina |
| `history.changedList(list)` | Changed: {list} | Cambiato: {list} |
| `history.loading` (hidden live) | Loading the history… | Caricamento della cronologia… |
| `history.failed` | The history could not be loaded | Non è stato possibile caricare la cronologia |
| `version.failed` | This version could not be loaded | Non è stato possibile caricare questa versione |

The **note slot** of FU-7 has no words of its own: `AddressLinesField` takes a `note` (the conflict's `conflict.alsoChanged(...)` or the moved-address hint), rendered under the shared hint and listed in every line's `aria-describedby`, so the focused line reads it.

**FU-1 crm-ui** (`offerWizard.letterhead.overflow.*`; **changes** `title`, `body`, `bodyAskAdmin`; adds two). The values on the letterhead now live in Legal entities, so the title stops saying "profile" and the body points at the Legal entities page. Links reuse `legalEntity.open` ("Open Legal entities") and `legalEntity.openNamed(entity)`; `letterhead.open` stays.

| Key (who sees it) | English | Italian |
|---|---|---|
| `title(entity, frame)` | A legal detail of {entity} does not fit the letterhead's {frame} | Un dato legale di {entity} è troppo lungo per {frame} della carta intestata |
| `body` (may manage {entity} **and** may open Letterheads) | Shorten the value on the Legal entities page, or change the letterhead. | Accorcia il valore nella pagina Società del gruppo, oppure modifica la carta intestata. |
| `bodyValueOnly` (may manage {entity}, may not open Letterheads) | Shorten the value on the Legal entities page, or ask an administrator to change the letterhead in Letterheads. | Accorcia il valore nella pagina Società del gruppo, oppure chiedi a un amministratore di modificare la carta intestata in Carte intestate. |
| `bodyLetterheadOnly` (may open Letterheads, may not manage {entity}) | Ask an administrator who keeps the Legal entities page to shorten the value, or change the letterhead. | Chiedi a un amministratore che gestisce la pagina Società del gruppo di accorciare il valore, oppure modifica la carta intestata. |
| `bodyAskAdmin` (neither) | Ask an administrator who keeps the Legal entities page to shorten the value, or to change the letterhead in Letterheads. | Chiedi a un amministratore che gestisce la pagina Società del gruppo di accorciare il valore, oppure di modificare la carta intestata in Carte intestate. |

`header` and `footer` ("header", "footer" · "l'intestazione", "il piè di pagina") are unchanged.

**FU-9 letterhead-api engine**, the sample document's `intro` (`letterhead-api/engine/src/sample/mod.rs`; the preview shows the registry's real details, a missing one in the missing look, so the old "placeholders, mark (SAMPLE)" sentence is false):

| Key | English | Italian |
|---|---|---|
| `intro` (**changes**) | This document is only here to show the letterhead. The company's details in it are the real ones; a detail that is not filled in yet is marked. The rest of the text is sample text. | Questo documento serve solo a vedere la carta intestata. I dati dell'azienda che vi compaiono sono quelli reali; un dato non ancora compilato è evidenziato. Il resto del testo è un testo di esempio. |

The sentence names no tool and no entity (a page picture has no links), and stays true when a detail is missing. When the registry cannot be read (S11) the pages mark every detail and the warning beside them says why, so the sentence does not mislead. The document's `title` ("Sample document" · "Documento di esempio") is unchanged.

**Notices** (`notice.*`, `email.*`): tables in N1 above; en and it for the in-app texts, English only for the email.

## Accessibility (AC-8.1, AC-8.2) — WCAG 2.1 AA

Targets for the suite's automated check: axe (A/AA) on S1 (loaded with each tab selected, loading, failed, not moved, the strip with every badge variant), S2 (clean, dirty, refused, conflict, a moved 5-line address),
S3, S4, S5 (both variants, empty, and the paging states: more, loading more, failed, last page), S6 (restorable, blocked), S7 (three variants, plus the protected block, loading the details, details failed, 429), S8 (four variants), S9, S10 (and the four bodies of S10b) and S11, S12 (checking, open, busy, check failed) and the 429 banner of S2,
each in dark and light and in Italian once. Test ids use the page prefix `admin-legal-…` (building-pages § 7).

**Keyboard-only path (E2E):** Admin tool → Legal entities section link → Tab to the entity tablist (one stop, the selected tab) → arrow to the other entity and back (lossless) → Tab to the view tablist → Tab into the form →
Legal name … Address (Italian) Line 1 … Line 4 … Save → refused: focus lands on the first refused control (the exact line), the summary buttons are the second way in → correct → Save →
"Saved" status read, focus still on Save → view tablist, arrow to History → Open version → heading focused → Restore this version → dialog (Cancel focused; Escape closes; Tab trapped) → Confirm → entity heading focused, success status.
Conflict: Reapply by keyboard, focus to the first flagged value. Leaving the page with a draft: the section link opens the leave dialog.
Protected change: Save (focus stays on it, "Checking…") → the dialog opens with focus on Cancel and its content read (title, intro, each detail with Old and New, the note that others are told) → Tab to "Save as version n", Shift+Tab back, Escape → closed, focus on Save, nothing sent, the form as typed → Save again → Tab to "Save as version n" → Enter → busy, not dismissible → the status read, focus on Save.

**Three tab levels and their keyboard model (hotspot):**
1. *Section level* (`TabNav`, `nav` "Admin sections"): real links, each its own Tab stop, `aria-current="page"`.
2. *Entity level* (`Tabs`, tablist "Legal entities"): one Tab stop (the selected tab, roving `tabindex`); Left/Right/Home/End move **and activate** (the library's behaviour). That is safe because switching entity never prompts and never loses a draft (S1). The tab's accessible name is the entity plus its marks in words ("WellD IT, Incomplete, Read-only, Unsaved changes"); marks are text, never colour or glyph alone. The tabpanel is the whole entity panel; because it starts with focusable content (the view tabs), the outer panel is rendered without its own `tabindex` (spread `tabPanelProps`, then drop `tabIndex`).
3. *View level* (`Tabs`, tablist "Views of {entity}"): same behaviour; its panel keeps the library default (`tabindex=0`) so the form or the table region is reachable.
Tab order through the page: section link → selected entity tab → selected view tab → panel content → Save. After a tab switch, focus stays on the tab just used (nothing moves into the panel); the panel is a labelled region (`aria-labelledby` its tab). Selecting a tab replaces the history entry (no Back trap); switching entity or view has no announcement beyond the selected state, and the unsaved mark has no live region.
Heading outline: h2 "Legal entities" (page) → h3 entity name (panel) → h4 groups and the version heading.
Reflow at 320 px: the entity strip wraps to two rows (it never scrolls sideways; this needs the one-property library change in the inventory), badges stay text.

Per screen:
- **S1** One h2 (PageHeader), one h3 per panel; Badge = glyph + words; "Read-only" is words + lock glyph, not colour; missing values have text + alert glyph; the "Unsaved changes" mark is words; the strip's name for assistive technology is "Legal entities" (also the h2), the two tabs are distinguishable by entity name first.
- **S2/S3 form** Every control has a visible label (no placeholder-only); required = `aria-required` + `*` (aria-hidden); hints and errors are `aria-describedby`; **language of parts**: Italian controls carry `lang="it"`, English `lang="en"` (WCAG 3.1.2) and `spellcheck` follows it; IBAN input `spellCheck=false`, `autoComplete="off"`, grouped only on blur (never while typing, so the caret and a screen reader's echo do not jump); the status text is not a live region (outcomes have their own banners); Save is `aria-disabled` + hidden reason (focusable, never `disabled`); the sticky bar must not cover the focused control (scroll-margin on controls); reflow at 320 px: single column, bar wraps.
- **Address lines (Q2=B, hotspot)** Each language is a `fieldset` with a `legend` ("Address (Italian)"), so a screen reader hears the group, then "Line 1", "Line 2"…; `lang` is on the fieldset; Line 1 carries `aria-required`, lines 2 to 4 do not; the shared hint is `aria-describedby` on every line; the "n / 120" count is `aria-hidden` (the limit is already in the hint) and is not a live region; every line error is its own `Field` error (`aria-invalid`, `aria-describedby`), spoken when the line gets focus; extra inputs for a moved address (Line 5+) have the same markup plus their static error; focus is moved to the exact line, never to the group. The input count changes only on load and after a save (no add or remove buttons), so there is no focus loss from a line disappearing except after a successful save, which keeps focus on Save.
- **Refusal (hotspot)** Summary = `role="alert"` Banner, announced once; focus moves to the first refused control in page order after the summary has mounted (letterheads' order of effects: summary first, then `focusFirstInvalid`), so a screen reader hears "n values need your attention" then the control with its label and error; each summary item is a real button naming the value, the line when it is an address line, and the remedy; errors never carry colour alone (alert glyph + words); the same sentence in summary and field.
- **Moved incomplete (S3)** persistent notes are `live="off"` and static `aria-describedby`; opening the page does not announce an alert.
- **Conflict** assertive banner (a 409 is time-critical); after Reapply, focus to the first flagged value (an address flags its fieldset: the legend is described by "Also changed in version n by …"), polite status "n values to review".
- **Leave dialog** `ConfirmDialog` (`alertdialog`, Cancel focused first, trap, Escape); it names the entities with unsaved changes; Keep editing returns focus to the element that triggered it (a section link) or to the selected entity tab for Back/Forward.
- **S5 table** caption, `scope` headers, version as row header; times in `<time>`; row buttons named per row; the table region is keyboard-scrollable (DataTable); the Current badge is text; a non-restorable row's Restore is `aria-disabled` and described by its reason.
- **S6/S7** Version heading focused on arrival; Back to history returns focus to that row's Open button; Restore aria-disabled keeps its reason readable; dialog = `ConfirmDialog` (`alertdialog`, focus Cancel, trap, Escape, focus returns to the row's Restore button on cancel; on success focus goes to the entity heading because the row may be gone).
- **S8** `nav` landmark named "Admin sections" next to the shell's tool nav; a hidden section is absent, not disabled; `aria-current="page"` from the router `Link`; a redirect from a hidden URL changes the page without announcement (same as every admin-ui navigation today).
- **S9–S11** Notes are `live="off"` (read in place); refusals follow the Letterhead notice: danger = assertive, preview = polite; the missing look is words + ⟦ ⟧ glyphs + yellow, never yellow alone; **the preview page's text alternative must contain the same ⟦Label⟧ marks** (DR-4); the link is a real `<a>` with the destination in its name ("Open Legal entities, WellD CH").
- **S12 (hotspot)** `ConfirmDialog` (`alertdialog`): the title names the entity; the **initial focus is Cancel, set explicitly** and tested; the dialog's `aria-describedby` covers the intro, the whole list and the "told" note, so a screen reader hears each detail with its Old and New values on opening (T60 tests the accessible description for the entity name, the labels "Old" and "New" and the values). The list is a real list; each detail's `dl` pairs the terms "Old" and "New" with their values; "None" is text. Old and New are told apart by their **words**, never by colour, strike-through or position alone; values wrap (320 px reflow, no truncation) and the IBAN in groups of four is read in groups by a screen reader. Escape and the close control are Cancel; Tab is trapped; focus returns to Save. Busy: the library disables the buttons natively (Confirm shows the busy label as text; this is shared `ConfirmDialog` behaviour for every dialog of the suite, accepted because the busy state is short and the busy label is announced; axe is clean), Escape and close are ignored. "Checking…" is the Save button's own busy state (no live region; the dialog or the outcome banner that follows is what is announced). The dialog follows the existing tone tokens only; contrast as the library's.
- **S7 additions** The protected block is inside the described content; while it loads or after a failed read, Confirm is `aria-disabled` through `confirmDisabledReason` (T73) with its reason readable (focusable, not `disabled`), the loading sentence is a hidden live region; a failed read is an inline `role="alert"` banner with Retry, announced once.
- **429 and paging** The 429 banner is announced like the other save failures (state 9) and carries the wait as words; no countdown and no live ticking. Paging: the button is `aria-disabled` + `aria-busy` while loading (it keeps focus); a polite hidden status says how many versions arrived; focus moves to the first new row's Open; on failure focus moves to Retry; the sentence "Showing the 50 newest versions." is the button's description. No focus is lost when the button disappears: it is moved first.
- **Notices (N1)** Plain text, no markup, so a notification centre, a lock screen and a screen reader read the same words in the same order; every line is a full sentence; the email's button is a real link whose text says where it goes ("Open the history of WellD CH"); the email's HTML text is escaped; the language of the in-app text follows the reader (the `it` variant), the email is English (`lang="en"` on the message).
- Contrast: only token pairs the library already measured (`*-text` tokens for tones as text; `--soft` for secondary text, never `--muted`); the `paper-mark` pair is 11.1:1.
- Motion: none added (skeletons and spinner are the library's, already `prefers-reduced-motion` aware).

## Coverage: ACs and surfaces

| AC | Surface |
|---|---|
| AC-1.1 | S1 (both entities as tabs), S2 (all values, both languages, address as lines) |
| AC-1.2–1.4 | S2 refusal (F4); S3 |
| AC-1.5 | S2 "saved" status with the minute (the propagation itself is not UI) |
| AC-2.1 | S2 no-op; version numbering on the Save button |
| AC-2.2, 2.3, 2.4 | S5 (with paging, "Show older versions"), S6, S7 |
| AC-2.6 | S2 conflict |
| AC-4.2, 4.3 | S4, S8, S1 (Read-only mark on the tab) |
| AC-5.4 | S11 |
| AC-6.1 | S9 |
| AC-6.3 | S10 (and S1 tab badge/S3 say the same on the entity) |
| AC-7.3 | S1 (tab badge), S3 |
| AC-8.1, 8.2 | Accessibility, Copy keys |
| AC-9.1, 9.2, 9.3, 9.5, 9.6, 9.17 | S12 (save; F15), the S2 states 11–14 |
| AC-9.4, 9.6, 9.17 | S7 additions (restore; F16) |
| AC-9.11, 9.12, 9.13 | N1 (in-app en and it, push, email en; F18) |

**ACs with no UI surface** (nothing to design): AC-1.1 as data model, AC-2.5 (audit row; the existing Audit tab shows it), AC-2.7
(immutability), AC-3.1–3.4 (API), AC-4.1 (catalog; the role editor renders it generically), AC-5.1–5.3, AC-5.5 for documents
(letterhead service), AC-6.2 and 6.4 (documents), AC-7.1, 7.2, 7.4, 7.5 (the move; its report is the operator's, not a screen), AC-9.7–9.10 (when and to whom a notice goes: the registry), AC-9.14–9.16 (retries, the audit entries the existing Audit tab shows, the move sending nothing). AC-7.2's "System" attribution is shown in S5.

**UI added that no AC asks for (accepted by the owner's non-objection, 2026-11-17; kept, minimal):** the freshness sentence after a save (AC-1.5/3.3 as
words); the leave guard (S2 state 10, now only for leaving the page); the "not moved yet" state (a window of the release order); the 403-lost and could-not-save
states; the CRM 503 notice (S10); the unavailable preview notice (plan sequence "Configurator preview"); the "Compared with the
current version, these change: …" line in the restore dialog. Added by the approved amendment (plan G7, G9, G11), not by an AC: the "told" sentences of S12 and S7, the "could not be checked" state, the 429 states, the paging area of the history, and the legend and the loading and failed states of the restore details.

**UI added by the consequences of Q1=B / Q2=B (so not covered by the earlier acceptance; owner may strike):** the per-entity drafts and the "Unsaved changes" mark on the tab (they replace a leave dialog on every tab switch, which would also fire on arrow keys); the "n / 120" count beside each address line (the owner asked for visible limits); the extra input per stored line of a moved address with more than 4 lines (D3).

**Scope creep found and not designed (stays out):**
1. Showing the registry's current values or its Incomplete status inside CRM Settings, or in the configurator beyond the missing look.
2. Marking in the version view which values that version changed, or a side-by-side comparison of two versions (AC-2.2 asks only for the names of changed values in the list).
3. A step-up sign-in for an IBAN change, or a second person approving it (security review F1 fixes 2 and 4: an owner decision outside US-9).
4. A "notice sent" mark or delivery status on the history rows (the failures are in the Audit tab, AC-9.15), a preference to switch notices off, a countdown on the 429, remembering a confirmation for the session.

(Two items of the earlier list, a confirmation step on an IBAN change and notifying other managers, are **now in scope**: S12 and N1, from US-9.)

## Drift (spec/plan gaps found while designing) and how each is resolved

| # | Finding | Resolution (adopted 2026-11-17) |
|---|---|---|
| **DR-1** | The version list carries no per-version completeness, so the history cannot show that a Restore will be refused (D4) before the person tries. | **Plan amendment: optional `restorable: boolean` on each list item**, computed by the same `rules.ts` (the architect amends; assumed). S5 disables Restore on such rows with a reason; S6/S7 keep their own checks. |
| **DR-2** | crm-ui and letterheads-ui must know whether this person may manage this entity to choose link vs sentence (AC-6.1/D5, S10, S11); the browser must not evaluate the `entity` condition (plan decision 5c). | **Adopted:** `useCanManageLegalEntity(entity)` = `GET {auth}/legal-entities/manageable` via `shell/session` `apiFetch`, cached per session, failing closed (no link). Added to the crm-ui and letterheads-ui tasks. |
| **DR-3** | Conflict needs the current details and the newer version's author; the 409 carries only `currentVersion`. | **No API change:** the page reads `GET /legal-entities/{entity}` and the versions list after the 409. |
| **DR-4** | A missing value must also be marked in the preview page's text alternative (letterhead AC-8.6), not only in the drawing. | **Assumed:** in preview mode a missing value appears in `text` as ⟦Label⟧ (same glyphs as the CRM wizard, closed label set in both languages); the drawn mark uses `--paper-mark`. |
| **DR-5** | Plan: "new refusals replacing 409 `entity_profile_missing`". | **Decided: `entity_profile_missing` is removed.** Generation is blocked only by 409 `legal_entity_incomplete`; `settings.notSet`, `offers.errors.profileMissing` and `offerWizard.preview.profileMissing` are removed/replaced (S9, S10). The architect amends the plan. |
| **DR-6** | AC-7.3 calls an entity with only a refused-but-present value "incomplete", but only a missing required value stops offers (AC-6.3, AC-7.5). | **Kept:** **Incomplete** (missing required, blocks offers) vs **Needs correction** (out-of-limit only, blocks nothing). Spec wording to read "incomplete or in need of correction". |
| **DR-7** | A hidden section's URL redirects silently (plan decision 5). | As proposed: optional, low; **not designed**. |
| **DR-8** | The audit tab description says authorization changes only; it will also list `legal_entity.*` rows. | As proposed: one-line copy change in `strings/audit.ts` (en + it); no screen change. |
| **DR-9** (new, from Q2=B) | `problems[].line` is "0-based" for an address line, but not stated against what: the submitted array, or the array after trimming and blank-line removal (plan, rules of a save). With four inputs the page must put the error on the right input. | **Architect: state that `line` is the position in the submitted array, before blank lines are removed**, and say the client sends the line inputs in order, blanks included. (If the plan keeps "after removal", the design still works: the client sends only the filled lines and maps the k-th problem to the k-th filled input; say which in the plan.) Also state which reason carries no `line`: `required` and `too_many_lines`. |
| **DR-10** (new, from Q2=B, D3) | `LegalEntity.invalid` is `[{ field, reason }]` with no `line` or `limit`, so a moved over-long line, or a moved 5th line, cannot be marked on its own input without the browser re-implementing the limits (plan decision 10). | **Architect: make `invalid` items `{ field, line?, reason, limit? }` like `problems`** (same `rules.ts`). A `too_many_lines` item needs no `line`: the page marks the inputs beyond the fourth. Without it the page can only mark the whole address. |
| **DR-11** (new, from Q1=B) | The plan names no admin-ui URLs beyond the section guard. The design now fixes one route `/admin/legal-entities` with search params `entity` (`welld_it`\|`welld_ch`), `view` (`details`\|`history`) and `version` (whole number), and `/admin/legal-entities?entity={entity}` as the link from crm-ui and letterheads-ui (D5, AC-6.1). The earlier sub-routes `/legal-entities/$entity` and `/versions/$n` are not used, and an unknown entity is not a 404 but falls back to the default tab. | **Architect/tasks:** record the route and its search params in the admin-ui and crm-ui/letterheads-ui tasks and in the AC-4.3/AC-6.1 E2E steps; the hidden-section redirect (plan decision 5) keeps working unchanged. No API change. |
| **DR-12** (new, from Q1=B) | The `Tabs` and `TabNav` list styles in `@operai/ui` cannot wrap. With status badges in the label the entity strip is wider than 320 px (WCAG 1.4.10 reflow). | **Library task:** allow the tab list to wrap onto a second row (one layout property, a story with long labels, no token); frontend-dev cannot fix it with utilities on a library component. |
| **DR-13** (new, T51) | Task T51 mentions a VAT number "emptied" in S12. A legal name and a VAT number are required, so a save that empties one is refused (422) **before** any confirmation; only the IBAN can be emptied by a save, and a restore of a version missing a required value is refused too (DR-1, D4). | No change. The dialog and `ProtectedChangeList` show an empty side as None generically; the mockup shows the cases that can happen (a VAT number filled in on a moved, incomplete entity; an IBAN removed). |
| **DR-14** (new, T51) | AC-9.8 sends the notice to every administrator "whether or not they also hold" `legal-entity:manage`, and AC-9.11 gives a link to the history. An administrator without the grant has no Legal entities section (S8), so that link lands on the hidden-section redirect (plan decision 5, DR-7), with no explanation. | Not designed (the link behaviour is plan decision 5). The notice says so in words (`notice.access`, `email.access`: only people who may see this history can open the link). **Owner may want** the page to show `PermissionDenied` instead of a silent redirect for this one URL, or the grant to be given to administrators; both are outside this task. |
| **DR-15** (new, T51) | The notice's zone abbreviation. `Intl`'s short zone name is "GMT+1" in many locales, so "CET" cannot come from it. | N1: CET when the offset on that date is +01:00, CEST when it is +02:00; T57 and T59 test both a winter and a summer date. |
| **DR-16** (new, T51) | The notification centre's rendering of a body with line breaks is not fixed by the schema. | N1: each line is a whole sentence ending in a full stop, so the text reads right with or without the breaks. |
| **DR-17** (new, T51) | Push is the notification's English title and body (R20), so the lock-screen text shows the author's account email and the two IBAN tails; AC-9.11 and 9.12 allow both (the owner accepted the address on 2026-11-18, amendment D9), and AC-9.12 forbids only everything else. No display name is shown. | Informational, no design change: the title names the entity and the details and holds no address; the body starts with the lead, the author's email and when. The owner may ask for a shorter push, which is a notify-api change. |
| **DR-18** (new, T51) | `LegalEntityNotice` for the overflow case needs the entity's manage gate in crm-ui (FU-1) in addition to `useCanOpenLetterheads()`, which T63 must add to `LetterheadNotice`. | S10b names the two gates and the four bodies. |

## Open items

Synced with the build on 2026-11-18 (eval round 1, QE T45). Status of this file stays `draft`: the design is ungated and the owner has not approved it.

Resolved:

- [x] Lift the three letterheads-ui patterns into `@operai/ui` (the lifted components (including `ErrorSummary` and `VersionTable`) are exported by the library and imported by admin-ui, no local copy; QE section 8).
- [x] Plan amendments that this design assumes: DR-1, DR-2, DR-4, DR-5, DR-9, DR-10, DR-11 (plan "Amendment 2026-11-17 after design", E1-E14, approved).
- [x] DR-12 library change (wrapping tab list): done; FU-3 verified at 320 px in a real browser by QE T45 (`scrollWidth` 320 = `clientWidth` 320, both themes; QE section 8).
- [x] The copy added by T51 landed in the code through T40, T60, T63, T65 and T59 (S12, S7 additions, the 429 and paging texts, the notice, FU-1, FU-4, FU-7, FU-9); QE saw it on the real pages (section 8, section 10).
- [x] Contrast: the page's 47 text elements measure at least 5.01:1 in both themes; axe (WCAG 2.1 A/AA) is 0 violations on every screen and both dialogs (QE T45, section 8).
- [x] S7 `confirmDisabledReason`, the list's description and the dialog's place beside the form: this document now says what was built (sections S7 and S12 and their accessibility notes). The S12 busy reading is written here as built too; the decision itself is listed below, approved by the owner on 2026-11-18.
- [x] FU-5 (no design change): the ADR for how a layout draws the missing mark is written: `docs/adr/20261117-a-layout-draws-the-configurators-missing-mark-through-a-runtime-patch-of-one-template-line-the-label-only-in-the-drawing-and-the-brackets-only-in-the-page-text-and-a-layout-that-cannot-is-refused.md` (commit `caf5564a`).

Decided by the orchestrator during the owner-requested unattended run 2026-11-17/18 (recorded in tasks.md), approved by the owner on 2026-11-18:

- [x] DR-14 (administrators without the grant get a link that redirects): the `admin` role holds `legal-entity:manage` by seed (T3) and department admins inherit it, so every effective administrator can open the history link; no design change. The owner may instead choose to show `PermissionDenied` rather than a redirect.
- [x] DR-17 (the lock-screen push shows the author's account email and the two IBAN tails): accepted as AC-9.11, AC-9.12 and reading R-a allow, and by the owner for the email on 2026-11-18 (D9). The owner may ask for a shorter push (a notify-api change).
- [x] DR-13, DR-15, DR-16 and DR-18: "as the design says" (2026-11-17; DR-18 went to T63). *(owner approved 2026-11-18)*
- [x] S12 busy reading (2026-11-18, T40 report): the library disables Confirm natively while busy; S12 is read as "Confirm unavailable while busy", no library change. *(owner approved 2026-11-18)*

Still open, for the owner:

- [x] Owner review of the copy added by T51 (S12 and S7 additions, the 429 and paging texts, the notice in-app en and it, email en, FU-1, FU-4, FU-7, FU-9). Owner: owner. *(owner approved 2026-11-18)*
- [x] **N1 / O-1**: the actor's display name in the notice. Resolved by spec amendment D9 (2026-11-18): the notice names its author by the account email captured in the version's transaction and shows no display name anywhere (copy in N1; plan "Amendment 2026-11-18 — D9", J1-J12). Reading R-D9a (an address that is not valid counts as no address on record) is proposed to the owner and applied meanwhile.
- [ ] **O-4**: the shell footer text (11 px, "Legal information", "Operai v0.5.0") measures 3.01:1 (light) and 2.79:1 (dark), under 4.5:1. Pre-existing chrome outside this feature and not on the Legal entities page; for the shell's designer, not this task.

## Amendment after the security review (2026-11-17, task T51): where each item went

Source: spec US-9 (AC-9.1–AC-9.17), plan "Amendment 2026-11-17 after security review" (G7, G9, G11, G13, G14). This **supersedes** "no confirmation step on an IBAN change" (Decisions) and items 1 and 4 of the earlier "Scope creep" list. Nothing new in the system: no primitive, token or icon.

- [x] **S12 Protected-change confirmation (save)**: section S12 (states checking, open, busy, check failed, cancelled; no acknowledge checkbox, Cancel focused); keys `protected.*`; S2 states 11–13; mockup `legal-entity-protected-change-confirm.html` (en dark and it light).
- [x] **S7 restore dialog additions (AC-9.4)**: S7 "Additions after the security review"; keys `restore.protectedIntro`, `restore.protectedLegend`, `restore.loadingDetails`, `restore.detailsFailed`; mockup `legal-entity-restore-protected-states.html`.
- [x] **Too many saves (429)**: S2 state 14 and the inline error of S7; keys `saveFailed.tooManyTitle`, `saveFailed.tooMany`, `saveFailed.tooManyNoWait`, `restore.tooMany`, `restore.tooManyNoWait`, `wait.minutes`.
- [x] **S5 history paging**: S5 "Paging"; keys `history.more`, `history.loadingMore`, `history.moreFailed`, `history.moreLoaded`, `history.showing`, `history.showingAll`.
- [x] **Notice copy (AC-9.11–9.13)**: section N1 (in-app en and it, push, email en: subject, body, button, footer); the longest case stated to fit 200 and 2000.
- [x] **FU-1** crm-ui overflow notice: S10b and its keys. **FU-4** `toCorrect.title`: replaced by "Some values need correcting". **FU-7** admin-ui string gaps, T39's included: Copy keys added by the amendment. **FU-9** the sample document's intro, it and en: same place.
- [x] "Coverage: ACs and surfaces" updated with AC-9.1–9.6 (S12, S7) and AC-9.11–9.13 (N1).
