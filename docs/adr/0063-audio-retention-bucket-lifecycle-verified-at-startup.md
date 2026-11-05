# 0063 — Audio is deleted by a bucket-wide 29-day lifecycle rule that the service verifies at startup, with lazy delete on read and versioning forbidden

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; plan approved by the user on 2026-11-04, D-9)
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0016](0016-eu-object-storage-refund-attachments.md), [ADR-0013](0013-invitation-lifecycle-derived-expiry-state.md), [ADR-0062](0062-durable-job-runner-work-queued-state-derived.md), [ADR-0061](0061-meetings-ai-providers-eu-zero-retention.md), [ADR-0064](0064-meetings-api-reads-audio-bytes-third-reader.md)

---

## Context

AC-4.4 promises that retained audio is irrecoverably deleted within 30 days (plus at most 24
hours) of its meeting leaving `processing`, for a frozen meeting too, and for a meeting nobody
ever opens again. The suite's posture (ADR-0013, ADR-0016) is no cron and no queue sweep.
The bucket holds only audio (chunks, uploaded originals, `audio.ogg`); transcripts and all
other content live in Postgres. A promise of deletion is a statement about what a storage
system does without us, so it must hold when our code is not running.

## Decision

1. **One bucket-wide lifecycle rule** on the meetings bucket: expire current objects after
   **29 days** and expire noncurrent versions too, with no prefix filter. S3 expiration rounds
   up to the next midnight UTC, so an object is gone at most 30 days after its creation, plus
   the provider's asynchronous removal lag. `audio.ogg` is created *during* processing, before
   the meeting leaves it, so deletion falls inside AC-4.4's window. The same rule caps chunks
   of a never-processed `interrupted` meeting and orphaned presigned uploads at 29 days.
2. **The service verifies the rule at startup and refuses to start** (exit 1) unless
   `GetBucketLifecycleConfiguration` shows a rule with no prefix filter and `Days ≤ 29`, **and**
   `GetBucketVersioning` shows versioning is not `Enabled`. A versioned delete is a delete
   marker over a retained object, which is not irrecoverable.
3. **On read**, `audio` is `{state:"kept", until: audioCreatedAt + 29 d}`, `{state:"deleted"}`
   once `now ≥ until` or `audioDeletedAt` is set, or `{state:"none"}`. A read that observes
   expiry with `audioDeletedAt` null sets it and fires an idempotent `DeleteObject` (a lazy
   delete, ADR-0016 lineage). Playback and retry are then refused (409), so a user never sees
   an offer the lifecycle has made false. Expiry is derived, never written by a timer.
4. **Explicit deletes** (AC-4.5 Delete recording, AC-4.6 delete meeting) list and delete the
   `meetings/<id>/` prefix **first**. If storage fails, the answer is 503 `storage_unavailable`
   and **nothing changes**. Then the DB rows go in one transaction (cascade, one content-free
   `MeetingDeletion`, one `deleted` `HostNotice` with no title, removal of that meeting's other
   outbox rows).
5. **Local and provisioning:** `compose.yaml`'s `minio-createbucket` creates `meetings` with
   `mc ilm rule add --expire-days 29` and versioning off; production provisioning creates the
   bucket with the rule, versioning off, and CORS (shell origin, `POST` and `GET`).
6. **Out of scope and tracked:** Postgres backups keep deleted *transcript* content for the
   backup retention period (R7, spec O2, for the data-protection lead). Crypto-shredding is the
   named follow-up.

## Failure shape

**A retention or deletion promise that is only as true as some code path happening to run, or
that a storage setting quietly undoes.** If deletion depends on a cron, a worker or a user
reading the record, it fails exactly for the records nobody touches, which are the ones that
sit longest. If it depends on a bucket setting, a later change (a rule removed, a prefix filter
added, versioning switched on for "safety") turns "deleted" into "hidden but retained" with no
error anywhere.

Mirror positions. **Expiry vs explicit delete:** both must reach the bytes, and the explicit
path must fail loudly (503, nothing changed) rather than delete the row and orphan the object.
**Bytes vs rows vs copies:** an object-store rule does not cover the database, backups, or
derived caches; each needs its own statement of how it ends (R7 is the open one). **Create vs
delete of the mechanism:** the *absence* of the rule is the failure, so the check is "the rule
is there now", at every start, not "we configured it once". **What users are told vs what is
true:** a UI that says "kept until" must be derived from the same clock the storage uses.
Recognise it for any future feature that promises a deletion date (exports, attachments, call
logs).

## Alternatives considered

- **A 30-day deletion cron.** Rejected: ADR-0013's posture, and a cron that stops means data
  silently outlives the promise.
- **Delete-on-read only.** Rejected: an unread meeting would keep its audio forever, which is
  the exact case AC-4.4 covers.
- **Per-object expiry tags.** Rejected: not portable across S3-compatible EU providers.
- **Trust the provisioning step without a startup check.** Rejected: nothing would notice the
  rule removed, narrowed by a prefix or overridden by versioning (R10 covers a provider that
  cannot read the rule: start is refused).

## Consequences

**Positive:**
- The promise holds when meetings-api is down or the meeting is never opened again.
- A misconfigured bucket cannot serve traffic.
- No scheduled process owns the data's end of life.

**Negative / trade-offs:**
- Deletion is bounded by a ≤ 24 h rounding and provider lag, which is what AC-4.4's "plus at
  most 24 hours" already allows; the margin of 29 vs 30 days absorbs it.
- The provider must support lifecycle rules and expose them for reading (MinIO, AWS, Scaleway
  and Hetzner do); a provider that does not cannot host the bucket.
- Versioning can never be turned on for this bucket (for backup or ransomware reasons)
  without revisiting this ADR.
- The startup checks need `s3:GetLifecycleConfiguration` and `s3:GetBucketVersioning`
  permissions on the service's credentials.

**Risks:**
- A bucket-wide rule also expires objects we might later want longer; a future non-audio
  object must go in a different bucket.
- R7: transcripts survive in database backups beyond a deletion.

## Compliance notes

- GDPR / nFADP: storage limitation for voice data; irrecoverable deletion within the window;
  explicit erasure on request (AC-4.5, AC-4.6).
- Data residency: the bucket is EU-validated at startup (ADR-0016, ADR-0061).
- Audit trail: a content-free `MeetingDeletion` row (Tier-1 append-only trigger); no audio
  access log.

## Follow-up notes

- **2026-11-05 (ADR-0069):** a second bucket now exists: a transient Google Cloud Storage bucket used only while one transcription attempt runs, with its own startup-verified rules (EU/CH location, 1-day lifecycle `Delete` rule, soft delete retention 0, versioning off, no retention policy). It does not change this ADR's 29-day audio rule, which governs the Railway bucket. "Delete recording" and "Delete meeting" now clear the Railway prefix and the transient `transcribe/<meetingId>/` prefix first, before any database change, with a 503 and nothing changed on failure.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
