# 20261118 — A caller's version pin can force the letterhead service to re-read the registry only when it is ahead of the version held, at most once a second and 100 times in 10 minutes per process; any other mismatching pin is answered 409 at once without a call

**Date:** 2026-11-18  
**Status:** Proposed — decided by the orchestrator during the owner-requested unattended run 2026-11-17/18, pending the owner's review. F6 part: owner decision of 2026-11-17 to fix every low finding of the security review in this feature (plan amendment "after security review", G10, approved 2026-11-17; tasks T64, T72). N2 part (newer pins only, budget of 100 per 10 minutes): recommended by the security re-review (security-review-2.md N2, T70) and added to tasks.md as T76 on 2026-11-18 by the orchestrator; implemented, and no owner approval of the numbers (1 s, the budget, crm-api's 1.1 s wait of T72) is recorded. **Amends** point 3 ("The pin") and point 4 of ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds. **Amended 2026-11-18:** the budget was lowered from 100 to 30 per 10 minutes by T77 (see Amendment 2026-11-18 below); the file name and the title keep the original 100.  
**Deciders:** the orchestrator, on the owner's standing instruction (unattended run 2026-11-17/18); Matteo Codogno (product owner) to confirm  
**Project:** operai

---

## Context

A document is made from one version of the issuer's details. `crm-api` sends a `legalEntityVersion` pin with a content-v2 render request; `letterhead-api` answers 409 `legal_entity_version_mismatch` with `currentVersion` if the version it holds is not the pin, after refreshing once if its entry was older (ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds, point 3). `crm-api` drops its own entry, re-reads, rebuilds and retries once.

The pin comes from the caller, and the refresh is a call to `auth`. Security review F6 (low) found that a request with a mismatching pin cleared the cache every time, so a caller could make every render a call to `auth`. F6's fix (T64) coalesced forced refreshes to at most one per second per process, and made `crm-api` wait 1 100 ms before its one retry so a legitimate save does not land inside the one-second window and turn into a 503 (T72).

The re-review (security-review-2.md N2, low) found that this still allows 600 forced refreshes in 10 minutes per process, while `auth` allows each calling service 300 legal-entity reads in 10 minutes in total, shared by every replica (`LEGAL_ENTITIES_SERVICE_LIMIT = 300`, ADR 20261112-system-endpoints-limited-per-verified-service; the steady rate of a consumer that caches 30 s is about 20). A holder of `letterhead:render` that kept sending a mismatching pin for about 5 minutes, or a `crm-api` bug that sent an old pin, would spend the service's allowance; after that every registry refresh, including the ordinary 30-second ones, is refused by `auth`, and renders become 503 for everyone.

## Decision

We will let a pin cause a registry read only when it is **newer** than the version held, and then at most once per second and at most 100 times in any 10 minutes per process; a pin older than or equal to the held version, or any pin beyond those limits, is answered 409 `legal_entity_version_mismatch` with `currentVersion` at once, without a call to `auth`.

(`letterhead-api/api/src/routes/render.rs` `issuer_details`; `api/src/registry/cache.rs` `refresh_for_pin`, `FORCED_REFRESH_EVERY`, `PIN_REFRESH_BUDGET`, `PIN_REFRESH_WINDOW`; `crm-api/src/offers/generation.ts` `issuerPinRetry`; tasks T64, T72, T76.)

1. **Older or equal pin.** Versions only go up, so no read can make an older pin current. `issuer_details` answers 409 with the held version at once, with no registry call. A matching pin costs nothing.
2. **Newer pin.** The caller saw something `auth` may hold and we do not yet. `refresh_for_pin()` forgets the entry so the next read asks `auth`, unless (a) a forced refresh was started less than 1 s ago, (b) the entry was sent less than 1 s ago (it is as new as a forced refresh would make it), or (c) 100 forced refreshes were started in the last 600 s (sliding window). A refused call does not use the budget; a started one does, whatever its outcome. When it does not refresh, the caller's next read is the held entry (no call) or the refresh already in flight (joined), and a pin that still differs is the caller's 409 at once. Nothing is dropped and nothing waits.
3. **The retry in `crm-api`.** On 409 `crm-api` drops its entry, waits `issuerPinRetry.waitMs = 1100` (a constant behind a test seam, past the one-second window), re-reads, rebuilds and retries **once**; a second mismatch is `layout_service_unavailable`. The wait is fixed and bounded; no value from a caller reaches it.
4. **Unchanged.** The 30 s fresh and 60 s stale rules of the cache, the sent-time stamp, single flight, and the 409 / retry-once contract of ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds.

