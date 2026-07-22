---
spec: 011
generated: 2026-07-22
---

# Tasks: Refund settings — admin-managed accounting distribution email

Derived from the approved `plan.md`. Levels: unit = pure fn; integration = route + Prisma
(test DB); component = UI (Vitest + Testing Library); e2e = Playwright. Domains in brackets.

- [x] T1: auth — declare `settings` resource (read/manage) + seed grants — refs: AC-3.1 — deps: none  **[backend-dev]**
  - touch: `auth/src/authz/catalogs/refund.ts`, `auth/src/authz/seed.ts` (+ catalog/seed tests)
  - Add a NEW `settings` resource to refund's catalog with `read` + `manage` actions, **unconditioned** (global, like `rate` — ADR-0023/0028). Add `seedSettingsAdminGrants()` granting `settings:read` + `settings:manage` to `admin` + `refund-admin` (mirror `seedRateAdminGrants`), wired into `seed()`. NOT a reuse of `rate:manage`.
  - done when: catalog snapshot asserts `settings:read`/`settings:manage` present + only on `settings`; `GET /admin/catalog` exposes them; seed grants both to `admin`/`refund-admin`; existing rules resolve unchanged.

- [x] T2: refund-api — `RefundSetting` schema + additive migration — refs: AC-5.2, US-3 — deps: none  **[backend-dev]**
  - touch: `refund-api/prisma/schema.prisma`, new migration `add_refund_settings`
  - New `RefundSetting` model (id, key, value String?, createdByUserId, createdByEmail, createdAt; `@@index([key, createdAt])`; `@@map("refund_setting")`) with the VERBATIM `mileage_rate` `BEFORE UPDATE/DELETE` immutability trigger (append-only, ADR-0024/0027). Same migration: `ALTER TABLE "refund_batch" ALTER COLUMN "recipientEmailSnapshot" DROP NOT NULL` (ADR-0029 — column repurposed to nullable per-attempt provenance; non-destructive). Additive only; no data backfill.
  - done when: `prisma migrate` applies clean on the test DB; a raw `UPDATE`/`DELETE` on `refund_setting` raises (test mirrors `db.mileage-rate-immutability`); `recipientEmailSnapshot` is nullable.

- [x] T3: refund-api — `settings` module (routes/service/repo/schemas + descriptor registry) — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-3.1, AC-5.1, AC-5.3, AC-5.4 — deps: T2  **[backend-dev]**
  - touch: new `refund-api/src/settings/` (repo.ts, service.ts, schemas.ts, routes.ts, registry.ts), register in `src/index.ts` + OpenAPI (+ integration tests)
  - Append-only key/value store; current value = latest-per-key (derived on read). A descriptor **registry** maps `key → {label, validate}`; unknown key → 404; the one registered key `accounting-distribution-email` validates a well-formed email (empty→null clears). `GET /settings/:key` (gate `settings:read`) → `{key, value, configured, updatedAt, updatedByEmail, history[]}`. `PUT /settings/:key` (gate `settings:manage`, body `{value: string|null}`) → 422 on malformed (nothing persisted, no audit), no-op suppressed (value===current → 200, no new row), else append a row (actor from JWT, never body). Via existing `authzMiddleware`/`hasCapability`, fail-closed 503.
  - done when: integration proves GET value/`configured:false`; PUT valid round-trips; malformed → 422 unchanged; clear → configured:false + audit row old→null; each transition appends actor/ts/old→new; no-op → no row; history chronological; 403 without the capability; unknown key → 404.

