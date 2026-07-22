# 0029 — Batch email recipient resolves LIVE at every send/resend attempt: amends ADR-0021's compile-time snapshot freeze; introduces the blocked-send `422` contract

**Date:** 2026-07-22
**Status:** Accepted — amends ADR-0021 (see that ADR's amended header note; ADR-0021 remains Accepted, its Decision points 1, 2, and 4 unchanged and in force)
**Deciders:** wellD
**Project:** Operai

---

## Context

ADR-0021 established that a compiled batch's accounting-distribution email is sent to
`recipientEmailSnapshot`, a value fixed at compile time from the single, deploy-configured
`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` env var, and stated explicitly that both the automatic
post-compile send and every subsequent resend use "the same configured accounting distribution
address … without re-running compilation." That design was correct under its own premise: the
address genuinely was fixed for the lifetime of a deploy, so freezing it onto the batch cost
nothing and gave a stable, inspectable record of what was sent where.

`specs/011-refund-settings` breaks that premise: the address is no longer a deploy-time constant,
it is a live, admin-editable `refund_setting` (ADR-0027), gated by a new capability (ADR-0028),
specifically so an accounting admin can fix a wrong or stale value **without a redeploy** (US-1).
Three of the spec's acceptance criteria are each individually unsatisfiable under ADR-0021's
freeze: AC-1.5 requires "the very next batch-email send or resend already observes the newly
saved value" with no restart; AC-2.3 requires the address is "never a value baked in at a
previous deploy" — literally the freeze's own behavior; and AC-2.4 requires that a batch whose
email was blocked because the setting was unconfigured at compile time must still be reachable by
a resend **after** the setting is subsequently configured — impossible if resend only ever reuses
a value snapshotted before that configuration existed. Additionally, `specs/011` introduces a
state ADR-0021 never had to consider: the setting can be genuinely **unconfigured** (not merely
misconfigured), which compilation must be unaffected by (AC-2.1) but which sending must refuse in
a way distinguishable from an ordinary delivery failure (AC-2.2).

## Decision

We will drop ADR-0021's compile-time recipient freeze. `refund-api` now resolves the accounting
distribution email **live**, from `refund_setting` (ADR-0027), at **every** send attempt —
automatic post-compile send and explicit resend alike — never at compile time. `compileBatch`
loses its recipient parameter entirely. `RefundBatch.recipientEmailSnapshot` is repurposed to a
nullable, informational **per-attempt delivery provenance** field. A new, distinct blocked-send
contract is introduced for the unconfigured case.

1. **Compile is fully decoupled from the setting (AC-2.1).** `compileBatch` no longer accepts or
   reads a recipient email at all — request selection, batch/PDF creation (ADR-0019), and audit
   recording (`batch_compiled`, ADR-0022) proceed identically whether the setting is configured,
   unconfigured, or about to change mid-flight. Compilation can never fail, and never behaves
   differently, based on the setting's state.
2. **Every send attempt — automatic or resend — re-resolves the live setting, never reuses a
   stored value as its source.** The send resolver (`batches/email.ts` / `lib/notifyEmail.ts`
   caller) reads `refund_setting`'s current `accounting-distribution-email` value (ADR-0027's
   latest-row-per-key derivation) at the moment of the attempt. `batches.routes.ts` drops its
   `env.REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` read entirely (removed alongside `lib/env.ts`'s
   schema entry, AC-4.1). This directly satisfies AC-1.5 (no redeploy/restart needed) and AC-2.3
   ("never a value baked in at a previous deploy") because there is no longer any value baked in
   anywhere — every attempt is a fresh read.
3. **`recipientEmailSnapshot` is repurposed, not dropped: nullable per-attempt provenance, never
   the source of truth.** The migration drops the column's `NOT NULL` constraint (a
   non-destructive change on a financial table, consistent with ADR-0018/0020's retention
   discipline). After each send attempt (successful, failed, or blocked), the resolver writes the
   address that attempt targeted (or leaves it `null` if the attempt never reached a resolvable
   address, i.e. blocked-unconfigured) — purely informational forensic history of "what this
   specific attempt tried," never read back as an input to any decision. `compileBatch` never
   writes to it; only the send/resend path does, once per attempt.
