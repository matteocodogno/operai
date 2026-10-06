---
spec: 015
generated: 2026-10-06
synced: 2026-10-06
---

# Tasks: Hardware inventory and depreciation register

Derived from `plan.md` (approved 2026-10-06, amended the same day) and `design.md`
(including its Resolutions section). Tier: `production`. Five tracks:

- **Platform** — `auth` (T3–T5), `notify-api` + mirrors (T6), run in parallel with everything else.
- **`inventory-api`** — T1, T2, T7–T23.
- **`inventory-ui`** — T24–T40.
- **`shell`** — T41, T42.
- **Close-out** — T43–T46.

Two scaffolds exist to keep later tasks from colliding on shared files:

- T1 creates one **stub router file per route group** and mounts them all in
  `src/index.ts`, so no later backend task touches `index.ts`.
- T24 creates the **route tree with placeholder pages** and one **strings file per
  namespace** under `src/strings/`, so no later UI task touches `router.tsx` or a shared
  strings file. T32 does the same for the asset detail page's four regions.

A task that needs to edit one of those shared files is drift on this list — stop and
re-sync. No change to `auth` or `notify-api` database schemas is planned; a task
proposing one is drift on the plan.

Label in brackets picks the agent: `[backend]`, `[frontend]`, `[devops]`, `[qe]`.

## Platform

- [ ] T1: [devops] Scaffold `inventory-api` and wire it into the repo — refs: AC-9.7 — deps: none
  - touch: `inventory-api/package.json`, `inventory-api/bun.lock`, `inventory-api/bunfig.toml`, `inventory-api/tsconfig.json`, `inventory-api/Dockerfile`, `inventory-api/railway.json`, `inventory-api/prisma.config.ts`, `inventory-api/.env.example`, `inventory-api/.envrc`, `inventory-api/CHANGELOG.md`, `inventory-api/src/index.ts`, `inventory-api/src/lib/env.ts`, `inventory-api/src/lib/db.ts`, `inventory-api/src/lib/errors.ts`, `inventory-api/src/lib/logger.ts`, `inventory-api/src/health/*`, `inventory-api/src/openapi/*`, `inventory-api/src/*/*.routes.ts`, `compose.yaml`, `mise.toml`, `lerna.json`, `scripts/check-changeset.mjs`, `.github/workflows/changeset-check.yml`
  - Copy `refund-api`'s shape (Bun + Hono + zod-openapi, RFC 7807 `onError`/`notFound`, port 8083, EU Railway region). `env.ts` validates **every** variable in plan § Environment for `inventory-api`, including `INVENTORY_S3_*` with the EU allowlist check and `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET`. `package.json` already carries the dependencies later tasks need (the S3 client and presigner for T21, a spreadsheet reader for T23), so no later backend task edits it.
  - Create these router files, each exporting an empty `OpenAPIHono`, all mounted in `index.ts`: `scope/scope.routes.ts`, `me/me.routes.ts`, `assets/read.routes.ts`, `assets/register.routes.ts`, `assets/edit.routes.ts`, `assets/transitions.routes.ts`, `assignments/assignments.routes.ts`, `ledger/dispose.routes.ts`, `depreciation/rules.routes.ts`, `fiscal-years/read.routes.ts`, `fiscal-years/close.routes.ts`, `invoices/invoices.routes.ts`, `history/history.routes.ts`.
  - done when: `cd inventory-api && bun run typecheck` passes; `bun run dev` serves `GET /health` 200 and `/openapi.json` on :8083; starting with `INVENTORY_S3_REGION=us-east-1` exits non-zero; `mise run dev` starts the service; `mise run changeset:check` recognises `inventory-api`.

- [ ] T2: [backend] Prisma schema, initial migration and DB test support — refs: AC-1.2, AC-1.5, AC-2.2, AC-6.5, AC-6.6, AC-8.7, AC-11.2 — deps: T1
  - touch: `inventory-api/prisma/schema.prisma`, `inventory-api/prisma/migrations/*`, `inventory-api/src/test-support/dbCleanup.ts`, `inventory-api/src/test-support/immutability.test.ts`
  - Everything in plan § Data model: the eight models, the two partial unique indexes, the four `CHECK`s, the raising `BEFORE UPDATE/DELETE` triggers on `depreciation_rule`, `fiscal_year`, `asset_year_figure`, `asset_event`, and the two seeded launch rules (actor `system:launch-seed`).
  - done when: `bun run db:migrate` applies on an empty DB; `bun test immutability` proves a raw `UPDATE` and `DELETE` raise on each of the four tables, a `welld_ch`/`EUR` asset insert violates its `CHECK`, a second live asset with the same entity+serial is rejected while one after disposal is accepted, a second `pending` assignment on one asset is rejected, and both launch rules exist with the values of AC-5.1 / AC-5.4.

- [ ] T3: [backend] `auth`: inventory permission catalog and seeded grants — refs: AC-9.1, AC-9.3, AC-9.4, AC-9.5, AC-9.6 — deps: none
  - touch: `auth/src/authz/catalogs/inventory.ts`, `auth/src/authz/catalogs/inventory.test.ts`, `auth/src/authz/seed.ts`, `auth/src/authz/seed.test.ts`
  - Catalog per plan § Authorization model (`inventory:access`, `asset:manage` and `ledger:manage` with `supportedConditions: ["entity"]`). Seed: `admin` all three unconditioned; `accounting` gets `inventory:access` + `ledger:manage` with the entity condition; new system role `inventory-manager` gets `inventory:access` + `asset:manage` with the entity condition. `inventory` must not also be registered through `SUITE_APPS`.
  - done when: `cd auth && bun test catalogs/inventory seed` passes, asserting the catalog shape, each role's grants and conditions, idempotent re-seed, and that `GET /authz/resolve` for an `accounting` user returns `ledger:manage` with the entity attribute.

