---
topic: Log hours directly from the project and deal pages and from task rows, not only from My hours in the user menu
grilled: 2026-11-16
target: idea (spec written from it: specs/20261116-record-hours-in-place/spec.md)
complete: true
---

## Decision ledger — record hours in place (project, deal, task rows)

Why (the user's words): "il fatto di dover aprire il time tracking dal menu in alto sembra macchinoso e
limita la velocità; dovrebbe essere possibile loggare le ore direttamente dalla vista del progetto/deal".

Map (all closed): B1 entry points (D1, D2) · B2 form (D3) · B3 who sees the button (D4) · B4 after saving (D6) ·
B5 where it lives (D5).

Decided (the user chose):
- D1 Entry points: "Record hours" on the project page, on the CRM deal page AND on each task row (the project's Tasks card, My tasks, the CRM's task lists), a task row prefilling the task as well — user chose this over the recommended "project + deal pages only" and over a global header button, 2026-11-16
- D2 A CRM task with no deal also offers "Record hours": it records "other work" with a category, without a link to the company or the task (an activity pointer exists only on a project or a deal, F6) — user chose this over the recommended "no button on such tasks" and over adding company as a target, 2026-11-16
- D3 Form: the My hours entry dialog itself, opened with the project or deal (and the task, from a task row) already set and not changeable there, the day set to today and focus on the duration; recording elsewhere stays My hours' job — user chose the recommended option over an editable target and over an inline quick form, 2026-11-16
- D4 Who sees the button: only people the page already knows can record there — the project's project manager and team, the deal's owner and technical contact, a task's assignee and participants (and, on a CRM task without a deal, its people, since "other work" needs no owner's leave); no new API: hours-api still decides, and an edge case the page cannot see (e.g. someone on a deal only through another activity) gets no button and uses My hours — user chose the recommended option over "everyone who reads the page" and over asking hours-api, 2026-11-16
- D5 Placement: a new, small spec that depends on specs/20261112-time-tracking only, can start once it closes and ship before specs/20261112-project-hours, whose read-only hours card later sits next to the button — user chose the recommended option over amending project-hours and over adding tasks to time tracking, 2026-11-16
- D6 After Save: a short success message on the page ("2 h 30 recorded on <project>") with a "See in My hours" link; nothing else on the page changes, and editing or deleting stays in My hours — user chose the recommended option over an Undo and over showing the person's own hours on the page, 2026-11-16
Delegated (the user deferred to the recommendation):
- (none)
Found (read from the repo, not asked):
- F1 My hours is reached from the user menu because the hours screens are ungated and not a `TOOLS` entry — docs/adr/20261112-hours-ui-ungated-remote.md
- F2 hours-ui's `EntryDialog` was designed prop-driven (initial values in, one submit out, no router coupling) precisely so the project/deal pages and meeting suggestions could reuse it — specs/20261112-time-tracking/design.md § Seams
- F3 The shell already lets a host page embed another remote's panel with a 5 s timeout, an error boundary and the host's own fallback (Meetings on the CRM deal page) — shell/src/lib/extensions.tsx, ADR 20261104-host-extension-federated-panel-through-the-shell
- F4 specs/20261112-project-hours (approved, no plan yet) adds a READ-ONLY hours card to the project and deal pages (US-2, D34); recording from those pages is in no spec — specs/20261112-project-hours/spec.md
- F5 Who may record is decided by hours-api at write time: on a project its project manager and team, on a deal its owner, its technical contact or an assignee/participant of one of its activities; anyone else gets 403 `not_on_project` / `not_involved_in_deal` — specs/20261112-time-tracking AC-2.2, AC-2.3, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route
- F6 An entry may point at one activity (task) only on a project or a deal — specs/20261112-time-tracking AC-2.7
- F7 A timer or start/end times are a non-goal of time tracking v1 (D8)
- F8 Hours "right after a meeting" are covered by specs/20261112-meeting-hours (entries suggested from one's meetings)
- F9 A pre-sales (CRM) task is about a company and only OPTIONALLY about one of its deals; time tracking has no "company" target (project, deal, meeting or other work only) — .claude/context/glossary.md § Activities, specs/20261112-time-tracking US-2
Assumed (not load-bearing; strike any that is wrong):
- A1 If hours-ui cannot load, the project/deal page and the task lists still work and show the host's own fallback in place of the button (F3; the A20 posture of specs/20261112-project-hours)
- A2 Same rules as My hours: whole 30-minute steps, a real day not in the future, work type and note optional, the same refusals and messages (the dialog is the same, D3)
- A3 On a CRM task without a deal (D2) the dialog opens on "other work" with no category preselected: the person picks one (no "pre-sales" category is seeded, and none is configured as a default)
- A4 The button is offered on open and on completed tasks alike: hours are often recorded after the work is done
- A5 A project or deal the person can record on in My hours is exactly where the button may appear; whatever hours-api accepts or refuses there (a closed project, a lost deal) applies unchanged — no extra state rule in the pages
- A6 Meeting pages get no button: hours from meetings are specs/20261112-meeting-hours' suggestions (F8)
Open (unresolved — each needs an owner):
- (none)

---

## Decision ledger — week view in My hours (amendment grilled 2026-11-16)

Target: specs/20261116-record-hours-in-place/spec.md (status: approved — consequences are proposed amendments).
Placement (the user chose): the week view goes into this spec, not into specs/20261112-time-tracking (nearly
closed) nor into another follow-up — "mettiamo nella spec 20261116-record-hours-in-place", 2026-11-16.

Map: W1 purpose (see / record from a cell / type in the cell) → W2 cells that already hold hours → W3 recording
on something not yet in the week → W4 what a row is → W5 where it sits in My hours and which view opens first.

Decided (the user chose):
- D7 Week view purpose (W1): see the week AND work from it — a cell opens the My hours entry dialog with that
  day and the row's project, deal or category already set (D3's dialog), and the detail behind a cell can be
  changed from the week too ("anche modificare il dettaglio") — user chose the recommended "see + record"
  and added editing, over read-only and over typing hours into the cell (timesheet), 2026-11-16.
  Consequence: AC-4.4 ("no page of this spec offers" edit or delete) must say "no page outside My hours",
  since the week view is part of My hours