- [x] T4: refund-api — live recipient resolution + blocked-send + env removal — refs: AC-1.5, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-4.1, AC-4.3 — deps: T2, T3  **[backend-dev]**
  - touch: `refund-api/src/batches/batches.routes.ts` (drop the `env.REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` read + `compileBatch`'s recipient param), `batches/email.ts` / `lib/notifyEmail.ts` (resolve the LIVE setting at each send/resend), `batches.schemas.ts`/`batches.service.ts` (widen `emailStatus` enum with `"blocked_unconfigured"`), `refund-api/src/lib/env.ts` (remove `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`) (+ integration tests; rewrite the existing "never a live re-read" batch-email tests — R1)
  - ADR-0029: send/resend resolve the live setting. Unconfigured → persist `emailStatus:"blocked_unconfigured"`; a **resend** returns 422 + `code:"accounting_distribution_email_unconfigured"` (distinguishable from a notify outage's best-effort 200/`failed`). Compile never fails (AC-2.1); mark-paid never blocked (AC-2.5). Configured → send to the live value (assert `to`), recorded as delivery provenance. `env.ts` no longer reads/validates the env var; boot succeeds without it (AC-4.1).
  - done when: unconfigured compile → 201 + items/PDF/audit; unconfigured resend → 422 `code` + `blocked_unconfigured`; configured send uses the live value; set-then-resend reaches the new value (AC-1.5/2.4); mark-paid on a blocked batch → 200; boot succeeds with the env var absent; existing snapshot tests rewritten for live behavior.

- [x] T5: refund-api — cutover seed script + runbook — refs: AC-4.2 — deps: T2, T3  **[backend-dev / devops]**
  - touch: `refund-api/scripts/seed-setting.ts` (or a `bun run settings:seed` package script), `infra/README.md`
  - Idempotent operator-run `bun run settings:seed <email>`: appends the initial `accounting-distribution-email` row iff the key has no rows (`createdByUserId:"system:settings-cutover"`, `createdByEmail:"system-cutover@welld.ch"`); a second run is a no-op. Document the runbook (run once post-deploy with the current prod value, then remove `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` from the platform). The RUNNING server never reads the env var.
  - done when: integration/test proves seed appends when empty + is idempotent on a second run; infra/README documents the cutover.

- [x] T6: admin-ui — Refund-tab distribution-email panel + `settingsApi.ts` — refs: AC-1.1, AC-3.2, AC-5.3 — deps: T3 (contract; mock in tests)  **[frontend-dev]**
  - touch: new `admin-ui/src/lib/settingsApi.ts` (mirror `ratesApi.ts` — `apiFetch` + `getRefundApiBaseUrl` from `shell/session`), `admin-ui/src/pages/MileageRatesPage.tsx` (add a capability-gated "Accounting distribution email" panel: view current / "not configured", edit + save, clear, inline validation error, change-history list) (+ component tests)
  - Panel visibility gated on `settings:read` via the same `getMe()` pattern the rate section uses (server enforces the real boundary). Match admin-ui house style (inline copy, no strings.ts). `PUT` maps the 422 malformed-email error to an inline message.
  - done when: component tests cover render (value / not-configured), save valid, 422 shown inline, clear, history render, and the panel hidden without `settings:read`.

- [x] T7: refund-ui — map `blocked_unconfigured` delivery status — refs: AC-2.2 (UI) — deps: none (contract; mock)  **[frontend-dev]**
  - touch: refund-ui batch detail delivery-status display, `refund-ui/src/strings.ts` (+ component tests)
  - Map `emailStatus:"blocked_unconfigured"` to an actionable, distinguishable message ("Set the accounting distribution email in Admin > Refund first"), distinct from an ordinary delivery failure. Copy via `strings.ts`.
  - done when: component test renders the distinguishable blocked message for that status, and the ordinary `failed` status still renders its own copy.

- [x] T8: e2e — settings → batch email journey — refs: US-1, US-2, US-4 — deps: T1, T3, T4, T6, T7  **[quality-engineer]**
  - touch: `shell/e2e/refund-settings.spec.ts`
  - Admin sets the distribution email in Admin > Refund → compile a batch → its email targets that address; clear/unset → the send is blocked with the distinguishable message while compile + mark-paid still succeed.
  - done when: the Playwright path passes against the running stack (or is authored + committed with each AC independently proven at integration/component level, per the 007–010 env-blocked posture).

- [x] T9: close — all gates green, spec status → done — deps: T1–T8
  - done when: every task checked, QE PASS + owasp clean (≥medium fixed), eval PASS; spec `status: done`.

## Coverage map (AC → task)

AC-1.1 T3,T6 · AC-1.2 T3 · AC-1.3 T3 · AC-1.4 T3 · AC-1.5 T3,T4 · AC-2.1 T4 · AC-2.2 T4,T7 · AC-2.3 T4 · AC-2.4 T4 · AC-2.5 T4 · AC-3.1 T1,T3 · AC-3.2 T6 · AC-4.1 T4 · AC-4.2 T5 · AC-4.3 T4 · AC-5.1 T3 · AC-5.2 T2 · AC-5.3 T3,T6 · AC-5.4 T3.

Every AC covered by ≥1 task; every task serves ≥1 AC. Parallelizable waves:
W1 {T1, T2, T6, T7} · W2 {T3} · W3 {T4, T5} · W4 {T8} · close T9.
