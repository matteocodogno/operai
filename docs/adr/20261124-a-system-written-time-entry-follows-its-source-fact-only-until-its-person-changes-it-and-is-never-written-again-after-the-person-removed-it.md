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

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*

Source: `specs/20261112-meeting-hours/plan.md` (§ Architecture "Applying a notice (hours-api)", "The person's
writes", D-P2, D-P3; § Data model; § Security). Spec: `specs/20261112-meeting-hours/spec.md`. Ledger:
`specs/20261112-time-tracking/ledger.md` D14, D54–D59.
