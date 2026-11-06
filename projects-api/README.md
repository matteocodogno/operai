# projects-api

The Projects module's resource server (specs/021-projects): the delivery work wellD runs,
its team, its terms and, for a project made from a won deal, its purchase order with the Bexio
order id. Bun + Hono + Prisma, port **8085**,
logical database **`projects`**. Live API reference at `http://localhost:8085/docs`.

It is authorization-enforcing (ADR-0014): every route except `/health` needs a valid JWT
and the `projects:access` permission, resolved live from auth. If auth cannot answer, the
route answers 503 `authz_unavailable`, never "allow". Writes are further scoped by
`project:manage` (entity) and `purchase-order:bexio`; the queue and the take by `handoff:take`
(entity); being a purchase order's ops-manager by `purchase-order:receive` (entity; an unconditioned
grant is the admin override). `GET /scope` reports `{ manage, managesAll, bexio, take, oversees }`
so the UI hides exactly what the server refuses (ADR-0063).

## The model: terms and purchase order (specs/022, ADR-0062)

A project has **0..1 terms** (`project_terms`: dates and the type-specific delivery terms, in the
nested shape `{ startDate, endDate?, terms: { ... } }` of specs/021) and **0..1 purchase order** (PO,
`purchase_order`: the deal, its estimate id, the Bexio order id, the referent's CRM contact id and the
ops-manager). "Contract" is retired. A PO is born only from a won deal, in the same transaction as its
project and terms; a project made by hand never has one and may carry terms. A PO is never deleted.
A project made from a deal has **no project manager until its ops-manager picks one**
(`awaitingProjectManager`).

- `POST` / `PATCH` / `DELETE /projects/{id}/terms` (`project:manage` for the project's entity,
  `If-Match` on the writes): `409 terms_exist`, `404 terms_not_found`, `409 terms_not_allowed`
  (`internal`), `409 terms_required` when deleting the terms of a project that has a PO, `422
  estimated_man_days_from_estimate` for estimate-backed man-days (ADR-0061).
- `PUT /projects/{id}/purchase-order/bexio-order` (`purchase-order:bexio`, `accounting` and admins):
  the only route that writes the Bexio order id; `404 purchase_order_not_found` on a hand-made
  project.
- `PATCH /projects/{id}/purchase-order` `{ referentContactId }` and `GET
  /projects/{id}/purchase-order/contacts` (`project:manage` for the entity): the referent and its
  picker; `422 referent_invalid`, `503 crm_unavailable`, `404 purchase_order_not_found`. The
  referent's name, job title, email and phone are read **live** from crm-api on `GET /projects/{id}`
  (only when one is set), never stored or cached, and every answer that carries them is
  `Cache-Control: no-store` (`referent.status` is `"unavailable"` when the CRM cannot answer;
  `referent` is `null` when it no longer has the contact or it moved to another company; ADR-0063).
- `PATCH /projects/{id}` `projectManagerId` on an awaiting project: only the PO's ops-manager (read
  from the row, and still holding `purchase-order:receive` for the entity) or an admin who
  `oversees` may set it (`403 not_ops_manager`); afterwards any `project:manage` holder changes it
  as in specs/021, clearing it is `422 project_manager_required`; `planned` -> `active` while
  awaiting is `409 awaiting_project_manager`; `GET /projects?projectManagerId=none` lists the
  awaiting projects.
- `POST /projects` creates a hand-made project of any type (a company for every type but
  `internal`, `saas` included), with optional `terms`; the creator is its project manager; it has
  no PO.

Removed with the contract: `POST /queue/{dealId}/attach`, `PUT /projects/{id}/type`, every
`/projects/{id}/contracts*` route and `GET /system/contracts`.

CRM company names are read from crm-api with a service credential (`crm.companies.read`,
ADR-0059): projects-api trades its service client for a 5-minute JWT at auth and calls
`GET /system/companies`.

## The projects hand-off (specs/022, ADR-0060 / ADR-0061)

A won deal reaches the module through reads, never through a copy:

- `GET /queue` (`handoff:take` for any entity: sales and admins; a project manager, an ops-manager
  or accounting get `403`) lists the CRM's won deals that no purchase order has taken, read live from
  crm-api `GET /system/deals` (scope `crm.deals.read`); a reopened deal drops out and a re-won one is
  back. crm-api down is `503 crm_unavailable`. Only the newest 500 won deals are considered
  (`truncated`).
- `POST /queue/{dealId}/project` (`handoff:take` **and** `project:manage` for the **deal's** entity:
  `403 forbidden` without either capability anywhere, `403 out_of_scope` for the other entity) takes a
  deal: `{ name, type, terms, opsManagerId, referentContactId? }`. It re-reads the deal live (it must
  be `won` and have no purchase order) and writes the project (`planned`, **no project manager**), its
  terms and its PO in one transaction. The unique index on `purchase_order.dealId` decides a race
  between two takes (`409 deal_taken`). `projectManagerId` in the body is `400`.
