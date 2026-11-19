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
  (the host is a constant in the source, not configuration), on a budget inside refund-api's 10 s deadline.
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

## Seed (operator-run, optional)

```bash
bun run seed:welld-ch --dry-run   # report what would be added, change nothing
bun run seed:welld-ch             # load WellD CH's accounts and VAT codes from scripts/data/seed.welld-ch.json
```

Adds the entries that do not exist yet, in one transaction, as `system:accounting-seed`; never changes or
deactivates an existing entry; idempotent. It is not a feature for users, and it is optional when accounting
prefers to type the list in the app. It is in the Docker image (the Dockerfile copies `scripts/` and the data it
reads, not the tests), so it runs inside the service (`railway ssh`, user `bun`, `/app`) with the service's own
environment, or from a checkout with this service's environment (`infra/README.md` § Accounting release runbook, step 6). The e2e global setup runs it
(`shell/e2e/global-setup.ts`, `E2E_SKIP_ACCOUNTING_SEED=1` skips it).
