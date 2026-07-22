---
spec: 011
status: approved
---

# Plan: Refund settings — admin-managed accounting distribution email

## Resolved decisions (the seven open questions)

- **D1 — Storage shape:** an **append-only key/value `refund_setting` table**; the current
  value of a setting is *derived on read* as the latest row for that `key` (ADR-0013 /
  ADR-0024 lineage). Extensible with zero rework — a new setting is a new `key`, never a
  migration. Chosen over a typed singleton row (not extensible) and over a mutable
  current-value row + separate audit table (two tables, two write paths that can drift).
- **D2 — Gating capability:** a **NEW `settings` catalog resource** on the `refund` app,
  actions `read` + `manage`, **no `supportedConditions`** (global, exactly like `rate`,
  ADR-0023). Rejected reusing `rate:manage`: a distribution mailbox is not a rate;
  conflating them makes the two admin surfaces un-separable (you could never grant rate
  management without also granting settings). Small catalog addition, clean separation,
  and it lets US-3 gate **read** (`settings:read`) and **write** (`settings:manage`)
  independently.
- **D3 — Audit mechanism:** the **`refund_setting` table IS its own audit trail** — the
  same self-auditing, DB-level-immutable pattern `MileageRate` uses (ADR-0024), because a
  settings change is **not request-scoped** and cannot be represented by `RefundAuditEntry`
  (its `requestId` FK is `NOT NULL`; a settings change has no request — exactly the mismatch
  the spec flags). Every value transition is a new row (actor / timestamp / old→new derivable
  from the previous row); the identical `BEFORE UPDATE/DELETE` raising trigger enforces
  AC-5.2. No-op suppression (AC-5.4): read-latest-before-append, skip the insert when the
  normalized new value equals the current value.
- **D4 — admin-ui wiring:** a **NEW refund-api settings endpoint** consumed by a **new
  `settingsApi.ts`** in admin-ui (mirrors `ratesApi.ts`), NOT an extension of the rates
  surface — different resource, capability, and validation contract. Same composition as
  ADR-0023: `shell/session`'s `apiFetch` + `getRefundApiBaseUrl()`. The existing Refund tab
  (`MileageRatesPage`) gains a new capability-gated panel; refund-api stays the sole owner
  of the value and all send logic.
- **D5 — blocked-send 4xx:** on an explicit **resend** while unconfigured, `422 Unprocessable
  Entity` + RFC 7807 with a stable extension member **`code: "accounting_distribution_email_
  unconfigured"`** (the specs/010 `code` discriminator pattern), and the batch's persisted
  `emailStatus` is set to the new value **`"blocked_unconfigured"`**. This is distinguishable
  from an ordinary Resend/notify-api outage two ways: outage stays a best-effort `200` with
  `emailStatus:"failed"` (ADR-0011), blocked is a `422` + `code` + a distinct persisted status.
  Mirrors the existing batches-router precedent (`422` for the empty-candidate-set refusal).