## Failure shape

**A value chosen by the caller makes the service spend a shared, bounded resource of a third party on the caller's behalf.** The service believes it is being careful (re-read when unsure), and the caller decides when it is unsure. The limit the third party applies is per service, not per caller, so one caller's stream, or one bug, exhausts what every other use of that service needs, and the visible failure is somewhere else (renders for everyone turn 503) and later (when the allowance is gone). The same shape in the other direction: the "fix" that spaces calls in time still lets the total exceed the allowance.

Where else this shape can appear, including the mirror-image positions:

- **Request-driven refresh.** Any cache or lookup that a request can invalidate or force (a `Cache-Control: no-cache` header honoured as is, a "refresh" query parameter, a version pin, an ETag mismatch, a retry-on-401 loop) is an amplifier: bound it by a time spacing **and** by a count, per process, below the upstream's own allowance, and decide what answers beyond the bound (here the held entry, at once).
- **Direction of the argument.** A pin or token that is ahead of what is held can be cured by a read; one that is behind or equal cannot. Check which direction a mismatch can be cured in before spending a read on it, in either comparison (version, timestamp, epoch, sequence).
- **Per-process and per-service.** A limit counted per process is N times larger with N replicas against an upstream limit per service; set the local bound well under `allowance / replicas`, or state the residual.
- **Spacing and total.** A minimum interval is not a budget (600 per 10 minutes passes a 1 per second rule); a budget is not a spacing (100 in one second passes a 100 per 10 minutes rule). Use both.
- **Sender and receiver of a retry.** The side that retries must wait past the receiver's window (here `crm-api` 1 100 ms) or the legitimate retry is the one refused; a receiver's coalescing rule and the sender's retry delay are one design.
- **Other consumers.** The next service that holds a registry cache with a pin inherits these rules and the numbers' reasoning; a Rust client and a TypeScript client keep the same rules, pinned by their own tests.

## Options considered

### Option A — Newer pins only, 1 per second, 100 per 10 minutes per process, 409 at once beyond (chosen)

Described above.

**Pros:**
- The registry read allowance cannot be spent by a pin stream from one caller or one bug; 100 is a third of the allowance for one process, and a legitimate save needs one or two reads
- An impossible refresh (older pin) is refused without a call
- No waiting and no queue: the answer beyond the bound is the 409 the caller already handles

**Cons:**
- A legitimate burst beyond 100 pin-forced refreshes in 10 minutes in one process gets 409 and, after `crm-api`'s one retry, `layout_service_unavailable`, even though a real change exists
- The numbers (1 s, 100, 600 s) are fixed constants of the Rust client, and `crm-api`'s 1 100 ms wait depends on the one-second constant
- With several replicas the sum of budgets can still pass 300 (3 replicas at 100 each), so the budget is "well under", not a guarantee

### Option B — Refresh on every mismatching pin (the original, rejected by F6)

**Pros:**
- Simplest; always as fresh as possible

**Cons:**
- A caller could make every request a call to `auth`

### Option C — Coalesce to one per second per process only (F6's fix, kept as the first limit)

**Pros:**
- Bounds the rate of calls and needs no budget state

**Cons:**
- 600 per 10 minutes per process against an allowance of 300 per service (N2)

### Option D — A budget only, no spacing (not chosen)

**Pros:**
- Allows a legitimate pair of reads in the same second

**Cons:**
- 100 reads could be made in one second and then none for ten minutes, which blocks the legitimate case that follows