- [ ] T4: [backend] `auth`: `POST /system/service-token` (scoped service JWT) — refs: AC-2.8, AC-2.9 — deps: none
  - touch: `auth/src/system/*`, `auth/src/lib/env.ts`, `auth/src/index.ts`, `auth/.env.example`
  - **Do the plan's R-4 early check first**: a contract test that a minted token verifies through `jose createRemoteJWKSet` against auth's JWKS with `audience: SERVICE_AUDIENCE`. If better-auth's jwt plugin cannot mint a non-user token with the same `kid`, sign with `jose` using `JWT_PRIVATE_KEY` (the plan's stated fallback) and say so in the task report.
  - Contract in plan § API contracts / `auth` and ADR-0044: client-credentials against `SERVICE_CLIENTS`, constant-time compare, identical 401 for unknown client and wrong secret, 5-minute RS256 token (`sub="system:<clientId>"`, `aud=SERVICE_AUDIENCE`, `scope` from the client entry), own rate-limit env pair.
  - done when: `cd auth && bun test system` passes: claims and expiry correct; unknown client and wrong secret return byte-identical 401 bodies; 429 with `Retry-After` past the limit; the token is rejected when verified with `audience: AUTH_AUDIENCE`; startup exits non-zero when `SERVICE_AUDIENCE` equals `AUTH_AUDIENCE`.

- [ ] T5: [backend] `auth`: `GET /authz/users/directory` — refs: AC-2.1, AC-3.7 — deps: T3, T4
  - touch: `auth/src/authz/directory.routes.ts`, `auth/src/authz/directory.routes.test.ts`, `auth/src/lib/env.ts`, `auth/src/index.ts`, `auth/.env.example`
  - Contract in plan § API contracts / `auth` and ADR-0047. Depends on T4 only because both edit `env.ts` and `index.ts`.
  - done when: `cd auth && bun test directory` passes: a holder of `asset:manage` gets active users of both entities, name-sorted, each with exactly `id`, `name`, `email`, `entity`; a soft-deleted user is absent; a caller without `asset:manage` (including one with only `ledger:manage`) gets 403; 429 past the limit.

- [ ] T6: [backend] `notify-api`: accept the scoped service JWT, add origin app `inventory` — refs: AC-2.8, AC-2.9 — deps: none
  - touch: `notify-api/src/system/*`, `notify-api/src/notifications/notifications.schemas.ts`, `notify-api/src/lib/env.ts`, `notify-api/.env.example`, `notify-ui/src/lib/severity.ts`, `notify-ui/src/lib/severity.test.ts`, `shell/src/lib/notifications.ts`, `shell/src/lib/notifications.test.ts`
  - `/system/notifications` accepts `X-Internal-Token` **or** `Authorization: Bearer` verified via the existing JWKS with `audience: SERVICE_AUDIENCE` and `scope` containing `notifications.push`. `/system/emails` stays token-only. `ORIGIN_APPS` gains `"inventory"`, and its two client mirrors (`NotificationOriginApp` in `notify-ui` and `shell`) gain the same value with a label.
  - done when: `cd notify-api && bun test system` passes: service JWT accepted; legacy token still accepted; user JWT, wrong `aud`, missing scope and expired token each 401; `/system/emails` rejects the service JWT; a body with `originApp:"inventory"` is stored. `pnpm --dir notify-ui test` and `pnpm --dir shell test notifications` pass with the new origin rendered.

## inventory-api

- [ ] T7: [backend] JWT + authorization middleware, entity scope, `GET /scope` — refs: AC-9.4, AC-9.5, AC-9.7 — deps: T1
  - touch: `inventory-api/src/auth/*`, `inventory-api/src/authz/*`, `inventory-api/src/scope/*`, `inventory-api/src/test-support/testAuth.ts`
  - Port `refund-api/src/auth/{jwt,authz}.middleware.ts` and `src/authz/{resolveClient,conditions}.ts`. Add `scopeFor(permissions, resource, action, callerEntity) → Entity[]` and `assetInScope(asset, scope)`. `GET /scope` per plan (no capability required, through `authzMiddleware`).
  - done when: `bun test auth authz scope` passes: conditioned grant → `[user.entity]`; unconditioned → both; conditioned with null `user.entity` → `[]`; widest-wins across two grants; `auth` unreachable → 503 Problem JSON; cache keyed by `(sub, perm_epoch)`; `GET /scope` returns both lists for each case.

- [ ] T8: [backend] Depreciation maths and canonical vectors — refs: AC-1.3, AC-5.1, AC-5.2, AC-5.3, AC-5.4, AC-5.5, AC-5.6, AC-7.2, AC-7.7, AC-7.8, AC-12.5 — deps: T1
  - touch: `inventory-api/src/depreciation/schedule.ts`, `inventory-api/src/depreciation/schedule.test.ts`, `inventory-api/src/depreciation/money.ts`, `inventory-api/src/depreciation/money.test.ts`, `inventory-api/src/depreciation/schedule-vectors.json`
  - Pure, no I/O: `roundHalfUp`, `splitPrice(totalCents, n)`, `schedule(priceCents, purchaseYear, rule, anchor?)`, `yearFigure(asset, year)` returning `{opening, purchase, depreciation, disposal, closing}` including the disposal rules — exactly plan § Schedule function.
  - done when: `bun test depreciation` passes every vector the plan lists (99815/CH; 100000/IT; 51646 and 51647/IT; anchor 53255,k=2), plus: 1 Jan and 31 Dec purchases give equal year-1 amounts; book value stays at residual after the schedule; disposal in the purchase year puts the price on the disposal figure with zero depreciation; `splitPrice(294635, 13)` sums to 294635 with the remainder on the last element.

- [ ] T9: [backend] Shared write helpers: closed-year guard, entity lock, history recorder, identities client — refs: AC-1.7, AC-11.1 — deps: T2
  - touch: `inventory-api/src/fiscal-years/guard.ts`, `inventory-api/src/fiscal-years/guard.test.ts`, `inventory-api/src/history/record.ts`, `inventory-api/src/history/record.test.ts`, `inventory-api/src/lib/identities.ts`, `inventory-api/src/lib/identities.test.ts`
  - `lockEntity(tx, entity)` (`pg_advisory_xact_lock`), `isClosed(tx, entity, year)` (`year <= max(fiscal_year.year)`), `assertYearOpen` raising the `fiscal_year_closed` problem; `recordEvent(tx, {...})` storing typed `changes`; `resolveIdentities(ids)` calling `auth POST /authz/users/identities` in chunks of 100, failing soft to `unknown`, and mapping `system:*` ids to status `system` without a network call.
  - done when: `bun test fiscal-years/guard history/record lib/identities` passes, including two concurrent transactions on one entity serialising on the lock, and identities returning `unknown` when `auth` is down.

