---
spec: 009
generated: 2026-07-20
---

# Tasks: Mileage rate — computed amounts for travel-km expense lines

Derived from the approved `plan.md`. Levels: unit = pure fn (Vitest); integration =
refund-api route + Prisma (test DB); component = UI (Vitest + Testing Library);
e2e = Playwright. Domains in brackets guide agent dispatch.

- [x] T1: auth catalog + seed — declare the `rate` resource — refs: AC-4.6 — deps: none  **[backend-dev]**
  - touch: `auth/src/authz/catalogs/refund.ts`, `auth/src/authz/seed.ts` (+ tests)
  - Add a `rate` resource with `read` + `manage` actions to refund's catalog (unconditioned, no entity condition — Decision 2). Seed grants `rate:read` + `rate:manage` to the `admin` and `refund-admin` system roles.
  - done when: catalog unit/integration test asserts `rate:read`/`rate:manage` present + granted to `admin`/`refund-admin`; `GET /admin/catalog` exposes them (composer picks them up with zero admin-ui change).

- [x] T2: refund-api schema + additive migration — refs: AC-4.7, AC-5.2, AC-1.6, US-3 — deps: none  **[backend-dev]**
  - touch: `refund-api/prisma/schema.prisma`, new `refund-api/prisma/migrations/<ts>_mileage_rate/`
  - New `MileageRate` model (entity, currency, ratePerKmMicros, validFrom `@db.Date`, createdByUserId, createdByEmail, createdAt; indexes `[entity,validFrom]` + `[entity,createdAt]`; `@@map("mileage_rate")`). Add the `BEFORE UPDATE/DELETE` immutability trigger (copy the `refund_audit_entry` pattern verbatim — R7). Add three nullable columns to `RefundLine`: `appliedRateMicros Int?`, `appliedRateValidFrom DateTime? @db.Date`, `appliedRateEntryId String?` + relation to `MileageRate` (`onDelete: Restrict`). Additive only — never edit an existing migration. No data backfill.
  - done when: `prisma migrate` applies clean on the test DB; a direct `UPDATE`/`DELETE` on `mileage_rate` raises.

- [x] T3: refund-api rate resolution + computation (pure) — refs: AC-2.1, AC-2.3, AC-2.4, AC-4.4, Decision 3 — deps: T2  **[backend-dev]**
  - touch: `refund-api/src/rates/resolve.ts`, `refund-api/src/rates/computeMileageAmountCents.ts` (+ unit tests + shared test-vector fixture)
  - `resolveEffectiveRate(entries, entity, date)` = latest `validFrom ≤ date` per entity, independent series, future entries ignored. `computeMileageAmountCents(km, ratePerKmMicros)` = `roundHalfUp(km × ratePerKmMicros / 10_000)`, integer-only, single rounding (Decision 3). Export a shared test-vector JSON reused by refund-ui (R1).
  - done when: unit vectors pass incl. half-up ties, future-date exclusion, two-entity independence, no-rate case.

- [x] T4: refund-api rates module (routes/service/repo/schemas) — refs: AC-4.1, AC-4.2, AC-4.3, AC-4.5, AC-4.6, AC-4.7, AC-4.8, AC-5.1, AC-5.3, AC-2.1, AC-2.2 — deps: T2, T3  **[backend-dev]**
  - touch: new `refund-api/src/rates/` (routes.ts, service.ts, repo.ts, schemas.ts), register in `src/index.ts`, OpenAPI (+ integration tests)
  - `GET /rates` (gate `rate:read`) → per-entity history + `currentEntryId`/`inEffectToday` (also the audit view). `POST /rates` (gate `rate:manage`) → append one entry; 422 on non-positive value / bad `validFrom`; server derives `currency` from entity, `ratePerKmMicros` from decimal input, `createdBy*` from JWT (never body); no PUT/PATCH/DELETE route. `GET /rates/effective?entity=&date=` (gate `refund:access` only) → effective rate or `{inEffect:false}`. All via existing `authzMiddleware`/`hasCapability`, fail-closed 503 on auth outage.
  - done when: integration tests green for history/ordering, append+resolve, 422 validation, 403 without capability, effective resolution, and `GET /rates/effective` leaks nothing beyond the effective rate.