### Option E — Drop the pin and let the caller retry on any failure (rejected)

**Pros:**
- No refresh path

**Cons:**
- Loses "one document is one version of the details" (ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds)

## Evidence

- `letterhead-api/api/tests/registry.rs` (`registry_a_forced_refresh_is_not_made_when_the_entry_was_sent_less_than_a_second_ago`, `registry_after_a_second_a_forced_refresh_reads_again_once_and_then_waits_a_second`, `registry_a_failed_forced_refresh_still_counts_for_the_second`, `registry_forced_refreshes_are_budgeted_per_ten_minutes_and_the_window_slides`) and `api/tests/render.rs` (`render_a_pin_that_differs_refreshes_once_and_a_pin_that_still_differs_is_409`, which includes an older pin answered 409 at once and again a second later with no call; `render_a_mismatching_pin_is_one_registry_call_per_second_at_most`: 100 mismatching renders in one second make at most one registry call), per tasks.md T64 and T76.
- `crm-api/src/offers/generation.ts` and its tests (the single retry after `issuerPinRetry.waitMs`, T72).
- specs/20261117-legal-entities/security-review-2.md N2 (the finding and its numbers) and qe-report.md (AC-5.5, AC-6.2).

## Consequences

**Positive:**
- A mismatching or hostile pin stream cannot take the registry's read allowance, so document making keeps working for everyone
- A pin that cannot be cured costs no call
- The retry and the receiver's window are designed together

**Negative / trade-offs:**
- More state in the Rust cache (`last_forced`, a queue of forced starts) and three constants to keep in step with `auth`'s allowance
- A legitimate save has a wait of about 1.1 s before the single retry

**Risks:**
- **Constants out of step.** If `auth`'s `LEGAL_ENTITIES_SERVICE_LIMIT` is lowered, or replicas are added, the budget may no longer be "well under"; neither is checked by a test that reads the other. Compare them when either changes.
- **Per-process counts.** Each replica of `letterhead-api` has its own budget; with N replicas the total is N times 100.
- **A registry change during a refused window.** A caller whose pin is newer than the held version, in the one-second window or beyond the budget, gets a 409; its single retry waits 1.1 s, which is past the window, but beyond the budget it fails with `layout_service_unavailable` until the entry's own 30-second refresh brings the new version. The document is refused, not printed with the wrong version.

## Amendment 2026-11-18 — the budget is 30 per 10 minutes, and the prior entry is the fallback during a forced refresh

Task T77 (in progress when this note was written) lowers `PIN_REFRESH_BUDGET` from 100 to **30** forced refreshes per 10 minutes per process and keeps the prior entry as the fallback while a forced refresh is in flight, so a slow, failing or 429-answering `auth` does not leave the process with no entry to fall back to. Both follow the delta findings of specs/20261117-legal-entities/security-review-2.md: T76-1 (a forced refresh dropped the held entry before its outcome was known) and T76-2 (the budget is per process while `auth`'s allowance of 300 reads per 10 minutes is per service, shared by every replica). Wherever this ADR, including its title and file name, says 100, read 30. Against `auth`'s 300 per 10 minutes per service, one replica makes at most 30 forced plus about 20 natural reads (one per 30 s), about 50 per 600 s, so the allowance holds up to about 6 replicas; `.railway/railway.ts` declares one today. Like the rest of this ADR, the 30 is pending the owner's review. The rest of the decision (newer pins only, once a second, 409 at once otherwise) is unchanged.

## Escalation triggers

This decision is revisited when any of these happens:

- `auth`'s per-service allowance for legal-entity reads changes, or `letterhead-api` runs more than one replica;
- a log shows renders refused with `legal_entity_version_mismatch` for a version the registry does hold (a budget too low, or a caller that pins ahead of every save);
- a second consumer with a pin and a cache is added (compare ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds's escalation triggers).

## Compliance notes

- GDPR / data-protection impact: none. No value is read or logged by this rule.
- Data residency: no change.
- Audit trail: not required.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