- [ ] T10: [backend] Depreciation rules: resolve-on-read, `GET /rules`, `POST /rules` — refs: AC-6.1, AC-6.2, AC-6.3, AC-6.4, AC-6.5 — deps: T7, T9
  - touch: `inventory-api/src/depreciation/rules.routes.ts`, `inventory-api/src/depreciation/rules.repo.ts`, `inventory-api/src/depreciation/rules.schemas.ts`, `inventory-api/src/depreciation/resolveRule.ts`, `inventory-api/src/depreciation/rules.test.ts`
  - `resolveRule(rules, entity, purchaseDate)` = latest `effectiveFrom <= purchaseDate`, ties by `createdAt`. `ledger:manage` with entity scope on both routes.
  - done when: `bun test depreciation/rules` passes: list marks `inForceId` and includes past and future rules with creator and time; a rule effective in a closed year → 409 `fiscal_year_closed`; life < 1, negative threshold or negative residual → 422 naming `field`; a new rule at D changes `resolveRule` only for purchase dates ≥ D; out-of-scope entity → 404; `asset:manage`-only caller → 403.

- [ ] T11: [backend] Register assets (`POST /assets`) — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-1.7, AC-10.2 — deps: T7, T8, T9
  - touch: `inventory-api/src/assets/register.routes.ts`, `inventory-api/src/assets/register.schemas.ts`, `inventory-api/src/assets/register.repo.ts`, `inventory-api/src/assets/register.test.ts`, `inventory-api/src/assets/view.ts`
  - `view.ts` owns the `AssetView` serializer without `ledger` (T12 adds the ledger projection in its own file).
  - done when: `bun test assets/register` passes: `in_stock` vs `ordered` by `received`; currency follows entity; quantity N creates N assets whose prices sum to the total and share supplier and invoice reference; no serial accepted; `serialNumbers` of the wrong length → 422 `serial_count_mismatch`; duplicate live serial → 409 `serial_conflict` with `assetId`; each missing field or price ≤ 0 → 422 and zero rows; purchase date in a closed year → 409; entity out of scope → 403; one `registered` event per asset.

- [ ] T12: [backend] Read assets: list, filters, search, detail, capability projections — refs: AC-3.7, AC-3.8, AC-4.3, AC-5.7, AC-5.8, AC-9.2, AC-10.3, AC-12.10 — deps: T10, T11
  - touch: `inventory-api/src/assets/read.routes.ts`, `inventory-api/src/assets/read.repo.ts`, `inventory-api/src/assets/read.schemas.ts`, `inventory-api/src/assets/ledgerView.ts`, `inventory-api/src/assets/read.test.ts`
  - `ledgerView.ts` builds `Ledger` from stored `asset_year_figure` rows for closed years and `schedule()` for open ones. List items carry `ledger: { bookValueCents }` only.
  - done when: `bun test assets/read` passes: each filter alone and combined; `q` case-insensitive on description and serial; order purchase date desc then id with a stable cursor; entity scope applied to list and detail (out-of-scope detail → 404); caller with neither capability → 403 on list and 404 on detail; inventory-only response has `purchasePriceCents` and no `ledger` key; accountant detail has every schedule year with `closed` flags and `rule.effectiveFrom`; an `ordered` asset's schedule starts in its purchase year.

- [ ] T13: [backend] Edit assets (`PATCH /assets/{id}`) — refs: AC-1.9, AC-3.6, AC-5.9, AC-10.1 — deps: T12
  - touch: `inventory-api/src/assets/edit.routes.ts`, `inventory-api/src/assets/edit.schemas.ts`, `inventory-api/src/assets/edit.repo.ts`, `inventory-api/src/assets/edit.test.ts`
  - done when: `bun test assets/edit` passes: location note leaves status and holder untouched; `entity`/`currency` in the body → 422; price or date edit with all years open changes the schedule returned by T12; the same edit with a closed year at or after the old or the new purchase year → 409; disposed asset → 409 `asset_disposed`; accountant-only caller may patch only `supplier`/`invoiceRef` (any other field → 403); changing `invoiceRef` clears `invoiceFileId`; one `edited` event with typed `changes` per call; serial conflict → 409.

- [ ] T14: [backend] Status transitions: receive, return, repair, repair-done, lost, found — refs: AC-1.8, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-3.5 — deps: T12
  - touch: `inventory-api/src/assets/transitions.routes.ts`, `inventory-api/src/assets/transitions.repo.ts`, `inventory-api/src/assets/transitions.test.ts`
  - Compare-and-set on `status`; the allowed table is in plan § Assets.
  - done when: `bun test assets/transitions` passes: every allowed transition; one disallowed source status per route → 409 `invalid_transition` with `from`; repair keeps the holder and repair-done lands on `assigned` or `in_stock` by holder presence; lost clears the holder and leaves `ledger` unchanged; `/lost` and `/repair` with a pending assignment → 409 `assignment_pending`; two concurrent calls → exactly one 200; one event each.

- [ ] T15: [backend] Assignments, manager side: create and cancel — refs: AC-2.1, AC-2.2, AC-2.5, AC-2.10 — deps: T12
  - touch: `inventory-api/src/assignments/assignments.routes.ts`, `inventory-api/src/assignments/assignments.repo.ts`, `inventory-api/src/assignments/assignments.schemas.ts`, `inventory-api/src/assignments/assignments.test.ts`
  - Assignee must resolve to an `active` identity (T9) or 422 `unknown_user`. Exposes an `afterCommit` hook point that T17 fills; no notification code here.
  - done when: `bun test assignments` passes: assigning an `in_stock` asset creates a `pending` row and leaves status `in_stock`; non-`in_stock` → 409 `invalid_transition`; second assign → 409 `assignment_pending`, including two concurrent requests; cancel → `cancelled` and assignable again; cancel of a non-pending → 409 `assignment_not_pending`; events recorded.

