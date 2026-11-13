---
id: 029
slug: time-tracking
status: approved
rigor: production
created: 2026-11-12
approved: 2026-11-12
depends-on: 017, 021, 025, 028
---

# Time tracking — the hours employees spend on company work

Decision ledger: `ledger.md`

> **Origin.** Requested and grilled on 2026-11-12 (ledger D1–D26). Time tracking was left out
> on purpose by specs/025 (D27), specs/027 and specs/028. The work is split in four specs
> (D11, D26, D34): **this one** records time entries and shows them to the people they concern;
> **specs/030** compares a project's hours with what was sold and shows hours on the project and
> deal pages (D22), after PR #9 (specs/026, project terms and purchase order) is merged;
> **specs/031** suggests hours from the meetings a person took part in (D17); **specs/032** turns
> the moments that need a decision into tasks (D12).

## Problem

Nobody at wellD can tell where employees' working time goes: how long a project, a deal or a
meeting took, or how much went into training, talks and administration. What Operai records
today — CRM activities, project tasks, meetings — says that something happened, never how long
it took or who spent the time. Without that record, a maintenance package or a fixed-price
estimate cannot be checked against the hours actually worked, a time-and-material month cannot
be backed by a timesheet, and the pre-sales effort spent on a deal is unknown.

## Domain language

- **time entry** — one person's own declaration that they spent a duration, on one day, on one
  thing: a project, a deal, a meeting, or work that is not an entity in Operai. It is not an
  activity (specs/028) but may point at one; one activity may have many time entries (D6).
- **category** — what a time entry on no entity is about (training, talk preparation,
  administration, …), chosen from a list an admin manages (D18).
- **work type** — the kind of work an entry on a project or a deal was (development, analysis,
  estimate, …), optional, from one of two lists an admin manages: one for projects, one for
  deals (D19, D20).
- **contractual day** — 8 h 24 min, from 42 hours a week, Monday to Friday (D3). Nothing in
  this spec checks a day against it (D23).
- **see everyone's hours** — the permission to read every person's time entries (D21).

## User stories

### US-1 Record my hours
As an employee, I want to record how long I worked on what, each day, so that my working time
is known without anyone else declaring it for me.

- AC-1.1 Given any active Operai user, when they record a time entry with a day, a duration and
  what it was on (US-2), then it is saved as theirs and appears in their hours view (A2).
- AC-1.2 Given a duration that is not a whole number of 30-minute steps, is under 30 minutes or
  is over 24 hours, when the entry is saved, then it is refused and nothing is saved (D8, A9).
- AC-1.3 Given a day after today, when the entry is saved, then it is refused (A10).
- AC-1.4 Given one person's entries on one day that together exceed the contractual day — for
  example 2 h on an internal project and 2 h on a client project for the same two hours — when
  they are saved, then all are accepted, and each counts in full on what it was booked on
  (D3, D4, A1).
- AC-1.5 Given a person's own entry, when they change any of its values or delete it, then the
  change is saved, however old the entry is (D24).
- AC-1.6 Given someone else's entry, when any user — an admin or a holder of see everyone's
  hours included — tries to create it on that person's behalf, change it or delete it, then it
  is refused and nothing changes (D14).
- AC-1.7 Given an entry with a note of more than 1000 characters, when it is saved, then it is
  refused; a shorter note, or none, is accepted (A16).
- AC-1.8 Given an entry, then it records a day and a duration only, never a start or an end
  time (D8).

### US-2 What hours are recorded on
As an employee, I want to record hours on the project, deal or meeting I worked on, or on work
that is not in Operai, so that every hour I worked has a place.

- AC-2.1 Given a time entry, then it is on exactly one of: a project, a deal, a meeting, or no
  entity. An entry on no entity must have a category; an entry on a project, a deal or a
  meeting has none. Any other combination is refused (D18).
- AC-2.2 Given a project, when a person records an entry on it or moves an entry to it, then it is
  accepted only if, at that moment, the person is the project's project manager or a member of its
  team; otherwise it is refused and nothing changes (D16, A3, D46). The project may be in any state
  (A12).
- AC-2.3 Given a deal, when a person records an entry on it or moves an entry to it, then it is
  accepted only if, at that moment, the person is the deal's owner, its technical contact, or the
  assignee or a participant of one of its activities; otherwise it is refused and nothing changes
  (D16, A3, D46). The deal may be in any stage, won and lost included (A13).
- AC-2.4 Given a person who leaves a project's team, or stops being involved in a deal, then the
  entries they recorded there stay unchanged and keep counting on that project or deal (A3).
- AC-2.5 Given a Meetings meeting, when its creator or one of its Operai participants records an
  entry on it, then it is accepted; anyone else is refused (A6).
