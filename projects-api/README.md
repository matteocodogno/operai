# projects-api

The Projects module's resource server (specs/021-projects): the delivery work wellD runs,
its team and its contracts, and the Bexio order id. Bun + Hono + Prisma, port **8085**,
logical database **`projects`**. Live API reference at `http://localhost:8085/docs`.

It is authorization-enforcing (ADR-0014): every route except `/health` needs a valid JWT
and the `projects:access` permission, resolved live from auth. If auth cannot answer, the
route answers 503 `authz_unavailable`, never "allow". Writes are further scoped by
`project:manage` (entity) and `contract:bexio` (see `GET /scope`).

CRM company names are read from crm-api with a service credential (`crm.companies.read`,
ADR-0059): projects-api trades its service client for a 5-minute JWT at auth and calls
`GET /system/companies`.

## Environment

The environment is validated at startup by `src/lib/env.ts`. The resource-server set is
required. The crm-api group is optional and all-or-nothing: without it the service starts,
a company name is `null` and the company picker answers 503 `crm_unavailable`.

| Variable | Local value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://<user>:<password>@localhost:5435/projects` | the compose Postgres; same credentials as the other backends |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | the shell; projects-ui is a federated remote |
| `AUTH_JWKS_URL` | `http://localhost:3001/auth/jwks` | |
| `AUTH_ISSUER` | `http://localhost:3001` | must equal auth's `BETTER_AUTH_URL` |
| `AUTH_AUDIENCE` | auth's `AUTH_AUDIENCE` (`operai-suite` locally) | |
| `AUTH_BASE_URL` | `http://localhost:3001` | `/authz/resolve`, `/authz/users/identities`, `/authz/app-access-check`, `/system/service-token` |
| `PORT` | `8085` (default) | |
| `CRM_INTERNAL_URL` | `http://localhost:8084` | optional group, all three or none: crm-api's base URL |
| `SERVICE_CLIENT_ID` | `projects-api` | its entry in auth's `SERVICE_CLIENTS` needs scope `crm.companies.read` |
| `SERVICE_CLIENT_SECRET` | the secret of that entry, at least 32 characters | secret |

crm-api also needs `SERVICE_AUDIENCE` (auth's value) to accept the credential.

## Commands

```bash
bun install
bun run db:deploy      # applies the migrations to the database DATABASE_URL names
bun run dev            # http://localhost:8085
bun run typecheck
bun test               # runs against the `<name>_test` database; see below
```

Tests run the assembled app against a real Postgres with the JWT, `/authz/resolve`, auth's
identity endpoints and crm-api faked (`src/test-support/`). They empty the tables between
tests, so the `bun test` preload (`src/test-support/env.ts`) always points them at the
`<name>_test` database of the server `DATABASE_URL` names (default `projects_test` on the
compose Postgres): `projects` is never touched. Create and migrate it once:

```bash
createdb -h localhost -p 5435 -U postgres projects_test
DATABASE_URL=postgresql://postgres:postgres@localhost:5435/projects_test bun run db:deploy
```

## Layout

- `src/index.ts` mounts every area router once: `projects`, `transitions`, `team`,
  `contracts`, `bexio`, `companies`. Tasks fill the routers in; none edits `index.ts`.
- `src/auth/guards.ts`: the `authorized` stack and `assertCanManage(c, entity)`
  (403 `forbidden` without `project:manage`, 403 `out_of_scope` for the other entity).
- `src/lib/serviceToken.ts`: a shared copy (`scripts/check-shared-copies.ts`), edit every
  copy together.