- **D6 — snapshot vs live → LIVE:** the send path (auto-send at compile **and** resend) now
  **resolves the live `accounting-distribution-email` setting at send time**; the per-batch
  compile-time freeze is dropped. AC-1.5 ("the very next send already observes the newly saved
  value"), AC-2.3 ("never a value baked in at a previous deploy"), and AC-2.4 (a
  previously-blocked batch must reach the later-configured address) are each unsatisfiable
  under a frozen snapshot. This **supersedes ADR-0021's `recipientEmailSnapshot` freeze**; the
  column is repurposed to nullable **per-attempt delivery provenance** ("the address the last
  send attempt targeted") — informational, never the source. `compileBatch` loses its
  `recipientEmail` parameter entirely, so compile is fully decoupled from the setting (AC-2.1).
- **D7 — cutover → seed the current value via a deliberate, operator-run one-time script.**
  Chosen over "deploy unconfigured" (which incurs AC-4.3's blocked window) for a zero-gap
  cutover. Crucially it is **NOT a server startup env read** and **NOT a schema migration
  carrying the value** — it is an idempotent `bun run settings:seed` maintenance command an
  operator runs once at deploy, passing the current production value explicitly; it appends
  the initial `refund_setting` row (with a documented `system:settings-cutover` actor) only
  when the key has no rows yet. This keeps AC-4.1 strictly honored (the *running service*
  never reads `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`) while making the cutover deliberate and
  documented (AC-4.2) and producing an honest first audit row.

## Architecture

Components touched / added:

- **refund-api — new `settings` module** (`src/settings/`): `repo.ts` (append + latest-per-key
  + history reads, Effect/Prisma, mirrors `rates/repo.ts`), `service.ts` (normalize/validate,
  no-op suppression, derive `configured`), `schemas.ts`, `routes.ts` (`GET`/`PUT /settings/:key`,
  gated by `settings:read`/`settings:manage` via the existing `jwtMiddleware`+`authzMiddleware`
  +`hasCapability` chain, ADR-0014 — fails closed 503 on an `auth` outage). Registered in
  `src/index.ts` alongside `ratesRouter`. A small **settings descriptor registry** maps each
  `key` → `{ label, validate }` so the store *and* the route stay extensible: an unknown key
  is a `404`; the one registered key `accounting-distribution-email` validates a well-formed
  email (or empty→null to clear). This registry is the single seam future settings extend.
- **refund-api — batch email path:** the send resolver (`batches/email.ts` /
  `lib/notifyEmail.ts` caller) reads the live setting from the new `settings` repo at each
  attempt. Unconfigured → persist `emailStatus:"blocked_unconfigured"` and (for resend) return
  the D5 422; configured → send to the live value and record it as the batch's delivery
  provenance. `batches.routes.ts` drops the `env.REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` read
  (line ~323) and `compileBatch`'s recipient parameter; `batches.schemas.ts`'s `emailStatus`
  enum widens to include `"blocked_unconfigured"` (with the `batches.service.ts` cast).
- **refund-api — `lib/env.ts`:** remove `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` from the zod
  schema (AC-4.1). `REFUND_APP_BASE_URL` (the deep-link base, ADR-0021) is **untouched**.
- **auth — catalog + seed:** `catalogs/refund.ts` gains a `settings` resource (read/manage, no
  conditions); `authz/seed.ts` gains `seedSettingsAdminGrants()` granting `settings:read`/
  `settings:manage` to `admin` + `refund-admin` (mirrors `seedRateAdminGrants`), added to the
  seed sequence. This is the *only* auth change (declaration + grant; ADR-0007 — no roles/perms
  in the JWT, resolved live via `/authz/resolve`, ADR-0014).
- **admin-ui — Refund tab:** `MileageRatesPage` gains a capability-gated
  accounting-distribution-email panel (view current / "not configured", edit, clear, inline
  validation error, change-history list), backed by a new `settingsApi.ts`. Visibility gated on
  `settings:read` via the same `getMe()` pattern the rate section uses (AC-3.2); the real
  boundary is refund-api's server-side gate.
- **refund-ui — batch detail (small):** map the new `emailStatus:"blocked_unconfigured"` to an
  actionable, distinguishable message ("Set the accounting distribution email in Admin > Refund
  first") — the only refund-ui touch (specs/008 US-3's delivery-status display, AC-2.2).

Referenced ADRs: **0011** (internal-token `/system/emails` path — unchanged), **0018/0022/0024**
(DB-level immutable audit, self-auditing sibling-table pattern reused), **0021** (compile-time
recipient snapshot — *superseded* for the source of the address), **0023** (global unconditioned
refund config permission + admin-ui→refund-api direct composition), **0014** (authz-enforcing
resource server), **0007** (live permission resolution, no perms in JWT), **0013** (derived-on-read
state, no cron).

## Data model

New table (additive migration `add_refund_settings`):

```prisma
// Append-only key/value config store; current value = latest row per key
// (derived on read, ADR-0013/0024). Self-auditing (ADR-0024) — the identical
// BEFORE UPDATE/DELETE raising trigger as mileage_rate / refund_audit_entry.
model RefundSetting {
  id              String   @id @default(cuid())
  key             String                    // e.g. "accounting-distribution-email"
  value           String?                   // null = cleared / not configured
  createdByUserId String                    // JWT sub, or "system:settings-cutover" (D7)
  createdByEmail  String
  createdAt       DateTime @default(now())

  @@index([key, createdAt])                 // latest-per-key + chronological history/audit
  @@map("refund_setting")
}
```

Migration raw SQL (mirrors the `mileage_rate` migration verbatim):

```sql
CREATE FUNCTION refund_setting_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'refund_setting rows are append-only and cannot be updated or deleted (id=%)', OLD.id
    USING ERRCODE = 'raise_exception';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER refund_setting_no_update BEFORE UPDATE ON "refund_setting"
  FOR EACH ROW EXECUTE FUNCTION refund_setting_immutable();
CREATE TRIGGER refund_setting_no_delete BEFORE DELETE ON "refund_setting"
  FOR EACH ROW EXECUTE FUNCTION refund_setting_immutable();
```

Batch recipient change (same migration): `ALTER TABLE "refund_batch" ALTER COLUMN
"recipientEmailSnapshot" DROP NOT NULL;` — the column is retained (non-destructive on a
financial table) but its meaning changes to nullable per-attempt delivery provenance (D6). No
`AuditAction` enum change and no `RefundAuditEntry` change (settings are not request-scoped, D3).
The `emailStatus` String column needs no DB change (free-form; only the app-boundary zod enum
widens).

**Cutover / seed (D7):** an idempotent `bun run settings:seed <email>` script that appends the
initial `refund_setting` row for `accounting-distribution-email` iff the key has no rows,
`createdByUserId = "system:settings-cutover"`, `createdByEmail = "system-cutover@welld.ch"`.
Runbook: run once immediately after deploy with the value currently in prod's
`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`; then remove the env var from the platform. Documented in
`infra/README.md`.

## API contracts

Settings surface (refund-api; RFC 7807 on all errors; dates ISO 8601):

```
GET /settings/{key}
  200 → { key, value: string | null, configured: boolean,
          updatedAt: string | null, updatedByEmail: string | null,
          history: [ { value: string | null, changedAt: string, changedByEmail: string } ] }
        // history chronological (AC-5.3); current value + updatedBy* come from the latest row
  403 → Problem (lacks settings:read)          404 → Problem (unknown key)

PUT /settings/{key}   body: { value: string | null }   // "" is normalized to null (clear)
  200 → same shape as GET (the post-write state)
  403 → Problem (lacks settings:manage)
  404 → Problem (unknown key)
  422 → Problem (value present but not a well-formed email) — nothing persisted, no audit (AC-1.3)
        // no-op (value === current, incl. null===null) → 200, no new row, no audit (AC-5.4)
```

Blocked-send contract (refund-api, D5):

```
POST /batches/{id}/email   (resend) — setting unconfigured
  422 → { type:"https://httpstatuses.com/422", title:"Unprocessable Entity", status:422,
          detail:"Set the accounting distribution email in Admin > Refund first.",
          instance, code:"accounting_distribution_email_unconfigured" }
        // side effect: batch.emailStatus := "blocked_unconfigured", emailLastAttemptAt := now
POST /batches (compile) — setting unconfigured
  201 → BatchDetail (unchanged) with emailStatus:"blocked_unconfigured"  // compile never fails (AC-2.1)
GET /batches/{id}, POST /batches/{id}/email (configured)
  → recipient resolved LIVE from the setting each time (AC-2.3); notify-api /system/emails call
    and the ADR-0011 internal-token path are byte-for-byte unchanged.
```

No change to notify-api's delivery API (ADR-0011/0021) — only the *source* of the `to` address.

## Test strategy

| AC | Level | What proves it |
|----|-------|----------------|
| AC-1.1 | refund-api integration + admin-ui component | GET returns value/`configured:false`; panel renders value or "not configured" |
| AC-1.2 | refund-api integration | PUT valid email → GET round-trips the new value |
| AC-1.3 | refund-api integration | PUT malformed → 422, latest row unchanged, no new/audit row |
| AC-1.4 | refund-api integration | PUT `""`/null → `configured:false`, new audit row old→null |
| AC-1.5 | refund-api integration | PUT new value then resend → live-resolved to the new value (no restart) |
| AC-2.1 | refund-api integration | unconfigured → POST /batches 201; items/PDF/`batch_compiled` audit all created |
| AC-2.2 | refund-api integration | unconfigured: auto-send persists `emailStatus:"blocked_unconfigured"`; resend → 422 `code` |
| AC-2.3 | refund-api integration | configured → `notifyBatchCompiled` invoked with the live setting value (assert `to`) |
| AC-2.4 | refund-api integration | compile-while-unconfigured → resend blocked → PUT value → resend → sent to new value |
| AC-2.5 | refund-api integration | `blocked_unconfigured` batch → mark-paid 200 (unchanged from any other failed delivery) |
| AC-3.1 | refund-api integration + auth unit | no `settings:read`→GET 403, no `settings:manage`→PUT 403; catalog declares `settings`, seed grants |
| AC-3.2 | admin-ui component | panel absent when `getMe()` lacks `settings:read` |
| AC-4.1 | refund-api unit/integration | env schema has no `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`; boot succeeds without it set |
| AC-4.2 | refund-api integration | `settings:seed` appends when empty; second run is a no-op (idempotent) |
| AC-4.3 | refund-api integration | (composed) unconfigured window → compile+mark-paid work, send blocked (AC-2.1/2.2/2.5) |
| AC-5.1 | refund-api integration | each transition (set/change/clear) appends a row with actor/timestamp/old→new |
| AC-5.2 | refund-api integration | raw UPDATE/DELETE on `refund_setting` raises (DB trigger, mirrors mileage_rate test) |
| AC-5.3 | refund-api integration + admin-ui component | GET history chronological; panel renders the change list |
| AC-5.4 | refund-api integration | PUT identical value → no new row, no audit, still 200 |

Mapping is **total** — every AC in the spec maps to at least one level.

## Risks

- **R1 — ADR-0021 supersession blast radius (D6).** Flipping snapshot→live changes
  `batches.routes.ts`, `batches/email.ts`, `lib/notifyEmail.ts` (drops `recipientEmail` input),
  `compileBatch`, and their existing tests (whose comments assert "never a live re-read").
  *Mitigation:* land the live-resolution + `compileBatch` signature change as one task with its
  tests rewritten in the same change; keep the column (nullable) rather than dropping it to
  avoid a destructive migration. Early check: grep for `recipientEmailSnapshot` before coding.
- **R2 — `emailStatus` enum widening.** `batches.schemas.ts` types it as `z.enum(["sent","failed"])`;
  adding `"blocked_unconfigured"` touches the schema, the two `batches.service.ts` casts, refund-ui
  copy, and the OpenAPI response. *Mitigation:* one enumerated constant reused across boundaries;
  covered by AC-2.2 tests.
- **R3 — Cutover env read vs AC-4.1 letter (D7).** A startup/transitional env read would violate
  AC-4.1. *Mitigation:* the seed is an operator-run script that takes the value as an argument —
  the server process never references the env var. Verify by asserting boot succeeds with the var
  absent (AC-4.1 test).
- **R4 — No-op suppression TOCTOU (AC-5.4).** Two concurrent PUTs could both append. *Mitigation:*
  benign for a single suite-wide setting (worst case a duplicate-value audit row); acceptable, not
  worth a lock. Noted, not mitigated in code.
- **R5 — Descriptor registry drift.** A future setting added to the store but not the registry
  would 404 on the API. *Mitigation:* the registry is the single documented seam; the store never
  invents keys the registry doesn't declare.

## Security

**Security-sensitive? YES.** This setting governs **where financial batch data (a signed deep
link covering every employee in a batch) is emailed** — a wrong or exposed value is a
misdirection/data-exposure risk. Schedule an **`owasp-reviewer` pass in parallel with QE** (this
spec is production rigor).

Surfaces to review:
- **`GET`/`PUT /settings/:key`** — server-side authz on **both read and write** (`settings:read` /
  `settings:manage`, ADR-0014, fail-closed 503), never UI-only hiding (US-3, A01/A05). The value
  is confidential to `settings:read` holders — a non-holder must not learn the mailbox.
- **Input validation** — well-formed-email only; malformed rejected with nothing persisted and no
  audit row (A03, AC-1.3). Clear is a distinct null, not an injectable value.
- **Audit immutability** — the `refund_setting` DB-level `BEFORE UPDATE/DELETE` trigger (A08/logging
  integrity, AC-5.2); actor is always the verified JWT `sub`/email, never request-body-supplied
  (A01), including the documented `system:settings-cutover` provenance for the seed.
- **The internal-token email path (ADR-0011) is unchanged** — `POST /system/emails` with
  `NOTIFY_INTERNAL_TOKEN` still carries a deep link, never a presigned URL/attachment (ADR-0021);
  only the resolved `to` value's source changes. The setting is read by refund-api's own internal
  DB call in the send path — **not** exposed on any unauthenticated endpoint.
- **Removing the env var opens no unauth path** — the send path's setting read is an internal
  server-side query; the only new externally-reachable surface is the two authz-gated settings
  endpoints. Confirm the compile/mark-paid paths remain reachable when unconfigured (AC-2.1/2.5)
  without leaking the setting.

## ADR candidates

- **Refund settings store** — the append-only key/value `refund_setting` table, current value
  derived latest-per-key, self-auditing via the ADR-0018/0024 immutability trigger; the reusable
  extensible-config pattern for the suite (D1 + D3).
- **New `settings` catalog permission** — a `settings` resource (read/manage, global/unconditioned)
  distinct from `rate`, establishing "refund config is not a rate" separation (D2).
- **Batch email recipient resolves live** — supersedes ADR-0021's compile-time
  `recipientEmailSnapshot` freeze; the column becomes nullable per-attempt delivery provenance, and
  the blocked-send contract (`422` + `code:"accounting_distribution_email_unconfigured"` +
  `emailStatus:"blocked_unconfigured"`) is introduced (D5 + D6). This one directly amends a prior
  ADR and most warrants an `adr-writer` pass.

The D7 cutover (seed-via-script) is an ops runbook decision, documented in `infra/README.md`, not a
standalone ADR.

## Spec amendments proposed

None. Every open question was answerable within the spec's stated boundaries; the AC→test mapping
is total with no AC that could not be mapped.