- [ ] T16: [backend] `/me/*`: my devices, confirm, decline — refs: AC-2.3, AC-2.4, AC-2.6, AC-2.7, AC-4.1, AC-4.2, AC-4.4 — deps: T15
  - touch: `inventory-api/src/me/me.routes.ts`, `inventory-api/src/me/me.repo.ts`, `inventory-api/src/me/me.schemas.ts`, `inventory-api/src/me/me.test.ts`
  - JWT only — these routes must **not** pass through `authzMiddleware` (ADR-0045). Own serializer; never reuse `AssetView`.
  - done when: `bun test me` passes: a user with zero grants gets their held devices and pending assignments, and `{devices:[],pending:[]}` when none; the response JSON has no key matching `/price|cents|ledger|schedule/i`; confirm → `confirmed`, asset `assigned`, caller is holder; decline → `declined`, asset `in_stock`, reassignable; another `sub` → 404; non-pending → 409; a pending row is unchanged after the clock is advanced 30 days; all of it passes with `auth /authz/resolve` unreachable.

- [ ] T17: [backend] Notification push with the scoped service token — refs: AC-2.8, AC-2.9 — deps: T15, T16
  - touch: `inventory-api/src/lib/serviceToken.ts`, `inventory-api/src/lib/serviceToken.test.ts`, `inventory-api/src/lib/notify.ts`, `inventory-api/src/lib/notify.test.ts`, `inventory-api/src/assignments/assignments.routes.ts`, `inventory-api/src/me/me.routes.ts`
  - `serviceToken.ts`: fetch from `auth POST /system/service-token`, cache until 60 s before expiry. `notify.ts`: after-commit, never throws, English copy from design § Shell touch points; links `/devices` (assignee) and `/inventory/assets/{id}` (manager).
  - done when: `bun test lib/serviceToken lib/notify assignments me` passes with `auth` and `notify-api` stubbed: create notifies the assignee; confirm and decline notify the creating manager with the outcome; the call happens after the transaction commits; a notify-api 500 or network error leaves the assignment committed and the route 2xx; the token is reused within its lifetime and refetched after expiry; neither token nor secret appears in any log line.

- [ ] T18: [backend] Dispose (`POST /assets/{id}/dispose`) — refs: AC-7.1, AC-7.3, AC-7.4, AC-7.5, AC-7.6 — deps: T13, T14, T15
  - touch: `inventory-api/src/ledger/dispose.routes.ts`, `inventory-api/src/ledger/dispose.schemas.ts`, `inventory-api/src/ledger/dispose.repo.ts`, `inventory-api/src/ledger/dispose.test.ts`
  - done when: `bun test ledger/dispose` passes: disposal from each non-disposed status sets `disposed` and clears the holder; pending assignment → 409 with `assignmentId`; closed-year date → 409; date before purchase → 422; sale price accepted only for `sold`/`ceded_to_employee`; afterwards every route of T13, T14, T15 on that asset → 409 `asset_disposed` and no route restores a status; `asset:manage`-only caller → 403.

- [ ] T19: [backend] Fiscal years: list and roll-forward view — refs: AC-8.1, AC-8.2, AC-8.3 — deps: T12, T18
  - touch: `inventory-api/src/fiscal-years/read.routes.ts`, `inventory-api/src/fiscal-years/read.repo.ts`, `inventory-api/src/fiscal-years/read.schemas.ts`, `inventory-api/src/fiscal-years/rollForward.ts`, `inventory-api/src/fiscal-years/rollForward.test.ts`, `inventory-api/src/fiscal-years/read.test.ts`
  - Open year: computed from `yearFigure()` over the entity's assets. Closed year: read only from `fiscal_year` + `asset_year_figure`. `closable` = previous year closed, or the year of the entity's earliest purchase.
  - done when: `bun test fiscal-years/rollForward fiscal-years/read` passes: a property test over generated asset sets holds `closing = opening − disposals + purchases − depreciation`, every line equals the sum of the per-asset rows, and `opening(Y+1) = closing(Y)`; a sale price changes no line (AC-7.3 cross-check); per-asset rows carry `openingCents` and `purchaseCents`; out-of-scope entity → 404; with 2,000 assets the view answers in under 500 ms.

- [ ] T20: [backend] Close a fiscal year — refs: AC-8.4, AC-8.5, AC-8.6, AC-8.7 — deps: T19
  - touch: `inventory-api/src/fiscal-years/close.routes.ts`, `inventory-api/src/fiscal-years/close.repo.ts`, `inventory-api/src/fiscal-years/close.test.ts`
  - One transaction under `lockEntity`: verify sequence, write `asset_year_figure` rows and the `fiscal_year` row, record `fiscal_year_closed`.
  - done when: `bun test fiscal-years/close` passes: close writes the rows and the view (T19) now reads them; previous year open → 409 `previous_year_open`; second close → 409 `already_closed`; entity with no assets → 409 `nothing_to_close`; after closing, adding a rule and editing an open-year asset leave the closed year's response byte-identical; no route reopens (404/405); a register dated in that year racing the close ends as either "in the closed figures" or 409, never neither.

- [ ] T21: [backend] Invoice files: storage, mint, confirm, link, download URL — refs: AC-10.4, AC-10.5, AC-10.6, AC-10.7 — deps: T12
  - touch: `inventory-api/src/lib/storage.ts`, `inventory-api/src/lib/s3Residency.ts`, `inventory-api/src/lib/storage.test.ts`, `inventory-api/src/invoices/*`
  - Port `refund-api/src/lib/{storage,s3Residency}.ts` (presigned POST capped at 10 MiB, pdf/jpeg/png; ~60 s presigned GET). Link rules per plan § Invoice files.
  - done when: `bun test invoices lib/storage` passes against MinIO: mint → upload → confirm → URL works for either capability in scope; `text/plain` → 415 and 11 MiB → 413 with no row left `stored`; one file linked to three assets is one `invoice_file` row; mismatching `invoiceRef` → 409; disposed asset → 409; re-link replaces the asset's link and keeps the old row; the asset's holder with no capability → 404; other-entity accountant → 404; `invoice_file_linked` events recorded.

