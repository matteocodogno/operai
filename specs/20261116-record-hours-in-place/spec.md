---
id: 20261116
slug: record-hours-in-place
status: done
rigor: production
created: 2026-11-16
approved: 2026-11-19
done: 2026-11-19
depends-on: 20261112-time-tracking
---

# Record hours in place — from the project, the deal and the task one is working on, and a week and month view of My hours

Decision ledger: `ledger.md`

> Amended 2026-11-16, after a first approval the same day: the Week view of My hours (US-5, ledger D7–D11,
> WA1–WA10, C1) and the wording of AC-4.3 and AC-4.4 that it touches. Re-approved by the user 2026-11-16.
> Aligned 2026-11-16, kept approved by the user: AC-5.21 names the Recorded on filter that My hours gained
> (specs/20261112-time-tracking AC-4.4 as amended, D52), since D11 asks for "the list's existing filters".
> Amended 2026-11-17 after /wellforge:design, kept approved by the user (their choices, ledger D12, D13): AC-4.2 says
> where a refusal stands in a dialog whose target is fixed; AC-5.24 covers a row on a retired category.
> Reopened and amended 2026-11-19 (ledger D15–D24), after a first close the same day (29c97359, reverted by
> 9ab6b879): the Week view becomes the **table view**, with a week or a month as its period, and is where My hours
> opens (AC-5.1 reversed); a date field picks the period; Next stops at the current period (AC-5.5 amended); an
> empty cell offers nothing (AC-5.12 withdrawn, AC-5.13 and AC-5.24 amended); every hours page uses the full width.
> New: AC-5.25–AC-5.34. Re-approved by the user 2026-11-19; AC-5.26 settled the same day at the plan gate (D25), AC-5.27 at the design gate (D26).

## Problem

specs/20261112-time-tracking lets every employee record their hours, but only from My hours, reached
through the user menu, where they are shown as a list, day after day. Someone working on a project, a deal
or a task has to leave that page, open My hours and find the same project, deal or task again in a picker
before recording a few hours on it. The detour is slow and easy to put off, and hours recorded late are
recorded less accurately (ledger "Why": "macchinoso e limita la velocità"). And the list does not show at a
glance how a week's hours split by project, deal and day, so filling in or correcting a week means reading
it entry by entry (ledger, week view section). Once the Week view was in use, the user found that it changes the
page's width when switching from the list, that a week far back can only be reached one week at a time, and that
a month cannot be seen the same way; they also asked for empty cells to carry no button (ledger, table view section).

## Domain language

No new term. **time entry**, **category**, **work type** and **My hours** as in specs/20261112-time-tracking;
**task**, **pre-sales activity**, **operational activity** and **My tasks** as in specs/20261110-activities.
"Record hours" below names the offer on a page, not a new concept: what it records is an ordinary time
entry. "List" and "table view" name the two ways My hours shows the same entries, and "week" and "month" the
two periods of the table view; none is a new concept, and the table view is not a timesheet (the glossary's
_Avoid_ for time entry).

## User stories

### US-1 Record from the project page
As a project manager or a member of a project's team, I want to record my hours from the project's
page, so that I do not leave it to find the project again in My hours.

- AC-1.1 Given the project manager or a member of a project's team, when they open the project's
  page, then it offers Record hours (D1, D4).
- AC-1.2 Given anyone else who can read the project, when they open its page, then it offers no
  Record hours (D4).
- AC-1.3 Given Record hours on a project's page, when it is opened, then the entry dialog of My
  hours opens with that project already chosen and not changeable, the day set to today, and the
  focus on the duration (D3).

### US-2 Record from the deal page
As a deal's owner or its technical contact, I want to record my hours from the deal's page, so that
pre-sales work is recorded while I am on it.

- AC-2.1 Given the owner or the technical contact of a deal, when they open the deal's page in the
  CRM, then it offers Record hours (D1, D4).
- AC-2.2 Given anyone else who can read the deal — including someone involved in it only through one
  of its activities — when they open its page, then it offers no Record hours; such a person still
  records on the deal from My hours (D4).
- AC-2.3 Given Record hours on a deal's page, when it is opened, then the entry dialog opens with
  that deal already chosen and not changeable, the day set to today, and the focus on the duration
  (D3).

### US-3 Record from a task
As the person a task is assigned to, or one taking part in it, I want to record my hours from the
task's row, so that the hours land on the right project or deal and point at that task without
searching for either.

