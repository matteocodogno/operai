---
spec: 20261112
status: draft
---

# Design: Project hours — time worked against what was sold

Inputs read: `spec.md` (approved 2026-11-26, US-1–US-4, AC-1.1–4.11), `plan.md` (approved; § Architecture, § Who may see what,
§ Consumption, § The hours views, § API contracts), `specs/20261112-time-tracking/ledger.md` (D80), ADR
20261104-host-extension-federated-panel-through-the-shell, `operai-ui/docs/{building-pages,design-system}.md`, `operai-ui/src/index.ts`,
`specs/20261112-time-tracking/design.md` (S1 and S4, whose states and words this design mirrors, never restates) and the code cited in the
inventory. No dev server was running (shell `:5173` did not answer), so nothing was inspected in a browser; every statement about the
current UI is from code.

**Amended 2026-11-26 (ledger D80, as rewritten after the owner saw the layouts drawn):** each of the project page and the deal page gets **one "Hours"
card**, with the breakdown behind a **closed disclosure** ("option 2"). The first draft had two cards on a project (Consumption and Hours); an intermediate
amendment had tabs Overview | Hours, which the owner dropped because the record page would then carry two menus (the tool's section tabs and the page's tablist).
The tabs, `?tab`, the tablist and the banner split are gone; the page is today's page plus this one card. Changed in place: Surfaces, F1–F3, F8, S1, S2, S3,
the inventory, Accessibility, Copy, AC coverage, G5, G6. S4 and G1–G4 are as first drafted.

Library in use: **`@operai/ui`** (the Operai design system, shared by the shell as a Module Federation singleton; AGENTS.md § Tech stack),
Tailwind 4 token utilities, TanStack Router; copy in each app's strings module (`en` plus a complete `it: typeof en`, `selectStrings`).
The project has a design system, so there is **no `## Visual direction`**: the system wins.

Surfaces (all inside existing pages; no new page, no new route, no new tab):

| Surface | App | What |
|---|---|---|
| **Hours card** (`HoursSection`) | projects-ui project page; crm-ui deal page | one `Card` titled "Hours": on a project the consumption block, then the widget; on a deal the widget alone |
| **Consumption block** | projects-ui, inside the project's Hours card | what the terms sold, set against the hours used (US-1) |
| **HostHours widget** | hours-ui `./HostHours`, inside the card | the total recorded, always visible, and a closed disclosure holding the breakdown (US-2) |
| **Hours views, widened** | hours-ui, My hours and Everyone's hours | linked meetings in the project filter, totals, a screen line, the export (US-4) |

Conventions that hold everywhere (not repeated below): all copy is in the strings modules, English and Italian, sentence case
(AC-3.2); a duration only through `formatDuration(ms, { style: 'short' })` ("2 h 30", "30 min"; `spoken` where a screen reader
reads it), a number only through `formatNumber`, a date only through `formatDate`; colour only as token utilities; icons only
through `Icon`; **no amount, price or rate anywhere** (AC-1.8); no figure is summed or sorted in the browser: every figure and
every order is the server's (the widget renders `SummaryAnswer` as sent; `consumption.ts` does one subtraction and one
division over two complete answers, plan § Consumption).

---

## Flows

**F1 Read consumption on the project page — US-1, AC-1.1–1.8, A51.** Entry: a person who can read a project opens it. The Hours card sits right after
Details. When the terms sold something that can be compared, the consumption block at its top asks `GET /time-entries/summary` once (with the package
window when there is a current period) and renders one of four variants. Exits: *loaded* (figures, no action), *unavailable* (the block says so, Retry; the
widget below is unaffected, AC-2.6/4.9). The block has no write and no disclosure of its own.

| Variant | Terms | Shows | ACs |
|---|---|---|---|
| **A** package, current period | `maintenance`/`saas` with an hour package and `currentPeriod` | package hours (+ kind), the period, hours used in it, hours left (negative when exceeded) | 1.1, 1.2, 1.3, 1.6 |
| **B** package, not started | same, `currentPeriod: null` | package hours (+ kind), "Starts on …", a note that earlier hours count in no period; **no request is made** | A51 |
| **C** fixed price | `fixed_price` | man-days used, estimated (only when known), max effort | 1.4, 1.6 |
| **D** time and material | `t_and_m` | man-days used, planned man-days (total of the positions) | 1.5, 1.6 |
| none | no terms (`internal`, or hand-made without), and `maintenance`/`saas` **without an hour package** (G2) | no block: the card is the widget alone (total line and disclosure) | 1.7 |

**F2 Read a project's hours — US-2, US-4, AC-2.1, 2.3, 2.5, 2.6, 2.7, 4.3, 4.9.** Entry: the same card. The widget (loaded through the shell seam when the page
loads) makes **one** `GET /time-entries/summary?projectId=` call and shows, with no click, **the total recorded and the line "Includes the hours recorded on
meetings linked to this project"**, then a closed disclosure. Opening it (F8) shows hours per work type (the meetings' and any untyped hours in the one
"Without a work type" row) and **per person only when the answer carries `byPerson`** (the project's manager, or a holder of see everyone's hours; for a project
awaiting its manager only a holder, AC-2.7; the widget cannot tell why it is absent and says nothing about it). Exits: loaded; empty (no hours yet); unavailable
(hours-api 503 including Meetings unknown, 404, network: **no figure at all**, Retry); the host's own fallback (remote missing, slow or throwing).

**F3 Read a deal's hours — AC-2.2, 2.4, 2.5, 2.6.** Entry: the deal's Hours card (after Meetings, before the timeline). The same widget (`on: 'deal'`), alone in the
card: the total and the inclusion line with no click, the closed disclosure for the rest; per person for the deal's owner or a holder (AC-2.4, 2.5). Linked meetings of
the deal are counted by hours-api (time-tracking AC-2.6).

