---
spec: 20261116
status: approved
approved: 2026-11-19
---

# Design: Record hours in place, and a table view of My hours (week and month)

> **Reopened 2026-11-19 and re-approved by the user the same day** (with D26: Month → Week returns to the week left; D27: the `pin` prop accepted) (spec reopened, ledger D15–D25, AC-5.1–5.34; plan
> § Amendment 2026-11-19). The Week view became the **table view** — a week or a calendar month, My hours' default — with
> a date field, a Next that stops at the current period, empty cells that offer nothing, and the full width on every hours
> page. **What this changes is stated in § Amendment 2026-11-19 — the table view: week and month (end of file).** Where an
> older section below is overtaken it carries a *Superseded 2026-11-19* note and is kept as history, the way the earlier
> amendments were; everything not marked still holds (F1, F2, S1–S5, S8 but for one line, the entry dialog, the success
> message). Where the older text says "Week" and the amendment says "table view" or "period", the amendment wins.

Inputs read: `spec.md` (approved, amended and re-approved 2026-11-16: US-1–US-5, 41 ACs, C1, A1–A7, WA1–WA10),
`ledger.md` (D1–D11), `plan.md` (approved; binding: Components table, "Decisions this plan makes", the
`hours.recordHours` / `EntryDialog` / `weekGrid` contracts, R1, R4, R5, R10), `operai-ui/docs/{building-pages,design-system}.md`,
`operai-ui/src/index.ts`, `specs/20261112-time-tracking/design.md` (S1 My hours, S2 entry dialog, F1–F3; this design
extends it and follows its voice), and the code it is drawn against: `hours-ui` (`MyHoursPage`, `EntryDialog`,
`EntryDialogModel`, `ActivityField`, `EntryDayList`, `HoursFilters`, `HoursShell`, `SuccessBanner`,
`DeleteEntryDialog`, `HoursBanners`, `strings/*`), `projects-ui` (`ProjectDetailPage`, `TasksCard`,
`ProjectTaskItem`, `MyTasksPageRow`), `crm-ui` (`DealDetailPage`, `TasksPage`, `ActivityItem`, `MeetingsSection`,
`LoadState`), `shell/src/lib/extensions.tsx`, and `TaskRow`, `Tabs`, `DataTable`, `Banner`, `Dialog`, `Card`,
`ToolLayout` in `operai-ui`.

**Inspected first-hand.** The dev stack answered on `:5173`; a dev test-auth session (`admin@operai.test`) was
used (no Google sign-in). I looked at My hours (1440 px), a project page (header with its state actions, the Tasks
card and a task row), the CRM Tasks page and EstimAI's estimate workspace (C1's reference width). Where the
design depends on how something lays out, I injected throwaway DOM built from the library's own classes (a
success banner in the project header and in a task row at 1440, 1024 and 375 px; a Week-shaped `DataTable` in the
My hours page at 1440 and 375 px) and read the result; nothing was written to the repo (the screenshots are
in the git-ignored `.playwright-mcp/`). Findings from those checks are marked **(checked)**. The 2026-11-17
amendment (after the QE verdict) re-measured the Week on a live week at 375, 960 and 1024 px, changing the row-label
floor at run time to compare candidates; nothing was written to the repo.

Surfaces: **two pages change** (My hours gains a view; a project page and a deal page gain one button),
**two lists change** (project and CRM task rows gain one button; My tasks too), **three dialogs** (the entry
dialog in two new modes, the new cell dialog; the delete confirmation is reused unchanged) and **one new message**.
Page types from `operai-ui/src/pages`: the Week is an *Item list* variant (a table of comparable cells in a card);
Record hours in place is the *Quick create in a dialog* page type reached from other tools' pages. Library in use:
**`@operai/ui`** with Tailwind token utilities (ADR 20261031-shared-ui-library-consumed-as-source,
20261031-one-styling-dialect-token-utilities); not Mantine. No visual direction section: the project has a design
system and it wins.

Conventions that hold on every screen below (not repeated): all copy is an `en` catalog plus a complete
`it: typeof en` through `selectStrings`, sentence case, parity and hardcoded-copy tests (AC-4.6); durations only
through `formatDuration(minutes * 60_000, { style: 'short' })` ("2 h 30"; the existing `aria-label`s use the same
short form, so do these); dates only through `formatDate` (dd.mm.yyyy) and `formatDateLong`; "today" is
`todayZurich()`; weeks start on Monday (WA1); colour only as token utilities; no `--muted` for text; icons only
through `Icon`; statuses and kinds through `Badge`/`StatusBadge`. **Weekday names are copy, not a date format**
(the library has no weekday formatter): a catalog of seven short and seven long names, en and it. **A week is
written as two `formatDate`s with an en dash**, "16.11.2026 – 22.11.2026"; a compact "16–22.11.2026" would need a
new library formatter (R4: library first) and nothing here needs it. A name a viewer may not read is never shown
and no screen displays an entity id (time-tracking design, "Names the viewer cannot read"; AC-5.23). The Week is
the one view that sums in the browser (plan decision 1, ADR candidate R1); it still shows no target, no
"incomplete" mark and no comparison (AC-5.11).

---

## Flows

Six flows. Every one maps to the ACs it serves; refusals are the existing ones (S2 of time tracking), unchanged.

### F1 Record hours in place — US-1, US-2, US-3, US-4, AC-1.1–1.3, 2.1–2.3, 3.1–3.6, 4.1–4.4, 4.6

Entry points (the host decides whether each shows, D4; hours-api decides every save):

| Entry point | Where | Records on | Notes |
|---|---|---|---|
| **Record hours** in the page header | project page; deal page | that project / deal | AC-1.1, 2.1 |
| **Record hours** on a task row | project Tasks card; My tasks (project and pre-sales rows); CRM Tasks page; every CRM activity timeline (deal, company, contact) | a project task → project + the task; a task about a deal → deal + the task; a task about a company with no deal → **other work**, no category chosen, no link to the task | AC-3.1–3.6; done tasks as open ones (A4) |

1. The host renders the offer only for a person its data says may record (project: manager or team; deal: owner or
   technical contact; task: assignee or participant). Everyone else sees nothing (AC-1.2, 2.2; the author of a task
   alone gets nothing).
2. The widget loads with **no placeholder**: nothing shows until hours-ui answers, then the button appears (in a
   right-aligned cluster a new leftmost button does not move the ones already there, by the header's
   `space-between` layout). After 5 s without an answer the host's fallback link takes its place (F2).
3. **Record hours** opens the entry dialog in `fixed` mode (S4): Day = today, **focus on Duration**, the target
   (and, from a task row, the task) shown as read-only text.
4. The person types a duration; may change the day, the work type, the activity (page-opened only) and the note;
   a deal-less CRM task also needs a **category** (S4).
5. **Save entry.** Success exit: the dialog closes, focus returns to Record hours (the library does it), and the
   message of S3 appears where the person acted: "2 h 30 recorded on <name>." with **See in My hours**.
   Nothing else on the host page is read again or redrawn (AC-4.3).
6. Error exits (dialog stays open, every value kept, same words as My hours, AC-4.2): `invalid_minutes`,
   `future_day`, `note_*` at the field; `not_on_project`, `not_involved_in_deal` and a vanished target at the
   **form level** (there is no picker to carry them, S4 *Errors*); `host_unavailable` fail-closed as in S2.
7. After the message: **See in My hours** (shell transition to `/hours`) or **×** (dismiss); it does not lapse on its own (S3, G1).
   An entry is changed or deleted only in My hours (AC-4.4): no Edit, no Delete, no Undo anywhere in this flow.

### F2 The hours screens cannot be loaded — AC-4.5, A1

The project page, the deal page and every list of tasks load and work exactly as before. Where Record hours would
be, **only for a person who would have been offered it**, the host shows its own fallback link, "Record hours in
My hours" (S5), after the widget failed to load, threw, or did not answer in 5 s. Not while loading. A host on a
shell that predates `hours.recordHours` (unknown name) gets the same link at once (plan R2). The link is a plain
anchor to `/hours`: when hours-ui is down it lands on the shell's own remote-failure state, which is the right
place to retry.

### F3 Open the Week and move between weeks — US-5, AC-5.1–5.5, 5.21, 5.22

> *Superseded 2026-11-19 (D19, D23, D24; AC-5.1 reversed, AC-5.5 amended): My hours opens on the table view, there are two periods, and Next stops at the current one. See the amendment's F3 and F7.*

1. My hours opens on the **List**, as before (AC-5.1). A **List | Week** switch sits under the page header (S6).
2. **Week** (click or arrow key) sets `?view=week` (the address, AC-5.2). The page stays mounted, so the project
   and deal picks, the Recorded on, Category and Work type filters are all still set (AC-5.22). The container
   goes full width (C1). Period (and its From / To) leave the Filters card; the Totals and Entries cards and
   Export are not shown (WA5, WA10).
3. The Week card shows the **current week** (AC-5.4) read in full, then the grid (S7). `‹` / `›` step one week;
   **This week** returns (AC-5.5). The week is in the address (`&week=<Monday>`), so a bookmark or a reload keeps it.
4. Any filter change reads the week again with the same span; "Clear filters" keeps the view and the week.
5. **List** goes back; the List's own Period is as the person left it (kept in the URL, unread in the Week).
6. Exits: loading, empty (no hours, or none matching the filters), error with Retry, the deal-filter refusal
   (AC-4.11 of time tracking), and the source-down notes — S7 *States*. **After a Retry that works, focus goes to the
   Week card's heading** (the Retry button went with the error); if the read fails again, focus goes to the banner
   that replaced it (S7 *Focus after a write or a Retry*).

### F4 Record on an empty cell — AC-5.12–5.14, 5.19, 5.20, WA6, WA7

> *Withdrawn 2026-11-19 (D17; AC-5.12 withdrawn, AC-5.32): an empty cell is not a control, so there is no plus and no recording from it. Hours are recorded with Record hours (F6) or with Add hours in the list of a cell that holds hours (F5). Kept below as history only.*

1. An empty cell of **today or an earlier day** on a readable row is a button (a plus). A future day's cell has
   no button; neither has an empty cell of an unreadable row (nor of a retired category's row: AC-5.24 as amended, G4).
2. It opens **My hours' own entry dialog** (S9) with that day and the row's project, deal, meeting or category
   set — still changeable (AC-5.13) — and focus on Duration.
3. Save: the dialog closes, the week is read again, the cell, its row total, its day total and the week total show
   the new figures without a reload (AC-5.20), a compact "Entry saved." confirms, and **focus goes to the same
   cell** (now holding hours); if the person changed the day or the row and the cell is no longer there, to the
   Week card's heading. Changed to a day outside the week shown: the confirmation says so (S7).
4. Errors: as S2; the dialog stays open.

### F5 Work on a cell's entries — AC-5.15–5.18, 5.20, 5.24

> *Amended 2026-11-19: step 5 now sends focus to the card's heading, never to "the cell, now empty" (an empty cell is no control, D17); the table keeps its sideways scroll position across the re-read. See the amendment's F5.*

1. A cell that holds hours is a button showing its total. It opens the **cell dialog** (S8): the entries of that
   row on that day, each exactly as My hours' list shows it, each with Edit and Delete; **Add hours** (not on an
   unreadable row, nor on a retired category's: AC-5.24 as amended).
2. **Edit** opens the entry dialog on that entry, *over* the cell dialog (the library stacks dialogs). Save: it
   closes, the week is read again, the figures follow (AC-5.20), focus returns to the entry's Edit button.
3. **Delete** opens the existing confirmation over the cell dialog; only Confirm deletes (AC-5.17); Cancel sends
   nothing. A 404 is "already gone", as in My hours.
4. **Add hours** opens the entry dialog (S9) with that day and row set; the cell dialog stays open behind it and
   shows the new entry once saved.
5. **When the last entry leaves the cell** (deleted, or edited to another day or row): the cell dialog **closes**
   after the new figures arrive, focus goes to the cell button (now empty) or, if its row is gone, to the card's
   heading, and the page says what happened ("Entry deleted." / "Entry saved."). An empty list in a dialog is a
   dead end; closing lands on the cell, one Enter from recording again.

### F6 Record with the page's Record hours while the Week is shown — AC-5.19, 5.20

> *Amended 2026-11-19: holds for the week and for the month; the outside-the-period sentence is the period's (`table.week.savedOutside`, `table.month.savedOutside`).*

**Record hours** in the page header (S6) is the List's: the dialog opens as in time tracking F1 (nothing preset,
today). Save reads the week again; if the day is in the week shown, the row appears (or the existing row's figures
change), AC-5.19; focus returns to Record hours. If the day is outside the week shown, the confirmation says so
("Entry saved. 16.11.2026 is outside the week you are viewing.", the Week's twin of the List's
`savedOutsidePeriod`). A row exists only for what holds hours that week (D9): there is no "Add row".

---

## Screens & states

Nine. S1–S5 are the in-place offer, S6–S9 the Week.

### S1 Record hours in a page header — project page, deal page (AC-1.1, 1.2, 2.1, 2.2, 4.5)

```
‹ Back to projects
Alpenstrom — portale clienti  [Active]             [Record hours] [Put on hold] [Close] [Cancel project]
Details …                                           ↑ secondary     ↑ the manage actions, only for those who manage
```

- **Where.** First item of the header's `actions`, ahead of the manage actions. The two groups mean different
  things (my own time vs managing the record) and the second is shown only to some people, so Record hours is
  the one item that is always at the left end of the cluster for everyone who has it: a non-manager sees it
  alone, a manager sees it with their state actions to its right. On the deal page, `actions` becomes a fragment
  (`<RecordHoursAction/>` then `{canManage && …}`) so a technical contact without `deal:manage` still gets it.
- **Variant.** `secondary`, default size, label "Record hours" (the string My hours already uses). Never
  `primary`: the project's primary is its state move ("Start project") and the deal's is "Move stage"; a header
  has at most one. `aria-haspopup="dialog"`, a plain button, not a toggle.
- **Owner.** Rendered by hours-ui (`placement: 'page'`) inside `HostExtension`; the host owns the slot and the
  fallback (S5). The host passes plain strings only (plan contract); nothing comes back.
