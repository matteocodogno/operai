---
id: 031
slug: meeting-hours
status: approved
rigor: production
created: 2026-11-12
approved: 2026-11-12
depends-on: 021, 029
---

# Meeting hours — time entries suggested from the meetings a person took part in

Decision ledger: `../029-time-tracking/ledger.md` (shared with specs/029 and specs/030)

> **Origin.** Split out of specs/029 on 2026-11-12 (ledger D26). specs/029 lets a person record
> hours on a meeting by hand; this spec has Meetings offer those hours, already filled in, to the
> people who took part (ledger D7, D17). Every rule of specs/029 about time entries holds for an
> entry made from a suggestion.

## Problem

A meeting recorded or uploaded in Meetings already knows when it happened, how long it lasted
and which colleagues took part, yet each of them has to type the same hours again in specs/029's
hours view — or forget to. Meetings are the most frequent and most often forgotten part of the
working day, so the hours spent in them are the ones most likely to go missing.

## Domain language

- **suggested entry** — a time entry Operai offers a person from a Meetings meeting they took
  part in, with the meeting's day and duration filled in. It counts for nothing until the person
  confirms it, and then becomes their time entry (specs/029). _Avoid:_ proposal (ProposAI's
  word), draft entry.
- **meeting**, **creator**, **Operai participant** — as in specs/021.

## User stories

### US-1 My meetings suggest their hours
As an employee, I want the meetings I took part in to offer me their hours, so that I record them
without typing them.

- AC-1.1 Given a Meetings meeting that starts on or after the day this spec is released and whose
  duration is known, then its creator and each of its Operai participants has a suggested entry
  in their hours view: on the meeting, on the meeting's day, for the meeting's duration rounded to
  the nearest 30 minutes and never below 30 (D17, A4, A19).
- AC-1.2 Given a meeting whose duration is not known — typed or pasted, or not yet processed —
  then it suggests nothing until its duration is known (A4).
- AC-1.3 Given a person who already has a time entry on the meeting, then no suggested entry is
  offered to them for it (A17).
- AC-1.4 Given a meeting that started before the day this spec is released, then it suggests
  nothing (A19).
- AC-1.5 Given CRM call and meeting activities, then they suggest nothing (D17).

### US-2 Confirm, change or dismiss a suggestion
As an employee, I want to accept a suggestion as it is, adjust it or throw it away, so that only
hours I declare are recorded.

- AC-2.1 Given a suggested entry, when its person confirms it as offered, then it becomes their
  time entry on the meeting and counts like any other (specs/029).
- AC-2.2 Given a suggested entry, when its person changes its day, duration or note and confirms
  it, then it becomes a time entry with the changed values, under specs/029's rules (30-minute
  steps, no future day, note length); a change those rules refuse saves nothing.
- AC-2.3 Given a suggested entry, when its person dismisses it, then it disappears and is never
  offered to them again for that meeting (D17).
- AC-2.4 Given a suggested entry not yet confirmed, then it counts in no total, filter result or
  export (specs/029 A11), and it stays offered until confirmed or dismissed, without expiring (A5).
- AC-2.5 Given someone else's suggested entry, then nobody — admins and holders of see everyone's
  hours included — can see, confirm, change or dismiss it (D14, A23).

### US-3 The meeting changes before I confirm
As an employee, I want a suggestion to follow its meeting, so that I never confirm hours for a
meeting that changed or no longer concerns me.

- AC-3.1 Given a meeting that is deleted before its person confirms the suggestion, then the
  suggestion disappears (A18).
- AC-3.2 Given a person removed from a meeting's participants before confirming, then their
  suggestion disappears (A18).
- AC-3.3 Given time entries already confirmed on a meeting, when the meeting is deleted or their
  person is removed from it, then the entries stay; on a deleted meeting they are shown without
  its title (A18).
- AC-3.4 Given a meeting whose date-time or duration changes before its person confirms, then the
  suggestion shows the new day and duration (A24).
- AC-3.5 Given a time entry already confirmed from a suggestion, when its meeting's date-time or
  duration changes, then the entry does not change (A24).
- AC-3.6 Given a person added to a meeting's participants, then they get a suggested entry as in
  AC-1.1 (A24).

### US-4 Privacy and availability
As a meeting participant, I want suggestions to reveal nothing new about meetings, so that the
Meetings visibility rules still hold.

- AC-4.1 Given a suggested entry, then it shows only the meeting's title, day and duration, which
  its person can already read in Meetings; no transcript, summary or other content (ADR-0058
  posture).
- AC-4.2 Given Meetings cannot be reached, when a person opens their hours view, then it still
  loads with their time entries and says suggestions are unavailable (A25).
- AC-4.3 Given a new suggestion, then no notification is sent; suggestions are seen in the hours
  view (A26).
- AC-4.4 Given any new copy, then it exists in English and Italian, and durations use the library
  formatters.

## Non-goals

- **Suggestions from CRM call or meeting activities** — they have no duration (D17).
- **Suggestions from calendars** (Google Calendar or any other) or from any source other than
  Meetings.
- **Recording hours without the person's confirmation**: a suggestion is never a time entry by
  itself (D14).
- **Suggestions for meetings that started before the release** (A19).
- **Notifications** about suggestions (A26).
- **Start and end times** — specs/029 records a day and a duration only (D8).

## Constraints

- None given by the user.

## Assumptions (strike any that is wrong)

From the ledger:
- A4 A meeting's duration is rounded to the nearest 30 minutes, never below 30; no duration, no
  suggestion.
- A5 A suggestion does not expire.
- A17 No suggestion to a person who already has an entry on the meeting.
- A18 Deleting the meeting or removing the participant removes the suggestion, never confirmed
  entries.
- A19 Only meetings that start on or after the release day suggest hours.

Added while writing this spec (not grilled — review them):
- A23 A suggested entry is visible only to its person.
- A24 A suggestion follows its meeting's day, duration and participants until confirmed.
- A25 When Meetings cannot be reached, the hours view loads and says suggestions are unavailable.
- A26 No notification for a new suggestion.

## Open questions

- None.
