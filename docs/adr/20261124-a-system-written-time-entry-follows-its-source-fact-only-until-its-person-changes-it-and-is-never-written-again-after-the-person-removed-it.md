# 20261124 — A time entry the system writes follows its source fact only until its person changes it, and is never written again once its person removed it

**Date:** 2026-11-24  
**Status:** Accepted (decided by the owner, 2026-11-24; narrows specs/20261112-time-tracking D14 by specs/20261112-meeting-hours D54–D56)  
**Deciders:** Owner of the Operai suite (wellD)  
**Project:** Operai

---

## Context

A time entry in hours-api is one person's own declaration of their hours, with a single writer: the person
(ADR 20261112-hours-api-time-entries-own-service-hours-catalog, no `If-Match`). The owner now wants the
hours of a Meetings meeting recorded automatically for its creator and Operai participants, as the same
kind of entry (specs/20261112-meeting-hours US-1, D54). That adds a second writer, the system, to a record
whose meaning is "what this person says they did". The system's copy must follow the meeting when it moves
or is resized (D56), yet never overwrite a value the person chose, and never come back once the person
deleted it (D55). Meetings is the sensitive source (recorded conversations); its facts cross into hours-api
as attendance only (who, when, how long), with no title or content.

## Decision

We will let Operai write a person's time entry only from a fact its owner states (meetings-api's hours
facts, pushed as a versioned state, ADR-candidate of specs/20261112-meeting-hours D-P1), only for the people
that fact names, and only on that meeting. Such an entry carries `origin = meeting`, `sourceMeetingId` and
`followsMeeting = true`. It follows the fact only while `followsMeeting` is true: any successful PATCH by the
person clears it, and every system update or delete is guarded by `AND "followsMeeting"`. A
`meeting_hours_block` row (`had_entry` or `deleted`) is written in the same transaction as the person's own
DELETE of an automatic entry, and the system never inserts an entry for a person whose block exists or who
already holds another entry on that meeting. A partial unique index allows one automatic entry per
(`userId`, `sourceMeetingId`), ever. No user, administrator or `time-entry:read-all` holder gains a write on
someone else's entry.

## Failure shape

**What class of mistake does this prevent, stated so it's recognisable somewhere we haven't been yet?**
A record that a person owns is changed or recreated by an automated writer that acts on a copy of a
source fact, after the person has made a choice the automation cannot see. The person's decision is
silently undone (overwritten, resurrected, or re-added after deletion), or the system acts on a
stale picture of the source and nobody can tell which side last spoke. The shape is a *second writer of a
human-owned record*: the automation must be able to tell "still mine to follow" from "the person's now",
and that answer must be durable, not re-derived by comparing values.

Where else it appears (the symmetric cases, which are the ones that get missed):
- **Update and delete are the same shape.** A system delete of a record the person edited is as wrong as
  a system overwrite. Guard both writes with the same "still system-owned" condition.
- **Resurrection after the person's delete.** Any path that recreates a record the person removed (a
  re-added participant, a re-sent notice, a backfill, a retry of an old job) repeats the defect. A
  removal by the person and a removal caused by the source are different events and leave different
  traces.
- **Comparing values to decide ownership.** A person who sets a value back to what the system wrote is
  still a person's choice. Anything that reads "same as the source" as "untouched" has this shape.
- **Inbound and outbound.** The source's facts arrive out of order, repeated, or stale; the system must
  apply only the newest version, and a repeat must be harmless. The same applies to any copy kept by
  messages.
- **Read side and write side.** Seeing another person's automatic entry, or a list that includes it, must
  not confer the right to change it; a read-all or admin role is a reader, never a writer of it.
- **Any new automatic writer** (a calendar import, a CRM activity, a future host) that writes into a
  person's own record: ask first whether the person can change it, whether a person's delete will be
  respected, and whether the writer can tell "still mine" from "theirs now".

## Options considered

### Option A — Versioned source facts, a `followsMeeting` flag, and a block row written with the person's delete (chosen)
The system writes with a flag that the person's PATCH clears; system writes are guarded by it, and the
person's DELETE of an automatic entry writes a `meeting_hours_block` in the same transaction.