- AC-3.1 Given a task shown in a list of tasks — a project's Tasks card, My tasks, or one of the
  CRM's task lists — then its row offers Record hours to the task's assignee and to its
  participants, and to nobody else (D1, D4).
- AC-3.2 Given a task about a project, when Record hours on its row is opened, then the entry dialog
  opens with the project and the task already chosen and not changeable (D3; specs/20261112-time-tracking
  AC-2.7).
- AC-3.3 Given a CRM task about one of a company's deals, when Record hours on its row is opened,
  then the entry dialog opens with that deal and the task already chosen and not changeable (D3).
- AC-3.4 Given a CRM task about a company and none of its deals, when Record hours on its row is
  opened, then the entry dialog opens on other work with no category chosen (D2, A3).
- AC-3.5 Given an entry saved from the row of a CRM task about no deal, then it is other work with the
  category the person picked, and it carries no link to the company or to the task (D2).
- AC-3.6 Given a task that is done, then its row offers Record hours exactly as an open task's row
  does (A4).

### US-4 The same entry, wherever it is recorded
As anyone recording hours, I want an entry recorded from a page to be the same as one recorded in My
hours, so that there is one set of rules and one place to correct it.

- AC-4.1 Given an entry recorded from a project's page, a deal's page or a task's row, then it is
  listed in the person's My hours with the same day, duration, target, task pointer, work type and
  note (D3).
- AC-4.2 Given a value or a situation that My hours' dialog refuses — a duration that is not whole
  30-minute steps, a day after today, a project whose team the person has left, a time-tracking
  outage — then the dialog opened from a page refuses it in the same way, with the same message
  (D3, A2; specs/20261112-time-tracking US-1, US-2). A refusal My hours shows on the project or deal picker is
  shown for the whole dialog, which has no picker, and drops any invitation to choose another (D13).
- AC-4.3 Given an entry saved from a project's page, a deal's page or a task's row, then the dialog closes and the page says what was
  recorded and on what (for example "2 h 30 recorded on <project>", or "on other work"), with a
  link that opens My hours; nothing else on the page changes (D6).
- AC-4.4 Given an entry recorded from a project's page, a deal's page or a task's row, then it is changed
  or deleted only in My hours — its list or its table view (US-5); none of those pages offers either (D6, D7).
- AC-4.5 Given the hours screens cannot be loaded, when a project's page, a deal's page or a list of
  tasks is opened, then it loads and works as before, and where Record hours would be it offers a
  link to My hours instead (A1).
- AC-4.6 Given any copy this spec adds, then it exists in English and Italian and follows the
  language the suite is shown in (specs/20261112-time-tracking AC-5.6).

### US-5 See and work on my week or my month in My hours
As anyone recording hours, I want My hours to show a week or a month as a grid of what I worked on, day by day, so
that I see where the time went and correct a day from there without going through the list.

Unless an AC names one period, it holds for the week and for the month (D15).

- AC-5.1 Given My hours, when it is opened from the user menu, then it shows the table view and offers a switch
  to the List (D19; reversed 2026-11-19, it opened on the List).
- AC-5.2 Given the address of the List, of the table view's week or of its month, when it is opened directly,
  then My hours opens on that view and that period (D11, D19, MA2).
- AC-5.3 Given the week as the period, then the table shows seven days, Monday to Sunday (WA1).
- AC-5.4 Given the table view opened with no week or month named in its address, then it shows the current
  week (WA5, D23).
- AC-5.5 Given any week or month shown, then the table view offers the previous period, a return to the current
  period, and the next period only while the period shown is before the current one (WA5, D24).
- AC-5.6 Given the person's entries in the period shown, then the table has exactly one row for each project,
  deal, meeting and category of other work they hold hours on in that period (D9, D10).
- AC-5.7 Given an entry on a meeting that counts for a deal, then its hours are on the meeting's row, not on
  the deal's row (D10).
- AC-5.8 Given the rows, then they are ordered projects, deals, meetings, other work, and by name within
  each kind (WA8).
- AC-5.9 Given a row and a day, then its cell shows the total duration of the person's entries on that row
  and that day, and is empty when there are none.
- AC-5.10 Given the period shown, then each row shows its total for the period, each day its day total and the
  period its grand total, each equal to the sum of the entries it covers.
- AC-5.11 Given any day of the period, then nothing on the table view compares it with a contractual day or
  any other target (WA2; specs/20261112-time-tracking D23).
- AC-5.12 Withdrawn 2026-11-19 (D17): an empty cell no longer opens the entry dialog; see AC-5.32.
- AC-5.13 Given the entry dialog opened with Add hours from a cell's list, then its day and its project, deal,
  meeting or category can still be changed before saving (WA6).
