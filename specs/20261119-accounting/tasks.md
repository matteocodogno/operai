---
spec: 20261119
generated: 2026-11-19
---

# Tasks: Accounting — one module for ledger accounts, VAT codes and monthly exchange rates

Derived from these committed files:

- `spec.md`: approved, 68 ACs, with amendments SA-1 to SA-3 (owner to confirm).
- `plan.md`: approved, with its "Post-approval sync with design.md and ADRs (2026-11-19)".
- `design.md`: UX-1..UX-23, the component inventory, copy keys and the accessibility plan.
- The ADRs of 2026-11-19 (three new records, amendments A1 to A6).

## How to read this list

- **Tracks.** Each can run in its own worktree. They meet only at the deps and the `touch:`
  overlaps listed in § Overlap check.

  | Track | Scope | Tasks |
  |---|---|---|
  | **AUTH** | auth | T1–T3 |
  | **ACC** | accounting-api | T4–T15 |
  | **REF** | refund-api | T16–T25 |
  | **UI** | accounting-ui + shell | T26–T32 |
  | **RUI** | refund-ui | T33–T38 |
  | **OPS** | e2e, local plumbing, infra docs, docs, changesets | T39–T45 |
  | **CLOSE** | QE, OWASP, eval, closing | T46–T49 |
  | **OWNER** | owner steps | T50–T52 |

  The UI and RUI tracks build against plan § API contracts with mocked responses, so they do not wait
  for the backend. REF builds against a fake `AccountingPort`, so it does not wait for ACC.
- **`touch:` is binding.** A task changes only the paths it lists (`*` does not cross `/`). A path
  found missing is added to the task, and to § Overlap check, before it is changed.
- **Moves keep history.** A file moves with `git mv` in the task that names it, as a commit of its own
  ("move, no change"), before the adapting commit of the same task.
  - A file is moved only when **nothing in its source package still imports it**. REF and RUI first
    switch their consumers (T18–T22, T34, T37), then T23 and T34 make the old code dead, then ACC and
    UI move it (T8, T10, T11, T14, T29–T31).
  - The source package's suite stays green at every commit: dead files keep their own tests until they
    move.
- **Migrations: one declared chain in refund-api**, not one file. The plan's single migration is
  split in two (drift declared here; the implementation sync folds it into plan § Data model):
  - `<ts1>_accounting_copies` (T16): plan steps 1–5 and 7 — add the columns and tables, carry the
    data, replace the guard, add the CHECKs, add the enum value.
  - `<ts2>_accounting_reference_moved_out` (T24): plan step 6, the drops.

  The split is needed because the old Prisma models must exist until the code using them has moved
  (T8, T11). Production runs both back to back.

  accounting-api has one init migration (T5).
- **Shared registries.** Each is owned by the tasks named, serialized by deps:

  | Registry | Owners |
  |---|---|
  | `accounting-api/src/index.ts` | T4 → T6 → T8 → T12 → T13 |
  | `refund-api/src/index.ts` | T23 only |
  | `refund-api/src/lib/env.ts` | T17 → T23 |
  | `auth/src/authz/seed.ts` and the catalogs index (`DECLARED_CATALOGS`) | T1 only |
  | `shell/src/lib/tools.ts` | T32 only |
  | `scripts/check-shared-copies.ts` | T4 → T7 |
  | `accounting-ui/src/strings.ts` | T26 (skeleton) → T27 (whole catalog) |
  | `refund-ui/src/strings.ts` | T33 (additions) → T38 (removals) |
  | `lerna.json` | T4 → T26 |
  | `.changeset/*` | T45 only |
- **Test databases.** Agents use the isolated container `operai-expense-analysis-pg` on **:5445**:
  - accounting-api: `accounting`, created once with `createdb`;
  - refund-api: `refund`;
  - auth: `auth`;
  - scratch databases `accounting_qe` and `refund_mig`, created and dropped by the task that uses them.

  Agents never use :5435 or Railway, and never start or stop the container.
- **Deploying is never a task.** Railway and Vercel are documented (T43) and applied by the owner
  (T52).

## AUTH — auth

- [x] T1: auth — `accounting` catalog (resource `accounting`, actions `read`/`manage`, entity condition, no `access`) and seed grants — refs: AC-3.1, AC-3.3 — deps: none
  - touch: `auth/src/authz/catalogs/accounting.ts`, `auth/src/authz/catalogs/accounting.test.ts`, `auth/src/authz/catalogs/uniqueResourceKeys.test.ts`, `auth/src/authz/seed.ts`, `auth/src/authz/seed.test.ts`
  - agent: backend-dev · backend
  - Details:
    - Labels: resource "Accounting", actions "Read" and "Manage" (G12).
    - `ACCOUNTING_CATALOG` is added to `DECLARED_CATALOGS`; the unique-key test's expected list gains
      `accounting`.
    - `seedAccountingCatalog` registers it. `seedAccountingGrants` gives `admin` both actions
      unconditioned and the `accounting` role both with `REFUND_ENTITY_CONDITION`, through
      `ensureGrant`, which never rewrites an existing rule. No other role gets either.
  - done when: `cd auth && bun test src/authz` is green, including new tests that:
    - the catalog declares exactly `read` and `manage` with `["entity"]`;
    - `admin` holds both unconditioned and `accounting` both entity-conditioned;
    - no other system role holds either;
    - a re-seed leaves a hand-edited `accounting:manage` rule unchanged;

    and `bun run typecheck` is clean.

- [x] T2: auth — `DERIVED_APPS` in `/authz/me` (admin ← `legal-entity:manage`, accounting ← `accounting:read` or `manage` covering ≥ 1 entity) and the shared coverage vectors — refs: AC-8.1, AC-3.2 — deps: T1
  - touch: `auth/src/authz/derivedApps.ts`, `auth/src/authz/derivedApps.test.ts`, `auth/src/legalEntities/coverage.ts`, `auth/src/authz/authz.routes.ts`, `auth/src/authz/authz.routes.test.ts`, `auth/src/authz/entity-coverage-vectors.json`
  - agent: backend-dev · backend
  - Details:
    - `adminAreaReachable` becomes one entry of the table; both entries use `entityGrantFor`.
      `/authz/resolve`, `/authz/app-access-check` and the directory filter are unchanged.
    - The vectors file lists (permissions, user entity, expected covered entities) cases: an
      unconditioned grant, an entity grant, an entity grant with the user's entity null, an unknown
      condition. accounting-api's T6 reads the same file (R12).
  - done when: `bun test src/authz src/legalEntities` is green, with `/authz/me` `apps` containing
    `accounting` for read-only, manage-only and both, and not for no grant, a null user entity or an
    unknown condition; the existing admin-derivation tests are unchanged and green.

- [x] T3: auth — service scope `accounting.reference.read` — refs: AC-3.8 — deps: none
  - touch: `auth/src/system/serviceClients.ts`, `auth/src/system/serviceClients.test.ts`, `auth/.env.example`
  - agent: backend-dev · backend
  - Details:
    - `KNOWN_SERVICE_SCOPES` gains the scope. The doc comment says only `refund-api` holds it.
    - `.env.example`'s sample `SERVICE_CLIENTS` gives refund-api's entry the scope (local stack).
  - done when: `bun test src/system` is green, including "a `SERVICE_CLIENTS` entry with
    `accounting.reference.read` parses" and "an unknown scope still refuses to start".

## ACC — accounting-api

- [x] T4: accounting-api — scaffold: package, Hono app, env, Problem JSON, JWT + system auth middlewares, authz resolve client and middleware, health, OpenAPI, Dockerfile — refs: none (foundation of every ACC task) — deps: none
  - touch:
    - `accounting-api/package.json`, `accounting-api/bun.lock`, `accounting-api/bunfig.toml`, `accounting-api/tsconfig.json`, `accounting-api/prisma.config.ts`, `accounting-api/Dockerfile`, `accounting-api/.dockerignore`, `accounting-api/.gitignore`, `accounting-api/.env.example`, `accounting-api/.envrc`, `accounting-api/CHANGELOG.md`;
    - `accounting-api/src/index.ts`, `accounting-api/src/lib/env.ts`, `accounting-api/src/lib/env.test.ts`, `accounting-api/src/lib/db.ts`, `accounting-api/src/lib/problem.ts`, `accounting-api/src/lib/logger.ts`, `accounting-api/src/health/*`, `accounting-api/src/openapi/*`;
    - `accounting-api/src/auth/jwt.middleware.ts`, `accounting-api/src/auth/jwt.middleware.test.ts`, `accounting-api/src/auth/systemAuth.middleware.ts`, `accounting-api/src/authz/resolveClient.ts`, `accounting-api/src/authz/resolveClient.test.ts`, `accounting-api/src/authz/authz.middleware.ts`, `accounting-api/src/authz/authz.middleware.test.ts`;
    - `accounting-api/src/test-support/testAuth.ts`, `accounting-api/src/test-support/fakeResolve.ts`;
    - `scripts/check-shared-copies.ts`, `lerna.json`.
  - agent: backend-dev · backend
  - Details:
    - Copied from projects-api (app shape, env, Dockerfile, scripts `dev`, `test`, `typecheck`,
      `db:migrate`, `db:deploy`, `db:generate`) and inventory-api (JWT and authz).
    - `systemAuth`, `problem` and `logger` join their shared-copy groups with the accounting-api path.
    - Env: `DATABASE_URL`, `PORT` (8089), `ALLOWED_ORIGINS`, `AUTH_JWKS_URL`, `AUTH_ISSUER`,
      `AUTH_AUDIENCE`, `AUTH_BASE_URL`, `SERVICE_AUDIENCE` (≠ `AUTH_AUDIENCE`),
      `ACCOUNTING_FX_SOURCE` (`bazg`, the default, or `off`).
    - CORS to the shell origin only; `bodyLimit` 4 KiB. The package `name` is
      `@operai/accounting-api`, version `0.0.0`; it is added to `lerna.json`.
    - A placeholder `prisma/schema.prisma` with only the datasource is allowed; T5 owns its content.
  - done when: `cd accounting-api && bun install && bun run typecheck && bun test` is green; `mise run
    shared:check` reports the extended groups in sync; `GET /health` answers 200 in a test;
    `env.test.ts` proves a start with `SERVICE_AUDIENCE == AUTH_AUDIENCE` or a missing variable
    exits 1.

- [x] T5: accounting-api — Prisma schema and the init migration (five tables, immutability triggers, CHECKs, fetched-once index, status-entity trigger) and `dbCleanup` — refs: AC-1.7, AC-1.12, AC-1.13, AC-2.2, AC-2.4, AC-2.5 — deps: T4
  - touch: `accounting-api/prisma/schema.prisma`, `accounting-api/prisma/migrations/*`, `accounting-api/src/lib/db.*.test.ts`, `accounting-api/src/test-support/dbCleanup.ts`
  - agent: backend-dev · backend
  - Details:
    - Plan § Data model, accounting-api, verbatim: `LedgerAccount`, `VatCode`, `CatalogStatusChange`
      (with `entity`), `ExchangeRateEntry` (with `entity`, `replacesRateMicros`),
      `ExchangeRateFetchAttempt` (with `entity`; outcome includes `not_fetchable`).
    - The raw SQL block reuses refund-api's `accounting_history_immutable()` shape. The db tests are
      modelled on refund-api's `db.accounting-immutability.test.ts` and `db.fx-fetched-once.test.ts`
      (read, not moved: those stay until T24).
    - `createdb -U postgres accounting` on :5445 the first time.
  - done when:
    - `DATABASE_URL=…:5445/accounting bun run db:deploy` applies on an empty DB;
    - `prisma migrate diff` shows no difference;
    - `bun test src/lib/db.*.test.ts` proves:
      - raw UPDATE and DELETE raise on all five tables;
      - `vat_code."rateBasisPoints"` and an entry's `entity` cannot change;
      - each CHECK refuses a bad row: number format and length, code format, rate range, an
        own-currency rate per entity, the first day of the month, origin vs fields;
      - a second `fetched` row for (entity, currency, month) violates the index, and a second
        `corrected` row is accepted;
      - a status row with another entity than its entry's is refused.

