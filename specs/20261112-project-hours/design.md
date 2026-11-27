---
spec: 20261112
status: draft
---

# Design: Project hours — time worked against what was sold

Inputs read: `spec.md` (approved 2026-11-26, US-1–US-4, AC-1.1–4.11; re-opened and approved again 2026-11-27 for US-5, AC-5.1–5.29, and amended at gate 2 the same day by D95–D96: AC-5.9's words), `plan.md` (approved 2026-11-26; § Architecture, § Who may see what,
§ Consumption, § The hours views, § API contracts; and its seventh amendment of 2026-11-27: § Signals on the consumption block, § Deploy order, D-P7–D-P9, R9–R13, approved at gate 2 on 2026-11-27),
`specs/20261112-time-tracking/ledger.md` (D80, D86–D96, F16–F21, A53–A56), ADR 20261104-host-extension-federated-panel-through-the-shell,
`operai-ui/docs/{building-pages,design-system}.md`, `operai-ui/src/index.ts`, `operai-ui/src/styles/tokens.css` (the tokens and the `@theme inline` map), `operai-ui/eslint/design-tokens.ts` (what the
lint refuses), `specs/20261112-time-tracking/design.md` (S1 and S4, whose states and words this design mirrors, never restates) and the code cited in the inventory. For the original design no dev server was
running. For the US-5 amendment the shell answers on `:5173` but redirects to the OAuth sign-in (no seeded session), so again **nothing was inspected in a browser**: every statement about the current UI is from code.
The owner's mock (option C) is a design canvas this design could not read; what it drew is taken from the brief (state line, bar on 0–125 % with marks at 80 % and 100 %, estimate mark, today mark, pace line, date line in a
small bordered box). Two things were **measured**, not assumed: the contrast ratios of the tokens (WCAG 2 relative luminance of the hex values in `tokens.css`, § S1.1) and that the bar's utility classes compile
in the repo's own Tailwind (4.3.3, as installed under projects-ui) and are not refused by the lint.

**Amended 2026-11-26 (ledger D80, as rewritten after the owner saw the layouts drawn):** each of the project page and the deal page gets **one "Hours"
card**, with the breakdown behind a **closed disclosure** ("option 2"). The first draft had two cards on a project (Consumption and Hours); an intermediate
amendment had tabs Overview | Hours, which the owner dropped because the record page would then carry two menus (the tool's section tabs and the page's tablist).
The tabs, `?tab`, the tablist and the banner split are gone; the page is today's page plus this one card. Changed in place: Surfaces, F1–F3, F8, S1, S2, S3,
the inventory, Accessibility, Copy, AC coverage, G5, G6. S4 and G1–G4 are as first drafted.

**Amended 2026-11-27 (QE pass 1, defect D1):** S4 said a 409 `project_meetings_changed` restarts the list "and the polite status says it was refreshed". The deal's 409 has no such status (specs/20261112-time-tracking plan, cursor amendment of 2026-11-23: "the list reloads its first page, the export restarts its walk"; its design.md never mentions the 409) and AC-4.8 asks for none, so the sentence described a behaviour the deal never had; the code (`hours-ui/src/lib/useHoursQuery.ts`, `exportPages.ts`) restarts silently for both host filters. Decision: one behaviour for both, the **silent restart**; the status is dropped, not added (nothing is wrong, nothing is for the person to do, and the region's own polite loading line already says the list is being read again). Changed in place: F4 (one sentence), S4 (the 409 sentence became its own paragraph), Accessibility (one bullet). No code change.

**Amended 2026-11-27 (QE pass 2, defect D3):** the sentence D1's fix added to S4 said My hours' table view "has no pages and cannot restart". It restarts: the table's one complete read of the period is the export's walk (`readAllEntries`, called by `readTable` in `MyHoursPage.tsx`), which starts over on both 409 codes, silently, at most three walks in all, and, refused three times, ends in the table's own read-failure state with Retry. A 409 answers only a later page, so only a period that holds more than one page of 500 entries can meet it. D1's decision stands (the silent restart, no status); only the description of the table view changed. Changed in place: S4 (the last sentence of the paragraph D1 added), Accessibility (one clause on the bullet D1 added). F4 speaks only of "the list" and is true as written. No code change.

**Amended 2026-11-27 (US-5, signals on the consumption block: the spec re-opened, AC-5.1–5.29, ledger D86–D94; the plan's seventh amendment; the owner's mock "option C"):** S1's two decisions
"'Exceeded' has no status colour and no badge" and "no progress bar" are **reversed**, as D86 and the plan said they would be. New: § S1.1 (the signals: state line, bar, pace line, excess, date lines; geometry,
tones, icons, contrast, every state per variant, layout at 320/360/1280), F9, the copy keys (`project.consumption.state|pace|bar|dates|excess`), one NEW component (`ConsumptionBar`) in the inventory, the accessibility
rules for the bar and the lines, the AC-5.x rows and gaps G7–G12. In the same pass, the eval's design follow-up (eval-report § Design fidelity): the six passages that § Gap resolutions overrode were checked against this
file (lines 56, 167, 301, 419, 430 and 522, all present as the eval cited them) and **folded in** — F1's variant A row, S1's sketch line, S3's "Nothing in the widget changes", the "Considered and not designed" list, the
spoken-"over" bullet and the `leftSpoken`/`overSpoken` copy row — and four more found on the way were folded too (S1's "Exceeded has no status colour" and "No progress bar" bullets, F1's "none" row, and the AC-coverage
rows that AC-1.7's and AC-1.9's amendments changed). § Gaps now records the resolutions only; § Gap resolutions is gone, with nothing left in the text above for it to override. **Status stays `draft`, on purpose:** design is
ungated unless `/wellforge:design --gate` is used and the owner has not gated it, so by the workflow's convention it never reaches `approved`; the parts for US-1–US-4 were validated by QE (three passes) and the eval, the
US-5 parts are new and not yet implemented, so `draft` is the honest status of the file as a whole. Changed in place: Inputs, Surfaces, Conventions, F1, F9 (new), S1, S3 (one paragraph), the inventory, Accessibility,
Copy (projects-ui), AC coverage, Gaps. No code change.

**Amended 2026-11-27 (gate 2: the plan approved, the owner's D95 and D96; G7–G11 resolved, G12 still open):** the plan's approval and the owner's two decisions answered the gaps the US-5 amendment reported. **G9 → D95:** at exactly 100 % of the reference (the hours used equal it, no excess) the state line says "Limit reached" / "Limite raggiunto"; "Over the limit" / "Oltre il limite" only above the reference; one state, one level, one icon, one tone, two wordings. New copy key `consumption.state.limitReached`; the line picks it from `share.state === 'over'` and `share.excess === null` (S1.1, "The words of the state line"). Changed in place: the tones table, the state line's words, the excess paragraph, the readings, the states table's legend, case 3 and case 4's label (which left the hours between the reference and 101 % of it in neither case), the "not designed" list, Accessibility (one bullet), Copy, AC coverage (AC-5.7–5.9). **G8 → widened and resolved by the plan:** sixteen of the bar's utilities, not six, are new to the suite's sheet, so without the shell rebuilt from the same commit the bar is not drawn at all, not merely plainer (plan § Deploy order, R13); G8's text is corrected, and its class list was checked against the classes S1.1 specifies (no mismatch). **G7 → the plan's AC-5.11 row; G10 and G11 → D96** (the three readings § S1.1 relies on are now confirmed). Each gap keeps its text and ends with its resolution; the gaps' "Open" header and the self-critique's "Kept, reported instead" list no longer present resolved gaps as open. Status stays `draft`. No code change.

Library in use: **`@operai/ui`** (the Operai design system, shared by the shell as a Module Federation singleton; AGENTS.md § Tech stack),
Tailwind 4 token utilities, TanStack Router; copy in each app's strings module (`en` plus a complete `it: typeof en`, `selectStrings`).
The project has a design system, so there is **no `## Visual direction`**: the system wins.

Surfaces (all inside existing pages; no new page, no new route, no new tab):

| Surface | App | What |
|---|---|---|
| **Hours card** (`HoursSection`) | projects-ui project page; crm-ui deal page | one `Card` titled "Hours": on a project the consumption block, then the widget; on a deal the widget alone |
| **Consumption block** | projects-ui, inside the project's Hours card | what the terms sold, set against the hours used (US-1), and, since US-5, its signals: state, bar, pace line, excess, date lines (S1.1) |
| **HostHours widget** | hours-ui `./HostHours`, inside the card | the total recorded, always visible, and a closed disclosure holding the breakdown (US-2) |
| **Hours views, widened** | hours-ui, My hours and Everyone's hours | linked meetings in the project filter, totals, a screen line, the export (US-4) |

Conventions that hold everywhere (not repeated below): all copy is in the strings modules, English and Italian, sentence case
(AC-3.2); a duration only through `formatDuration(ms, { style: 'short' })` ("2 h 30", "30 min"; `spoken` where a screen reader
reads it), a number only through `formatNumber`, a percentage only through `formatNumber(p / 100, { style: 'percent', maximumFractionDigits: 0 })` from an already floored integer (R11), a date only through `formatDate`; colour only as token utilities; icons only
through `Icon`; **no amount, price or rate anywhere** (AC-1.8); no figure is summed or sorted in the browser: every figure and
every order is the server's (the widget renders `SummaryAnswer` as sent; `consumption.ts` does integer arithmetic over two complete answers: one subtraction, one division and, since US-5, the floor and the thresholds, plan § Consumption and
§ Signals).

---

## Flows

**F1 Read consumption on the project page — US-1, AC-1.1–1.8, A51.** Entry: a person who can read a project opens it. The Hours card sits right after
Details. When the terms sold something that can be compared, the consumption block at its top asks `GET /time-entries/summary` once (with the package
window when there is a current period) and renders one of four variants, with its signals (F9). Exits: *loaded* (figures, no action), *unavailable* (the block says so, Retry; the
widget below is unaffected, AC-2.6/4.9). The block has no write and no disclosure of its own.