- [ ] T22: [backend] History route (`GET /assets/{id}/history`) — refs: AC-11.3, AC-11.4 — deps: T14, T16
  - touch: `inventory-api/src/history/history.routes.ts`, `inventory-api/src/history/history.schemas.ts`, `inventory-api/src/history/history.repo.ts`, `inventory-api/src/history/history.test.ts`
  - done when: `bun test history/history` passes: events come back oldest first with actor `Identity` and typed `changes`; for assign → confirm → return → assign → confirm the holder periods with start and end can be derived from the response alone; user ids in `holder` changes are returned as `Identity`; out-of-scope asset → 404; either capability may read.

- [ ] T23: [backend] Legacy import script — refs: AC-12.1, AC-12.2, AC-12.3, AC-12.4, AC-12.6, AC-12.7, AC-12.8, AC-12.9 — deps: T8, T9
  - touch: `inventory-api/scripts/*`
  - `scripts/import-legacy.ts --file <xlsx> --user-map <json> --expected-opening-cents <n> [--dry-run]`. Parses text and serial dates; splits multi-unit rows with `splitPrice`; writes `asset_year_figure` rows `source='imported'` for every amount the sheet has (plan R-2) and `fiscal_year` rows for 2024 and 2025; marks assets `legacyImported`; applies the cession rows as 2026 disposals; exits non-zero and writes nothing unless Σ closing(2025) equals the argument. The user map is produced by hand from the directory; an assignee matching exactly one entry is imported `assigned` with a `confirmed` assignment, anything else goes to `locationNote` with `toVerify`. Actor `system:legacy-import`.
  - The fixture is synthetic — never commit the real sheet. Rows spec O5 leaves undecided are reported and skipped, not guessed.
  - done when: `bun test scripts` passes on a fixture with a 13-unit row, a text-dated row, an unassigned row, a matched and an unmatched assignee, a cession row, an "Ordinato" row and an O5-style orphan: each AC above is asserted; a wrong `--expected-opening-cents` exits 1 with zero rows written; running twice does not duplicate; `--dry-run` writes nothing and prints the totals.

## inventory-ui

- [ ] T24: [frontend] Scaffold the `inventory-ui` remote — refs: AC-9.6 — deps: T1
  - touch: `inventory-ui/package.json`, `inventory-ui/pnpm-lock.yaml`, `inventory-ui/index.html`, `inventory-ui/vite.config.ts`, `inventory-ui/vitest.config.ts`, `inventory-ui/eslint.config.js`, `inventory-ui/postcss.config.js`, `inventory-ui/tsconfig*.json`, `inventory-ui/vercel.json`, `inventory-ui/CHANGELOG.md`, `inventory-ui/src/main.tsx`, `inventory-ui/src/App.tsx`, `inventory-ui/src/MyDevices.tsx`, `inventory-ui/src/router.tsx`, `inventory-ui/src/router.test.tsx`, `inventory-ui/src/index.css`, `inventory-ui/src/version.ts`, `inventory-ui/src/vite-env.d.ts`, `inventory-ui/src/federation/*`, `inventory-ui/src/strings.ts`, `inventory-ui/src/strings/*`, `inventory-ui/src/lib/noHardcodedStrings.test.ts`, `inventory-ui/src/lib/api.ts`, `inventory-ui/src/lib/api.test.ts`, `inventory-ui/src/pages/*.tsx`, `mise.toml`, `lerna.json`, `scripts/check-changeset.mjs`, `.github/workflows/changeset-check.yml`
  - Copy `refund-ui`'s setup; port 5178; exposes `./App`, `./MyDevices`, `./version`. `router.tsx` declares `/assets`, `/assets/new`, `/assets/$id`, `/rules`, `/years`, `/years/$entity/$year` with a placeholder page file each (`AssetsPage`, `RegisterAssetPage`, `AssetDetailPage`, `RulesPage`, `FiscalYearsPage`, `FiscalYearDetailPage`, `MyDevicesPage`, `NotFoundPage`). `strings.ts` aggregates one empty file per namespace listed in design § Strings and numbers. `lib/api.ts` wraps `shell/session`'s `apiFetch` + `getInventoryApiBaseUrl()` and parses Problem JSON into `{status, code, detail, extras}`. `package.json` already carries `exceljs` (T39) and the `axe` test dependency (T40), so no later UI task edits it.
  - Depends on T1 only because both edit `mise.toml`, `lerna.json` and the changeset-check lists.
  - done when: `cd inventory-ui && pnpm lint && pnpm build && pnpm test` pass; `pnpm dev` serves `remoteEntry.js` on :5178; the router test resolves all six routes and the not-found route; `noHardcodedStrings` runs over `src/` and passes.

- [ ] T25: [frontend] Port the shared primitives from `refund-ui` and `admin-ui` — refs: AC-4.4, AC-9.7 — deps: T24
  - touch: `inventory-ui/src/components/ErrorBanner*`, `inventory-ui/src/components/PermissionDenied*`, `inventory-ui/src/components/SkeletonListRows*`, `inventory-ui/src/components/ConfirmDialog*`, `inventory-ui/src/components/GuardrailDialog*`, `inventory-ui/src/components/EntityBadge*`, `inventory-ui/src/components/CurrencyBadge*`, `inventory-ui/src/components/Combobox*`, `inventory-ui/src/components/FormModal*`, `inventory-ui/src/lib/money*`, `inventory-ui/src/lib/dates*`, `inventory-ui/src/strings/errors.ts`, `inventory-ui/src/strings/common.ts`
  - The reuse table in design § Component inventory, re-authored with the same props. `ErrorBanner` gains the 503 "authorization service unavailable" heading variant; `strings/errors.ts` holds one message per API `code` from design § Error and conflict catalogue.
  - done when: `pnpm test components lib/money lib/dates` passes with each port's tests carried over; every `code` in the plan's API tables has an `errors.<code>` string (asserted by a test that reads the list from a constant).