4. **Blocked-send contract for the unconfigured case (D5).** When the live setting is
   unconfigured (`value IS NULL`, i.e. never set or explicitly cleared, ADR-0027) at send time:
   - **Automatic send at compile:** no email is sent; the batch's `emailStatus` is persisted as
     the new value `"blocked_unconfigured"` (a widened enum alongside the existing `"sent"`/
     `"failed"`, ADR-0011). Compile itself still returns `201` (AC-2.1) — this is purely a
     post-compile side effect.
   - **Explicit resend:** returns `422 Unprocessable Entity`, RFC 7807 Problem JSON, with a stable
     extension member `code: "accounting_distribution_email_unconfigured"`; the batch's
     `emailStatus` is (re-)set to `"blocked_unconfigured"` and `emailLastAttemptAt` updated. This
     mirrors the existing batches-router precedent of a `422` for the empty-candidate-set refusal.
   - This is **structurally distinguishable** from an ordinary Resend/notify-api outage, which
     remains ADR-0011's existing best-effort `200` + `emailStatus:"failed"` — a blocked send is a
     configuration gap the caller can fix themselves (US-1); a failed send is a vendor/network
     problem it cannot. `mark-paid` is unaffected by either (AC-2.5, unchanged from ADR-0021/007's
     existing "delivery failure never blocks mark-paid" posture).
5. **A previously-blocked batch is not permanently blocked (AC-2.4).** Because resolution always
   reads the live setting, a batch stuck at `"blocked_unconfigured"` is fully reachable the moment
   an admin configures the setting (ADR-0027/US-1) and any authorized user triggers a resend — no
   re-compilation, no special "unblock" action, no data migration; the very next resend attempt
   simply resolves successfully.

## Options considered

### Option A — Drop the freeze; resolve live at every attempt; repurpose the snapshot column to provenance (chosen)

Described above.

**Pros:**
- AC-1.5, AC-2.3, and AC-2.4 each fall out structurally — there is no code path left that could
  serve a stale value, because no value is ever stored as a decision input in the first place
- Compile stays entirely decoupled from the setting's state (AC-2.1) — the simplest possible
  contract: compilation never knows or cares whether the setting is configured
- The blocked/failed distinction (Decision 4) gives accounting and ops a genuinely different,
  actionable signal for "you forgot to configure this" versus "Resend/notify-api is down" —
  neither previously existed as a distinct state
- Retaining (not dropping) `recipientEmailSnapshot` avoids a destructive migration on a financial
  table and preserves forensic value — "what address did this specific attempt actually target" —
  which a value-source column alone (live-resolved) cannot answer after the fact