**F4 Filter the hours views by a project — AC-4.4, 4.7, 4.8, 4.10.** Entry: My hours or Everyone's hours, Project filter
picked. The entries and totals now include the meetings linked to that project; each such entry is listed as a **Meeting** row
with a screen line **"Counts for project <name>"** (the cue; there is no filter-level hint, as the deal filter has none).
A meeting whose project the viewer cannot read keeps its row with "Counts for a project that is not visible to you" and no name.
Exit: *refused* when Meetings cannot say which meetings are linked: Totals and Entries (and the table view's grid) are replaced
by one warning banner, Retry and "Clear the project filter" (the deal filter's refusal, generalised). Without a project
filter nothing is refused: the view answers, and the unknown link is said (F5).

**F5 Totals by project — AC-4.5, 4.10.** Group by Project: a meeting entry is counted under its project; one on a project the viewer
cannot read joins the existing "Projects not visible to you" row; when Meetings cannot be asked the meeting hours form
one row "Meetings whose project is unknown right now" and a polite banner says so (the deal grouping's twin).

**F6 Export — AC-4.6, 4.7.** The workbook gains **Counts for project**, so the file summed by it equals F5.

**F7 My hours, table view — AC-4.11.** No UI change: a project-linked meeting's hours stay on the meeting's row. A test pins it
(`tableGrid.ts` `rowOf` keys by the entry's own target, lines 54–64).

**F8 Open and close the breakdown — D80 (no AC: "the breakdown is on the page, one click away").** Entry: the Hours card's **Show breakdown** button, on the
project page and on the deal page. Steps: press it (click, Enter or Space) → the work-type table (and the person table when allowed) appears below the button, the
button reads **Hide breakdown**, focus stays on it; press again → the region hides, the button reads Show breakdown. **No request is made either way** (the one
summary call already carried both groups). The state is the widget's own: closed on every load, not in the address, reset by a reload and by a different record,
kept while the page stays and the widget stays mounted.

**Not a flow:** AC-3.1 (no write route, data only from time tracking and the terms) and AC-4.1/4.2 (what counts, and when a relink
takes effect) have no UI surface of their own: they are visible only through the figures above. AC-2.7 changes what is absent, never
what is shown.

---

## Screens & states

### S1 Project page — the Hours card (projects-ui)

The page is today's page plus one card. Its column of cards (`ProjectDetailPage.tsx:188-282` today: Details, Team, Tasks, Meetings, Purchase order | Terms):

```
… banners (stale, saved, read-only, awaiting, deal-not-won) …   header actions (Record hours, state actions): unchanged
Details                      (unchanged)
Hours                        NEW — one card: consumption block (if any) + the widget (total, closed breakdown)
Team · Tasks · Meetings      (unchanged)
Purchase order | Terms       (unchanged)
```

Why here: consumption is the figure a project manager opens the page for ("act before it runs out") and the owner kept it visible at a glance (D80), so the
card follows the details, where the first draft put Consumption. The Terms card the block compares with is the last card; the block names what it compares with, so it needs no
adjacency. A project with no terms shows Details, Hours, … (AC-1.7).

**Closed, with a comparable package (variant A):**

```
┌ Hours ─────────────────────────────────────────────────────────────────┐
│ Yearly package    Current period            Hours used in this period    Hours left │
│ 120 h             01.03.2026 – 28.02.2027   84 h 30                      35 h 30    │
│ Hours left in a period do not carry over to the next one.               │
│ ─────────────────────────────────────────────────────────────────────── │
│ Total recorded                                                           │
│ 84 h 30                                                                  │
│ Includes the hours recorded on meetings linked to this project.          │
│ [ v Show breakdown ]                                                     │
└────────────────────────────────────────────────────────────────────────┘
```

**Open** (the same card, the button now "Hide breakdown" with the up chevron, the region below it):

```
│ [ ^ Hide breakdown ]                                                     │
│ By work type                                                             │
│   Work type                                              Time            │
│   Development                                            40 h            │
│   Without a work type                                    32 h 30         │
│ By person           ← only when the answer carries byPerson              │
│   Person                                                 Time            │
│   Anna Rossi                                             50 h            │
```

Anatomy, top to bottom, inside one `Card title="Hours"` (h3, `data-testid="project-hours"`):

1. **Consumption block** (projects-ui; absent when there is no comparable variant): a `FactList` (figures in `font-mono`, a one-line hint under it in `text-xs text-soft`).
   Wrapper: `role="group"`, `aria-label` "Consumption", `tabIndex={-1}` (the target of focus after a Retry). **No visible heading of its own**: the card's title is
   the heading, and the first fact's term ("Yearly package", "Man-days used") says what it is.
2. **A divider** (`border-t border-rule`, token utilities) **only when both parts are shown**.
3. **The widget** (hours-ui `HostHours`, through the seam): total fact, inclusion line, disclosure button, the closed region (S3).

The three variants besides A:

```
B  Capacity package   Starts on                                  C  Man-days used   Estimated man-days   Max effort
   120 h              01.03.2027                                     7.5 man-days    10.0 man-days        12.0 man-days
   Hours recorded before the start date do not count against        Counts all the hours recorded on the project. One man-day is 8 hours.
   the package.                                                     ("Estimated man-days" is omitted, not "None", when the terms carry none, AC-1.4)
D  Man-days used   Planned man-days
   7.5 man-days    24.0 man-days
   Compared with the total of all positions. One man-day is 8 hours.
   Capacity (variant A): terms "Capacity package" · "Package period" 01.03.2026 – 30.09.2026 (or "From 01.03.2026, no expiry") · "Hours used" · "Hours left"; no carry-over note.
   Exceeded: the last fact reads  −4 h 30  (a real minus sign, G1); spoken "4 hours, 30 minutes over".
```

Rules and decisions for the consumption block:

- **Units** (A33, AC-1.6): hours for a package (`formatDuration` short: "120 h", "84 h 30", "0 min"), man-days for fixed price and
  time-and-material through `formatNumber` with exactly one decimal (`minimumFractionDigits: 1`, `maximumFractionDigits: 1`), the unit
  word from the existing `strings.terms.details.manDays`. Note: the Terms card shows its own man-days without a forced
  decimal (`TermsDetails.tsx:6`, "10 man-days"); the block forces one, because AC-1.6 asks for it, and so shows "10.0" a few cards from it. Kept, recorded here.
- **No positions table, no per-position figure** (AC-1.5, D13). **No money** (AC-1.8): the block imports no money formatter.
- **Yearly vs capacity wording.** The kind is the first fact's term (the existing `terms.details.kinds`: "Yearly package" /
  "Capacity package"). Yearly: "Current period" with both dates, "Hours used in this period", the carry-over note (AC-1.2, D28).
  Capacity: "Package period" with both dates, or "From <start>, no expiry" without an expiry (the block never shows `currentPeriod.to`
  there, which is today), "Hours used" (AC-1.3).
- **Zero is a figure, not an empty state:** "0 min used", the whole package left. The block has no empty state.
- **"Exceeded" has no status colour and no badge** (decision). Reasons: the spec asks for a negative figure, not a colour (AC-1.1);
  raising attention on these figures is project-alerts' job (non-goal, D34) and a coloured card now would be an alert by another
  name that project-alerts would have to undo; the status dictionary has no meaning for it (`failed` is "ended badly", `attention`
  carries the wrench of "in repair") and the error colours have their own meanings (orange: try again, red: fix this). The sign carries it,
  with a spoken twin so it is not a lone "−" (see Accessibility). **Which tokens may be text, if the owner wants a cue later:** only
  `--org-text` / `--red-text` through a component (`StatusBadge status="attention"`, never `failed`); the bare `--org` / `--red`
  are not text colours (light-theme contrast), and `--muted` never is.
- **No progress bar** (considered): no AC asks for it, the library `ProgressBar` has one fixed accent fill and clamps at its maximum,
  so an exceeded package would read as a full, healthy bar.
- **"Hours used in this period" beside "Total recorded"** is intended (period against all time); the labels say which is which, and "Total recorded" is all time on purpose (AC-2.1).

**States — which part owns which, in one card.** The card frame and its title are the section's own and **are always shown, in every state**, so the heading survives whatever
happens to either part (the rule of `MeetingsSection.tsx:10`). Each part is complete or absent: no part ever shows a figure it could not read.

| Part | Loading | Loaded | Empty | Error / fallback |
|---|---|---|---|---|
| **Consumption block** | the page's own `Loading` (`LoadState.tsx:8-18`): polite "Loading consumption…", two skeleton rows | variant A, C or D; variant B is static and **never makes a request**, so it has no loading or error | none (zero is a figure); no variant: the block is absent | `Banner tone="warning"` (alert), title "Consumption is unavailable", body "Operai could not load the hours recorded on this project, so no comparison is shown rather than one that could be too low. Try again in a moment.", Retry. **No hours figure, no remaining figure** (AC-4.9); the sold figures are not repeated (the Terms card holds them) |
| **Widget** | the seam or the module loading: the host's `Loading` with one skeleton row; then the widget's own (S3): a single skeleton row, no button yet | S3: total line, inclusion line, disclosure | S3: total "0 min" and one sentence, **no disclosure** | the host fallback (`Banner tone="info"`, "Hours are unavailable. Reload the page to try again.", no Retry) or the widget's own warning with Retry (S3) |

The two parts read independently (the block asks the summary with the window, the widget without), so the cases are real:

- **Block fails, widget loads:** the card shows the block's warning in the first slot, then the total line and the disclosure as usual. The total is a complete figure from its own successful read, so AC-4.9 holds.
- **Widget fails (or falls back), block loads:** the card shows the consumption facts, then the widget's banner in the second slot: no total line and no disclosure.
- **Both fail** (the common case when hours-api or Meetings is down: one cause): two warning banners, each with its own Retry. The parts do not coordinate: the widget's props are plain strings and nothing comes back across the seam (ADR 20261104-host-extension-federated-panel-through-the-shell), so a single shared message is not possible. Recorded, not hidden.
- **Project with no comparable terms (AC-1.7, G2):** no block and no divider; the card is the widget alone, "Total recorded", the inclusion line and the disclosure.

Retry (either part): that part shows its loading state; when the answer arrives (either outcome) focus moves to **that part's wrapper**, so a keyboard user is not left on a button that no longer exists; on failure the alert is announced again and the wrapper holds it.

**`HoursSection` (host, projects-ui)** — the `MeetingsSection` shape (`MeetingsSection.tsx:41-57`) with one difference: it owns the **whole card**, and `HostExtension`'s `loading` and `fallback` are the *widget's slot*, not a replacement card
(`MeetingsSection`'s `MeetingsCard` wraps its fallback; here the frame, the consumption block and the divider stay put while only the widget's slot changes):

```
<Card title="Hours">
  <ConsumptionBlock />                       (when there is a variant)
  <ExtensionContain …>                       (the seam: useExtensionSeam → HostExtension name="hours.hostHours"
    <HostExtension props={{ on: 'project', targetId }} loading={…} fallback={…} />    resetKey = project id)
  </ExtensionContain>
</Card>
```

Tone choice, recorded: the host fallback is **info** with "reload" because nothing in the page can retry a failed import (a failed module import is cached; the Meetings fallback's tone and shape);
the widget's own failure (S3) is **warning** with Retry because it can (orange means "try again", design-system § Error colour). The seam is imported once per page by
`useExtensionSeam`, which the header's Record hours and the Meetings card already use.

The card is shown to everyone who can read the project (AC-2.1); there is no permission check in the host, only the server's.

### S2 Deal page — the Hours card (crm-ui)

One `Card title="Hours"` in `DealDetailPage.tsx`, **after the Meetings card and before the activity timeline** (`:263-264`; the order today is Details, Estimate, Offers, Delivery, Attachments, Meetings, Timeline): the two federated
panels sit together and the long timeline stays last. It holds **the widget alone**: no consumption block (no AC), no divider.

```
┌ Hours ─────────────────────────────────────────────────────────────────┐
│ Total recorded                                                           │
│ 12 h 30                                                                  │
│ Includes the hours recorded on meetings linked to this deal.             │
│ [ v Show breakdown ]                                                     │
└────────────────────────────────────────────────────────────────────────┘
```

Props `{ on: 'deal', targetId: deal.id }`, `resetKey = deal.id`. States as the widget row of S1's table: host loading (one skeleton row), host fallback (info, reload), the widget's own states (S3). Everyone who can read the deal sees the
card (AC-2.2); the deal's owner or a holder also gets the person table when the disclosure is open (AC-2.4, AC-2.5). Copy in `strings.deals.hours`.

### S3 `HostHours` — hours-ui widget (`./HostHours`, `hours.hostHours`)

A read widget with one disclosure; no card of its own (the host's card frames it; cards are never nested). It renders text only, never an `href` from a name (plan § Security). It throws at render on an invalid prop set
(`on` not `project|deal`, empty `targetId`), so the host's fallback shows (the `RecordHoursModel.checkProps` rule, `RecordHoursModel.ts:44`).

**Props stay `{ on, targetId }`: no new prop.** The disclosure starts closed (D80) and its state is the widget's own, so nothing about it crosses the seam; the heading levels are fixed (both hosts' cards are `Card`
h3, so the open region's "By work type" / "By person" are h4 on both pages), so a `headingLevel` prop would only widen a seam that is two plain strings for no case that exists. Add a plain-string prop then, if a host ever needs one.
**It makes one summary call when it mounts** and none when the disclosure opens (`byWorkType` and `byPerson` came with the one answer); it resets its data and its disclosure when `on` or `targetId` changes, and keeps them across the host's re-renders.

Anatomy (loaded, total > 0):

```
Total recorded                                           ← FactList, one fact (the Totals card's pattern, TotalsCard.tsx:99-102)
84 h 30                                                  ← Duration (short for the eye, spoken for the reader, EntryRow.tsx:31)
Includes the hours recorded on meetings linked to this project.      ← text-xs text-soft, always shown
[ v Show breakdown ]                                     ← the disclosure button (ghost, sm); "Hide breakdown" and the up chevron when open
┌ region id=…  (always in the DOM; `hidden` while closed) ───────────────────────────┐
│ ( info note: names could not be loaded )           ← only for unavailable ∋ "identities"   │
│ By work type  (h4)  → DataTable: Work type | Time                                         │
│ ( info note + Retry: breakdown by person could not be checked ) ← only for ["authz"]       │
│ By person  (h4)     → DataTable: Person | Time                                            │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

The disclosure:

- **The button** is a library `Button` (`variant="ghost"`, `size="sm"`) with the `Icon` chevron (`chevron-down` closed, `chevron-up` open; decorative) and the label **"Show breakdown" / "Hide breakdown"**; `aria-expanded` is the state and
  `aria-controls` the region's id. It is a plain toggle (not `aria-haspopup`, which is for dialogs). One disclosure per card, so its name needs nothing more.
- **The region** is always mounted and `hidden` while closed (the `DockAgenda.tsx:47-58` pattern), so `aria-controls` always names a real element, the closed tables are not in the tab order or the accessibility tree, and opening costs no remount.
- **Closed by default**, on every load; not in the address; not remembered across reloads (D80). No auto-open for the project manager.
- **Focus:** pressing the button never moves focus: it stays on the button, whose label and `aria-expanded` change, which a screen reader announces. Nothing is announced through a live region for it. Tab from the button reaches, when open, the first table's scroll region.
  Escape does nothing (it is a disclosure, not a popup).
- **No tab for it:** while closed the region is skipped by Tab, by the page's find and by a screen reader's virtual cursor.

The rows of the open region:

- **By work type** — `DataTable` (columns Work type, Time `numeric`), rows in the server's order (minutes descending, "Without a work type" last), a retired work type suffixed with the existing `strings.entries.retired`, a keyed row whose label
  is null as `strings.totals.nameUnavailable`. The "none" group is one row of its own (AC-2.1). `labelledBy` is the visible h4, so the table is named by what is on screen.
- **By person** — same table, columns Person, Time. A name is `personName(label, status)` (`PersonFilterOptions.ts:18`: "Unknown user" when the name could not be read, "(deactivated)" for a closed account). Present only when `byPerson` is not null
  (AC-2.3–2.5, 2.7); its absence has no placeholder, no lock icon and no sentence, so a reader is not told that others see more.
- **Numbers** — right-aligned DM Mono tabular figures, which `DataTable` `numeric` gives; no row is added up or re-ordered here.

States (exactly one body; the root is always mounted):

| State | Render |
|---|---|
| loading (first read, or after Retry) | one `Skeleton` row and the polite line "Loading hours…" (`VisuallyHidden live`); **no button yet**, because there is nothing to disclose |
| loaded, total > 0 | the total fact, the inclusion line, the closed disclosure |
| empty (`totalMinutes` 0) | the total fact reads "0 min" and, instead of the inclusion line, one sentence in `text-sm text-soft`: "No hours recorded yet. Hours recorded on this project, or on meetings linked to it, appear here." **No disclosure** (nothing to disclose). Compact on purpose: a `StatePanel` is a centred block that would dominate a card of two lines, on every deal that has no hours; the Totals card's own empty line (`TotalsCard.tsx:143-147`) is the precedent, and here the line sits under a fact, not alone |
| error (503 `host_unavailable` — Meetings unknown, the owner, anything — 404, network) | `Banner tone="warning"` (alert), title "Hours are unavailable", body "Operai could not load these hours, so no figure is shown rather than one that could be too low. Try again in a moment.", Retry. **No total, no button, no table** (AC-2.6, AC-4.9) |
| `unavailable: ["identities"]` | the figures are complete: the names read "Unknown user"; one `Banner tone="info" live="polite"` **inside the open region**, above the tables, says what the Entries card says (`strings.entries.banners.unavailable` with `strings.names.sources.identities`). It is about the names, which are in the breakdown |
| `unavailable: ["authz"]` (per-person withheld) | no person table; one `Banner tone="info" live="polite"` with Retry **inside the open region**: "The breakdown by person could not be checked right now, so it is not shown." (fail closed is the server's; the note only says why a table a person expected is missing). Closed, nothing shows: the total is unaffected |

Focus: Retry (either banner) → the widget's root (`role="group"`, `aria-label` "Hours on this project" / "… deal", `tabIndex={-1}`) takes focus when the next answer arrives, whatever it is (the button that had focus is gone; the
DealFilterUnavailable precedent). The first load, a host re-render and opening or closing the disclosure never move focus beyond the button the person pressed.

Nothing in the widget changes when someone records hours in place (G5).

### S4 My hours and Everyone's hours — widened by US-4 (hours-ui)

No new screen. What changes, and where (S1 and S4 of the time-tracking design stay as written):

**Project filter refusal (AC-4.8).** `DealFilterUnavailable` becomes the refusal of "a host filter": `kind: 'deal' | 'project'` picks the words
and the test ids; the structure, tone (`Banner tone="warning"`, `role="alert"`), actions (Retry; `ghost` `sm` Clear), the focus rules
and the "pages already shown stay, with the error below them" rule (D48) are exactly the deal's (`DealFilterUnavailable.tsx:24-45`;
`MyHoursPage.tsx:525` (table view), `:610` (list view); `EveryoneHoursPage.tsx:350`). It replaces Totals and Entries (and the table's
grid), never the empty state, never "0 min". Clear returns focus to the **Project** picker's input. If both a deal and a project filter are
set, the project wording shows; clearing it leaves the deal's if the deal filter still triggers the refusal (both depend on the
same Meetings answer), so the person is never shown a filter that is not set. A 409 `project_meetings_changed` (the linked set changed
between pages) is handled like `deal_meetings_changed`: the list restarts from its first page and the polite status says it was refreshed.

**The screen line (AC-4.7).** A Meeting entry carries one line under its name: `Counts for deal <name>` today; now `Counts for project <name>`
when its host is a project, in the same place and style (`EntryRow.tsx:82,104`; `EntriesTable.tsx:64`, the "On" cell). A meeting has one
host, so at most one of the two lines exists.

| `on.project` | Line (EN) | Notes |
|---|---|---|
| `linked` `visible` | Counts for project Alpha | the name as sent, plain text (the deal line is not a link either) |
| `linked` `hidden` | Counts for a project that is not visible to you | no name, no id, no link |
| `linked` `unavailable` | Counts for a project whose name is unavailable | |
| `unknown` | — (see next) | |
| `none` | — | nothing to say |

`unknown` and the deal: both come from the one hosts read (plan (d)), so they are unknown **together**. Two lines saying "the deal … is
unknown" and "the project … is unknown" under one meeting would be noise and half wrong (a meeting has one host), so the existing
unknown line is widened to speak for both, "The deal or project these hours count for is unknown right now", and
`countsForProjectLine` returns `null` for `unknown`. A missing `on.project` (an older hours-api, G4) reads as `none`.

**By-project totals (AC-4.5, 4.10).** `TotalsCardRows.ts:28-43` `mergedWords` gains `project-unknown` for the project grouping:
"Meetings whose project is unknown right now". The merged rows come in the server's order (hidden, unavailable, project-unknown,
none) and are never sorted. `HoursBanners` gains the twin of the deal-grouping note, shown only while grouping by Project and the answer's
`unavailable` carries `meeting-projects` (`MyHoursPage.tsx:319-320`; `HoursBanners.tsx`): `Banner tone="warning" live="polite"`,
"Meeting hours can't be placed under their project right now, so they are shown in one separate row. The total is unchanged." Never an alert:
the totals read fine and only a grouping is degraded.

**Names and sources.** `names.ts` `unavailableSources` knows `meeting-projects` (after `meeting-deals`, `SOURCE_ORDER` `:99-106`); its words
are the same as `meeting-deals`'s, widened to "the deal or project that meeting hours count for", and the banner shows an identical phrase
once, because the two codes always come together. `hasHiddenName` also counts a hidden `on.project` (`:84-87`), so the standing
"Entries without a visible name" note appears when only the project was withheld.

**Export (AC-4.6, 4.7).** One column is added: **Counts for project** (it: *Conta per il progetto*), **after Counts for deal**, so the sheet
has **ten columns** and the new one is the **seventh** (G), the others shifting right: Day, Person, Hours, On, Name, Counts for deal,
**Counts for project**, Category or work type, Activity, Note. `WIDTHS` (`hoursWorkbook.ts:65`) gains a 30. Cell values, as `countsForDealCell`
(`:129-138`) does for the deal:

| Entry | Cell |
|---|---|
| on a project the viewer can read | the project's name |
| on a project that is hidden / unavailable | "Not visible to you" / "Name unavailable" (the shared `strings.names` words) |
| on a meeting whose `on.project` is `linked` visible | the project's name |
| … `linked` hidden / unavailable | "Not visible to you" / "Name unavailable" |
| … `unknown` | "Unknown" |
| … `none`, or on a deal, or on other work | empty |

A project entry therefore has its name in both **Name** and **Counts for project**, as a deal entry does in Counts for deal (D40), and the file summed by
the new column equals the by-project totals (hidden and unknown words are the rows' merged groups).

**Table view (AC-4.11).** Unchanged, pinned by a test (F7).

**Filters card.** Unchanged: the Project picker (`SearchPicker`) already exists; no hint text is added (the deal picker has none, the screen
line is the cue).

---

## Component inventory

Library in use: **`@operai/ui`** (+ Tailwind token utilities), from AGENTS.md and the imports below. REUSE means the library's or an in-repo component used
as is or extended in place; NEW is a component or module that does not exist.

| Element | Component | Reuse / NEW |
|---|---|---|
| The one Hours card, both pages | `Card` (`operai-ui/src/components/Card.tsx`), `title="Hours"` | REUSE |
| Consumption facts, widget total | `FactList` (`FactList.tsx`) | REUSE |
| **The disclosure** | **no disclosure, collapsible or accordion exists in `@operai/ui`** (`src/index.ts`, `src/components/` checked). Built from `Button variant="ghost" size="sm"` + `Icon` (`chevron-down` / `chevron-up`) + native `aria-expanded` / `aria-controls` + a `hidden` region, the pattern of `meetings-ui/src/dock/DockAgenda.tsx:47-58` and `projects-ui/src/components/ProjectFormDialog.tsx:273-284` (and `admin-ui/src/pages/AuditPage.tsx:209`, a row toggle) | REUSE of the library's `Button` and `Icon`; **no new component**: the markup is ten lines private to `HostHours` (below, an observation about lifting it) |
| Work-type and person tables | `DataTable` (`DataTable.tsx`), `labelledBy`, `numeric` | REUSE |
| Unavailable / refusal / notes | `Banner` (`Banner.tsx`), `onRetry`, `live` | REUSE |
| Loading shapes | `Skeleton`, `SkeletonRows`, `VisuallyHidden live` | REUSE |
| Durations, man-days, dates | `formatDuration`, `formatNumber`, `formatDate` | REUSE (G1: one option may be added to `formatDuration`) |
| Project block loading | `Loading` (`projects-ui/src/components/LoadState.tsx:8-18`) | REUSE |
| Seam import, once per page | `useExtensionSeam` (`projects-ui/src/lib/extensionSeam.ts:45-58`; crm-ui's copy, same name) | REUSE |
| Containing the widget's failure | `ExtensionContain` (`projects-ui/src/components/ExtensionContain.tsx`; crm-ui's copy) | REUSE |
| The card and the widget's slot | `MeetingsSection` (`projects-ui/.../MeetingsSection.tsx:9-57`; `crm-ui/.../MeetingsSection.tsx:9-60`) as the shape | **NEW** `HoursSection` ×2 (one per host app): owns the whole card (the frame, the block, the widget's slot) where `MeetingsSection` swaps a whole card; its own heading, copy and extension name; nothing generic to share (each app owns its seam and strings, ADR 20261104-host-extension-federated-panel-through-the-shell: "NOT precedent for shared primitives") |
| Sold-vs-used block | none | **NEW** `ConsumptionBlock` (projects-ui; the plan's `ConsumptionCard`, now a block inside `HoursSection`'s card, not a card): no component compares a term with a figure; built from `FactList` |
| Its arithmetic | — | **NEW** `lib/consumption.ts` (pure, plan): left, man-days in integers, the variant by terms; no UI |
| The widget | `meetings-ui/src/host/HostMeetings.tsx` (the precedent), `RecordHours.tsx` (rules: no router, no `exceljs`, throws on bad props) | **NEW** `HostHours` (+ `HostHoursModel.ts`, hours-ui): total line plus the one disclosure; the Totals card is page-bound (filters, group-by select, router) and cannot be embedded in a host's tree |
| Total of an entry-style duration | `Duration` (`hours-ui/src/components/EntryRow.tsx:31`) | REUSE in `HostHours` (short for the eye, spoken for the reader); the graph test allows `EntryRow`, which pulls no page or `exceljs` |
| Person names | `personName` (`hours-ui/src/components/PersonFilterOptions.ts:18`) | REUSE |
| Group rows | `totalsRows` / `mergedWords` (`TotalsCardRows.ts:28-78`) | REUSE, extended (`project-unknown`) |
| Project-filter refusal | `DealFilterUnavailable` (`hours-ui/src/components/DealFilterUnavailable.tsx`) | REUSE, generalised (`kind`); no `ProjectFilterUnavailable` copy |
| Notes about sources and grouping | `HoursBanners` (`hours-ui/src/components/HoursBanners.tsx`) | REUSE, one more flag |
| Screen line | `countsForDealLine` (`hours-ui/src/lib/names.ts:48-60`), `EntryRow`, `EntriesTable.On` | REUSE, `countsForProjectLine` beside it |
| Export | `hoursWorkbook.ts` (`:25-47`, `:150-193`) | REUSE, one column |
| Table view | `tableGrid.ts` | REUSE, unchanged |
| Retry text | `strings.common.retry` (hours-ui, projects-ui, crm-ui) | REUSE |

**Count:** 24 REUSE or extended in place (12 library pieces, 12 in-repo), **4 NEW** UI pieces (`ConsumptionBlock`, `HostHours`, `HoursSection` in each of two apps) and one pure module (`consumption.ts`). No library component is added, no
route, no tab. **The widget needs no new prop.**

Observations, not scope:

- *The disclosure is now the third hand-made copy* (meetings-ui's dock agenda, projects-ui's form, and this widget), and the design-system rule says a pattern a second app needs goes into the library with a story and a test. Lifting it into `@operai/ui` as a small
  `Disclosure` is a library change that must be live in the shell before a remote uses it (AGENTS.md § Frontend), and nothing in the ACs needs it, so this feature keeps the private markup. *Recommend:* lift it when any of the three is next touched.
- `ConsumptionBlock` needs the "short for the eye, spoken for the reader" figure that hours-ui's `Duration` is; it keeps a private one-line helper rather than lift `Duration` into the library now (same reason). The same "lift when next touched" applies.

UI no AC asks for, **reported, kept small, and droppable on a word from the owner** (nothing else is designed beyond the ACs):

0. **The disclosure** itself is the owner's decision (D80), not an AC ("the breakdown is on the page, one click away"); AC-2.1/2.2's "per work type" is satisfied one click away, and no AC changes.
1. The `["identities"]` and `["authz"]` notes in `HostHours` (plan § API contracts carries them; AC-2.5 only says "no per-person figure"), placed inside the open region.
2. The three one-line hints of the consumption block (carry-over, "before the start date", man-day rule): they state rules AC-1.2, A51 and AC-1.6 set that a reader cannot otherwise see.
3. The inclusion line of `HostHours` (decided on AC-2.1/2.2/4.3).
4. The `projectGrouping` banner in the hours views (the deal grouping's twin; AC-4.10 says only that the view still answers).
5. Retry and the focus rule after it; the compact empty sentence.

Considered and **not** designed: a status colour or badge for an exceeded package, a progress bar, an "expired" cue (G3), a Refresh action (G5), a per-position table, a "counts for project" cell in the table view, a count or a summary on the closed button
("3 work types"), remembering the disclosure across reloads or putting it in the address, opening it by default for the project manager, a `headingLevel` or `defaultOpen` prop, tabs.

---

## Accessibility

Headings: the tool keeps one h1; each record page keeps one h2 (`PageHeader`); the Hours card is h3 (`Card`); the open region's "By work type" / "By person" are **h4** (never a skipped or repeated level). The consumption block has no heading, only a named group.

**The Hours card, closed (the state every load starts in)**
- Reading order: the card's heading, the consumption facts (a `dl`: each figure read with its term), the total fact, the inclusion line, the button. Nothing else is in the tab order but the button (and a Retry when a part failed).
- A duration shows the short text for the eye (`aria-hidden`) and the spoken text for the reader ("84 hours, 30 minutes"); the exceeded "left" figure's spoken text is "4 hours, 30 minutes over", so a sign dropped by a reader cannot turn an overrun into a surplus.
  Man-days are words ("7.5 man-days"), read as written.
- Loading: polite "Loading consumption…" and "Loading hours…" (two lines at most, one per part). Loaded: no announcement (the card is read in place on page load, as the Terms card is; the widget no longer announces its total). Failure: `Banner` `role="alert"`, announced when it appears, no focus move on the first load.
- Contrast: no status colour. Figures are `--text`, hints and the inclusion line `--soft` (`text-soft`), never `--muted`; both themes are the library's.

**The disclosure (S3)**
- A native `button` (library `Button`): reachable by Tab, toggled by Enter and Space, `aria-expanded` true/false, `aria-controls` the region's id (the region stays in the DOM, `hidden` while closed, so the reference is always valid). The label changes ("Show breakdown" / "Hide breakdown"); the chevron is decorative (`aria-hidden`).
- **Focus stays on the button** when it is pressed, open or closed; the change is announced by the button's own state and name, with no live region. A closed region is `hidden`: out of the tab order, out of the accessibility tree, not found by a virtual cursor.
- Open: the region is, in order, the optional names note, h4 "By work type" and its table, the optional per-person note, h4 "By person" and its table. Each `DataTable` has an sr-only `<caption>` ("Hours by work type" / "Hours by person") and `labelledBy` the visible h4; `scope` on every header; the row's name is the row header; Time is `numeric`
  (right-aligned, tabular DM Mono). Each table's scroll region is a tab stop named by its caption (the library's); a long name wraps (`break-words`). No row is a link; nothing in the region is clickable.
- The notes (`identities`, `authz`) are `info` and polite (not alerts: the figures are complete or fail closed); the error is `warning` and an alert.
- Focus after Retry: the part's wrapper (`tabIndex={-1}`, named: "Consumption" or "Hours on this project/deal"). A host re-render and a remount never steal focus. The host's loading and fallback are plain content, not focus targets.
- 320 px: `FactList` wraps to one column; the button and the tables fit (the tables scroll in their own focusable regions); no horizontal page scroll.
- Escape does nothing; there is no popup, no focus trap and no motion to stop under `prefers-reduced-motion`.

**Hours views (S4)**
- The refusal: `Banner` `role="alert"`, `tabIndex={-1}`; it does not take focus when it appears (the person is in the Filters card); after a Retry that failed it takes
  focus (its Retry button is gone); on success focus goes to the Totals heading; Clear goes to the Project picker's input (the deal rules).
- The screen line is a `p` in the meta style under the name (read after it, as the deal line is); hidden and unavailable variants are plain words, never an id.
- The by-project merged rows are table rows like the others, named by their words. The grouping banner is polite, not an alert.
- Export: the existing `ExportButton` contract (busy, status, failure alert); the file's new column header is a plain cell; a note starting with `=` stays text (unchanged).

---

## Copy

Every string below is new or changed; English and Italian, sentence case, in the module named. A function takes the already formatted value.
Italian follows each app's own vocabulary: hours-ui says *riunione* and *opportunità*; projects-ui says *giornate* for man-days and *pacchetto orario*
for the hour package (its existing Meetings card heading says *Meeting*, which this feature does not touch). There are **no tab strings**.

### hours-ui — new `strings/hostHours.ts` (aggregated as `strings.hostHours` in `strings.ts`)

| Key | EN | IT |
|---|---|---|
| `regionLabel.project` | Hours on this project | Ore su questo progetto |
| `regionLabel.deal` | Hours on this deal | Ore su questa opportunità |
| `loading` | Loading hours… | Caricamento delle ore… |
| `total` | Total recorded | Totale registrato |
| `includesMeetings.project` | Includes the hours recorded on meetings linked to this project. | Comprende le ore registrate sulle riunioni collegate a questo progetto. |
| `includesMeetings.deal` | Includes the hours recorded on meetings linked to this deal. | Comprende le ore registrate sulle riunioni collegate a questa opportunità. |
| `show` | Show breakdown | Mostra dettaglio |
| `hide` | Hide breakdown | Nascondi dettaglio |
| `byWorkType.heading` / `.caption` / `.column` | By work type / Hours by work type / Work type | Per tipo di lavoro / Ore per tipo di lavoro / Tipo di lavoro |
| `byWorkType.none` | Without a work type | Senza tipo di lavoro |
| `byPerson.heading` | By person | Per persona |
| `empty.project` | No hours recorded yet. Hours recorded on this project, or on meetings linked to it, appear here. | Nessuna ora registrata finora. Le ore registrate su questo progetto, o sulle riunioni collegate, compaiono qui. |
| `empty.deal` | No hours recorded yet. Hours recorded on this deal, or on meetings linked to it, appear here. | Nessuna ora registrata finora. Le ore registrate su questa opportunità, o sulle riunioni collegate, compaiono qui. |
| `error.title` | Hours are unavailable | Le ore non sono disponibili |
| `error.body` | Operai could not load these hours, so no figure is shown rather than one that could be too low. Try again in a moment. | Operai non è riuscito a caricare queste ore, quindi non mostra nessuna cifra invece di una che potrebbe essere troppo bassa. Riprova tra un momento. |
| `peopleUnavailable` | The breakdown by person could not be checked right now, so it is not shown. | Al momento non è stato possibile verificare il dettaglio per persona, quindi non viene mostrato. |

Reused as they are: `strings.entries.banners.unavailable(…)` with `strings.names.sources.identities`, `strings.everyone.person.unknown` / `.deactivated`,
`strings.totals.columnTime`, `strings.totals.groupBy.person`, `strings.totals.caption.person`, `strings.totals.nameUnavailable`, `strings.entries.retired`, `strings.common.retry`.
(The earlier draft's `announce`, `announceEmpty` and `empty.title` are dropped: the widget no longer announces its total, and its empty state is a sentence.)

### hours-ui — existing modules, additions and changes

| Module · key | EN | IT |
|---|---|---|
| `names` · `countsForProject(name)` | Counts for project ${name} | Conta per il progetto ${name} |
| `names` · `countsForHiddenProject` | Counts for a project that is not visible to you | Conta per un progetto non visibile a te |
| `names` · `countsForUnavailableProject` | Counts for a project whose name is unavailable | Conta per un progetto il cui nome non è disponibile |
| `names` · `countsForUnknownDeal` (**changed**) | The deal or project these hours count for is unknown right now | L'opportunità o il progetto a cui contano queste ore al momento non è noto |
| `names` · `sources['meeting-deals']` (**changed**) and `sources['meeting-projects']` (new, same words) | the deal or project that meeting hours count for | l'opportunità o il progetto a cui contano le ore delle riunioni |
| `totals` · `rows.project.projectUnknown` | Meetings whose project is unknown right now | Riunioni il cui progetto al momento non è noto |
| `entries` · `banners.projectGrouping` | Meeting hours can't be placed under their project right now, so they are shown in one separate row. The total is unchanged. | Al momento le ore delle riunioni non possono essere attribuite al loro progetto, quindi compaiono in una riga separata. Il totale non cambia. |
| `entries` · `projectFilterUnavailable.title` | Hours on this project can't be shown right now | Al momento non è possibile mostrare le ore di questo progetto |
| `entries` · `projectFilterUnavailable.body` | Operai could not check which meetings belong to this project, so a list or total would be incomplete. Nothing is shown until it can. Try again in a moment. | Operai non è riuscito a verificare quali riunioni appartengono a questo progetto, quindi un elenco o un totale sarebbero incompleti. Non viene mostrato nulla finché non è possibile. Riprova tra un momento. |
| `entries` · `projectFilterUnavailable.clear` | Clear the project filter | Rimuovi il filtro progetto |
| `export` · `workbook.columns.countsForProject` | Counts for project | Conta per il progetto |

Test ids added: `hours-project-filter-unavailable` (with `-retry`, `-clear`; the deal's keep theirs), `hours-host-hours` (root), `hours-host-hours-total`, `hours-host-hours-toggle`,
`hours-host-hours-breakdown` (the region), `hours-host-hours-work-types`, `hours-host-hours-people`, `hours-host-hours-error`, `hours-host-hours-empty`.

### projects-ui — `strings/project.ts`, next to `project.meetings` (no aggregator change)

| Key | EN | IT |
|---|---|---|
| `hours.heading` (the card's title) | Hours | Ore |
| `hours.loading` (the widget's slot while the seam loads) | Loading hours… | Caricamento delle ore… |
| `hours.unavailable` (the host fallback) | Hours are unavailable. Reload the page to try again. | Le ore non sono disponibili. Ricarica la pagina per riprovare. |
| `consumption.label` (the group's accessible name, never drawn) | Consumption | Consumo |
| `consumption.loading` | Loading consumption… | Caricamento del consumo… |
| `consumption.unavailable.title` | Consumption is unavailable | Il consumo non è disponibile |
| `consumption.unavailable.body` | Operai could not load the hours recorded on this project, so no comparison is shown rather than one that could be too low. Try again in a moment. | Operai non è riuscito a caricare le ore registrate su questo progetto, quindi non mostra nessun confronto invece di uno che potrebbe essere troppo basso. Riprova tra un momento. |
| `consumption.currentPeriod` (yearly) | Current period | Periodo in corso |
| `consumption.packagePeriod` (capacity) | Package period | Periodo del pacchetto |
| `consumption.range(from, to)` | `${from} – ${to}` | `${from} – ${to}` |
| `consumption.since(from)` | From ${from}, no expiry | Dal ${from}, senza scadenza |
| `consumption.startsOn` | Starts on | Inizia il |
| `consumption.hoursUsedInPeriod` / `.hoursUsed` / `.hoursLeft` | Hours used in this period / Hours used / Hours left | Ore usate nel periodo / Ore usate / Ore rimaste |
| `consumption.leftSpoken(spoken)` / `.overSpoken(spoken)` | `${spoken} left` / `${spoken} over` | `${spoken} rimaste` / `${spoken} in più` |
| `consumption.yearlyNote` | Hours left in a period do not carry over to the next one. | Le ore non usate in un periodo non passano a quello successivo. |
| `consumption.notStartedNote` | Hours recorded before the start date do not count against the package. | Le ore registrate prima della data di inizio non contano per il pacchetto. |
| `consumption.manDaysUsed` | Man-days used | Giornate usate |
| `consumption.fixedPriceNote` | Counts all the hours recorded on the project. One man-day is 8 hours. | Conta tutte le ore registrate sul progetto. Una giornata equivale a 8 ore. |
| `consumption.timeAndMaterialNote` | Compared with the total of all positions. One man-day is 8 hours. | Confrontato con il totale di tutte le posizioni. Una giornata equivale a 8 ore. |

Reused from `strings.terms.details`: `kinds` (the package kind as the first fact's term), `estimatedManDays`, `maxEffortManDays`, `plannedManDays`,
`manDays(value)`; and `strings.common.retry`. Test ids: `project-hours` (the card), `project-hours-consumption`, `project-hours-consumption-facts`, `project-hours-consumption-unavailable`, `project-hours-unavailable` (the host fallback).

### crm-ui — `strings/deals.ts`, next to `deals.meetings`

`deals.hours.heading` Hours / Ore, `.loading` Loading hours… / Caricamento delle ore…, `.unavailable` Hours are unavailable. Reload the page to try again. /
Le ore non sono disponibili. Ricarica la pagina per riprovare. Test ids `crm-deal-hours`, `crm-deal-hours-unavailable`.

Parity (`catalogGaps`) and the hardcoded-copy scan apply in all three apps (AC-3.2).

---

## AC coverage and scope

| AC | Surface |
|---|---|
| 1.1, 1.2, 1.3 | consumption block, variant A (and B for before the start), in the project's Hours card |
| 1.4, 1.5, 1.6 | variants C, D; the man-day formatting |
| 1.7 | no consumption block; the card is the widget alone: its total line, visible with no click, is "only the total hours recorded" (the disclosure adds the breakdown, one click away) |
| 1.8 | no money in any surface; the block imports no money formatter |
| 2.1, 2.2 | the widget: total recorded visible with no click; per work type (with the "without a work type" row) in the disclosure, one click away; project page and deal page |
| 2.3, 2.4, 2.5, 2.7 | the widget's person table, in the disclosure, present or absent as the answer says; no copy about the absence |
| 2.6, 4.9 | host fallback, widget error, block unavailable: no figure from a part that failed, and the rest of the page, the header and every other card untouched; the card keeps its title |
| 3.1 | **no UI surface** (a data and route rule) |
| 3.2 | the Copy section; formatters only |
| 4.1, 4.2 | **no UI surface of their own** (counting rules); visible through every figure |
| 4.3 | widget and block figures; the inclusion line |
| 4.4 | S4 filter, the screen line |
| 4.5, 4.10 | S4 by-project totals, `project-unknown`, the grouping banner |
| 4.6 | S4 export column |
| 4.7 | S4 hidden / unavailable lines, totals row, export cells |
| 4.8 | S4 project-filter refusal |
| 4.11 | S4 table view, unchanged |
| A51 | variant B |
| D80 (no AC) | one Hours card per page, breakdown behind a closed disclosure; consumption stays visible at a glance; no AC changes |

---

## Gaps

Found in the spec or the plan; recommendations only, nothing is designed around them except where the text above says so.

**G1. AC-1.1 asks for "negative when exceeded" but `formatDuration` clamps a negative duration to zero.**
`operai-ui/src/lib/format.ts:131-155` ("a negative duration is shown as zero"), so "hours left" through the library formatter (AC-3.2) shows `0 min` and hides
the overrun. A hand-built minus would break "never format by hand". This design shows "−4 h 30". *Recommend (a):* add a `signed` option to `formatDuration`
(`short` and `spoken`, the minus from the library's own `minus()`), with a story and a test, shipped before projects-ui uses it (the live-shell rule of
AGENTS.md § Frontend); or *(b), the least invasive, if the owner prefers no library change:* amend AC-1.1 to "hours left, or the hours the package is exceeded by",
and the row's label becomes "Over by" with the absolute figure. Needs a decision before the block's task.

**G2. Terms that sold nothing comparable are not in the plan's table.** A `maintenance`/`saas` project with an SLA and **no hour package** (allowed:
`maintenance_needs_sla_or_hours`, `projects-ui/src/strings/terms.ts:122`) has terms, but AC-1.7 covers only "no terms", and AC-1.1 only "has an hour
package". This design shows no consumption block (the card is the widget alone). *Recommend:* reword AC-1.7 / the plan's table row "no terms" to "no terms, or terms with nothing to compare".

**G3. After a capacity package's expiry the block cannot say so.** `packagePeriod` keeps `[start, expiry]` as the final figure (plan § Consumption), so
"Hours left" reads like a live package; the page has no business day to compare `expiryDate` with (projects-api owns the Europe/Zurich rule). *Recommend:*
`currentPeriod` gains `ended: boolean`, derived by the same `packagePeriod(hourPackage, today)`, and the block then shows `StatusBadge status="voided"`
"Expired" beside the period (the dictionary's meaning for it); or accept that the two dates are the whole signal.

**G4. Version skew between deploy steps 2 and 4.** The plan deploys hours-ui (step 2) before hours-api (step 4), but a meeting entry's `on.project`
exists only once hours-api ships. Plan R4 covers `project-unknown`, not a **missing `on.project`**. *Recommend:* hours-ui reads an absent `on.project` as `{ state: "none" }`
(types, `countsForProjectLine`, the export cell, `hasHiddenName`), with a test; state it in the plan's § Deploy order.

**G5. The card's figures are stale after "Record hours" on the same page, until reload.** Record hours (in the page header) records through hours-api and, by design,
"nothing else on the page changes", nothing comes back (specs/20261116-record-hours-in-place AC-4.3, ADR 20261116-record-hours-widget-through-the-host-extension-seam),
so the consumption block, the total line and the breakdown keep the values they loaded with, and a person who just recorded two hours sees no change in the Hours card two cards below the button. The disclosure's open or closed state does not refresh them either (opening makes no request).
There is no tab or remount to give a free refresh. *Recommend:* accept for this release and say so in the release note (least invasive); if not acceptable, the fix is a seam change (an event the widget raises and the card listens to), which amends that ADR and is not this feature's to decide. No Refresh button is designed.

**G6. The plan's components table and test rows still describe two cards; nothing else changes.** The plan (§ Components, the projects-ui rows (a) `HoursSection` and (b) `ConsumptionCard`, and the hours-ui row (a) `HostHours`; § Test strategy rows AC-1.1, 1.4, 1.5, 1.7, 2.1, 2.6) says the `ConsumptionCard` is its own card "shown when the project has terms" next to a separate `HoursSection` card,
and that `HostHours` renders "total, per work type, per person". Now: `HoursSection` owns **one** card whose first part is a `ConsumptionBlock` (not a card) and whose second is the widget, and `HostHours` renders the total line always and the
per-work-type and per-person tables behind its own closed disclosure (local state, no request). *Recommend:* amend those table rows and test rows only (component tests: "block fails, widget loads", "widget fails, block loads", "no comparable terms: widget alone", "breakdown closed on mount and opens with no new request", "person table only when `byPerson`"). **No change** to routes,
the API, R3 (a project page still makes two summary calls, a deal page one), the deploy order or the ADRs. The ledger's D80 already records the decision.

(Not gaps, recorded: the export has **ten** columns, the new **Counts for project** being the seventh, after Counts for deal, not the tenth; `meeting-deals` and `meeting-projects`
always come together because they share one hosts read, which the plan states in § The hours views and this design relies on for the single unknown line and the single source phrase.)

## Gap resolutions (the owner, 2026-11-26, while deriving the tasks — ledger D81–D84)

These override the text above where they differ; S1's sketch, its "Exceeded" line and the copy rows named here are superseded.

- **G1 → "Over by", no minus (D81, AC-1.1 amended).** Once a package is exceeded, the last fact's term changes from "Hours
  left" to **"Over by"** and its value is the absolute duration through `formatDuration` (no library change, no hand-built
  minus): `Hours used in this period 124 h 30 · Over by 4 h 30`. Copy: `consumption.overBy` "Over by" / "Sforato di" replaces
  `consumption.overSpoken`; `consumption.leftSpoken` is dropped (the term itself says left or over, so the value needs no
  spoken twin). No colour and no badge, as before.
- **G2 → AC-1.7 reworded (D82).** Terms that sold nothing to compare with (an SLA and no hour package) show no consumption
  block: the Hours card is the widget alone, as already designed.
- **G3 → "Expired" badge (D83, AC-1.9).** When `currentPeriod.ended` is `true` (a capacity package past its expiry), the
  consumption block shows `StatusBadge status="voided"` labelled **"Expired" / "Scaduto"** right after the period's dates;
  the facts stay as they are (the final figure of the package). The word follows the suite: `expired` (admin-ui
  invitations, `voided`) is something no longer valid after a date, `overdue` (tasks, `attention`) is work late to do.
  Copy: `consumption.expired` "Expired" / "Scaduto" in projects-ui `strings/project.ts`.
- **G4 → plan § Deploy order (no owner decision needed).** A missing `on.project` reads as `{ state: "none" }`.
- **G5 → the figures follow a Record hours save (D84, AC-2.8; plan D-P6).** After a save with Record hours on the same page,
  `HostHours` and `ConsumptionBlock` re-read (they listen for `operai:time-entry-recorded` naming their target). The re-read
  keeps what is on screen until the answer arrives (no skeleton, no layout jump), then replaces the figures; a failed
  re-read shows the part's usual warning banner with Retry. Nothing is announced beyond what each part already announces;
  the breakdown keeps its open or closed state.
- **G6 → done** (the plan's components table and test rows were amended for D80).

---

## Self-critique

One pass against the design.md checklist, over the D80 rewrite (one card, closed breakdown). **Fixed:** (1) the widget's empty state was a centred `StatePanel`, which would dominate a two-line card on every deal with no hours: now a total "0 min" plus one sentence and no disclosure; (2) the names and per-person notes
sat above the tables and would have shown on a closed card: moved inside the open region, where the thing they explain is; (3) the widget still announced its total on load, which, with the card now read in place like the Terms card, is noise: dropped (focus after Retry carries it); (4) `MeetingsSection`'s fallback replaces a whole card, which here would have hidden the consumption block when only the widget failed: the
frame, the block and the widget's slot are separated, and the four combinations of failure (block, widget, both, neither) are written down with what each shows; (5) a conditional render of the region would have left `aria-controls` pointing at nothing: the region stays mounted and `hidden`; (6) the consumption block had a card title of
its own inside a card titled "Hours": now a named group with no visible heading. **Kept, reported instead:** the disclosure is the third hand-made copy of the pattern (library lift recommended, not in scope); two banners when both parts fail (cannot be one, props are plain strings); the disclosure, the notes, the hints and the grouping banner are UI no AC asks for (listed, droppable); AC-3.1 and AC-4.1/4.2 have no UI surface (stated);
G1–G6 are for the owner or the plan, not design choices.