| Variant | Terms | Shows | ACs |
|---|---|---|---|
| **A** package, current period | `maintenance`/`saas` with an hour package and `currentPeriod` | package hours (+ kind), the period, hours used in it, hours left — or "Over by" the excess once exceeded (D81) — and "Expired" beside the dates when the package has ended (D83); with the signals of F9 | 1.1, 1.2, 1.3, 1.6, 1.9 |
| **B** package, not started | same, `currentPeriod: null` | package hours (+ kind), "Starts on …", a note that earlier hours count in no period; **no request is made**; no share, so no state, bar or pace line; date lines when the terms have an end date to warn about (AC-5.24) | A51 |
| **C** fixed price | `fixed_price` | man-days used, estimated (only when known), max effort, "Over by" once over; with the signals of F9 (the estimate also as a mark on the bar) | 1.4, 1.6 |
| **D** time and material | `t_and_m` | man-days used, planned man-days (total of the positions), "Over by" once over; with the signals of F9 | 1.5, 1.6 |
| none | no terms (`internal`, or hand-made without), and `maintenance`/`saas` **without an hour package** (G2, resolved D82) | no figures, no state, no bar: the card is the widget alone (total line and disclosure) — **unless** the terms have an end date that has passed or is near and the project is not closed or cancelled: then a block of **date lines alone** and the divider (AC-1.7 amended, AC-5.24) | 1.7 |

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
filter nothing is refused: the view answers, and the unknown link is said (F5). A relink between two pages of the list is not an exit the person is told about: the list starts over from its first page, silently (S4).

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

**F9 Read the signals on the consumption block — US-5, AC-5.1–5.29.** Entry: a person who can read a project opens it; the block of F1 is on the page. Nothing is asked of the person and nothing is added to the page's tab
order. Steps: the block's figures arrive (F1); under them the **state line** says on track, close to the limit or over, with the consumed percentage; the **bar** shows the same share on a scale to 125 %, with the estimate
mark (fixed price) and the today mark; the **pace line** says it in a sentence, with the time elapsed when the period or the deadline gives one; the **excess** is the last fact; and, whatever the hours did, a **date line**
says that the deadline or the terms' end date has passed or is near (the terms alone, AC-5.24). Exits: *shown* (any combination of these, by the rules of S1.1); *nothing said* (no terms, nothing comparable, no date to warn
about: F1's "none"); *no state* (an expired capacity package, a closed or cancelled project: the figures and the bar stay, AC-5.25, 5.26); *hours unavailable* (no share, the date lines stay, AC-5.4, 5.24). A save made with
Record hours on the page moves the percentage, the bar, the state, the pace line's used percentage and the excess, and leaves the time elapsed and the date lines as they were (AC-5.28, A52).