- **States.** *Not offered* (everyone else): no element, no placeholder, no explanation. *Loading*: nothing.
  *Ready*: the button. *Dialog open*: the button stays (the dialog is modal). *Saved*: S3. *Failed to load or
  timed out*: S5, for people who would have had the button. *Throws at render* (an invalid prop set, plan R10):
  the host's boundary shows S5.
- **Not designed here:** a count or "my hours on this project" beside it (a non-goal, spec § Non-goals).

### S2 Record hours on a task row — project Tasks card, My tasks, CRM Tasks page, CRM timelines (AC-3.1, 3.6, 4.5)

```
[Open] Send the offer
Due 18.11.2026 · Assigned to Anna Rossi
[Mark done] Edit Delete [Record hours]        ← actions group: "Actions for Send the offer"
```

- **Where.** The **last** item of the row's `actions` (after Edit / Delete / "Open in CRM"), so the button and the
  message that follows it (S3) are the last things in the group and **nothing the person is already using is
  displaced when the message opens** (**checked** in the project Tasks card at 1440 and 375; the alternative,
  between Mark done and Edit, would push Edit and Delete down a line while the message shows, by the group's
  `flex-wrap`). `TaskRow` renders Mark done first, then `actions`.
- **Variant and size.** `secondary` `sm`, the same weight as Mark done; label "Record hours". A done task's
  row offers it exactly as an open task's (AC-3.6): no difference in label, variant or position.
- **Name.** Visible text "Record hours". The accessible name is "Record hours on <task subject>" when the host
  gives a task name (project and deal tasks), so a list of buttons read out of context tells the rows apart (the
  label contains the visible text, WCAG 2.5.3). For a CRM task with no deal the host passes the subject as
  `activityName` too, for the name only — never sent (G3, plan amendment 2026-11-17): "Record hours on <subject>".
- **Per row, not per list.** In one list some rows have the button (mine) and some do not (someone else's, or I
  only authored it): the group simply has one item fewer. In the CRM Tasks page, the "Assigned to" filter showing
  someone else's tasks shows those rows without it.
- **States.** As S1 (no element when not offered; nothing while loading; S5 on failure). One widget per
  offered row: a 25-row page mounts at most 25, one cached module import (plan R1).

### S3 The success message — page and row (AC-4.3, R5)

- **What it is.** A compact `Banner tone="success"` (`role="status"`, polite) rendered by the widget, one at a
  time per widget (a second save replaces it; it has no timer, see Dismissal).
- **Text.** "<duration> recorded on <name>." — "2 h 30 recorded on Alpenstrom — portale clienti." For other work:
  "2 h 30 recorded on other work: Training." With no name from the host: "… on this project." / "… on this deal."
  Then the link **See in My hours**, inline in the message (a `.link` anchor, design-system rule 4: inline
  navigation is a text link, not a button): a real `<a href="/hours">` whose click is a shell transition
  (`navigateSuite('/hours')`), so open-in-new-tab and middle-click still work. No day is repeated in the message
  (the person chose it a moment ago; the List and Week show it).
- **Where on a page.** Inside the header's action row, **immediately before Record hours** (DOM order and visual
  order: message, then button), so it appears beside the button the person pressed and grows into the free space to the
  left of the right-aligned cluster, so **when the header has room it moves none of the buttons**. Maximum width
  ~24 rem (`max-w-sm`); the message wraps inside it.
  - When the header cannot hold title + message + buttons on one line (**checked**: a long project name at 1440, or
    anything at 1024), the browser wraps the whole action row under the title for as long as the message shows;
    nothing overlaps and nothing is lost. The suite's `Saved` banners already push the cards down; this is the
    same cost, paid for a moment.
  - On a phone (**checked** at 375, content ≈ 263 px) the message becomes a full-width banner above the buttons;
    Banner's own wrapping drops the × to a second line.
- **Where on a row.** Inside the row's `actions` group, after the buttons, on **its own line**
  (`basis-full`), full row width (**checked** at 1440 and 375). It is the last element of the group, so nothing
  moves, and the row grows by one banner height. Focus is not in the row's later content, so DOM order = visual
  order.
- **Dismissal.** × (`dismissLabel` = "Dismiss", `strings.common.dismiss`) removes it and **returns focus to
  Record hours** (the × is gone, so focus would otherwise fall to the page). **No auto-dismiss** (G1, plan amendment 2026-11-17):
  a link that disappears in 3 s cannot be reached by a keyboard or screen-reader user (WCAG 2.2.1). The message
  goes by ×, by the next save (replaced), or by leaving the page.
- **Announcement.** `role="status"` (a status inserted with its text already in it is not announced by every
  combination; the suite's other success banners work the same way). Verified by the automated checks of the role, the
  text and the focus only: a readback in a real screen reader (NVDA, VoiceOver) is **not** part of this feature's gate —
  decided by the user on 2026-11-19 (amendment below); it is a follow-up.
- **Never.** Not the shell's `ToastHost` (reserved for notifications from elsewhere, design-system § Feedback);
  no Undo; no Edit link; no hours shown on the host page (spec § Non-goals).

### S4 The entry dialog opened from a page — `fixed` (AC-1.3, 2.3, 3.2–3.5, 4.1, 4.2)

The same `EntryDialog` as My hours (title "Record hours", `FormDialog` `size="lg"`, "Save entry"), recording mode,
with `preset` + `fixed` + `focus: 'duration'`. Same rules, same refusals, same body sent (`toInput`).

```
Record hours                                                              ×
Recording hours on the project  Alpenstrom — portale clienti.        ← read-only, announced as the dialog's description
Day  [16.11.2026]            Duration * [          ]  ← focus here          "= 2 h 30" as you type
ACTIVITY                                                      ← only from a task row (S4 "the fixed task")
Write the offer
Hours are recorded on this task. It can't be changed here.
Work type [No work type ▾]                                    ← project / deal
Note [                                  ]
                                              [Cancel] [Save entry]
```

- **How a fixed target reads.** As **text**, not as a disabled picker: the dialog's `description` (the line under the
  title, which the library uses as the accessible description, so it is announced when the dialog opens even though
  focus lands on Duration): "Recording hours on the project **<name>**." / "… on the deal **<name>**." — the name in
  `font-medium text-text`. The "What was it on" radio group and the picker are **not rendered**. With
  `targetName === ''` (the host could not name it): "Recording hours on this project." / "this deal." — never a
  blank, never an id (plan R10: the host builds name and id from one object).
- **Day.** Today, editable, `max` today, the floor and every rule of S2 unchanged (AC-4.2: a future day is refused
  with the same `future_day` words). **Duration** has `data-autofocus`; Day stays first in tab order (the dialog is
  the same, only where focus starts changes, AC-1.3).