- AC-2.6 Given a meeting linked to a deal, then the hours recorded on the meeting count for that
  deal, without AC-2.3's check; when the meeting is relinked to another deal, they count for the
  new deal and no longer for the old one (A6).
- AC-2.7 Given an entry on a project or a deal, then it may point at one activity about that same
  project or deal that the person can read — a task of the project, or a pre-sales activity of
  the deal; pointing at any other activity is refused (A14).
- AC-2.8 Given one activity, then any number of entries, by any number of people on any number of
  days, may point at it (D6).
- AC-2.9 Given an activity that time entries point at, when it is deleted, then the entries stay
  on their project or deal, without the pointer (A22).
- AC-2.10 Given a project, deal or meeting the person cannot read, then the answer is the same as
  for one that does not exist (ADR-0005, ADR-0058, ADR-0081 posture).
- AC-2.11 Given the tool that owns a project, deal or meeting cannot confirm whether the person
  may record on it, when the entry is saved, then it is refused as unavailable and nothing
  changes (A21, fail closed).
- AC-2.12 Given a person's own entry on a project, deal or meeting they are no longer on, no
  longer involved in, or can no longer read, when they change its day, duration, note or work
  type and leave it on the same project, deal or meeting, then the change is saved without the
  checks of AC-2.2, AC-2.3 and AC-2.5; a new activity pointer is still checked as AC-2.7 says,
  and moving the entry elsewhere is checked like a new entry (D46). *(Added 2026-11-13 during
  design.)*

### US-3 Categories and work types
As an admin, I want to manage the categories and work types people pick from, so that hours are
grouped consistently without a release.

- AC-3.1 Given a holder of the permission to manage the lists (held by default by the `admin` role
  only), then they can create, rename, retire and restore a category, and likewise a work type in
  each of the two lists (projects, deals) (D18, D20, A8). *(Restore added 2026-11-12 during
  design, D38; wording aligned with AC-3.3, D41.)*
- AC-3.2 Given a category or a work type, then nobody, admins included, can delete it.
- AC-3.3 Given a user without the permission to manage the lists, when they try to create, rename,
  retire or restore a category or a work type, then it is refused and nothing changes. The lists
  are managed from the Admin tool, so a role granted that permission also needs access to Admin
  to reach the screen. *(Wording amended 2026-11-12 during design, D41.)*
- AC-3.4 Given a retired category or work type, then it is no longer offered for a new entry or a
  change, and the entries that already have it keep it and show it.
- AC-3.5 Given an entry on a project, then its work type is optional and, when given, comes from
  the projects list; on a deal, from the deals list; an entry on a meeting or on no entity
  carries no work type. Anything else is refused (D20, A8).
- AC-3.6 Given a category marked as requiring a note, when an entry with it has no note, then it
  is refused (A7).
- AC-3.7 Given a new installation, then the lists start as: categories Training, Talk
  preparation, Administration, Other (Other requires a note); project work types Development,
  Analysis, Project management, Support; deal work types Analysis, Estimate, Demo, Offer (A15).
- AC-3.8 Given a category or work type name, then it is shown exactly as the admin typed it, in
  both languages (A16).

### US-4 My hours and everyone's hours
As an employee, I want to see my hours, and as a manager everyone's, so that recorded time is
visible to whom it concerns and to no one else.

- AC-4.1 Given a person, then their hours view lists their entries by day, with each day's total;
  no day is marked incomplete and no reminder is sent (D23).
- AC-4.2 Given a person without see everyone's hours, then they see only their own entries, and a
  request for anyone else's is refused (D9).
- AC-4.3 Given a holder of see everyone's hours, then they see every person's entries, from both
  entities (D21).
- AC-4.4 Given the hours view, then it filters by period, person (for a holder of see everyone's
  hours), project, deal, category and work type, and the list and its totals show only the
  entries that match (D25).
- AC-4.5 Given the hours view, then it shows totals grouped, at the viewer's choice, by person,
  project, deal, category or month; the hours of a meeting linked to a deal are counted under
  that deal (D25, A6).
- AC-4.6 Given a filtered view, when the viewer exports it, then they get a spreadsheet file with
  exactly the entries the view shows, each with its day, person, duration, what it was on,
  category or work type, the activity it points at and its note (D25, A11); the duration is a
  number of hours with decimals (2 h 30 is 2.5), so the file can be summed (D39), and an entry on
  a meeting linked to a deal also carries that deal, so the file summed by deal matches the
  by-deal totals of AC-4.5 (D40). *(Duration and deal columns added 2026-11-12 during design.)*
- AC-4.7 Given an entry whose project, deal, meeting or activity cannot be resolved because the
  owning tool does not answer, then the entry is still listed and counted, with its name shown
  as unknown (A21).
- AC-4.8 Given a person whose Operai name changes, then the hours view shows the new name on all
  their entries (ADR-0039 posture).
