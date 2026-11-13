# 0089 — Whether a person may record hours on a project, deal or meeting is asked of the service that owns it, as the caller, at write time; a meeting's current deal link is read live from meetings-api's first `/system/*` route

**Date:** 2026-11-12  
**Status:** Accepted (specs/029-time-tracking, plan.md § ADR candidates; decided by the owner at the planning gate, 2026-11-12); amended 2026-11-12 (see § Amendment 2026-11-12)  
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

## Amendment 2026-11-12 — labels follow the viewer for every fact read with the service's credential; the deal filter fails closed

**Date:** 2026-11-12  
**Amends:** § Decision 6 (labels follow the viewer) and § Decision 5 for the `dealId` read; adds amendment decisions A1 and A2 below.  
**Source:** specs/029-time-tracking, decided by the owner at the design gate, 2026-11-12 (ledger D40, D43, D44, D45; spec AC-4.10, AC-4.11). For A2 the architect recommended the opposite; the owner's choice is recorded here.

### A1 — A fact read with hours-api's own credential reaches a viewer only with the right to name it

The meeting → deal link is read live from meetings-api with hours-api's service credential (Decision 5),
and that credential can see every meeting's link. The link therefore reaches a viewer only together with
the viewer's right to read the record it names: the deal's id and name when the viewer can read that deal
(asked of crm-api as the viewer, § Views), and neither otherwise. This is Decision 6 applied to the fact
that points at the entity, not only to the entity.

It applies to **every** viewer, the entry's own author included (D43, AC-4.10). An author who cannot read
a deal sees the meeting's hours counted, but not the deal's name or id.

Every aggregate and export merges what the viewer cannot name into one group per reason, not one per id:
- `hidden`: the viewer may not read the project, deal or meeting;
- `unavailable`: the owner did not answer the viewer's read;
- `deal-unknown`: the meeting's current deal could not be read with the service credential.

The export writes the same placeholder for each group (§ Export file), so a file summed by deal equals the
by-deal totals (D40).

*Rejected:* one group per unreadable id. It produces rows nobody can tell apart, an export that cannot
reproduce them without ids (AC-4.10), and it hands the id of a fact held with a service's credential to a
person who cannot read it. *Rejected:* returning the linked deal's id with a null name, which still tells
the viewer which deal a meeting they may not read is linked to.

**Decided 2026-11-13 (D44): WITHHOLD.** An entry's own target is stored by hours-api when the author records
the entry; it is not learned with the service credential, so the name rule above does not reach it. In a
time entry view, `on.id` (project, deal or meeting) and `activity.id` are returned only when the record is
visible to the viewer or the entry belongs to the viewer; otherwise they are `null`. A visible record keeps
its id for everyone, since the viewer can already read it and its `href` carries the id. The author keeps
the ids of their own entries whatever the visibility, including `unavailable`, so the edit dialog keeps
working. Totals, labels and the export are unchanged: totals never carried ids, and the export and everyone's
hours use none.

*Reason.* Before this decision a holder of `time-entry:read-all` without `crm:access` could take the ids of
hidden records from the list and feed them back as `dealId`, `projectId` or `meetingId` filters. The OWASP
review of 2026-11-13 reproduced it (finding F1, Medium, `specs/029-time-tracking/owasp-report.md` § F1): the
list returned the id of a hidden deal and the ids of two hidden meetings, and the `dealId` filter then
returned exactly the entries on those two meetings. The holder learned which hidden meetings are linked to
which hidden deal. That is the disclosure A1 forbids, reached through ids rather than names. Withholding the
ids closes the pivot for all three filters at once.

*Rejected:* keeping the ids and adding a viewer `crm` read on every `dealId` filter. It adds a call and a
refusal, and it does not close the `projectId` and `meetingId` pivots. *Rejected:* withholding the ids from the
author too. That is uniform with the name rule, but it breaks the author's edit dialog for no gain, since the
author already knows their own targets.

*Residual, accepted (F2, Low):* a deal id obtained outside hours-api (from the CRM, or from a meeting the
viewer can read) can still be used as a `dealId` filter. What it reveals is only "this entry's meeting is
linked to the deal you named", with no name or content.

*Where it lands:* the plan's § Views contract (`id: string | null`) and spec AC-4.10. The decision and its
rationale are recorded in `specs/029-time-tracking/ledger.md` (D44) and `owasp-report.md` § 4.

**Constrains:** specs/030 (hours on project and deal pages) and any later consumer of hours totals must
take the same groups, must not name a project, deal or meeting the viewer cannot read, and must show the
`deal-unknown` gap rather than drop it.

This is the borrowed-authority form of § Failure shape read from the other end: a fact held with one
service's right is shown under another person's right, and the answer is about the wrong right.

### A2 — The deal filter fails closed (a deliberate departure from ADR-0080 for this one filter)

A list or totals read that carries a `dealId` filter first asks meetings-api which meetings are linked to
that deal (`GET /system/meetings/hosts?dealId=`, Decision 5). If that call does not answer, the whole read
is refused with `503 host_unavailable` and nothing partial is returned (AC-4.11). The export, which walks
the list, is refused the same way.

Without a deal filter, reads still degrade as Decision 5 and § Totals say: `groupBy=deal` counts meeting
entries in the `deal-unknown` group, a list item carries `on.deal = { state: "unknown" }`, and
`meeting-deals` is named in `unavailable`.

This departs on purpose from ADR-0080's rule that a read degrades and a write that must confirm refuses.
For this filter the reader is protected the other way round: a deal's figures shown low are worse than a
short refusal, because the reader takes a partial total for the deal's total. The outage window is seconds
to minutes (a redeploy of meetings-api's single replica, a crash, a network error). Nothing is stored, so
the first read after meetings-api answers is complete.

*Rejected:* answering with the deal's own entries plus `meeting-deals` in `unavailable` (the architect's
recommendation). For the whole window the deal's total would be low, and a reader who does not read the
warning takes it as the total. *Rejected:* counting every meeting entry of the period as a possible match,
which gives wrong totals in the other direction.

**Scope of the departure.** It covers the `dealId` filter on the list, the totals and the export only. It
does not cover `groupBy=deal` without a filter (still degrades), the other filters (still degrade with
`unavailable`), or writes (already fail closed, § Errors 503).

**Revisit when either:**
- meetings-api runs more than one replica. The outage window then becomes rare, and the question is
  whether the refusal still costs more than a warned partial answer for what remains.
- users report the deal filter as unusable during outages, in a way the refusal and a retry do not
  resolve. That report reopens the choice between the refusal and the warned partial answer.

### Consequences of the amendment

**Positive:**
- A viewer never learns a deal's name or id through a meeting they may not read.
- A deal's total is never shown low without its gap named: either it is refused (A2) or the gap is a
  `deal-unknown` group (§ Decision 5).

**Negative / trade-offs:**
- The `dealId` filter on list, totals and export is refused for as long as meetings-api cannot answer.
- hours-ui must render that refusal as a retryable error. It must not render an empty list or a zero total
  for it.
- The author's own entries are the only ones that show the id of a record the viewer cannot read (D44).

**Risks:**
- A person reads a refused deal view as "no hours". Mitigation: the refusal is a `503 host_unavailable`
  with a retryable message, never a `200` with empty groups.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
