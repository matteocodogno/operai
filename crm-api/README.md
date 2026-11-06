# crm-api

The CRM's resource server (specs/017-crm, ADR-0052): companies, contacts, deals, the pipeline,
activities and tasks. Bun + Hono + Prisma, port **8084**, logical database **`crm`**. Live API
reference at `http://localhost:8084/docs`.

## Environment

The environment is validated at startup by `src/lib/env.ts`. The resource-server set is
required. specs/018 adds two optional groups: without them, crm-api starts and only the
estimate routes, or the offer and attachment routes, answer 503 (`estimai_unconfigured`,
`storage_unconfigured`). specs/019 adds a third, the notify group: without it nothing is
sent and nothing fails. specs/022 adds a service-to-service read of projects-api for the deal
page (ADR-0060): without `PROJECTS_INTERNAL_URL` the deal loads with `deliveryKnown: false`. The
deal page reads projects-api's `GET /system/purchase-orders` (the purchase order's project and Bexio
order id; the shape of the deal's `delivery` is unchanged).

| Variable | Local value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://<user>:<password>@localhost:5435/crm` | the compose Postgres; same credentials as the other backends |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | the shell; crm-ui is a federated remote |
| `AUTH_JWKS_URL` | `http://localhost:3001/auth/jwks` | |
| `AUTH_ISSUER` | `http://localhost:3001` | must equal auth's `BETTER_AUTH_URL` |
| `AUTH_AUDIENCE` | auth's `AUTH_AUDIENCE` (`operai-suite` locally) | |
| `AUTH_BASE_URL` | `http://localhost:3001` | `/authz/resolve`, `/authz/users/identities` |
| `PORT` | `8084` (default) | |
| `ESTIMAI_API_URL` | `http://localhost:8080` | optional; estimate requests and offers (called with the caller's own JWT) |
| `CRM_S3_ENDPOINT` | `http://localhost:9000` | optional group, all five or none; the compose MinIO |
| `CRM_S3_REGION` | `us-east-1` | an opaque placeholder for a non-AWS endpoint |
| `CRM_S3_BUCKET` | `operai-crm-files-dev` | created by `minio-createbucket` in compose.yaml |
| `CRM_S3_ACCESS_KEY_ID` / `CRM_S3_SECRET_ACCESS_KEY` | the MinIO root user (`minioadmin` / `minioadmin` by default) | secrets in any shared environment |
| `CRM_S3_EU_ENDPOINT_HOSTS` | `localhost` | required for a non-AWS endpoint: the EU residency allowlist (ADR-0016) |
| `NOTIFY_INTERNAL_URL` | `http://localhost:8081` | optional (specs/019): without it the CRM sends no notifications |
| `PROJECTS_INTERNAL_URL` | `http://localhost:8085` | optional (specs/022): the deal page's Delivery card reads projects-api here; without it `deliveryKnown` is `false` |
| `SERVICE_CLIENT_ID` | `crm-api` | required with either URL above, refused alone; its entry in auth's `SERVICE_CLIENTS` needs scopes `notifications.push emails.send projects.purchase-orders.read` (renamed from the contracts scope of specs/022's first draft; auth refuses a client that still carries the old one) |
| `SERVICE_CLIENT_SECRET` | the secret of that entry, at least 32 characters | secret; required with `SERVICE_CLIENT_ID`, and with either URL |
| `SERVICE_AUDIENCE` | auth's `SERVICE_AUDIENCE` | optional; the `aud` accepted on `/system/*` (`GET /system/companies`, `GET /system/deals`, `GET /system/contacts`), different from `AUTH_AUDIENCE`. Unset: every `/system/*` request is a 401 |

## Service-to-service routes

`GET /system/companies` (scope `crm.companies.read`, read by projects-api, ADR-0059),
`GET /system/deals` (scope `crm.deals.read`, read by projects-api, ADR-0060) and
`GET /system/contacts` (scope `crm.contacts.read`, read by projects-api, ADR-0063) are not behind
`authorized`: they accept one credential, a scoped service JWT, and answer every failure with
the same `401`. `GET /system/deals` takes exactly one of `stage=won` (newest win first, at most
500, `truncated` beyond) or `ids=a,b` (any stage, at most 100) and returns each deal's title,
stage, entity, company, win date and estimate link: never an amount, currency, owner or notes.

`GET /system/contacts` serves a purchase order's **referent** (specs/022, D49, ADR-0063): it takes
exactly one of `companyId=<id>` or `ids=a,b` (each id 1–64 characters, at most 20) and has **one
shape per mode**, each built with an explicit `select` and pinned by a key-set contract test:
`companyId` returns that company's non-archived contacts `{ items: [{ id, firstName, lastName,
jobTitle }], truncated }` (by last then first name, at most 500; no email or phone), `ids` returns
those contacts, archived or not, as `{ items: [{ id, companyId, firstName, lastName, jobTitle,
email, phone, archived }] }` (an erased contact is absent). Neither or both parameters, a
malformed id or more than 20 ids is `400`. Never `notes`, `createdBy`, `updatedBy` or `version`.
The scope is granted to the `projects-api` service client only: it is personal data, read live by
projects-api and never stored there.

The deal page goes the other way: crm-api reads projects-api's `GET /system/purchase-orders?dealIds=`
(scope `projects.purchase-orders.read`) with its own service credential, as above.

`mise run dev` starts it with `direnv exec .` like every backend. The setup follows the other
backends:

- `.envrc` (committed) contains no secrets. It loads the root `.envrc` (`source_up`), builds
  `DATABASE_URL` from the root `POSTGRES_*` values, and then loads `.env`.
- `.env.example` (committed) holds the other variables, all of them not secret. Copy it to
  `.env`, which is gitignored.

Once, then `direnv allow crm-api`:

```bash
cp crm-api/.env.example crm-api/.env
```

The shell needs `VITE_CRM_API_URL=http://localhost:8084` in `shell/.env`. Without it,
`apiFetch` does not trust the crm-api origin and the CRM shows "Could not load".

## Commands

```bash
bun install
bun run db:migrate     # creates/updates the `crm` database (Prisma migrate dev)
bun run dev            # http://localhost:8084
bun run typecheck
bun test               # needs DATABASE_URL pointing at a disposable DB: tests TRUNCATE the tables
```

Tests run the assembled app against a real Postgres with the JWT and `/authz/resolve` mocked
(`src/test-support/`). Use a separate database, e.g. `crm_test`, migrated with
`bun run db:deploy`.