- AC-5.14 Given a day after today, then its cells offer no recording (WA7).
- AC-5.15 Given a cell that holds hours, when it is opened, then it lists the entries of that day on that
  row, each with what My hours' list shows for it (D8).
- AC-5.16 Given an entry in a cell's list, when Edit is chosen, then My hours' entry dialog opens on that
  entry and saves it under the same rules as from the list (D8).
- AC-5.17 Given an entry in a cell's list, when Delete is chosen, then My hours' delete confirmation is
  asked and the entry is deleted only once confirmed (D8).
- AC-5.18 Given a cell's list on today or an earlier day, when Add hours is chosen, then the entry dialog
  opens with that day and that row's project, deal, meeting or category set (D8).
- AC-5.19 Given something with no hours in the period shown, when the person records on it on a day of that
  period with My hours' Record hours, then a row for it appears (D9).
- AC-5.20 Given an entry saved, changed or deleted from the table view, then the cell, its row total, its
  day total and the period's total show the new figures without reloading the page (WA9).
- AC-5.21 Given a project, deal, category, work type or recorded-on filter set in My hours, when the table
  view is shown, then it holds only the entries the filters match (D11, WA5; recorded on since
  specs/20261112-time-tracking D52).
- AC-5.22 Given filters set in one view or period, when the person switches to another view or period, then
  the same filters are still set (D11, WA5, MA4).
- AC-5.23 Given a row on a project, deal or meeting whose name the person cannot read, then the row is
  labelled as My hours' list labels such an entry (WA8; specs/20261112-time-tracking AC-4.10).
- AC-5.24 Given a row whose name the person cannot read, or a row on a retired category, then it offers no Add
  hours in its cells' lists; its entries can still be changed and deleted (WA8, D12, D17;
  specs/20261112-time-tracking AC-3.4).
- AC-5.25 Given the month as the period, then the table shows every day of that calendar month, from its first
  day to its last (D15).
- AC-5.26 Given a week shown, when the person switches the period to the month, then the current month is shown
  if the week is the current week, and otherwise the month holding that week's Monday (MA6, D25).
- AC-5.27 Given a month shown, when the person switches the period to the week, then the week shown before the
  month is shown again if it has a day in that month; otherwise the current week if it has a day in that month;
  otherwise the first week whose Monday is in that month (MA6, D26).
- AC-5.28 Given the current week or the current month shown, then moving to the next period is unavailable
  (D24).
- AC-5.29 Given an address naming a week or a month after the current one, when it is opened, then the current
  week or month is shown instead (D24).
- AC-5.30 Given a week or a month shown, when the person picks a day in the period's date field, then the week
  or the month holding that day is shown, in the same period (D18).
- AC-5.31 Given the period's date field, then it offers no day after today (D20).
- AC-5.32 Given an empty cell, on any day, then it offers no recording and nothing happens when it is
  chosen (D17).
- AC-5.33 Given any hours page — My hours in the List or the table view, in either period, Everyone's hours,
  Settings — then it uses the full width the suite gives a tool's page, as EstimAI does (C1), so switching view,
  period or tab does not change the page's width (D16).
- AC-5.34 Given a month wider than the window, then the table scrolls sideways within the page, every day of
  the month can be reached, and the page's own width does not change (D15, MA8).

## Non-goals

- **Changing the project, deal or task in the dialog opened from a page** — recording on something
  else stays My hours' job (D3).
- **Editing, deleting or undoing an entry from a page** — My hours only (D6).
- **Showing hours on these pages** — totals, per-person figures, "my hours here": the read-only hours
  card of specs/20261112-project-hours (D6, ledger F4).
- **A Record hours button visible everywhere, or a timer** — the offer is on the project, the deal
  and the task rows only (D1); a timer is a non-goal of specs/20261112-time-tracking (D8 there).
- **Recording on a company** — a CRM task without a deal records other work (D2); there is no
  company target.
- **Meeting pages** — hours from meetings are specs/20261112-meeting-hours' suggestions (A6).
- **Typing hours into a cell of the table view** (a timesheet) — a cell that holds hours opens its list of
  entries (D7, D17).
- **Recording from an empty cell** — hours are recorded with My hours' Record hours or with Add hours in the
  list of a cell that holds hours (D17).
- **An "add row" in the table view, or the previous period's rows shown empty** — a row exists only for what
  holds hours in the period shown; anything else is recorded with Record hours (D9).
