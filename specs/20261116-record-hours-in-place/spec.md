---
id: 20261116
slug: record-hours-in-place
status: approved
rigor: production
created: 2026-11-16
approved: 2026-11-16
depends-on: 20261112-time-tracking
---

# Record hours in place — from the project, the deal and the task one is working on

Decision ledger: `ledger.md`

## Problem

specs/20261112-time-tracking lets every employee record their hours, but only from My hours, reached
through the user menu. Someone working on a project, a deal or a task has to leave that page, open
My hours and find the same project, deal or task again in a picker before recording a few hours on it.
The detour is slow and easy to put off, and hours recorded late are recorded less accurately (ledger
"Why": "macchinoso e limita la velocità").

## Domain language

No new term. **time entry**, **category**, **work type** and **My hours** as in specs/20261112-time-tracking;
**task**, **pre-sales activity**, **operational activity** and **My tasks** as in specs/20261110-activities.
"Record hours" below names the offer on a page, not a new concept: what it records is an ordinary time
entry.

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
- AC-4.3 Given an entry saved from a page, then the dialog closes and the page says what was
  recorded and on what (for example "2 h 30 recorded on <project>", or "on other work"), with a
  link that opens My hours; nothing else on the page changes (D6).
- AC-4.4 Given an entry recorded from a page, then it is changed or deleted only in My hours: no page
  of this spec offers either (D6).
- AC-4.5 Given the hours screens cannot be loaded, when a project's page, a deal's page or a list of
  tasks is opened, then it loads and works as before, and where Record hours would be it offers a
  link to My hours instead (A1).
- AC-4.6 Given any copy this spec adds, then it exists in English and Italian and follows the
  language the suite is shown in (specs/20261112-time-tracking AC-5.5).

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
- **Offering Record hours to everyone who may record** — someone involved in a deal only through one
  of its activities, or another case a page cannot see, records from My hours (D4).

## Constraints

- None given by the user.

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

## Open questions

- None — the ledger closed every branch (`complete: true`).
