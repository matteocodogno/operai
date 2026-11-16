---
id: 20261116
slug: record-hours-in-place
status: draft
rigor: production
created: 2026-11-16
depends-on: 20261112-time-tracking
---

# Record hours in place — from the project, the deal and the task one is working on, and a week view of My hours

Decision ledger: `ledger.md`

> Amended 2026-11-16, after a first approval the same day: the Week view of My hours (US-5, ledger D7–D11,
> WA1–WA10, C1) and the wording of AC-4.3 and AC-4.4 that it touches. Back to draft for re-approval.

## Problem

specs/20261112-time-tracking lets every employee record their hours, but only from My hours, reached
through the user menu, where they are shown as a list, day after day. Someone working on a project, a deal
or a task has to leave that page, open My hours and find the same project, deal or task again in a picker
before recording a few hours on it. The detour is slow and easy to put off, and hours recorded late are
recorded less accurately (ledger "Why": "macchinoso e limita la velocità"). And the list does not show at a
glance how a week's hours split by project, deal and day, so filling in or correcting a week means reading
it entry by entry (ledger, week view section).

## Domain language

No new term. **time entry**, **category**, **work type** and **My hours** as in specs/20261112-time-tracking;
**task**, **pre-sales activity**, **operational activity** and **My tasks** as in specs/20261110-activities.
"Record hours" below names the offer on a page, not a new concept: what it records is an ordinary time
entry. "List" and "Week" name the two ways My hours shows the same entries, not new concepts; the Week view
is not a timesheet (the glossary's _Avoid_ for time entry).

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
  (D3, A2; specs/20261112-time-tracking US-1, US-2).
- AC-4.3 Given an entry saved from a project's page, a deal's page or a task's row, then the dialog closes and the page says what was
  recorded and on what (for example "2 h 30 recorded on <project>", or "on other work"), with a
  link that opens My hours; nothing else on the page changes (D6).
- AC-4.4 Given an entry recorded from a project's page, a deal's page or a task's row, then it is changed
  or deleted only in My hours — its list or its Week view (US-5); none of those pages offers either (D6, D7).
- AC-4.5 Given the hours screens cannot be loaded, when a project's page, a deal's page or a list of
  tasks is opened, then it loads and works as before, and where Record hours would be it offers a
  link to My hours instead (A1).
- AC-4.6 Given any copy this spec adds, then it exists in English and Italian and follows the
  language the suite is shown in (specs/20261112-time-tracking AC-5.6).

### US-5 See and work on my week in My hours
As anyone recording hours, I want My hours to show one week as a grid of what I worked on, day by day, so
that I see where the week went and record or correct a day from there without going through the list.

- AC-5.1 Given My hours, when it is opened from the user menu, then it shows the list as before this spec
  and offers a switch between List and Week (D11).
- AC-5.2 Given the address of the Week view, when it is opened directly, then My hours opens on the Week
  view (D11).
- AC-5.3 Given the Week view, then it shows seven days, Monday to Sunday (WA1).
- AC-5.4 Given the Week view, when it is opened, then it shows the current week (WA5).
- AC-5.5 Given any week shown, then the Week view offers the previous week, the next week and a return to
  the current week (WA5).
- AC-5.6 Given the person's entries in the week shown, then the Week view has exactly one row for each
  project, deal, meeting and category of other work they hold hours on that week (D9, D10).
- AC-5.7 Given an entry on a meeting that counts for a deal, then its hours are on the meeting's row, not on
  the deal's row (D10).
- AC-5.8 Given the rows, then they are ordered projects, deals, meetings, other work, and by name within
  each kind (WA8).
- AC-5.9 Given a row and a day, then its cell shows the total duration of the person's entries on that row
  and that day, and is empty when there are none.
- AC-5.10 Given the week shown, then each row shows its week total, each day its day total and the week its
  grand total, each equal to the sum of the entries it covers.
- AC-5.11 Given any day of the week, then nothing on the Week view compares it with a contractual day or
  any other target (WA2; specs/20261112-time-tracking D23).
- AC-5.12 Given an empty cell on today or an earlier day, when it is opened, then the entry dialog of My
  hours opens with that day and the row's project, deal, meeting or category set (D7).
- AC-5.13 Given the entry dialog opened from a week cell, then its day and its project, deal, meeting or
  category can still be changed before saving (WA6).
- AC-5.14 Given a day after today, then its cells offer no recording (WA7).
- AC-5.15 Given a cell that holds hours, when it is opened, then it lists the entries of that day on that
  row, each with what My hours' list shows for it (D8).
- AC-5.16 Given an entry in a cell's list, when Edit is chosen, then My hours' entry dialog opens on that
  entry and saves it under the same rules as from the list (D8).
- AC-5.17 Given an entry in a cell's list, when Delete is chosen, then My hours' delete confirmation is
  asked and the entry is deleted only once confirmed (D8).
- AC-5.18 Given a cell's list on today or an earlier day, when Add hours is chosen, then the entry dialog
  opens with that day and that row's project, deal, meeting or category set (D8).
- AC-5.19 Given something with no hours in the week shown, when the person records on it on a day of that
  week with My hours' Record hours, then a row for it appears (D9).
- AC-5.20 Given an entry saved, changed or deleted from the Week view, then the cell, its row total, its
  day total and the week total show the new figures without reloading the page (WA9).
- AC-5.21 Given a project, deal, category or work type filter set in My hours, when the Week view is shown,
  then it holds only the entries the filters match (D11, WA5).
- AC-5.22 Given filters set in one view, when the person switches to the other, then the same filters are
  still set (D11, WA5).
- AC-5.23 Given a row on a project, deal or meeting whose name the person cannot read, then the row is
  labelled as My hours' list labels such an entry (WA8; specs/20261112-time-tracking AC-4.10).
- AC-5.24 Given a row whose name the person cannot read, then it offers no Add hours, neither on its empty
  cells nor in its cells' lists (WA8).

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
- **Typing hours into a cell of the Week view** (a timesheet) — a cell opens the dialog or its list of
  entries (D7).
- **An "add row" in the Week view, or last week's rows shown empty** — a row exists only for what holds hours
  that week; anything else is recorded with Record hours (D9).
- **Meeting hours on their deal's row in the Week view** — they stay on the meeting's row; the totals' Group
  by Deal of specs/20261112-time-tracking still counts them for the deal (D10).
- **Opening My hours on the Week view, or remembering the last view** — My hours opens on the list (D11).
- **A Week view of Everyone's hours** — own hours only (WA4).
- **Exporting from the Week view** — the list's export covers it (WA10).
- **A completeness cue or a 42-hour target in the Week view** — specs/20261112-time-tracking D23 (WA2).
- **Offering Record hours to everyone who may record** — someone involved in a deal only through one
  of its activities, or another case a page cannot see, records from My hours (D4).

## Constraints

- C1 (layout of the Week view, the user's words): "in merito al layout, sfrutta tutta la dimensione della
  pagine come fatto in Estimai" (2026-11-16).

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
- WA1 Weeks run Monday to Sunday, all seven days shown (the rules allow recording on a weekend) (AC-5.3).
- WA2 specs/20261112-time-tracking D23 holds: day and week totals, no "incomplete" mark, no 42-hour target (AC-5.11).
- WA3 Every rule of My hours holds unchanged: the same refusals and messages, names a person cannot read
  not shown, English and Italian (AC-4.2, AC-4.6, AC-5.23).
- WA4 Own hours only: Everyone's hours gets no Week view (Non-goals).
- WA5 In the Week view the week takes the place of the Period filter; the other filters apply and are kept
  when switching (AC-5.4, AC-5.5, AC-5.21, AC-5.22).
- WA6 From a week cell the day and the row are set but changeable: it is My hours' own dialog, so D3's
  "not changeable" (about the other pages) does not apply (AC-5.13).
- WA7 A day after today offers no recording (AC-5.14).
- WA8 Rows ordered by kind, then by name; a row whose name cannot be read is labelled as in the list and
  offers no Add hours (AC-5.8, AC-5.23, AC-5.24).
- WA9 Figures follow a save, an edit or a delete at once (AC-5.20).
- WA10 No export from the Week view (Non-goals).

## Open questions

- None — the ledger closed every branch (`complete: true`).