- [x] T6: accounting-api — `entities.ts`, `coverage.ts` (read = read ∪ manage, fail closed) and `GET /v1/me` — refs: AC-3.2, AC-3.5, AC-3.6, AC-8.2 — deps: T2, T4
  - touch: `accounting-api/src/entities.ts`, `accounting-api/src/authz/coverage.ts`, `accounting-api/src/authz/coverage.test.ts`, `accounting-api/src/me/*`, `accounting-api/src/index.ts`
  - agent: backend-dev · backend
  - Details:
    - `ENTITIES`, `OWN_CURRENCY`, `RATE_SOURCE` (welld_ch: BAZG, EUR/USD/GBP; welld_it: none, no
      currencies; D19).
    - `coverage.test.ts` reads `auth/src/authz/entity-coverage-vectors.json` by repo-relative path and
      must agree with it.
    - One helper `requireEntityAccess(c, entity, "read" | "manage")`: 404 `not_found` when the entity
      is outside read coverage, 403 `accounting_manage_required` for a write without manage, 403
      `accounting_forbidden` when nothing is covered.
    - `GET /v1/me` → `{ entities: [{ entity, ownCurrency, canManage, rateSource }] }`, welld_ch first.
  - done when: `bun test src/authz src/me` is green: the vectors agree; `/v1/me` returns one entity
    for a conditioned welld_ch user, two for an admin, and 403 with no data for a person without
    either grant; manage-only covers read.

- [x] T7: accounting-api — the shared wire schema `accountingWire` (both 200 bodies of the system routes), its refund-api copy and the shared-copy group — refs: AC-3.8, AC-6.8 — deps: T4
  - touch: `accounting-api/src/system/accountingWire.ts`, `accounting-api/src/system/accountingWire.test.ts`, `refund-api/src/accounting/accountingWire.ts`, `scripts/check-shared-copies.ts`
  - agent: backend-dev · backend
  - Details:
    - zod schemas: reference data `{ entity, ownCurrency, ledgerAccounts[{number,name,active}],
      vatCodes[{code,label,rateBasisPoints,active}] }`;
    - rates `{ entity, rates[ in_effect {currency, month, rateMicros, origin, attempted} | missing
      {currency, month, attempted, reason} ] }` (plan § API, with G10's `attempted`);
    - both strict, with no unknown keys;
    - the region between `// shared-copy:begin accountingWire` and `:end` is byte-identical in both
      files.
  - done when: `mise run shared:check` lists `accountingWire` in sync; `bun test
    src/system/accountingWire.test.ts` proves the schemas refuse an extra key, a missing pair field
    and a non-integer `rateMicros`.

- [x] T8: accounting-api — **move** the catalog from refund-api, then ledger accounts per entity: add, deactivate, reactivate, list, keyed by number — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.9, AC-1.11, AC-1.12, AC-1.13, AC-3.4, AC-3.5, AC-8.3 — deps: T5, T6, T23
  - touch:
    - `refund-api/src/accounting/catalog.repo.ts`, `refund-api/src/accounting/catalog.routes.ts`, `refund-api/src/accounting/catalog.schemas.ts`, `refund-api/src/accounting/catalog.routes.test.ts` (source side of the move);
    - `accounting-api/src/catalog/*`, `accounting-api/src/index.ts`.
  - agent: backend-dev · backend
  - Details:
    - **Move:** `git mv refund-api/src/accounting/catalog.{repo,routes,schemas}.ts
      refund-api/src/accounting/catalog.routes.test.ts accounting-api/src/catalog/`. It is a commit of
      its own. The file names stay `catalog.*` (a drift from the plan's `ledgerAccounts.*/vatCodes.*`
      split, accepted; the routes stay one router).
    - **Adapt:**
      - paths `/v1/entities/{entity}/ledger-accounts[/{number}/deactivate|reactivate]`, via
        `requireEntityAccess`;
      - `limits.ts` for AC-1.2: trim; digits separated by single dots; ≤ 20; name 1..120, not blank;
      - 422 `invalid_ledger_account` with `fields[{field, reason}]`;
      - 409 `ledger_account_duplicate` with `number` and `reactivate` (the existing entry is
        deactivated, G9), P2002 mapped;
      - `already_active` / `already_inactive` 409s write nothing; status changes lock the entry
        `FOR UPDATE`;
      - the status row carries `entity`;
      - no who-added and no history in responses (D18);
      - no PUT, PATCH or DELETE.
    - Register the router in `index.ts`. VAT codes keep their old shape inside the moved files until
      T9, which may leave them unregistered.
  - done when: `git log --follow accounting-api/src/catalog/catalog.repo.ts` shows the refund-api
    history; `cd accounting-api && bun test src/catalog && bun run typecheck` is green, with the
    plan's AC-1.1–1.4, 1.9, 1.11–1.13, 3.4, 3.5 and 8.3 rows for accounts (concurrent add ×20 → one
    201; concurrent deactivate ×20 → one 200 and one status row); `cd refund-api && bun test && bun
    run typecheck` stays green.

- [x] T9: accounting-api — VAT codes per entity: add (upper-case, rate to basis points), deactivate, reactivate, list, keyed by code — refs: AC-1.5, AC-1.6, AC-1.7, AC-1.8, AC-1.10, AC-1.11, AC-1.12, AC-1.13, AC-3.4, AC-8.3 — deps: T8
  - touch: `accounting-api/src/catalog/*`
  - agent: backend-dev · backend
  - Details:
    - Paths `/v1/entities/{entity}/vat-codes[/{code}/…]`, with `{code}` upper-cased.
    - Limits: code `^[A-Z0-9_-]{1,16}$` after upper-casing; label 1..80; rate `^\d{1,3}(\.\d{1,2})?$`
      within 0..100.
    - 409 `vat_code_duplicate` with `vatCode` and `reactivate`, case-insensitive. Same concurrency and
      no-op rules as T8.
  - done when: `bun test src/catalog` is green with the plan's rows for AC-1.5, 1.6 (`imp81` vs
    `IMP81`, active and deactivated, the other entity accepted, concurrent ×20), 1.7 (PUT and PATCH →
    404), 1.10, 1.11 and 1.13 for VAT codes; the `/v1/*` route matrix shows no write method other
    than the six POSTs.

- [x] T10: accounting-api — **move** the pure FX modules (BAZG client, parser, months) and their fixture — refs: AC-2.1, AC-2.3, AC-2.7 — deps: T4, T23
  - touch: `refund-api/src/fx/bazgSource.ts`, `refund-api/src/fx/bazgSource.test.ts`, `refund-api/src/fx/parse.ts`, `refund-api/src/fx/parse.test.ts`, `refund-api/src/fx/months.ts`, `refund-api/src/fx/months.test.ts`, `refund-api/src/fx/months.zurich.test.ts`, `refund-api/src/fx/fixtures/*`, `accounting-api/src/rates/bazgSource*.ts`, `accounting-api/src/rates/parse*.ts`, `accounting-api/src/rates/months*.ts`, `accounting-api/src/rates/fixtures/*`, `accounting-api/src/test-support/fakeSource.ts`
  - agent: backend-dev · backend
  - Details:
    - **Move:** `git mv` the seven files and `fixtures/bazg-xmlavgmonth-2026-03.xml` into
      `accounting-api/src/rates/`, as their own commit.
    - Adapt the imports only. The hardening is unchanged: constant host, `redirect: "error"`,
      512 KiB, DOCTYPE/ENTITY refused, `<monat>` echo, unit normalisation, the rate range,
      `FX_FETCH_GRACE_DAYS = 5`, `FX_FIRST_MONTH = "2026-01"`.
    - `fakeSource.ts` extracted from the old tests.
  - done when: `git log --follow accounting-api/src/rates/parse.ts` shows the history; `bun test
    src/rates/{bazgSource,parse,months,months.zurich}.test.ts` is green, unchanged in assertions; `cd
    refund-api && bun test && bun run typecheck` stays green.

- [x] T11: accounting-api — **move** the FX repo and service as the rates repo and service: per entity, rate in effect, corrections with `replacesRateMicros`, manager fetch (10 s budget) and consumer fetch (6 s budget), throttle, single flight, server-derived trigger, the 20261118 response shape — refs: AC-2.1, AC-2.2, AC-2.4, AC-2.6, AC-2.8, AC-2.10, AC-2.11 — deps: T5, T6, T10
  - touch: `refund-api/src/fx/fx.repo.ts`, `refund-api/src/fx/fx.service.ts`, `refund-api/src/fx/fx.service.test.ts`, `accounting-api/src/rates/rates.repo.ts`, `accounting-api/src/rates/rates.service.ts`, `accounting-api/src/rates/rates.service.test.ts`
  - agent: backend-dev · backend
  - Details:
    - **Move:** `git mv fx.repo.ts → rates.repo.ts`, `fx.service.ts → rates.service.ts`,
      `fx.service.test.ts → rates.service.test.ts`, as their own commit.
    - **Adapt:**
      - every function takes `entity`; currencies come from `RATE_SOURCE`, and welld_it has none;
      - `FX_FETCH_BUDGET_MS = 10_000` for `trigger: "manager"` and `CONSUMER_FETCH_BUDGET_MS = 6_000`
        for `trigger: "consumer"` (the ADR-writer assumption, confirmed);
      - the trigger is a parameter set by the route, never by the body;
      - the result keeps `recorded` per month, `deferredMonths`, and the outcomes `ok`, `failed`,
        `not_fetchable`, `disabled`, `throttled` (G5);
      - the attempt log writes `not_fetchable` only for `manager`; a consumer call writes no row for a
        not-yet-published or throttled month;
      - `consumerRates(entity, pairs, actor)` returns each pair as `in_effect` or `missing` with
        `reason` and `attempted`;
      - the correction appends a `corrected` row with `replacesRateMicros`; a no-op writes nothing.
    - The env switch is `ACCOUNTING_FX_SOURCE`.
  - done when: `bun test src/rates/rates.service.test.ts` is green, including:
    - fetched once;
    - the correction survives a later fetch;
    - a source failure changes no rate and records `failed`;
    - the consumer budget: a 30 s fake → `missing`/`fetch_failed` in under 7 s;
    - the manager budget of 10 s;
    - 36 pairs over 12 months → at most 6 months attempted;
    - throttle within 15 min;
    - a welld_ch fetch writes nothing for welld_it.

    `cd refund-api && bun test && bun run typecheck` stays green.