- D8 A cell that already holds hours (W2): clicking it opens its detail — the entries of that day on that row,
  each with Edit and Delete (the list's dialog and the list's delete confirmation) — and "Add hours", which
  opens the entry dialog with that day and that row set; an empty cell opens the entry dialog directly — user
  chose the recommended option over "detail with Edit only" and over "open the list filtered to the cell",
  2026-11-16
- D9 Something with no hours yet in the week (W3): the week shows a row only for what holds hours that week;
  anything else is recorded with the page's Record hours button (the dialog with the target picker), and its
  row appears once saved — user chose the recommended option over "Add row" and over showing last week's rows
  empty, 2026-11-16
- D10 A row (W4): one row per thing the hours are on — each project, each deal, each meeting, each category of
  other work; work type, task and note are in the cell's detail; a meeting's hours stay on the meeting's row
  even when it counts for a deal — user chose the recommended option over meetings inside their deal's row and
  over one row for all other work, 2026-11-16
- D11 Placement (W5): a List | Week switch inside My hours; My hours opens on the List as today; the address
  names the view, so a bookmark can open the week; the week is filtered by the list's existing filters
  ("stessi filtri già esistenti per la lista") — user chose the recommended option over opening on the week
  and over remembering the last view, and added the filters, 2026-11-16
Constraints (volunteered by the user, verbatim — for the plan and the design, not explored here):
- C1 "in merito al layout, sfrutta tutta la dimensione della pagine come fatto in Estimai" (2026-11-16)
Delegated (the user deferred to the recommendation):
- (none yet)
Found (read from the repo, not asked):
- WF1 A week grid or timesheet is listed as "Not designed — scope creep, reported" in time tracking —
  specs/20261112-time-tracking/design.md § Not designed
