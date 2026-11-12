# 0089 — Whether a person may record hours on a project, deal or meeting is asked of the service that owns it, as the caller, at write time; a meeting's current deal link is read live from meetings-api's first `/system/*` route

**Date:** 2026-11-12  
**Status:** Accepted (specs/029-time-tracking, plan.md § ADR candidates; decided by the owner at the planning gate, 2026-11-12)  
**Deciders:** wellD (owner of specs/029)  
**Project:** Operai

---

## Context

Time entries (specs/029) record hours on exactly one of: a project, a deal, a meeting, or no entity.
Each of the three is owned by another tool, and each has its own answer to "who may act on this":
a project's project manager and team (projects-api, ADR-0079); a deal's owner, technical contact and
the people involved in its activities (crm-api, ADR-0052, activities-api, ADR-0081); a meeting's
creator and Operai participants (meetings-api, ADR-0058). The hours tool must not restate any of
those rules, and must not hold a copy of who is involved, because a copy goes stale on reassignment,
removal from a team or a relink.

A meeting's hours count for the deal the meeting is linked to *now* (AC-2.6): when a meeting is
relinked, its hours follow it. The link lives in meetings-api and reaches the CRM by notice (ADR-0059),
which is retried only manually. Labels on lists must also follow the viewer's own access, not the
writer's (AC-4.10). Activities and meetings are readable only by relationship (ADR-0058, ADR-0081), so
an answer that describes the service's rights rather than the person's is a leak.

## Decision

We will decide whether a person may record or change an entry on a project, deal or meeting **by asking
the owning service, with the caller's own JWT forwarded, on every write**, and we will not cache the
answer or copy the involvement into `hours-api`. Failure is closed: unreachable is `503`, unreadable or
missing is `404`, readable but not allowed is `403`.

1. **Project.** projects-api's existing `POST /activity-host/v1/resolve` (ADR-0081) answers
   `assignees` (project manager and team). The caller must be in it. Its `writable` flag is ignored:
   entries are accepted in any project state.
2. **Deal.** crm-api's `POST /activity-host/v1/resolve` learns `entityType: "deal"` and answers
   `involved: [ownerUserId, technicalUserId?]`, the technical contact as the deal view shows it (an
   estimate override row is not a technical contact). If the caller is not there, hours-api asks
   activities-api `GET /activities?dealId=` as the caller and looks for the caller as a task assignee
   or participant. This second question is the same host-decided rule as ADR-0081, not a new contract.
3. **Activity pointer.** activities-api `GET /activities` gains an `ids` filter (≤ 50), still resolved
   as the caller. A pointed activity must belong to the same project or deal as the entry.
4. **Meeting.** meetings-api `GET /meetings` gains `ids` (≤ 25). It lists only the caller's own meetings
   (creator or Operai participant), so one call is both the check and the label. A host-only reader is
   never in the list and gets the same `404` as a missing meeting.
