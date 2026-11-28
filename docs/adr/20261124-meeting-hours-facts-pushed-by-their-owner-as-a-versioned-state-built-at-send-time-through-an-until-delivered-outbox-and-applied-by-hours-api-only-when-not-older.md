# 20261124 — A meeting's hours facts are pushed by meetings-api as a versioned state built at send time through an until-delivered outbox; hours-api applies only a version not older than the one it holds

**Date:** 2026-11-24  
**Status:** Accepted (decided by the owner, Matteo Codogno, 2026-11-24; plan `specs/20261112-meeting-hours/plan.md` § Architecture, decision D-P1 and § Release backfill)  
**Deciders:** Matteo Codogno (owner), wellD  
**Project:** Operai

---

## Context

A meeting that has a duration gives its creator and each Operai participant an automatic hours entry on that meeting (specs/20261112-meeting-hours, D54–D57). The facts that decide those entries (when the meeting started, how long it lasted, who created it, who took part) are owned by meetings-api; the entries are owned by hours-api, which must keep them correct under every total, export and deal figure without asking meetings-api at read time (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route). The facts change more than once (a recording stops, an upload is probed, a participant is added or removed, a meeting is moved or deleted), messages can be lost, repeated or reordered, and the meetings of the release day already exist before the new channel does.

## Decision

We will have meetings-api push the hours facts of a meeting to hours-api as a **versioned state built at send time**: every change to a fact bumps `Meeting.hoursSeq` and records a content-free `hours_notice` row in the same transaction, and the job runner builds the body from the meeting's current facts when it delivers (`POST /system/meeting-hours/v1/notices`, scope `meeting-hours-notices.send`, `sub` `system:meetings-api`). hours-api applies a notice in one transaction under a per-meeting row lock and ignores a notice whose version is older than the one it applied; an equal version is applied again, which is harmless. Meetings created before the release are delivered by a backfill enqueued by meetings-api's own migration, for the meetings with a duration started in the last 14 days; hours-api filters that set by its own release day.

## Failure shape

**The failure is a copy of an owner's state that is written from something older than the state it claims to describe.** A message carries a snapshot taken when it was queued, a retry or a slow delivery lands after a newer one, and the receiver overwrites newer truth with older truth and reports success. Separately, a change that was recorded but never sent, or a record that existed before the channel did, leaves the copy silently short, and nothing looks wrong because "nothing arrived" and "nothing there" look identical.

The same shape appears in every mirror position:

- **Outbound, the state is read at send time, never at enqueue time.** Any code that queues "the new value" and later sends it is in the shape. Coalescing several pending messages into one, or sending a value captured earlier, can drop a change that the in-flight message has already read past (a lost update).
- **Inbound, a version decides, never arrival order.** A consumer that applies whatever message it receives last, on a read-modify-write without a version comparison, is in the shape, including a consumer that re-reads the owner after a message and applies what it reads twice.
- **Deletion is a state too.** The owner's delete cascades its own rows; a notice about the delete must not be a foreign key to the thing deleted, and the consumer must keep the tombstone it applied, or a late older state brings back what the owner removed.
- **Before-the-channel records.** Any record created before a new push exists, the push must cover it or the consumer's copy is missing for ever. A backfill that depends on an operator remembering a script is in the shape; one that is queued by the owner's own migration is not.
- **Read side.** A total or an export computed from a copy that may be behind looks complete while it is not. Wherever a figure is built from a mirrored state, ask whether a missing or late message would show as a smaller number with no sign.

Recognise it in any new flow where one service writes another service's records from a message, a webhook, an event or a read-back; when a consumer's "latest" is decided by arrival; or when an owner's delete has to be remembered by someone else.

## Options considered

### Option A — Versioned state built at send time, until-delivered outbox, version-gated apply (chosen)
meetings-api writes `hours_notice` and bumps `hoursSeq` in the write's transaction; the runner reads the meeting when it sends; hours-api keeps the newest `seq` per meeting under a row lock and re-applies an equal one.

**Pros:**
- A delivery carries what is true when it is sent, so a late or repeated delivery cannot regress the copy.
- Ordering and duplicates are harmless by construction: hours-api needs only the newest version, and every pending row for a meeting may be delivered in any order.
- No second route, scope or hop: one POST, retried until accepted, using the job runner and token machinery that host notices already use (ADR 20261104-meeting-host-contract-resolve-and-notices, ADR 20261104-durable-job-runner-work-queued-state-derived).
- Content-free outbox: no personal data is stored in it; ids are read at send time.

**Cons:**
- meetings-api now sends a body that is a full state, not a delta, so the wire schema must be shared byte-for-byte between the two services.
- A notice for a meeting that changes often can be sent several times (the older ones are simply discarded by hours-api).
- A failed delivery is retried for as long as it takes (until-delivered), so a long hours-api outage lengthens the delay.