- [ ] T26: [frontend] New shared components: status badge, data table, load-more, irreversible-action dialog — refs: AC-3.7, AC-7.1, AC-8.4 — deps: T24
  - touch: `inventory-ui/src/components/AssetStatusBadge*`, `inventory-ui/src/components/DataTable*`, `inventory-ui/src/components/LoadMore*`, `inventory-ui/src/components/IrreversibleActionDialog*`, `inventory-ui/src/strings/badges.ts`
  - Per design § NEW and § Accessibility: badges carry text + glyph, not colour alone; `DataTable` has caption, `scope` headers and right-aligned numeric cells; the dialog traps focus, defaults focus to Cancel, and enables its action only after the acknowledgement checkbox.
  - done when: `pnpm test components/AssetStatusBadge components/DataTable components/LoadMore components/IrreversibleActionDialog` passes, including: six badge variants each with an accessible name; the dialog's confirm button is disabled until acknowledged and Escape closes it returning focus to the trigger.

- [ ] T27: [frontend] API clients and types — refs: AC-9.2, AC-9.4 — deps: T24
  - touch: `inventory-ui/src/lib/types.ts`, `inventory-ui/src/lib/scopeApi*`, `inventory-ui/src/lib/assetsApi*`, `inventory-ui/src/lib/assignmentsApi*`, `inventory-ui/src/lib/ledgerApi*`, `inventory-ui/src/lib/fiscalYearsApi*`, `inventory-ui/src/lib/rulesApi*`, `inventory-ui/src/lib/invoiceFilesApi*`, `inventory-ui/src/lib/historyApi*`, `inventory-ui/src/lib/meApi*`, `inventory-ui/src/lib/directoryApi*`
  - One client per route group, typed exactly as plan § API contracts (`ledger` optional on `AssetView`). `directoryApi` calls `auth` via `getAuthBaseUrl()`.
  - done when: `pnpm test lib` passes with a test per client asserting method, path, body and the mapping of each documented error `code`.

- [ ] T28: [frontend] Tool layout, capability hook and scope states — refs: AC-9.1, AC-9.3, AC-9.4, AC-9.6 — deps: T25, T27
  - touch: `inventory-ui/src/components/InventoryShell*`, `inventory-ui/src/hooks/useInventoryCapabilities*`, `inventory-ui/src/hooks/useScope*`, `inventory-ui/src/App.tsx`, `inventory-ui/src/strings/nav.ts`
  - Tabs per design T0: Assets for either capability; Rules and Fiscal years only with `ledger:manage`. A missing capability hides the tab and its route renders `PermissionDenied`. Empty scope with tool access shows the "no entity in your scope" state (design Resolutions G1/G11).
  - done when: `pnpm test components/InventoryShell hooks` passes for manager-only, accountant-only, both, and empty-scope users, asserting which tabs exist in the DOM (absent, not disabled).

- [ ] T29: [frontend] Assets list page with filters and search — refs: AC-3.7, AC-3.8, AC-10.3, AC-12.10 — deps: T26, T28
  - touch: `inventory-ui/src/pages/AssetsPage*`, `inventory-ui/src/components/AssetFilterBar*`, `inventory-ui/src/strings/assets.ts`
  - Design T1. Filters and `q` live in URL search params; holder filter only with `asset:manage`; "to verify" and invoice-reference filters; book value column only with `ledger:manage`.
  - done when: `pnpm test pages/AssetsPage components/AssetFilterBar` passes: each control updates the URL and the request; loading, empty, filtered-empty, error and 503 states render; Load more appends and keeps focus; the search input is debounced and precedes the filters in tab order.

- [ ] T30: [frontend] Register asset page — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-1.7 — deps: T26, T28
  - touch: `inventory-ui/src/pages/RegisterAssetPage*`, `inventory-ui/src/lib/splitPrice*`, `inventory-ui/src/lib/split-vectors.json`, `inventory-ui/src/strings/register.ts`
  - Design T3. Entity select limited to `GET /scope`'s `asset` list; currency shown, not editable; quantity with the live per-unit breakdown from a `splitPrice` mirrored from T8 (copy its vectors; a parity test asserts them).
  - done when: `pnpm test pages/RegisterAssetPage lib/splitPrice` passes: required-field and price validation summary; "not yet received" sends `received:false`; serial inputs are either none or one per unit; `serial_conflict` shows the conflicting asset as a link; `fiscal_year_closed` names the year; a network failure shows the "check the list before retrying" message; success navigates to the new asset (or the list filtered by invoice reference when N > 1).

- [ ] T31: [frontend] My devices view — refs: AC-2.3, AC-2.4, AC-4.1, AC-4.2, AC-4.4 — deps: T25, T27
  - touch: `inventory-ui/src/MyDevices.tsx`, `inventory-ui/src/pages/MyDevicesPage*`, `inventory-ui/src/components/DeviceCard*`, `inventory-ui/src/strings/myDevices.ts`
  - Design D1 with Q3 as resolved: Confirm is one click, Decline opens a confirm dialog. No money anywhere; no call to `/scope` or any capability hook.
  - done when: `pnpm test pages/MyDevicesPage components/DeviceCard` passes: pending and held sections; empty state; confirm moves the card and announces it; decline removes it after the dialog; 404/409 on a stale card refreshes the list with a message; the rendered DOM contains no currency text; focus lands on the section heading after an action.

- [ ] T32: [frontend] Asset detail page frame and edit dialog — refs: AC-1.9, AC-3.6, AC-10.1 — deps: T26, T28
  - touch: `inventory-ui/src/pages/AssetDetailPage*`, `inventory-ui/src/components/EditAssetDialog*`, `inventory-ui/src/components/AssetActions.tsx`, `inventory-ui/src/components/LedgerBlock.tsx`, `inventory-ui/src/components/InvoiceFilePanel.tsx`, `inventory-ui/src/components/HistoryTimeline.tsx`, `inventory-ui/src/strings/assetDetail.ts`
  - Design T2. The page renders summary fields and four regions, each a component file created here as a stub and filled by T33–T36. A region is rendered only when its capability is held. The edit dialog's field set depends on capability (accountant-only: supplier and invoice reference); entity and currency are never editable; changing the invoice reference with a file linked warns that the file is unlinked.
  - done when: `pnpm test pages/AssetDetailPage components/EditAssetDialog` passes for manager-only, accountant-only and both: regions present or absent in the DOM; loading, 404 and error states; edit saves and shows `fiscal_year_closed`, `asset_disposed` and `serial_conflict`; a disposed asset is read-only.