- The take's form is fed by `GET /queue/{dealId}/ops-managers` (the holders of
  `purchase-order:receive` for the deal's entity, read **live from auth**
  `GET /authz/users/holders` with the caller's own JWT, admins last; `prefillId` only when exactly one
  non-admin exists) and `GET /queue/{dealId}/contacts` (the **deal's** company's non-archived CRM
  contacts, never a company id from the client, `no-store`). The take re-validates both: `422
  ops_manager_invalid`, `422 referent_invalid`; auth down is `503 identity_unavailable`, crm-api down
  `503 crm_unavailable`, and nothing is written.
- After the commit, **one notification** is pushed to the ops-manager through notify-api `POST
  /system/notifications` (scope `notifications.push`, `originApp: "projects"`, English only, a link
  to the project, no contact data). It is best effort: never awaited by the response and never
  failing it, a no-op when `NOTIFY_INTERNAL_URL` is unset.
- A `fixed_price` project made from a deal with an estimate copies the estimate's man-days once
  from estimai-api `GET /system/estimates/{id}/summary` (scope `estimai.estimates.read`). The client
  omits `terms.estimatedManDays`; sending it, even as `null`, is `422
  estimated_man_days_from_estimate`. An estimate EstimAI does not know leaves it `null`; EstimAI
  unreachable is `503 estimai_unavailable` and nothing is written.
- `GET /system/purchase-orders?dealIds=` (scope `projects.purchase-orders.read`, a service JWT only)
  is read by crm-api for the deal page: `{ items: [{ dealId, purchaseOrderId, project: { id, name },
  bexioOrderId }] }`, never terms, people, amounts or contact data. Like `/system/*` in crm-api it
  answers every credential failure with the same `401`.

## Environment

The environment is validated at startup by `src/lib/env.ts`. The resource-server set is
required. The crm-api group is optional and all-or-nothing: without it the service starts,
a company name is `null`, the company picker and the to-start queue answer 503 `crm_unavailable`,
and a deal cannot be taken. The service credential is configured through that group only, so
`ESTIMAI_INTERNAL_URL` without it answers `estimai_unconfigured`, and `NOTIFY_INTERNAL_URL` without
it sends nothing (the take is unaffected).

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
| `SERVICE_CLIENT_ID` | `projects-api` | its entry in auth's `SERVICE_CLIENTS` needs scopes `crm.companies.read crm.deals.read crm.contacts.read estimai.estimates.read notifications.push` |
| `SERVICE_CLIENT_SECRET` | the secret of that entry, at least 32 characters | secret |
| `ESTIMAI_INTERNAL_URL` | `http://localhost:8080` | optional; estimai-api's base URL. Unset: taking a `fixed_price` deal that has an estimate answers 503 `estimai_unconfigured` |
| `NOTIFY_INTERNAL_URL` | `http://localhost:8081` | optional; notify-api's base URL. The ops-manager's notification after a take is pushed here as `system:projects-api`. Unset, or without the service credential: no push, no failure (best effort) |
| `SERVICE_AUDIENCE` | auth's `SERVICE_AUDIENCE` | optional; the `aud` accepted on `/system/*`, different from `AUTH_AUDIENCE`. Unset: every `/system/*` request is a 401 |

crm-api and estimai-api also need `SERVICE_AUDIENCE` (auth's value) to accept the credential, and
crm-api's `SERVICE_CLIENTS` entry needs `projects.purchase-orders.read` to read
`/system/purchase-orders`. notify-api accepts `originApp: "projects"` from `system:projects-api` only.

## Migrations

`prisma/migrations` holds specs/021's `20261103163000_init` (unchanged) and specs/022's
`20261105120000_purchase_order`, stacked on it. The second **refuses to run**, with a message saying
what to do by hand, if the `contract` table has any row or a `saas` project exists: terms are one row
per project, a `saas` project now always has a company, and a purchase order exists only for a won
deal, so such data cannot be converted unambiguously (ADR-0062). On an empty database, or one with
projects but neither, it migrates untouched. Local databases are simply reset.

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

- `src/index.ts` mounts every area router once: `projects` (which also mounts the referent routes
  of `purchase-orders/`), `transitions`, `team`, `terms`, `bexio`, `companies`, `system`, `queue`,
  `take`.
- `src/auth/guards.ts`: the `authorized` stack and `assertCanManage(c, entity)`
  (403 `forbidden` without `project:manage`, 403 `out_of_scope` for the other entity).
- `src/lib/serviceToken.ts`: a shared copy (`scripts/check-shared-copies.ts`), edit every
  copy together.
