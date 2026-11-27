# @operai/inventory-api

## 0.3.1

### Patch Changes

- 8653331: A U+0000 in any input is a 400, never a 500. Postgres text (and the text inside jsonb) cannot hold it; every backend's global error handler now answers the database's refusal (Postgres 22021 / 22P05, Prisma P2039 / P2010) with a 400 `validation_failed` (hours-api: `invalid_request`) that names no value and none of the database's words, so a route nobody remembered is still not a 500. In auth a guard in front of the whole app refuses a NUL in the path, the query or a JSON body before any route runs (`GET /admin/users?q=%00`, `POST /admin/departments`, roles, invitations, legal entities, …). In projects-api the shared text helpers (`requiredText`, `optionalText`, a new `searchText`) refuse it, which covers `GET /projects?q=`, a project's name, a T&M position's profile, the Bexio order id and `GET /system/purchase-orders?dealIds=`.
- 8653331: The safety net that answers 400 when Postgres refuses a U+0000 now leaves one log line, `[nul] database refused U+0000 or invalid text` and the Prisma and SQLSTATE codes (`P2039/22021`), so a value built by the server with bad bytes is no longer blamed on the client without a trace (security review A09). The line carries only codes taken from the two closed sets the detector already knows: no message, value, argument, request or person. No wire contract changes.

## 0.3.0

### Minor Changes

- e64a774: Inventory: an asset can be held by an office (CH - Agno, CH - Lugano, YoRoom - Milano) instead of a person. Assigning to an office is immediate and works for any office whatever the asset's entity; return, lost and dispose clear it like a person. Offices are managed on a new Offices page (add, rename, archive); the asset list filters by office, and the holder column, detail, fiscal-year table, export and history show the office.
- 58c62d3: Inventory: an employee who has not confirmed or declined an assigned device is reminded by email and in Operai 24 hours after the offer, then every week until they answer. An inventory manager can send a reminder now from the asset (at most one an hour); the asset shows how many reminders went out and when the next one is due, and each one is in its history. Requires `emails.send` for inventory-api's service client in auth's `SERVICE_CLIENTS` before deploying.

### Patch Changes

- 080a1fb: Migration logs on Railway no longer show as errors: `bun run` no longer echoes the command on stderr (`[run] silent = true`) and `db:deploy` sends Prisma's informational stderr to stdout. A failing migration still exits non-zero and fails the deploy.

## 0.2.1

### Patch Changes

- 8d5ed71: Pins `hono` to 4.13.16 in every backend (it was a `^4.6.16` range that had resolved to 4.12.12 through 4.13.16 depending on the service), closing the hono advisories reported by `bun audit`, among them the CORS wildcard-origin reflection with credentials (GHSA-88fw-hqm2-52qc), the `bodyLimit()` bypass for chunked bodies (GHSA-9vqf-7f2p-gf9v), the CORS preflight ReDoS (GHSA-8j4g-w8fx-2239), the `mount()` prefix bypass (GHSA-4m76-xfj5-7975) and the RegExpRouter wildcard-middleware skip (GHSA-h7mg-cq63-vhpq). `@hono/node-server`, which only reaches the services through `prisma > @prisma/dev` (pinned there to 1.19.11, used by `prisma dev` and never at runtime), is overridden to 2.1.6 in each `package.json`, closing four path-handling advisories (GHSA-92pp-h63x-v22m, GHSA-frvp-7c67-39w9, GHSA-rmxm-3fg6-px4f, GHSA-jpvv-r467-5p4w). No route, status code or response changes.
- a2699bb: Moves inventory-api to zod 4 (4.6.7) and `@hono/zod-openapi` 1.6.3, and `@scalar/hono-api-reference` to 0.12.17, closing the zod memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5, zod before 4.6.6, no 3.x fix); the Scalar bump is needed because the old one pulled a second, vulnerable zod. A body, query or path value that fails validation still answers 422 with the same `field` and `errors` members, but the message text inside is zod 4's wording. A JSON body sent with another Content-Type, or none, now answers 415 as a Problem document instead of 422. In the OpenAPI document the asset response schema now declares `additionalProperties`, and a duplicate `nullable` entry in the history change values is gone; neither changes what is accepted or returned. The `/docs` page loads Scalar through a different script.
- 4cef202: Removes the stale `pnpm-lock.yaml` and `pnpm-workspace.yaml` from these Bun services. Their only lockfile is now `bun.lock`, which is what the Dockerfiles and CI install from; the leftover pnpm lockfiles still listed zod 3 and kept the zod advisory (GHSA-mrhx-c7xc-m3w5) showing in dependency scanners. No runtime change.
- fcdb417: The validation hook's issue path type accepts any property key (zod 4 may report symbols), so it type-checks under both zod 3 and zod 4. Responses are unchanged.

## 0.2.0

### Minor Changes

- 26521e2: The supplier field now suggests the suppliers already in the register, on the
  register form and in the Edit dialog. It is still free text: a new supplier is
  typed as before. Suggestions come from a new `GET /suppliers` endpoint, limited
  to the entities the caller can read.

### Patch Changes

- 80400be: Remove the Cloudflare CLI (`cf`) from the service's dependencies. It was added by
  mistake and never recorded in `bun.lock`, so the image build, which installs with
  a frozen lockfile, failed.
- c30a110: Mark the S3 residency allowlist and path-style addressing in `src/lib/s3Residency.ts` with `shared-copy` begin/end comments, so a CI check can fail when the copies across the backends drift. Comment-only: no behaviour change.
- 81f0af0: The shared notification token is retired. `notify-api`'s two internal routes,
  `POST /system/emails` and `POST /system/notifications`, now accept only a scoped
  service credential from the caller; the `X-Internal-Token` header is refused with
  401 and the `NOTIFY_INTERNAL_TOKEN` setting is no longer read, so a deployment that
  still has it set starts normally. `inventory-api`'s comments and example file no
  longer mention the shared token.
- 041cf92: Mark the service-token client's shared region in `src/lib/serviceToken.ts` with
  `shared-copy` begin/end comments so a CI check can fail when the three copies drift.
  Comment-only: no behaviour change.

## 0.1.0

### Minor Changes

- 2b11a53: New Inventory tool (specs/20261006-hardware-inventory): a hardware register with assets, employee-confirmed
  assignment, a depreciation ledger with fiscal-year close, and invoice files.

  `inventory-api` and `inventory-ui` are new. The shell mounts the gated `/inventory` route
  and an ungated `/devices` route (a "My devices" screen for every signed-in user). `auth`
  gains the inventory permission catalog, a scoped service-token endpoint and a capability-gated
  user directory. `notify-api` accepts the scoped service JWT on `/system/notifications` and a new
  `inventory` origin app, which `notify-ui` renders. New environment variables must be set before
  deploying: see `infra/README.md` § `inventory-api` service.

  `auth GET /authz/resolve` now returns no permissions for a soft-deleted user, so a removed
  user loses access to `refund-api` and `inventory-api` within 30 seconds instead of keeping it
  until their token expires.