- **Meeting hours on their deal's row in the table view** — they stay on the meeting's row; the totals' Group
  by Deal of specs/20261112-time-tracking still counts them for the deal (D10).
- **Remembering the last view or period** — My hours opens on the table view's current week (D19, D23).
- **Future weeks or months** — neither the date field nor the next period reaches past the current one
  (D20, D24).
- **A calendar of its own, a week picker or a month picker** — the period's date field picks a day (D18).
- **A table view of Everyone's hours** — own hours only; Everyone's hours only follows the full width (WA4,
  D16, MA7).
- **Exporting from the table view** — the list's export covers it (WA10).
- **A completeness cue or a 42-hour target in the table view** — specs/20261112-time-tracking D23 (WA2).
- **Offering Record hours to everyone who may record** — someone involved in a deal only through one
  of its activities, or another case a page cannot see, records from My hours (D4).

## Constraints

- C1 (layout of the Week view, the user's words): "in merito al layout, sfrutta tutta la dimensione della
  pagine come fatto in Estimai" (2026-11-16). Widened 2026-11-19 to every hours page (D16, AC-5.33).

## Assumptions (strike any that is wrong)

- A1 When the hours screens cannot be loaded, the pages and lists keep working and show a link to My
  hours where Record hours would be (AC-4.5).
- A2 The rules and messages are those of My hours' dialog, unchanged: whole 30-minute steps, no day
  after today, work type and note optional, the same refusals (AC-4.2).
- A3 On a CRM task without a deal the dialog opens on other work with no category preselected: no
  "pre-sales" category is seeded and none is configured as a default (AC-3.4).
- A4 Record hours is offered on done tasks as on open ones: hours are often recorded after the work
  is finished (AC-3.6).
- A5 No extra rule about a project's or a deal's state: whatever specs/20261112-time-tracking accepts
  or refuses on a closed project or a lost deal applies unchanged (AC-4.2).
- A6 Meeting pages get no Record hours (Non-goals).
- A7 A project task's assignee and participants are normally on the project's team; when one is
  not, the row still offers Record hours and saving is refused as AC-4.2 says.

Week view (ledger, week view section):
- WA1 Weeks run Monday to Sunday, all seven days shown (the rules allow recording on a weekend) (AC-5.3); a
  month shows all its days, weekends included (AC-5.25).
- WA2 specs/20261112-time-tracking D23 holds: day and week totals, no "incomplete" mark, no 42-hour target (AC-5.11).
- WA3 Every rule of My hours holds unchanged: the same refusals and messages, names a person cannot read
  not shown, English and Italian (AC-4.2, AC-4.6, AC-5.23).
- WA4 Own hours only: Everyone's hours gets no table view (Non-goals).
- WA5 In the table view the week or the month takes the place of the Period filter; the other filters
  (Recorded on included) apply and are kept when switching view or period (AC-5.4, AC-5.5, AC-5.21, AC-5.22).
- WA6 From Add hours in a cell's list the day and the row are set but changeable: it is My hours' own dialog,
  so D3's "not changeable" (about the other pages) does not apply (AC-5.13).
- WA7 A day after today offers no recording (AC-5.14).
- WA8 Rows ordered by kind, then by name; a row whose name cannot be read is labelled as in the list and
  offers no Add hours (AC-5.8, AC-5.23, AC-5.24).
- WA9 Figures follow a save, an edit or a delete at once (AC-5.20).
- WA10 No export from the table view (Non-goals).

Table view, week and month (ledger, table view section):
- MA1 The month's cells behave as the week's: a cell that holds hours opens the same list (entries, Edit, Delete,
  Add hours on today or earlier); an empty cell does nothing (AC-5.15–5.18, AC-5.32).
- MA2 The List, the week and the month each have an address of their own (AC-5.2); the words naming the table
  view and its periods are the design's.
- MA3 The month offers the previous month, the next month up to the current one and a return to the current
  month (AC-5.5, AC-5.28).
- MA4 The month applies the same filters as the week, kept when switching view or period (AC-5.21, AC-5.22).
- MA5 The month's figures, like the week's, come from one complete read of the month: a period that cannot be
  read in full shows an error, never part of the grid (AC-5.10; ledger MF6).
- MA6 Switching period keeps the time in view (AC-5.26, AC-5.27).
- MA7 Everyone's hours gets no table view (Non-goals).
- MA8 Where the month does not fit, its table scrolls sideways (AC-5.34).

## Open questions

- None — the ledger closed every branch (`complete: true`).