- WF2 My hours today: Period select (This week, Last week, This month default, …), entries grouped by day with
  a day total, a Totals card grouped by project, deal, category or month; weeks start on Monday —
  specs/20261112-time-tracking/design.md S1
- WF3 No figure on screen is computed in the browser; every total comes from hours-api's totals, which today
  group by ONE dimension (person, project, deal, category, month or day) — design.md conventions, plan.md
  § Totals. A grid of rows × days needs two at once: the plan decides how
- WF4 D23 of time tracking: no completeness check — each day's total, no "incomplete" mark, no reminder (the
  user chose it over marking partial days); D8: a day and a duration, never a time of day; D14: only the person
  writes their own entries — specs/20261112-time-tracking/ledger.md
- WF6 The design system gives a tool page one of three widths through `ToolLayout`: narrow 40rem, default
  80rem (every list and detail page; hours-ui today), wide = the full width with a 24px gutter (data-dense
  workspaces, the CRM pipeline); EstimAI's estimate workspace uses the full width —
  operai-ui/docs/design-system.md, hours-ui/src/components/HoursShell.tsx. C1 reads as the week view on the
  full width; whether the List does too is the design's call
- WF5 One day and one target can hold several entries (different work types, tasks, notes) —
  specs/20261112-time-tracking AC-2.7, US-1
Assumed (not load-bearing; strike any that is wrong):
- WA1 Weeks run Monday to Sunday, all seven days shown (the rules allow recording on a weekend)
- WA2 D23 holds in the week view: day and week totals, no "incomplete" mark, no 42-hour target shown
- WA3 Every rule of My hours holds unchanged: names a person cannot read are not shown, the same refusals,
  English and Italian
- WA4 Own hours only: Everyone's hours gets no week view
- WA5 The week replaces the Period filter (previous week, next week, this week; any past week); the other
  filters (project, deal, category, work type) apply to the week, and switching view keeps them (D11)
- WA6 Opened from a week cell, the entry dialog has the day and the row's project, deal, meeting or category set
  but changeable — it is My hours' own dialog, so D3's "not changeable" (about other pages) does not apply
- WA7 A day after today offers no recording (the future-day rule); its cell shows nothing to add
- WA8 Rows ordered by kind (projects, deals, meetings, other work), then by name; a row whose name the person
  cannot read is shown as in the list ("not visible to you"), its entries editable from the detail, with no
  "Add hours" on it
- WA9 After a save, an edit or a delete from the week, the cell, its row, its day and the week total show the
  new figures
- WA10 No export from the week: the list's export covers it
Open (unresolved — each needs an owner):
- (none)

Later note (2026-11-16): specs/20261112-time-tracking added a **Recorded on** filter to My hours (its D52). D11's
"stessi filtri già esistenti per la lista" includes it, so AC-5.21 names it — the user asked to align the spec
and keep it approved.

---

## Decision ledger — design review (2026-11-17)

Target: specs/20261116-record-hours-in-place/spec.md (status: approved) — two gaps the design found (design.md § Gaps,
G2, G4) touched approved ACs; the user chose, and the spec is amended and kept approved.

Decided (the user chose):
- D12 A Week row on a retired category behaves as an unreadable row: no recording on its empty cells, no Add hours in its
  cells' lists; its entries stay listed, changed and deleted (AC-5.24 amended) — user chose the recommended option over
  "open the dialog with no category" (it would offer a different category than the row), 2026-11-17
- D13 In the dialog opened from a page (target fixed), a refusal My hours shows on the picker (`not_on_project`,
  `not_involved_in_deal`, the target gone) is shown for the whole dialog with the same sentence, and the target-gone
  sentence drops "Choose another" (AC-4.2 amended) — user chose the recommended option over the identical text, which
  invites an action the dialog cannot offer, 2026-11-17