- [x] T12: accounting-api — exchange-rates user routes: list (window, origin, `lastFetch`, `fetchDue`, `source`, `currencies`), Fetch now, correction — refs: AC-2.3, AC-2.4, AC-2.5, AC-2.7, AC-2.8, AC-2.9, AC-2.11, AC-3.4, AC-3.5 — deps: T8, T11
  - touch: `refund-api/src/fx/fx.routes.ts`, `refund-api/src/fx/fx.routes.test.ts`, `refund-api/src/fx/fx.schemas.ts`, `accounting-api/src/rates/rates.routes.ts`, `accounting-api/src/rates/rates.routes.test.ts`, `accounting-api/src/rates/rates.schemas.ts`, `accounting-api/src/index.ts`
  - agent: backend-dev · backend
  - Details:
    - **Move:** `git mv` the three `fx.routes`/`fx.schemas` files to `rates.*`; after it, `src/fx/`
      in refund-api is empty and is removed.
    - **Adapt:**
      - paths `/v1/entities/{entity}/exchange-rates[/fetch|/{month}/{currency}]`;
      - the window is 2026-01 to the last completed month, plus earlier months with an entry or an
        attempt, newest first;
      - `source: null` and `currencies: []` for welld_it, whose fetch is 422 `no_rate_source`;
      - the correction validates `0 < r < 1000` with ≤ 6 decimals, a completed month, and a
        non-own currency (`invalid_rate`, `month_not_completed`, `currency_not_convertible`);
      - no `trigger` is accepted from the body.
    - Register in `index.ts`.
  - done when: `bun test src/rates/rates.routes.test.ts` is green with the plan's rows AC-2.3, 2.4,
    2.5 (with `999.999999` accepted and `1000` refused), 2.7, 2.8 (visible to a reader), 2.9 (a reader
    → 403 with no attempt row) and 2.11; `refund-api/src/fx` no longer exists; refund-api is green.

- [x] T13: accounting-api — system routes: `GET /system/v1/entities/{entity}/reference-data` and `…/rates?pairs=` (scope, `SYSTEM_READERS`, identical 401, no-store, consumer fetch) — refs: AC-3.8, AC-2.10, AC-1.4, AC-1.8, AC-1.9, AC-1.10, AC-4.1 — deps: T7, T9, T12
  - touch: `accounting-api/src/system/referenceData.routes.ts`, `accounting-api/src/system/rates.routes.ts`, `accounting-api/src/system/system.routes.test.ts`, `accounting-api/src/system/readers.ts`, `accounting-api/src/index.ts`
  - agent: backend-dev · backend
  - Details:
    - `systemAuth` (`aud = SERVICE_AUDIENCE`), then the scope `accounting.reference.read`, then `sub`
      in `SYSTEM_READERS = ["system:refund-api"]`, with one 401 body for every failure.
    - GET only.
    - Responses are validated with `accountingWire` before sending.
    - `pairs`: 1..36 distinct, months ≥ 2000-01, a currency of the entity (else 422
      `currency_not_convertible`).
    - The consumer fetch runs with the service sub as the attempt actor.
  - done when: `bun test src/system` is green:
    - the reference data equals the reader projection of `GET /v1/entities/{e}/…` for the same entity;
    - deactivate and reactivate flip `active` in it;
    - a missing published month is fetched and answered (trigger `consumer`);
    - 401 is byte-identical for no token, a user JWT, wrong aud, expired, missing scope and
      `system:crm-api`;
    - POST, PUT and DELETE → 404.

- [x] T14: accounting-api — **move** the seed data and add `seed:welld-ch` (operator-run, idempotent, `--dry-run`, system actor) — refs: AC-1.1, AC-1.13, AC-7.5 — deps: T9, T22
  - touch: `refund-api/scripts/data/accounting-seed.welld-ch.json`, `accounting-api/scripts/data/seed.welld-ch.json`, `accounting-api/scripts/seed-welld-ch.ts`, `accounting-api/scripts/seed-welld-ch.test.ts`, `accounting-api/package.json`
  - agent: backend-dev · backend
  - Details:
    - **Move:** `git mv refund-api/scripts/data/accounting-seed.welld-ch.json
      accounting-api/scripts/data/seed.welld-ch.json`, then trim it to `ledgerAccounts` and
      `vatCodes`. T22 has already created refund-api's `accounting-defaults.welld-ch.json` and stopped
      reading this file.
    - The script runs in one transaction. It adds only absent numbers and codes as
      `system:accounting-seed`, never touches an existing entry, and prints counts and the
      numbers/codes added, with no personal data.
    - The "seeds agree" test checks that every number and code in refund-api's defaults file exists
      in this file.
  - done when: `bun test scripts` is green (two runs → the second adds nothing; an existing
    deactivated entry stays deactivated; `--dry-run` writes nothing; the seeds agree);
    `package.json` has `seed:welld-ch`; refund-api is green.

- [x] T15: accounting-api — adversarial and cross-cutting tests — refs: AC-3.6, AC-3.8, AC-2.10, AC-6.8 — deps: T13
  - touch: `accounting-api/src/matrix.test.ts`, `accounting-api/src/budgets.cross-package.test.ts`
  - agent: qe · backend
  - Details:
    - `matrix.test.ts`: every `/v1/*` route × {no grant → 403 with no data, other entity → 404,
      reader write → 403}; no user route accepts a service JWT and no system route a user JWT.
    - `budgets.cross-package.test.ts` reads `CONSUMER_FETCH_BUDGET_MS` and refund-api's
      `ACCOUNTING_DEADLINE_MS` (repo-relative import) and asserts budget + 1 s < deadline. The REF
      constant comes from T17; until it exists the test is skipped with a reason, and it must be
      unskipped before T46.
  - done when: `bun test` (whole accounting-api) is green with both files present and unskipped.

## REF — refund-api

- [x] T16: refund-api — migration `<ts1>_accounting_copies`: copy columns, the two default tables, carried data, guard v2 (copies locked when paid and numbered, fx write-once), CHECKs, `line_rate_copied` — refs: AC-4.7, AC-5.3, AC-5.6, AC-5.7, AC-7.1 — deps: none
  - touch: `refund-api/prisma/schema.prisma`, `refund-api/prisma/migrations/*`, `refund-api/src/lib/db.accounting-receipt-guard.test.ts`, `refund-api/src/lib/db.accounting-copies.test.ts`, `refund-api/src/lib/migration.accounting-move.test.ts`, `refund-api/src/test-support/dbCleanup.ts`
  - agent: backend-dev · backend
  - Details:
    - Plan § Data model, refund-api, steps 1–5 and 7. The old FK columns and tables **stay** (dropped
      by T24).
    - The guard v2 does not reference the old FK columns.
    - CHECKs are added `NOT VALID`, then `VALIDATE`d.
    - `dbCleanup.ts` TRUNCATEs the two new tables.
    - The migration test builds `refund_mig` (:5445) up to `20261119090000`, inserts fixture rows
      (classified CH lines, a paid numbered line, an EUR line with an old rate, defaults and
      designation history), applies this migration, and asserts the copies, the carried history (same
      ids and actors) and the EUR rate copy. It drops `refund_mig` at the end.
  - done when: `bun run db:deploy` applies on `refund`; `bun test
    src/lib/db.accounting-{receipt-guard,copies}.test.ts src/lib/migration.accounting-move.test.ts` is
    green:
    - copies locked on a paid numbered line;
    - fx: null → set allowed, set → changed refused on any status;
    - every CHECK refuses its bad row;
    - immutability of both new tables;
    - the migration test passes.

    The whole `bun test` is green (old code still on the old columns).

- [x] T17: refund-api — `AccountingPort` (live, 10 s per operation, one 401 re-mint, every failure kind = unavailable), `referenceSnapshot`, `fakeAccounting`, `ACCOUNTING_INTERNAL_URL` — refs: AC-6.8, AC-4.8, AC-3.9 — deps: T7
  - touch: `refund-api/src/accounting/accountingClient.ts`, `refund-api/src/accounting/accountingClient.test.ts`, `refund-api/src/accounting/referenceSnapshot.ts`, `refund-api/src/accounting/referenceSnapshot.test.ts`, `refund-api/src/test-support/fakeAccounting.ts`, `refund-api/src/lib/env.ts`, `refund-api/src/lib/env.test.ts`, `refund-api/.env.example`
  - agent: backend-dev · backend
  - Details:
    - The client uses the existing `serviceTokens` with scope `accounting.reference.read`.
      `ACCOUNTING_DEADLINE_MS = 10_000` (injectable for tests). There is no cache across operations;
      memoisation is per operation object.
    - Failure kinds: timeout, network, a non-2xx after one 401 re-mint, a redirect, non-JSON, a body
      over 256 KiB, a schema mismatch, a wrong entity echo, a missing or duplicated pair, a token mint
      failure. Logs carry the kind and operation only.
    - `referenceSnapshot`: `lookupAccount(number)` and `lookupVat(code)` → `active`, `deactivated`,
      `not_found`; `unverified` when unavailable.
    - `fakeAccounting` can hold data, delay, fail with each kind, and count calls.
    - `ACCOUNTING_INTERNAL_URL` is required.
  - done when: `bun test src/accounting/{accountingClient,referenceSnapshot}.test.ts src/lib/env.test.ts`
    is green: each failure kind → `AccountingUnavailableError`; a 150 ms answer at a 200 ms deadline →
    ok, 250 ms → unavailable; two operations → two reads; the default constant is 10 000. refund-api
    `bun run typecheck` is clean.

- [x] T18: refund-api — resolver on copies and snapshot; the default and designation tables with live validation and states; audit detail v2 and `line_rate_copied` types — refs: AC-4.4, AC-4.5, AC-4.7, AC-6.3, AC-6.9, AC-6.10, AC-3.7 — deps: T16, T17
  - touch: `refund-api/src/accounting/classification.ts`, `refund-api/src/accounting/classification.test.ts`, `refund-api/src/accounting/classification.repo.ts`, `refund-api/src/accounting/defaults.repo.ts`, `refund-api/src/accounting/defaults.routes.ts`, `refund-api/src/accounting/defaults.schemas.ts`, `refund-api/src/accounting/defaults.routes.test.ts`, `refund-api/src/requests/audit.ts`
  - agent: backend-dev · backend
  - Details:
    - `resolveClassification` keeps its rules on copies (number/name, code/rate) and a snapshot. An
      unusable default (deactivated, not found, unverified) resolves to none for approval, but is
      reported with its state and `isDefault: true` (G8a).
    - `classifiableInput` moves from `classification.repo.ts` into `classification.ts`, so T19–T21 do
      not share a file.
    - Defaults: GET returns copies, states and `accounting: available|unavailable`. PUT takes
      natural keys and is validated live (422 inactive or not found, 503 `accounting_unavailable`
      with `Retry-After: 30`); it appends copies, and a no-op is suppressed. The designation works
      the same way. Gates unchanged (`settings:read` and `settings:manage`).
    - `audit.ts`: `line_classified` detail v2, `line_rate_copied`; readers accept v1.
    - Problem `detail`s are generic English (AC-6.10).
  - done when: `bun test src/accounting/{classification,defaults.routes}.test.ts` is green with the
    plan's rows AC-4.4, 4.5, 4.7 (the history unchanged after the fake deactivates the entry, renames
    it or is unreachable), 6.9 and the AC-3.7 second half (an Accounting manager without
    `settings:manage` → 403); every 4xx/5xx body matches no URL, host, cuid or stack pattern.

