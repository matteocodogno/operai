# auth

The suite's authentication and authorization service: OAuth sign-in (better-auth), sessions,
RS256 JWTs with a JWKS endpoint, the role / department / permission model and its admin API
(ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims), invitations, and the scoped service credentials the tools use to call each other
(ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049). Bun + Hono + Prisma, port **3001**. Live API reference at
`http://localhost:3001/docs`. The service-wide conventions are in the repository's `AGENTS.md`;
this file records what is easy to miss.

## Permission catalogs and seeds

Each tool declares its permission catalog in `src/authz/catalogs/` and `src/authz/seed.ts`
registers it and grants it to the system roles (`bun run db:seed`, idempotent and non-destructive;
`bun run db:release` = migrations + seed). The resolver keys grants by `(resource, action)`
**without the app id**, so no two catalogs may declare the same pair.

### The `projects` catalog (specs/20261103-projects, 026; ADR 20261103-projects-tool-shape-and-authorization/0093/0094)

| Capability | Condition | Held by | Needed for |
|---|---|---|---|
| `projects:access` | none | project-manager, ops-manager, sales, accounting, admin | every projects-api route (reads included) |
| `project:manage` | entity | project-manager, ops-manager, sales (own entity); admin unconditioned | create / edit projects, terms, referent, states |
| `handoff:take` | entity | sales (own entity); admin unconditioned | the to-start queue and taking a won deal |
| `purchase-order:receive` | entity | **ops-manager** (own entity); admin unconditioned | being a purchase order's ops-manager; unconditioned is the admin override |
| `purchase-order:bexio` | none | accounting, admin | the Bexio order id (was `contract:bexio`) |

`ops-manager` is a system role created by the seed ("receives purchase orders and picks their
project manager"). Assigning it to people is a manual step (Admin tool). There is no `contract`
resource any more: "contract" is retired. The seed does **not** delete stale `contract:bexio`
rules from an earlier local database; remove them by hand.

### The `hours` catalog (specs/20261112-time-tracking; ADR 20261112-hours-api-time-entries-own-service-hours-catalog/0090)

| Capability | Condition | Held by | Needed for |
|---|---|---|---|
| `time-entry:read-all` | none | admin | hours-api's oversight path: `whose=all` and a `userId` filter on `GET /time-entries` and `GET /time-entries/totals` (everyone's hours); never a write |
| `time-list:manage` | none | admin | creating, renaming, retiring and restoring the time categories and work types (`POST`/`PATCH` on hours-api's `/time-categories` and `/work-types`) |

There is **no `hours:access`**: recording and reading your own hours needs only a signed-in user
(ADR 20261112-hours-ui-ungated-remote), so `hours` is not in `ALL_APP_IDS`, the seed gives `employee` nothing, and hours-api
consults neither permission for a person's own hours. Neither permission is in
`DIRECTORY_GATE_PERMISSIONS` or `HOLDERS_GATE_PERMISSIONS` (ADR 20261104-user-directory-gate-meetings-access): hours-ui's person filter reads
the `person` groups of hours-api's totals, not the user directory. Grant either to another role in
the Admin tool and it applies at once: hours-api asks `GET /authz/resolve` live on the oversight path
and on every list write. A role given `time-list:manage` also needs access to Admin to reach the
screen (`/admin/time-lists`).

## The holders listing: `GET /authz/users/holders` (ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047, amends ADR 20261006-user-directory-endpoint-capability-gated)

Feeds projects-api's ops-manager picker. A user Bearer JWT (projects-api forwards the caller's),
gated on the caller holding **`handoff:take`** under any entity (not the user directory's gate),
live, a soft-deleted caller refused.

```
GET /authz/users/holders?resource=purchase-order&action=receive&entity=welld_ch
200 { "users": [{ "id": "…", "name": "…", "unconditioned": false }] }
```

- Only the pair `purchase-order:receive` is answerable, pinned in code: any other pair (e.g.
  `asset:manage`) is `400 unsupported_permission`; unknown parameters or an `entity` other than
  `welld_ch` / `welld_it` are `400 invalid_query`.
- The answer lists the active users whose effective permissions grant the pair **for that entity**
  and who hold `projects:access`, name-sorted, as `{ id, name, unconditioned }` and nothing else (no
  email, no entity). An entity-conditioned grant qualifies only when the user's own entity equals the
  asked one; an unrecognised condition grants nothing (fail closed, as projects-api's `scopeFor`).
  `unconditioned` is true for an unrestricted grant (the admins).
- Its own rate limiter (60 attempts per caller per 10 minutes, a `403` or a bad query counts too →
  `429` + `Retry-After`), `Cache-Control: no-store`.

## Service scopes

`SERVICE_CLIENTS` (JSON, keyed by client id) declares each service client's secret and scopes; a
scope outside `KNOWN_SERVICE_SCOPES` (`src/system/serviceClients.ts`) refuses to start, naming the
client and never a secret.

| Scope | Accepted by | Held by |
|---|---|---|
| `notifications.push`, `emails.send` | notify-api `/system/*` | each notify caller |
| `users.contact` | auth `POST /system/users/contact` | notify-api |
| `crm.companies.read` | crm-api `GET /system/companies` | projects-api |
| `crm.deals.read` | crm-api `GET /system/deals` | projects-api |
| `crm.contacts.read` (specs/20261103-projects-handoff) | crm-api `GET /system/contacts` — a PO's referent, personal data | projects-api only |
| `estimai.estimates.read` | estimai-api `GET /system/estimates/{id}/summary` | projects-api |
| `projects.purchase-orders.read` (specs/20261103-projects-handoff; the retired contracts scope now refuses to start) | projects-api `GET /system/purchase-orders` | crm-api |
| `meetings.hosts.read` (specs/20261112-time-tracking, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route) | meetings-api `GET /system/meetings/hosts` — which host record (today a CRM deal) each meeting is linked to, `{id, host}` and nothing else; its `sub` allowlist is `system:hours-api` | the client `hours-api`, alone |

Locally, `projects-api` needs `crm.companies.read crm.deals.read crm.contacts.read
estimai.estimates.read notifications.push`, `crm-api` needs `notifications.push emails.send
projects.purchase-orders.read` and `hours-api` needs `meetings.hosts.read` alone (see `.env.example` and
`tools/env-doctor`). In production the `hours-api` client is added to `SERVICE_CLIENTS` only **after** the
auth that knows the scope is live: an unknown scope refuses to start (ADR 20261108-crm-pushes-deal-links-to-estimai).

## Commands

```bash
bun install
bun run db:deploy     # applies the migrations to the database DATABASE_URL names
bun run db:seed       # catalogs and system-role grants (idempotent)
bun run dev           # http://localhost:3001
bun run typecheck
bun test
```

`direnv exec .` loads the environment, as for every backend (`cd auth && direnv exec . bun test`).