- [ ] T33: [frontend] Asset actions: receive, assign, cancel, return, repair, lost, found — refs: AC-1.8, AC-2.1, AC-2.2, AC-2.5, AC-2.10, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-3.5 — deps: T32
  - touch: `inventory-ui/src/components/AssetActions*`, `inventory-ui/src/components/AssignDialog*`, `inventory-ui/src/strings/actions.ts`
  - Design T2 action bar. Only the actions valid for the current status are offered; an action blocked by state (a pending assignment) is `aria-disabled` with a described reason. Assign uses the `Combobox` over the directory; Return and Lost confirm first (Q4).
  - done when: `pnpm test components/AssetActions components/AssignDialog` passes: the action set per status; assign shows the pending banner with Cancel; directory loading, empty and 429 states; `invalid_transition` and `assignment_pending` refresh the asset with a message; after an action whose button disappears, focus moves to the page heading and a status line announces the result.

- [ ] T34: [frontend] Ledger block, schedule table and dispose dialog — refs: AC-5.8, AC-7.1, AC-7.3, AC-7.4, AC-7.5 — deps: T32
  - touch: `inventory-ui/src/components/LedgerBlock*`, `inventory-ui/src/components/ScheduleTable*`, `inventory-ui/src/components/DisposeDialog*`, `inventory-ui/src/strings/ledger.ts`
  - Design T2 ledger region: rule in force with its effective date, schedule per year with a closed/open column, book value. Dispose uses `IrreversibleActionDialog`; the sale-price field appears only for `sold` and `ceded_to_employee`.
  - done when: `pnpm test components/LedgerBlock components/ScheduleTable components/DisposeDialog` passes: every schedule year rendered with currency; dispose blocked with a reason while an assignment is pending; `fiscal_year_closed` and date-before-purchase shown on the field; after disposal the block shows the disposal and no Dispose button.

- [ ] T35: [frontend] Invoice file panel — refs: AC-10.4, AC-10.5, AC-10.6 — deps: T32
  - touch: `inventory-ui/src/components/InvoiceFilePanel*`, `inventory-ui/src/strings/invoice.ts`
  - Design T2 invoice region with Q2 as resolved: after upload, offer the other assets sharing the invoice reference for linking in the same panel. Client-side type and size check before minting.
  - done when: `pnpm test components/InvoiceFilePanel` passes: mint → upload → confirm sequence; wrong type and oversize rejected before any request and again on 415/413; sibling list and link; `invoice_ref_mismatch` names the asset; open requests a fresh URL each time; read-only on a disposed asset; no remove control exists.

- [ ] T36: [frontend] History timeline — refs: AC-11.3, AC-11.4 — deps: T32
  - touch: `inventory-ui/src/components/HistoryTimeline*`, `inventory-ui/src/strings/history.ts`
  - done when: `pnpm test components/HistoryTimeline` passes: events in chronological order as an ordered list; each `changes` entry rendered "field: from → to" with holder identities by name; `deleted` and `unknown` actors labelled; system actors shown as "System"; loading, empty and error states.

- [ ] T37: [frontend] Depreciation rules page and new-rule dialog — refs: AC-6.1, AC-6.2, AC-6.3, AC-6.4, AC-6.5 — deps: T26, T28
  - touch: `inventory-ui/src/pages/RulesPage*`, `inventory-ui/src/components/NewRuleDialog*`, `inventory-ui/src/strings/rules.ts`
  - Design T4, modelled on `admin-ui`'s `MileageRatesPage`: per-entity sections from `GET /scope`'s `ledger` list, "in force" badge, added-by and date, no edit or delete control. The dialog states that assets purchased on or after the date are rescheduled.
  - done when: `pnpm test pages/RulesPage components/NewRuleDialog` passes: past, current and future rules listed; field-level 422 messages; `fiscal_year_closed` on the date field; the acknowledgement is required before saving; the DOM has no edit or delete affordance.

- [ ] T38: [frontend] Fiscal years list, year detail and close dialog — refs: AC-8.1, AC-8.4, AC-8.5, AC-8.7 — deps: T26, T28
  - touch: `inventory-ui/src/pages/FiscalYearsPage*`, `inventory-ui/src/pages/FiscalYearDetailPage*`, `inventory-ui/src/components/RollForwardStatement*`, `inventory-ui/src/components/CloseYearDialog*`, `inventory-ui/src/components/ExportYearButton.tsx`, `inventory-ui/src/strings/years.ts`
  - Design T5/T6. The statement reads as a labelled table with words and signs; per-asset rows show opening, purchase, depreciation, disposal and closing. Close is offered only when `closable`; `ExportYearButton` is a stub filled by T39.
  - done when: `pnpm test pages/FiscalYears pages/FiscalYearDetail components/RollForwardStatement components/CloseYearDialog` passes: five lines with currency; open vs closed presentation; close requires acknowledgement and handles `previous_year_open`, `already_closed`, `nothing_to_close`; a closed year has no close or reopen control.

- [ ] T39: [frontend] XLSX export of a fiscal year — refs: AC-8.8, AC-8.9 — deps: T38
  - touch: `inventory-ui/src/lib/yearWorkbook*`, `inventory-ui/src/components/ExportYearButton*`
  - `buildYearWorkbook(view)` with `exceljs` (as `estimai-ui`): one row per asset with the columns of AC-8.8, then the five roll-forward lines; amounts as numbers in major units with two decimals; an open year carries a "provisional" mark in the sheet and the file name.
  - done when: `pnpm test lib/yearWorkbook components/ExportYearButton` passes: reading the produced workbook back gives the expected header, one row per asset, the five lines, and the provisional mark only for an open year.