- [x] T19: refund-api — review view, `/accounting/options` (gate D16), classification PUT by natural key with copies, `viewer.canOpenAccountingRates`, Accounting-unavailable view; withdraw clears copies — refs: AC-4.1, AC-4.2, AC-4.3, AC-4.9, AC-5.2, AC-5.7, AC-6.5, AC-6.10, AC-7.3, AC-1.4, AC-1.8, AC-3.9 — deps: T18
  - touch: `refund-api/src/accounting/classification.repo.ts`, `refund-api/src/accounting/classification.routes.ts`, `refund-api/src/accounting/classification.schemas.ts`, `refund-api/src/accounting/classification.routes.test.ts`, `refund-api/src/accounting/classification.inactive-default.test.ts`, `refund-api/src/accounting/classification.race.test.ts`, `refund-api/src/requests/lifecycle.repo.ts`, `refund-api/src/requests/lifecycle.routes.test.ts`, `refund-api/src/authz/accountingViewer.ts`, `refund-api/src/authz/accountingViewer.test.ts`
  - agent: backend-dev · backend
  - Details:
    - Plan § API (review view, options, PUT): `rateStatus`, states, `accounting:
      available|unavailable` (the view is still 200 when Accounting is unreachable).
    - The PUT reads Accounting before the transaction (503 if unreachable), then locks the request
      `FOR UPDATE` and writes copies; it never touches fx or money. SR-1, SR-2, FR-1 and FR-2 are
      unchanged.
    - `accountingViewer.ts`: `canOpenAccountingRates(permissions, user)` = `accounting:read` or
      `manage` covering welld_ch, using the same coverage rule (it also reads auth's vectors file).
    - Withdraw clears the copy columns, with cause `withdrawn` (the ADR-writer assumption, confirmed).
  - done when: `bun test src/accounting/classification.*.test.ts src/requests/lifecycle.routes.test.ts
    src/authz/accountingViewer.test.ts` is green with the plan's rows AC-4.1 (exact key sets), 4.2,
    4.3, 4.9, 5.2, 5.7, 6.5, 7.3 (view flag); the 20261118 race test passes 20 iterations with the
    fake; withdraw leaves the copy columns null.

- [x] T20: refund-api — approve: Accounting pre-read (superset of pairs), copies, rate copy or pending, 503 `accounting_unavailable`, `classification_missing` on unusable defaults; `classifyAndNumber` on copies — refs: AC-5.1, AC-5.6, AC-6.1, AC-6.2, AC-6.3, AC-6.4, AC-4.9, AC-7.1 — deps: T18
  - touch: `refund-api/src/review/decide.repo.ts`, `refund-api/src/review/decide.routes.ts`, `refund-api/src/review/decide.routes.test.ts`, `refund-api/src/review/approve-accounting.test.ts`, `refund-api/src/accounting/numbering.repo.ts`, `refund-api/src/accounting/numbering.repo.test.ts`, `refund-api/src/accounting/receipt.lifecycle.test.ts`
  - agent: backend-dev · backend
  - Details:
    - Order: authorization, self-approval, status pre-check, release gate, then (with ≥ 1 non-rejected
      CH line, D10) the reference data and rates for every non-CHF CH line of the request, then the
      CAS transaction.
    - `classifyAndNumber` writes the copies and, for non-CHF lines, `fx*` or leaves the rate pending.
      Audit `line_classified` v2 carries `fxRate`.
    - IT-only and all-CH-rejected requests make no Accounting call.
  - done when: `bun test src/review src/accounting/{numbering.repo,receipt.lifecycle}.test.ts` is
    green with the plan's rows AC-5.1, 5.6 (approval part), 6.1, 6.2 (no number, counter, copy, decision
    or audit after each refusal), 6.3, 6.4 (0 fake calls), 4.9; every 20261118 approval and numbering
    assertion still holds (AC-7.1).

- [x] T21: refund-api — export from copies: the pending-rate copy inside the export transaction (`line_rate_copied`), the `accountingUnavailable` blocker, `missingRates[].reason`, `fetchAttempted`, `ratePendingLineCount`, `viewer.canOpenAccountingRates` — refs: AC-5.3, AC-5.4, AC-5.5, AC-5.6, AC-6.6, AC-6.7, AC-7.2, AC-7.3 — deps: T18
  - touch: `refund-api/src/accounting/export.repo.ts`, `refund-api/src/accounting/export.routes.ts`, `refund-api/src/accounting/export.schemas.ts`, `refund-api/src/accounting/export.routes.test.ts`, `refund-api/src/accounting/export.failures.test.ts`, `refund-api/src/accounting/export.test.ts`, `refund-api/src/accounting/rateCopy.repo.ts`, `refund-api/src/accounting/rateCopy.repo.test.ts`
  - agent: backend-dev · backend
  - Details:
    - CHF and VAT amounts come from `fxRateMicros` and `vatRateBasisPoints`.
    - With no pending line there is no Accounting call.
    - The CSV transaction: lock the pending lines, `UPDATE … WHERE "fxRateMicros" IS NULL`, audit,
      re-read, build, write the log, commit, send.
    - `viewer` comes from T19's `accountingViewer.ts`, which is imported, not touched. The import is
      what makes T21 depend on T19 at merge, and it is declared in § Overlap check.
    - The golden CSV and its input fixture are unchanged.
  - done when: `bun test src/accounting/{export*,rateCopy.repo}.test.ts` is green with the plan's rows
    AC-5.3 (CSV bytes unchanged after the fake changes), 5.4 (0 fake calls while unreachable; two
    exports identical), 5.5 (`10.40;0.9246;9.62` with the fake at 0.9300), 5.6 (export copy, refused
    export copies nothing, concurrent exports → one copy), 6.6, 6.7 (with `reason`), 7.2 (golden file
    byte-identical), 7.3.

- [x] T22: refund-api — `accounting:release` rewritten: read Accounting first (exit 2, nothing written, if it cannot), seed Refund defaults and designation from `accounting-defaults.welld-ch.json` by natural key, backfill copies, rate or pending — refs: AC-7.4, AC-7.5 — deps: T20
  - touch: `refund-api/scripts/accounting-release.ts`, `refund-api/scripts/accounting-release.test.ts`, `refund-api/scripts/accounting-release.cli.test.ts`, `refund-api/scripts/data/accounting-defaults.welld-ch.json`, `refund-api/src/test-support/accountingRelease.ts`
  - agent: backend-dev · backend
  - Details:
    - The new JSON holds `typeDefaults` and `foreignCurrencyVatCode`, copied from the old seed. The
      old seed file is no longer read; T14 moves it.
    - The script does not seed the catalog any more. Rates are asked in chunks of 6 months. A default
      not active in Accounting is skipped and reported.
    - The report adds the "rate pending" and "left unclassified" counts. SR-3, SR-4, `--offsets` and
      `--dry-run` are unchanged.
  - done when: `bun test scripts` is green with the plan's rows AC-7.4 (with the fake unreachable:
    exit 2, the message, and no number, copy, default, designation or marker; a rerun works) and AC-7.5
    (empty Accounting → numbered and listed unclassified, and a later approval → 409); the report has
    no `@` without `--show-emails`.

- [x] T23: refund-api — cut the legacy surface: unregister the catalog and exchange-rate routes, remove `fxService` wiring and `REFUND_FX_SOURCE`, add the removed-routes test — refs: AC-3.7, AC-4.6 — deps: T19, T20, T21, T22
  - touch: `refund-api/src/index.ts`, `refund-api/src/lib/env.ts`, `refund-api/src/lib/env.test.ts`, `refund-api/.env.example`, `refund-api/src/removed-routes.test.ts`
  - agent: backend-dev · backend
  - Details:
    - After this task nothing outside `src/accounting/catalog.*` and `src/fx/*` imports them. The
      files stay, dead, for T8, T10, T11 and T12 to move.
  - done when:
    - `bun test && bun run typecheck` is green;
    - `removed-routes.test.ts` shows `/accounting/ledger-accounts`, `/accounting/vat-codes`,
      `/exchange-rates` and their sub-paths → 404 for a `settings:manage` holder;
    - `grep -rlE "catalog\.(repo|routes|schemas)|/fx/" refund-api/src refund-api/scripts` lists only
      files inside `src/accounting/catalog.*`, `src/fx/` and `src/lib/db.fx-fetched-once.test.ts`.

- [x] T24: refund-api — migration `<ts2>_accounting_reference_moved_out`: drop the old FK columns, the six moved tables and the enum; schema and tests follow — refs: AC-5.3, AC-5.7 — deps: T8, T11, T12, T23
  - touch: `refund-api/prisma/schema.prisma`, `refund-api/prisma/migrations/*`, `refund-api/src/lib/db.accounting-immutability.test.ts`, `refund-api/src/lib/db.fx-fetched-once.test.ts`, `refund-api/src/lib/migration.accounting-move.test.ts`, `refund-api/src/test-support/dbCleanup.ts`
  - agent: backend-dev · backend
  - Details:
    - Plan § Data model, step 6.
    - `git rm src/lib/db.fx-fetched-once.test.ts`; its accounting-api counterpart is in T5.
    - `db.accounting-immutability.test.ts` keeps `refund_batch_export` and the two default tables.
    - The migration test is extended to apply both migrations and assert that the drops happened.
  - done when: both migrations apply on a fresh DB and on `refund`; `prisma migrate diff` shows no
    difference; the extended migration test and the whole `bun test` are green; "an UPDATE of a
    non-accounting column of a paid numbered line succeeds" is asserted, so the guard no longer
    references a dropped column.

