# 0027 — Refund settings store: append-only, self-auditing key/value, extending the `MileageRate` sibling-table pattern

**Date:** 2026-07-22
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/011-refund-settings` turns the accounting distribution email — today a startup-only,
deploy-configured environment variable (`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`) — into the first
of what the spec's Domain language explicitly requires be a genuinely extensible concept: a
**refund setting**, "a named, persisted configuration value owned by refund-api … the underlying
store MUST be modeled to hold more refund settings later without rework." US-5 additionally
requires every change be fully auditable (actor, timestamp, old value, new value, AC-5.1) and
permanently immutable — "can never be edited or deleted by any user, including an admin"
(AC-5.2) — mirroring the suite's existing governed-audit posture (ADR-0018, ADR-0022, ADR-0024).

Two existing, materially different persistence shapes already exist in `refund-api` and were the
live candidates: `RefundAuditEntry` (ADR-0018, extended by ADR-0022) — an append-only,
DB-level-immutable table, but scoped by a **non-null** `requestId` foreign key to a specific
request/decision event, a shape that does not fit a settings change (which has no request to
attach to, exactly the mismatch `specs/011`'s Constraints section flags) — and `MileageRate`
(ADR-0024) — a **sibling**, non-request-scoped, self-auditing table using the identical
`BEFORE UPDATE/DELETE`-trigger immutability mechanism, created for exactly this class of problem
(a non-request-scoped, admin-governed, policy-value change) one spec earlier. A refund setting is
the second instance of that same shape, plus one new requirement `MileageRate` didn't have: the
store must hold an open-ended, growing set of **distinct named values** (`key`s), not just one
policy dimension, without a schema migration per new setting.

## Decision

We will add a new `RefundSetting` table — an append-only, key/value store where the current value
of a `key` is **derived on read** as its latest row (ADR-0013 lineage), made physically immutable
by the **same, verbatim** `BEFORE UPDATE/DELETE … RAISE EXCEPTION` trigger pattern ADR-0018
established and ADR-0024 already reused — and the row itself **is** the complete audit record; no
separate `RefundSettingAuditEntry` table is introduced.

1. **`RefundSetting` is a generic key/value table, not a typed singleton row per setting.**
   Columns: `id`, `key` (string — e.g. `"accounting-distribution-email"`), `value` (nullable
   string — `null` means cleared/not-configured), `createdByUserId`, `createdByEmail`,
   `createdAt`, indexed on `(key, createdAt)` for both "current value" (latest row per key) and
   "chronological history for a key" (AC-5.3) with the identical query shape. A future refund
   setting is a new `key` value written through the same table — zero migration, zero new table,
   zero new trigger — directly satisfying the Domain language's extensibility requirement. A small
   application-level **descriptor registry** (`{key → {label, validate}}`, refund-api's `settings/`
   module) is the single seam that declares which keys exist and how each validates; the store
   itself never hardcodes a specific setting's shape.
2. **Append-only, enforced at the database, not merely by an absent route.** The migration adds a
   `refund_setting_immutable()` function that `RAISE EXCEPTION`s, wired as
   `refund_setting_no_update`/`refund_setting_no_delete` `BEFORE` triggers — copied verbatim from
   `mileage_rate`'s (ADR-0024), itself copied verbatim from `refund_audit_entry`'s (ADR-0018).
   This is the pattern's **third** independent instance in the same database, now proven across
   three genuinely different record shapes (request-scoped audit, non-request-scoped policy
   value, non-request-scoped generic config).
3. **The row IS the audit trail — no separate audit table, exactly as ADR-0024 chose for
   `MileageRate`.** Every field AC-5.1 requires (actor, timestamp, old value, new value) is
   answerable from consecutive rows for the same `key` ordered by `createdAt`; "old value" is the
   previous row, "new value" is the row itself. `SELECT … WHERE key = … ORDER BY createdAt` answers
   both "what is the setting's history" (US-1/US-5 UI) and "what is the audit trail" (AC-5.3) with
   one query. No `RefundAuditEntry` row is ever written for a settings change — that table remains
   scoped entirely to request-level (ADR-0018) and batch-level (ADR-0022) events, neither of which
   a settings change is.
4. **No-op suppression via read-before-append (AC-5.4).** The settings `service.ts` layer reads
   the current (latest) row for the key, normalizes the incoming value (including `""` → `null`
   for "clear"), and skips the `INSERT` entirely when the normalized new value equals the current
   value — a save that changes nothing produces neither a new row nor a spurious audit entry. This
   is an application-level check (not a DB constraint), accepted as benign under a rare
   TOCTOU race for a single suite-wide value (see Risks).
5. **Migration is additive only.** `add_refund_settings` creates the new table plus its two
   triggers; it makes no destructive change to any existing table. (The separate,
   non-destructive `recipientEmailSnapshot` nullability change on `RefundBatch` is recorded under
   ADR-0029, not here.)

## Options considered

### Option A — Generic append-only key/value table, self-auditing via the ADR-0018/0024 trigger mechanism (chosen)

Described above.

**Pros:**
- Directly satisfies the Domain language's "more settings later, without rework" requirement — a
  new setting is a new `key` and a new descriptor-registry entry, never a migration
- No config/audit drift is possible: there is exactly one row per value transition and it serves
  both the "what's the current value" and "what's the history" purposes, exactly as ADR-0024
  already argued for `MileageRate`
- Reuses a proven, three-times-verified mechanism (the DB-level immutability trigger) rather than
  inventing a fourth approach to "how do we make a table append-only" in the same codebase
- `(key, createdAt)` is a single index that answers both the hot "current value" read and the
  cold "full history" read with the same query shape, keeping the store's read path trivially
  simple even as the number of distinct settings grows

**Cons:**
- "Current value" is always a query (`ORDER BY createdAt DESC LIMIT 1` scoped to `key`), never an
  O(1) row lookup by primary key the way a typed singleton table would offer — an accepted,
  bounded cost given the table's expected size (a handful of settings, changed rarely)
- A third hand-authored trigger definition now exists in the same database, parallel to but not
  shared with `refund_audit_entry`'s and `mileage_rate`'s — a future revision to the pattern must
  be deliberately propagated to all three, since nothing enforces they stay identical

### Option B — A typed singleton row per setting (e.g. a dedicated `AccountingDistributionEmailSetting` table with one current-value column) plus a separate mutable-then-audited history (rejected)

Model this specific setting as its own small table with a directly-updatable "current value"
column, and a companion append-only audit table recording each change.

**Pros:**
- "What's the current value" is the simplest possible query — a single-row lookup, no `ORDER BY`

**Cons:**
- Directly contradicts the Domain language's extensibility requirement: every future refund
  setting would need its own dedicated table and its own audit companion, exactly the "per-setting
  migration" cost the spec explicitly rules out
- Reintroduces the config/audit-drift risk ADR-0024 already rejected for `MileageRate` (Option C
  there): two tables, two write paths, a real risk of the "current value" row and the "audit"
  table disagreeing if a write to one succeeds and the other doesn't
- The "current value" column would be genuinely mutable (a plain `UPDATE`), the opposite of
  AC-5.2's "can never be edited … including an admin" bar — immutability would have to live
  entirely in the audit companion, not in the actual state the application reads
- Rejected: fails the spec's own stated extensibility requirement outright, and reintroduces a
  drift risk the suite has already solved once (ADR-0024)

### Option C — Extend `RefundAuditEntry` with a new `AuditAction` (e.g. `settings_changed`), mirroring how ADR-0022 extended it for batch events (rejected)

Reuse the existing request-audit table, adding a settings-change row type.

**Pros:**
- Zero new tables or trigger definitions — the exact reuse pattern ADR-0022 already established

**Cons:**
- `RefundAuditEntry.requestId` is a non-null foreign key to `RefundRequest` — a settings change has
  no request to attach to, the identical mismatch ADR-0024 already identified and rejected this
  same option for (`MileageRate`, Option B there)
- Would still require a *second* place to hold the actual current setting value for the
  application to read and validate against — `RefundAuditEntry` is a governance log, not a
  resolvable current-state store, so this option does not eliminate a second table, it only
  relocates the drift risk rather than removing it
- Rejected for the same reason ADR-0024 already rejected it for rate entries: does not fit the
  domain shape, and does not actually avoid a second table in practice

### Option D — Add a discriminator/`kind` column to the existing `MileageRate` table and reuse it for settings too (rejected)

Widen `MileageRate` into a generic "policy value" table covering both per-entity rates and
suite-wide settings.

**Pros:**
- One fewer table and trigger definition than Option A

**Cons:**
- Conflates two genuinely different domain concepts under one schema: `MileageRate` is
  per-entity, effective-dated, and numeric (ADR-0023/0025); a refund setting is suite-wide,
  not date-effective, and (for this feature) a string. Forcing both into one table means most
  columns are `NULL` for one concept or the other, and every query needs an extra discriminator
  filter
- Directly undermines ADR-0028's decision to keep `settings` and `rate` as two separate,
  independently-grantable catalog capabilities (a distribution mailbox is not a rate) — a shared
  table would make that separation cosmetic, since both admin surfaces would be reading/writing
  the same physical rows
- Rejected: no genuine schema-reuse benefit once the shape mismatch and the permission-separation
  requirement are accounted for

## Consequences

**Positive:**
- The Domain language's extensibility requirement is met structurally: a new refund setting never
  requires a migration, only a new descriptor-registry entry and (if it needs its own gating) a
  new catalog capability
- AC-5.1–AC-5.4 (audit capture, immutability, chronological history, no-op suppression) are all
  satisfied by the same mechanism this suite has already twice proven correct (ADR-0018, ADR-0024)
- No config/audit drift is possible by construction — there is exactly one row per value
  transition, serving both the "current value" and "history" reads
- Validates the sibling-table pattern's generality a second time beyond `MileageRate`: it now
  demonstrably fits both a per-entity numeric policy value and a suite-wide string config value

**Negative / trade-offs:**
- "Current value" is a query, not a direct row lookup — an accepted cost given how rarely a
  refund setting is expected to change and how small the resulting table will be
- A third hand-authored trigger definition exists in the database, requiring deliberate,
  by-inspection consistency with `refund_audit_entry`'s and `mileage_rate`'s rather than any
  shared, enforced definition
- No remediation path for a genuine data-entry mistake short of an out-of-band, protection-bypassing
  database intervention — the same accepted cost ADR-0018/0024 already named; a correction is
  always a new, forward-dated row, never an edit

**Risks:**
- **Descriptor registry drift (plan Risk R5).** A future setting added to the store without a
  matching registry entry would 404 on the API. Mitigation: the registry is the single documented
  seam; the store never invents keys the registry doesn't declare, and this is covered by tests
  for both the known key and an unknown-key 404.
- **No-op suppression TOCTOU (plan Risk R4, AC-5.4).** Two concurrent saves of the same value
  could both pass the read-before-append check and both insert. Mitigation: accepted as benign for
  a single suite-wide setting changed rarely by a small number of trusted admins — worst case is a
  duplicate-value audit row, not an incorrect current value; not worth a database-level lock.
- **Migration trigger portability.** The raw-SQL trigger must survive `prisma migrate` on the
  EU-region Postgres exactly as `refund_audit_entry`'s and `mileage_rate`'s already do. Mitigation:
  copied verbatim rather than reimplemented, covered by the same class of direct-SQL adversarial
  test (`db.*-immutability`) already established for both prior tables.

## Compliance notes

- GDPR/nLPD impact: low — a `RefundSetting` row records the actor's `userId`/`email` alongside a
  configuration value (for this feature, an email address that is itself an operational mailbox,
  not personal data about a data subject), necessary for governance/accountability of a
  financial-routing configuration change; no special-category data is introduced beyond what
  `RefundAuditEntry` (ADR-0018) and `MileageRate` (ADR-0024) already established as acceptable for
  the same purpose.
- Data residency: unaffected — `RefundSetting` lives in `refund-api`'s existing EU-region
  PostgreSQL database (ADR-0016's deployment posture), the same database `RefundAuditEntry` and
  `MileageRate` already live in.
- Audit trail: this ADR **is** the audit-trail decision for refund-setting changes — a
  self-auditing table, not a companion audit table — distinct from, and not a replacement for,
  ADR-0018 (request-level audit) or ADR-0022 (batch-level audit), neither of which this feature's
  rows are written into; the second independent instance of the pattern ADR-0024 first established
  for `MileageRate`.

This decision **extends** ADR-0018 (the same database-level immutability mechanism, reused
verbatim rather than reimplemented) and ADR-0024 (the suite's second reuse of the sibling
self-auditing-table pattern for a non-request-scoped record type, this time additionally required
to hold an open-ended set of distinct keys rather than one fixed policy dimension), and follows
ADR-0013's derived-on-read discipline (current value = latest row per key, never a scheduled
job). It supplies the persistence layer ADR-0028's `settings:read`/`settings:manage` capability
gates access to, and ADR-0029's live send-time recipient resolution reads from.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
