# estimai-api

EstimAI's resource server (specs/001, ADR-0003/0004/0005): estimate persistence as a JSONB
document with collaborator sharing (specs/013, ADR-0036). Bun + Hono + Prisma, port **8080**.
Live API reference at `http://localhost:8080/docs`.

It is deliberately **not** an authorization-enforcing resource server: every `/estimates` route
verifies the caller's user JWT and scopes its queries to the caller's own and shared estimates.

## The system route (specs/022, ADR-0061)

`GET /system/estimates/{id}/summary` is the one route that is **not** scoped to a user. It is read
by projects-api, as itself, to copy a deal's estimate man-days onto a fixed-price contract:

- Authorization: a 5-minute service JWT minted by `auth` (`POST /system/service-token`), scope
  `estimai.estimates.read`, `aud = SERVICE_AUDIENCE`. A user JWT is never accepted, and every
  credential failure (none, malformed, expired, another scope, `SERVICE_AUDIENCE` unset) answers
  the same `401`.
- It reads any estimate regardless of owner or collaborators, so it answers only
  `{ id, name, manDays }`, never the estimate's content. An unknown id is `404 estimate_not_found`.
- `manDays` is the Expected effort without AI gain (the sum of PERT plus risk buffer per activity,
  rounded half up once to one decimal). The arithmetic in `src/system/manDays.ts` between the
  `shared-copy` markers is a byte-identical copy of crm-api's `src/offers/scope.ts`: change both
  in one commit; `bun scripts/check-shared-copies.ts` (repo root) fails when they differ.
- `src/index.ts` mounts `systemEstimatesRouter` **before** the estimates routers, whose wildcard
  user-JWT middleware would otherwise answer a service credential with a `401`.

## Environment

Validated at startup by `src/lib/env.ts`, which is the source of truth. The new key:

| Variable | Local value | Notes |
|---|---|---|
| `SERVICE_AUDIENCE` | auth's `SERVICE_AUDIENCE` | optional; the `aud` accepted on `/system/*`, different from `AUTH_AUDIENCE`. Unset: every `/system/*` request is a 401. The `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` already set here are the notify client and are unrelated to it |

The `projects-api` entry in auth's `SERVICE_CLIENTS` needs the scope `estimai.estimates.read`, and
projects-api needs `ESTIMAI_INTERNAL_URL` pointing here.

## Commands

```bash
bun install
bun run db:migrate     # creates/updates the database (Prisma migrate dev)
bun run dev            # http://localhost:8080
bun run typecheck
bun test
```