- [x] T25: refund-api — adversarial and cross-cutting tests — refs: AC-4.8, AC-6.8, AC-6.10, AC-7.1, AC-7.2 — deps: T23
  - touch: `refund-api/src/accounting/accounting-unavailable.matrix.test.ts`, `refund-api/src/accounting/natural-keys.test.ts`, `refund-api/src/accounting/no-cache.test.ts`
  - agent: qe · backend
  - Details:
    - The matrix runs one failure kind (each of AC-6.8's list) through approve, classify, view,
      options, settings write, export and release, and asserts the outcome of AC-6.1 to 6.6 and 6.9.
    - The no-cache test counts fresh reads per listed operation.
    - The natural-keys test: the fake re-numbers its internal ids and the defaults still resolve.
    - The AC-6.10 body scan covers every refusal.
  - done when: `bun test` (whole refund-api) is green with the three files.

## UI — accounting-ui and shell

- [x] T26: accounting-ui — scaffold from letterheads-ui: package (port 5183, federation `accounting`, `./App` and `./version`, `@operai/ui` with `import: false`), Vitest with stubs, `api.ts`, the copied `LoadState`/`PermissionDenied`/`NotFoundPage`/`Saved`, `useLoadedResource`, the axe helper and its self-test, `lib/limits.ts`, the strings skeleton — refs: AC-8.4 — deps: none
  - touch: `accounting-ui/*` (top-level files: `package.json`, `pnpm-lock.yaml`, `vite.config.ts`, `vitest.config.ts`, `tsconfig*.json`, `eslint.config.js`, `index.html`, `postcss.config.js`, `vercel.json`, `.gitignore`, `.prettierrc`, `CHANGELOG.md`), `accounting-ui/src/*.ts`, `accounting-ui/src/*.tsx`, `accounting-ui/src/lib/*`, `accounting-ui/src/components/LoadState.tsx`, `accounting-ui/src/components/PermissionDenied.tsx`, `accounting-ui/src/components/Saved.tsx`, `accounting-ui/src/pages/NotFoundPage.tsx`, `accounting-ui/src/hooks/useLoadedResource*.ts`, `accounting-ui/src/federation/*`, `accounting-ui/src/test-support/*`, `lerna.json`
  - agent: frontend-dev · frontend
  - Details:
    - The scaffold follows commit a8448b6f.
    - `useLoadedResource` is copied from refund-ui, with its `ApiError` from `lib/api.ts` (G4).
    - `axe.ts` and `axe.test.tsx` are copied unchanged; `axeKnownFindings.ts` is not; `axe-core
      ^4.14.0` is added.
    - `lib/limits.ts` mirrors the server limits.
    - `strings.ts` has `en` and `it` skeletons, with the parity and `noHardcodedStrings` tests.
    - The package `name` is `@operai/accounting-ui`, version `0.0.0`.
  - done when: `cd accounting-ui && pnpm install && pnpm lint && pnpm test && pnpm build` is green;
    the axe self-test proves the helper fails on the broken fixture.

- [x] T27: accounting-ui — the whole copy catalog (en + it) from design § Copy keys — refs: AC-8.4 — deps: T26
  - touch: `accounting-ui/src/strings.ts`, `accounting-ui/src/strings.test.ts`
  - agent: frontend-dev · frontend
  - Details:
    - Every accounting-ui key of design.md § Copy keys, at once: the moved cards' keys under their
      new names, the UX-4 reader sentences, UX-7 deactivate, UX-10 correction, UX-11 month note, UX-13
      empty states, UX-15 failure ladder, the entity names.
    - Functions for sentences with values. No other task edits `strings.ts`; a missing key is a small
      follow-up commit on this file, serialized.
  - done when: `pnpm test src/strings.test.ts` is green (`catalogGaps(en, it)` is `[]`), and every key
    named in design § Copy keys for accounting-ui exists (a test that lists them).

- [x] T28: accounting-ui — frame: `AccountingShell` (`/v1/me`, failure ladder), router with `TabNav` (three routes, `?entity=` carried, `?month=` dropped), `EntitySwitch` and `useEntity` (garbage → fallback, uncovered → not found, 404 → re-read), three page placeholders — refs: AC-8.2, AC-3.5, AC-3.6, AC-8.4 — deps: T27
  - touch: `accounting-ui/src/router.tsx`, `accounting-ui/src/router.test.tsx`, `accounting-ui/src/App.tsx`, `accounting-ui/src/App.test.tsx`, `accounting-ui/src/components/AccountingShell*.tsx`, `accounting-ui/src/components/EntitySwitch*.tsx`, `accounting-ui/src/hooks/useEntity*.ts`, `accounting-ui/src/pages/LedgerAccountsPage.tsx`, `accounting-ui/src/pages/VatCodesPage.tsx`, `accounting-ui/src/pages/ExchangeRatesPage.tsx`
  - agent: frontend-dev · frontend
  - Details: design UX-1, UX-2, UX-3, UX-12, UX-15, AS1, AS2, AS7. The page files are placeholders
    (heading + entity) owned afterwards by T29–T31.
  - done when: `pnpm test` is green:
    - with two entities the switch appears and writes `?entity=` with `replace`;
    - one entity → no switch;
    - `?entity=xyz` → falls back;
    - `?entity=welld_it` for a CH-only person → not-found view with focus on its heading;
    - 403 → `PermissionDenied`;
    - 503 → the auth-unavailable banner with Retry;
    - axe has no violations in every frame state.

- [x] T29: accounting-ui — **move** the ledger-account card and dialog and `useCatalogToggle`, adapted: entity, number keys, no Added column, reader sentence, `reactivate` pointer, AC-1.2 limits, `fields[]` — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.9, AC-1.11, AC-1.12, AC-8.3, AC-8.4 — deps: T28, T34
  - touch:
    - `refund-ui/src/components/settings/LedgerAccountsCard.tsx`, `refund-ui/src/components/settings/LedgerAccountsCard.test.tsx`, `refund-ui/src/components/settings/AddLedgerAccountDialog.tsx`, `refund-ui/src/components/settings/AddLedgerAccountDialog.test.tsx`, `refund-ui/src/components/settings/useCatalogToggle.ts` (source side);
    - `accounting-ui/src/components/LedgerAccountsCard*.tsx`, `accounting-ui/src/components/AddLedgerAccountDialog*.tsx`, `accounting-ui/src/hooks/useCatalogToggle.ts`, `accounting-ui/src/lib/catalogApi.ts`, `accounting-ui/src/lib/catalogApi.test.ts`, `accounting-ui/src/lib/statusMeaning.ts`, `accounting-ui/src/pages/LedgerAccountsPage.tsx`.
  - agent: frontend-dev · frontend
  - Details:
    - **Move** with `git mv` as its own commit; T34 has already removed their only refund-ui importer.
    - Then adapt: UX-3, UX-4 (`canManage` from `/v1/me`), UX-5, UX-6 (no `ErrorSummary`, focus on the
      first refused field), UX-7, UX-8, UX-15 (403 re-reads `/v1/me`).
    - Test ids `accounting-ledger-*`. `catalogApi.ts` is new (paths `/v1/entities/{entity}/…`, no ids).
  - done when: `git log --follow` shows the refund-ui history; `cd accounting-ui && pnpm test && pnpm
    build && pnpm lint` is green with the design's AS3 and AS6 state matrix under axe; `cd refund-ui &&
    pnpm test && pnpm build` stays green.

- [x] T30: accounting-ui — **move** the VAT-code card and dialog, adapted: code keys, upper-case, rate limits, case-insensitive duplicate with `reactivate`, `formatVatRate` copy — refs: AC-1.5, AC-1.6, AC-1.7, AC-1.8, AC-1.10, AC-8.3, AC-8.4 — deps: T29
  - touch: `refund-ui/src/components/settings/VatCodesCard.tsx`, `refund-ui/src/components/settings/VatCodesCard.test.tsx`, `refund-ui/src/components/settings/AddVatCodeDialog.tsx`, `refund-ui/src/components/settings/AddVatCodeDialog.test.tsx`, `accounting-ui/src/components/VatCodesCard*.tsx`, `accounting-ui/src/components/AddVatCodeDialog*.tsx`, `accounting-ui/src/lib/catalogApi.ts`, `accounting-ui/src/lib/catalogApi.test.ts`, `accounting-ui/src/lib/formatVatRate.ts`, `accounting-ui/src/pages/VatCodesPage.tsx`
  - agent: frontend-dev · frontend
  - Details: as T29, for AS4. No rate edit control (AC-1.7).
  - done when: as T29, for the VAT-code matrix; a test asserts there is no edit control for a rate.

- [x] T31: accounting-ui — **move** the exchange-rates card, the correction dialog and `exchangeRatesApi`, adapted: entity, no history drawer, no `trigger`, Source and last-fetch outcome, WellD Italia no-source panel, deep link and "month not listed" note, UX-10 copy and limits, auto-fetch once for managers — refs: AC-2.3, AC-2.4, AC-2.5, AC-2.7, AC-2.8, AC-2.9, AC-2.11, AC-7.3, AC-8.4 — deps: T28, T34, T37
  - touch: `refund-ui/src/components/settings/ExchangeRatesCard.tsx`, `refund-ui/src/components/settings/ExchangeRatesCard.test.tsx`, `refund-ui/src/components/settings/RateCorrectionDialog.tsx`, `refund-ui/src/components/settings/RateCorrectionDialog.test.tsx`, `refund-ui/src/lib/exchangeRatesApi.ts`, `refund-ui/src/lib/exchangeRatesApi.test.ts`, `accounting-ui/src/components/ExchangeRatesCard*.tsx`, `accounting-ui/src/components/RateCorrectionDialog*.tsx`, `accounting-ui/src/lib/exchangeRatesApi*.ts`, `accounting-ui/src/lib/monthLabel*.ts`, `accounting-ui/src/pages/ExchangeRatesPage.tsx`
  - agent: frontend-dev · frontend
  - Details:
    - **Move** as its own commit. T34 removed the `ExchangeRatesView` importer; T37 removed
      `accountingExportApi`'s import of `exchangeRatesApi` types.
    - `monthLabel` is copied from refund-ui; refund-ui keeps its own.
    - The response shape includes `recorded`, `deferredMonths` and the five outcomes (G5).
  - done when: `git log --follow` shows the history; accounting-ui tests are green with the design's AS5
    matrix under axe (no source, a missing cell, auto-fetch running, the failed banner, switched off,
    throttled, the deep-link note); refund-ui stays green.

- [x] T32: shell — register Accounting: `ToolId`/`TOOLS` (last in the main list), Sidebar icon `list-ordered`, gated `/accounting/$`, remote entry (build-time and runtime), types and stubs, `getAccountingApiBaseUrl` + trusted origin, strings, CSP, `useRemoteVersions` — refs: AC-8.1, AC-3.6, AC-3.9 — deps: none
  - touch: `shell/src/lib/tools.ts`, `shell/src/lib/tools.test.ts`, `shell/src/components/Sidebar.tsx`, `shell/src/components/Sidebar.test.tsx`, `shell/src/router.tsx`, `shell/src/router.accounting.test.tsx`, `shell/src/strings.ts`, `shell/src/lib/session.ts`, `shell/src/lib/session.test.ts`, `shell/src/lib/runtimeRemotes.ts`, `shell/src/lib/runtimeRemotes.test.ts`, `shell/src/federation/*`, `shell/src/federation/__stubs__/*`, `shell/src/hooks/useRemoteVersions.ts`, `shell/src/components/AboutModal.test.tsx`, `shell/vite.config.ts`, `shell/vitest.config.ts`, `shell/vercel.json`, `shell/src/vite-env.d.ts`
  - agent: frontend-dev · frontend
  - Details: plan § Components (shell) and design UX-14 and G1. `ACCOUNTING_REMOTE_URL` defaults to
    `http://localhost:5183/remoteEntry.js`; `VITE_ACCOUNTING_API_URL` is optional and trusted only when
    set.
  - done when: `cd shell && pnpm test && pnpm lint && pnpm build` is green:
    - the Sidebar shows "Accounting" only with `apps ∋ accounting`, after Projects;
    - `/accounting` is refused without it;
    - `getAccountingApiBaseUrl` origin is trusted only when set;
    - `noHardcodedStrings` and the remote-version tests include accounting.

## RUI — refund-ui

- [x] T33: refund-ui — copy additions (en + it): defaults states, unavailable notes, link note, rate pending, `accounting_unavailable` sentences, the export blocker, pending count, "ask an accounting manager" — refs: AC-6.10 — deps: none
  - touch: `refund-ui/src/strings.ts`, `refund-ui/src/strings.test.ts`
  - agent: frontend-dev · frontend
  - Details: design § Copy keys "refund-ui: added, changed". Removals wait for T38: the moved
    components still read their keys until they move.
  - done when: `pnpm test src/strings.test.ts` is green (parity), and every added key of design § Copy
    keys exists (a listing test).

- [x] T34: refund-ui — Settings: two views (General, Default classification), `AccountingSettingsView` → `DefaultsSettingsView` by `git mv` without the catalog cards, `ExchangeRatesView` removed, `AccountingLinkNote` — refs: AC-4.6 — deps: T33
  - touch: `refund-ui/src/pages/SettingsPage.tsx`, `refund-ui/src/pages/SettingsPage.test.tsx`, `refund-ui/src/pages/settings/*`, `refund-ui/src/components/AccountingLinkNote.tsx`, `refund-ui/src/components/AccountingLinkNote.test.tsx`
  - agent: frontend-dev · frontend
  - Details:
    - Design UX-16 and UX-17. `?section=general|defaults`, with any other value → General.
    - The link note reads `apps` from `usePermissions()`.
    - After this task the six catalog and rate components have no importer in refund-ui (moved by T29
      to T31).
  - done when: `pnpm test && pnpm build` is green: Settings renders only the two views;
    `?section=exchange-rates` → General; the note shows a link with `apps ∋ accounting` and the text
    without it; `SettingsViews.a11y.test.tsx` has no axe violations; `grep -rl
    "LedgerAccountsCard\|VatCodesCard\|ExchangeRatesCard" refund-ui/src` lists only those components'
    own files.

- [x] T35: refund-ui — Default classification card and dialogs: number/code values, states (`StatusBadge` per UX-18), unavailable banner with Retry and `aria-disabled` Change (UX-19, UX-23), 503 and 422 in the dialogs; `CatalogSelect` and `useActiveCatalogOptions` on `/accounting/options` — refs: AC-4.4, AC-4.5, AC-4.7, AC-6.9, AC-6.10 — deps: T34
  - touch: `refund-ui/src/components/settings/ExpenseTypeDefaultsCard*.tsx`, `refund-ui/src/components/settings/DefaultClassificationDialog*.tsx`, `refund-ui/src/components/settings/ForeignCurrencyVatDialog*.tsx`, `refund-ui/src/components/settings/useActiveCatalogOptions.ts`, `refund-ui/src/components/CatalogSelect*.tsx`, `refund-ui/src/lib/accountingApi.ts`, `refund-ui/src/lib/accountingApi.test.ts`
  - agent: frontend-dev · frontend
  - Details: `accountingApi.ts` gets the new defaults, designation and options shapes; its catalog half
    stays until T38.
  - done when: `pnpm test && pnpm build` is green: the states render with the right badge; the
    history shows the recorded copies; unavailable → banner, Change `aria-disabled` with its reason,
    History still opens, Retry focuses the card heading and announces the result; a 503 in a dialog
    shows the message and no options; axe is clean on every new state.

- [x] T36: refund-ui — review page: the panel on number/code values with states, rate pending, the Accounting-unavailable page banner and read-only lines, the 503 branch inside the approve dialog, the rate link from `viewer.canOpenAccountingRates` — refs: AC-4.1, AC-4.2, AC-4.3, AC-4.9, AC-5.2, AC-5.6, AC-6.1, AC-6.5, AC-6.10, AC-7.3 — deps: T35
  - touch: `refund-ui/src/components/LineClassificationPanel*.tsx`, `refund-ui/src/pages/ReviewDetailPage.tsx`, `refund-ui/src/pages/ReviewDetailPage.test.tsx`
  - agent: frontend-dev · frontend
  - Details:
    - Design RS4, RS5, UX-18 to UX-21 and UX-23. The approve switch on `error.code` gains
      `accounting_unavailable`.
    - The view is reloaded after a classification 503.
    - FU-S7/A-1 of 20261118 is untouched (G14).
  - done when: `pnpm test && pnpm build` is green:
    - a deactivated stored value shows as the selected disabled option with its hint;
    - pending → badge and "—";
    - unavailable → banner, no selects, a PUT 503 reverts the value;
    - approve 503 → the `role="alert"` sentence in the dialog, Approve still available;
    - the rate link only with the flag;
    - axe is clean.

- [x] T37: refund-ui — export card: the `accountingUnavailable` blocker, `missingRates[].reason`, the pending count, the AC-7.3 link from `viewer.canOpenAccountingRates`, the quiet re-read after a download; `accountingExportApi` no longer imports `exchangeRatesApi` — refs: AC-5.6, AC-6.6, AC-6.7, AC-7.3 — deps: T33
  - touch: `refund-ui/src/components/AccountingExportCard*.tsx`, `refund-ui/src/lib/accountingExportApi.ts`, `refund-ui/src/lib/accountingExportApi.test.ts`, `refund-ui/src/pages/BatchDetailPage.test.tsx`
  - agent: frontend-dev · frontend
  - Details: design RS6 and UX-22. Links are plain `<a className="link">` (UX-17).
  - done when: `pnpm test && pnpm build` is green:
    - the blocked card shows "Accounting cannot be read" as its own heading;
    - a `not_published` item says "not published yet";
    - the link to `/accounting/exchange-rates?entity=welld_ch&month=2026-03` appears only with the
      flag;
    - the pending sentence disappears after the quiet re-read;
    - `grep exchangeRatesApi refund-ui/src/lib/accountingExportApi.ts` is empty;
    - axe is clean.

- [x] T38: refund-ui — cleanup after the moves: remove the moved components' copy keys, the catalog half of `accountingApi.ts`, the unused parts of `catalogLabels.ts` — refs: none (cleanup; AC-4.6 regression) — deps: T29, T30, T31, T35, T36, T37
  - touch: `refund-ui/src/strings.ts`, `refund-ui/src/strings.test.ts`, `refund-ui/src/lib/accountingApi.ts`, `refund-ui/src/lib/accountingApi.test.ts`, `refund-ui/src/lib/catalogLabels.ts`, `refund-ui/src/lib/catalogLabels.test.ts`
  - agent: frontend-dev · frontend
  - done when: `pnpm lint && pnpm test && pnpm build` is green; no `settings.accounts`,
    `settings.vatCodes` or `settings.fx` key remains; `knip`-style check: `grep` finds no export of
    `accountingApi.ts` or `catalogLabels.ts` without an importer.

## OPS — e2e, plumbing, infra docs, docs, changesets

- [x] T39: repo plumbing for local dev: `mise.toml` (dev, dev:web, dev:preview, db:migrate with accounting-api :8089 and accounting-ui :5183, `VITE_ACCOUNTING_API_URL` default), `compose.yaml` (`accounting-api` service, DB `accounting`) — refs: none (dev environment) — deps: T4, T26
  - touch: `mise.toml`, `compose.yaml`
  - agent: orchestrator · release
  - done when: `mise tasks` lists the updated tasks; `docker compose config` validates; `mise run
    dev`'s script text names both new processes (checked by reading, not by running the stack).

- [x] T40: e2e — global setup (accounting-api health pre-check, `seed:welld-ch`, then Refund's release; `E2E_SKIP_ACCOUNTING_SEED`), `helpers/accountingFixtures.ts`, `refundFixtures.ts` on natural keys — refs: AC-7.5 — deps: T3, T14, T22, T39
  - touch: `shell/e2e/global-setup.ts`, `shell/e2e/helpers/accountingFixtures.ts`, `shell/e2e/helpers/refundFixtures.ts`, `shell/playwright.config.ts`
  - agent: qe · e2e
  - Details: fixtures `createLedgerAccount`, `createVatCode`, `setRate`, `uniqueAccountNumber`,
    `uniqueVatCode`, `unusedPastMonth` against accounting-api with an admin token; `refundFixtures`
    loses the catalog and rate helpers.
  - done when: `cd shell && pnpm exec tsc -p tsconfig.e2e.json --noEmit` and eslint on the three
    files are clean; `pnpm exec playwright test --list` runs (the live run is T51).

- [x] T41: e2e — `accounting.spec.ts` (manager journey, keyboard dialog, real-browser axe light/dark, en/it) and `accounting-access.spec.ts` (reader, CH-only manager, non-holder, admin switcher and WellD Italia empty/no-source) — refs: AC-1.1, AC-1.3, AC-1.9, AC-2.4, AC-3.1, AC-3.4, AC-3.5, AC-3.6, AC-8.1, AC-8.2, AC-8.4 — deps: T2, T13, T29, T30, T31, T32, T40
  - touch: `shell/e2e/accounting.spec.ts`, `shell/e2e/accounting-access.spec.ts`
  - agent: qe · e2e
  - Details: plan § e2e and design § Accessibility layer 2 (`axeViolations(page, 'main')`). Grants
    go through the admin API like any capability (AC-3.1).
  - done when: static checks as T40, and `playwright test --list` lists both specs (the live run is
    T51).

- [x] T42: e2e — adapt `refund-accounting-settings.spec.ts` (T31 of 20261118) and `refund-accounting.spec.ts` (T32 of 20261118): defaults among Accounting entries, no Accounts/VAT or Rates view, the link note, a deactivated default; correct the March rate in Accounting and export `10.40;0.9246;9.62`; a rate-pending line copied at export — refs: AC-4.4, AC-4.5, AC-4.6, AC-5.5, AC-5.6, AC-7.2, AC-7.3 — deps: T19, T20, T21, T35, T36, T37, T40
  - touch: `shell/e2e/refund-accounting-settings.spec.ts`, `shell/e2e/refund-accounting.spec.ts`
  - agent: qe · e2e
  - done when: static checks as T40; `playwright test --list` lists both; no reference to refund-api's
    removed routes remains in `shell/e2e` (`grep -r "exchange-rates\|ledger-accounts" shell/e2e`
    shows only accounting-api URLs).

- [x] T43: infra docs (document only, never deploy): `infra/README.md` accounting-api section and release runbook, `infra/check.sh`, `.railway/railway.ts` block without `source`, env-doctor manifest and templates — refs: none (release plumbing) — deps: T13, T23
  - touch: `infra/README.md`, `infra/check.sh`, `.railway/railway.ts`, `tools/env-doctor/manifest.ts`, `tools/env-doctor/templates/production/accounting-api.env`, `tools/env-doctor/templates/production/refund-api.env`, `tools/env-doctor/*.test.ts`
  - agent: orchestrator · release
  - Details:
    - Plan § Deploy order steps 0–8 verbatim as the runbook.
    - The variable table for accounting-api; refund-api gains `ACCOUNTING_INTERNAL_URL` and retires
      `REFUND_FX_SOURCE` (env-doctor flags it as retired); auth's `SERVICE_CLIENTS` edit comes after
      the new auth is live.
    - The outbound BAZG host moves to accounting-api.
    - `check.sh` gains accounting-api `/health`, a 401 on `/v1/me` and a 401 on `/system/v1/…`.
    - No `railway`, `vercel` or `provision-tool.sh --apply` command is run.
  - done when: `mise run env:doctor` and the env-doctor tests are green; `bash -n infra/check.sh`
    passes; `railway.ts` type-checks at the root (`pnpm exec tsc --noEmit -p .railway` or the repo's
    check); every path and command named in the new text exists (checked in review).

- [x] T44: docs: AGENTS.md (tool table, structure, backends, ports, the Accounting domain terms and the Refund terms "kept in Accounting", "Manage includes Read", Running locally and e2e setup) and README.md rows — refs: none (docs) — deps: T13, T23, T32, T38, T39, T40
  - touch: `AGENTS.md`, `README.md`, `accounting-api/README.md`, `accounting-ui/README.md`
  - agent: orchestrator · release
  - done when: every path, port, script and command named in the new text exists (checked by a
    reviewer, with the list in the commit message); `mise run env:doctor` is still green.

- [x] T45: changesets: `accounting-module.md` (accounting-api and accounting-ui minor as new packages; auth, shell, refund-api and refund-ui minor), and edit the pending `refund-accounting-export.md` so it no longer announces the moved Settings tabs — refs: none (release plumbing) — deps: T15, T24, T25, T32, T38
  - touch: `.changeset/accounting-module.md`, `.changeset/refund-accounting-export.md`
  - agent: orchestrator · release
  - done when: `mise run changeset:check` is OK against local `main` and `origin/main`.

## CLOSE — QE, security, eval, closing

- [ ] T46: QE pass over all 68 ACs — refs: all ACs (nominal) — deps: T3, T15, T24, T25, T38, T41, T42, T43, T44, T45
  - touch: `specs/20261119-accounting/qe-report.md`
  - agent: qe · release
  - Details: on :5445 only. Verify the moves kept history (`git log --follow` on one file per move
    task). Run the manual browser a11y pass only if a stack is available; otherwise list it under the
    owner step T51. Re-check A-1 and A-2 of 20261118 on the changed screens (G14).
  - done when: `qe-report.md` has verdict PASS; every AC has a named, executed test. Green:
    - accounting-api, refund-api and auth `bun test` + `typecheck`;
    - accounting-ui and refund-ui `pnpm test`, `lint` and `build`;
    - shell `pnpm test`, `lint` and `build`;
    - `mise run ui:check`, `shared:check`, `changeset:check` and `env:doctor`;
    - both migration checks on fresh databases.

    The live e2e is PENDING (T51), not a failure.

- [ ] T47: OWASP review (plan § Security, standard tier), in parallel with QE — refs: all ACs (nominal) — deps: T3, T15, T24, T25, T38, T41, T42, T43, T44, T45
  - touch: `specs/20261119-accounting/security-review.md`
  - agent: owasp-reviewer · release
  - Details: the ten surfaces of plan § Security. Escalate to frontier only on the plan's trigger.
  - done when: `security-review.md` lists no open high or critical finding; any fix is a new task
    appended here, with an overlap check.

- [ ] T48: Eval — refs: all ACs (nominal) — deps: T46, T47
  - touch: `specs/20261119-accounting/eval-report.md`
  - agent: orchestrator · release
  - done when: `/wellforge:eval` produces a passing `eval-report.md`.

- [ ] T49: All gates green; QE, security review and eval pass; the live e2e reported green; spec status → done — refs: all ACs (nominal) — deps: T48, T51
  - touch: `specs/20261119-accounting/spec.md`, `specs/20261119-accounting/tasks.md`
  - agent: orchestrator · release
  - done when: `/wellforge:done 20261119-accounting` accepts: tasks T1–T48 checked, QE PASS, no open
    high, a fresh passing eval, the changesets present, and T51 recorded green.

## OWNER

- [ ] T50: [OWNER] Accounting signs off the release inputs and answers the open questions — refs: none (release prerequisite) — deps: none
  - touch: `accounting-api/scripts/data/seed.welld-ch.json`, `refund-api/scripts/data/accounting-defaults.welld-ch.json`, `specs/20261119-accounting/spec.md`
  - agent: owner (accounting, product)
  - Details:
    - The WellD CH accounts and VAT codes, and who enters them (seed or by hand; SA-1).
    - The 12 type defaults and the foreign-currency VAT code (20261118 Q4 and Q6).
    - The limits.
    - Re-rating after approval (fallback: no).
    - Confirm SA-1 to SA-3.
    - The still-open 20261118 questions (source, offsets, CSV dialect, the post-approval capability).
    - `touch:` applies only if an answer changes a seed or the spec text.
  - done when: each open question of spec.md has its answer recorded; `seed:welld-ch --dry-run` and
    `accounting:release --dry-run` against a copy of production show reports accounting accepts.

- [ ] T51: [OWNER] Live e2e and the manual browser accessibility pass — refs: AC-8.4, AC-5.5, AC-5.6 (live evidence) — deps: T41, T42
  - touch: `specs/20261119-accounting/qe-report.md`, `specs/20261119-accounting/design.md`
  - agent: owner
  - Details: on the e2e stack (shared dev Postgres, 1Password secrets), with `mise run dev` and
    `ACCOUNTING_FX_SOURCE=off`.
  - done when: `cd shell && pnpm e2e accounting refund-` passes, together with every existing
    `refund-*.spec.ts`; the browser pass is recorded in design.md's "Browser accessibility pass"
    section; the result is noted in qe-report.md.

- [ ] T52: [OWNER] Release, by the runbook of `infra/README.md` (provision, variables, release, `SERVICE_CLIENTS` edit, verify, seed Accounting, release Refund) — refs: none (release) — deps: T49, T50
  - touch: `CHANGELOG.md`, `*/CHANGELOG.md`, `*/package.json`, `shell/src/lib/suiteVersion.generated.json`, `.changeset/*`, `.railway/railway.ts`
  - agent: owner
  - done when:
    - RELEASING.md "Before" checks pass;
    - `operai@<X.Y.Z>` is tagged;
    - `./infra/check.sh` passes with the accounting-api checks;
    - an accounting user sees Accounting in the menu;
    - both script reports are filed;
    - the first production approval of a WellD CH request succeeds.

## Coverage

Implementing and verifying tasks per AC. Nominal references (T46–T49) and tasks that serve no AC (T4,
T38, T39, T43–T45, T50, T52) are left out.

| AC | Tasks |
| --- | --- |
| AC-1.1 | T8, T14, T29, T41 |
| AC-1.2 | T8, T29 |
| AC-1.3 | T8, T29, T41 |
| AC-1.4 | T8, T13, T19, T29 |
| AC-1.5 | T9, T30 |
| AC-1.6 | T9, T30 |
| AC-1.7 | T5, T9, T30 |
| AC-1.8 | T9, T13, T19, T30 |
| AC-1.9 | T8, T13, T29, T41 |
| AC-1.10 | T9, T13, T30 |
| AC-1.11 | T8, T9, T29 |
| AC-1.12 | T5, T8, T9, T29 |
| AC-1.13 | T5, T8, T9, T14 |
| AC-2.1 | T10, T11 |
| AC-2.2 | T5, T11 |
| AC-2.3 | T10, T12, T31 |
| AC-2.4 | T5, T11, T12, T31, T41 |
| AC-2.5 | T5, T12, T31 |
| AC-2.6 | T11 |
| AC-2.7 | T10, T12, T31 |
| AC-2.8 | T11, T12, T31 |
| AC-2.9 | T12, T31 |
| AC-2.10 | T11, T13, T15 |
| AC-2.11 | T11, T12, T31 |
| AC-3.1 | T1, T41 |
| AC-3.2 | T2, T6 |
| AC-3.3 | T1 |
| AC-3.4 | T8, T9, T12, T41 |
| AC-3.5 | T6, T8, T12, T28, T41 |
| AC-3.6 | T6, T15, T28, T32, T41 |
| AC-3.7 | T18, T23 |
| AC-3.8 | T3, T7, T13, T15 |
| AC-3.9 | T17, T19, T32 |
| AC-4.1 | T13, T19, T36 |
| AC-4.2 | T19, T36 |
| AC-4.3 | T19, T36 |
| AC-4.4 | T18, T35, T42 |
| AC-4.5 | T18, T35, T42 |
| AC-4.6 | T23, T34, T38, T42 |
| AC-4.7 | T16, T18, T35 |
| AC-4.8 | T17, T25 |
| AC-4.9 | T19, T20, T36 |
| AC-5.1 | T20 |
| AC-5.2 | T19, T36 |
| AC-5.3 | T16, T21, T24 |
| AC-5.4 | T21 |
| AC-5.5 | T21, T42, T51 |
| AC-5.6 | T16, T20, T21, T36, T37, T42, T51 |
| AC-5.7 | T16, T19, T24 |
| AC-6.1 | T20, T36 |
| AC-6.2 | T20 |
| AC-6.3 | T18, T20 |
| AC-6.4 | T20 |
| AC-6.5 | T19, T36 |
| AC-6.6 | T21, T37 |
| AC-6.7 | T21, T37 |
| AC-6.8 | T7, T15, T17, T25 |
| AC-6.9 | T18, T35 |
| AC-6.10 | T18, T19, T25, T33, T35, T36 |
| AC-7.1 | T16, T20, T25 |
| AC-7.2 | T21, T25, T42 |
| AC-7.3 | T19, T21, T31, T36, T37, T42 |
| AC-7.4 | T22 |
| AC-7.5 | T14, T22, T40 |
| AC-8.1 | T2, T32, T41 |
| AC-8.2 | T6, T28, T41 |
| AC-8.3 | T8, T9, T29, T30 |
| AC-8.4 | T26, T27, T28, T29, T30, T31, T41, T51 |

**Every one of the 68 ACs has at least one implementing task and at least one task whose done-when
runs its test.** Checked by script against `spec.md`.

## Overlap check

Effective graph = `deps:` ∪ `touch:` overlap. Globs (`*` does not cross `/`) were expanded against
each other and against the tracked files. "A → B" means A comes before B. Every overlap found, and
what was done:

**Shared registries, ordered by explicit deps:**

- `accounting-api/src/index.ts`: T4 → T6 → T8 → T12 → T13. T12 depends on T8 and T13 on T12 for this
  file as well as for code.
- `scripts/check-shared-copies.ts`: T4 → T7.
- `lerna.json`: T4 and T26 both add a package. **Not ordered by a dep: they touch different lines of
  a small JSON list.** The second to merge rebases and keeps both entries. This is the only accepted
  concurrent touch; it is declared here so a reviewer expects it.
- `refund-api/src/lib/env.ts`, `env.test.ts`, `refund-api/.env.example`: T17 → T23 (through T18–T22).
- `refund-api/src/index.ts`: T23 only.
- `refund-api/prisma/schema.prisma`, `refund-api/prisma/migrations/*`,
  `refund-api/src/lib/migration.accounting-move.test.ts`, `refund-api/src/test-support/dbCleanup.ts`:
  T16 → T24 (the declared migration chain).
- `accounting-ui/src/strings.ts`: T26 → T27. `refund-ui/src/strings.ts`: T33 → T38.
- `shell/src/lib/tools.ts`, `shell/src/router.tsx`, `shell/src/strings.ts`: T32 only. The e2e tasks
  touch `shell/e2e/` and `shell/playwright.config.ts` only (T40).
- auth `seed.ts`, the catalogs index, `uniqueResourceKeys.test.ts`: T1 only. `authz.routes.ts`: T2
  only. `serviceClients.ts`: T3 only.

**Moves (source and destination listed in one task each):**

- `refund-api/src/accounting/catalog.*` → `accounting-api/src/catalog/` in T8, which depends on T23
  (no importer left); T9 then edits the destination only.
- `refund-api/src/fx/{bazgSource,parse,months}*` and `fixtures/*` → T10. `fx.repo`, `fx.service` and
  `fx.service.test` → T11. `fx.routes`, `fx.routes.test` and `fx.schemas` → T12. T10 → T11 → T12, and
  all three come after T23.
- `refund-api/scripts/data/accounting-seed.welld-ch.json` → T14, after T22 (which stops reading it).
  T22's `accounting-defaults.welld-ch.json` is a different file.
- `refund-ui/src/components/settings/{LedgerAccountsCard,AddLedgerAccountDialog,useCatalogToggle}*` →
  T29. `{VatCodesCard,AddVatCodeDialog}*` → T30. `{ExchangeRatesCard,RateCorrectionDialog}*` and
  `lib/exchangeRatesApi*` → T31. Each comes after T34 (the last importer removed). T31 also comes
  after T37 (the `accountingExportApi` import removed).
- `refund-ui/src/pages/settings/AccountingSettingsView*` → `DefaultsSettingsView*` (a rename inside
  refund-ui) and the deletion of `ExchangeRatesView.tsx`: T34 only.

**Same package, distinct files (not an overlap):**

- refund-api `classification.repo.ts`: T18 (moves `classifiableInput` out) → T19. T20 and T21 import
  `classification.ts`, not the repo.
- refund-api `src/authz/accountingViewer.ts`: created by T19, **imported** by T21, which does not
  touch it. T21 runs in parallel with T19 against the function's declared signature
  (`canOpenAccountingRates(permissions, user): boolean`, plan § API). At merge T21 rebases on T19. If
  T19 is not yet merged, T21 adds a local stub of that one function in its own test file and may not
  create `accountingViewer.ts`.
- refund-api `numbering.repo.ts`: T20 only. T22 imports `classifyAndNumber` (dep T20 → T22).
- refund-api `src/requests/audit.ts`: T18 only; T19–T22 import it.
- refund-api `src/lib/db.accounting-*.test.ts`: T16 names `receipt-guard` and `copies` explicitly; T24
  names `immutability` explicitly; there is no glob, so no clash.
- accounting-api `src/catalog/*` (T8 → T9), `src/rates/*` (T10, T11 and T12 name distinct file
  patterns), `src/system/*` (T7 names `accountingWire*`; T13 names its own files).
- accounting-ui `src/lib/catalogApi*`: T29 → T30. `src/pages/*Page.tsx`: created by T28, each then
  edited by exactly one of T29, T30 and T31 (dep T28).
- accounting-ui `src/lib/*` (T26's glob) vs T29–T31's `src/lib/...` files: T26 → T27 → T28 → T29/T31,
  ordered.
- refund-ui `lib/accountingApi.ts`: T35 → T36 (T36 does not touch it but depends on its shapes) → T38.
- refund-ui `components/CatalogSelect*`: T35 only.

**Cross-track file touches (declared):**

- T7 writes `refund-api/src/accounting/accountingWire.ts` (ACC owns the contract); T17 imports it.
- T8, T10, T11, T12 and T14 delete refund-api files through `git mv`. T29, T30 and T31 delete
  refund-ui files the same way. Each depends on the task that made those files dead.
- T15 and T19 read `auth/src/authz/entity-coverage-vectors.json` (owned by T2), read-only. T15 reads a
  refund-api constant, read-only.

No other overlap was found.

## Parallel batches (effective graph)

Computed on deps ∪ `touch:` overlap, earliest start, ties broken by task number. Within a batch, no two
tasks share an edge or a path, except the declared `lerna.json` line-level touch of T4 and T26.

| Batch | AUTH | ACC | REF | UI | RUI | OPS / CLOSE / OWNER | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | T1, T3 | T4 | T16 | T26, T32 | T33 | T50 [OWNER] | No prerequisites. T50 gates only T52. |
| B2 | T2 | T5, T7 | | T27 | T34, T37 | T39 | |
| B3 | | T6 | T17 | T28 | T35 | | |
| B4 | | | T18 | T29, T31 | T36 | | T29 and T31 wait for T34; T31 also for T37. |
| B5 | | | T19, T20, T21 | T30 | | | Three REF tasks in parallel (distinct files). |
| B6 | | | T22 | | T38 | | |
| B7 | | | T23 | | | | The cut: the old code is dead from here. |
| B8 | | T8, T10 | T25 | | | | The moves start. |
| B9 | | T9, T11 | | | | | |
| B10 | | T12, T14 | | | | | |
| B11 | | T13 | T24 | | | T40 | T24 waits for the last move (T12). |
| B12 | | T15 | | | | T41, T42, T43, T44 | |
| B13 | | | | | | T45, T51 [OWNER] | The live e2e can start once T41 and T42 are written. |
| B14 | | | | | | T46, T47 | Security runs in parallel with QE. |
| B15 | | | | | | T48 | |
| B16 | | | | | | T49 | |
| B17 | | | | | | T52 [OWNER] | |

**Critical path:** T4 → T7 → T17 → T18 → T20 → T22 → T23 → T10 → T11 → T12 → T13 → T15 → T45 → T46
→ T48 → T49 → T52.

- The REF switch-over (T17–T23) gates the backend moves. The UI and RUI tracks finish by B6 and have
  slack for review rework.
- The ACC pre-move work (T4–T7) runs alongside REF.
- To shorten the path, T8–T12 can start as soon as T23 merges. The moved code is already tested, so
  the risk is in the adaptation, not in the move.

## Fix round 1 (2026-11-19) — QE FAIL (qe-report.md D-1..D-6) and security review (security-review.md F-01..F-07, F-12)

- [x] T53: accounting-api — D-1 path keys `{number}`/`{code}` validated (NUL and control chars → 404, no 500; flips catalog.keys.test.ts green); D-6 a name/label made only of blanks incl. zero-width/bidi characters is `empty`, length counted in code points; F-01 a per-entity cap on ledger accounts and VAT codes (value chosen so the largest allowed reference-data answer stays well under refund-api's 256 KiB consumer cap, asserted by a cross-package test like budgets.cross-package.test.ts) with a clear 409/422 when reached; F-07 `Cache-Control: no-store` + `nosniff` on user routes — refs: AC-1.2, AC-1.5, AC-6.1, AC-6.8 — deps: T46, T47
  - touch: `accounting-api/src/catalog/*`, `accounting-api/src/index.ts`, `accounting-api/src/lib/*`, `accounting-api/src/*.test.ts`, `accounting-api/src/system/*`
  - done when: catalog.keys.test.ts green; cap and payload-size test green; accounting-api suite + tsc green.
- [ ] T54: refund-api — D-5 one scratch DB name per describe in migration.accounting-move.test.ts (green under `--randomize` with two seeds); F-02 lines dated before Accounting's month floor never make the whole rates read fail (ask only in-range pairs; out-of-range pairs are missing with a reason; the release does not exit 2 for them); F-03 the release script's generic catch prints only the error kind/masked text; F-07 `no-store` + `nosniff` on classification, options and defaults routes — refs: AC-6.1, AC-6.7, AC-6.10, AC-7.4 — deps: T46, T47
  - touch: `refund-api/src/lib/migration.accounting-move.test.ts`, `refund-api/src/accounting/*`, `refund-api/src/review/*`, `refund-api/scripts/accounting-release*.ts`
  - done when: refund-api suite green in default order and with `--randomize` seeds 424242 and 77; new tests for F-02/F-03/F-07 green; tsc green.
- [ ] T55: docs/CI — D-2 correct the three "seed not in the Docker image" statements (`.changeset/accounting-module.md`, AGENTS.md, accounting-api/README.md); D-3 `.dockerignore` `**/*.test.ts` (or correct the comments) for accounting-api; D-4 `shared-copies.yml` path filter lists both `accountingWire` copies; F-12 the runbook's rollback names only existing migrations — refs: none (docs/CI) — deps: T46, T47
  - touch: `.changeset/accounting-module.md`, `AGENTS.md`, `accounting-api/README.md`, `accounting-api/.dockerignore`, `accounting-api/Dockerfile`, `.github/workflows/shared-copies.yml`, `infra/README.md`
  - done when: grep finds no false statement; `shared-copies.yml` filter test (if any) green; `docker build` of accounting-api excludes test files (or comment corrected).

- [x] T56: accounting-ui — mirror T53's server rules in `lib/limits.ts` (a name/label of only blanks or invisible characters is empty; length in code points) and handle 409 `catalog_full` (with `limit`) in the add dialogs with its own message (en + it), axe-checked — refs: AC-1.2, AC-1.5 — deps: T53
  - touch: `accounting-ui/src/lib/*`, `accounting-ui/src/components/*`, `accounting-ui/src/strings.ts`, `accounting-ui/src/**/*.test.tsx`
  - done when: tests for both rules and the 409 green; accounting-ui tsc -b, lint, tests, build green.

## Implementation notes (reconciled 2026-11-19)

Each track ran in its own worktree and was integrated by rebase + fast-forward; checkboxes are
reconciled here centrally. No merge collisions; `lerna.json` (T4/T26) and
`.github/workflows/changeset-check.yml` (T4 added accounting-api, the orchestrator added
accounting-ui at integration) were the accepted shared edits.

Files touched outside a task's `touch:` list, as reported by the dev agents:

- T4: `.github/workflows/changeset-check.yml`, `scripts/check-shared-copies.test.ts`.
- T16: `scripts/accounting-release.test.ts`, `src/accounting/numbering.repo.test.ts`,
  `src/accounting/classification.race.test.ts` (refund-api; the DB lock is now asserted on the copy
  columns).
- T19/T20: `refund-api/src/accounting/legacyFk.ts` (interim, deleted in T23),
  `export.routes.test.ts`, `scripts/accounting-release.test.ts`, `lifecycle.routes.test.ts`.
- T23: `refund-api/src/fx/fx.service.ts`, `fx.routes.ts` (singletons removed so tsc passes without
  REFUND_FX_SOURCE).
- T26: `accounting-ui/src/federation/__stubs__/*`; T32: `shell/src/index.css` (@source),
  `shell/src/italian.test.tsx`, `shell/src/lib/noHardcodedStrings.test.ts`,
  `shell/public/runtime-config.example.json`.
- T29–T31: page tests and `lib/formatVatRate.test.ts` in accounting-ui; T28's `router.test.tsx`,
  `App.test.tsx`. T31's move needed `refund-ui/src/pages/settings/ExchangeRatesView.tsx` removed
  (dead file left by T34); the permission system refused the deletion to the dev agents, and the
  owner approved the orchestrator doing it (commit 144e28b2).
- T34–T37: `refund-ui/src/router.tsx`, `lib/catalogLabels.ts`, `lib/statusMeaning.ts`;
  T38: `DefaultsSettingsView.test.tsx`, `SettingsViews.test.tsx`, `lib/statusMeaning.ts`.
- T8–T11: `accounting-api/src/health/health.test.ts` and `test-support/testAuth.ts` (harness fix:
  mocks installed on import); `refund-api/src/fx/fx.routes*.ts` and `fx.schemas.ts` deleted rather
  than moved (T12 rebuilt the rates routes from them), `refund-api/src/lib/db.fx-fetched-once.test.ts`
  rewritten (deleted in T24). T10 and T11 share one move commit.
- T12: `accounting-api/src/catalog/catalog.routes.test.ts`; T14: `accounting-api/Dockerfile`
  (`COPY scripts`).
- T24: five refund-api test files whose fixtures used the dropped columns.
- T40–T42: `shell/e2e/helpers/accountingFixtures.ts` grew helpers for T41/T42; accounting-ui's e2e
  preview port is 5185 (5183 is projects-ui's e2e port).

The migration chain declared by the architect (T16 adds and carries, T24 drops) replaces the
plan's single migration; T16 and T24 are `20261119120000_accounting_copies` and
`20261119130000_accounting_reference_moved_out`.