Found:
- DF1 A retired category is never offered for a new entry — specs/20261112-time-tracking AC-3.4
- DF2 The design's other gaps (G1, G3, G5, G7) are plan-level and adopted as the plan's first amendment; G6, G8–G11
  stand as designed — design.md § Gaps


## Decision ledger — closing (2026-11-19)

Decided:
- D14 The screen-reader readback (NVDA, VoiceOver) of the success status, the Week cells' labels, the phone-width scroll
  hint and a refused save's alert is not part of this feature's gate; the roles, texts, `aria-hidden` and focus stay
  verified by the unit and e2e tests, the readback is a follow-up (design.md § Amendment 2026-11-19) — user chose
  removing it from the design over running the five-step VoiceOver check (recommended), 2026-11-19


## Decision ledger — table view: week and month (grilled 2026-11-19)

Target: specs/20261116-record-hours-in-place/spec.md, reopened (D22). The user's asks, after using the Week view: "il
passaggio tra list e week ridimensiona la pagina con un brutto effetto", "non c'è un datepicker per il cambio di
settimana", "sarebbe utile avere anche una vista mensile, sempre con un datepicker per la selezione", "rimuovi il bottone
`+` su una cella vuota". Grilled first as a free-form idea (`.forge/grill/my-hours-calendar-views.md`, now folded in
here and removed); renumbered from D15 so no number repeats an earlier section's.

Map (all closed): month shape (D15) · page width (D16) · empty cells (D17) · date field (D18, D20) · views and default
(D19, D23) · where the change lands (D21, D22) · Next (D24).

Decided (the user chose):
- D15 Month: the Week's grid over one calendar month — a row per project, deal, meeting and category of other work held
  that month, a column per day of the month (28–31), row, day and month totals, the same rows, cells and cell dialog as
  the week; it scrolls sideways where the month does not fit — user chose the recommended "Foglio ore" over a classic
  Monday-to-Sunday calendar (fits, but no split by project) and a per-week summary (no day detail), 2026-11-19