- [x] T5: refund-api line response + travel_km write derivation — refs: AC-1.1, AC-1.6, AC-1.7, AC-1.8, AC-2.2, AC-3.2, AC-3.3, AC-6.4 — deps: T2, T3  **[backend-dev]**
  - touch: `refund-api/src/requests/mapLine.ts` (or equivalent), line create/update service, schemas (+ integration tests)
  - `mapLine` gains nested `mileage { km, rateInEffect, appliedRate, computedAmountCents, snapshotted }` (null for non-travel_km). On a travel_km line write: server forces `currency` from entity, ignores client `requestedAmountCents`/`currency`, and writes the recomputed cents. On `GET /requests/:id`: recompute each *draft* travel_km line from current config (derived-on-read); a decided/submitted line returns its stored snapshot (never recomputed). Legacy null `appliedRate` maps gracefully.
  - done when: integration tests cover the nested object, server-derived currency + ignored client amount, draft recompute vs submitted snapshot, legacy-null render.

- [x] T6: refund-api submit/withdraw snapshot — refs: AC-3.1, AC-3.2, AC-1.4, AC-2.2, Decision 1 — deps: T3, T5  **[backend-dev]**
  - touch: `refund-api/src/requests/lifecycle.repo.ts` (submit + withdraw transactions) (+ integration tests)
  - Inside the submit transaction: re-resolve each travel_km line's effective rate; if any not in effect (AC-2.2) or `km ≤ 0` (AC-1.4) → 422 with `fields.offendingLineIds` (007 shape); else write `requestedAmountCents` + `appliedRate*` and flip to `submitted`. Withdraw clears `appliedRate*` on every travel_km line in the same transaction.
  - done when: integration proves submit writes the snapshot, a later backdated rate leaves it frozen (AC-3.1), withdraw nulls it and re-read recomputes live (AC-3.2), no-rate/km≤0 blocks submit.

- [x] T7: refund-api immutability + downstream (subtotal/batch) integration — refs: AC-4.7, AC-5.2, AC-6.1, AC-6.2, AC-6.3 — deps: T2, T4, T6  **[backend-dev]**
  - touch: `refund-api/test/db.mileage-rate-immutability.test.ts` (mirror `db.audit-immutability.test.ts`), subtotal/batch integration tests
  - DB-trigger raises on direct UPDATE/DELETE. A travel_km line's computed amount folds into the existing per-currency subtotal (`computeSubtotals`) and 008 batch totals/PDF with no special-casing; approved-total remains independently editable above/below the computed amount.
  - done when: immutability test + subtotal/batch integration tests green with no mileage special-case in downstream code.

- [x] T8: devops — refund-api CORS allowlist gains admin-ui origin — refs: R8, Security A05 — deps: none  **[devops]**
  - touch: `refund-api` env docs / `.env.example`, `infra/README.md`, CORS `ALLOWED_ORIGINS` handling
  - Add admin-ui's exact origin(s) per environment to refund-api's `ALLOWED_ORIGINS` (Hono CORS only; must NOT widen better-auth `trustedOrigins`). Document the local/dev/preview/prod origins.
  - done when: an OPTIONS/preflight from admin-ui's origin to `/rates` is allowed in local dev; documented per env; verified in the e2e (T15).

- [x] T9: shell — `getRefundApiBaseUrl()` export — refs: R8 — deps: none  **[frontend-dev]**
  - touch: `shell/src/lib/session.ts` (+ its exposed session module) (+ unit test)
  - Add a `getRefundApiBaseUrl()` getter mirroring the existing `getAuthBaseUrl()`, exposed from `shell/session` so remotes source refund-api's origin from the shell (remotes carry no env).
  - done when: exported + unit-tested; consumable by admin-ui.

- [x] T10: admin-ui `ratesApi.ts` client — refs: admin-ui→refund-api wiring — deps: T9  **[frontend-dev]**
  - touch: `admin-ui/src/lib/ratesApi.ts` (+ `ratesApi.test.ts`, mirroring `adminApi.test.ts`)
  - Mirror `adminApi.ts`: import `apiFetch` + `getRefundApiBaseUrl` from `shell/session` (NOT `import.meta.env`). Methods: `listRates()` (GET /rates), `addRate({entity, ratePerKm, validFrom})` (POST /rates).
  - done when: unit test proves it uses `apiFetch` + the shell base URL (not env), and maps the response/errors.

- [x] T11: admin-ui Mileage Rates screen — refs: AC-4.1, AC-4.2, AC-4.3, AC-4.5, AC-4.6, AC-5.3 — deps: T10  **[frontend-dev]**
  - touch: new `admin-ui/src/pages/MileageRatesPage.tsx`, `admin-ui/src/components/AddRateEntryModal.tsx`, `RateInEffectBadge.tsx`; `SectionNav`/route; `PermissionDenied` gains a `message` prop (design gap) (+ component tests)
  - Per-entity history table (value + validFrom, current-in-effect highlighted), add-rate modal (positive value + validFrom, backdating allowed, append-only — no edit/delete affordances), audit list. Nav entry + route gated client-side on `rate:manage` (UX only). States L/E/P/Err/PD. Match admin-ui's house style + inline-copy convention (no strings.ts in admin-ui — carried as pre-existing). Focus returns to trigger after a successful add.
  - done when: component tests cover history render, add-entry submit via `ratesApi`, in-effect highlight, 422 surfaced, section hidden/denied without `rate:manage`.