- [ ] T40: [frontend] Accessibility pass against design § Accessibility — refs: AC-4.1, AC-9.6 — deps: T29, T30, T31, T33, T34, T35, T36, T37, T39
  - touch: `inventory-ui/src/a11y.test.tsx`, `inventory-ui/src/index.css`
  - One test file rendering each page and dialog through `axe`, plus a contrast check of the badge tints and focus ring against the Operai tokens in both themes (the design's flagged unknown). Fixes go in `index.css` tokens only; a fix needed inside a component is reported, not made here.
  - done when: `pnpm test a11y` passes with zero violations on every page and dialog; the task report states the measured contrast ratios for the six badges and the focus ring.

## shell

- [x] T41: [frontend] Shell: remote wiring, session URL, CSP — refs: AC-9.6 — deps: none
  - touch: `shell/vite.config.ts`, `shell/src/lib/runtimeRemotes.ts`, `shell/src/lib/runtimeRemotes.test.ts`, `shell/src/lib/session.ts`, `shell/src/lib/session.test.ts`, `shell/src/federation/*`, `shell/public/runtime-config.example.json`, `shell/vercel.json`, `shell/src/components/AboutModal.tsx`, `shell/src/components/AboutModal.test.tsx`
  - Add the `inventory` remote (dev default `:5178`, runtime-resolved per ADR-0006), `getInventoryApiBaseUrl()` with the trusted-origin guard, ambient declarations for `inventory/App`, `inventory/MyDevices`, `inventory/version`, the About modal's version row (ADR-0030, degrade silently), and `script-src`/`connect-src` for the inventory remote and API origins.
  - done when: `pnpm --dir shell test runtimeRemotes session AboutModal federation` passes: the remote resolves from runtime config and is omitted when absent; `apiFetch` attaches the Bearer to the inventory API origin and not to an untrusted one; the About modal lists Inventory and still renders when `inventory/version` rejects or times out.

- [x] T42: [frontend] Shell: `/inventory` tool route, ungated `/devices` route, menu link — refs: AC-4.1, AC-9.6 — deps: T41
  - touch: `shell/src/lib/tools.ts`, `shell/src/lib/tools.test.ts`, `shell/src/router.tsx`, `shell/src/router.inventory.test.tsx`, `shell/src/components/UserMenu.tsx`, `shell/src/components/UserMenu.test.tsx`
  - `TOOLS`/`ToolId` gain `inventory`; `/inventory/$` uses `createToolAccessBeforeLoad('inventory')`; `/devices` is a child of `shellRoute` with no `beforeLoad`, mounting `inventory/MyDevices` through `RemoteMount`, and is not in `TOOLS` (ADR-0045 — this is the plan's R-5 early check). "My devices" menu row after "My profile".
  - done when: `pnpm --dir shell test tools router UserMenu` passes: a user without `inventory:access` is redirected from `/inventory` to `/no-access` and has no sidebar entry, yet reaches `/devices`; visiting `/devices` does not write `operai_last_tool`; a failing `MyDevices` remote shows `RemoteMount`'s error state inside an intact shell; the menu row is a real link.

## Close-out

- [ ] T43: [devops] Env contract, docs and changeset — refs: AC-9.7 — deps: T4, T5, T6, T23, T39, T42
  - touch: `tools/env-doctor/manifest.ts`, `tools/env-doctor/check.test.ts`, `tools/env-doctor/templates/*`, `infra/README.md`, `CLAUDE.md`, `.changeset/*`
  - Manifest: `inventory-api` as a service; `SERVICE_AUDIENCE` shared by `auth` + `notify-api`; `AUTH_AUDIENCE` extended to `inventory-api`; `AUTH_JWKS_URL`/`AUTH_BASE_URL`/`NOTIFY_INTERNAL_URL` targets; `SERVICE_CLIENT_SECRET` and `INVENTORY_S3_SECRET_ACCESS_KEY` as secrets; a check that `inventory-api`'s client id/secret match an entry in `auth`'s `SERVICE_CLIENTS`. `CLAUDE.md`: tool table, structure tree, ports, domain language, API contract pointer. One changeset selecting `@operai/auth`, `@operai/notify-api`, `@operai/notify-ui`, `@operai/shell`, `@operai/inventory-api`, `@operai/inventory-ui`.
  - done when: `mise run env:doctor` passes locally with the new service and fails when `SERVICE_AUDIENCE` differs between `auth` and `notify-api`; `bun test tools/env-doctor` passes; `mise run changeset:check` passes.

- [ ] T44: [qe] Capability × route matrix and event-per-mutation test — refs: AC-9.1, AC-9.2, AC-9.3, AC-9.4, AC-9.5, AC-9.7, AC-11.1 — deps: T10, T13, T14, T17, T18, T20, T21, T22
  - touch: `inventory-api/src/test-support/routeMatrix.ts`, `inventory-api/src/matrix.test.ts`
  - Generated from the mounted routes, so a route added later without a matrix row fails the test. Callers: none, manager-CH, manager-global, accountant-CH, accountant-global, both. Every non-`/me` route is hit directly for each caller against a CH and an IT asset.
  - done when: `bun test matrix` passes: outcomes match plan § API contracts (403 capability-absent, 404 out of scope); every 2xx mutating call wrote exactly one `asset_event`; a route missing from the expectation table fails the run; with `auth` unreachable every non-`/me` route is 503.

- [ ] T45: [qe] End-to-end journeys through the shell — refs: AC-2.8, AC-2.9, AC-4.1, AC-8.8, AC-9.6 — deps: T40, T42, T44
  - touch: `shell/e2e/helpers/inventoryFixtures.ts`, `shell/e2e/inventory-assignment.spec.ts`, `shell/e2e/inventory-ledger.spec.ts`, `shell/e2e/mf-singleton.spec.ts`
  - Assignment journey: a manager registers and assigns; a user with zero grants sees the bell notification, follows it to `/devices`, confirms; the manager is notified; that user has no Inventory sidebar entry and `/inventory` gives `/no-access`. Ledger journey: an accountant sees the schedule, disposes, closes a year and downloads the export. `mf-singleton` extended to `/devices`.
  - done when: with the stack up (`mise run dev`), `cd shell && pnpm e2e inventory-assignment.spec.ts inventory-ledger.spec.ts mf-singleton.spec.ts` passes.

- [ ] T46: [qe] All gates green, feature closed — refs: AC-9.7 — deps: T43, T45
  - touch: `specs/015-hardware-inventory/spec.md`
  - done when: `bun run typecheck && bun test` pass in `auth`, `notify-api`, `inventory-api`; `pnpm lint && pnpm build && pnpm test` pass in `shell`, `notify-ui`, `inventory-ui`; `cd shell && pnpm e2e` passes; `mise run env:doctor` and `mise run changeset:check` pass; QE, security review and eval verdicts are PASS; then `/wellforge:done 015-hardware-inventory` sets the status.