**Pros:** ownership is a stored fact, so no comparison is needed; a concurrent PATCH is handled by the
guarded `UPDATE`/`DELETE` (CAS) without `If-Match`; the block commits with the delete, so an apply that
runs afterwards sees one of the two states; the entry stays an ordinary `time_entry` row, so every list,
total, export and deal figure counts it unchanged.
**Cons:** hours-api gains a second writer and a `followsMeeting` shape CHECK; a removal caused by the source
leaves no block, so a re-added person gets an entry again (accepted: AC-3.7); the person's PATCH must clear
the flag in the same statement as the change.

### Option B — Compare current values with the source to decide "untouched"
An automatic entry is followed while its day and minutes still equal what Operai wrote.

**Rejected.** A person who sets the same duration back would be followed again, and a later meeting change
would overwrite a deliberate confirmation. "Same value" is not "same decision".

### Option C — A soft-deleted `time_entry` row as the tombstone for a deleted automatic entry
The person's delete sets a `deleted_at` column; the system checks for that row before recreating.

**Rejected.** Every reader of `time_entry` (lists, totals, export, oversight, deal figures) would have to skip
tombstones, and one missed filter would count a deleted entry. The block lives in its own table, so readers
never see it.

### Option D — Recreate an automatic entry after a delete while the person has no entry on the meeting
A deleted automatic entry comes back on the next notice, as long as the person has no entry on the meeting.

**Rejected** (ledger D55, "never recorded again"). The person's deliberate delete would be undone by the
next meeting edit, which is the defect of the failure shape above.

### Option E — A suggestion each participant confirms (the superseded design)
Kept for the record: suggestions appeared in My hours and each person confirmed them (ledger D17, superseded by
D54). It avoids a system writer entirely, but the owner chose automatic entries so that forgotten hours are
not lost.

**Pros:** no second writer on a person's record.
**Cons:** the forgotten hours stay forgotten; a confirmation is one more action per meeting.

## Consequences

**Positive:**
- A person's change to an automatic entry is final: no later meeting change overwrites it (AC-3.5).
- A person's delete is final: the system never recreates the entry on that meeting (AC-2.5).
- Totals, exports, lists and deal figures need no change: automatic entries are rows like any other.
- Concurrent PATCH and system apply are resolved by the guarded write, with no version precondition on
  the person's entries.

**Negative / trade-offs:**
- hours-api now has a system writer and must keep three guards in step: the `followsMeeting` clear in every
  PATCH path, the `AND "followsMeeting"` on every system write, and the block insert in every DELETE path of
  an automatic entry. A new writer path to `time_entry` must repeat all three or be reviewed against this ADR.
- The entry's "From meeting" mark persists after the person changes it (D57), so `origin` must never be
  recomputed from the current values.
- A removal caused by the source leaves no block. A participant removed and re-added gets a fresh automatic
  entry, which the person may have wanted to keep deleted. Accepted for the meeting's own truth.

**Risks:**
- **Liveness is not re-checked when hours are written** (D-P3, ledger D58): a person deactivated between being
  added to a meeting and its end gets an entry that only read-all holders see. Mitigation: liveness is enforced
  where participants are added in meetings-api, and the entry is removable by the person.
- **Labour-law go-live sign-off (spec O3, accepted as risk).** Automatic recording of hours about a person is a
  labour-law matter. Management / HR must approve before go-live; informing employees is part of that sign-off.
  Until it is given, the feature is not released.
- **A forged duration** is capped by the stored recording chunks and the 24 h entry cap; a meeting creator can
  add colleagues as participants, who then receive entries (the trust Meetings already places in the creator).
  Each person can delete theirs.

## Compliance notes

- GDPR / data-protection impact: **medium** — attendance (who took part, on which day, for how long) about
  identifiable employees crosses from meetings-api to hours-api. No title, transcript, summary or external
  participant is sent (AC-4.1). hours-api stores only the entry it already holds and `meeting_hours_block`
  (meeting id, user id, reason). Logs carry no user id.
- Data residency: compliant with required jurisdiction (both services on EU Railway; no new external host).
- Audit trail: not required by this ADR. Labour-law go-live sign-off (spec O3) is required before release.

## Amendment — 2026-11-24: the mark follows the entry's target, and the duration risk is corrected

**Decided by:** Owner of the Operai suite (wellD), after the OWASP review of specs/20261112-meeting-hours (ledger D67, D70, D63; review findings I8 and L1). Source: `specs/20261112-meeting-hours/plan.md` § ADR candidates, item 3, and D-P5; spec AC-2.3 (changed), A47, AC-2.7; `specs/20261112-meeting-hours/design.md` (amendment note, S1).

This amendment changes two statements in the Consequences above. It adds no write rule. The Decision, the Options and the Failure shape stand as written.