- [x] T12: refund-ui rate lib — `ratesApi` + shared `computeMileageAmountCents` — refs: AC-1.2, Decision 3, R1 — deps: none  **[frontend-dev]**
  - touch: `refund-ui/src/lib/ratesApi.ts` (GET /rates/effective via apiFetch), `refund-ui/src/lib/computeMileageAmountCents.ts` (+ unit tests using the SHARED vectors from T3)
  - Mirror refund-api's rounding rule exactly; consume the shared test-vector fixture so client == server (R1).
  - done when: unit tests pass against the shared vectors, identical results to refund-api.

- [x] T13: refund-ui employee mileage line — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.5, AC-1.6, AC-1.8, AC-2.2 — deps: T12  **[frontend-dev]**
  - touch: new `refund-ui/src/components/MileageAmountField.tsx`; `ExpenseLineComposer.tsx`, `ExpenseLineRow.tsx`; `strings.ts` (+ component tests)
  - For travel_km: hide amount + currency inputs, render read-only computed amount with the `km × rate = amount` breakdown (aria-live), live recompute on km/entity/date change (debounced `GET /rates/effective`), entity-designated currency shown, blocked "no rate configured" state (`role="status"`) that also blocks submit. Non-travel_km unchanged. `km > 0` preserved.
  - done when: component tests cover hidden inputs, live breakdown, blocked state, entity currency, non-mileage untouched.

- [x] T14: refund-ui accounting review — applied rate display — refs: AC-6.4 — deps: T12  **[frontend-dev]**
  - touch: `refund-ui/src/pages/ReviewDetailPage.tsx` / `ExpenseLineRow.tsx` (review mode); `strings.ts` (+ component tests)
  - Show the applied rate (value + validFrom) alongside each mileage line's amount during review, without disturbing the approved-total editing (AC-6.1). Legacy null `appliedRate` renders gracefully (amount only, no breakdown).
  - done when: component test renders applied rate + validFrom in review mode; null case omits the breakdown, keeps the amount.

- [ ] T15: e2e — cross-service mileage flow — refs: US-4, US-1, US-2, US-3, US-6 — deps: T7, T8, T11, T13, T14  **[quality-engineer]**
  - touch: `shell/e2e/mileage-rate.spec.ts` (seeded-session helper)
  - admin adds a rate in admin-ui → employee drafts a travel_km line + submits in refund-ui → accounting reviews and sees the applied rate; assert the computed amount and the snapshot freeze.
  - done when: the Playwright path passes against the running stack (or is authored + committed with each AC it exercises independently proven at integration level, mirroring 007/008 if 1Password-gated env blocks the live run).

- [ ] T16: close — all gates green, spec status → done — deps: T1–T15
  - done when: every task checked, QE PASS + owasp clean (≥medium fixed), eval PASS; spec `status: done`.

## Coverage map (AC → task)

AC-1.1 T5,T13 · AC-1.2 T12,T13 · AC-1.3 T13 · AC-1.4 T6 · AC-1.5 T13 · AC-1.6 T5,T13 · AC-1.7 T5 · AC-1.8 T5,T13 · AC-2.1 T3,T4 · AC-2.2 T4,T5,T6,T13 · AC-2.3 T3 · AC-2.4 T3,T5 · AC-3.1 T6 · AC-3.2 T5,T6 · AC-3.3 T5 · AC-4.1 T4,T11 · AC-4.2 T4,T11 · AC-4.3 T4,T11 · AC-4.4 T3 · AC-4.5 T4,T11 · AC-4.6 T1,T4,T11 · AC-4.7 T2,T4,T7 · AC-4.8 T4 · AC-5.1 T4 · AC-5.2 T2,T7 · AC-5.3 T4,T11 · AC-6.1 T7 · AC-6.2 T7 · AC-6.3 T7 · AC-6.4 T5,T14 · Decision 1 T6 · Decision 3 T3,T12 · catalog/seed T1 · admin-ui wiring T10.

Every AC is covered by ≥1 task; every task serves ≥1 AC. Parallelizable waves:
W1 {T1,T2,T8,T9,T12} · W2 {T3,T10} · W3 {T4,T5,T11,T13,T14} · W4 {T6} → {T7} · W5 {T15} · close T16.