**Cons:**
- This is a genuine, in-place amendment of a previously-Accepted ADR (ADR-0021) — a first for the
  suite (contrast ADR-0020, which superseded only an unnumbered schema-comment freeze, never
  another numbered ADR's own Decision text) — future readers must consult both records together
- `recipientEmailSnapshot`'s meaning changes from "the authoritative address this batch was sent
  to" to "the address the *last* attempt targeted" — any external tooling, dashboard, or manual
  query written against ADR-0021's original semantics silently reads a different thing after this
  ships
- The send path now does an additional internal DB read (the settings repo) on every attempt
  rather than trusting an already-loaded batch column — a small, accepted latency/complexity cost

### Option B — Keep the compile-time freeze; only resend re-resolves and re-snapshots (rejected)

Preserve ADR-0021's freeze for the automatic post-compile send; treat an explicit resend as
"refresh the snapshot from the live setting, write it, then send."

**Pros:**
- Smaller diff against ADR-0021 — the automatic-send path is untouched, only the resend handler
  changes
- Partially satisfies AC-2.4 — a later-configured value does reach a previously-blocked batch on
  resend

**Cons:**
- Still technically violates AC-2.3's "never a value baked in at a previous deploy" for the
  automatic send: that value is captured at the compile instant, which is not guaranteed to be
  simultaneous with the actual send attempt (e.g. a delayed or retried delivery pipeline) — a
  narrower but real version of the exact staleness risk this feature exists to close
  - Requires **two different resolution code paths** (compile-freezes-once vs.
  resend-refreshes-and-rewrites) that each need their own blocked/unconfigured handling, doubling
  the surface Risk R1/R2 already flag as needing careful, single-change coverage
- Still mutates `recipientEmailSnapshot` as if it were the source of truth on every resend,
  keeping the exact column-semantics ambiguity Option A's provenance reframing avoids, while
  gaining none of Option A's structural simplicity
- Rejected: does not cleanly satisfy the full AC set, and is more code for a worse guarantee than
  full live resolution

### Option C — Keep the env var, but make it "live" via an in-process reload mechanism (config-reload endpoint, SIGHUP, or a periodically-refreshed cache) instead of moving the value into `refund_setting` (rejected)

Address AC-1.5's "no redeploy" requirement without adopting ADR-0027's DB-backed settings store.

**Pros:**
- Would avoid a schema change entirely if only this ADR's concern (staleness) is considered in
  isolation

**Cons:**
- Does not touch US-1 (admin-viewable/editable in Admin > Refund) or US-5 (per-change audit
  trail) at all — those requirements independently mandate a persisted, queryable,
  auditable value (ADR-0027), which an env-var-plus-reload mechanism cannot provide
- Directly violates AC-4.1, which requires refund-api not read, require, or validate the env var
  **at all**, not merely that it be reloadable
- Rejected: solves a narrower problem than the one actually specified, and still leaves US-1/US-5
  unaddressed, so it would not actually avoid ADR-0027's schema change — only add a second,
  redundant mechanism alongside it

### Option D — Drop `recipientEmailSnapshot` entirely rather than repurposing it (rejected)

Remove the column outright in the same migration, since it is no longer the source of truth for
the send address.

**Pros:**
- Avoids carrying a column whose meaning has changed, reducing potential confusion to zero by
  simply not having the column

**Cons:**
- A destructive migration on a financial table (`RefundBatch`), against the suite's established
  non-destructive-migration discipline for financial/governance data (ADR-0018/0020's retention
  posture: extend or nullable-relax, don't drop)
- Permanently loses the forensic value of "what address did this specific send attempt actually
  target" — useful precisely in the failure/blocked cases this feature adds, where reconstructing
  intent after the fact matters most
- Rejected: the plan's own Risk R1 mitigation is explicit about keeping the column nullable rather
  than dropping it, for exactly this reason

## Consequences

**Positive:**
- AC-1.5, AC-2.1, AC-2.3, AC-2.4, and AC-2.5 are each satisfied structurally, with no code path
  capable of serving a stale or previously-frozen address
- The blocked/failed distinction (Decision 4) gives ops and accounting a genuinely new, actionable
  signal that didn't exist under ADR-0021 — "you forgot to configure this" is now a first-class,
  differently-coded outcome from "Resend is down"
- `notify-api`'s delivery API (ADR-0011) and the internal-token trust path (ADR-0011/ADR-0017) are
  entirely untouched — only the *source* of the `to` value changes, confirmed by the plan's API
  contracts section (byte-for-byte unchanged `POST /system/emails` call shape)

**Negative / trade-offs:**
- This ADR is a genuine, first-of-its-kind in-place amendment to a prior Accepted ADR's Decision
  text (ADR-0021 point 3) — a materially different kind of cross-reference than the suite's prior
  "extends"/"contrasts with" relationships, and it requires a reader of ADR-0021 alone to also
  discover this ADR to get the current, accurate picture (mitigated by the forward-pointer note
  added to ADR-0021's header, see below)
- `recipientEmailSnapshot`'s semantics change (authoritative address → last-attempt provenance)
  is a breaking change to any external reading of that column's meaning; on a batch whose very
  first attempt was blocked-unconfigured, the column can now legitimately be `null` even for a
  batch that eventually did send successfully on a later attempt, until that later attempt writes
  it
- `batches.schemas.ts`'s `emailStatus` enum widening (`"blocked_unconfigured"`) ripples into the
  `batches.service.ts` casts, refund-ui's delivery-status copy, and the OpenAPI response shape
  (plan Risk R2) — a small but real multi-file touch for one new enum member

**Risks:**
- **Supersession blast radius (plan Risk R1).** Flipping snapshot→live touches
  `batches.routes.ts`, `batches/email.ts`, `lib/notifyEmail.ts` (drops the `recipientEmail`
  parameter), `compileBatch`, and their existing tests — some of which have comments explicitly
  asserting "never a live re-read," inherited directly from ADR-0021. Mitigation: land the
  live-resolution change and its test rewrites as one task/change, not split across commits; grep
  for `recipientEmailSnapshot` before coding to enumerate every touch point up front.
- **`emailStatus` enum widening ripple (plan Risk R2).** One new enumerated constant reused across
  the schema, two service-layer casts, refund-ui copy, and the OpenAPI response. Mitigation: a
  single shared constant, covered by AC-2.2's dedicated test.
- **Settings-repo dependency on the send hot path.** The send resolver now performs an additional
  internal DB read (via ADR-0027's settings repo) on every attempt, rather than trusting an
  already-loaded batch column. Mitigation: this is an in-process, same-database, already-indexed
  (`key, createdAt`) read with no cross-service call involved — materially cheaper than, and not
  comparable in risk to, a cross-service `auth` resolve call (ADR-0014's actual latency-sensitive
  dependency).

## Compliance notes

- GDPR/nLPD impact: unchanged from ADR-0021 — the email itself still carries no financial data,
  only a link and non-sensitive metadata; this decision changes only how the recipient address is
  *sourced*, not what the email body contains or how the PDF is accessed.
- Data residency: unaffected — the live-resolved value is read from `refund_setting` in
  `refund-api`'s existing EU-region PostgreSQL database (ADR-0016's deployment posture, ADR-0027's
  table), the same database the batch and its (now-nullable) `recipientEmailSnapshot` column
  already live in.
- Audit trail: unchanged in scope from ADR-0021 — the send/resend action itself remains outside
  `RefundAuditEntry` (delivery status lives on the batch row and in `notify-api`'s own
  `EmailDelivery` record, per ADR-0011/ADR-0021's existing stance). The *setting's* own value
  history is separately, fully audited via ADR-0027 — this ADR neither duplicates nor weakens
  that.

**This decision amends ADR-0021.** Specifically, it supersedes ADR-0021's Decision point 3
("Recipient is always exactly the one configured distribution address … on every compile and
every resend") for the *timing and source* of resolution: compile no longer participates in
recipient resolution at all (Decision point 1 above), and "every resend" now means live-resolved
against `refund_setting` (ADR-0027), never a value reused from a frozen snapshot.
**ADR-0021's Decision points 1, 2, and 4 — the in-app deep-link design (never a raw presigned URL
or attachment), the `notify-api` template/channel shape, and the soft-failure/never-blocks-
compilation posture — are entirely unchanged and remain fully in force.** Per this repository's
established convention (no ADR in this suite has ever been marked with a `Superseded` status —
ADR-0020's own supersession of a prior freeze left that freeze's non-existent ADR file untouched
and simply narrated the relationship in its own text), ADR-0021's `Status` remains **Accepted**.
Because this is the suite's first amendment of an actual *numbered* ADR's Decision text (rather
than an unnumbered schema-comment freeze), a forward-pointer note has additionally been added to
ADR-0021's own header, so a reader who opens ADR-0021 first is directed here.

This decision also **depends on** ADR-0027 (the `refund_setting` store this resolution reads
from) and ADR-0028 (the `settings:read`/`settings:manage` capability that gates the setting
itself — orthogonal to, and unaffected by, this ADR's send-time resolution logic).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