- **The fixed task** (`ActivityField` `lock: 'fixed'`, a variant **distinct from the "not visible" one**): the field
  keeps its place and its label "Activity" (the word My hours' list uses afterwards, "Activity: <subject>"), but is a
  read-only fact — a one-item `FactList` (`grid-cols-1`: term "Activity", value the task's subject) with the hint
  "Hours are recorded on this task. It can't be changed here." No select, no `aria-disabled`, no read of
  activities-api. It is placed directly under the description (before Work type) so the fixed things read
  together. The "not visible" variant stays as it is (a disabled select with the entry's pointer, for an entry
  whose target the author cannot read); the two share a prop (`lock: 'hidden' | 'fixed'`) and nothing else.
  A task with an empty subject reads "This task".
- **Opened from a page (no task).** Everything above except the Activity fact: the **Activity select works as in My
  hours**, listing the fixed project's / deal's activities, optional.
- **A deal-less CRM task (kind fixed to Other work).** The description reads: "This task is about a company, not a
  deal, so its hours are recorded as other work. They are not linked to the task." (AC-3.4, 3.5: honest about the
  missing link, which the person would otherwise look for in My hours). No radio, no Activity field. **Category** is
  the S2 `select`, required, **nothing chosen** (A3), listing non-retired categories; with none available the
  field says what S2 says and Save is blocked; a category that requires a note makes Note required, as in S2.
- **Work type** (project / deal) and **Note**: as S2.
- **Errors — "same surfaces, same words" (AC-4.2).** Field errors (Day, Duration, Category, Note, and Activity **when
  it is a select**, i.e. a dialog opened from a page with no task) land on their fields exactly as in S2. What S2 puts
  on a control this dialog does not have appears in the dialog's form-level `.form-error` (`role="alert"`, above the
  footer), same sentences: the three errors S2 puts on the entity picker — `not_on_project`, `not_involved_in_deal`
  (the person is not, or no longer, on it: A7) and `404` (target gone) — and, **when a task is fixed**,
  `activity_not_allowed` (the Activity is a fact with no field to carry it; S2's sentence, "This activity does not
  belong to the chosen project." / "…deal."). **G2:** S2's 404 sentence ends "Choose another.", which cannot be done
  here: fixed mode uses "This project is no longer available to you." / "…deal…" (a one-clause variant).
  `host_unavailable` fail-closed and "Something went wrong" are the form error as in S2. Values are kept on every
  failure; Save is pressed again to retry.
- **Focus after a form-level refusal.** Save is `busy` (disabled) while the request runs, and a disabled control cannot
  keep focus, so when a refusal that has no field arrives (every form-level error above) **focus returns to Save**, the
  control the person pressed: the next Enter retries, and a keyboard user keeps their place instead of starting from
  the dialog's ×. The alert is announced by its own role; focus does not move onto the alert's text. A refusal that
  has a field keeps the rule of S2 (the first invalid field is focused; an entity refusal in a dialog that has a
  picker focuses the picker). This is how `EntryDialog` behaves wherever it opens: a page, a task row, a week cell,
  My hours' own button.
- **Loading / error of the lists.** Pressing Record hours reads the categories and work types first: the button is
  `busy` until `GET /time-lists` answers, and the dialog opens once it has answered or failed (plan § Components and
  § Sequences: `getTimeLists()`, then `EntryDialog`; the lists are read on press, so a long task list that mounts many buttons reads nothing until one is used). If the read
  fails the dialog still opens, the Category and Work type selects say "could not be loaded" with **Try again** (S2),
  which shows S2's "Loading…" hints while it reads again, and a project / deal entry can still be saved without a work
  type. Same strings.
- **Saving.** `busy` on Save, dialog not dismissible, as in the library.

### S5 The host fallback link (AC-4.5)

`<a href="/hours" className="link text-sm">Record hours in My hours</a>` in the slot Record hours would occupy: first
in the page header's `actions` (it aligns with the buttons, `align-items:center`), last in a row's `actions`
(the "Open in CRM" row link in My tasks is the precedent: `link self-center text-sm`). Shown only on failure,
throw or timeout, only to someone who would have been offered the button, never while loading. No retry affordance:
a failed module import is cached, so the link is the whole offer (the `MeetingsSection` posture); reloading the page
retries. No message, no banner: the page works, one link is the only difference.

### S6 My hours with the List | Week switch (AC-5.1, 5.2, 5.4, 5.21, 5.22, C1, WA5, WA10)

> *Superseded 2026-11-19 (D16, D19; AC-5.1 reversed, AC-5.33): the switch is Table | List, the table view is the default, and the column is `wide` on every hours page. See the amendment's S6.*

```
Hours                                                  (h1)   [My hours | Everyone's hours | Settings]   ← holders only, unchanged
My hours                                               (h2)                                [Record hours]
Time worked on two things at once counts in full …
[ List | Week ]                                        ← Tabs, a tablist of views of the SAME page
[ notice: "Entry saved." ]  [ HoursBanners ]           ← inside the panel
┌ Filters ─ [Clear filters] ┐   Period is shown in the List only
│ (Period) Recorded on  Project  Deal  Category  Work type │
└─────────────────────────┘
<the List's Totals + Entries>   or   <the Week card (S7)>
```

- **Control: `Tabs` (existing).** The design system reserves `Tabs` for "switches views of the SAME page without
  navigating" (EstimAI's Activities / Summary / Parameters, the CRM's Open / Done); `TabNav` is for pages with their
  own URL, and the plan rejected a route (`/hours?view=week`, decision 5). **Nothing new in the library.** The
  panel wrapper uses `tabPanelProps`. The tab list is named "View of your hours"; the two tabs "List" and "Week".
  A selected tab sets/clears `view` in the search (replace navigation); List is the default and is left out of the
  URL. Arrow keys switch (automatic activation, the `Tabs` contract); with two tabs that is acceptable even though
  the Week then reads.
- **Where.** Directly under `PageHeader` (its description stays: the "counts in full on each" sentence is as true of
  a week), above the notices and Filters, so both views share everything above the panel. The tool's own `TabNav`
  (holders only) is above the page, in the tool header, and looks the same as `Tabs`; the CRM's Tasks page and
  EstimAI already stack the two.
- **Filters card in the Week.** Period and its From / To are not rendered (the week replaces them, WA5); the
  other controls reflow; "Clear filters" appears only when a **visible** filter differs from the default (**G5**:
  the List's `isFiltered` counts `period`, which is hidden in the Week; the Week must ignore it, and
  `clearFilterSearch` keeps `view` and `week`). Recorded on, Project, Deal, Category and Work type keep what the
  person set and apply to the Week (AC-5.21, 5.22).
- **Width (C1).** `HoursShell` gives `ToolLayout width="wide"` while `view=week`, `default` otherwise: the CRM's
  per-route precedent (`CrmShell`: `wide` on the pipeline). The tool title, the tool's tabs and the page all
  follow, so the columns of the header and the grid line up (EstimAI's workspace runs edge to edge with the same
  24 px gutter; **checked**). The List keeps 80 rem (whether the List also widens is the user's call; C1 reads as
  the Week).
- **States.** The Tabs, the header and the Filters are always shown (as in time tracking S1). The panel is one state
  per region, as S7. A person who lands on `/hours?view=week` with a `week` that is not a real day gets this week.
- **Everyone's hours** has no view switch (WA4).

### S7 The Week grid — `/hours?view=week[&week=<day>]` (US-5, AC-5.3–5.14, 5.20–5.24, WA1–WA3, WA7–WA9)

> *Superseded 2026-11-19 (D15, D17, D18, D24) for: the card's controls and their place, the plus on empty cells, "Next week is always offered", the "not started" state, the scroll hint, and everything that is the month's. Kept as history; the rows, the label, the totals, AC-5.11, the cell dialog's opening, and the stated measurements of the week still hold. See the amendment's S7.*

```
┌ Week 16.11.2026 – 22.11.2026 ──────────────────────────────────── [‹] [This week] [›] ┐   (h3 + Card action)
│ RECORDED ON                     MON        TUE        WED        THU    FRI   SAT   SUN       TOTAL │
│                              16.11.2026 17.11.2026 18.11.2026 …                                  │
│                                         [Today]                                                  │
│ [Project] Alpenstrom — porta…    4 h        5 h         +                                9 h     │
│ [Project] Operai — strumenti…     +         1 h       2 h 30                              3 h 30   │
│ [Deal] Brera — configuratore…     +          +         1 h                                 1 h     │
│ [Meeting] Retrospettiva sprint 4 1 h         +          +                                  1 h     │
│ [Other work] Training             +          +          +        2 h   (future: blank)    2 h     │
│ [Project] Not visible to you      +         2 h         +                                  2 h     │
│ Total                            5 h        8 h       3 h 30      2 h    —     —     —    16 h 30 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

(The mock above and its figures are illustrative; the shape was **checked** as injected DOM at 1440 and 375.)

- **Container.** One `Card` (title = the week, h3; `action` = the navigator) holding one `DataTable`
  (`caption` and `regionLabel` "Hours by project, deal, meeting and other work, 16.11.2026 – 22.11.2026"). A
  `DataTable` is the right primitive: comparable cells, `scope` headers, a keyboard-scrollable region. The design
  system's one exception to "never a raw table" is an *editing grid* with inline inputs; this grid has none (a
  cell opens a dialog, it is not typed into, spec § Non-goals), so it is a data table of buttons.
- **Navigator** (`WeekNavigator`, in the card header): `‹` Previous week (`iconOnly`, `ghost`, `sm`,
  `aria-label` "Previous week"), **This week** (`secondary`, `sm`), `›` Next week (icon only). The group is
  `role="group"` named "Choose a week". **This week** is `aria-disabled="true"` while the current week is shown
  (it stays reachable and keeps focus after a click, instead of `disabled` dropping focus). `Next week` is always
  offered (AC-5.5): a future week is a blank grid with the "not started" state below. The week label is the card's
  heading, "Week 16.11.2026 – 22.11.2026", so a screen reader on the heading hears which week; on a phone the
  heading wraps to three short lines (**checked**) and the three buttons stay on the right.
  *Why in the card and not in the Filters card, where "the week takes the place of Period" (WA5):* the stepper
  navigates the grid it sits on, a Filters card with a gap where Period was would shift the other controls, and
  "Previous" belongs next to the week it leaves. WA5 states what is replaced, not where; flagged, not a drift.
- **Columns.** First: **Recorded on** (row header: the kind `Badge` — Project, Deal, Meeting, Other work, the same
  words and badge as the List's rows, AC-5.8's kind marker — then the name). Then seven day columns, Monday to Sunday
  (AC-5.3): header line 1 the short weekday (+ a **Today** `Badge tone="accent"` inline for today), line 2
  `formatDate(day)` ("16.11.2026": unambiguous across a month boundary, no date built by hand). Then **Total**.
  Day and Total columns are `numeric` (right-aligned DM Mono, tabular). The row-header cell has a floor width of
  **`min-w-28` (7 rem, 112 px)**, so a name is never squeezed to a word or two per line, and no wider: the floor
  decides whether a day is visible on a phone and how wide a screen the grid fits. A name wraps to two or three lines
  (**checked**: "Alpenstrom — portale clienti" in two at 375 px). The widths below were **checked** on a live week by
  changing the floor at run time; the sums for longer Totals follow from them.
  - **At 375 px (QE observation → defect, 2026-11-17).** The Week card is 258 px wide inside the shell's 64 px rail and
    its grid region is **220 px** (the first draft reasoned from 263 px). Every day column is about 88 px (an 11 px
    mono date, nowrap) and the label column is the floor plus 16 px of cell padding. A 176 px floor (`min-w-44`, the
    first draft) showed 28 px of the Monday column and no figure; 144 px showed 60 px, 128 px showed 76 px, still no
    figure; **112 px shows the whole Monday column, header and figures**, with Tuesday starting 5 px beyond the edge.
    The first draft left a phone with a column of names, no day figure and no sign that the grid scrolls; G10 accepted
    the scroll, not that. The sign is the hint under *Phone* below.
  - **At 1024 px (QE observation → defect, 2026-11-17).** The grid's minimum width is the sum of its columns: the
    label column, 7 × ~88 px for the days and the Total column (about 52 px for "5 h", 75 for "11 h 30", 83 for
    "100 h 30"). The grid region is the viewport minus 155 px in this layout (869 px at 1024). With the 176 px floor
    the minimum was 858 px for a week of small totals and about 880 px once a total reached ten hours (the QE measured
    879 against 869): the Total column's last character sat under the card's edge and a sideways scrollbar appeared
    for 10 px. With the 112 px floor the minimum is 794 px, 825 px with a three-digit-hour Total: it fits at 1024 with
    44 px or more to spare and at 960 (805 px) for a short Total. The grid fits without a sideways scroll from about
    980 px up; below that it scrolls inside the card, as designed.
- **Rows.** Exactly one per project, deal, meeting and category of other work the person has hours on in the week
  (AC-5.6), a meeting's hours on the meeting's row even when it counts for a deal (AC-5.7), ordered projects, deals,
  meetings, other work, by name inside each, unnamed after named (AC-5.8, `weekGrid`). A row label:
  - readable: the name as the server sent it (never translated, never an id). Other work: the category's name, a
    retired one as the list writes it, "Training (retired)" (`strings.entries.retired`).
  - not readable: the List's words, "Not visible to you" / "Name unavailable" (`strings.names`), with the kind
    badge still there (AC-5.23). Two unreadable rows read the same and are told apart by position only, as in the
    List (D44: no id is shown).
  - No link on the name (the List links a readable name to its page): the plan's `WeekRow` carries no `href` and no
    AC asks for one; a link per row would also add a tab stop per row. Deliberate (G6).
- **Cells** (AC-5.9, 5.12, 5.14, 5.15, 5.24). By day, from today backwards only:

  | Cell | Shows | Is | Accessible name |
  |---|---|---|---|
  | holds hours (past or today, any row) | the total, "2 h 30" (DM Mono) | `Button ghost sm`, `aria-haspopup="dialog"`, opens S8 | "2 h 30 on Alpenstrom — portale clienti, Wednesday 18 November 2026, 2 entries" ("1 entry"); an unreadable row: "2 h on a project not visible to you, …" (the List's `onPhrase`) |
  | empty, today or earlier, readable row | a plus (`Icon plus`, `iconOnly`) | `Button ghost sm iconOnly`, `aria-haspopup="dialog"`, opens S9 | "Record hours on Alpenstrom — portale clienti, Thursday 19 November 2026" |
  | empty, an **unreadable** row (AC-5.24) | nothing | not a control | — |
  | empty, a **future** day (AC-5.14, WA7) | nothing | not a control | — |

  Empty cells show a visible plus rather than reveal one on hover: hover does not exist on a phone and a hidden
  control is not discoverable. The row label text and the weekday are inside each name because a button reached by
  Tab or a screen reader's buttons list is out of its table context. A cell shows no entry count visually: the
  number of entries is in the cell dialog, and a second figure per cell would be noise.
- **Totals** (AC-5.10). A **Total** column (row totals, `font-medium`) and a last row **Total** (row header) with the
  seven day totals and, in the corner, the week's grand total. A day with nothing shows an en dash "—"
  (`strings.common.none`), never "0" and never an empty `td` that could read as missing. `DataTable` has no
  `tfoot`, so the totals row is the last `tbody` row. Every figure is a sum over the one complete read; all agree
  by construction (plan decision 1).
- **AC-5.11 — nothing compares a day with a target.** No threshold, tint, icon, "complete / incomplete", "x of 42 h"
  or colour change depends on a figure. The only emphasis anywhere is `font-medium` on totals, applied identically
  to 1 h and 42 h; the Today badge is about the calendar, not the hours. The component test of the plan (a 42 h week
  and a 1 h week, same markup) is the guard.
- **Today and the future.** Today's column has the Today badge in its header (text, so colour is never the only
  signal); the rest of the column is not tinted (`DataTable` does not style cells, and restyling is forbidden). Days
  after today are blank.
- **Announcements.** When a week (or filters) finish loading, one polite status: "Week 09.11.2026 – 15.11.2026:
  38 h 30 in total." Focus does not move.

States (exactly one per region; Tabs, Filters, header and the card's heading + navigator are always shown)

| Region | Loading | Empty | Error / partial |
|---|---|---|---|
| The grid | `SkeletonRows` (4 rows, `aria-hidden`) + `VisuallyHidden live` "Loading your week…". A week or filter change shows it at once: the previous week's figures are never on screen under the new span | **No filter:** `StatePanel` (h4) "No hours recorded this week" / "Record the hours you worked and they appear here, by project and day." — no action, the header has it (as the List). **A future week:** "This week has not started" / "You can record hours on a day once it has come." **Filters set:** the List's "No entries match these filters" + **Clear filters** (reuse `entries.emptyFiltered`, `filters.clear`) | `ErrorBanner` (warning) "Your hours could not be loaded" + **Retry**, **no partial grid** (the read is all or nothing). A 503 `host_unavailable` **with a deal filter set** is the List's `DealFilterUnavailable` (same words, Retry, "Clear the deal filter"), replacing the grid; nothing is drawn until the link can be read (time-tracking AC-4.11) |
| After a write (save, edit, delete) | the same read runs again, with the same skeleton: no old figure stays under a new answer. If a dialog is open (S8) it keeps the last loaded cell until the new grid lands (S8) | — | as above; a failed re-read after a write that worked shows the error with Retry (honest: the figures on screen would be stale) |
| Source down (`unavailable[]`) | — | — | `HoursBanners` as the List: one polite info banner naming the sources; the rows then read "Name unavailable" |
| Names not visible (AC-5.23) | — | — | the same standing `live="off"` note as the List, whenever any row is unreadable |

- **Retired category row (G4; AC-5.24 as amended 2026-11-17).** Its cells that hold hours open S8 without Add hours, and its empty cells
  are not controls: a retired category is not offered for a new entry (time-tracking AC-3.4), and a preset the
  dialog would then show as "unchosen" is a trap. The row is labelled with "(retired)".
- **Focus after a write or a Retry** (F3, F4, F5). The grid is replaced while it reloads, so the library's "focus
  returns to the opener" would land on nothing: the page asks for focus on `[data-cell=<row>:<day>]` once the new grid
  is there, else on the card's heading (`focusableHeading`). The same `focusRequest` pattern `MyHoursPage` already
  uses for the List ("heading after a delete, Record hours after an edit"). After a **Retry** of a failed week read
  (the error banner's and the deal-filter refusal's alike) the Retry button is gone with the error: when the read
  works, focus goes to **the Week card's heading**; when it fails again, to the banner that replaced it (the
  deal-filter refusal's existing behaviour). Never to `body`.
- **Phone (R5-style check).** The `DataTable` region scrolls horizontally inside the card (focusable, keyboard
  scrollable), the page does not (**checked** at 375). **A visible cue (QE observation → defect, 2026-11-17):** below
  `lg` (1024 px) one line of hint text sits between the card's heading and the grid, "Scroll sideways to see all
  seven days." (`week.scrollHint`), a plain `<p className="mb-3 text-xs text-soft lg:hidden">` (the footnote of
  `TimeListCard` is the precedent). It is shown only with a grid (not while loading, on an empty week, on an error or
  on a replaced state), has no control and no dismissal, and is `aria-hidden="true"`: a cue for the eye, while the
  region is already a labelled, focusable scroll region and a screen-reader user moves by table cell. A sentence
  rather than a shadow at the region's edge: the library draws none (a library change, R4), and 5 px of Tuesday is not
  a cue. Between about 980 and 1023 px it shows although the grid fits; accepted, a breakpoint is sturdier than a
  width measured against figures that change with a longer total. The hint is the removable half of this fix: the
  floor alone already puts a day on a phone's first screen. Both classes (`min-w-28`, `lg:hidden`) are new to the
  suite's one Tailwind sheet, which the shell emits from `hours-ui/src`. The row label is **not sticky** —
  `DataTable` has no sticky column and adding one is a library change that would have to ship in the shell first
  (R4); a cell scrolled away from its label still names its row and day in its accessible name and in its dialog's
  title. If the phone use proves common, an optional `DataTable` prop is the follow-up (not in this feature).

### S8 A cell's entries — the cell dialog (AC-5.15–5.18, 5.20, 5.24)

> *Amended 2026-11-19: nothing visible changes. The weekday in the title's description comes from the date, not from the column's position (a month need not start on a Monday); and when the cell empties the dialog closes and focus goes to the card's heading (F5).*

```
Project: Alpenstrom — portale clienti                                          ×
Wednesday 18 November 2026 · 2 entries, 6 h 30
┌ [Project] Alpenstrom — portale clienti                    4 h  [Edit] [Delete] ┐   ← EntryRow, exactly the List's
│ Development · Activity: Write the offer                                          │
│ Kick-off notes                                                                   │
├ [Project] Alpenstrom — portale clienti                  2 h 30  [Edit] [Delete] ┤
│ Support                                                                          │
└──────────────────────────────────────────────────────────────────────────────────┘
                                                              [Close] [Add hours]
```

- **Dialog, not Drawer, not popover.** `Dialog` `size="lg"` (a plain `dialog`). A `Drawer` is "reference content
  read next to the page, never a form or a confirmation", and this holds Edit and Delete; the library has no popover
  and a menu is for choosing an action, not for listing records. A modal also gives the stack the library already
  handles: Edit's `EntryDialog` and Delete's `ConfirmDialog` open over it, take the keyboard, and hand it back.
- **Title and description.** Title "Project: Alpenstrom — portale clienti" (`<kind>: <name>`; "Other work: Training";
  for an unreadable row "Project: Not visible to you"); description "Wednesday 18 November 2026 · 2 entries, 6 h 30"
  (the dialog's accessible description). Heading and description name the row and the day, which is all a person
  who opened the cell by keyboard needs to know where they are.
- **Rows.** `EntryRow` (moved out of `EntryDayList`, unchanged) in `ListRows`, labelled "Entries on 18 November
  2026" (`entries.dayList`): the kind badge, the name (a link only where the List makes one), work type or category,
  activity, the deal a meeting counts for, the note, the duration, **Edit** and **Delete** with the same
  `aria-label`s as the List. Entries are in the server's order. Edit and Delete exist on every entry, readable or not
  (the author edits and deletes their own, time-tracking AC-2.12).
- **Footer.** `Close` (`ghost`, left) and **Add hours** (`primary`, right: the dialog's one primary). **Add hours is
  absent** on an unreadable row (AC-5.24), on a retired category's row (G4), and never relevant to a future day (a
  future day cannot hold entries). × and Escape close.
- **After a write.** The entries shown are the last grid that loaded (held by the page, not read from the hook's
  current state), so the list does not blank while the week is read again; when the new grid lands, the list updates in place (the same entry ids keep their DOM). **If the cell is
  now empty, the dialog closes** (F5 step 5). If the entry whose Edit or Delete button had focus is gone (it moved
  away or was deleted) focus goes to the dialog's heading, never to the page behind it.
- **States.** The dialog is only opened from a cell that holds hours, so it has no empty state of its own (it closes
  instead); *loading* is the re-read described above (the list stays, the buttons keep working); *error* of the
  re-read is the page's `ErrorBanner` behind the dialog, announced as an alert, with the dialog still usable.
  Edit, Delete and Add hours report their own refusals inside their own dialogs (S2, S3 of time tracking; an entry
  dialog's form-level refusal returns focus to its Save, S4).
- **Edit** opens `EntryDialog` with `entry`; **Delete** opens `DeleteEntryDialog`; both unchanged (AC-5.16, 5.17).

### S9 The entry dialog opened from a week cell (AC-5.12, 5.13, 5.18, WA6)

> *Amended 2026-11-19: reached only through Add hours in a cell's list (AC-5.13, 5.18), in either period; the empty-cell way in is gone (AC-5.12 withdrawn). The dialog itself is unchanged.*

My hours' **own** dialog, `preset` only — not `fixed`: Day and the row's project, deal, meeting or category are
filled and **can still be changed** (the radio group and the picker are there, holding the row's target, the
Category select holding the row's category). Because the click already chose the day and the target, **focus starts on
Duration** (`focus: 'duration'`; the plan's default `day` is for My hours' own button; no AC asks for either, G7).
Opened from a cell the title is "Record hours" and there is no description. A meeting row's preset needs a meeting
choice with the title (it is on the row's entries); a project or deal row's needs the name (`companyName` null).
All errors on their own fields as in S2; a refusal with no field is the form-level error, with focus back on Save (S4).

---

## Copy

> *Superseded 2026-11-19 for every `week.*` key below: the keys move to `table.*` (plan decision 9) and gain the month; `week.cell.record` and `week.emptyFuture.*` are removed. The amendment's Copy table is the live one; this one is history.*

All catalogs en + `it: typeof en`, sentence case, in the strings modules named in the plan (`strings/recordHours.ts`,
`strings/week.ts`, additions to `strings/activity.ts`, `strings/entry.ts`; the hosts' own `strings`). Italian follows
hours-ui's words ("Registra ore", "Le mie ore", "Opportunità", "Riunione", "Altro lavoro", "Attività") and
crm-ui's ("azienda"); **a native speaker should read the Italian before release**.

| Key | en | it |
|---|---|---|
| `recordHours.button` | reuse `entry.record` — Record hours | Registra ore |
| `recordHours.buttonOn(task)` (aria-label) | Record hours on {task} | Registra ore su {task} |
| `recordHours.recorded(duration, name)` | {duration} recorded on {name}. | Hai registrato {duration} su {name}. |
| `recordHours.recordedOther(duration, category)` | {duration} recorded on other work: {category}. | Hai registrato {duration} su altro lavoro: {category}. |
| `recordHours.thisProject` / `thisDeal` | this project / this deal | questo progetto / questa opportunità |
| `recordHours.seeInMyHours` | See in My hours | Vedi in Le mie ore |
| `recordHours.dialog.onProject(name)` / `onThisProject` | Recording hours on the project {name}. / Recording hours on this project. | Stai registrando ore sul progetto {name}. / Stai registrando ore su questo progetto. |
| `recordHours.dialog.onDeal(name)` / `onThisDeal` | Recording hours on the deal {name}. / Recording hours on this deal. | Stai registrando ore sull'opportunità {name}. / Stai registrando ore su questa opportunità. |
| `recordHours.dialog.onOtherWork` | This task is about a company, not a deal, so its hours are recorded as other work. They are not linked to the task. | Questa attività riguarda un'azienda, non un'opportunità, quindi le ore vengono registrate come altro lavoro. Non sono collegate all'attività. |
| `activity.fixed.hint` | Hours are recorded on this task. It can't be changed here. | Le ore vengono registrate su questa attività. Qui non si può cambiare. |
| `activity.fixed.unnamed` | This task | Questa attività |
| `entry.errors.targetGoneFixed.project` / `.deal` | This project is no longer available to you. / This deal is no longer available to you. | Questo progetto non è più disponibile per te. / Questa opportunità non è più disponibile per te. |
| host fallback (projects-ui, crm-ui) | Record hours in My hours | Registra ore in Le mie ore |
| `week.view.label` / `.list` / `.week` | View of your hours / List / Week | Vista delle tue ore / Elenco / Settimana |
| `week.title(range)` | Week {range} | Settimana {range} |
| `week.nav.label` / `previous` / `next` / `thisWeek` | Choose a week / Previous week / Next week / This week | Scegli una settimana / Settimana precedente / Settimana successiva / Questa settimana |
| `week.weekday.short` | Mon Tue Wed Thu Fri Sat Sun | Lun Mar Mer Gio Ven Sab Dom |
| `week.weekday.long` | Monday … Sunday | lunedì … domenica |
| `week.today` | Today | Oggi |
| `week.grid.caption(range)` | Hours by project, deal, meeting and other work, {range} | Ore per progetto, opportunità, riunione e altro lavoro, {range} |
| `week.grid.total` | Total | Totale |
| `week.cell.record(on, day)` | Record hours on {on}, {weekday} {date} | Registra ore su {on}, {weekday} {date} |
| `week.cell.open(duration, on, day, n)` | {duration} on {on}, {weekday} {date}, 1 entry / {n} entries | {duration} su {on}, {weekday} {date}, 1 registrazione / {n} registrazioni |
| `week.loading` | Loading your week… | Caricamento della tua settimana… |
| `week.announce(range, total)` | {range}: {total} in total. | {range}: {total} in totale. |
| `week.empty.title` / `.body` | No hours recorded this week / Record the hours you worked and they appear here, by project and day. | Nessuna ora registrata in questa settimana / Registra le ore lavorate e compaiono qui, per progetto e giorno. |
| `week.emptyFuture.title` / `.body` | This week has not started / You can record hours on a day once it has come. | Questa settimana non è ancora iniziata / Puoi registrare le ore di un giorno quando è arrivato. |
| `week.cellDialog.title(kind, name)` | {kind}: {name} | {kind}: {name} |
| `week.cellDialog.description(day, n, total)` | {day} · 1 entry / {n} entries, {total} | {day} · 1 registrazione / {n} registrazioni, {total} |
| `week.cellDialog.add` | Add hours | Aggiungi ore |
| `week.savedOutside(date)` | Entry saved. {date} is outside the week you are viewing. | Registrazione salvata. Il {date} è fuori dalla settimana che stai guardando. |
| `week.scrollHint` | Scroll sideways to see all seven days. | Scorri di lato per vedere tutti e sette i giorni. |

**The Italian of the success message (QE observation → defect, 2026-11-17).** The first draft, "{duration}
registrate su …", made a participle agree with a duration: "registrate" is feminine plural, which suits "ore" but not
"1 h" or "30 min". "Hai registrato {duration} su …" puts the verb in the person (second singular, the voice of "Stai
registrando ore…" and "la settimana che stai guardando") and nothing agrees with the figure, so it is correct for
30 min, 1 h, 2 h 30 and 24 h, and for "altro lavoro: Formazione". `{duration}` is the short form ("2 h 30"), the same
text in both languages. The other Italian strings of this feature were re-read for agreement (ore, registrazione /
registrazioni, "quando è arrivato" for a day): no other case.

Reused unchanged: `entries.type.*`, `entries.retired`, `entries.dayList`, `entries.emptyFiltered`, `entries.error`,
`entries.edit*`/`delete*`, `names.*`, `filters.recordedOn.label`, `filters.clear`, `common.dismiss`/`close`/`retry`/`none`,
`entry.saved`, `entry.delete.*`, every `entry.errors.*` except the 404 sentence above.

---

## Component inventory

> *Amended 2026-11-19: `WeekView`, `WeekNavigator`, `WeekCellDialog` are renamed `TableView`, `PeriodNavigator`, `TableCellDialog` (plan decision 9) and written for a period; `HoursShell` is `wide` always; two thin app-level pieces are added and one optional `DataTable` extension is proposed. See the amendment's Component inventory. The counts below are history.*

Library in use: **`@operai/ui`** (`operai-ui/`), Tailwind token utilities, TanStack Router, `shell/session` and
`shell/extensions`. Nothing is added to the library: R4 (a library change ships in the shell first) does not apply.

### Reused as they are

| Element | Reuse |
|---|---|
| The offer and the row | `Button` (`secondary`, `sm` on a row), `TaskRow` (`actions`; unchanged), `PageHeader` (`actions`; unchanged) |
| The message | `Banner tone="success" compact` (+ `onDismiss`; no `autoDismiss`, G1), the host's `Saved` shape is **not** reused (the message lives inside the widget) |
| The dialogs | `FormDialog` (via `EntryDialog`), `ConfirmDialog` (via `DeleteEntryDialog`), `Dialog` (the cell dialog); the library's dialog stack |
| The switch | `Tabs` + `tabPanelProps` |
| The Week | `Card` (+ `action`), `DataTable`, `Badge` (kind; Today, accent), `Icon` (`plus`, `chevron-left`, `chevron-right`), `StatePanel`, `SkeletonRows`, `VisuallyHidden`, `ListRows` (cell dialog) |
| The fixed task | `FactList` (one item, `grid-cols-1`), the library's `field-hint` text style for the sentence under it |
| In hours-ui already | `DeleteEntryDialog`, `HoursBanners`, `DealFilterUnavailable`, `ErrorBanner`, `SuccessBanner`, `EntryDayList`'s row (moved to `EntryRow`), `todayZurich`, `readAllEntries`, `lib/names.ts` (`rowName`, `onPhrase`) |
| In the hosts already | `MeetingsSection`'s seam shape (dynamic import of `shell/extensions`, feature check, own boundary) |

### Extended (existing in-repo files; each stays backwards compatible)

| Element | Change | Why |
|---|---|---|
| `EntryDialog` / `EntryDialogModel` | recording mode `preset`, `fixed`, `focus` (plan contract). Design adds: in `fixed` the description sentence (S4), no kind radio / picker, entity-field errors to the form-level error, the 404 variant | S4, S9 |
| `ActivityField` | `lock?: 'hidden' \| 'fixed'` (plan) — `fixed` renders the one-item `FactList` + its own hint, makes no read | AC-3.2, 3.3 |
| `HoursFilters`, `HoursFiltersState` | `view`: no Period (and From / To) in the Week; `isFiltered` ignores period in the Week (G5) | WA5 |
| `HoursShell` | `width="wide"` while `view=week` | C1 |
| `MyHoursPage` | the Tabs panel, the Week branch, focus requests for cells (plan) | US-5 |
| `projects-ui`/`crm-ui` pages and rows | `actions` of `PageHeader`, `TaskRow` (project and CRM task rows; the CRM deal page's header becomes a fragment) | S1, S2 |

### NEW (app level, hours-ui and the two hosts; no new library component)

| New | Why nothing fits |
|---|---|
| `hours-ui/src/RecordHours.tsx` (the widget) | The offer, the dialog wiring, the write and the message live in one remote and must cross the `HostExtension` seam as plain strings (plan decision 2); no library or host component can own a dialog that reads hours-api |
| `RecordHoursAction` ×2 (projects-ui, crm-ui) | The seam wrapper per host (plan decision 6): `@operai/ui` cannot import `shell/extensions` |
| `WeekView` (the card + the grid + its states) | Composition of `Card`, `DataTable`, `Badge`, `Icon`, `StatePanel`, `SkeletonRows`; no library component draws a rows × days grid of buttons, and an editing grid it is not |
| `WeekCellDialog` | Composition of `Dialog`, `ListRows` and the List's `EntryRow`; the one place that lists "the entries of a cell" |
| `WeekNavigator` | Three `Button`s in a group; thin, may live in `WeekView` |
| `ViewSwitch` | Binds `Tabs` to the `view` search param and the copy; thin, may stay inline in `MyHoursPage` |

Ratio: **~17 library components and ~10 in-repo pieces reused**, **6 in-repo files extended**, **6 NEW app-level compositions
(2 of them one thin file per host) and 0 NEW library components**. None duplicates an existing one;
`WeekNavigator` and `ViewSwitch` are the two a reviewer may fold away. One library component changed behaviour during
the fix round, with no new prop: `ListRows` keeps a row by its own `key` instead of by its position, so a success message
in a task row survives the host list's re-read after a row above it is added or removed (AC-4.3; changeset
`operai-ui-list-rows-keyed`, amendment below).

---

## Accessibility

Common: one h1 (Hours), one h2 (My hours), cards h3, `StatePanel` titles h4, dialog titles h2 in their dialog; the
shell owns `<main>`; every icon-only button has an `aria-label`; icons `aria-hidden`; the focus ring is the
library's; QE checks both themes (no `--muted` text; token utilities only); `prefers-reduced-motion` is the library's.
Colour is never the only signal (kinds and Today are text badges). How NVDA and VoiceOver read "2 h 30" in the new
`aria-label`s (the existing design's open point; fallback is the `spoken` style) is a follow-up, not part of this
feature's gate (amendment 2026-11-19 below).

**Record hours on a page (S1, S2, S5).**
- Keyboard: the button is a tab stop in header or row order (page: first in the header's actions; row: after the
  row's other buttons); Enter or Space opens the dialog; the group "Actions for <task>" (already on all three hosts)
  names the row.
- Focus: dialog open → Duration; Escape / Cancel / Save → back to Record hours (the library). × on the message →
  Record hours. A fallback link is an ordinary link in the same order.
- ARIA: `aria-haspopup="dialog"`; `Record hours on <task>` as the accessible name where a task name exists (label in
  name); a deal-less CRM task's too (G3).
- No contrast concern: library button, library banner, `.link`.

**The success message (S3).**
- `role="status"`, polite, text complete in the message; the link and × are real controls.
- No auto-dismiss (G1), so "See in My hours" stays reachable (WCAG 2.2.1 Timing Adjustable); × returns focus to
  Record hours.
- A page header that rewraps while the message shows is not announced and moves no focus.

**The entry dialog from a page (S4).**
- Modal, labelled by its title, **described by the read-only sentence** ("Recording hours on the project …"), so the
  target is announced on open even though focus is on Duration. Trap, Escape, × and focus return are
  `useDialogBehavior`.
- The fixed task is a `dl` (term "Activity") in reading order after the description; it is not focusable and not
  `aria-disabled` (it is not a control). The kind radio and the pickers are absent, not disabled.
- Errors: field errors as S2 (`role="alert"`, linked by `aria-describedby`, first invalid field focused);
  the three entity errors (and, with a task fixed, `activity_not_allowed`) are the form-level `.form-error`
  (`role="alert"`); **after any refusal that has no field, focus returns to Save** (it is disabled while the request
  runs, so focus would otherwise be lost; the alert is announced by its role, focus does not move onto it). The same
  for `host_unavailable` and "Something went wrong", in every placement of the dialog (S4).

**My hours with the switch (S6).**
- `Tabs`: a real `tablist` named "View of your hours", one tab stop, ←/→ and Home/End, `aria-selected`; the panel
  is `tabPanelProps` (focusable region, as EstimAI and the CRM do).
- Selecting Week does not move focus off the selected tab; on load the polite "Week …: 38 h 30 in total" is read.
- Keyboard path of the Week: header (Record hours) → tabs → panel → Filters (Recorded on, Project, Deal, Category,
  Work type, Clear filters) → the card's navigator (Previous, This week, Next) → the table's scroll region → the
  cell buttons in row order, left to right.

**The Week grid (S7).** *(Superseded 2026-11-19 for the empty cells, Next and the tab order; the table-semantics decision and its stated cost hold for both periods. See the amendment's Accessibility.)*
- **Table semantics, not the ARIA `grid` role** (the decision the plan left). A `<table>` with `scope="col"` day headers and
  `scope="row"` row headers lets a screen reader announce "row header, column header, button" without custom
  keyboard code; it reuses `DataTable` (keyboard-scrollable region, caption, `th scope`). The ARIA `grid` role would need
  a roving tabindex with arrow-key movement, Home/End, PageUp/PageDown and its own tests, and changes how screen
  readers treat the table (they switch to forms mode inside a grid): a new interaction pattern the design system does
  not have, for a surface that is not an editing grid. **Cost, stated:** every cell button is a tab stop, in a typical
  week 30–45 of them. Upgrade path if QE or users find it long: a roving-tabindex layer inside `WeekView` only
  (one tab stop, arrows between cells), no change to the data or the dialogs.
- Accessible names carry row and day ("Record hours on …, Thursday 19 November 2026"; "2 h 30 on …, 2 entries"), so a
  button reached out of table context is complete. Day headers read "Mon 16.11.2026" (+ "Today"); the grid's caption
  names the week; the Total row's header is "Total".
- A future cell and an unreadable row's empty cell are not controls (no tab stop). They are blank `td`s; assistive
  technology reads "blank". Not an error: AC-5.14 and AC-5.24 ask for no offer.
- The week label is the card's heading; the navigator buttons keep focus after a step and "This week" is
  `aria-disabled` rather than `disabled` on the current week. Weeks load with an aria-hidden skeleton and one polite
  "Loading your week…"; errors are an `alert` (Retry: after one that works focus goes to the card's heading, after one
  that fails again to the banner that replaced it); the deal-filter refusal is the List's, `role="alert"`, focus as
  there.
- **Focus after a write:** the grid is replaced while it reloads, so the page restores focus to the cell acted on, or
  the card heading if the cell is gone (S7). Never to `body`.
- Scroll region: a focusable `role="region"` with a label, so a keyboard user can scroll sideways on a phone; the
  one-line scroll hint above it is `aria-hidden` (S7 *Phone*).
- Contrast: kind and Today badges and the plus icon are library tokens; day totals are `--text`.

**The cell dialog (S8) and the dialogs over it.**
- `dialog`, labelled by "<kind>: <name>", described by "<weekday date> · <n entries>, <total>". Focus opens on the first
  control (the library's `auto`: the first Edit); Escape and × close and return focus to the cell button.
- Edit / Delete open stacked dialogs; the library gives Escape and Tab to the topmost; on close focus returns to the
  button that opened it. If that button is gone (the entry moved or was deleted) focus goes to the dialog's heading;
  when the cell empties the dialog closes and focus goes to the cell (or the card heading).
- The list has `aria-label` "Entries on <date>"; each Edit / Delete names the entry (the List's labels), so two entries
  of one cell are told apart by duration and position, as in the List.
- Close then Add hours in DOM order; **Add hours** (`primary`) is the dialog's only primary.

---

## AC coverage and scope

> *Superseded 2026-11-19: US-5 now runs to AC-5.34 and AC-5.12 is withdrawn; the amendment's AC coverage is the live one. This table is history.*

All 41 ACs are accounted for.

| Surface | ACs |
|---|---|
| F1 · S1 | AC-1.1, 1.2, 1.3 (dialog opens fixed, today, focus Duration), 2.1, 2.2, 2.3 |
| F1 · S2 | AC-3.1, 3.6 (and 3.2–3.4 through the preset S4 variants) |
| F1 · S4 | AC-1.3, 2.3, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2 |
| S3 | AC-4.3 (message, link, "nothing else changes"), 4.4 (no Edit, no Delete offered) |
| F2 · S5 | AC-4.5 |
| every string | AC-4.6 |
| F3 · S6 | AC-5.1, 5.2, 5.4, 5.5, 5.21, 5.22 |
| S7 | AC-5.3, 5.6–5.11, 5.14, 5.19 (F6), 5.20, 5.23, 5.24 |
| F4 · S7 · S9 | AC-5.12, 5.13, 5.14, 5.19, 5.20 |
| F5 · S8 | AC-5.15–5.18, 5.20, 5.24 |

ACs with **no UI surface of their own** (a result, a computation or an absence): AC-4.1 and AC-3.5 (what the saved
entry is, visible only in My hours); AC-5.6–5.10 (computed by `weekGrid`; their surface is the grid of S7); AC-5.11
(an absence, guarded by a test); AC-4.4 (nothing is offered).

**UI added that no AC asks for (small, kept, reported — strike any):** the dialog's read-only description sentence and
the deal-less task's explanation of "other work, not linked" (S4); the 404 sentence variant without "Choose another"
(S4); focus on Duration also for dialogs opened from a week cell (S9); the Today badge; the Week's polite
"…: 38 h 30 in total"; the one-line scroll hint under 1024 px (S7); the "This week has not started" variant of the
empty state (S7); the "outside the week you are viewing" confirmation (F6); × returning focus to Record hours; `aria-disabled` on This week. None changes data, a
route or a permission.

**Not designed — scope creep or out of spec, reported:** typing hours into a cell (spec non-goal); "Add row", last
week's rows shown empty (non-goal); Everyone's hours in Week (WA4); export from the Week (WA10); a target, a 42 h mark or
any completeness cue (WA2); an Undo or Edit on the host page message (non-goal); Record hours on a meeting page (A6);
hours shown on the project or deal page (non-goal; specs/20261112-project-hours); drag to move an entry between cells;
copy last week; a roving-tabindex grid and a sticky first column (both noted as upgrade paths, S7, Accessibility);
name links in the Week's row labels (G6); a compact "16–22.11.2026" formatter.

---

## Gaps found in the spec and plan

Drift in the sense of the plan being binding: none of these is designed around; each is reported with the section
it touches and, where one exists, the smallest resolution. **None blocks the design.**

**Resolved 2026-11-17** (main loop, the user deciding G2 and G4): G1, G3, G5 and G7 adopted as recommended (plan,
first amendment); G4 adopted and AC-5.24 amended to cover a retired category's row (ledger D12); G2 read as
recommended and AC-4.2 amended to say so (ledger D13); G6, G8, G9, G10 and G11 stand as designed.

**Amended 2026-11-17** (after the QE verdict, `qe-report.md`): D2 — the claim that focus stays on Save "as it does
today" was false (it falls to `<body>`), so S4 *Errors* (new *Focus after a form-level refusal*, which also names the
fixed task's `activity_not_allowed` as a form-level error, D1's surface), S8, S9 and § Accessibility now state the
target, Save, as a behaviour; S7 and F3 add that after a successful Retry focus goes to the Week card's heading · the
Week at 375 px and the 10 px overflow at 1024 px are one defect with one fix (row-label floor `min-w-44` → `min-w-28`,
plus a scroll hint below 1024 px, `week.scrollHint`; G10 amended) · the Italian success message is "Hai registrato
{duration} su …" (§ Copy).

1. **G1 — the message's link vs its 3 s lifetime** (plan § `hours/RecordHours`, "gone after `CONFIRMATION_DISMISS_MS`";
   AC-4.3 "with a link that opens My hours"). A link inside a message that vanishes in 3 s is unreachable for keyboard
   and screen-reader users (WCAG 2.2.1) and the suite has no other auto-dismissing message with an action.
   *Recommended:* the widget's message has no `autoDismiss` (dismissed by ×, by the next save, or by leaving); one prop.
   The design is written to the plan and flags the line.
2. **G2 — AC-4.2 "refuses it in the same way, with the same message" vs a dialog with no pickers.** S2 puts
   `not_on_project`, `not_involved_in_deal` and the 404 on the entity picker; `fixed` has none, so those land in the
   form-level error with the same sentences, except the 404's "Choose another." (impossible here) which loses that
   clause (`entry.errors.targetGoneFixed`). Reading "same message" as "same refusal, same sentence where it can
   stand" needs the caller's nod.
3. **G3 — the props cannot name a deal-less CRM task** (plan § `hours/RecordHours`: "`activityName` only with
   `activityId`", `on: 'none'` has `activityId ''`). So its button cannot be named "Record hours on <task>" and a
   screen-reader buttons list shows several identical "Record hours". The row group label covers sequential use.
   *Recommended:* allow `activityName` (display only, for the name) with `on: 'none'`.
4. **G4 — a retired category's row** (plan § `weekGrid`: `preset` is `null` for an unreadable name only; spec
   AC-5.12/5.18 "the row's … category set"; time-tracking AC-3.4: a retired category is not offered for a new entry). An empty
   cell would open a dialog whose category reads as unchosen. *Recommended:* `preset: null` for a retired category too,
   so it behaves as an unreadable row (no empty-cell button, no Add hours); its hours stay listed, edited and deleted.
5. **G5 — `isFiltered` counts `period`** (`HoursFiltersState.ts`; plan § `HoursFiltersState.ts` says only "Period is not
   rendered in Week"). In the Week a hidden Period would make "Clear filters" appear (and `clearFilterSearch` reset a
   hidden control). The Week must ignore `period`, `from`, `to` and `group` when deciding `filtered`.
6. **G6 — name links.** The List links a readable name to its project / deal / meeting; plan § `weekGrid`'s `WeekRow` has
   no `href`, and no AC asks for a link in the Week. Designed without; one field to add if wanted.
7. **G7 — focus in dialogs from a week cell.** Plan § `EntryDialog` `focus` defaults to `day`; AC-5.12 is silent. Designed
   as `duration` for week cells (the day and target are known from the click). One argument.
8. **G8 — the re-read UX after a write.** Plan § Sequences says "readAllEntries again"; `useHoursQuery.reload()` goes to
   `loading` (documented in the hook). Designed accordingly (a skeleton, focus restored to the cell, the open cell dialog
   keeps the last loaded cell), which is the least invasive reading; keeping the old grid while it refreshes would need
   a different hook and is not asked for.
9. **G9 — WA5 says the week "takes the place of the Period filter".** The navigator sits in the Week card's header, not in
   the Filters card (S7 explains). Same behaviour, different home; strike if the filter bar is wanted.
10. **G10 — phone.** `DataTable` has no sticky first column, so a name scrolls away from its cells on a phone; mitigated by
    names in every cell's accessible name and dialog title; an optional library prop is the follow-up (R4 order).
    **Amended 2026-11-17 (QE observation):** accepting the scroll did not mean a phone with no figure on its first screen
    and no sign that the grid scrolls (the grid region is 220 px, not the 263 px this gap assumed): the label floor drops
    to `min-w-28` and a hint is shown below 1024 px (S7).
11. **G11 — A7 and S4.** A task row whose assignee is not on the project's team still shows the button and the save is refused
    by hours-api; in `fixed` mode the refusal appears in the form-level error with no way to choose another project, which
    is what A7 and AC-4.2 ask for (stated so QE does not look for a picker).
12. **Copy.** The Italian strings are drafted from hours-ui's and crm-ui's words and need a native reader before release.

No contradiction in the spec itself was found: AC-5.1–5.24, WA1–WA10 and C1 are consistent with each other and with the
plan's address and contracts.

## Amendment 2026-11-19 — screen-reader readback out of the gate

Decided by the user on 2026-11-19, after QE's passes left one row BLOCKED (`qe-report.md`: "screen-reader readback (NVDA,
VoiceOver) — not executed"). The readback in a real screen reader of the success status ("2 h 30 recorded on <name>. See
in My hours"), of the Week cells' `aria-label`s, of the phone-width scroll hint (`aria-hidden`) and of a refused save's
alert is **no longer a check of this feature**. What stays verified, by unit and e2e tests: the roles (`status`, `alert`,
the labelled grid region), the texts and labels as designed in both languages, `aria-hidden` on the scroll hint, and where
focus goes. What is not verified: whether every browser and screen-reader combination speaks them as intended (the design's
own caveat above). Follow-up, not scheduled: a person runs the five-step readback in the old qe-report.md script with
NVDA and VoiceOver and files any defect as a bugfix.


## Amendment 2026-11-19 — design text brought in line with the build

Approved by the user on 2026-11-19, with the stale lines the eval found (`eval-report.md` § Design fidelity, (b)–(d),
and § Spec fidelity, (a) and (e)) corrected to what was built and verified:
- **S3.** The success message has no timer since G1 (plan amendment 2026-11-17); a second save replaces it. The sentence
  that said a second save "restarts its timer" now says it has none.
- **S4.** The dialog does not open at once: the button is `busy` while the categories and work types are read, and the
  dialog opens once they have answered or failed, as the plan's sequence has it. A failed read opens the dialog with S2's
  "could not be loaded" and Try again, unchanged.
- **Component inventory.** `ListRows` (`@operai/ui`) keeps a row by its `key`, so a message shown in a task row stays
  when the host list re-reads after a row above it changes (AC-4.3, decisions.md, fix round 1). It is a behaviour change
  of an existing component with no new prop, so the count of NEW library components stays 0.
- **Front matter.** `status: approved`.

Not changed here: the plan's Components table does not yet list the fix round's changes outside it (`ListRows`,
`cacheKey` on projects-ui `TasksCard` and crm-ui `ActivityTimeline`, the `useHoursQuery` stale-outcome fix, the
`DeleteEntryDialog` focus fix); that is a plan note, recorded in `decisions.md`.

## Amendment 2026-11-19 — the table view: week and month

For the user's re-approval (front matter back to `draft`). **Inputs read, besides those at the top:** `spec.md` as re-approved
2026-11-19 (US-5 AC-5.1–5.34, AC-5.12 withdrawn, AC-5.26 as settled by D25, Non-goals, C1, WA1–WA10, MA1–MA8), `ledger.md` D15–D25
and MF1–MF7, `plan.md` § Amendment 2026-11-19 (binding: the address, `TablePeriod`, `tableGrid`, the renames, the copy keys,
"What the design decides", R11–R21), `operai-ui` `Tabs`, `RadioGroupField`, `Field`, `DateInput`, `DataTable`, `Card`,
`ToolLayout`, `tokens.css` (card header, tab list, table region, radio options) and `formatMonth` / `formatNumber` /
`formatDateLong`, and hours-ui at `36e66536`: `WeekView`, `WeekNavigator`, `ViewSwitch`, `HoursShell`, `HoursFilters`,
`HoursFiltersState`, `WeekCellDialog`, `WeekViewModel`, `strings/week.ts`, `pages/MyHoursPage.tsx`, `pages/SettingsPage.tsx`.

**Inspected first-hand.** The dev stack answered (`:5173`, hours-ui `:5184`); the dev test-auth session `admin@operai.test`
was used, no Google or GitHub sign-in. I looked at the live Week at 1440 px; at 1920 px at the List, Everyone's hours and
Settings, with the shell's own `tool-width-wide` class added to the DOM to see them at the new width; and I built **throwaway
month tables in the page** from the library's own classes with the live Week's cell, header and row markup copied
(November 2026, which starts on a Sunday; 30 and 31 columns; 3, 6 and 10 rows; figures "1 h", "8 h", "7 h 30"; Total "120 h 30";
a pinned first and last column; scrolled; the toolbar at 1440 and 375 px). Nothing was written to the repo or to anyone's hours
(the screenshots are in the git-ignored `.playwright-mcp/`). Findings are marked **(checked)**.

### What is decided — the open items of plan § "What the design decides"

| # | Item | Decision | Where |
|---|---|---|---|
| 1 | Words | View tabs **Table** and **List** (Table first: it is the default); periods **Week** and **Month** under the group name **Period**; the date field **Show the week of** / **Show the month of**; the navigator **Previous week · This week · Next week** / **… month**. Not "Timesheet": the glossary's _Avoid_ for time entry, and the spec says "the table view is not a timesheet". "Period" is the List's own word for the same idea | Copy |
| 2 | Period switch | **`RadioGroupField`** "Period" with two radios, Week and Month, applied at once, one tab stop, the arrow keys select. Nothing new in the library. *Rejected:* a second `Tabs` (two stacked tab lists that look identical, one of them needing a panel of its own); a `select` (two clicks to choose between two, and the other choice hidden); two `Button`s with `aria-pressed` (a pattern the library does not have); a segmented control (a NEW library component for one use). The radio group is already how hours-ui's own entry dialog chooses between Project, Deal, Meeting and Other work | S7 |
| 3 | Where the controls sit | One **toolbar row under the card's heading**: Period · the navigator · the date field, left to right, wrapping. The heading stays alone in the card header. *Why not the header's action (where the Week had the navigator):* `.card-header` does not wrap: at 375 px the Week's heading already wraps to three lines beside its three buttons, and in my prototype with the month's longer "This month" button the row overflowed the card's edge **(checked)**; two labelled controls more cannot fit | S7 |
| 4 | The month's day header | **Compact:** the short weekday, the day of the month as a number (`formatNumber`), and the **Today** badge beside the weekday; the long date (weekday + `formatDateLong`, "Thursday 19 November 2026", + "today" for today) is the header's accessible name and the compact form is `aria-hidden`. The week's header is **unchanged** (weekday + `formatDate`): a week can cross a month, a month never does, so a bare day number is ambiguous in a week and exact in a month | S7 |
| 5 | Weekends, Today | No tint, no mark: the weekday word is the cue, and a Saturday or Sunday with no hours shrinks to its header's width **(checked)**, which reads as a weekend without anything drawn. Weekends are recordable (WA1). Today is the existing badge | S7 |
| 6 | Sticky label column | **Yes, for the month, and its Total as well** (the first and the last column pinned) from 48 rem (768 px) up; below that the table scrolls as the Week's does. Needs one **optional library extension**, `DataTable` column `pin` (below). If the user declines it, the month ships unpinned (fallback stated in S7) | S7, Component inventory |
| 7 | Scroll hint | **Week:** as built, `lg:hidden`. **Month:** shown whenever a grid is shown, at every width, no breakpoint: the month's measured minimum width is 1,974–2,729 px against a region of 1,125 / 1,285 / 1,765 px at 1280 / 1440 / 1920 **(checked)**: the region is the window's width minus ~155 px, so the month scrolls on every window narrower than ~2,130 px with short figures and ~2,880 px with half-hours, which is every laptop and desktop window | S7 |
| 8 | An empty cell | A **blank `td`**: no text, no icon, no mark, no hover, no pointer, no focus, no handler. *Rejected:* a dash or a dot (31 × the rows of "dash" read aloud, and it would collide with the Total row's dash, which means "no hours that day") | S7 |
| 9 | A cell that holds hours | Unchanged: `Button ghost sm` with the figure. It looks like text until it is hovered or focused; that is accepted and reported as a risk (R-D1), not restyled | S7 |
| 10 | Typing in the date field (R16) | Navigates only on a **complete day inside [min, today]**; holds its own text while focused; shows the period's reference day again on blur; no error text (the limit is in the picker and in the field's description). Detail in F7 | F7 |
| 11 | Next under the keyboard (R18) | `aria-disabled`, still a tab stop, a press does nothing; the focus stays on it. Same for Previous at the floor and for "This week/month" on the current period | S7 |
| 12 | Tab order | Record hours → view tabs → Filters → Period → Previous → This week/month → Next → date field → table region → filled cells in reading order. Detail in Accessibility | Accessibility |
| 13 | Full width | `wide` on every hours page. **No layout guard is proposed**: no page's width changes, and no inline form exists to cap | Width |
| 14 | After a write | The table keeps its **sideways scroll position** across the re-read; a cell that empties sends focus to the card's heading | F5, S7 |

### Flows (amended)

**F3 Open the table view and change its period — US-5, AC-5.1, 5.2, 5.4, 5.5, 5.21, 5.22, 5.25–5.29, 5.33** (replaces F3)

1. My hours opens on the **table view**, **the current week** (AC-5.1, 5.4), from the user menu, from a host's "See in My hours"
   and from `/hours` typed by hand. The tabs read **Table | List**, Table selected. The container is full width (S6).
2. The card's heading says the period ("Week 16.11.2026 – 22.11.2026"); under it the toolbar: **Period** (Week selected),
   the navigator, the date field showing today.
3. **Month** (click, or ← / → in the group) shows the month by the plan's rule (AC-5.26, D25): the current month from the
   current week, the month of the week's Monday from a past one. **Week** shows the week by AC-5.27 as settled by D26: the week the month
   was reached from, else the current week, else the first week whose Monday is in the month (G14, G15 resolved). The radio keeps focus; the grid is replaced by the skeleton and the heading, the toolbar
   and the date field stay (never-replaced part, plan).
4. **Previous** steps one period back; **This week / This month** returns to the current one; **Next** steps forward **only
   while the period shown is before the current one**: on the current period it is `aria-disabled` and does nothing (AC-5.5,
   5.28). A person who steps forward and arrives at the current period keeps the focus on Next, now unavailable (R18).
5. The period is in the address (`?week=<Monday>`, `?view=month&month=<YYYY-MM>`, plan § The address; a replacing navigation), so a
   bookmark or a reload keeps it. An address naming a later week or month shows the current one (AC-5.29): nothing is said,
   the page just shows the current period with Next unavailable.
6. Any filter change reads the period again with the same span; **Clear filters** keeps the view and the period (AC-5.21,
   5.22). Period and its From / To are not in the Filters card in the table view (WA5).
7. **List** goes to the List; **Table** comes back to the period that was shown (plan `withList` / `withTable`). Filters and the
   project and deal picks are the same in both (AC-5.22).
8. Exits: loading, empty (no hours, or none matching the filters), error with Retry, the deal-filter refusal, the source-down
   notes (S7 *States*). After a Retry that works focus goes to the card's heading; if it fails again, to the banner.

**F4 — withdrawn** (D17). There is no recording from an empty cell. An empty cell is a plain blank `td`; clicking it does
nothing, on any day and any row (AC-5.32).

**F5 Work on a cell's entries — amended** (AC-5.15–5.18, 5.20, 5.24; steps 1–4 as before, for either period)

5'. **When the last entry leaves the cell** (deleted, or edited to another day or row): the cell dialog **closes** once the new
    figures are there, **focus goes to the card's heading** (the cell is empty, and an empty cell is no control), and the page
    says what happened ("Entry deleted." / "Entry saved."). The old "to the cell, now empty, one Enter from recording again"
    is gone with the plus. **The table keeps its sideways scroll position**: the grid is replaced by a skeleton while it is
    read again, so the scroll region is unmounted and would come back at the left edge, which in a month is a loss of place
    (the heading does not scroll it back, a cell button would); the card remembers the region's `scrollLeft` for the period shown and
    puts it back when that period's grid returns (G18). A change of period starts at the left.

**F6 Record with the page's Record hours while the table view is shown — amended wording** (AC-5.19, 5.20): as before for the
week and the month. The day outside the period shown gets the period's sentence (`table.week.savedOutside` /
`table.month.savedOutside`).

**F7 Jump to a day with the date field — US-5, AC-5.30, 5.31 (new; plan decision 14 and R16)**

1. The field shows the period's **reference day**: today in the current period, else the period's first day. Its label says
   what it does ("Show the week of" / "Show the month of"); its description, read on focus, says "Up to today." (visually hidden); the
   picker greys every day after today (`max`) and every day before the earliest period the address accepts (`min`).
2. Picking a day in the native picker, or typing a complete day: **a day in another period shows that period, of the same kind
   (week stays week, month stays month), at once** — no Apply button (AC-5.30). A day inside the period shown changes nothing.
3. Typing is digit by digit, so the field passes through values that are valid days of no use: the year 0002, 0020, 0202. They are
   below `min`, so **nothing happens until a complete day inside [min, today] exists**; every navigation aborts the walk of the
   one before (plan). Typing a single segment of a filled date (the day 19 → 12) makes a complete day each time and navigates
   if it lands in another period; that is the field working, not a fault.
4. **While the field has focus its text is the person's**: a re-render, including the one a navigation causes, never rewrites it.
   An incomplete or emptied value, a day after today or a day before `min` changes nothing and says nothing; on **blur** the
   field shows the reference day of the period shown again (a refused day is visibly given back). No error text: the limit is
   stated by the greyed days and by the description (AC-5.31), and a message that flashes on a half-typed date is the thing
   R16 warns about.
5. After a navigation the **focus stays in the field**; the period's other controls and the heading follow it. A period changed
   by any other control puts that period's reference day in the field.
6. Reported, not a fault (G21): after picking Wed 14.10 the field reads Mon 12.10 in the week and 01.10 in the month once it loses
   focus. It states the period shown, from the address; it keeps no state of its own.

### Screens & states (amended)

#### S6 My hours with the Table | List switch (AC-5.1, 5.2, 5.4, 5.21, 5.22, 5.33, C1, WA5, WA10)

```
Hours                                                  (h1)   [My hours | Everyone's hours | Settings]   ← holders only, unchanged
My hours                                               (h2)                                [Record hours]
Time worked on two things at once counts in full … (description, unchanged)
[ Table | List ]                                       ← Tabs, a tablist of views of the SAME page
[ notice: "Entry saved." ]  [ HoursBanners ]           ← inside the panel
┌ Filters ─ [Clear filters] ┐   no Period in the table view (Period, with From and To, is the List's)
│ Recorded on  Project  Deal  Category  Work type │
└──────────────────────────┘
<S7, the table card>        or        <the List's Totals and Entries, unchanged>
```

- **Control: `Tabs`, as built** (`ViewSwitch`); the tabs are **Table** (first, the default) and **List**, the tab list "View of
  your hours". Selecting a tab writes the address by the plan's `withList` / `withTable` and does not move focus off the tab. The
  choice of `Tabs` over `TabNav` stands (decision 5 of the plan: one page, no route).
- **The three addresses** the plan names (`/hours`, `?view=month`, `?view=list`, and the legacy `?view=week`) open the view and
  period they say; the controls of S7 write them.
- **Width (AC-5.33).** `HoursShell` gives `ToolLayout width="wide"` on every route and view, so the tool title, the tool's own
  tabs and every page share one column: switching Table ↔ List, Week ↔ Month, or My hours ↔ Everyone's hours ↔ Settings moves
  nothing **(checked: the container is 1,851 px at 1920 px on the List, Everyone's hours and Settings alike)**. See § Width.
- **States.** Tabs, header and Filters are always shown; the panel is one state per region, as S7.
- **Everyone's hours** has no table view (WA4); it only follows the width.

#### S7 The table view — `/hours[?view=month][&week=…|&month=…]` (US-5, AC-5.3–5.11, 5.13–5.34)

```
┌ Week 16.11.2026 – 22.11.2026 ─────────────────────────────────────────────────────────────────┐
│ Period                                         Show the week of                               │   ← labels
│ (•) Week  ( ) Month      ‹  [This week]  ›     [19.11.2026 ▭]                                 │   ← toolbar
│ RECORDED ON     MON         TUE         WED         THU [Today]   FRI   SAT   SUN      TOTAL │
│              16.11.2026  17.11.2026  18.11.2026  19.11.2026  20.11…                           │
│ [Project] Alpenstrom — …    3 h                                                          3 h  │
│ [Other work] Talk prep…     1 h                                                          1 h  │
│ Total                       4 h          —           —           —      —     —     —     4 h  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘

┌ November 2026 ─────────────────────────────────────────────────────────────────────────────────┐
│ Period                                         Show the month of                               │
│ ( ) Week  (•) Month      ‹  [This month]  ›    [19.11.2026 ▭]                                  │
│ Scroll sideways to see every day of the month.                                                 │
│ RECORDED ON ┃ SUN  MON  TUE  WED  THU  FRI  SAT  SUN  MON  TUE  … (scrolls) ┃          TOTAL │
│             ┃   1    2    3    4    5    6    7    8    9   10             ┃                 │
│ [Project]   ┃       8 h  8 h  4 h  8 h 7 h 30           8 h  4 h …          ┃       120 h 30 │
│ Alpenstrom… ┃                                                                ┃                 │
│ Total       ┃  —   8 h  8 h  8 h  8 h  8 h   —    —   8 h  8 h  …           ┃          154 h │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
   ┃ = the pinned label and Total columns (from 768 px up): a rule on the edge that faces the days
```

(Illustrative figures. The shape was **checked** as injected DOM at 1440 and 375 px, the pins as a scrolled table at 1440.)

- **Container.** One `Card` whose title is the period (h3: the week as two `formatDate`s as before, "Week 16.11.2026 –
  22.11.2026"; the month through `formatMonth`, "November 2026") holding the toolbar, the hint and one `DataTable` (`caption`
  and `regionLabel` "Hours by project, deal, meeting and other work, November 2026"). The card's `action` is empty.
- **Toolbar** (a `flex flex-wrap items-end gap-x-6 gap-y-3` row, three items; **checked** at 1440 and at 375, where it wraps to
  three short rows and the heading has the full card width):
  1. **Period** — `RadioGroupField` (visible label "Period", radios "Week" and "Month"; `name` from `useId`). Choosing applies at once.
  2. **The navigator** (`PeriodNavigator`, `role="group"` named "Choose a week" / "Choose a month"): `‹` Previous (`iconOnly`,
     `ghost`, `sm`, "Previous week"), the return (`secondary`, `sm`, "This week" / "This month"), `›` Next (`iconOnly`, `ghost`,
     `sm`, "Next week"). The return is `aria-disabled` on the current period; **Next is `aria-disabled` on the current
     period** (AC-5.28); Previous is `aria-disabled` on the first period hours-api answers (the plan's floor). The library's
     `aria-disabled` look is the dimmed one; the press does nothing; the focus stays.
  3. **The date field** — `Field` + `DateInput`, visible label "Show the week of" / "Show the month of"; `min` / `max` from the plan's
     `pickBounds`; described by a visually hidden "Up to today."; no `required` mark (F7).
- **Columns.** First **Recorded on** (the row header; kind `Badge` + name, unchanged; the floor `min-w-28` stays for both periods — a
  longer name wraps to three or four lines in the month's narrow label column **(checked)** and the label is pinned, so that is
  acceptable). Then **one column per day of the period**: 7 or 28–31, the 1st to the last for a month (AC-5.25), Monday to Sunday for
  a week. Then **Total**. Day and Total columns are `numeric`.
  - **Week header:** as built, short weekday + the **Today** badge, and `formatDate(day)` on the second line.
  - **Month header:** line 1 the short weekday, with the **Today** badge beside it on today's column; line 2 the day number
    ("1" … "31", `formatNumber`). The whole header is `aria-hidden` and followed by `VisuallyHidden` with the long date ("Sunday 1
    November 2026", with the word for today added on today's column), so a column header is read as a date, not as "Sun 1". The weekday comes
    **from the date**, never from the column's index: 1 November 2026 is a Sunday, so the first column of that month is "Sun" (R17).
    **(checked)** ten rows with a half-hour in most columns are 2,655 px with the compact header against 2,838 px with `formatDate` headers: the form
    of the header moves ~180 px, because the **cell button** (3 + 10 px padding around a 12 px mono figure, in a cell with 8 px padding)
    is what sets a day column's width: 60 px when every figure is "8 h" or shorter, 81 px as soon as the column holds "7 h 30".
    The compact header is chosen for reading, not for width.
- **Rows, totals, AC-5.11:** as in the superseded S7 above, which still holds for them. One row per project, deal, meeting and kind of other work held in the period; the
  order; the unreadable and the retired labels; the day with nothing shows "—" in the Total row; a Total column and a last Total row; **no
  threshold, tint, icon or comparison anywhere**; `font-medium` on totals only, the same markup for 1 h and for 160 h.
- **Cells** (AC-5.9, 5.14, 5.15, 5.24, 5.32):

  | Cell | Shows | Is | Accessible name |
  |---|---|---|---|
  | holds hours (a day up to today, any row) | the total, "2 h 30" (DM Mono) | `Button ghost sm`, `aria-haspopup="dialog"`, `data-cell`, opens S8 | "2 h 30 on Alpenstrom — portale clienti, Sunday 1 November 2026, 2 entries" (unchanged; an unreadable row: "2 h on a project not visible to you, …") |
  | **empty, any day, any row** (D17, AC-5.14, 5.32) | **nothing** | **not a control**: a plain `td`; no button, no `data-cell`, no tab stop, no handler, no hover, no pointer | — |

  A day after today, an unreadable row, a retired category and a readable row on a past day all look and behave the same
  when empty: blank and inert. A cell that holds hours on an unreadable row or a retired category opens S8 without Add hours
  (AC-5.24), as before.
- **Today.** The badge in today's header (text, so colour is never the only signal); the column is not tinted. In a month that
  has not reached its end, the days after today are blank columns with "—" in the Total row.
- **Pinned columns, month only, from 48 rem (768 px) up.** The **Recorded on** column sticks to the region's start edge and **Total**
  to its end edge, so the row's name and its total are in view whatever is scrolled **(checked: pinned and scrolled at 1440 px; the
  pin's edge rule drew and the row hairlines held across the pinned cells)**. This needs one change to `@operai/ui`, **optional, recommended**:
  `DataTableColumn.pin?: 'start' | 'end'` (at most one of each; ignored below 48 rem). Required behaviour, for the library task:
  an opaque surface equal to the card's (`--ink-soft`, both themes); a hairline `--rule` on the edge that faces the scrolling days
  (an inset shadow: the table has collapsed borders, which a sticky cell does not carry); the row hairlines stay; and **a focused
  cell is never hidden under a pinned column** — the region's scroll padding follows the pinned columns' measured widths, so Tab
  and Shift+Tab bring a cell clear of them (WCAG 2.4.11, the case jsdom cannot show: the real-browser e2e proves it). A story (a
  wide table), a test, a changeset for `@operai/ui`, and it ships through the shell first (ADR 20261114; plan R4, R12). The week
  does not pin: it fits from ~980 px and its phone behaviour is the QE-verified one.
  **If the user declines the extension,** the month ships unpinned: on any ordinary window the row's name scrolls out of sight on the first
  scroll (each cell still names its row and day, and its dialog's title names them) and the row Total is off-screen until the end of
  the table. That is what G10 accepted for the week and it is much worse in a table that always scrolls.
- **Scroll hint.** Week: as built, `lg:hidden`, "Scroll sideways to see all seven days." Month: the same `<p className="mb-3 text-xs
  text-soft" aria-hidden="true">` with "Scroll sideways to see every day of the month.", **at every width**, only while a grid is shown
  (not loading, not empty, not an error, not a replaced state). It stays true with the pins: the days scroll.
- **Scroll region.** `DataTable`'s focusable, labelled region (AC-5.34): the page's width does not change; the last day of the
  month is reachable by scrolling or by the keyboard.
- **Announcement.** One polite status when a period (or its filters) finish loading: "November 2026: 154 h in total." (spoken
  duration), or "…: no hours recorded."; focus does not move.

**States** (exactly one per region; the heading, the toolbar and the date field are always shown)

| Region | Loading | Empty | Error / partial |
|---|---|---|---|
| The grid | `SkeletonRows` (4 rows, `aria-hidden`) + `VisuallyHidden live` "Loading your week…" / "Loading your month…". A period or filter change shows it at once, never the previous period's figures under the new span | **No filter:** `StatePanel` (h4) "No hours recorded this week" / "…this month" + the body "Record the hours you worked and they appear here, by project and day." (the header has the action). **Filters set:** the List's "No entries match these filters" + **Clear filters**. **No "not started" state** (D24): no future period can be shown | `ErrorBanner` (warning) "Your hours could not be loaded" + **Retry**, no partial grid (the read is all or nothing, MA5). A 503 `host_unavailable` with a deal filter set is the List's `DealFilterUnavailable`, replacing the grid in both periods |
| After a write | the same read again with the same skeleton; an open cell dialog keeps the last loaded cell until the new grid lands; the sideways scroll position is restored | — | a failed re-read shows the error with Retry |
| Source down, names hidden | — | — | `HoursBanners` and the standing "not visible to you" note, as the List and the Week |

**Focus rules.**
- A period change by the radios, the navigator or the date field: focus **stays on the control used** (all of them are in the never-replaced part).
- A save from Record hours in the header: the library returns focus to Record hours. A write from the cell dialog: the dialog keeps focus (the
  library gives it back to the button that opened the dialog that wrote).
- **A cell that empties**, or a re-read after a write that leaves nothing to focus: the card's heading (`focusableHeading`), never `body`; the
  sideways scroll is restored first.
- **After a Retry**: that works → the heading; fails again → the banner. As before.
- Next pressed and arriving at the current period: focus stays on Next (R18).

#### S8 and S9 — deltas only

The cell dialog and the entry dialog opened from it are as before, for a week cell and for a month cell. Edit and Delete open their
dialogs over it; Add hours opens My hours' own dialog with that day and that row set and still changeable (AC-5.13, 5.18, WA6), focus on
Duration; there is no longer any other way into that preset dialog.

### Width of every hours page (AC-5.33, D16, R20)

`HoursShell` is `wide` on My hours (List, week, month), Everyone's hours, Settings and the not-found panel. **Checked at 1920 px** with
`tool-width-wide` on: the tool container goes from 1,280 px to 1,851 px on all three pages, header, tabs and cards share the left
and right edge, and the Filters grid (`auto-fit minmax(160px, 1fr)`) simply makes seven controls ~240 px each. What gets long is
what D16 named: the List's Totals and Entries rows (a name at the left, the figure ~1,700 px away) and Settings' tables (four columns spread
over 1,800 px). **No guard is proposed.** The plan's R20 allows "capping a form's own width": hours-ui has **no inline form** — Settings edits
in `FormDialog`s (a dialog has its own width) and the Filters grid reflows — so there is nothing to cap, and capping a card or a table
would put that card's right edge at a different place from My hours' cards, which is the jump D16 removed. Nothing here changes a
page's width: if the user wants shorter lines on very wide screens later, the place is a `max-w-*` on the Totals and Entries tables
only (their card edges stay aligned), as a follow-up.

### Copy (en + `it: typeof en`; the plan's keys, the design's words)

The standing note stands: a native speaker should read the Italian before release. `PeriodWords` is the plan's type; the one key it lacks
is marked.

| Key | en | it |
|---|---|---|
| `table.view.label` / `.list` | View of your hours / List | Vista delle tue ore / Elenco |
| `table.view.table` | Table | Tabella |
| `table.period.label` / `.week` / `.month` | Period / Week / Month | Periodo / Settimana / Mese |
| `table.week.title(range)` | Week {range} | Settimana {range} |
| `table.month.title(month)` | {month} ("November 2026") | {month} ("novembre 2026") |
| `table.week.nav.label` / `previous` / `current` / `next` | Choose a week / Previous week / This week / Next week | Scegli una settimana / Settimana precedente / Questa settimana / Settimana successiva |
| `table.month.nav.label` / `previous` / `current` / `next` | Choose a month / Previous month / This month / Next month | Scegli un mese / Mese precedente / Questo mese / Mese successivo |
| `table.week.pick.label` / `table.month.pick.label` | Show the week of / Show the month of | Mostra la settimana del / Mostra il mese del |
| `table.pick.hint` **(new, shared, not in the plan's `PeriodWords`; G16)** | Up to today. | Fino a oggi. |
| `table.week.loading` / `table.month.loading` | Loading your week… / Loading your month… | Caricamento della tua settimana… / Caricamento del tuo mese… |
| `table.week.empty.title` / `table.month.empty.title` | No hours recorded this week / No hours recorded this month | Nessuna ora registrata in questa settimana / Nessuna ora registrata in questo mese |
| `table.empty.body` | Record the hours you worked and they appear here, by project and day. | unchanged |
| `table.week.savedOutside(date)` / `table.month.savedOutside(date)` | Entry saved. {date} is outside the week you are viewing. / …the month you are viewing. | Registrazione salvata. Il {date} è fuori dalla settimana che stai guardando. / …dal mese che stai guardando. |
| `table.week.scrollHint` / `table.month.scrollHint` | Scroll sideways to see all seven days. / Scroll sideways to see every day of the month. | Scorri di lato per vedere tutti e sette i giorni. / Scorri di lato per vedere tutti i giorni del mese. |
| `table.grid.caption(label)` | Hours by project, deal, meeting and other work, {label} | Ore per progetto, opportunità, riunione e altro lavoro, {label} |
| `table.announce(label, total)` / `announceEmpty(label)` | {label}: {total} in total. / {label}: no hours recorded. | {label}: {total} in totale. / {label}: nessuna ora registrata. |
| `table.weekday.*`, `table.today`, `table.grid.total`, `table.cell.open(…)`, `table.cellDialog.*` | as `week.*` was | as `week.*` was |
| removed | `week.cell.record`, `week.emptyFuture.title` / `.body` | — |

The month header's hidden long date is made of existing words — `table.weekday.long`, `formatDateLong`, and `table.today` ("today" in lower case)
— so it adds no key.

### Component inventory (delta)

Library in use: **`@operai/ui`**, token utilities. One optional extension, no new component.

| Element | Reuse |
|---|---|
| The view switch | `Tabs` + `tabPanelProps` (`ViewSwitch`, relabelled Table / List) |
| The period switch | `RadioGroupField` (a labelled radiogroup, native radios) |
| The date field | `Field` + `DateInput` |
| The card, the grid | `Card`, `DataTable`, `Badge` (kind; Today), `Button`, `Icon`, `StatePanel`, `SkeletonRows`, `VisuallyHidden` (the month header's long date, the date field's description), `Dialog`, `ListRows` |
| Formatters | `formatMonth`, `formatDate`, `formatDateLong`, `formatNumber`, `formatDuration` |
| In hours-ui, extended (renamed by plan decision 9) | `TableView`, `PeriodNavigator`, `TableCellDialog`, `TableViewModel`, `ViewSwitch`, `HoursFilters` (`showPeriod`, exists), `HoursFiltersState`, `HoursShell`, `MyHoursPage` |

| NEW | Why nothing fits |
|---|---|
| `hours-ui/src/components/PeriodDateField.tsx` | The typing contract of R16 (navigate only on a complete in-range day, hold the text while focused, show the reference day on blur) is behaviour that a bare `Field` + `DateInput` does not have, and no hours-ui component has it |
| `PeriodSwitch` (thin; may stay inline in `TableView`) | Binds `RadioGroupField` to the copy and to `switchTo`; nothing more |

| Library extension (optional, recommended) | |
|---|---|
| `@operai/ui` `DataTableColumn.pin?: 'start' \| 'end'` | `DataTable` has no sticky column and the month always scrolls (decision 6). A prop on an existing component, with a story, a test and a changeset, shipped through the shell before hours-ui uses it |

Ratio: **14 library components and 5 formatters reused**, **9 in-repo files extended** (renames), **2 NEW app-level pieces (one of them thin
and foldable)**, **0 new library components, 1 optional library prop**.

### Accessibility (amended)

Common conventions of § Accessibility above hold: one h1, one h2, cards h3, `StatePanel` h4, dialog titles h2, every icon-only button
named, the library's focus ring, both themes, no `--muted` text, `prefers-reduced-motion` untouched (nothing here animates).

**My hours with the switch (S6).** `Tabs` is a real tablist named "View of your hours": one tab stop, ←/→ and Home/End, `aria-selected`;
the panel is `tabPanelProps`. Selecting a tab does not move focus off it.

**The table view (S7).**
- **Tab order**, top to bottom: Record hours → the view tab (one stop) → the panel → the Filters' controls → in the card: the **Period** group (one
  stop; ←/↑ and →/↓ select the other radio, which applies at once) → **Previous** → the **return** (a stop even when `aria-disabled`) → **Next**
  (likewise) → the **date field** (its day, month and year segments, then the picker button, as the browser builds it) → the **table region**
  (one stop; the arrow keys scroll it) → **the cells that hold hours**, row by row, left to right. Not stops: empty cells, the Total cells, the
  header cells, the pinned columns as such.
- **Table semantics, not the ARIA `grid` role** — the decision of S7 above holds for both periods and its cost grows with the month: every
  cell that holds hours is a tab stop, **typically 40–120 in a month, 310 at the worst** (31 days × 10 rows). Nothing is hidden behind them but
  the shell's footer link (the table is the last content), Shift+Tab goes back, and a screen-reader user moves by table cell, not by
  Tab. The upgrade path (a roving tabindex inside `TableView`, arrows between cells) is unchanged and is now a candidate follow-up (R-D2).
- **Names.** A column header reads as a date: the week's "Mon 16.11.2026" (+ "Today"); the month's, through the hidden long date,
  "Thursday 19 November 2026, today". A row header is the row's kind and name; "Total" heads the last column and the last row. A cell
  button keeps its full name (figure, row, long day, number of entries). The caption names the period.
- **Empty cells** are blank `td`s, read as "blank". A hidden "no hours" in each would be 31 × the rows of noise (decision 8).
- **The Period group** is a `radiogroup` labelled "Period"; the **navigator** is a `group` named "Choose a week" / "Choose a month"; Next and
  the return are `aria-disabled` rather than `disabled`, so the keyboard keeps them and a press does nothing (R18; the label is unchanged,
  the browser says "unavailable"). The **date field** has a visible label, a description ("Up to today.") and `min` / `max`.
- **Focus.** Moves to the heading only where its target is gone (a cell that emptied, a Retry that worked); everywhere else it stays on the
  control used (F5, F7, S7 *Focus rules*). **A pinned column never hides a focused cell** (the `pin` requirement above; WCAG 2.4.11).
- **Announcements.** One polite status per loaded period ("November 2026: 154 h in total."), the skeleton's "Loading your month…", errors as an
  `alert`. The scroll hint is `aria-hidden`; the region is a labelled, focusable scroll region.
- **Contrast.** Badges, today's marker and the figures are library tokens; the pinned cells take the card's surface token so nothing scrolls
  visibly under them in either theme; the pin's hairline is decoration, not information.
- **The cell dialog (S8) and the dialogs over it:** as in § Accessibility above, for a week cell and a month cell alike; what changes is only the weekday
  (from the date) and where focus lands when the cell empties (the card's heading, F5).
- **The screen-reader readback** of all this is out of the gate (amendment above, D14); the roles, texts, `aria-hidden` and focus are what the
  tests verify.

### AC coverage and scope (amended)

| Surface | ACs |
|---|---|
| S6 · F3 | AC-5.1 (the Table / List switch, Table first), 5.2 (the addresses; written by S6 and S7's controls), 5.4, 5.21, 5.22, 5.33 |
| S7 · F3 | AC-5.3, 5.25 (the columns), 5.5, 5.28 (the navigator), 5.26, 5.27 (the period switch), 5.6–5.11, 5.23 (rows, cells, totals, labels), 5.20, 5.34 (scroll, pins, hint) |
| F7 · S7 | AC-5.30, 5.31 (the date field) |
| S7 cells | AC-5.32 (an empty cell is inert), 5.14 (a day after today offers nothing: the same blank cell) |
| F5 · S8 · S9 | AC-5.13, 5.15–5.18, 5.24 |
| F6 | AC-5.19 |
| every string | AC-4.6 |

ACs with **no UI surface of their own**: AC-5.12 (withdrawn); AC-5.14 (an absence, covered by AC-5.32); AC-5.29 (an address: the table just shows the
current period with Next unavailable); AC-5.6–5.10 (computed by `tableGrid`; their surface is the grid); AC-5.11 (an absence, guarded by a test).

**UI added that no AC asks for (small, kept, reported — strike any):** the pinned label and Total columns, and the library prop that needs (decision
6); restoring the sideways scroll position after a write (G18); the date field's hidden description; the month header's hidden long date; the radio
group's visible label "Period"; `aria-disabled` on Previous at the floor (plan decision 12). None changes data, a route or a permission.

**Not designed — scope creep or out of spec, reported:** scrolling today's column into view when the current month opens; a roving-tabindex grid; a
chip or border on cells that hold hours (R-D1); a visible hint, or an error message, under the date field; a weekend tint; a bare "Add" on an
empty day; typing into a cell; "Add row"; a week or month picker of our own; the week starting on another day; remembering the last period.

### Risks (closed, and new)

| Risk | Result |
|---|---|
| R11 month width | **Measured:** 1,974 px (30 days, every figure "8 h" or shorter), 2,034 (31 days), 2,295 (a six-row month with empty weekends), 2,655–2,729 (a half-hour in most columns, Total "120 h 30"); 2,838 with the week's date headers. Region 1,125 / 1,285 / 1,765 px at 1280 / 1440 / 1920. The region is the window's width minus ~155 px (**checked**), so the month scrolls on any window narrower than ~2,130–2,880 px, i.e. every ordinary one. Closed by: pins, the always-on hint, the compact header (for reading) |
| R12 library change | One optional prop, `DataTable` `pin`; no date formatter needed (the day number is `formatNumber`, the long date `formatDateLong`) |
| R16 typing | F7: navigate on a complete in-range day only; own text while focused; reference day on blur |
| R18 Next | `aria-disabled`, still a stop; the press does nothing; the focus stays |
| R-D1 a filled cell reads as text | A `ghost` button has no border at rest; with the plus gone, nothing but the hover tint, the pointer and the focus ring says a figure opens its entries. Accepted (least change; the user asked for the plus to go). Check in QE; if it proves hard to find, the smallest remedy is `variant="secondary"` on cells that hold hours, a one-prop change |
| R-D2 tab stops in a month | Up to ~310 (typical 40–120); table semantics kept; the roving-tabindex layer is the named upgrade |
| R-D3 pins and focus | Needs the library's scroll padding to follow the pinned columns; only a real browser shows it, so the e2e proves it (Shift+Tab to a cell beside the pinned label) |
| R-D4 ragged day columns | A column is 60 px, or 81 px once it holds "7 h 30", and an empty weekend shrinks to its header: the month is not a uniform grid and no uniform width is forced (a width on the cell's content would add a month-only width rule to a QE'd cell) |

### Gaps found in the spec and plan

None blocks the design; none is designed around; the spec and plan are not edited.

12. **G12 — the plan's R11 attributes the width gap to the wrong thing.** "About 2,000 px with compact day headers and about 2,800 px with `formatDate`
    headers": **measured**, the header form is worth ~180 px (2,655 vs 2,838 px, ten rows, same cells); the 2,000-to-2,800 spread is the **figure
    width** ("8 h" 60 px per column, "7 h 30" 81 px). The range itself holds (1,974–2,729 px). Consequence in decision 6 and 7.
13. **G13 — nothing in the spec says where a scrolling month's row Total lives.** AC-5.10 asks for one per row; AC-5.34 lets the table scroll.
    At the far end of a 2,000-px table the headline figure of the month is off-screen at first sight on every ordinary window (the month is 1,974–2,729 px wide). The design
    pins it (library prop); if the user declines the prop it is a spec-level question whether the Total may come first.
14. **G14 — AC-5.27 does not keep the week the person left, and the plan's test row says it does.** From a past week the month is the month of its Monday,
    and back to Week the rule gives the current week if it falls in that month, else the week holding the month's 1st. The plan's AC-5.27 test row ("the
    round trip week → month → week lands on the week left") is true only for the current week (and a week that holds the month's 1st). Example: Wed 14
    October's week, Mon 12 – Sun 18 Oct, → October → Week gives Mon 28 Sep – Sun 4 Oct. Either the spec accepts that, or the address keeps `week`
    while the month shows (the plan's `withTablePeriod` removes it) so that Week returns to it.
15. **G15 — "the week holding the month's first day" can be mostly another month.** 1 November 2026 is a Sunday: the week is Mon 26 Oct – Sun 1 Nov, six
    October days. Someone on November (past) who switches to Week gets a week that reads as October. The first week that **begins** in the month (Mon 2
    Nov) would read right; it is the spec's call (AC-5.27) and is only reported.
16. **G16 — the plan's `PeriodWords.pick` is `{ label }` only.** The design adds one shared key, `table.pick.hint` ("Up to today."), as the date field's visually
    hidden description: AC-5.31's limit is otherwise stated only by greyed days in a picker that a screen reader does not describe.
17. **G17 — not a gap in the plan but a change to shipped markup, reported so tasks.md carries it.** The build puts the navigator in `Card`'s `action`; the plan
    says only that it stays "in the part that is never replaced". The design moves it into the toolbar under the heading (decision 3, **checked**): every test id and
    the never-replaced rule are kept, and any test that assumes the navigator is the card's action changes with the move.
18. **G18 — nothing covers the table's scroll position after a write.** The grid is replaced by a skeleton while it is read again, which unmounts the scroll
    region: it comes back at the left edge. Harmless for a week that fits, a loss of place for a month; and since a cell that empties sends focus to the
    heading (D17), nothing scrolls it back. The design restores `scrollLeft` for the same period (F5); the plan does not mention it.
19. **G19 — the plan's AC-5.33 e2e names the page roots `hours-my-page` and `hours-everyone-page`; Settings' root is `time-lists-page`** (a `section`, exists). Add
    it so all three pages are measured.
20. **G20 — with AC-5.12 withdrawn there is no one-step way to record on an empty day of a row that already exists.** The paths are the header's Record hours (the
    person picks the project again) or Add hours in a neighbouring cell's list with the day changed in the dialog (WA6). That is D17, the user's choice; reported only.
21. **G21 — the date field shows the period's reference day, not the day just picked** (picked Wed 14.10 → Mon 12.10 in the week, 01.10 in the month, once the field
    loses focus). Plan-conformant (derived from the address, no state); stated so QE does not file it.