### Option B — Content-free notice plus a read-back route in meetings-api (`GET /system/meetings/attendance`)
hours-api is told only that meeting M changed, then asks meetings-api for the facts.

**Pros:**
- The notice itself carries nothing.
- meetings-api always answers with the facts as they are when asked.

**Cons:**
- A second route, a second scope and a second network hop on every apply, and hours-api must call out while it holds a lock or applies out of its transaction.
- Two concurrent read-backs can still apply out of order, so the version is needed anyway; the design ends with the same version, plus a call.

### Option C — Derive automatic entries on read from meetings-api
Totals, lists, exports and Everyone's hours compute the automatic entries from meetings-api at read time.

**Pros:**
- No copy at all; no outbox, no apply logic.

**Cons:**
- Every total, export and deal figure depends on Meetings answering. An outage or a slow answer makes figures wrong while they look complete, the failure ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route rejected.
- The person's edits (moves, deletions, blocks) would need a second store anyway.

### Option D — A change feed that hours-api pulls on a timer
hours-api reads a cursor over meetings-api's changes every few minutes.

**Pros:**
- The owner is not called on each change.

**Cons:**
- A cursor in commit order misses rows from transactions that commit later with an earlier position, so the feed is not complete without a second pass.
- Deletions need tombstones in the feed, and hours-api needs a scheduler of its own, which the suite keeps out of consumers (ADR 20261118-assignment-reminders-in-process-scheduler-claimed-by-cas is a scheduler in the owning service, not in a consumer).

### Option E — Coalesce pending notices per meeting
Keep one pending row per meeting and overwrite it when a fact changes.

**Pros:**
- Fewer rows and sends.

**Cons:**
- A notice already being delivered may have read the facts before the change that would replace it, so the replacement is never sent: a lost update. Keeping one in-flight row and one pending row per meeting makes it safe only at the cost of the ordering this option was meant to remove.

### Option F — Operator-run backfill script for the release day
A script run once by a person copies the existing meetings into hours-api.

**Pros:**
- Explicit, and visible in the release runbook.

**Cons:**
- A forgotten step silently loses the release day's meetings: nothing fails, the copy is simply short. Chosen instead: the backfill is enqueued by meetings-api's migration, so it runs with the deploy that needs it and cannot be skipped.

## Consequences

**Positive:**
- The apply is idempotent and order-independent for every outcome that matters: an older notice is refused as a no-op, an equal one re-applies, a newer one wins.
- The release day's meetings reach hours-api without an operator step, and a gap of up to two weeks between the two deploys is covered by the 14-day window.
- A future-day entry (a meeting dated after today in Zurich) is delivered again on its day by a second job with the same version; no scheduler in hours-api.

**Negative / trade-offs:**
- The notice body is a full state, so `meetingHoursWire.ts` is a byte-identical file in both services and is checked by the shared-copies script.
- hours-api gains one row per meeting (`meeting_hours_meeting`, the applied `seq`) and two more tables for the untouched-entry rules (`meeting_hours_block`, `meeting_hours_release`).
- The release backfill covers meetings with a duration started in the last 14 days only; older meetings are not copied, by design, because their entries were never automatic.

**Risks:**
- hours-api or the service token unavailable for a long time: entries are late, never lost. Mitigation: the 30 s, 2 min, 10 min, then every 30 min backoff; a count of `hours_notice` rows older than an hour is the early signal in the release runbook.
- A permanent 400 (a version gap between the two copies of the wire schema) strands a meeting until its next fact change. Mitigation: one shared schema file, checked in CI; a `failed` row keeps its error code.
- The backfill window (14 days) is shorter than the gap between two deploys: deploy both services in one release (plan § Deploy order).

## Compliance notes

- GDPR / data-protection impact: **medium.** Attendance (which Operai person took part in which meeting, when and for how long) crosses from meetings-api to hours-api. The feature needs that minimum; no title, no external participant, no transcript or content is sent (AC-4.1). The outbox row holds no personal data, and hours-api stores only what an entry already holds plus a block row (meeting id, user id, reason). Logs carry the meeting id and the counts, never a user id.
- Labour-law note: automatic recording of hours about a person is a go-live sign-off owned by management / HR (spec O3), accepted as a risk in the plan.
- Data residency: compliant. Both services run in the EU region; no new external host.
- Audit trail: not required by this ADR. Entries are ordinary time entries and are changed by the person, as today.

---

*Reference: `specs/20261112-meeting-hours/plan.md` (§ Architecture, § Data model, § API contracts, § Risks; decision D-P1 and § Release backfill). Ledger: `specs/20261112-time-tracking/ledger.md` D54–D59.*