5. **A meeting's current deal** (needed to count its hours under a deal for any viewer, AC-2.6) is read
   live from meetings-api's first `/system/*` route, `GET /system/meetings/hosts?ids=` and
   `?dealId=`. It sits behind a service JWT (`aud = SERVICE_AUDIENCE`, scope `meetings.hosts.read`,
   `sub` must be `system:hours-api`, every failure the same `401`). It answers `{ id, host }` and nothing
   else: no title, participant, duration or content (ADR-0058). Reads fail soft and name the source as
   unavailable. The scope is granted in production `SERVICE_CLIENTS` only after the new auth is live
   (ADR-0076's rollout order).
6. **Labels follow the viewer.** An entity the viewer cannot read is shown as hidden: its type, no name,
   no activity subject (AC-4.10). A label lookup never grants a write.

## Failure shape

**A decision about a person being made from a picture of a shared record that is no longer true, or
by an authority that is not the person's.** Two forms recur. The first is a copy: a second service keeps
a list of who is involved, or what is linked to what, and answers from it. The copy is right at the
moment it was made and wrong after the next reassignment, removal, relink or deleted notice, and nothing
in the copying service notices. The second is borrowed authority: the question is put with the
service's own rights, so the answer says what the service may see, not what the person may do.

Where else this shape appears, in the mirror positions:

- **Read and write.** A list that shows counts or labels for a record takes the same rule as the write
  that adds to it. A label the viewer could not obtain on their own must not be shown as if it were
  theirs. Do not let a label lookup be the one that grants, and do not let a grant lookup fall back to a
  cached "yes".
- **Link and target.** A relation between two owners (a meeting linked to a deal, an entry pointing at an
  activity) is a fact of the owner of the link. Read it from that owner live; a notice that was sent once
  and never retried is not the link. Recognise it when a total moves between records and nobody can say
  when it changed.
- **Time of check and time of consequence.** A right checked at write time is not a right that keeps
  applying: someone who leaves a team keeps the entries they recorded (AC-2.4). Do not re-check history
  or retroactively remove what was true when it was written.
- **Existence and access.** "Not yours" and "not there" must give the same answer from every hop, or the
  id space becomes an oracle for other owners' records.
- **Service and user principals.** A route that reads a fact on the user's behalf uses the user's
  credential; a route the service calls for a state push or a copy uses the service's scope and `sub`.
  Recognise a regression when a user-facing read is served with a service token, or a service route starts
  asking "as whom?".
- **Recognise it** by the sentence "this service already knows who is involved, so I'll just check that".

## Options considered

### Option A — Ask each owner as the caller, live, fail closed; read a meeting's current link from meetings-api's content-free system route (chosen)
Described above.

**Pros:** each owner keeps its rule; a reassignment, removal, relink or revoked grant applies on the next
write; the answer is the person's, not the service's; OPS and other users without `crm:access` never need
it; the pattern reuses ADR-0059's resolve and ADR-0081's activity-host contract.
**Cons:** every entry write makes one to three owner calls and fails if any owner is down; list reads
degrade per source; a new `/system/*` route and scope on meetings-api.

### Option B — Use activities-api's meeting mirror (the `meeting` activity with a deal id) as the meeting→deal link (rejected)
**Pros:** no new route on meetings-api; one service already holds the link.
**Cons:** a `linked` or `changed` notice that fails is retried only manually by the creator, and the mirror
activity can be deleted by hand and is never recreated. Hours would silently stop counting for a deal.
A mirror is a copy of the link, which is the failure shape above.

### Option C — Store the deal on the time entry at write time (rejected)
**Pros:** a single read for the deal total.
**Cons:** breaks AC-2.6: when a meeting is relinked, its hours must follow it, and a stored deal does not.

### Option D — Copy involvement into hours-api from crm-api and projects-api notices (rejected)
**Pros:** no call on the write path.
**Cons:** a copy of reassignment and removal that must be kept right by messages (ADR-0076's warning);
a missed notice grants or refuses a write on a stale team.

### Option E — A new `/time-host/v1/resolve` contract parallel to the activity-host resolve (rejected)
**Pros:** a shape tailored to hours.
**Cons:** two contracts for one question ("may this person act on this record?"); the owners would have to
keep two rule sets in step. Extending the existing resolve with `entityType: "deal"` is one contract with
a second consumer.

### Option F — Give `time-entry:read-all` holders access to meetings, or read meeting titles with a service call (rejected)
**Pros:** oversight can label every meeting.
**Cons:** visibility by relationship, never by role (ADR-0058). An oversight role must not widen what content
it can see. Labels for other people's meetings stay hidden (AC-4.10).

## Consequences

**Positive:**
- A person may record hours only on a project, deal or meeting they are currently part of, decided by
  the owner that holds the rule.
- A meeting's hours follow its current deal (AC-2.6) without a copy of the link.
- No second copy of the CRM, project or meeting involvement exists in the hours service.

**Negative / trade-offs:**
- Entry writes depend on up to three owners being up, and fail closed.
- Three services gain small, additive routes or answers: crm-api (`deal` entity type on its resolve),
  activities-api (`ids` filter), meetings-api (`ids` filter and the first `/system/*` route). projects-api
  is unchanged: its existing resolve is reused.
- Lists are assembled from several owners and can show a source as unavailable.

**Risks:**
- **Latency of a deal booking.** Two owner calls on the write path. **Revisit** when the p95 of a deal
  booking exceeds 800 ms; the next step is an `involvedIn` filter on activities-api, not a cache.
- **A third host** (or a host whose access is per record rather than per entity) would need its own
  resolve entry and a decision on the same contract. Revisit then.
- **Resolve answering more than the routes allow.** Each owner's resolve must reuse its own route guards,
  or hours-api will grant what the owner would refuse. Cover both in each owner's contract test.
- **`meetings.hosts.read` widening.** The scope must answer only `{ id, host }`. Adding a field is a
  change to this ADR, not a quiet extension.

## Compliance notes

- **GDPR / nFADP impact: medium.** Time entries describe what a named person worked on and for how long,
  which is employee-related data. The link check reads only ids and host references from meetings-api;
  titles and content are read only by the viewer's own relationship.
- **Data residency:** compliant. All calls stay on EU suite services (Railway EU).
- **Audit trail:** not required by this ADR. Entry changes are recorded by hours-api's own rules (specs/029);
  a decision to add an append-only trail belongs to that spec's review, not here.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
