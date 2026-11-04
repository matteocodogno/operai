# 0062 — A durable job runner executes work users asked for; lifecycle state stays derived on read

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; plan approved by the user on 2026-11-04, D-6)
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0013](0013-invitation-lifecycle-derived-expiry-state.md), [ADR-0019](0019-refund-batch-pdf-generation-pdf-lib.md), [ADR-0016](0016-eu-object-storage-refund-attachments.md), [ADR-0038](0038-optimistic-concurrency-version-if-match-cas-amends-0004.md), [ADR-0059](0059-meeting-host-contract-resolve-and-notices.md), [ADR-0064](0064-meetings-api-reads-audio-bytes-third-reader.md)

---

## Context

Meetings has work that takes minutes and must survive a deploy: preparing audio with ffmpeg,
transcribing up to 3 h of speech, generating a summary, and delivering a removal notice to a
host until it lands. The suite has no queue. ADR-0013 and its lineage (0016, 0019) forbid
cron or queue *sweeps that write lifecycle state by the passage of time*, and the plan must
not read as an exception to that. The two things are different and the difference needs
writing down, because the next engineer to need a background process will read ADR-0013 and
either avoid a needed queue or add a sweeper.

## Decision

1. **A Postgres `meeting_job` table is the queue.** Kinds: `prepare_audio`, `transcribe`,
   `summarize`, `deliver_host_notice`. A route enqueues **in its own transaction** and issues
   `NOTIFY meetings_jobs`.
2. **A worker loop runs inside the meetings-api process** (`MEETINGS_WORKER=on|off|only`). It
   wakes on `LISTEN` or a 30 s idle poll of *its own queue*, and claims with `SELECT … FOR
   UPDATE SKIP LOCKED` where `state='queued' AND runAfter<=now()` **or** `state='running' AND
   leaseUntil<now()` (a job whose process died). Lease 2 minutes, heartbeated every 30 s; at
   most 2 concurrent jobs per process, only one of them ffmpeg.
3. **Every step is idempotent**, and each result is committed in one transaction that
   re-checks the target row still exists and the job's `attemptId` still matches, so a
   superseded or resurrected worker commits nothing.
4. **Retries:** 3 attempts for transient provider errors (429/5xx/timeout), backoff 30 s → 2 m
   → 10 m; permanent errors fail at once. `deliver_host_notice` for `unlinked`/`deleted` retries
   until delivered (ADR-0059). On SIGTERM the worker stops claiming and finishes running work
   within Railway's grace period; anything cut off is re-claimed on lease expiry.
5. **The boundary with ADR-0013, stated as a rule.** The runner executes **work a user (or a
   committed change) requested**, and it never scans for "expired", "stale" or "overdue" things
   to change their state. Every time-based state stays **derived on read**: `interrupted`
   (no chunk or heartbeat for 2 min), audio expired, frozen, a stale summary, an answer
   `pending` for more than 2 min reads `failed`, a summary `generating` for more than 10 min
   reads `failed` with Retry, the rate-limit window. A time comparison that decides what the
   user sees belongs in the read path; a unit of work that was asked for belongs in the queue.
6. **Escalation:** split the worker into its own Railway service (same image,
   `MEETINGS_WORKER=only` / `off`) when ffmpeg affects API p95 or there are routinely more than
   2 queued jobs.

## Failure shape

**A user-requested operation left neither done nor visibly failed, and, the opposite
mistake, a record's state made true only by a background writer.** The first is work lost when
a process dies mid-flight, a deploy lands, or a promise is dropped without a row, so nothing
retries it and nothing can show "failed". The second is a state ("expired", "interrupted",
"stuck") that is only correct if a sweeper ran recently, so a stopped sweeper means wrong
state, and every reader must trust the writer.

Mirror positions. **Claim vs commit:** a worker that lost its lease can still finish and write;
the commit must re-check ownership (`attemptId`), not rely on having claimed. **Enqueue vs
effect:** the row must be written in the same transaction as the change that needs the work,
or a crash between them loses the work or runs it for a change that rolled back. **Work vs
state:** if you are about to write "a job that finds old rows and sets a flag", the flag
should be a derived expression instead; if you are about to run a model call or a transcode
in the request, it should be a job. **Success vs failure visibility:** a derived "read as
failed" rule must exist for every pending state whose worker can die. Recognise it in any
future "do this later" feature (report generation, imports, email batches).

## Alternatives considered

- **Synchronous processing in the request.** Rejected: 3 h of audio takes minutes, and a
  deploy loses it.
- **Fire-and-forget promise with no row.** Rejected: lost on restart, nothing to retry, AC-6.9
  cannot show `failed`.
- **Redis/BullMQ or SQS.** Rejected: a new store and new infrastructure for a queue Postgres
  already provides, with the enqueue no longer transactional with the change.
- **A Railway cron.** Rejected: a time-driven sweep, the exact thing ADR-0013 forbids, plus
  latency.
- **Kick work lazily on read only.** Rejected: nobody reading means never transcribed, and no
  AC-12.2 notification.

## Consequences

**Positive:**
- Jobs survive restarts and deploys; no new infrastructure; enqueue is atomic with the change.
- ADR-0013's posture stays intact and now has a stated boundary, not an implied exception.

**Negative / trade-offs:**
- The worker shares a process with the API, so a long ffmpeg job competes for CPU with
  requests (the escalation trigger above).
- Every job kind must be written idempotent; a non-idempotent step is a bug here, not a
  convenience. A re-run after a lost lease costs a second transcription (R6).
- `numReplicas: 1` for now; more replicas are safe for claiming but not yet exercised.

**Risks:**
- A deploy during a long job. Mitigation: lease re-claim, SIGTERM drain.
- A permanent-failure misclassified as transient burns attempts; the closed set of failure
  codes (`audio_unreadable | provider_unavailable | provider_rejected | too_long`) keeps it
  visible.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