- AC-4.9 Given a duration on screen, then it is shown as hours and minutes (for example "2 h 30");
  the exported file uses decimal hours instead (AC-4.6, D39).
- AC-4.10 Given any viewer — the entry's own author included — who cannot read an entry's project,
  deal or meeting, or the deal a meeting is linked to, then the entry is listed, counted and
  exported with its type, but without the name of that project, deal or meeting and without the
  subject of the activity it points at (ADR-0058, ADR-0081 posture). *(Added 2026-11-12 during
  planning, approved by the owner; widened from holders of see everyone's hours to every viewer
  during design, D43.)*
- AC-4.11 Given a view filtered by a deal, when Meetings cannot say which meetings are linked to
  that deal, then the view is refused as unavailable and nothing partial is shown; pages already
  shown before a later page fails stay, with the error below them (D48); without a deal filter the
  view still answers as AC-4.7 says (D45). *(Added 2026-11-12 during design; D48 2026-11-13.)*

### US-5 Access and copy
As an admin, I want time tracking to follow the suite's permission rules, so that hours are
recorded by everyone and read only by whom they concern.

- AC-5.1 Given any active Operai user, whatever tools they can open, then they can record and see
  their own hours (A2).
- AC-5.2 Given the suite's permissions, then a new permission, see everyone's hours, exists,
  unconditioned, held by default by the `admin` role only; an admin can grant it to other roles
  (D21).
- AC-5.3 Given a request without a valid session, then it is refused.
- AC-5.4 Given an `auth` outage, when a request needs see everyone's hours, then it is refused as
  unavailable, never allowed (ADR-0014 posture).
- AC-5.5 Given any new screen, then all its copy exists in English and Italian, and dates and
  durations use the library formatters.

## Non-goals

- **Start and end times** of an entry, or a timer — a later spec may add an optional time (D8).
- **Absences** (holidays, sickness, permits) and anything that checks a day against the
  contractual day: no "incomplete day" mark, no reminder, no contractual hours per person
  (D2, D23).
- **Recording, changing or deleting hours for someone else**, admins included (D14).
- **Locking or approving hours** — open as O4 (D24).
- **Comparing hours with what was sold** (hour packages, max effort, estimated man-days, T&M
  positions) and the **hours on the project and deal pages** (D22): **specs/030**; the
  **proactive alerts** of D12: **specs/032**.
- **Hours suggested from meetings** (D17): **specs/031**. In this spec a meeting's hours are
  recorded by hand (AC-2.5).
- **T&M positions or estimate activities on an entry** (D13).
- **Money**: rates, costs, invoicing, anything sent to Bexio (specs/025 D14).
- **Charts and dashboards** (D25).
- **Any automatic tracking** of what people do: every entry is declared by its person.

## Constraints

- None given by the user. Where time entries are stored — a new service or `activities-api` —
  is left to the plan (ledger D6).

## Assumptions (from the ledger — strike any that is wrong)

- A1 Overlapping hours count in full on each thing they are booked on.
- A2 Every active Operai user can record their own hours, whatever tools they can open.
- A3 Team membership and deal involvement are checked when an entry is created or moved to a
  project or deal; entries already recorded stay, and stay correctable by their author, when they
  end (narrowed 2026-11-13, D46).
- A6 A meeting's creator and Operai participants may book on it; a linked meeting's hours count
  for its deal without the involvement check and follow it when relinked.
- A7 A category can require a note; the initial "Other" does.
- A8 Both work-type lists are managed like the categories; meeting and no-entity entries carry no
  work type.
- A9 One entry is 30 minutes to 24 hours; a day has no total cap.
- A10 No entry on a future day.
- A11 The export holds exactly the entries the view shows.
- A12 A project in any state takes entries.
- A13 A deal in any stage takes entries.
- A14 An entry points only at a readable activity of its own project or deal.
- A15 The initial lists of AC-3.5.
- A16 A note is at most 1000 characters; list names are one text, shown as typed in both languages.
- A21 An access check the owning tool cannot answer refuses the write; reads still list the entry
  with an unknown name.
- A22 Deleting an activity removes the pointer, never the entries.

(A4, A5 and A17–A19 belong to specs/031; A20 to specs/030.)

## Open questions

**Accepted as risk at approval (2026-11-12):** the owner approved this spec with O3 and O4 open
and chose not to address them here ("ignora punti aperti 3 e 4").

- O3 Labour-law check before go-live: informing employees about the hours recorded and who reads
  them (IT: art. 4 L. 300/1970; CH: art. 26 OLL 3) — owner: management / HR.
- O4 A lock or approval of recorded hours before they are used to bill T&M on a timesheet —
  owner: product owner, at the latest with specs/030 or a billing export.
- O1 and O2 (man-day ↔ hours, yearly package carry-over) are specs/030's.
