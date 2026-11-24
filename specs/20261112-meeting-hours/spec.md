---
id: 20261112
slug: meeting-hours
status: in-progress
rigor: production
created: 2026-11-12
reopened: 2026-11-24
approved: 2026-11-24
depends-on: 20261104-meetings, 20261112-time-tracking, 20261116-record-hours-in-place
---

# Meeting hours — the hours of a meeting recorded automatically for the people who took part

Decision ledger: `../20261112-time-tracking/ledger.md` (shared with specs/20261112-time-tracking, specs/20261112-project-hours and
specs/20261112-project-alerts; this spec's decisions are D7, D17 as superseded by D54, and D54–D57)

> **Origin.** Split out of specs/20261112-time-tracking on 2026-11-12 (ledger D26) and approved the same day as
> *suggested* entries each person confirmed (D17). **Re-opened on 2026-11-24** before any plan: the
> owner decided that a meeting's hours are recorded **automatically** when it ends, with no
> suggestion and no confirmation (D54). Every rule of specs/20261112-time-tracking about time entries holds
> for an automatic entry; the one it bends is who creates it (Operai, not the person — D14 narrowed,
> see US-1). Amended the same day after /wellforge:design: AC-2.3 names Everyone's hours and the
> Italian mark, AC-2.7 is new (ledger D60–D62).

## Problem

A meeting recorded or uploaded in Meetings already knows when it happened, how long it lasted and
which colleagues took part, yet each of them has to type the same hours again in My hours — or
forget to. Meetings are the most frequent and most often forgotten part of the working day, so the
hours spent in them are the ones most likely to go missing from every total built on them.

## Domain language

- **automatic entry** — a time entry Operai records for a person on a Meetings meeting they
  created or took part in, with the meeting's day and its duration rounded to 30 minutes. It is
  the person's own time entry (specs/20261112-time-tracking) from the moment it exists and counts like any other.
  _Avoid:_ suggested entry (the superseded design), proposal (ProposAI's word), draft entry.
- **untouched** — an automatic entry its person has not changed since Operai recorded it. Only an
  untouched entry follows its meeting (D56).
- **meeting**, **creator**, **Operai participant** — as in specs/20261104-meetings; **My hours**, **table view**,
  **List** — as in specs/20261116-record-hours-in-place.

## User stories

### US-1 A meeting records its hours
As an employee, I want the meetings I took part in to record their hours for me, so that I do not
type them and do not forget them.

- AC-1.1 Given a Meetings meeting that starts on or after the day this spec is released, when its
  duration becomes known, then its creator and each of its Operai participants has an automatic
  entry: on the meeting, on the meeting's day, for the meeting's duration rounded to the nearest 30
  minutes (D54, A4, A19).
- AC-1.2 Given a person who is both the meeting's creator and one of its participants, then they
  get one automatic entry, not two.
- AC-1.3 Given a meeting whose duration is not known — typed or pasted, or not yet processed —
  then no automatic entry exists for it until its duration is known (A4).
- AC-1.4 Given a person who already has a time entry on the meeting when its duration becomes
  known, then no automatic entry is recorded for them (A17).
- AC-1.5 Given a meeting that started before the day this spec is released, then it records no
  automatic entry (A19).
- AC-1.6 Given CRM call and meeting activities, then they record no automatic entry (D17).
- AC-1.7 Given an automatic entry, then it is recorded by Operai and not by a user; no user — an
  admin or a holder of see everyone's hours included — can still create, change or delete
  someone else's entry (specs/20261112-time-tracking AC-1.6, D14 narrowed by D54).
- AC-1.8 Given an automatic entry, then it obeys every rule of specs/20261112-time-tracking for an entry on a meeting:
  whole 30-minute steps from 30 minutes to 24 hours, no future day, no work type, counted for the
  meeting's deal when the meeting is linked to one (specs/20261112-time-tracking AC-2.6).

### US-2 My automatic entries are mine
As an employee, I want an automatic entry to behave like an entry I typed, so that I correct or
remove it like any other.

- AC-2.1 Given an automatic entry, then it appears in My hours in both views: in the table view's
  cell for its meeting and day, and as a row of the List (D54).
- AC-2.2 Given an automatic entry, then it counts in every total, filter result and export like an
  entry typed by hand — Everyone's hours and the deal's figures included (D54).
- AC-2.3 Given an automatic entry, then wherever entries are listed one by one (the List, the
  entries of a table view cell, Everyone's hours) it is marked "From meeting" ("Da riunione" in
  Italian); the mark stays after the person changes the entry (D57, D60, D62).
- AC-2.4 Given an automatic entry, when its person changes its day, duration, note or what it is
  recorded on, then the change is saved under specs/20261112-time-tracking's rules, and a change those rules refuse
  saves nothing (specs/20261112-time-tracking AC-1.5).
- AC-2.5 Given an automatic entry, when its person deletes it, then it is never recorded again for
  them on that meeting, whatever later happens to the meeting (D55).
- AC-2.6 Given a new automatic entry, then no notification is sent; the person sees it in My hours
  (A26).
- AC-2.7 Given an automatic entry, when its person asks to delete it, then the confirmation also
  says that Operai will not record it again from its meeting and that they can still record hours
  themselves; the confirmation of an entry typed by hand is unchanged (D61).

### US-3 An untouched entry follows its meeting
As an employee, I want an entry I have not touched to stay true to its meeting, so that a meeting
that is moved, corrected or deleted does not leave wrong hours behind.

- AC-3.1 Given an untouched automatic entry, when the meeting's date-time changes, then the entry's
  day becomes the meeting's new day (D56).
- AC-3.2 Given an untouched automatic entry, when the meeting's duration changes, then the entry's
  duration becomes the new duration rounded as in AC-1.1 (D56).
- AC-3.3 Given an untouched automatic entry, when its person is removed from the meeting's
  participants (and is not its creator), then the entry is removed (D56).
- AC-3.4 Given untouched automatic entries, when their meeting is deleted, then they are removed
  (D56).
- AC-3.5 Given an automatic entry its person has changed (AC-2.4), when its meeting's date-time or
  duration changes, then the entry does not change (D56).
- AC-3.6 Given an automatic entry its person has changed (AC-2.4), when the person is removed from
  the meeting or the meeting is deleted, then the entry stays; on a deleted meeting it is shown
  without the meeting's title (D56, A18).
- AC-3.7 Given a person added to the meeting's participants after its duration is known, then they
  get an automatic entry as in AC-1.1, unless AC-1.4 or AC-2.5 applies to them (A24).

### US-4 Privacy and availability
As a meeting participant, I want automatic entries to reveal nothing new about meetings, so that
the Meetings visibility rules still hold.

- AC-4.1 Given an automatic entry, then it carries only what any entry on a meeting carries — the
  meeting, its day and its duration, with an empty note; no transcript, summary or other content
  of the meeting is copied into it (ADR 20261104-meetings-tool-shape-visibility-by-participation posture, A41).
- AC-4.2 Given Meetings cannot be reached when a meeting's duration becomes known or the meeting
  changes, then My hours still loads with the person's entries, and the automatic entries are
  recorded or brought up to date once Meetings can be reached; none is lost or recorded twice
  (A40).
- AC-4.3 Given any new copy (the "From meeting" mark included), then it exists in English and
  Italian, and durations use the library formatters.

## Non-goals

- **Suggesting and confirming** a meeting's hours — superseded by automatic entries (D54).
- **Automatic entries from CRM call or meeting activities** — they have no duration (D17).
- **Automatic entries from calendars** (Google Calendar or any other) or from any source other than
  Meetings.
- **Asking for a duration** on a typed or pasted meeting so that it records hours (A4).
- **Automatic entries for meetings that started before the release** (A19).
- **Entries for external participants** — they have no Operai account.
- **Whether a meeting linked to a project counts its hours for that project** (specs/20261104-meetings A18,
  2026-11-23): an automatic entry is on the meeting, like a hand-made one; how a project counts
  meeting hours is **specs/20261112-project-hours**'.
- **Bulk actions** on automatic entries (delete all, undo all).
- **Notifications** about automatic entries (A26).
- **Start and end times** — specs/20261112-time-tracking records a day and a duration only (D8).

## Constraints

- None given by the user.

## Assumptions (strike any that is wrong)

From the ledger:
- A4 A meeting's duration is rounded to the nearest 30 minutes; no duration, no automatic entry.
- A17 No automatic entry for a person who already has an entry on the meeting when its duration
  becomes known.
- A18 A changed automatic entry stays when its meeting is deleted or its person removed, shown
  without the meeting's title on a deleted meeting.
- A19 Only meetings that start on or after the release day record hours.
- A24 A person added to a meeting after its duration is known gets an automatic entry.
- A26 No notification for a new automatic entry.

Added on re-opening (2026-11-24, not grilled — review them):
- A35 The meeting's day is the calendar day of its start in Europe/Zurich (the zone of both
  entities).
- A36 Rounding: a half step rounds up (45 minutes → 1 h, 1 h 15 → 1 h 30); never below 30 minutes
  (15 minutes → 30) and never above 24 hours.
- A37 A meeting whose day is after today records nothing until that day (specs/20261112-time-tracking AC-1.3); an
  untouched entry whose meeting moves to a later day than today is removed until then.
- A38 Only Operai participants whose account is active get an automatic entry.
- A39 "Changed" (untouched no more) means any saved change of day, duration, note or what the entry
  is recorded on; reading it, or the meeting being relinked to another deal, is not a change.
- A40 When Meetings cannot be reached, automatic entries are late, never lost or doubled.
- A41 An automatic entry's note is empty (the meeting's title already names it; copying the title or
  anything else into the note would freeze it there).

## Open questions

- [ ] Labour-law check before go-live (ledger O3, carried from specs/20261112-time-tracking): automatic entries record
  hours about a person without the person acting, which widens what informing employees must
  cover (IT: art. 4 L. 300/1970; CH: art. 26 OLL 3) — owner: management / HR. A go-live sign-off,
  not a blocker of the plan. **Accepted as risk by the owner at approval, 2026-11-24.**