**Not a flow:** AC-3.1 (no write route, data only from time tracking and the terms) and AC-4.1/4.2 (what counts, and when a relink takes effect) have no UI surface of their own: they are visible only through the figures above.
AC-2.7 changes what is absent, never what is shown. Of US-5, AC-5.5 and AC-5.6 (the floor and the exact minutes), AC-5.20 (how the time elapsed is counted), AC-5.27 (no per-person figure, the same signals for everyone) and AC-5.29 (the
day every signal reads) likewise decide *what* is drawn and *from which day*, not a surface; AC-5.4 is the absence of the share (F9's exits).

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

**Closed, with a comparable package (variant A, shown here with its signals: close to the limit, half the period gone; the signals' own states and geometry are S1.1):**

```
┌ Hours ──────────────────────────────────────────────────────────────────────
│ Yearly package    Current period            Hours used in this period   Hours left
│ 120 h             01.03.2026 – 28.02.2027   99 h 30                     20 h 30
│ Hours left in a period do not carry over to the next one.
│ 
│ ⚠ Close to the limit                                                   82%
│                          Today
│                            ┆
│   [████████████████████████┃███████████████                    ]
│                                          ┴         ┴          ┴
│                                         80%      100%      125%
│ Used 82% of the hours with 50% of the period elapsed
│ ──────────────────────────────────────────────────────────────────────────
│ Total recorded
│ 99 h 30
│ Includes the hours recorded on meetings linked to this project.
│ [ v Show breakdown ]
└────────────────────────────────────────────────────────────────────────────
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

1. **Consumption block** (projects-ui; absent when there is nothing to say): a named group (`role="group"`, `aria-label` "Consumption", `tabIndex={-1}`, the target of focus after a Retry; **no visible heading of its own**: the
   card's title is the heading, and the first fact's term — "Yearly package", "Man-days used" — says what it is). In order: the `FactList` (figures in `font-mono`) and its one-line hint (`text-xs text-soft`); then,
   since US-5, **the share** — state line, bar, pace line (S1.1) — when the block has one; then the **date lines** (S1.1), which stand alone when there is no share (SLA-only terms, hours loading or unavailable, a package not started).
2. **A divider** (`border-t border-rule`, token utilities) **only when both parts are shown** (`hasConsumptionBlock(terms, state)`, the one rule the block renders by and the divider is drawn by).
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
   Exceeded: the last fact's term changes from "Hours left" to "Over by" and its value is the absolute figure, 4 h 30 (D81, AC-1.1).
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
- **The block now has a status colour and a bar: D86 reverses the first draft (2026-11-27).** The first draft said an exceeded package has no status colour or badge and that the block has no progress bar, because raising attention on
  these figures was project-alerts' job (non-goal, D34). The owner reversed both: the signals are drawn on the project page, in this block and nowhere else (spec non-goal), and they are not alerts (no task, no notification, nothing to
  dismiss). The first draft's reason against a library `ProgressBar` still holds and is why the bar is projects-ui's own (D-P8): it has one fixed accent fill and clamps at its maximum, so an exceeded package would read as a full, healthy bar.
- **"Over by" (D81, was G1):** once a package is exceeded, the last fact's term changes from "Hours left" to **"Over by"** and its value is the absolute duration through `formatDuration`: no negative figure, no hand-built minus (AC-1.1). The
  same word heads the man-day excess of a fixed price and of time and material (AC-5.12).
- **"Expired" (D83, was G3):** when `currentPeriod.ended` is `true` (a capacity package past its expiry) the period fact carries `StatusBadge status="voided"` labelled "Expired" right after the dates, the dictionary's meaning for "no longer
  valid after a date"; the facts stay as they are (the package's final figures) and no state is said (AC-5.25, D91).
- **"Hours used in this period" beside "Total recorded"** is intended (period against all time); the labels say which is which, and "Total recorded" is all time on purpose (AC-2.1).

#### S1.1 Signals on the consumption block (US-5, D86–D94)

The block now also says, under its figures, whether the project is on track, close to what was sold or over it, how much of the period has gone, and whether a date has passed or is near. The look is the owner's mock (option C, D86).
It is drawn by projects-ui alone (D-P8), computes nothing (every value comes from `consumptionOf` and `dateSignalsOf`, D-P9) and adds no request, no tab stop, no route and no `@operai/ui` export. Reading the sketches: ✓ `check`,
⚠ `alert`, ⊗ `x-circle`, ▦ `calendar`; `█` the fill, `▒` the striped part beyond 100 %, `◆` the estimate mark, `┃` and `┆` today. They are schematic; the table of the bar is the geometry.

**Close to the limit** — shown in full under S1's closed card above. **Over, past the end of the scale, with the estimate mark** — a fixed price, 108 h recorded against a max effort of 12.0 man-days (96 h), estimate 10.0, deadline passed, an end date near:

```
┌ Hours ──────────────────────────────────────────────────────────────────────
│ Man-days used   Estimated man-days   Max effort      Over by
│ 13.5 man-days   10.0 man-days        12.0 man-days   1.5 man-days
│ Counts all the hours recorded on the project. One man-day is 8 hours.
│ 
│ ⊗ Over the limit                                                      112%
│                                                  Today
│                                                    ┆
│   [████████████████████████████████████████◆███████┃▒▒▒▒▒      ]
│                                          ┴         ┴          ┴
│                                         80%      100%      125%
│                                       ◆ Estimate
│ Used 112% of the max effort with 100% of the time to the deadline elapsed
│ 
│ [⊗ Deadline passed 27 days ago                               ▦ 31.10.2026]
│ [⚠ End date in 23 days                                       ▦ 20.12.2026]
│ ──────────────────────────────────────────────────────────────────────────
│ (the widget as before)
└────────────────────────────────────────────────────────────────────────────
```

**Date lines alone** (SLA-only terms whose end date is near); **hours unavailable** (the date line stays under the banner); **an expired capacity package** (no state: the percentage alone, a neutral bar, the excess still a fact):

```
┌ Hours ──────────────────────────────────────────────────────────────────────
│ [⚠ End date in 3 days                                        ▦ 30.11.2026]
│ ──────────────────────────────────────────────────────────────────────────
│ Total recorded   …   (the widget as before)
└────────────────────────────────────────────────────────────────────────────

┌ Hours ──────────────────────────────────────────────────────────────────────
│ [ Consumption is unavailable. Operai could not load the hours …    [ Retry ] ]
│ [⊗ End date passed 12 days ago                               ▦ 15.11.2026]
│ ──────────────────────────────────────────────────────────────────────────
│ Total recorded   …   (the widget as before)
└────────────────────────────────────────────────────────────────────────────

┌ Hours ──────────────────────────────────────────────────────────────────────
│ Capacity package   Package period                     Hours used   Over by
│ 120 h              01.06.2025 – 31.05.2026 [Expired]  140 h 30     20 h 30
│ 
│                                                                       117%
│                                                  Today
│                                                    ┆
│   [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓┃░░░░░░░░   ]
│                                          ┴         ┴          ┴
│                                         80%      100%      125%
│ Used 117% of the hours with 100% of the period elapsed
└────────────────────────────────────────────────────────────────────────────
```

**The parts, in DOM order (= reading order).** Each is drawn only when its rule says so (plan § Signals).

| # | Part | Drawn when | From |
|---|---|---|---|
| 1 | **Facts** and their hint | as before; fixed price and time and material gain a last fact, **Over by**, when over (below) | `consumptionOf` |
| 2 | **State line**: icon and state words at the left, the consumed percentage at the right | the block has a *share* (not for `none`, a package not started, hours unavailable, a reference not above zero: AC-5.4); the words only when `share.state` is not null (not for an expired capacity package, a closed or cancelled project: AC-5.25, 5.26) | `share.state`, `share.consumedPercent` |
| 3 | **Bar** (`ConsumptionBar`, `aria-hidden`) | with a share | `share.bar`; its tone from `share.state` |
| 4 | **Pace line** | with a share | `share.consumedPercent`, `share.elapsedPercent` |
| 5 | **Date lines**: the deadline first, then the terms' end date | each when `dateSignalsOf` returns it (AC-5.21–5.23, 5.26), **from the terms alone, whatever the hours did** (AC-5.24) | `DateSignal[]` |

Rows 2–4 are drawn or absent together, "the share"; row 5 never waits for the hours. Spacing: the signals region sits `mt-4` under the facts and their hint; inside it `gap-2` between the state line, the bar and the pace line, and `mt-3` before the date lines (none when they are alone in the block); the
whole region is `w-full max-w-xl` and left-aligned (576 px at most: a longer bar at 1280 px would only spread the three labels out), the facts above it keep the card's full width.

**State line.** A `div` `flex items-center justify-between gap-3`. Left: a `p` `flex items-center gap-2 text-sm font-medium` plus the tone's words class, holding the icon (decorative, `Icon` at 1em) and the state words
(`data-testid="project-hours-consumption-state"`). Right: the consumed percentage in `font-mono text-base text-text`, **`aria-hidden`** (the pace line says the same figure in text, so a screen reader is not told it twice;
`-percent`). With no state said (AC-5.25, 5.26) the left side is absent and the percentage keeps its place at the right (`ml-auto`), so nothing implies a state. The level is the tone: on track none, close to the limit milder, over graver
(glossary § Level).

**The words of the state line (D95, was G9).** Three states, four wordings, one rule. On track says `consumption.state.onTrack` and close to the limit `closeToLimit`; **over** says `limitReached` when `share.excess` is null (the hours used equal the reference exactly: nothing left, nothing beyond it) and `over` when it is not. The line reads the share's two fields and nothing else: `share.state === 'over' && share.excess === null` is "Limit reached". The plan's `Share` already gives both (`excess` is null at or below the reference, `state` is `over` from the reference up), so no field is added and the component computes nothing. It never reads the percentage, which cannot tell the two apart: 120 h 30 of a 120 h package reads "100%" and is "Over the limit", by 30 min (AC-5.9's own example), and only exactly 120 h is "Limit reached". The same holds for a man-day reference: an excess that rounds to 0.0 is still an excess (`belowOneTenth`, AC-5.13), so 96 h 1 min of a 12.0 man-day max effort reads "Over the limit", "100%" and "Less than 0.1 man-day", and only exactly 96 h reads "Limit reached", with no "Over by" fact. The icon (`x-circle`), the graver level, the tone and the bar are the over state's in both; only the words change. A share with no state said (below) has no words at all, as before.

**Tones and icons — one map of complete class strings** (a status → colour map holds whole classes, never `text-${tone}`; plan R12):

| State (level) | Icon (`Icon name`) | Words and icon | Fill | Beyond 100 % |
|---|---|---|---|---|
| on track (none) | `check` | `text-acc-text` | `bg-acc-solid` | none (a share below 100 % has none) |
| close to the limit (milder) | `alert` | `text-org-text` | `bg-org` | none |
| over (graver): "Limit reached" at exactly the reference, "Over the limit" above it (D95) | `x-circle` | `text-red-text` | `bg-red` | `bg-linear-90 from-red from-50% to-transparent to-50% bg-size-[6px_100%]` |
| no state said (expired capacity package, closed or cancelled project) | none | the percentage in `text-text` | `bg-soft` | `bg-linear-90 from-soft from-50% to-transparent to-50% bg-size-[6px_100%]` |

The bar's tone is the tone of the state that is *said*: with no state the fill and the stripes are neutral, because a tone without its words would be colour alone (AC-5.10). Words are only ever in `*-text` tokens (`--org` and `--red` are not text
colours in the light theme); `--org`, `--red` and `--acc-solid` appear only as fills, and `--soft`, a text token, doubles as the neutral fill. The icons are the suite's own: `alert` is the warning glyph (crm-ui and meetings-ui `Badge tone="warning"`), `x-circle` the danger glyph (crm-ui
`Badge tone="danger"`), `check` the "in order" glyph. No `StatusBadge` is used for a state: the status dictionary has no meaning for it (`attention` is the wrench of "in repair", `failed` is "ended badly"), so each icon is taken for its
general meaning and drawn next to the words; `clock` and `ban` stay the dictionary's.

**The bar — `ConsumptionBar({ share })`** (projects-ui `components/ConsumptionBar.tsx`; it computes nothing: every position is `share.bar`, in percent of the bar's *length*, whose scale is 0–125 % of the reference). Root: `aria-hidden="true"`,
`data-testid="project-hours-consumption-bar"`, no `tabIndex`, no `title`, no tooltip (a tooltip on a mark would be reachable by mouse only). Inline `style` carries widths and positions only; every colour is a token utility.

| Part | Complete class strings | Position | Notes |
|---|---|---|---|
| Root | `relative` | — | up to four rows, top to bottom: the today label, the track, the scale labels, the estimate label |
| Row T (only when `bar.today` is not null) | `relative h-5` | — | holds the "Today" label |
| Row B (the track row) | `relative h-2.5` | — | holds the track surface and every mark |
| Track surface | `absolute inset-0 overflow-hidden rounded-sm bg-ink ring-1 ring-dim` | — | the unfilled scale, 0–125 %; `bg-ink` (not `bg-ink-mid`) so every fill clears 3:1 against it in both themes (§ Contrast) |
| Fill | `absolute inset-y-0 left-0` + the tone's fill | `style` width = `within` % | 0–80 % of the track; absent at 0; no minimum width (30 min of 120 h is a sliver or nothing, and the number says it) |
| Beyond part | `absolute inset-y-0` + the tone's stripes | `style` left = 80 %, width = `beyond` % | its **own element, absent unless `beyond` > 0** (so absent at exactly 100 %, AC-5.15); ends at the track's end from 125 % on, while the percentage still reads in full (AC-5.16) |
| Scale ticks | `absolute top-0 h-4 w-0.5 -translate-x-1/2 bg-soft ring-1 ring-ink` | left 64 %, 80 %, 100 % | 10 px through the track, 6 px below it: over a fill the notch below is what is seen. The first two are `BAR_MARKS` (80 % and 100 % of the reference); the third is the end of the track, 125 %, a label and a tick but no constant of the plan |
| Today line | `absolute -top-1.5 h-4 w-0.5 -translate-x-1/2 bg-text ring-1 ring-ink` | left = `today` % | 6 px above the track and through it; only when `bar.today` is not null |
| Estimate mark | `absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-text ring-1 ring-ink` | left = `estimate` % | a diamond on the track's centre line; only when `bar.estimate` is not null (it can sit in the beyond zone, 100–125 %; at 0 or 100 % half of it is outside the track, inside the card's padding) |
| Row S | `relative mt-2 h-4` | — | the three scale labels |
| Scale labels | `absolute font-mono text-2xs text-soft` | 80 %, 100 % centred (`-translate-x-1/2`) at 64 % and 80 %; 125 % end-aligned (`-translate-x-full`) at 100 % | the words are `formatNumber(n / 100, { style: 'percent', maximumFractionDigits: 0 })` of the constants 80, 100, 125: "80%", "100%", "125%" |
| Row E (only with `bar.estimate`) | `relative h-4` | — | the estimate label |
| "Today" label | `absolute bottom-1 font-mono text-2xs text-text` | left = `today` %; centred, start-aligned when `today` < 8 | `strings.project.consumption.bar.today` |
| "Estimate" label | `absolute font-mono text-2xs text-text`, with the same diamond as a key (`inline-block size-2 rotate-45 bg-text ring-1 ring-ink`) before the word | left = `estimate` %; centred, start-aligned when < 14, end-aligned when > 86 | `strings…bar.estimate`. Tied to its mark by the shape and by the x position, one row below the scale labels, **never by a leader line**: a leader would run through the "80%" label whenever the estimate is near it, and a typical estimate is (10.0 of 12.0 is 83 %, a mark 6 px from the 80 % tick) |

The alignment rules (the `< 8`, `< 14`, `> 86` thresholds) are layout only, read from the positions: they keep a 33 px "Today" and a 63 px "◆ Estimate" inside a 234 px bar. The marks are two-tone on purpose: a `text` core with a 1 px `ink` ring, so
every adjacent pair clears 3:1 whether the mark sits on the track, on a fill or on stripes in either theme (§ Contrast). Nothing animates: a re-read replaces the widths at once, so there is nothing to stop under `prefers-reduced-motion`.
**R9 does not materialise.** The stripes are vertical (3 px of the tone, 3 px of the track), drawn by Tailwind's gradient utilities with hard stops: `bg-linear-90`, `from-*`, `from-50%`, `to-transparent`, `to-50%` and `bg-size-[6px_100%]` compile in the repo's
Tailwind, none matches the lint's refusals (`var(--`, or `#`, `rgb(`, `hsl(`, `oklch(` in an arbitrary class), and no `tokens.css` change or component class is needed. A diagonal hatch would need an arbitrary `repeating-linear-gradient` or an SVG `<pattern>`: not
designed. One consequence was a gap (G8, resolved by the plan): sixteen of the utilities in the bar's table and in the tones table above it are used nowhere else in the suite, and the shell's single Tailwind sheet is what generates a remote's utilities, so the shell is rebuilt and deployed from the same commit (plan § Deploy order, R13); until it is, the bar is not drawn at all, and every text line is unaffected (G8).

**Pace line.** A `p` `text-xs text-soft` (`data-testid="project-hours-consumption-pace"`). It states the consumed percentage and, when the share has a time elapsed, that too (AC-5.18, 5.19); it judges nothing and forecasts nothing. Per variant: a package
"Used 82% of the hours with 50% of the period elapsed", or "Used 70% of the hours" for a capacity package without an expiry; a fixed price "Used 75% of the max effort with 40% of the time to the deadline elapsed", or "Used 75% of the max effort" when the
deadline is before the start date; time and material "Used 31% of the planned man-days". Both percentages come through `formatNumber` from floored integers. No share, no pace line.

**Excess (AC-5.12, 5.13).** A *fact*, never part of the state line, so it still reads where no state is said (AC-5.25, 5.26). Package: the existing last fact ("Hours left" becomes "Over by", D81), unchanged. Fixed price and time and material: a **last fact "Over by",
shown only when over**, in man-days with one decimal ("1.5 man-days") or, when a positive excess would round to 0.0, "Less than 0.1 man-day", never "0.0". At exactly 100 % there is no excess, the state line says "Limit reached" (D95) and a package's last fact still reads "Hours left 0 min" (AC-5.9).

**Date lines (AC-5.21–5.24).** One bordered box per signal, deadline first, then the end date, each on its own line even on the same day (AC-5.23); `w-full`, inside the `max-w-xl` region, `flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm`
(`data-testid="project-hours-consumption-date-deadline"`, `-date-end-date`) plus the level's classes. Inside, two paragraphs: the words with the level icon at the left (`flex items-center gap-2 font-medium`, in the level's text colour), and the date at the right
(`flex items-center gap-1.5 font-mono text-xs text-text`, the `calendar` icon and a `<time dateTime>` through `formatDate`). Not a `Banner` and not a `Badge` (inventory says why).

| Level | Signal | Icon | Complete class strings (box) | Words (EN) |
|---|---|---|---|---|
| milder | the date is today or up to 30 days ahead (AC-5.22; a date's own day is today and has **not** passed, D94) | `alert` | `border-org/40 bg-org/10 text-org-text` | "Deadline in 10 days", "Deadline is today"; "End date in 23 days", "End date is today" |
| graver | the date is before today (AC-5.21) | `x-circle` | `border-red/40 bg-red/10 text-red-text` | "Deadline passed 27 days ago"; "End date passed 1 day ago" |

With 31 days or more to go, nothing. The owner's mock drew one calendar icon; AC-5.21 also asks for the date itself, so it sits at the right with the `calendar` icon, and the level icon leads the words (the reading of AC-5.10 below). At 320 px the box wraps: the date drops under
the words. The lines are read in place (no live region, no role): they are not alerts.

**Readings this design relies on.**

- *AC-5.10, "in words and by an icon of its own, so that none is told by colour alone".* Read as: every state and every date signal has words **and** an icon, and the icon follows the **level** — three distinct shapes for the three states (`check`, `alert`, `x-circle`) and two
  distinct shapes for the two date kinds, passed and near (`x-circle`, `alert`). A state and a date signal of the same level share their level's shape on purpose (glossary § Level: they carry the same degree of attention). The owner's calendar icon stays, beside the date value, as the mark of
  "this is a date". The owner confirmed this reading (D96, G11); five pairwise-distinct shapes would have needed two more `Icon` shapes (the library has none that is not reserved: `clock` and `ban` are the dictionary's), a library push (plan § Deploy order), and are not designed. The over state's two wordings (D95) are one state and share its one icon.
- *AC-5.11, "everything the bar shows is also given in text".* Read as: a reader who never sees the bar still gets the consumed percentage (the pace line), the state (the state line's words), the time elapsed (the pace line), the excess (the "Over by" fact) and the estimate
  (the "Estimated man-days" fact, which AC-1.4 keeps). The estimate mark's *position* (its share of the max effort, 83 % in the example) is not put in words — the plan declines a second percentage on another base — and the 80 % and 100 % marks are the thresholds the state words stand for. The owner confirmed this reading (D96).
- *The tone of a bar with no state:* neutral (above). The spec was silent (AC-5.25, 5.26 say "no state", not what the bar looks like); the owner confirmed it (D96, G10) and the spec's gate-2 note records it.

**Contrast (R12).** WCAG 2 relative luminance of the hex values in `tokens.css`, the card being `--ink-soft` and the track `--ink`; QE measures the rendered pixels, these are the expected values. Text ≥ 4.5:1; fills, stripes and marks ≥ 3:1 (the date boxes' borders are decoration: the words and the icon carry the signal).

| Pair | Dark | Light |
|---|---|---|
| Fill `acc-solid` / `org` / `red` / `soft` against the track (`ink`) | 3.86 / 9.55 / 5.99 / 5.67 | 4.73 / **3.23** / 4.37 / 5.60 |
| The same fills against the card (`ink-soft`), for a reader who does not see the track's faint ring | 3.68 / 9.09 / 5.70 / 5.40 | 4.42 / **3.02** / 4.09 / 5.24 |
| Stripes (`red`, `soft`) against the track gap (`ink`) | 5.99 / 5.67 | 4.37 / 5.60 |
| Mark core `text` against its ring `ink` | 14.45 | 18.27 |
| Mark ring `ink` against a fill `acc-solid` / `org` / `red` / `soft` | 3.86 / 9.55 / 5.99 / 5.67 | 4.73 / 3.23 / 4.37 / 5.60 |
| Scale tick core `soft` against its ring `ink`; the notch below the track against the card | 5.67; 5.40 | 5.60; 5.24 |
| Labels on the card: `soft` / `text` | 5.40 / 13.76 | 5.24 / 17.08 |
| State words on the card: `acc-text` / `org-text` / `red-text` | 6.94 / 9.09 / 5.70 | 5.60 / 5.39 / 5.88 |
| Date-box words on the box's own 10 % tint: `org-text` / `red-text`; the date in `text` | 7.69 / 5.11; 11.64 / 12.33 | 4.87 / 5.11; 15.44 / 14.85 |

The tightest pair is the light theme's `--org` fill (3.23:1 against the track, 3.02:1 against the card): above 3:1 with the least margin. If QE measures under 3:1 on the rendered pixels, the fallback is `bg-org-text` for that one fill (the `*-text` token read as a fill: 5.76:1
against the track in light, unchanged in dark); nothing else changes. In greyscale every state keeps its words and its shape, the beyond part its stripes, each date its words and its level icon.

**Every state of the share and of the date lines, per variant** (✓ on track, ⚠ close to the limit, ⊗ over, said "Limit reached" at exactly the reference and "Over the limit" above it (D95); "—" nothing drawn; the date lines column is always "by the terms" unless it says otherwise):

| # | Case | Facts | State line | Bar | Pace line | Date lines |
|---|---|---|---|---|---|---|
| 1 | **Yearly**, current period, below 80 % (also 0 %: nothing recorded) | package, period, used, left, carry-over hint | ✓ On track, accent; "0%" for no hours | accent fill (none at 0 %), ticks, today mark | "Used 50% of the hours with 40% of the period elapsed" | by the terms' end date, if it is near or has passed |
| 2 | Yearly, 80–99 % | as 1 | ⚠ Close to the limit, warning | warning fill, past the 80 % tick | as 1 | as 1 |
| 3 | Yearly, **exactly 100 %** (the hours used equal the package) | last fact "Hours left 0 min" (no excess) | ⊗ **Limit reached** (D95: the over state, in other words; same level, `x-circle` and tone) | danger fill up to the 100 % tick, **no beyond part** (AC-5.15) | as 1 | as 1 |
| 4 | Yearly, **above the reference** (the percentage reads 100% until 101 % of it, as at 120 h 30 of 120 h, AC-5.9) | last fact "Over by 4 h 30" | ⊗ Over the limit | danger fill, plus the striped beyond part to the percentage (the end of the track at 125 %) | as 1 | as 1 |
| 5 | Over 125 % ("180%") | "Over by …" | ⊗ Over the limit, "180%" in full | fill and stripes to the end of the track, nothing cut (AC-5.16) | "Used 180% …" | as 1 |
| 6 | **Capacity** with an expiry, not ended | "Package period" with both dates | as 1–5 | as 1–5, today mark (span start to expiry) | as 1, "of the period elapsed" | as 1 |
| 7 | Capacity **without an expiry** | "From 01.03.2026, no expiry" | as 1–5 | as 1–5, **no today mark** (AC-5.19) | "Used 70% of the hours" (the percentage alone) | as 1 |
| 8 | Capacity, **expired** (`ended`) | "Expired" `StatusBadge` beside the dates; the final figures; "Over by" if exceeded | **none** (D91): the percentage alone at the right | **neutral** `bg-soft` fill, neutral stripes if above 100 %; today mark at 100 % elapsed (aligned with the 100 % tick) | "Used 117% of the hours with 100% of the period elapsed" | as 1 (the terms' end date, if any); on the expiry day itself the package has not ended and has its state (AC-5.25) |
| 9 | **Package not started** (`currentPeriod` null) | package, "Starts on", the hint; no request | — | — | — | by the terms (AC-5.24) |
| 10 | **Fixed price**, any share | man-days used, estimated (only when known), max effort, **Over by** once over | by the share (1–5) | by the share; the **estimate diamond and label** when 4e ≤ 5m (none without an estimate or beyond 125 % of the max effort; at 0 it is at the start, at 125 % at the end); today mark over start date to deadline, none when the deadline is before the start date | "Used 75% of the max effort with 40% of the time to the deadline elapsed", or "Used 75% of the max effort" | the **deadline line first**, then the end-date line when the terms have one; same day, two lines |
| 11 | **Time and material** | man-days used, planned, **Over by** once over | by the share | by the share; no estimate mark, no today mark | "Used 31% of the planned man-days" | the end-date line only (no deadline) |
| 12 | **SLA-only** (`maintenance`/`saas` without an hour package) | none | — | — | — | the end-date line when it is near or has passed, as a block of **date lines alone** with the divider; otherwise **no block** (the card is the widget alone) |
| 13 | **Internal / no terms** | none | — | — | — | none (no terms, no date); no block |
| 14 | **Closed or cancelled** project | as any project | **none** (D93): the percentage alone | **neutral**, today mark stays | the pace line stays, with its time elapsed | **none** (a closed SLA-only project has no block) |
| 15 | **Hours loading** | skeleton rows in place of 1–4 | — | — | — | shown at once, below the skeleton |
| 16 | **Hours unavailable** (503, Meetings unknown, network) | the warning banner "Consumption is unavailable" with Retry | — | — | — | stay, below the banner (AC-5.24) |
| 17 | **Re-read after a Record hours save** | replaced in place after the answer, no skeleton | may change words, icon and tone, silently | the widths change at once, no animation | the used percentage changes, the time elapsed does not | unchanged (same `asOf`) |
| 18 | **Older projects-api** (no `asOf`, R10) | as the case | as the case | no today mark | the percentage alone | none; an SLA-only project has no block |
| 19 | **Reference not above zero** (hand-built terms; the schemas forbid it) | facts | — | — | — | by the terms |

Date-line counts: today is "is today", a number of days is `formatNumber` with the plural chosen from the integer ("1 day", "27 days"), and a date 31 days or more ahead is not drawn.

**Layout at 320, 360 and 1280 px** (the card's inner width is the viewport minus the tool container's 2 × 24 px and the card's 2 × 19 px: 234, 274 and 1194 px):

| Viewport | Facts | Signals region | Notes |
|---|---|---|---|
| 1280 | up to five columns of 170 px | capped at `max-w-xl` (576 px), left-aligned; the state line's percentage sits at the cap's right edge, not the card's | the three scale labels are ≥ 40 px apart; the date boxes do not stretch across the card |
| 360 | one column | full inner width, 274 px | the state line stays on one line in both languages; date boxes wrap when the words and the date do not fit |
| 320 | one column | full inner width, 234 px | scale labels: the gap between "80%" and "100%" is ≈ 14 px and between "100%" and "125%" ≈ 7 px (11 px DM Mono, ≈ 6.6 px a character); they would touch below ≈ 215 px, which no layout reaches. The pace line wraps to two or three lines (the Italian longest); the date box's words wrap and the date goes under them; no horizontal page scroll |

Both themes come from the tokens; nothing here is theme-specific. A viewer's 200 % text-only zoom on a 320 px screen can make the "100%" and "125%" labels touch: they are decoration, `aria-hidden`, and every figure they stand for is in the lines.

**States — which part owns which, in one card.** The card frame and its title are the section's own and **are always shown, in every state**, so the heading survives whatever
happens to either part (the rule of `MeetingsSection.tsx:10`). Each part is complete or absent: no part ever shows a figure it could not read. *Since US-5:* the date lines are the one thing the block shows without reading hours
(AC-5.24), so a block that could not read the hours still shows them. The states of the share, per variant, are the table of S1.1.

| Part | Loading | Loaded | Empty | Error / fallback |
|---|---|---|---|---|
| **Consumption block** | the page's own `Loading` (`LoadState.tsx:8-18`): polite "Loading consumption…", two skeleton rows **in place of the facts and the share**; the date lines, when there are any, are shown at once below it | variant A, C or D (facts, share, date lines); variant B is static and **never makes a request** (facts and date lines), so it has no loading or error; SLA-only terms: date lines alone | none (zero is a figure); no variant and no date line: the block is absent | `Banner tone="warning"` (alert), title "Consumption is unavailable", body "Operai could not load the hours recorded on this project, so no comparison is shown rather than one that could be too low. Try again in a moment.", Retry. **No hours figure, no remaining figure, no percentage, state, bar or pace line** (AC-4.9, AC-5.4); the sold figures are not repeated (the Terms card holds them); **the date lines stay below the banner** (AC-5.24) |
| **Widget** | the seam or the module loading: the host's `Loading` with one skeleton row; then the widget's own (S3): a single skeleton row, no button yet | S3: total line, inclusion line, disclosure | S3: total "0 min" and one sentence, **no disclosure** | the host fallback (`Banner tone="info"`, "Hours are unavailable. Reload the page to try again.", no Retry) or the widget's own warning with Retry (S3) |

The two parts read independently (the block asks the summary with the window, the widget without), so the cases are real:

- **Block fails, widget loads:** the card shows the block's warning (and its date lines under it) in the first slot, then the total line and the disclosure as usual. The total is a complete figure from its own successful read, so AC-4.9 holds.
- **Widget fails (or falls back), block loads:** the card shows the consumption facts and signals, then the widget's banner in the second slot: no total line and no disclosure.
- **Both fail** (the common case when hours-api or Meetings is down: one cause): two warning banners, each with its own Retry. The parts do not coordinate: the widget's props are plain strings and nothing comes back across the seam (ADR 20261104-host-extension-federated-panel-through-the-shell), so a single shared message is not possible. Recorded, not hidden.
- **Project with no comparable terms (AC-1.7, G2):** no consumption figures; the card is the widget alone, "Total recorded", the inclusion line and the disclosure — plus, when the terms have an end date that has passed or is near and the project is not closed or cancelled, the block's date line(s) and the divider (AC-1.7 amended).
- **A re-read after a Record hours save (D84, AC-5.28; was G5):** the block keeps what is on screen — facts, share, date lines — until the answer arrives (no skeleton, no layout jump), then replaces the figures and the share in place. The date lines and the time elapsed do not change: they come from the page's own `asOf` (A52). A failed re-read shows the block's usual warning banner with Retry. Nothing is announced beyond what the block already announces.

Retry (either part): that part shows its loading state; when the answer arrives (either outcome) focus moves to **that part's wrapper**, so a keyboard user is not left on a button that no longer exists; on failure the alert is announced again and the wrapper holds it.

**`HoursSection` (host, projects-ui)** — the `MeetingsSection` shape (`MeetingsSection.tsx:41-57`) with one difference: it owns the **whole card**, and `HostExtension`'s `loading` and `fallback` are the *widget's slot*, not a replacement card
(`MeetingsSection`'s `MeetingsCard` wraps its fallback; here the frame, the consumption block and the divider stay put while only the widget's slot changes):

```
<Card title="Hours">
  <ConsumptionBlock />                       (when `hasConsumptionBlock`; props projectId, terms, state)
  <ExtensionContain …>                       (the seam: useExtensionSeam → HostExtension name="hours.hostHours"
    <HostExtension props={{ on: 'project', targetId }} loading={…} fallback={…} />    resetKey = project id)
  </ExtensionContain>
</Card>
```

Tone choice, recorded: the host fallback is **info** with "reload" because nothing in the page can retry a failed import (a failed module import is cached; the Meetings fallback's tone and shape);
the widget's own failure (S3) is **warning** with Retry because it can (orange means "try again", design-system § Error colour). The seam is imported once per page by
`useExtensionSeam`, which the header's Record hours and the Meetings card already use.

The card is shown to everyone who can read the project (AC-2.1); there is no permission check in the host, only the server's. *Since US-5* `HoursSection` also takes the project's `state` (AC-5.26: a closed or cancelled project shows no state and no date line) and draws the
divider by `hasConsumptionBlock(terms, state)`, the same rule `ConsumptionBlock` renders by, so the two cannot disagree (an SLA-only project whose end date is near has a block of date lines alone, and the divider).

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

**Re-read after a Record hours save (D84, AC-2.8; this replaces the first draft's "Nothing in the widget changes when someone records hours in place", G5).** The widget listens for `operai:time-entry-recorded` while mounted and, when its
`detail` names its own target, re-reads exactly as on mount: it keeps what is on screen (the total, the open or closed breakdown and its tables) until the answer arrives — no skeleton, no jump — then replaces the figures; a failed re-read shows
the widget's own error (warning, Retry) like a failed first read, and the disclosure keeps its state. Nothing is announced beyond what the widget already announces. The event carries no figure and none is taken from it (plan D-P6).

### S4 My hours and Everyone's hours — widened by US-4 (hours-ui)

No new screen. What changes, and where (S1 and S4 of the time-tracking design stay as written):

**Project filter refusal (AC-4.8).** `DealFilterUnavailable` becomes the refusal of "a host filter": `kind: 'deal' | 'project'` picks the words
and the test ids; the structure, tone (`Banner tone="warning"`, `role="alert"`), actions (Retry; `ghost` `sm` Clear), the focus rules
and the "pages already shown stay, with the error below them" rule (D48) are exactly the deal's (`DealFilterUnavailable.tsx:24-45`;
`MyHoursPage.tsx:525` (table view), `:610` (list view); `EveryoneHoursPage.tsx:350`). It replaces Totals and Entries (and the table's
grid), never the empty state, never "0 min". Clear returns focus to the **Project** picker's input. If both a deal and a project filter are
set, the project wording shows; clearing it leaves the deal's if the deal filter still triggers the refusal (both depend on the
same Meetings answer), so the person is never shown a filter that is not set.

**The linked set changed between two pages (AC-4.4; amended 2026-11-27, QE D1 and D3).** A 409 `project_meetings_changed` answers a *Load more* when the set of meetings linked to the project changed after the previous page was read (a meeting linked, unlinked or deleted). It is handled exactly as the deal's `deal_meetings_changed` is: the list starts over from its first page, **silently**. The Entries region shows its ordinary loading state (the skeleton and the polite "Loading your hours…") and then answers as any first page does: the new list, the region's own error banner with Retry, or the refusal above when Meetings cannot say. There is no `Banner`, no alert and no "refreshed" status for the restart itself, because nothing is wrong and there is nothing to do: the pages dropped are read again with Load more, and the restart exists so that the list never mixes two sets of meetings. The export's walk restarts the same way, at most three walks in all, and shows nothing for a restart; a walk refused three times in a row fails like any other export failure, with the button's own alert. This is one code path for both host filters, in My hours' List and in Everyone's hours. My hours' table view has no Load more, but its one complete read of the period goes through the export's walk (`readAllEntries`), so it restarts the same way: a 409 answers only a later page, so a period that holds more than one page of 500 entries can meet it, and the walk then starts over, silently (the card stays in its one loading state), at most three walks in all. Refused three times in a row, the card shows its own read-failure state with Retry, as for any failed read of the period, not the host-filter refusal above (that is for 503 `host_unavailable` only).

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
| Durations, man-days, dates | `formatDuration`, `formatNumber`, `formatDate` | REUSE (no option is added: G1 was resolved without one, D81) |
| Project block loading | `Loading` (`projects-ui/src/components/LoadState.tsx:8-18`) | REUSE |
| Seam import, once per page | `useExtensionSeam` (`projects-ui/src/lib/extensionSeam.ts:45-58`; crm-ui's copy, same name) | REUSE |
| Containing the widget's failure | `ExtensionContain` (`projects-ui/src/components/ExtensionContain.tsx`; crm-ui's copy) | REUSE |
| The card and the widget's slot | `MeetingsSection` (`projects-ui/.../MeetingsSection.tsx:9-57`; `crm-ui/.../MeetingsSection.tsx:9-60`) as the shape | **NEW** `HoursSection` ×2 (one per host app): owns the whole card (the frame, the block, the widget's slot) where `MeetingsSection` swaps a whole card; its own heading, copy and extension name; nothing generic to share (each app owns its seam and strings, ADR 20261104-host-extension-federated-panel-through-the-shell: "NOT precedent for shared primitives") |
| Sold-vs-used block | none | **NEW** `ConsumptionBlock` (projects-ui; the plan's `ConsumptionCard`, now a block inside `HoursSection`'s card, not a card): no component compares a term with a figure; built from `FactList`. Since US-5 it also draws the signals below its facts (S1.1) |
| Its arithmetic | — | **NEW** `lib/consumption.ts` (pure, plan): left, man-days in integers, the variant by terms; since US-5 the share (percentage, state, excess, bar positions, time elapsed), `dateSignalsOf` and `hasConsumptionBlock` (D-P9); no UI |
| **The bar** | no `@operai/ui` component draws a scale with a second segment and marks: `ProgressBar` is `role="progressbar"`, clamped at its maximum, with one fixed accent fill, the indicator meetings-ui and crm-ui use for work moving to completion (a change to it reaches them untested), and a new library `Meter` needs a push to the shell before a remote may use it (plan D-P8 (a), (b)) | **NEW** `ConsumptionBar` (projects-ui `components/ConsumptionBar.tsx`): one app needs it (the signals are drawn nowhere else, a spec non-goal); token utilities, inline `style` for widths and positions only, `aria-hidden`. *Lift it into the library as a `Meter` when a second app needs it* |
| State line, pace line, date lines | private helpers in `ConsumptionBlock.tsx` (the way `Facts` and `Group` are today): token utilities and `Icon` | REUSE (no new component). Not `Banner`: orange there means "try again" (design-system § Error colour) and this block already shows a warning Banner with Retry for "Consumption is unavailable"; a one-line fact in a block of figures would be heavier than the figures (12 × 16 px padding, a title and a body) and it has no slot for a level icon. Not `Badge`: it is `nowrap` at 11 px and the date lines must wrap at 320 px. Not `StatusBadge`: its dictionary has no meaning for these states |
| Signal icons | `Icon` `check`, `alert`, `x-circle`, `calendar` | REUSE: all four exist (`operai-ui/src/components/Icon.tsx`); no shape is added (a new shape is a library push, plan § Deploy order) |
| Percentages, a number of days | `formatNumber` | REUSE |
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

**Count:** 27 REUSE or extended in place (12 library pieces, 12 in-repo, and since US-5 three more: the signal lines' markup, the four icons, `formatNumber` for percentages and days), **5 NEW** UI pieces (`ConsumptionBlock`, `ConsumptionBar`, `HostHours`,
`HoursSection` in each of two apps) and one pure module (`consumption.ts`). No library component, no icon shape, no route, no tab. **The widget needs no new prop.** US-5 adds one NEW, `ConsumptionBar`, and no `@operai/ui` change.

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
6. *(US-5)* The scale labels ("80%", "100%", "125%"), the "Today" and "Estimate" labels and the estimate's key diamond: the owner's mock (D86); AC-5.14 asks for the marks, not for their labels.
7. *(US-5)* The consumed percentage at the right of the state line, beside the pace line's: the mock; AC-5.1 asks for it once, shown.
8. *(US-5)* The `calendar` icon and the level icon in the date lines: the mock and the reading of AC-5.10 (AC-5.21 asks for the date and the words, not for an icon).
9. *(US-5)* The `max-w-xl` cap of the signals region and the labels' alignment thresholds (layout only).

Considered and **not** designed: a Refresh action (the card re-reads by itself after a Record hours save, D84), a per-position table, a "counts for project" cell in the table view, a count or a summary on the closed button
("3 work types"), remembering the disclosure across reloads or putting it in the address, opening it by default for the project manager, a `headingLevel` or `defaultOpen` prop, tabs. *US-5:* `role="meter"` or `role="progressbar"` on the bar (D-P8:
it would repeat the pace line and cannot expose the marks), a tooltip or hover text on a mark (not reachable by keyboard), an animated fill, a minimum fill width, a diagonal hatch (it needs an arbitrary gradient or an SVG pattern; vertical stripes need
neither), a legend row (the two labelled marks carry their own labels), a leader line to the estimate label, announcing a changed state after a save (a signal is not an alert), a tone for an expired package or a closed project, a judgement of the pace
(ahead of or behind, a forecast: spec non-goal), a dismiss or snooze of a signal (spec non-goal), a second estimate percentage, new `Icon` shapes, a fourth state, level, icon or tone for exactly 100 % (D95 changes the words only), choosing those words from the percentage rather than from the excess (100.42 % reads "100%").

---

## Accessibility

Headings: the tool keeps one h1; each record page keeps one h2 (`PageHeader`); the Hours card is h3 (`Card`); the open region's "By work type" / "By person" are **h4** (never a skipped or repeated level). The consumption block has no heading, only a named group.

**The Hours card, closed (the state every load starts in)**
- Reading order: the card's heading, the consumption facts (a `dl`: each figure read with its term, "Over by" included) and their hint, then, since US-5, the state line (its words; the percentage is `aria-hidden`), the pace line and the date lines (the words,
  then the date), then the total fact, the inclusion line, the button. **The bar is skipped**, its text labels included (`aria-hidden`). Nothing else is in the tab order but the button (and a Retry when a part failed).
- A duration shows the short text for the eye (`aria-hidden`) and the spoken text for the reader ("84 hours, 30 minutes"). "Over by" is a term of its own with the absolute figure, so no sign is needed to tell an overrun from a surplus (D81).
  Man-days are words ("7.5 man-days"), read as written.
- Loading: polite "Loading consumption…" and "Loading hours…" (two lines at most, one per part). Loaded: no announcement (the card is read in place on page load, as the Terms card is; the widget no longer announces its total). Failure: `Banner` `role="alert"`, announced when it appears, no focus move on the first load.
- Contrast: § S1.1's table. Text is ≥ 4.5:1 in every tone (the state words and the date boxes are in `*-text` tokens, never the bare `--org` or `--red`); fills, stripes and marks are ≥ 3:1 against the track in both themes. Figures are `--text`; hints, the pace
  line and the inclusion line `--soft` (`text-soft`), never `--muted`; both themes are the library's.

**The signals (S1.1)**
- **Nothing is added to the tab order:** the bar, the state line, the pace line and the date lines are text or `aria-hidden` drawing; there is no tooltip, no hover-only text and no interactive mark. The group stays `tabIndex={-1}` (the target of focus after a Retry).
- **Never colour alone (AC-5.10).** Each state has words and a shape (`check`, `alert`, `x-circle`); each date line has words and a level icon (`alert`, `x-circle`); the beyond part has stripes against a solid fill; with no state the bar is neutral and says nothing. In
  greyscale the reading is the same. Icons are decorative (`aria-hidden`, no `label`): the words say the same.
- **The bar is `aria-hidden`; the lines say what it shows (AC-5.11, D-P8).** Percentage and time elapsed: the pace line. State: the state line. Excess: the "Over by" fact. Estimate: the "Estimated man-days" fact. The state line's percentage is `aria-hidden` too, because
  the pace line states it: no figure is read twice. No `role="meter"` or `progressbar`: it would repeat the pace line and cannot expose the marks.
- **Dates:** each date line is two short paragraphs in a box, the words then a `<time dateTime>`; read in place, deadline first, then the end date. No live region and no role: a date signal is not an alert.
- **Changes are silent.** After a Record hours save the percentage, the state words, the bar and the excess change in place and nothing is announced (D84: nothing beyond what each part already announces); a state turning from "Close to the limit" to "Limit reached" or "Over the limit", or from "Limit reached" to "Over the limit", is
  not announced either. Considered and not designed.
- **Motion:** none. The fill and the marks are replaced at once, so nothing needs stopping under `prefers-reduced-motion`.
- **Forced colours:** fills, ticks and stripes are backgrounds that a forced-colours mode drops; the text lines carry everything, as they do for the library's own `ProgressBar`. Accepted.
- **Reflow:** at 320 px (a 234 px bar) the signals wrap and nothing scrolls horizontally; the scale labels are decoration (S1.1).

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
- The restart after a 409 between pages is silent by design (S4): the only announcement is the Entries region's ordinary polite loading line; no status text, no alert, no banner. In the table view the restart happens inside the period's one read, so the table card's own polite loading line ("Loading your week…" / "Loading your month…"), already spoken when the read began, is all there is: its text does not change during the restart.
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
| `consumption.overBy` (D81; it also heads the man-day excess of a fixed price and of time and material, AC-5.12) | Over by | Sforato di |
| `consumption.expired` (D83) | Expired | Scaduto |
| `consumption.yearlyNote` | Hours left in a period do not carry over to the next one. | Le ore non usate in un periodo non passano a quello successivo. |
| `consumption.notStartedNote` | Hours recorded before the start date do not count against the package. | Le ore registrate prima della data di inizio non contano per il pacchetto. |
| `consumption.manDaysUsed` | Man-days used | Giornate usate |
| `consumption.fixedPriceNote` | Counts all the hours recorded on the project. One man-day is 8 hours. | Conta tutte le ore registrate sul progetto. Una giornata equivale a 8 ore. |
| `consumption.timeAndMaterialNote` | Compared with the total of all positions. One man-day is 8 hours. | Confrontato con il totale di tutte le posizioni. Una giornata equivale a 8 ore. |
| `consumption.excess.lessThanOneTenth(value)` (AC-5.13; `value` is `formatNumber(0.1, one decimal)`) | `Less than ${value} man-day` | `Meno di ${value} giornate` |
| `consumption.state.onTrack` | On track | In linea |
| `consumption.state.closeToLimit` | Close to the limit | Vicino al limite |
| `consumption.state.over` (D95: an `over` share **with** an excess) | Over the limit | Oltre il limite |
| `consumption.state.limitReached` (D95: an `over` share with **no** excess, `share.excess === null`; S1.1) | Limit reached | Limite raggiunto |
| `consumption.pace.hours(used)` | `Used ${used.text} of the hours` | `Usato ${il(used)} delle ore` |
| `consumption.pace.hoursElapsed(used, elapsed)` | `Used ${used.text} of the hours with ${elapsed.text} of the period elapsed` | `Usato ${il(used)} delle ore con ${il(elapsed)} del periodo trascorso` |
| `consumption.pace.maxEffort(used)` | `Used ${used.text} of the max effort` | `Usato ${il(used)} dell’impegno massimo` |
| `consumption.pace.maxEffortElapsed(used, elapsed)` | `Used ${used.text} of the max effort with ${elapsed.text} of the time to the deadline elapsed` | `Usato ${il(used)} dell’impegno massimo con ${il(elapsed)} del tempo fino alla scadenza trascorso` |
| `consumption.pace.plannedManDays(used)` | `Used ${used.text} of the planned man-days` | `Usato ${il(used)} delle giornate previste` |
| `consumption.bar.today` / `.estimate` | Today / Estimate | Oggi / Stima |
| `consumption.dates.deadline.passed(days)` | `Deadline passed ${days.text} ${days.n === 1 ? 'day' : 'days'} ago` | `Scadenza superata da ${days.text} ${days.n === 1 ? 'giorno' : 'giorni'}` |
| `consumption.dates.deadline.today` | Deadline is today | La scadenza è oggi |
| `consumption.dates.deadline.near(days)` | `Deadline in ${days.text} ${days.n === 1 ? 'day' : 'days'}` | `Scadenza tra ${days.text} ${days.n === 1 ? 'giorno' : 'giorni'}` |
| `consumption.dates.endDate.passed(days)` | `End date passed ${days.text} ${days.n === 1 ? 'day' : 'days'} ago` | `Data di fine superata da ${days.text} ${days.n === 1 ? 'giorno' : 'giorni'}` |
| `consumption.dates.endDate.today` | End date is today | La data di fine è oggi |
| `consumption.dates.endDate.near(days)` | `End date in ${days.text} ${days.n === 1 ? 'day' : 'days'}` | `Data di fine tra ${days.text} ${days.n === 1 ? 'giorno' : 'giorni'}` |

(The first draft's `consumption.leftSpoken` and `consumption.overSpoken` are dropped: the term itself says left or over, so the value needs no spoken twin, D81.)

**Types and Italian.** A function takes `Count = { n: number; text: string }`: `n` is the integer (the plural, the Italian article), `text` the figure already formatted by `formatNumber`. A percentage is `formatNumber(p / 100, { style: 'percent',
maximumFractionDigits: 0 })` of the floored integer, so it reads "99%" in both languages, never "99 %" (the library's formatter; the spec and the mock wrote "80 %", G12). The Italian article before a percentage is a private helper `il(count)` of the strings module:
**`lo`** before 0 ("lo 0%"), **`l’`** before 1, 8, 11, 80–89 and 800–899 ("l’1%", "l’8%", "l’11%", "l’80%", "l’89%", "l’800%"), **`il`** otherwise ("il 65%", "il 99%", "il 100%", "il 116%", "il 1234%"); those are the vectors of the strings test.
The date sentences name the date in the lines' own words, and the date value itself is `formatDate` beside the calendar icon (S1.1), never inside the sentence.

Reused from `strings.terms.details`: `kinds` (the package kind as the first fact's term), `estimatedManDays`, `maxEffortManDays`, `plannedManDays`, `manDays(value)`; and `strings.common.retry`. Test ids: `project-hours` (the card),
`project-hours-consumption`, `project-hours-consumption-facts`, `project-hours-consumption-unavailable`, `project-hours-consumption-expired`, `project-hours-unavailable` (the host fallback); *US-5:* `project-hours-consumption-state`, `-percent`, `-bar`, `-pace`,
`-date-deadline`, `-date-end-date`.

### crm-ui — `strings/deals.ts`, next to `deals.meetings`

`deals.hours.heading` Hours / Ore, `.loading` Loading hours… / Caricamento delle ore…, `.unavailable` Hours are unavailable. Reload the page to try again. /
Le ore non sono disponibili. Ricarica la pagina per riprovare. Test ids `crm-deal-hours`, `crm-deal-hours-unavailable`.

Parity (`catalogGaps`) and the hardcoded-copy scan apply in all three apps (AC-3.2).

---

## AC coverage and scope

| AC | Surface |
|---|---|
| 1.1, 1.2, 1.3 | consumption block, variant A (and B for before the start), in the project's Hours card; "Over by" once exceeded (D81) |
| 1.4, 1.5, 1.6 | variants C, D; the man-day formatting |
| 1.7 | no consumption figures; the card is the widget alone — its total line, visible with no click, is "only the total hours recorded" (the disclosure adds the breakdown, one click away) — plus, when the terms have an end date that has passed or is near and the project is not closed or cancelled, the block's date line(s) (AC-5.21–5.24) |
| 1.8 | no money in any surface; the block imports no money formatter; no signal shows an amount, a price, a rate or a figure per person (AC-5.27) |
| 1.9 | the "Expired" `StatusBadge` beside the dates; its final figures carry no state (AC-5.25) |
| 2.1, 2.2 | the widget: total recorded visible with no click; per work type (with the "without a work type" row) in the disclosure, one click away; project page and deal page |
| 2.3, 2.4, 2.5, 2.7 | the widget's person table, in the disclosure, present or absent as the answer says; no copy about the absence |
| 2.6, 4.9 | host fallback, widget error, block unavailable: no figure from a part that failed, and the rest of the page, the header and every other card untouched; the card keeps its title |
| 2.8 | `HostHours` and `ConsumptionBlock` re-read in place on `operai:time-entry-recorded`, keeping what is on screen until the answer (D84; S1 states, S3) |
| 3.1 | **no UI surface** (a data and route rule) |
| 3.2 | the Copy section; formatters only (percentages and numbers of days included) |
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
| D86 (look, no AC of its own) | S1.1: state line, bar, pace line, excess, date lines; reverses S1's first-draft "no status colour" and "no progress bar" |
| 5.1–5.3 | the consumed percentage: the state line (right) and the pace line, per variant (S1.1) |
| 5.4 | no share: no state line, bar, pace line or excess (F9's exits; S1.1 cases 9, 12, 13, 15, 16, 19), the date lines aside |
| 5.5, 5.6 | no UI surface of their own (the floor, the exact minutes); visible as a percentage that never contradicts the state words |
| 5.7–5.9 | the state line (words, icon, tone) and the bar's tone; exactly 100 % has no beyond part and no excess, and its state line says "Limit reached", "Over the limit" only above the reference (D95; S1.1 case 3 and the state line's rule) |
| 5.10 | state and date lines: words and an icon by level; S1.1 tones table and readings (confirmed, D96) |
| 5.11 | the pace line, the state words, the "Over by" fact and the "Estimated man-days" fact; the bar `aria-hidden` (G7, resolved by the plan's AC-5.11 row) |
| 5.12, 5.13 | the "Over by" fact, in hours or in man-days; "Less than 0.1 man-day" |
| 5.14–5.16 | the bar: the 0–125 % scale, ticks at 80 % and 100 %, the fill, the striped beyond part, full at 125 % and beyond |
| 5.17 | the estimate diamond and its label (fixed price; S1.1 case 10) |
| 5.18, 5.19 | the today mark and the time elapsed in the pace line; none without a period with an end |
| 5.20 | no UI surface of its own (how the time elapsed is counted) |
| 5.21–5.23 | the date lines: passed (graver), near or today (milder), the deadline first, one line each |
| 5.24 | the date lines in every state of the hours read; an SLA-only project's block of date lines alone |
| 5.25, 5.26 | no state line and a neutral bar (S1.1 cases 8, 14; the tone confirmed, D96); no date line for a closed or cancelled project |
| 5.27 | no UI surface of its own: the same signals for every reader, none per person |
| 5.28 | re-read in place (S1.1 case 17): percentage, bar, state and excess move; the time elapsed and the date lines do not |
| 5.29 | no UI surface of its own (the day is `asOf`); visible only as the day counts of the date lines |

---

## Gaps

**Resolved.** G1–G6 of the first draft were answered by the owner on 2026-11-26 (ledger D81–D84) and are folded into the text above; this table is the record.

| Gap | Resolution | Folded into |
|---|---|---|
| G1 "negative when exceeded" cannot go through `formatDuration` (it clamps a negative to zero) | **"Over by" and the absolute figure** (D81, AC-1.1 amended): no minus sign, no library change | F1, S1 rules, Copy (`overBy`), Accessibility |
| G2 terms that sold nothing comparable (an SLA and no hour package) | AC-1.7 reworded (D82): no consumption figures, the widget alone; since US-5 also the date lines when the end date is near or passed | F1 "none", S1 states, S1.1 case 12 |
| G3 a capacity package past its expiry cannot say so | **"Expired" `StatusBadge` `voided`** beside the dates (D83, AC-1.9); no state on its final figures (AC-5.25) | S1 rules, S1.1 case 8, Copy (`expired`) |
| G4 version skew: a missing `on.project` before hours-api ships | read as `{ state: "none" }` (plan § Deploy order) | S4 (no design change) |
| G5 the card's figures stale after Record hours on the same page | **re-read on `operai:time-entry-recorded`** (D84, AC-2.8, plan D-P6), keeping what is on screen until the answer | S1 states, S3 |
| G6 the plan's components and test rows still described two cards | amended for D80 | — |

(Not gaps, recorded: the export has **ten** columns, the new **Counts for project** being the seventh, after Counts for deal, not the tenth; `meeting-deals` and `meeting-projects`
always come together because they share one hosts read, which the plan states in § The hours views and this design relies on for the single unknown line and the single source phrase.)

**Found while amending for US-5 (2026-11-27), and how each ended.** Each was a recommendation, with nothing designed around it except where the text says so. **G7–G11 were resolved the same day, at gate 2** — by the plan's approval and the owner's D95 and D96 — and each keeps its text and ends with the line that begins "Resolved". **G12 is the only one still open, and it asks for no action.** R9 (plan) is closed by this design, not a gap: the stripes are drawn within the dialect (S1.1).

| Gap | Status | Source |
|---|---|---|
| G7 the bar's labels against the plan's "holds no text" | **resolved** | the plan's § Test strategy AC-5.11 row and § Signals' bar bullet, approved 2026-11-27 |
| G8 the bar's utilities and the shell's sheet | **resolved** (text widened and corrected) | the plan's § Deploy order and R13, approved 2026-11-27 |
| G9 "Over the limit" at exactly 100 % | **resolved** | ledger D95 (owner, 2026-11-27); spec AC-5.9 |
| G10 the bar's tone when no state is said | **resolved** (confirmed) | ledger D96 (owner, 2026-11-27); the spec's gate-2 note |
| G11 the icon reading | **resolved** (confirmed) | ledger D96 (owner, 2026-11-27); the plan's AC-5.10 row |
| G12 "80%", not "80 %" | **open**, no action | — |

**G7. The plan's AC-5.11 test row says the `ConsumptionBar` root "holds no text"; the owner's mock labels the bar.** The mock puts "80 %", "100 %" and "125 %" under the bar and "today" and "estimate" at its marks. Those are text, drawn inside the `aria-hidden` root so
assistive technology never reads them, and each figure they stand for is in a line (S1.1 readings). *Recommend:* amend that row of § Test strategy to "the `ConsumptionBar` root is `aria-hidden="true"` and every text in it is decoration (the scale and the two mark labels),
none carrying a figure the lines do not state". The signature stays `ConsumptionBar({ share })`; the component reads its two label words from the app's strings module, as `ConsumptionBlock` does.

**Resolved — the plan's AC-5.11 row (approved 2026-11-27).** The recommendation was taken: the row now says the `ConsumptionBar` root is `aria-hidden="true"` and its text is exactly the closed set of its labels, "80%", "100%" and "125%" (`formatNumber` of the constants), "Today" only with a today mark and "Estimate" only with an estimate mark, decoration the lines and facts repeat, never the consumed percentage, an excess, a day count or a date; § Signals' bar bullet says the same. This design's bar table already drew exactly that set (rows T, S and E), so nothing here changes. The signature stays `ConsumptionBar({ share })`.

**G8. The bar's utilities are new to the suite's Tailwind sheet, the shell generates that sheet, and without the shell rebuilt from the same commit the bar is not drawn at all.** `shell/src/index.css` `@source`s every remote's source and emits the one sheet (ADR 20260709-suite-frontend-module-federation, Remote CSS strategy addendum), and Tailwind emits only the classes some scanned source holds. **Sixteen** of the utilities S1.1 specifies for the bar are in no scanned source today (the architect's measure of 2026-11-27, re-checked here against S1.1's class strings and a scan of every `@source`; no mismatch: all sixteen are in S1.1, and no other utility of the bar, the state line, the pace line or the date lines is missing from the sheet): `h-2.5` (the track row); `ring-1` with `ring-dim` (the track surface) and with `ring-ink` (the ticks, the today line, the estimate diamond and its key); `-top-1.5` (the today line); `bottom-1` (the "Today" label); `size-2` and `rotate-45` (the estimate diamond and its key); `-translate-x-full` (the "125%" label); and the beyond part's stripes, `bg-linear-90`, `from-red`, `from-soft`, `from-50%`, `to-transparent`, `to-50%` and `bg-size-[6px_100%]`. (The first draft named six of them and said the bar would be "plainer", without stripes and outlines: too small a reading of the same cause.) Without a shell built from a commit that holds projects-ui's US-5 source, the track row has no height (`h-2.5` is missing and every child of the row is absolutely positioned), so the track surface, the fill and the beyond part have none either and **the bar vanishes**; the estimate diamond and its key have no size (`size-2`) and vanish too; no mark has an outline; the "125%" label starts at the end of the track instead of ending there (`-translate-x-full`); and what is left is the ticks and the today line, which keep their sizes (`h-4 w-0.5`), and the scale labels, with no track to mark. Every text line — the facts, the state line, the pace line, the "Over by" fact and the date lines — stays complete and right, because the utilities they use are in the sheet already: a missing drawing, never a wrong figure (the bar is `aria-hidden`, AC-5.11). Read from the class list, not seen in a browser.

**Resolved — the plan's § Deploy order and R13 (approved 2026-11-27).** The plan took the correction in full: it counts the same sixteen, says the shell needs no source change but is **rebuilt and deployed from the same commit as projects-ui** (step 3, whose condition is confirmed live before step 5), describes the skew as a bar drawn "without its track, fill, beyond part or estimate diamond", and rolls the shell and projects-ui back together. Its two checks: e2e F reads in the browser the computed styles only these utilities give (the track row 10 px high, the beyond part's `background-image` a `linear-gradient` with `background-size` `6px 100%`, the estimate diamond 8 px wide with a ring), so a utility the shell's Tailwind does not generate fails the run, which a component test cannot see; and at deploy step 3 a `curl` of the live shell's stylesheets counts `bg-linear-90` (0 means the live shell predates the bar). This design adds one check: all sixteen compile under the shell's own Tailwind (4.3.2, the compiler that emits the sheet) with the suite's `tokens.css`. No design change.

**G9. "Over the limit" at exactly 100 %.** AC-5.9 makes exactly 100 % "over", so the state line reads "Over the limit" beside a package's last fact "Hours left 0 min" (there is no excess at exactly the reference). It follows the spec, a little hard on a project exactly at
its limit; "Limit reached" would be gentler and would not say "over". *Recommend:* keep; the owner can change one copy key (`state.over`).

**Resolved — D95 (owner, 2026-11-27; spec AC-5.9 and its state term amended the same day).** The recommendation above, to keep, was not taken: the owner chose the gentler words. At exactly 100 % of the reference (the hours used equal it, with no excess) the state line says "Limit reached" / "Limite raggiunto"; "Over the limit" / "Oltre il limite" only once the hours are above the reference. It is the same state, level, icon and tone; only the words change. Folded into S1.1 ("The words of the state line", the tones table, the excess paragraph, the states table's legend, case 3 and case 4's label), Accessibility, Copy (`consumption.state.limitReached`) and AC coverage. The line picks the words from `share.state === 'over' && share.excess === null`, which the plan's `Share` already gives: no new field.

**G10. The bar's tone when no state is said.** AC-5.25 and AC-5.26 say "no state", and that the bar "reads as for any package"; neither says what tone it takes. This design draws it neutral (`bg-soft`, neutral stripes beyond 100 %): a red bar with no "Over the limit" beside it would
be colour alone (AC-5.10). The plan's `Share` has no tone field, which agrees (the tone follows `share.state`, null meaning neutral). *Recommend:* confirm, and add "the bar is neutral when no state is said" to AC-5.25/5.26 or to the plan's bar row.

**Resolved — confirmed by the owner, D96 (2026-11-27).** A bar with no state said (an ended capacity package, a closed or cancelled project) is drawn neutral, never in a state's tone (AC-5.25, AC-5.26): the spec's gate-2 note records it, and the plan's Levels bullet and AC-5.25/5.26 rows already pin it. The design is as drawn (S1.1 cases 8 and 14, the tones table's last row).

**G11. The icon reading.** AC-5.10's "an icon of its own" can be read as a distinct shape per level (this design) or per signal; the second needs two more `Icon` shapes (`clock` and `ban` being the dictionary's), a library push (S1.1 readings). *Recommend:* the first reading, which the
plan's own test row ("three states three icons, two date kinds two") already takes.

**Resolved — confirmed by the owner, D96 (2026-11-27).** An icon follows the level: three shapes for the three states, two for a date that has passed or is near, a state and a date signal of the same level sharing their level's shape (AC-5.10). The plan's AC-5.10 test row takes it; no `Icon` shape is added. D95 changes no icon: the over state's two wordings share its one.

**G12. "80%", not "80 %".** The spec and the mock write a space before the percent sign; the library's `formatNumber` percent writes none in en-GB and it-IT, and AC-3.2 and R11 require the formatter. The design uses its output; the plan's AC-3.2 row already says "99%". No action,
beyond remembering it when a test compares strings against the spec's examples.

---

## Self-critique

One pass against the design.md checklist, over the D80 rewrite (one card, closed breakdown). **Fixed:** (1) the widget's empty state was a centred `StatePanel`, which would dominate a two-line card on every deal with no hours: now a total "0 min" plus one sentence and no disclosure; (2) the names and per-person notes
sat above the tables and would have shown on a closed card: moved inside the open region, where the thing they explain is; (3) the widget still announced its total on load, which, with the card now read in place like the Terms card, is noise: dropped (focus after Retry carries it); (4) `MeetingsSection`'s fallback replaces a whole card, which here would have hidden the consumption block when only the widget failed: the
frame, the block and the widget's slot are separated, and the four combinations of failure (block, widget, both, neither) are written down with what each shows; (5) a conditional render of the region would have left `aria-controls` pointing at nothing: the region stays mounted and `hidden`; (6) the consumption block had a card title of
its own inside a card titled "Hours": now a named group with no visible heading. **Kept, reported instead:** the disclosure is the third hand-made copy of the pattern (library lift recommended, not in scope); two banners when both parts fail (cannot be one, props are plain strings); the disclosure, the notes, the hints and the grouping banner are UI no AC asks for (listed, droppable); AC-3.1 and AC-4.1/4.2 have no UI surface (stated);
G1–G6 are for the owner or the plan, not design choices.

Second pass, 2026-11-27, over the US-5 amendment (same checklist, one pass). **Fixed:** (1) the inventory's `formatDuration` row still said "G1: one option may be added", which D81 made untrue: now "no option is added"; (2) the AC-5.4 coverage row left the
loading case (S1.1 case 15) out of the cases with no share; (3) the tones paragraph called `--soft` a fill only, though it is also a text token: now said both ways; (4) the contrast intro claimed numbers for the date boxes' borders, which are decoration and have none:
dropped; (5) the `HoursSection` sketch still said "when there is a variant": now `hasConsumptionBlock`; (6) the date lines' `mt-3` would have left a gap above a block of date lines alone: now only when something precedes them; (7) three sketches ran together: separated.
Missing-state check: every new part has its loading, error, empty and refreshing behaviour in S1.1's 19-row table, the share and the date lines in separate columns because they fail independently. **Kept, reported instead** (as of that pass; G7–G11 were resolved the same day at gate 2, see § Gaps and the third pass below, so only G12 is still open): the plan's AC-5.11 test row ("holds no text") against the
mock's labels (G7, resolved by the plan's row); the shell rebuild the bar's new utilities need (G8, resolved by plan § Deploy order and R13); "Over the limit" at exactly 100 % (G9, resolved by D95: "Limit reached"); the neutral tone with no state (G10, confirmed by D96); the icon reading and the two-icon date line (G11, confirmed by D96); "80%" for "80 %" (G12, **open**, no action); the estimate label sits two rows below its
mark and is tied to it by shape and by x, not by a leader, because a leader would strike through the "80%" label (S1.1) — the one place the mock's directness is traded for legibility; the state line's percentage is `aria-hidden` and repeats the pace line on purpose; the
NEW count is one (`ConsumptionBar`), the state line, pace line and date lines being private helpers, not components.

Third pass, 2026-11-27, over the gate-2 amendment (same checklist, one pass). **Fixed:** (1) case 4 of the states table said "over (101 % or more)", which, once D95 gave the exact reference its own words, left the hours between the reference and 101 % of it (AC-5.9's 120 h 30 of 120 h, reading "100%") in neither case 3 nor case 4: now "above the reference"; (2) the Inputs paragraph still called the plan `draft` pending gate 2 and stopped at D94 and R12; (3) the tones table, the AC coverage row of AC-5.7–5.9 and the accessibility bullet on silent state changes named only "Over the limit", and the excess paragraph said nothing of the state line at exactly 100 %; (4) G8 named six utilities and called the skew a plainer bar: it is sixteen, and the bar is not drawn (each utility was checked against S1.1's own class strings and the suite's source, and compiled under the shell's Tailwind: no utility of S1.1 outside the sixteen is new to the sheet, so there is no mismatch to report). Missing-state check: "Limit reached" is one more wording of a state the 19-row table already covers in every case (case 3 changes its words; cases 8 and 14 say no state; 15 and 16 draw none), so no loading, empty or error state is added or lost. NEW and duplicate check: no component, icon or library change; the choice of words is the state-line helper's, and one copy key is added in en and it. Flow and AC check: the wording is asked by D95 and now by AC-5.9's own text, so the design adds no UI that no AC or decision asks for. Accessibility check: the new words are text in the same line as the old, with the same icon and level, and the bar stays `aria-hidden`. **Kept, reported instead:** G12; the plan's prose still calls the neutral tone pending the owner's confirmation (its header note and the Levels bullet) and its AC-5.9 test row and § Signals do not yet name the two wordings (this design cannot amend the plan); three test ids the plan has the block task add for e2e F (`project-hours-consumption-bar-track`, `-bar-beyond`, `-bar-estimate`) are not in this design's test-id list, which names the bar's root only.