### (a) The "From meeting" mark follows the entry's current target

The mark is shown exactly while an automatic entry is recorded on a meeting, that is while
`origin === 'meeting' && on.type === 'meeting'`, where `on` is the entry's **current** target. The rule is computed on
each read from two fields of the same view, in one predicate that the List, a table cell's entries and Everyone's hours
all call. A deleted meeting still counts as a meeting (`on.type` stays `meeting`, AC-3.6). Consequently:

- An automatic entry moved to a project, a deal or other work shows no mark. It reads like any typed entry of that kind.
- An entry moved to another meeting keeps the mark, and so does one moved back onto a meeting.
- Changing its day, duration or note leaves the mark, as before.

**What is corrected.** The Consequences bullet "The entry's 'From meeting' mark persists after the person changes it (D57)"
is true only for a change that keeps the entry on a meeting. A move to a project, a deal or other work removes the mark. The
persistent fact is `origin`, not the mark.

**What does not change.** `origin` is still never recomputed. It stays `meeting` after any change, a move off the meeting
included, because the delete confirmation's sentence (AC-2.7) and A47 read it. The delete sentence keeps its own rule, `origin`
alone, so it still shows for a moved entry: deleting it still means Operai will not record it again (D70). The two predicates
are deliberately different. `TimeEntryView` gains no server-side field for the mark; the client already has both inputs.

**Rejected alternatives:**
- **The mark on `origin` alone** (the rule of D57 and D62, the previous one). Review I8 found that a read-all holder seeing the
  mark on a moved entry learned that a person's hours on another target came from a meeting, a fact they could not otherwise
  read from that entry. The mark now shows only what the entry is recorded on now.
- **Recomputing `origin` when an entry moves.** It would make the delete sentence (AC-2.7, D70) false for a moved entry and
  would remove the input A47 reads.

**Implementation status.** The hours-ui code still follows the previous rule (`origin` alone, `EntriesTable.tsx:68` as I8
describes it) until the hours-ui amendment of the plan lands: one predicate, `showsFromMeetingMark`, in `src/lib/fromMeetingMark.ts`.
The rule above is the one that code must follow when it does.

### (b) The forged-duration risk: the stated bound was wrong

The Consequences risk that reads "a forged duration is capped by the stored recording chunks and the 24 h entry cap" is **wrong**
(review L1). It is replaced by the following statement. The original text is not rewritten above.

- The 24 h entry cap is never the binding bound. The held duration is client-reported: each recording chunk ≤ 15 s, and the
  meeting's total ≤ 3 h 1 min (refused beyond it); an upload's is the container's own claim, ≤ 3 h. So an automatic entry is at
  most **180 minutes** per person and meeting (A36's rounding of 3 h 1 min).
- The stored chunks do not bound it. A chunk needs only to be an object of 1 to 8 MiB, and its reported duration is not compared
  with its bytes.
- **Once processing reads the audio, the measured duration corrects the held one (D63, AC-3.8 to AC-3.10).** When the measured
  duration differs from the held one by more than the larger of 30 s and 10 %, the meeting takes the measured duration and an
  untouched automatic entry follows it. The rule is one pure integer function, `durationAfterMeasure`, applied in
  `prepare_audio`'s one commit (plan § The measured duration, ADR candidate 4 of the plan, which is to be recorded as its own ADR).
- **What stays creator-trusted.** The held duration between Stop and the end of processing; a difference within the margin;
  and audio that cannot be read at all. The review's case (about 722 one-byte chunks each reported at 15 s) fails processing as
  `audio_unreadable`, and its held duration and the entries built on it stay (D69, AC-3.10). An entry changed by its person is
  theirs and is not touched by a correction.
- **`startsAt` is a second creator-controlled input that the original risk omitted.** It is set at create or by PATCH, to any
  instant, and decides the day of every participant's entry. It is bounded by the release day and today (AC-1.5, A37) and is not
  checked against the audio or anything else (a non-goal of the spec).
- Each person can still delete their own entry, and a deleted automatic entry is never recorded again (AC-2.5).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*

Source: `specs/20261112-meeting-hours/plan.md` (§ Architecture "Applying a notice (hours-api)", "The person's
writes", D-P2, D-P3; § Data model; § Security). Spec: `specs/20261112-meeting-hours/spec.md`. Ledger:
`specs/20261112-time-tracking/ledger.md` D14, D54–D59.
