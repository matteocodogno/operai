# accounting-api

The Accounting module's resource server (specs/20261119-accounting): the accounting reference data of
each legal entity — **ledger accounts**, **VAT codes** and **monthly average exchange rates**. Bun + Hono +
Prisma, port **8089**, logical database **`accounting`**. Live API reference at `http://localhost:8089/docs`.

Other modules read this data instead of keeping their own copy (ADR 20261119-accounting-reference-data-belongs-to-accounting-api-…);
Refund is the first consumer and keeps, on each line, a copy of what it booked.

## Authorization

Every route except `/health` needs a valid JWT. Access is `accounting:read` or `accounting:manage` (two
capabilities, each grantable with the `entity` condition; **manage includes read**), resolved live from
`auth GET /authz/resolve` and failing closed (503) when auth cannot answer. There is no `accounting:access`:
the shell shows the tool to a person whose grant covers at least one entity.

- `GET /v1/me` — the entities the caller covers, each with its own currency, `canManage` and `rateSource`.
- `GET|POST /v1/entities/{entity}/ledger-accounts` and `.../{number}/deactivate|reactivate`.
- `GET|POST /v1/entities/{entity}/vat-codes` and `.../{code}/deactivate|reactivate`.
- `GET /v1/entities/{entity}/exchange-rates`, `POST .../exchange-rates/fetch`,
  `PUT .../exchange-rates/{month}/{currency}` (a correction).
- An entry is identified by its number or code **within its entity**; there is no edit and no delete. An
  entity the caller does not cover is a 404; a write without manage is 403.
- **Catalog cap per entity** (`CATALOG_CAPS`, `src/catalog/limits.ts`): at most **200 ledger accounts** and
  **50 VAT codes** per entity, **deactivated ones included**. Entries cannot be deleted, so this is a
  **lifetime** limit for the entity. An addition beyond it answers 409 `catalog_full` with `limit` and writes
  nothing. The cap keeps the largest reference-data answer well under refund-api's 256 KiB read limit
  (asserted by `src/catalog.cap.cross-package.test.ts`). The operator seed (`seed:welld-ch`) does not check
  the cap; its file is far below it.

## Service read for consumers

`GET /system/v1/entities/{entity}/reference-data` and `GET /system/v1/entities/{entity}/rates` take **only** a
scoped service JWT minted by `auth` (`POST /system/service-token`): `aud=SERVICE_AUDIENCE`, scope
`accounting.reference.read`, and a `sub` on the allowlist (`system:refund-api`). A user token, a missing
scope or any other failure answers the same 401. `Cache-Control: no-store`. A consumer's `SERVICE_CLIENTS`
entry in auth must hold the scope `accounting.reference.read`.

## Environment

All variables are validated at startup (`src/lib/env.ts`); a missing one exits 1 naming it. See
`.env.example` for the template. Required: `DATABASE_URL`, `ALLOWED_ORIGINS` (the shell's origin, never `*`),
`AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_BASE_URL`, `SERVICE_AUDIENCE` (must differ from
`AUTH_AUDIENCE`). Optional: `PORT` (8089), `NODE_ENV`, and **`ACCOUNTING_FX_SOURCE`**:

- `bazg` (default): a missing rate of a completed month is fetched on demand from the one fixed federal host
  (the BAZG's rates backend, which serves the monthly average rates for VAT of the Federal Tax Administration,
  AFC/ESTV, the authority for them; the host is a constant in the source, not configuration), on a budget inside refund-api's 10 s deadline.
- `off`: no outbound call; every attempt is recorded as `disabled` and rates are typed by hand. Use it for the
  e2e and offline development.

## Commands

```bash
bun install
bun run db:deploy        # apply migrations (db:migrate for a dev migration); the database `accounting` is made by
                         # `docker compose run --rm accounting-createdb` (or `mise run db:migrate`)
bun run dev              # http://localhost:8089 (hot reload); `direnv allow accounting-api` first
bun run typecheck        # tsc --noEmit
bun test
```

### AFC/ESTV verification (opt-in, never in CI)

The rates' authority is the AFC/ESTV; the endpoint read is the "XML-File" link of its monthly average page, served
by the BAZG. To check that the channel still answers the signed-off value (2026-03: EUR 0.9246), on a networked
machine:

```bash
ACCOUNTING_LIVE_RATES=1 bun test src/rates/afc.live.test.ts
```

Without the flag the test is skipped, so `bun test` and CI never call out. QE runs it once per release.

## Seed (operator-run, optional)

```bash
bun run seed:welld-ch --dry-run   # report what would be added, change nothing
bun run seed:welld-ch             # load WellD CH's accounts and VAT codes from scripts/data/seed.welld-ch.json
```

The file holds the list signed off by accounting on 2026-11-19: **19 ledger accounts** (2620.1, 5808,
5901 to 5907, 5909, 5999, 6101, 6102, 6104, 6405, 6501, 6701, 6720 and 7122 "Spese da riaddebitare a
WellD Italia") and **6 VAT codes** (`IPM81` 8.1, `IPM77` 7.7, `IP00` 0, `BZM81` 8.1 reverse charge,
`IPM26` 2.6, `IPM38` 3.8). There is no `IMP81`, `IMP77` or `NOVAT`. The VAT code labels are the
operator's, written from the rates until accounting confirms them.

Adds the entries that do not exist yet, in one transaction, as `system:accounting-seed`; never changes or
deactivates an existing entry; idempotent. It is not a feature for users, and it is optional when accounting
prefers to type the list in the app. It is in the Docker image (the Dockerfile copies `scripts/` and the data it
reads, not the tests), so it runs inside the service (`railway ssh`, user `bun`, `/app`) with the service's own
environment, or from a checkout with this service's environment (`infra/README.md` § Accounting release runbook, step 6). The e2e global setup runs it
(`shell/e2e/global-setup.ts`, `E2E_SKIP_ACCOUNTING_SEED=1` skips it).
