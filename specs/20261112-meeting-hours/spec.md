---
id: 20261112
slug: meeting-hours
status: done
rigor: production
created: 2026-11-12
reopened: 2026-11-24
approved: 2026-11-24
done: 2026-11-25
depends-on: 20261104-meetings, 20261112-time-tracking, 20261116-record-hours-in-place
---

# Meeting hours — the hours of a meeting recorded automatically for the people who took part

Decision ledger: `../20261112-time-tracking/ledger.md` (shared with specs/20261112-time-tracking, specs/20261112-project-hours and
specs/20261112-project-alerts; this spec's decisions are D7, D17 as superseded by D54, D54–D62, and D63–D76 added after the
security review — D64, D65, D66 and D72 were withdrawn the same day by D74, D75 and D76; and D77 after the PR #12 review)

> **Origin.** Split out of specs/20261112-time-tracking on 2026-11-12 (ledger D26) and approved the same day as
> *suggested* entries each person confirmed (D17). **Re-opened on 2026-11-24** before any plan: the
> owner decided that a meeting's hours are recorded **automatically** when it ends, with no
> suggestion and no confirmation (D54). Every rule of specs/20261112-time-tracking about time entries holds
> for an automatic entry; the one it bends is who creates it (Operai, not the person — D14 narrowed,
> see US-1). Amended the same day after /wellforge:design: AC-2.3 names Everyone's hours and the
> Italian mark, AC-2.7 is new (ledger D60–D62).
>
> **Amended 2026-11-24 after the security review** (`owasp-report.md`, verdict PASS): the owner added to the scope five
> hardenings the review had proposed as optional (ledger D63–D72), and **withdrew three of them completely the same day**
> (D74–D76, owner's choice "A"), accepting the review's notes on them as risk. What stands (ledger D63, D67–D71): a
> meeting's duration corrected to the measured length of its audio when it is materially wrong (AC-3.8–AC-3.10, D63; review
> L1), and the "From meeting" mark shown only while an entry is recorded on a meeting (**AC-2.3 changed**, D67; I8, design
> G6), which reverses "the mark stays after the person changes the entry" of D57 and D62. What was withdrawn, so that no
> acceptance criterion or assumption remains for it: the record of a refused but correctly signed service credential (I1,
> D64 and D72, withdrawn by D74), the refusal for good of a notice with a malformed identifier (I3, D65, withdrawn by D75),
> and the dropping of the records of who deleted or already had an entry when a meeting is deleted (I6, D66, withdrawn by
> D76); each is now a non-goal. Every other acceptance criterion is unchanged.
>
> **Amended 2026-11-25 after the PR #12 review** (a drift correction, no change of scope or behaviour; ledger D77): the
> non-goal "A history of where a moved entry came from" said that once an entry is recorded on something else nothing on it
> shows it was ever automatic. The build does not do that: hours-ui shows no mark on an entry recorded on a project, a deal
> or other work (AC-2.3), but the entry's `origin` stays `meeting`, reaches every viewer, and still decides the delete
> confirmation's sentence (AC-2.7, D70). The owner reworded the non-goal to say so, rather than change what the API sends,
> and the security review had accepted that residual (`owasp-report.md` I8, N3). No acceptance criterion changed.

## Problem

A meeting recorded or uploaded in Meetings already knows when it happened, how long it lasted and
which colleagues took part, yet each of them has to type the same hours again in My hours — or
forget to. Meetings are the most frequent and most often forgotten part of the working day, so the
hours spent in them are the ones most likely to go missing from every total built on them.

## Domain language

- **automatic entry** — a time entry Operai records for a person on a Meetings meeting they
  created or took part in, with the meeting's day and its duration rounded to 30 minutes. It is
  the person's own time entry (specs/20261112-time-tracking) from the moment it exists and counts like any other. It stays an
  automatic entry when its person records it on something else (A47).
  _Avoid:_ suggested entry (the superseded design), proposal (ProposAI's word), draft entry.
- **untouched** — an automatic entry its person has not changed since Operai recorded it. Only an
  untouched entry follows its meeting (D56).
- **held duration** / **measured duration** — the held duration is the one a meeting has before Operai processes its audio:
  a recording's sum of the pieces its browser reported, or an uploaded file's own claim. The measured duration is the length
  of the audio Operai itself decodes when it processes a recorded or uploaded meeting (review L1). _Avoid:_ real length,
  actual duration.
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
- AC-2.3 **(changed after the security review)** Given an automatic entry, then wherever entries are listed one by one (the
  List, the entries of a table view cell, Everyone's hours) it is marked "From meeting" ("Da riunione" in Italian) exactly
  while it is recorded on a meeting — one whose meeting has since been deleted included. So changing its day, duration or
  note leaves the mark; recording it on a project, a deal or other work removes it, in My hours and in Everyone's hours
  alike; and recording it on a meeting again brings it back (D57 as narrowed, D60, D62, D67, A47).
  _Before the review it read: "the mark stays after the person changes the entry"._
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
- AC-3.8 **(added after the security review)** Given a recorded or uploaded meeting that holds a duration, when Operai
  processes its audio and its measured duration differs from the held duration by more than the larger of 30 seconds and
  10 % of the held duration, then the meeting's duration becomes the measured one, so that Meetings shows the measured
  duration wherever it shows the meeting's duration (D63, A42, A43).
- AC-3.9 **(added)** Given a meeting whose duration became the measured one under AC-3.8, then an untouched automatic entry
  takes it, rounded as in AC-1.1, and an automatic entry its person has changed does not change (AC-3.2, AC-3.5, D63).
- AC-3.10 **(added)** Given the same meeting, when the measured duration is within that margin of the held one, or when its
  audio cannot be measured because processing fails, then the meeting's duration and its automatic entries stay as they
  are, even when the measured duration would round to another 30-minute step. An uploaded file whose audio proves longer
  than 3 hours is refused under specs/20261104-meetings AC-3.2 and loses its duration then, as it does today (D63, A42).

### US-4 Privacy and availability
As a meeting participant, I want automatic entries to reveal nothing new about meetings, so that the Meetings visibility
rules still hold.

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
- **Checking who took part in a meeting, or when it started**, against anything: the day of an entry and who gets one stay
  what the meeting's creator set, a trust the owner accepted (AC-1.7); the review's L1 closes only the duration.
- **Measuring audio that cannot be read at all**, or removing hours because of it: its reported duration and the entries
  built on it stay (AC-3.10; decided by D69).
- **Removing an entry its person changed when its meeting is deleted**: it is the person's own entry from then on, and
  AC-3.6 stays (D56).
- **A history of where a moved entry came from**: no log of what it was recorded on before is kept or shown, and once it is
  recorded on a project, a deal or other work no "From meeting" mark shows on it (AC-2.3). It stays an automatic entry:
  `origin` stays `meeting` and is never rewritten, the API still carries it for every viewer, a holder of see everyone's
  hours included (review I8 and N3, accepted), and on such an entry it drives only the delete confirmation's sentence
  (AC-2.7, D70, D77).
- **Telling anyone that a meeting's duration was corrected**: no notification, no earlier figure shown (A26, A43).
- **Recording a correctly signed service credential that is refused for its service or its permission** (review I1,
  accepted as risk by the owner, D74): the sender already shows the refusal, and a record in the shared credential check
  would change six services, four of them unrelated to this feature.
- **Restricting the characters of the identifiers on a meeting notice** (review I3, accepted as risk by the owner, D75):
  Operai itself makes every one of them, and a real identifier outside the set would refuse a whole meeting's hours for
  good.
- **Removing the records of who deleted their automatic entry or already had an entry when a meeting is deleted** (review
  I6, accepted as risk by the owner, D76): nothing reads them again once the meeting is gone, they hold no more than two
  identifiers and a reason, and clearing them would cost a migration and race risks.
- **The review's other findings** (I2, I4, I5, I7): the review found no change required.

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
- A39 "Changed" (untouched no more) means any edit its person saves, whether or not the values end up different:
  saving the entry again with the values it already holds counts too. Whether the values differ is deliberately not
  compared: a person who sets a value back to what Operai wrote has still made a choice, and the ADR rejects "value
  comparison for untouched" (ADR 20261124-a-system-written-time-entry-follows-its-source-fact-only-…). Reading the
  entry, or the meeting being relinked to another deal, is not a change. My hours' entry dialog sends only what the
  person changed and sends nothing when nothing changed, so only a direct API caller can save an edit that changes
  nothing. This is how the build behaves.
- A40 When Meetings cannot be reached, automatic entries are late, never lost or doubled.
- A41 An automatic entry's note is empty (the meeting's title already names it; copying the title or
  anything else into the note would freeze it there).

Added after the security review (2026-11-24, not grilled — review them):
- A42 "Materially" (AC-3.8, AC-3.10): the measured duration differs from the held duration by more than the larger of
  30 seconds and 10 % of the held duration, shorter or longer. A smaller gap is the ordinary difference between a browser's
  timer, a file's own header and the decoded audio, and is left alone so that entries are not resized by noise. A meeting
  that holds no duration takes the measured one, as AC-1.1 says. The margin is the review's suggestion (L1).
- A43 Where Meetings shows a duration (AC-3.8): in one place today, the Duration line of a meeting's details, which shows
  the duration the meeting holds once it is known; after a correction it shows the measured one, with no mention of the
  earlier figure and no notice (A26). The recorder's running time and the saved time of an interrupted recording are other
  figures and do not change. Read from specs/20261104-meetings (its design lists Duration among a meeting's details; no
  acceptance criterion of its spec says how the duration is set) and from the meeting's details screen. Whether this
  amends specs/20261104-meetings was decided: it does not (D68).
- A47 An automatic entry stays its person's one automatic entry for its meeting when they record it on a project, a deal or
  other work, or on another meeting: Operai records no second one for that meeting, and deleting it still means Operai will
  not record it again, so AC-2.7's confirmation still applies to it. Only the mark follows what the entry is recorded on
  now: an entry moved to another meeting keeps it (it is on a meeting), one moved to a project, a deal or other work loses
  it, and recording it on a meeting again brings it back. This is how the build behaves today; the mark's change makes it
  visible.

## Open questions

- [ ] Labour-law check before go-live (ledger O3, carried from specs/20261112-time-tracking): automatic entries record
  hours about a person without the person acting, which widens what informing employees must
  cover (IT: art. 4 L. 300/1970; CH: art. 26 OLL 3) — owner: management / HR. A go-live sign-off,
  not a blocker of the plan. **Accepted as risk by the owner at approval, 2026-11-24.**
- [x] Does AC-3.8 amend specs/20261104-meetings? It changes a fact Meetings owns, a meeting's duration, after processing.
  That spec names no rule for how the duration is set and its design lists Duration among the details, but its tasks say
  processing keeps the sum of the stored chunk durations, which stays true until the audio is measured. If yes, that spec
  gets the line and AC-3.8's last clause moves there; if no, it stays here — owner: owner, with the Meetings spec.
  **Decided 2026-11-24 (D68): it stays here; specs/20261104-meetings is not amended.**
- [x] Audio Operai cannot read at all (processing fails) is never measured, so its reported duration and the entries built
  on it stay (AC-3.10) — the case the review's forged-pieces example reaches. Keep (an honest recording lost to a glitch
  keeps its hours, and a person can delete an entry) or remove the untouched entries? Recommended: keep — owner: owner.
  **Decided 2026-11-24 (D69): keep.**
- [x] AC-2.7's confirmation, for an entry its person recorded on a project, a deal or other work, still says Operai will not
  record it again from its meeting (A47) although the mark is gone. Keep or hide? Recommended: keep — it is true, and the
  deletion still has that effect — owner: owner. **Decided 2026-11-24 (D70): keep.**
- [x] Size: with the additions the spec has 28 acceptance criteria (25 before), and the two hardenings that remain (the
  measured duration and the mark) can ship apart from the feature and from each other. One spec, or split? — owner: owner,
  at the gate. **Decided 2026-11-24: one spec — the owner added them here; the three withdrawn by D74–D76 brought it from
  34 to 28.**