- D16 Every hours page uses the full page width (My hours in either view and period, Everyone's hours, Settings), so
  neither a view switch nor a tab change resizes the page — user chose the recommended option over full width for My
  hours only (the jump stays between tabs) and 80rem everywhere (drops C1); accepted cost: long lines for the List and
  the Settings forms on very wide screens, 2026-11-19
- D17 An empty cell is not a control, in the week and the month: no plus, no action; hours are recorded with Record
  hours or with Add hours in the list of a cell that holds hours — user chose this over the whole empty cell as a button
  with no icon (recommended) and a plus shown only on hover or focus; withdraws AC-5.12, 2026-11-19
- D18 The week and the month each offer a date field (the date input hours-ui's filters already use) beside previous /
  current / next: choosing a day shows the week or the month that holds it — user chose the recommended option over a
  new calendar component in the design system (week highlighted, month picked directly) and a month + year select for
  the month, 2026-11-19
- D19 Week and month are one view, the table view, with a choice of period; the List is a different view; My hours opens
  on the table view — the user, correcting the assumption "List | Week | Month, opening on the List": "week e month sono
  accomunate, la vista a lista è proprio una cosa diversa, inoltre la vista tabellare (settimana / mese) deve essere la
  default"; reverses AC-5.1 and the non-goal "Opening My hours on the Week view", 2026-11-19
- D20 The date field reaches only the current period and past ones, never a future day — the user, correcting the
  assumption "any day, a future one included": "no, corrente e passati", 2026-11-19
- D21 The change amends this spec, no follow-up spec — the user, correcting the assumption "a new spec that depends on
  this one": "modifica la spec attuale, non crearne un'altra", 2026-11-19
- D22 The feature is reopened on purpose: the close commit 29c97359 is reverted (9ab6b879), status back to
  `in-progress`; PR #11 is a draft and not merged, so nothing has shipped, and the earlier close stays in git history
  and in run trace 2026-11-19T07-40-00Z; spec, plan and design are amended and re-approved, tasks re-synced, then
  implement, QE, security, eval and /wellforge:done again — user chose the recommended option over a follow-up spec that
  would keep this one done (WellForge refuses a reopening by editing the status; a revert is its sanctioned way),
  2026-11-19
- D23 The table view opens on the week, the current one — user chose the recommended option over the month (it scrolls
  below ~1500 px) and the last period used, 2026-11-19
- D24 Next stops at the current period: on the current week or month it moves nowhere, and an address naming a future
  period opens the current one — user chose the recommended option over Next reaching future, empty periods; amends
  AC-5.5 and design S7's "Next week is always offered" and its "not started" state, 2026-11-19
- D25 From the current week, Month shows the current month (today's), also when the week straddles two months; from a
  past week, the month of its Monday — user chose the recommended option at the plan gate over "always the Monday's
  month" (the current week Mon 30 Nov – Sun 6 Dec 2026, today 2 December, would have shown November); amends AC-5.26,
  2026-11-19
- D26 Month → Week shows the week the month was reached from when it has a day in that month, else the current week when
  it has one, else the first week whose Monday is in the month — user chose the recommended option at the design gate
  over the plan's rule (current week, else the week holding the 1st), which lost the week left (12–18 Oct → October →
  28 Sep – 4 Oct) and could show a week mostly in the previous month (November 2026 → 26 Oct – 1 Nov); amends AC-5.27,
  2026-11-19
- D27 The month's row-label and Total columns stay in view while it scrolls sideways, through a new optional `pin` prop
  on the design system's table — user chose the recommended option at the design gate over a month with no fixed
  columns (row names and totals scroll out of sight); a design-system change shipped in the shell before hours-ui,
  2026-11-19

Found (read from the repo, not asked):
- MF1 The jump is the column width: hours-ui's root layout gives My hours' List the design system's `default` width
  (80rem) and the Week `wide` (full width), per C1 (2026-11-16) — `hours-ui/src/components/HoursShell.tsx`
- MF2 This spec was `done` (29c97359) with PR #11 a draft; WellForge's post-spec-guard refuses moving a closed spec's
  status backwards by edit and names a revert of the closing commit as the way for a close made too early
- MF3 The week's address is `?view=week&week=<Monday>`; the navigator offers previous / this week / next only (AC-5.5)
- MF4 The design system has a date input (the browser's own), used by hours-ui's filters and entry dialog; it has no
  week or month picker
- MF5 The plus on an empty cell was deliberate (design.md S7: hover does not exist on a phone, a hidden control is not
  discoverable); AC-5.12 required an empty cell to open the entry dialog
- MF6 ADR 20261116-week-view-sums-a-complete-read-in-the-browser allows browser sums over one complete read of a bounded
  span for the Week view only; the month summed the same way amends it
- MF7 The complete read walks `GET /time-entries` in pages of 500 (`hours-ui/src/lib/exportPages.ts`)

Assumed (not load-bearing; strike any that is wrong):
- MA1 The month's cells behave as the week's: a cell that holds hours opens the same list (entries, Edit, Delete, Add
  hours on today or earlier); an empty cell does nothing (D15, D17)
- MA2 The List, the table view's week and its month each have an address of their own, opened directly; the words
  naming the table view and its periods are the designer's
- MA3 The month offers the previous month, the next month up to the current one (D24) and a return to the current month
- MA4 The month applies the same filters as the week, kept when switching view or period
- MA5 The month's figures are summed in the browser from one complete, all-or-nothing read of that month, as the week's:
  a failed page is an error, never a partial grid (MF6; the plan's to write)
- MA6 Switching period keeps the time in view: week to month shows the month of the week's Monday; month to week shows
  the current week when it falls in that month, otherwise the month's first week
- MA7 Everyone's hours gets no table view; it only follows D16's width
- MA8 Where the month does not fit, its table scrolls sideways with the week's scroll hint; every day of the month is a
  column, weekends included, with no target or comparison (WA2)
- MA9 Tier `production`, unchanged

Open: none.
