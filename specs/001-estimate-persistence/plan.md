---
spec: 001
status: approved
---

# Plan: Estimate persistence API

## Architecture

A new **`estimai-api`** service backs whole-document estimate persistence for signed-in
users, and `estimai-ui` moves its estimate CRUD from `localStorage` to that service —
keeping `localStorage` only as the source for the one-time US-5 import.

### Component map

```
┌─────────────┐   apiFetch (Bearer JWT)   ┌──────────────┐   verify RS256    ┌──────────┐
│ estimai-ui  │ ────────────────────────▶ │  estimai-api │ ────via JWKS────▶ │   auth   │
│  (React)    │   VITE_API_URL/estimates  │  (Bun+Hono)  │  /.well-known/    │ service  │
└─────────────┘                           └──────┬───────┘   jwks.json       └──────────┘
      │                                          │ Prisma
      │ localStorage (import source only)        ▼
      ▼                                   ┌──────────────┐
  estimai_project_* keys                  │ PostgreSQL   │  estimate table
                                          │ (EU region)  │  (columns + JSONB content)
                                          └──────────────┘
```

### estimai-api — new service

estimai-api is built as **Bun + Hono + TypeScript**, mirroring the existing `auth` service
so the monorepo has one backend stack, one test toolchain, one deploy recipe, and one team
mental model. A Kotlin/Spring route would mean standing up a second language, build system,
and JVM ecosystem for a service whose entire job in this iteration is JWT-verified JSONB
CRUD — not justified by any requirement in this spec. This decision is listed as an ADR
candidate below. The concrete stack, matching `auth`:

- **Runtime/framework:** Bun + Hono + `@hono/zod-openapi` (Scalar API reference at `/docs`).
- **Persistence:** Prisma 7 + `@prisma/adapter-pg` against PostgreSQL (same local
  Postgres 17 on host port 5435, a separate database/schema `estimai`).
- **Errors:** Effect TS for DB effects (`Effect.tryPromise` + tagged errors, per
  `auth/src/lib/errors.ts`), surfaced as RFC 7807 Problem JSON via a global
  `app.onError` + `app.notFound` (copied shape from `auth/src/index.ts`).
- **Env validation:** zod schema à la `auth/src/lib/env.ts`, `process.exit(1)` on missing
  vars. New vars: `DATABASE_URL`, `AUTH_JWKS_URL` (auth service `/auth/jwks` — better-auth's
  built-in JWKS whose rotating keypair signs `/auth/token`; NOT the custom
  `/.well-known/jwks.json`, corrected 2026-07-05 per T14 / ADR-0005),
  `AUTH_ISSUER` (= auth's `BETTER_AUTH_URL`), `ALLOWED_ORIGINS` (CORS, includes the UI
  origin), `MAX_ESTIMATE_BYTES` (default `1048576` = 1 MiB), `PORT` (default 8080),
  `NODE_ENV`.
- **Structure (routes-by-feature):**
  `src/estimates/estimates.routes.ts` (CRUD + import), `src/estimates/estimates.repo.ts`
  (Prisma access, Effect-wrapped), `src/estimates/estimates.schemas.ts` (zod request/
  response), `src/auth/jwt.middleware.ts` (JWKS verification + user scoping),
  `src/health/health.routes.ts`, `src/openapi/registry.ts`, `src/lib/{env,db,errors}.ts`.
  Registered in `src/index.ts` with CORS (`credentials: true`, `Authorization` allowed).

**Rejected for estimai-api:** Kotlin/Spring (stack duplication, no requirement pull);
Drizzle over Prisma (Prisma chosen to match `auth` exactly — same generated-client
pattern, same `PrismaPg` adapter, same migration convention; Drizzle would be a second
ORM idiom for no concrete gain here).

### Auth model (JWT resource verification)

estimai-api is a **resource server**: it does not manage sessions or issue tokens. A
`jwtMiddleware` on the `/estimates` router:

1. Reads `Authorization: Bearer <jwt>`; missing/malformed → 401 Problem (AC-4.2).
2. Verifies the RS256 signature with `jose` `jwtVerify`, using a **cached remote JWKS**
   (`jose` `createRemoteJWKSet(new URL(AUTH_JWKS_URL))` — built once at module scope; it
   caches keys and honours the auth JWKS `Cache-Control: max-age=3600`, refetching only on
   unknown `kid`). Verify `issuer: AUTH_ISSUER`; the signing key uses better-auth's
   rotating **dynamic `kid`** from `/auth/jwks` (corrected 2026-07-05 — the earlier
   static `operai-auth-rs256-v1` was the wrong, non-signing key; see ADR-0005).
3. On any verification failure (expired, bad signature, wrong issuer) → 401 Problem
   (AC-4.2). No DB access happens for unauthenticated requests.
4. On success, set `c.set('userId', payload.sub)` and `c.set('email', payload.email)`.

**Every** repository call is scoped by `where: { userId }` derived from `sub` — never from
a request body or path. Fetching/deleting an estimate the caller does not own returns
**404** (not 403): the record is filtered out by the `userId` predicate, so "not yours"
and "does not exist" are indistinguishable to the caller. This satisfies AC-4.1 (user B
receives none of user A's data, attempt rejected) and avoids leaking existence of other
users' ids.

This mirrors `auth`'s `requireAuth` Problem-JSON shape but verifies a *foreign* token via
JWKS rather than calling `better-auth.getSession()` (estimai-api has no better-auth
instance and no session cookie). It is the first JWKS-consumer in the monorepo → ADR
candidate.

### UI flow changes

- New `src/lib/estimatesApi.ts`: typed wrappers over `apiFetch(\`${VITE_API_URL}/estimates…\`)`.
  `VITE_API_URL` is already a trusted origin in `apiFetch` (`isTrustedOrigin`), so the
  Bearer JWT is attached automatically; no change to `api.ts`.
- `projects.ts` is **retired as the estimate store** but kept intact as the **import
  source** (its `loadProjects`/`loadProject` read the legacy `estimai_project_*` keys).
  New estimate reads/writes go through `estimatesApi`.
- `router.tsx`: the `/` and `/estimates/$estimateId` `beforeLoad` guards currently call
  `loadProject` (localStorage). They move to a server existence check via loader (or defer
  the not-found handling into the page to keep the guard cheap). The `_authed` guard is
  unchanged.
- `EstimatesPage`: list from `GET /estimates`; async load state; empty state already exists
  (AC-2.3) and is reused when the server returns `[]`; delete calls `DELETE` then refreshes.
- `EstimatorContext`: the auto-save effect switches from `saveProjectData` (localStorage)
  to a debounced `PUT /estimates/{id}` (create-then-update; last-write-wins per spec). On
  save failure the effect **keeps in-memory state and surfaces an error** without clearing
  or overwriting (AC-1.3).
- Import: an `ImportOffer` surfaced once per session on first authenticated load when
  legacy localStorage estimates exist (details in "API contracts" and "Test strategy").

**Existing ADRs honoured:** ADR-0001 (JWT in memory, `apiFetch` refresh/retry, trusted
origins) is unchanged and reused as-is — estimai-api is a trusted origin via `VITE_API_URL`.
ADR-0002 (central sign-in) is unchanged — estimai-api never serves auth UI.

## Data model

One table, `estimate`, in a new `estimai` Postgres database. Prisma schema (own `estimai-api/prisma/schema.prisma`, separate from `auth`'s; **new migration only, never edit existing**):

```prisma
model Estimate {
  id        String   @id @default(cuid())
  userId    String                              // JWT `sub`; ownership scope (AC-4.1)
  name      String                              // denormalised for list view (AC-2.1)
  author    String   @default("")               // denormalised for list view
  sizeBytes Int                                 // byte length of content JSON (AC-1.4)
  content   Json                                // { params, releases, acts } — JSONB, byte-faithful
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId, updatedAt(sort: Desc)])      // list query: user's estimates, newest first
  @@map("estimate")
}
```

Design notes:
- **JSONB document + listing columns.** `name`/`author`/`updatedAt`/`sizeBytes` are
  promoted to columns so the list query (AC-2.1) and ownership filter (AC-4.1) never parse
  JSON, and the size guard (AC-1.4) is a cheap integer. The full editable payload
  (`params`, `releases`, `acts`) lives in `content` JSONB.
- **Byte-faithful round-trip (AC-1.1/AC-2.2).** The server stores the client payload
  verbatim (no field renaming, no defaulting, no re-ordering-sensitive transform). On read
  it returns `content` unchanged. `name`/`author` in columns are copies of the values
  inside the document sent by the client; the client is the single source of shape. Since
  Postgres `jsonb` does not preserve key order or insignificant whitespace, "byte-faithful"
  is defined as **semantic (deep-equal) round-trip** of the JSON value — the estimation
  model (AC-2.2) depends only on values, not serialization; this is asserted explicitly in
  the test strategy. (If literal-byte fidelity is ever required, switch `content` to `text`;
  not needed for any AC here — noted as a rejected option.)
- No `release`/`activity`/`epic` tables — sub-resource CRUD is an explicit non-goal.
- Migration approach: Prisma migrate (`prisma migrate dev` locally, `prisma migrate deploy`
  in CI/deploy), matching `auth`'s convention. One `init` migration creates `estimate` +
  the composite index.

## API contracts

Base URL `VITE_API_URL` (local `http://localhost:8080`). All requests require a valid
Bearer JWT (AC-4.2). All errors are RFC 7807 `application/problem+json` with the
`{ type, title, status, detail, instance }` shape used by `auth`. Timestamps are ISO 8601.

Shared shapes (zod):

```ts
// EstimateContent — stored verbatim in JSONB; mirrors UI ProjectData minus id/name/author
EstimateContent = {
  params: Parameters,          // { parallelism, sprintDays, workingDaysMonth,
                               //   qaDeployDays, qaTestDays, pmDays, aiCostCoef, aiGain }
  releases: Release[],         // [{ id, name, fte }]
  acts: Activity[],            // [{ id, num, epic, act, prof, o, ml, p, risk, aiGain?, notes, release }]
}

// Request body for POST / PUT
EstimateUpsert = { name: string, author: string, content: EstimateContent }

// List item
EstimateListItem = { id: string, name: string, author: string, updatedAt: string }

// Full estimate
EstimateFull = { id, name, author, content, createdAt, updatedAt }
```

Endpoints:

```
POST /estimates                       Create (AC-1.1)
  body: EstimateUpsert
  201 → EstimateFull
  400 → validation Problem (bad shape)
  413 → size Problem (see guard); nothing persisted
  401 → unauthenticated

GET /estimates                        List current user's (AC-2.1, AC-2.3)
  200 → EstimateListItem[]  (only userId == sub; [] is the empty state, not an error)
  401 → unauthenticated

GET /estimates/{id}                   Full estimate (AC-2.2)
  200 → EstimateFull  (only if owned by caller)
  404 → not found OR not owned (AC-4.1 — indistinguishable)
  401 → unauthenticated

PUT /estimates/{id}                   Update in place, no duplicate (AC-1.2)
  body: EstimateUpsert
  200 → EstimateFull  (same id; updatedAt advanced; last-write-wins, no version check; amended by specs/013-estimate-sharing/ADR-0038, see note below)
  404 → not found OR not owned (AC-4.1)
  413 → size Problem; prior stored version untouched (no partial write, AC-1.4)
  401 → unauthenticated

DELETE /estimates/{id}                Delete (AC-3.1)
  204 → deleted (idempotent: deleting a non-owned/absent id → 404)
  404 → not found OR not owned (AC-4.1)
  401 → unauthenticated

POST /estimates/import                One-time bulk import (US-5, AC-5.2/5.4)
  body: { estimates: Array<{ localId: string } & EstimateUpsert> }
  200 → { results: Array<{ localId, status: "imported" | "failed",
                           id?: string, error?: string }> }
  Partial-failure tolerant: each element imported independently in its own transaction;
  one failure never aborts the batch. Per-element size guard applies (an over-size element
  → that element status "failed", others still imported). The endpoint itself returns 200
  as long as the request was well-formed; per-estimate outcome is in `results`.
  401 → unauthenticated
```

> **Amended 2026-08-07 by `specs/013-estimate-sharing`**
> ([ADR-0038](../../docs/adr/0038-optimistic-concurrency-version-if-match-cas-amends-0004.md)):
> `PUT /estimates/{id}` no longer accepts unconditional last-write-wins — it now requires
> an `If-Match` version precondition, returning `428` (missing/malformed precondition) or
> `409 estimate_version_conflict` (stale version) instead of always succeeding. This plan's
> contract as written reflects what spec 001 shipped; see specs/013's plan for the current
> `PUT` contract.

### Size guard (AC-1.4)

- Applied on `POST /estimates`, `PUT /estimates/{id}`, and **per element** of
  `POST /estimates/import`.
- Limit: `MAX_ESTIMATE_BYTES`, default **1 MiB (1048576 bytes)** — measured as the UTF-8
  byte length of the serialized `content`. Rationale: a large real estimate (hundreds of
  activities × ~1 KB each) sits comfortably under 100 KB; 1 MiB is ~10× headroom while
  still bounding abusive/accidental payloads. Configurable per environment.
- Enforced **before** any write, so nothing is persisted on rejection (AC-1.4 "no partial
  write"). Also enforce a Hono body-size limit at the router so the process never buffers
  an unbounded body.
- Rejection response (`413 Payload Too Large`):
  ```json
  {
    "type": "https://httpstatuses.com/413",
    "title": "Payload Too Large",
    "status": 413,
    "detail": "Estimate content is 2.3 MB; the maximum is 1.0 MB. Nothing was saved.",
    "instance": "/estimates/{id}"
  }
  ```
- No count quota anywhere (spec non-goal): unlimited number of estimates per user.

## Test strategy

Test tooling: `bun test` for estimai-api (unit + integration, real Postgres via the
existing compose DB; JWTs signed in-test with a fixture RS256 keypair and a local JWKS the
middleware points at). UI: Vitest + Testing Library for unit/integration; Playwright for
e2e. e2e "full stack" tests run estimai-api + a real/stub auth JWKS + Postgres.

**AC → test coverage (total — every AC mapped):**

| AC | What it asserts | Level | Test that proves it |
|----|-----------------|-------|---------------------|
| AC-1.1 | Save persists full estimate; refetch is identical | integration (api) | `POST /estimates` then `GET /estimates/{id}` → deep-equal on `content` (params/releases/acts) + name/author. Byte-faithful = semantic round-trip. |
| AC-1.2 | Re-save after edit updates in place, no duplicate | integration (api) | Create → `PUT` with edits → `GET /estimates` returns exactly 1 item, same id, `updatedAt` advanced, content reflects edit. |
| AC-1.3 | Save failure → error shown, in-browser data not lost | unit (ui) | EstimatorContext save effect: mock `estimatesApi.update` rejects → error surfaced, in-memory state unchanged, no clear/overwrite. |
| AC-1.4 | Over-size payload rejected, nothing persisted; in-limit saves; no count cap | integration (api) | `POST`/`PUT` with content > `MAX_ESTIMATE_BYTES` → 413 Problem, `GET /estimates` count unchanged / prior version intact. In-limit → 201/200. Loop create N>expected-cap estimates → all succeed (no quota). |
| AC-2.1 | List shows every saved estimate with name + last-modified | integration (api) | Seed 3 estimates for user → `GET /estimates` returns 3 `EstimateListItem` with `name` + `updatedAt`. |
| AC-2.2 | Reopen loads exact content; computed values match model | integration (ui) | Load fixture estimate via `estimatesApi.get`, mount editor, assert `useEstimator` outputs (PERT/Expected/Elapsed) equal the model's output for that content. |
| AC-2.3 | No estimates → empty state, no error | unit (ui) + integration (api) | api: `GET /estimates` for fresh user → `200 []`. ui: EstimatesPage with `[]` renders empty state, no error banner. |
| AC-3.1 | Delete → gone from list and direct fetch reports gone | integration (api) | Create → `DELETE /estimates/{id}` → 204 → `GET /estimates` excludes it, `GET /estimates/{id}` → 404. |
| AC-3.2 | Decline confirm → estimate untouched | unit (ui) | EstimatesPage delete: user declines confirm → `estimatesApi.delete` NOT called, item still present. |
| AC-4.1 | User B cannot read user A's list/estimate | integration (api) | Seed estimate for user A. With user B's JWT: `GET /estimates` excludes A's; `GET/PUT/DELETE /estimates/{A-id}` → 404. |
| AC-4.2 | Unauthenticated request rejected, no data returned/modified | integration (api) | No/invalid/expired Bearer on each endpoint → 401 Problem; DB unchanged (verified by a follow-up authed read). |
| AC-5.1 | First sign-in offers import; can accept/decline | integration (ui) | With legacy localStorage estimates present + authed session, ImportOffer renders with accept + decline actions. |
| AC-5.2 | Accept → each local estimate appears with identical content | integration (ui+api) | Accept → `POST /estimates/import` → results all "imported" → `GET /estimates` returns each with content deep-equal to the local version. |
| AC-5.3 | Decline → local untouched, offer not repeated in session | unit (ui) | Decline → localStorage keys unchanged; re-render / navigate within session → offer does not reappear (session-scoped dismissal flag). |
| AC-5.4 | Partial failure → user told which imported/which not; no local removed | integration (ui+api) | Import batch where one element is over-size/invalid → `results` marks it "failed", others "imported"; UI shows per-estimate outcome; all localStorage keys still present. |

**Two thin spots the 002 eval flagged (explicitly closed here):**

- **T-JWKS-identity (closes 002 AC-3.2 gap) — e2e/integration.** A real estimai-api call
  where the Bearer JWT is verified against the JWKS and the resolved `sub`/`email`
  identifies the correct user. Concretely: mint a JWT for user A, `POST /estimates`, then
  `GET /estimates/{id}` and assert ownership resolved to A (and a token for B cannot reach
  it — dovetails with AC-4.1). This exercises the *real* JWKS-verification path against a
  live 001 backend, not a mock — the assertion 002 could only stub.
- **T-real-401 (apiFetch real-401 path) — integration (ui against estimai-api).** Drive
  `apiFetch` against estimai-api returning a genuine 401 (expired/absent JWT): assert the
  ADR-0001 refresh-retry-then-redirect circuit fires against a real backend 401, not a
  mocked `Response`. Confirms the UI interceptor and the 001 401 Problem contract agree.

## Risks

- **localStorage → server cutover for existing local estimates.** Users who worked pre-001
  have estimates only in localStorage; a naive cutover makes them "disappear" from the list.
  *Mitigation:* localStorage is retained read-only as the US-5 import source; the import
  offer (AC-5.1) is the migration path. *Early check:* the router guards must not delete or
  depend on localStorage estimates; verify legacy keys survive an import decline (AC-5.3).
- **JWKS availability / caching.** If estimai-api cannot reach the auth JWKS, every request
  fails closed (401/503). *Mitigation:* `jose` `createRemoteJWKSet` caches keys and only
  refetches on unknown `kid`; honour the auth `max-age=3600`. *Early check:* health endpoint
  and an integration test that a transient JWKS fetch failure surfaces as 503 (service
  problem), not 401 (which would wrongly redirect the user to sign-in).
- **estimai-api does not exist yet — bootstrapping cost.** The directory is empty; this is a
  from-scratch service. *Mitigation:* scaffold by copying `auth`'s proven skeleton
  (env/db/errors/openapi/onError/CORS) rather than greenfielding; keep the surface to the
  6 endpoints in this spec. *Early check:* first task is a health-check + env-validation
  slice that boots against the compose Postgres before any estimate logic.
- **Data-residency deploy.** Estimate data must live in an EU region with no provider logging
  beyond access logs. *Mitigation:* deploy estimai-api + its Postgres to an EU region
  (Railway EU, per the spec 001 data-residency constraint) and disable request-body logging (the `hono/logger` used by
  `auth` logs method/path/status only — no bodies; keep it that way, do not log `content`).
  *Early check:* deployment task explicitly names the region and asserts no estimate payload
  is written to application logs. (Devops constraint — see Security/Deployment note.)
- **Round-trip fidelity vs JSONB normalization.** Postgres `jsonb` reorders keys / strips
  whitespace, so "byte-faithful" cannot mean literal bytes. *Mitigation:* define fidelity as
  semantic deep-equal (AC-2.2 depends on values only) and assert it in AC-1.1's test. If a
  future requirement needs literal bytes, `content` becomes `text` — noted, not adopted.
- **Last-write-wins data loss across tabs/devices.** Two concurrent editors: the later save
  silently overwrites. This is the spec's accepted behaviour (non-goal), not a defect — no
  mitigation required, but flagged so it is not "discovered" later as a bug.

## Security

**SECURITY-SENSITIVE? — YES.** This feature introduces authenticated per-user persistence of
client-sensitive effort and pricing data (PII-adjacent commercial data), a JWT-verifying
resource server, cross-origin browser→API calls, and a bulk-import endpoint. Per the process,
the orchestrator schedules an **`owasp-reviewer` pass in parallel with QE** (not left to
discovery). Because the data is client-sensitive consulting data for regulated-sector clients
(energy/finance/healthcare), treat this review at the elevated tier.

Top review targets (name the surfaces):
- **Ownership scoping (AC-4.1) — highest priority.** Every query in
  `estimai-api/src/estimates/estimates.repo.ts` must be filtered by `userId` derived from the
  verified JWT `sub`, never from request body/path. Review: `GET /estimates`,
  `GET/PUT/DELETE /estimates/{id}` — confirm 404-on-not-owned (no existence leak), no IDOR.
- **Import endpoint `POST /estimates/import`.** Bulk write surface: review per-element size
  guard, per-element transaction isolation (one failure cannot corrupt or partially write
  another), input validation of arbitrary client-supplied JSON, and that it writes only under
  the caller's `userId`.
- **JWT verification middleware `estimai-api/src/auth/jwt.middleware.ts`.** Confirm signature
  + `issuer` are both verified, expired/wrong-issuer/wrong-kid tokens rejected (AC-4.2),
  algorithm pinned to RS256 (no `alg:none` / algorithm-confusion), and unauthenticated
  requests never touch the DB.
- **Size guard / DoS.** Body-size limit at the router so an unbounded body is never buffered
  (AC-1.4); Problem response leaks no internals.
- **Data residency / logging.** No estimate `content` in application or provider logs beyond
  standard access logs; EU-region deploy (deployment constraint for devops).

## ADR candidates

(For the caller to invoke `adr-writer` — not written here.)

1. **estimai-api is Bun + Hono + TypeScript, not Kotlin/Spring Boot.** Rationale =
   monorepo stack consistency with `auth`.
2. **Estimate persistence shape: JSONB document + denormalised listing columns.** One
   `estimate` row with `content` JSONB plus `name`/`author`/`sizeBytes`/timestamps as columns;
   whole-document CRUD, no sub-resource tables (this iteration). Records the fidelity
   definition (semantic deep-equal, not literal bytes) and the size-guard limit.
3. **JWT resource-server verification via remote JWKS (first JWKS consumer).** estimai-api
   verifies foreign RS256 tokens with `jose createRemoteJWKSet` (issuer-pinned, RS256-pinned,
   cached), scoping every query to `sub`, returning 404 on not-owned. Establishes the pattern
   for all future Operai resource services.

## Spec amendment proposed

None. The spec is internally consistent and every AC is mappable. (AGENTS.md — which
previously carried a Kotlin/Spring estimai-api note — has been removed from the project, so
there is no doc to reconcile against.)
