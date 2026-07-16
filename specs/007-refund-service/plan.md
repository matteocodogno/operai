---
spec: 007
status: approved
---

# Plan: Refund service (Rimborsi) — expense requests, expense lines & accounting review

## Context this plan fits (read before the design)

- `refund-api` **does not exist yet.** This plan bootstraps it as a new Bun + Hono +
  `@hono/zod-openapi` + Prisma + PostgreSQL + Effect TS JWKS resource server, mirroring
  `estimai-api`/`notify-api`'s shape verbatim (`src/lib/{env,db,errors,logger}.ts`,
  `src/auth/jwt.middleware.ts`, `src/openapi/registry.ts`, global RFC-7807
  `onError`/`notFound`, `AUTH_AUDIENCE` enforcement per ADR-0010).
- `refund-ui` exists as an authed-only placeholder (`src/App.tsx`) — a federated remote
  with no own auth guard/chrome that reads `shell/session` (`useSession`, `apiFetch`)
  per ADR-0006. This plan replaces the placeholder with the real screens.
- Two **capabilities the suite does not have yet** are load-bearing for this spec and are
  designed below as new seams (each an ADR candidate), not assumed to exist:
  1. **Server-side authorization in a resource server.** `estimai-api` verifies *identity*
     only (JWKS). `GET /authz/me` (ADR-0007) is **session-cookie**-gated, so a resource
     server holding only a Bearer JWT cannot call it. refund-api is the first service that
     must enforce **role + entity-scoped** permissions server-side (AC-5.4/6.4/7.5 demand
     API-level denial, not just UI hiding). ADR-0007 explicitly deferred the resource-server
     side; this plan defines it.
  2. **Cross-user in-app notification.** `POST /notifications` (notify-api) derives the
     recipient from the caller's own JWT `sub` (OWASP A01 — a caller can only notify
     themselves). `/system/emails` is email-only. AC-3.6 requires refund-api (acting as the
     *accounting* user) to push an **in-app** notification to a **different** user (the
     employee). No server-to-server in-app path exists → new internal endpoint below.

## Architecture

### Components

| Component | Change | Notes |
|---|---|---|
| `refund-api` (NEW) | Bootstrapped resource server | Own logical PostgreSQL DB, own `.envrc`, `mise run dev` wiring. JWKS identity (ADR-0005) + `aud` (ADR-0010). |
| `auth` `src/authz/` | +`GET /authz/resolve` (Bearer) + `catalogs/refund.ts` + seed grants | The Bearer-authed resource-server resolution seam; refund's real catalog replacing the access-only stub. |
| `notify-api` `src/system/` | +`POST /system/notifications` (internal-token) | Cross-user in-app push; mirrors `/system/emails` (ADR-0011). |
| `refund-ui` | Real screens replace placeholder | Employee request composer/list/detail; accounting queue/review. Federated remote (ADR-0006). |
| Object storage (NEW) | EU-region S3-compatible bucket | Receipt attachments (data residency, CLAUDE.md). |

### Request → review → decision flow

```
EMPLOYEE (role: employee)                           ACCOUNTING (role: accounting, entity-scoped)
──────────────────────────                          ─────────────────────────────────────────────
POST /requests                → draft
POST /requests/:id/lines      → line(s)
POST …/attachments            → presigned PUT to EU bucket ─────► object storage (EU)
POST /requests/:id/submit     → validate → SUBMITTED ──────────► GET /review/requests (queue, entity-scoped)
                                    │ audit: submitted                 GET /requests/:id (full detail, in-scope)
                                    │                                  GET …/attachments/:id/url → presigned GET
POST /requests/:id/withdraw   → back to DRAFT (removes from queue)
                                                                       PUT …/approved-total (per line, entity-scoped)
                                                                       POST /review/requests/:id/approve → APPROVED
                                                                       POST /review/requests/:id/reject  → REJECTED (motivation)
                                    ┌──────────────────────────────────────────┘ audit: approved|rejected|approved-total-set
                                    ▼
        refund-api → POST /system/notifications (X-Internal-Token) → notify-api inAppChannel
                     → SSE push to employee's sub  (AC-3.6)
GET /requests, GET /requests/:id   ◄── employee tracks outcome (requested vs approved, motivation)
```

### How refund-api authorizes every call (server-side, ADR-0007-consistent)

1. `jwtMiddleware` verifies RS256 + `iss` + `aud` (ADR-0005/0010); sets `userId` (`sub`),
   `email`, and reads `perm_epoch` from the verified token.
2. `authzMiddleware` (new) resolves the caller's **refund** permissions live from
   `GET /authz/resolve` on `auth`, forwarding the caller's Bearer token. Response:
   `{ epoch, permissions[], entity, jobTitle }`. Cached in-process keyed by
   `(sub, perm_epoch)` (the JWT carries `perm_epoch`; an admin grant change bumps the epoch
   → the client's next refreshed token carries a new epoch → cache miss → refetch), with a
   short hard TTL (default 30 s) as a liveness backstop. Sets `c.var.authz` =
   `{ permissions, entity }`.
3. Route handlers gate on the resolved permissions and evaluate **conditions locally**
   (the auth resolver persists/surfaces conditions but never evaluates them against records
   — that is the consuming app's job, per `resolver.ts`). Ownership (`ownership:own`) and the
   entity condition (`{key:"entity", match:"user"}`) are evaluated in refund-api against the
   request/its lines.

Reuses: ADR-0001 (in-memory JWT via `shell/session.apiFetch`), ADR-0005 (JWKS + ownership-404),
ADR-0006 (federated remote), ADR-0007 (live permission resolution, no perms in JWT),
ADR-0009 (notification center), ADR-0010 (`aud`), ADR-0011 (internal-token service trust).

### refund-ui screen architecture

Real inner TanStack Router mounted at `basepath: '/refund'` (the placeholder deferred this):

- `/refund/requests` — employee's own list (status + last-updated; AC-3.1).
- `/refund/requests/new` + `/refund/requests/:id` — draft composer: line editor (type-driven
  fields, `km` shown only for `travel-km`), attachment upload, per-currency subtotals,
  submit/withdraw/delete. Read-only once `submitted`/decided; approved shows requested vs
  approved + the monthly-processing note (AC-4.1); rejected shows the motivation.
- `/refund/review` — accounting queue (rendered only when `authz.apps`/permissions include
  `request:review`; the shell nav item is likewise gated). Entity-scoped list.
- `/refund/review/:id` — accounting detail: full lines + attachments, editable approved
  totals, approve / reject-with-motivation.

All data via `shell/session`'s `apiFetch` (attaches Bearer to the trusted refund-api origin,
handles 401 refresh-retry, ADR-0001). No auth guard/chrome in the remote (ADR-0006).
UI copy is i18n IT/EN from day one; the twelve expense-type labels and entity labels come
from a shared constant (English identifier ↔ Italian source-form label, spec table).

## Data model

New Prisma schema in `refund-api/prisma/schema.prisma` (own logical DB). One initial
migration `0001_init` creates the enums, tables, indexes, and the audit-immutability trigger.

### Money handling — decision: integer minor units (`Int` cents/centesimi)

Amounts stored as **integer minor units** (`amountCents: Int`), not `Decimal`. Justification:
exact and unambiguous (no binary-float or Decimal-scale drift on a value that ends up on a
paycheck); trivially and safely summable for the per-currency subtotals; matches the suite's
"all displayed numbers are rounded" convention (the UI formats cents → `x,xx €`/`x,xx CHF`).
`Int` (max ≈ 2.1 B cents ≈ 21 M EUR) far exceeds any single reimbursement line. **Currency is
never stored** — it is *derived* from `entity` (`welld_it → EUR`, `welld_ch → CHF`) at the API
boundary, so line entity is the single source of truth and cannot disagree with a stored
currency. No cross-currency arithmetic ever occurs (Non-goals): subtotals are grouped by
`entity`.

### Enums

```prisma
enum RefundStatus { draft submitted approved rejected }   // withdraw = submitted→draft; `withdrawn` is an audit event, not a status
enum Entity       { welld_it welld_ch }                    // reuses auth's user.entity values
enum ExpenseType {
  travel_highway travel_km travel_parking travel_train travel_other_public_transport
  company_manuals stationery representation_meals representation_gifts
  office_material postal telephone
}
enum AuditAction  { submitted withdrawn approved rejected approved_total_set }
enum UploadStatus { pending stored }
```

### Tables

```prisma
model RefundRequest {
  id                 String       @id @default(cuid())
  ownerUserId        String                                  // JWT sub — never from body (ADR-0005)
  ownerEmail         String                                  // snapshot for accounting display (AC-6.1)
  ownerName          String?
  status             RefundStatus @default(draft)
  submittedAt        DateTime?
  decidedAt          DateTime?
  decidedByUserId    String?
  decidedByEmail     String?
  rejectionMotivation String?                                // non-null iff status==rejected (AC-7.3)
  lines              RefundLine[]
  auditEntries       RefundAuditEntry[]
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt
  @@index([ownerUserId, status])                             // list-own (AC-3.1)
  @@index([status])                                          // queue base filter (AC-5.1)
}

model RefundLine {
  id                 String      @id @default(cuid())
  requestId          String
  request            RefundRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  date               DateTime    @db.Date
  type               ExpenseType
  motivo             String
  entity             Entity
  requestedAmountCents Int                                    // employee-entered (AC-1.2)
  km                 Int?                                     // required & >0 iff type==travel_km (AC-1.2)
  approvedTotalCents Int?                                     // set during review (AC-7.1/7.2)
  attachments        Attachment[]
  createdAt          DateTime    @default(now())
  updatedAt          DateTime    @updatedAt
  @@index([requestId])
  @@index([requestId, entity])                               // per-request entity-scope check
}

model Attachment {
  id           String       @id @default(cuid())
  lineId       String
  line         RefundLine   @relation(fields: [lineId], references: [id], onDelete: Cascade)
  objectKey    String       @unique                          // refund/{requestId}/{lineId}/{attachmentId}/{safeName}
  fileName     String
  contentType  String
  sizeBytes    Int
  uploadStatus UploadStatus @default(pending)                // two-phase presigned upload
  createdAt    DateTime     @default(now())
  @@index([lineId])
}

model RefundAuditEntry {                                     // append-only, immutable (US-8)
  id         String      @id @default(cuid())
  requestId  String
  request    RefundRequest @relation(fields: [requestId], references: [id], onDelete: Restrict)
  lineId     String?
  actorUserId String
  actorEmail String
  action     AuditAction
  detail     Json?                                           // e.g. {rejectionMotivation} | {lineId, fromCents, toCents}
  createdAt  DateTime    @default(now())
  @@index([requestId, createdAt])
}
```

### Immutability & retention (US-8)

- **AC-8.2 (audit immutable, even to admin):** a raw-SQL trigger in `0001_init` blocks writes:
  `CREATE RULE refund_audit_no_update AS ON UPDATE TO "RefundAuditEntry" DO INSTEAD NOTHING;`
  and the same for `DELETE` (or `BEFORE UPDATE/DELETE … RAISE EXCEPTION`). Defense-in-depth
  beyond "no code path exists to mutate it" — teeth at the DB level. refund-api exposes **no**
  update/delete route for audit rows.
- **AC-8.3 (decided requests not deletable):** `RefundAuditEntry.request` uses
  `onDelete: Restrict`; combined with the route guard that only permits `DELETE /requests/:id`
  when `status == draft`, a request that ever reached `approved`/`rejected` (and thus has audit
  rows) cannot be deleted. Lines/attachments cascade-delete only while the request is a draft.
- Attachment **objects** in storage are deleted only on explicit draft-time attachment removal
  (AC-1.3); a decided request's objects are retained.

### Migrations needed

1. `0001_init` — enums, four tables, indexes, audit-immutability trigger/rule.
   (No further migrations planned for the first iteration; never edit an applied migration.)

## API contracts

Base: `http://localhost:8082` (local) / `https://refund-api…` (prod, EU region). All errors
are RFC-7807 Problem JSON (`type,title,status,detail,instance`). All timestamps ISO 8601.
Amounts on the wire are integer **cents** with a sibling derived `currency` for display.
Auth on every route: `jwtMiddleware` then `authzMiddleware`. Denial semantics:

- **Capability absent** (no `request:review` grant at all) on `/review/*` → **403**.
- **Record-level** ownership/entity-scope failure on `/requests/:id` and its subroutes →
  **404** (mirrors ADR-0005 "not yours = not found"; also AC-6.4 "deep link denied" without
  leaking existence). Non-owner-non-accounting on any `/requests/:id` → 404 (AC-2.5).

### Shared shapes

```jsonc
// RefundLine (response)
{ "id":"…","date":"2026-07-01","type":"travel_km","motivo":"Client visit","entity":"welld_it",
  "currency":"EUR","requestedAmountCents":4550,"km":120,"approvedTotalCents":4000,
  "attachments":[{"id":"…","fileName":"receipt.pdf","contentType":"application/pdf","sizeBytes":20481}] }

// RefundRequest detail (response) — per-currency subtotals, never blended (AC-3.5/6.6)
{ "id":"…","status":"approved","owner":{"userId":"…","email":"a@welld.ch","name":"…"},
  "submittedAt":"…","decidedAt":"…","decidedBy":{"email":"acct@welld.ch"},
  "rejectionMotivation":null,"lines":[ /* … */ ],
  "subtotals":[ {"entity":"welld_it","currency":"EUR","requestedCents":9100,"approvedCents":8000},
                {"entity":"welld_ch","currency":"CHF","requestedCents":5000,"approvedCents":5000} ],
  "createdAt":"…","updatedAt":"…" }
```

### Employee endpoints (require `refund:access` + `request:create`/`request:read`, ownership:own)

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /requests` | – | 201 request (draft) | 401/403 |
| `GET /requests` | – | 200 `[{id,status,updatedAt,subtotals}]` (own only) | 401/403 |
| `GET /requests/:id` | – | 200 detail | 404 (not owner & not in-scope accounting) |
| `DELETE /requests/:id` | – | 204 | 404; **409** if status≠draft (AC-2.3/8.3) |
| `POST /requests/:id/lines` | `{date,type,motivo,requestedAmountCents,entity,km?}` | 201 line | 404; **422** validation |
| `PUT /requests/:id/lines/:lineId` | same | 200 line | 404; 409 if not draft; 422 |
| `DELETE /requests/:id/lines/:lineId` | – | 204 | 404; 409 if not draft |
| `POST /requests/:id/lines/:lineId/attachments` | `{fileName,contentType,sizeBytes}` | 201 `{attachmentId,upload:{url,fields,objectKey}}` | 404; 409 if not draft; 422 (type/size) |
| `POST …/attachments/:aid/confirm` | – | 200 attachment (uploadStatus=stored) | 404; 409 |
| `DELETE …/attachments/:aid` | – | 204 (+object delete) | 404; 409 if not draft |
| `POST /requests/:id/submit` | – | 200 request (submitted) | 404; **422** (0 lines AC-1.5 / incomplete lines AC-1.6, body lists offending line ids) |
| `POST /requests/:id/withdraw` | – | 200 request (draft) | 404; **409** if status≠submitted (AC-2.3) |
| `GET /requests/:id/lines/:lineId/attachments/:aid/url` | – | 200 `{url,expiresAt}` (presigned GET) | 404 (owner or in-scope accounting only) |

Line validation (`422`, AC-1.2/1.6): `date,type,motivo,requestedAmountCents,entity` required;
`km` required and `> 0` **iff** `type==travel_km`, rejected if present for any other type;
`requestedAmountCents >= 0` integer. Attachments never part of the required-field check (AC-1.7).

### Accounting endpoints (require `refund:access` + `request:review`/`approve`/`reject`, entity-scoped)

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /review/requests` | – | 200 queue (submitted ∧ in entity scope; AC-5.1/5.5/5.6) | **403** if no `request:review` |
| `GET /requests/:id` | – | 200 full detail incl. all lines (AC-6.5) | **404** if scope matches none of its lines (AC-6.4) |
| `PUT /review/requests/:id/lines/:lineId/approved-total` | `{approvedTotalCents}` | 200 line | 403; 404 (out of scope); **409** if status≠submitted (AC-7.4) |
| `POST /review/requests/:id/approve` | – | 200 request (approved) | 403; 404; 409 if status≠submitted |
| `POST /review/requests/:id/reject` | `{motivation}` (non-empty) | 200 request (rejected) | 403; 404; 409; **422** empty motivation (AC-7.3) |

Approve (AC-7.2): each line's `approvedTotalCents` finalized to its set value, defaulting to
`requestedAmountCents` for any line left untouched; `decidedBy*`/`decidedAt` stamped; audit
`approved`. Reject (AC-7.3): `rejectionMotivation` persisted, `decidedBy*`/`decidedAt` stamped,
approved totals left inapplicable; audit `rejected`. Both are **whole-request**, including
out-of-scope lines (AC-7.6). Every `approved_total_set` write emits an audit row (AC-8.1).

### On decision → notify the employee (AC-3.6)

In the same transaction boundary as the decision (after commit), refund-api calls
`notify-api` `POST /system/notifications` with `X-Internal-Token: <NOTIFY_INTERNAL_TOKEN>`
(shared secret, 1Password, mirrors ADR-0011):

```jsonc
{ "recipientId":"<owner sub>", "originApp":"refund", "severity":"info|success|warning",
  "title":"Rimborso approvato" | "Rimborso respinto",
  "body":"…", "link":{"href":"/refund/requests/<id>"} }
```

notify-api routes it through the existing `inAppChannel.send` (persist + SSE push). A failed
notify call is logged and does not roll back the decision (the decision is the source of truth;
the employee still sees the outcome on `GET /requests/:id` — the notification is an additive
push, notifications.repo is the DB-source-of-truth pattern from specs/005).

## Authz integration (security-critical)

### Catalog — replace the access-only stub (`auth/src/authz/catalogs/refund.ts`, NEW)

`refund` currently appears in `seed.ts`'s `SUITE_APPS` as an access-only stub. Move it out of
`SUITE_APPS` (exactly as `estimai` is excluded) and register a full catalog via a new
`seedRefundCatalog()` (one full-replace `upsertAppCatalog` per appId — never double-register):

```ts
// resource `refund`  → action `access`  (supportedConditions: [])
// resource `request` → actions:
//   create            supportedConditions: []            // employee owns what they create
//   read              supportedConditions: ["ownership"] // employee reads own (ownership:own)
//   review            supportedConditions: ["entity"]    // accounting: queue + full detail
//   set-approved-total supportedConditions: ["entity"]
//   approve           supportedConditions: ["entity"]
//   reject            supportedConditions: ["entity"]
```

Permission strings used by refund-api: `refund:access`, `request:create`, `request:read`,
`request:review`, `request:set-approved-total`, `request:approve`, `request:reject`.
Submit/withdraw/edit/delete of a *draft* are authorized by `request:create` + ownership of the
request (the creator) — not separate catalog actions, matching the spec's enumerated set.

### Role → permission mapping (seed grants)

The seed registers refund's **catalog** and the **`accounting`** role's grants only —
it does **not** grant any refund permission to the `employee` role.

- **`employee`** (default, every user): **no refund grants seeded.** Per the suite convention
  (specs/004), app access and domain permissions are admin-assigned — an employee can create,
  submit, and track their own requests only once an admin grants the `employee` role (or that
  user) `refund:access`, `request:create`, and `request:read` (`ownership:own`) via the
  existing specs/004 GUI. Enforcement is unchanged: an employee lacking the grant is denied at
  the API (403 on capability-gated routes, 404 on record routes) exactly as any other caller.
- **`accounting`** (admin-granted role): `request:review`, `request:set-approved-total`,
  `request:approve`, `request:reject`, plus `refund:access`. The seed attaches these with the
  **entity condition** `{attributes:[{key:"entity",match:"user"}]}` → each accounting user is
  scoped to **their own `user.entity`** (single-entity).

### Entity-scoped review — how it is enforced (reuses specs/004 verbatim, no new mechanism)

- The **entity condition** `{key:"entity", match:"user"}` means "the record's entity must equal
  the acting user's `entity` attribute" (specs/004). refund-api reads the caller's `entity`
  from `GET /authz/resolve` (it is deliberately **not** in the JWT — ADR-0007 token minimalism).
- A request has **no single entity** (mixed-entity per line). refund-api evaluates the condition
  at **request level with "at least one line matches"** semantics:
  - `review` grant carries the entity condition → **single-entity**: request is in scope iff
    `∃ line. line.entity == caller.entity` (AC-5.6/6.4). Queue query:
    `status=submitted AND lines.some(entity = caller.entity)`.
  - `review` grant carries **no** entity condition → **global**: every submitted request
    (AC-5.5). Queue query: `status=submitted`.
- **"Both / global"** is realized via the resolver's existing **widest-wins union**
  (`dedupeWidest`: "an unconditional grant ∪ a conditional one = unconditional"). A user who
  holds the `accounting` (entity-conditioned) role *and* an additional unconditioned `review`
  grant resolves to an **unconditional** `review` → global. So single-entity = `accounting` role
  + `user.entity` set; global = additionally an unconditioned review grant. **Decided:** the plan
  ships only the entity-scoped `accounting` role — **no `accounting-global` role is seeded**;
  "global" review is composed by an admin adding an unconditioned `review` grant through the
  existing specs/004 GUI, with the widest-wins union promoting the caller to global.
- Decisions are **whole-request** even for lines outside the deciding user's scope (AC-6.5/7.6):
  once a request is in scope (≥1 matching line), refund-api never filters lines and applies the
  decision to all of them.

### `auth` `GET /authz/resolve` (NEW, Bearer-authed resource-server seam)

Sibling of `GET /authz/me`, but authenticated by the **Bearer JWT** (auth verifies its own
RS256 token — same issuer, its own public key — pinned `alg:RS256`, `iss`, `aud`), because a
resource server has no better-auth session cookie. Returns the **caller's own** resolution only
(never an arbitrary user's — same guard as `/authz/me`):

```jsonc
{ "sub":"…","epoch":7,
  "permissions":[ {"resource":"request","action":"review","conditions":{"attributes":[{"key":"entity","match":"user"}]}}, … ],
  "entity":"welld_it", "jobTitle":null }
```

The added `entity`/`jobTitle` (the caller's own attribute values) are what let a resource server
*evaluate* `match:"user"` conditions locally. This is the one deliberate widening beyond
`/authz/me` and is safe (caller's own attributes, over an authenticated channel; still no
sensitive data in the JWT). ADR candidate.

## Object storage

- **Choice:** EU-region S3-compatible object storage. Primary candidate **AWS S3 `eu-south-1`
  (Milan)** (best data-residency fit for IT/CH) or **Scaleway Object Storage `fr-par`**;
  **Cloudflare R2 with EU jurisdiction restriction** is the fallback (fits the suite's
  Vercel/edge posture). All satisfy CLAUDE.md's EU-region hard constraint. Selected via
  ADR (candidate). Configured through S3-compatible env: `REFUND_S3_ENDPOINT`,
  `REFUND_S3_REGION`, `REFUND_S3_BUCKET`, `REFUND_S3_ACCESS_KEY_ID`,
  `REFUND_S3_SECRET_ACCESS_KEY` (1Password refs; validated in `src/lib/env.ts`,
  `process.exit(1)` on missing).
- **Upload — presigned direct-to-bucket (not proxied).** Decision: refund-api mints a
  **presigned POST** (policy-constrained), the browser uploads **directly** to the EU bucket,
  refund-api only persists metadata + object key. Justification: keeps large receipt bytes out
  of refund-api's memory/bandwidth; the presigned **POST policy** enforces
  `content-length-range` (≤ **10 MiB**) and an allowed `content-type` set
  (`application/pdf`, `image/jpeg`, `image/png`) **server-side at mint time** — the browser
  cannot exceed them. Data residency is preserved because the browser talks to the **EU**
  bucket directly. Two-phase (`pending` → `confirm`) plus a periodic reconcile of orphaned
  `pending` rows (no upload followed) — **no cron** for lifecycle *state* (consistent with
  ADR-0013's derived-state posture); orphans are reconciled on read/next-write and are
  invisible (only `stored` attachments are returned).
- **Key namespacing:** `refund/{requestId}/{lineId}/{attachmentId}/{sanitizedFileName}` —
  request/line-scoped, non-guessable ids, no user PII in the key.
- **Download — signed GET, authz-gated.** `GET …/attachments/:aid/url` mints a short-lived
  (~60 s) presigned GET **only after** the ownership/entity-scope check passes; the bucket is
  otherwise private (no public read). AC-6.2 (accounting view/download) and AC-1.3/employee
  view flow through this single gated minting point.
- **Limits:** ≤ 10 MiB/file, allowed types above; enforced in the presigned POST policy and
  re-validated on `confirm` (HEAD the object: size/content-type match the recorded metadata,
  else reject). Attachment metadata request bodies capped by a small `bodyLimit` (mirrors
  estimai-api).

## Test strategy

Levels: **unit** (pure logic — validation, subtotal grouping, status-transition guards,
money, condition evaluation, queue-scope predicate), **integration** (refund-api routes vs a
test PostgreSQL, with `GET /authz/resolve`, object storage, and `POST /system/notifications`
mocked; adversarial for every scoping/ownership path), **e2e** (refund-ui in the shell via
Playwright, seeded session, headline journeys). Because refund permissions are **admin-assigned** (no default-on employee grants), every employee-path test **provisions the `employee` refund grants** (`refund:access`, `request:create`, `request:read` ownership:own) in setup, and every accounting-path test provisions the `accounting` role (entity-conditioned, or unconditioned for the global cases). The AC→test map is **total** (all 41 ACs):

| AC | Level | What proves it |
|---|---|---|
| 1.1 new request is draft, private, not queued | integration | `POST /requests` → status=draft; absent from another user's `GET /requests` and from queue |
| 1.2 line fields; km req & >0 only for travel_km | unit + integration | line validator: km required/>0 iff travel_km, rejected otherwise; amount employee-set |
| 1.3 attach to a specific line; removable pre-submit | integration | mint→confirm attaches to lineId; DELETE attachment on draft succeeds |
| 1.4 edit/delete line or request; no accounting involvement | integration | draft edit/delete succeed owner-only; no state leaves owner |
| 1.5 submit 0-line request refused | unit + integration | `POST /submit` on 0 lines → 422 clear message |
| 1.6 submit with incomplete line refused, lines identified | integration | 422 body lists offending line ids |
| 1.7 submit with no attachments proceeds | integration | submit succeeds with attachment-less lines |
| 2.1 submit → submitted, read-only, in queue | integration | transition; subsequent line edit → 409; appears in in-scope queue |
| 2.2 withdraw submitted → draft, leaves queue | integration | `POST /withdraw` → draft, editable; gone from queue |
| 2.3 decided is terminal/immutable | integration | edit/delete/withdraw on approved|rejected → 409 |
| 2.4 rejected re-claim = new request | integration | rejected has no edit path; new `POST /requests` unaffected |
| 2.5 non-owner non-accounting denied all ops | integration | other user view/edit/submit/withdraw → 404 |
| 3.1 list own only, status + updated | integration | list scoped to sub; foreign requests absent |
| 3.2 approved shows requested vs approved per line | integration | detail exposes both amounts per line |
| 3.3 rejected shows motivation | integration | detail exposes rejectionMotivation |
| 3.4 submitted reads as pending | unit + e2e | status distinct; UI badge not approved/rejected |
| 3.5 mixed-entity per-currency subtotals (employee) | unit + integration | subtotal grouping EUR/CHF, never blended |
| 3.6 decision pushes notification to employee | integration | approve/reject → `POST /system/notifications` called with owner sub + originApp refund |
| 4.1 approved shows monthly-processing note | e2e | approved detail renders the note; no date/amount |
| 4.2 no payroll messaging on draft/submitted | e2e | note absent pre-decision |
| 5.1 queue = submitted ∧ in scope, with summary | integration | queue lists submitted-in-scope with employee/date |
| 5.2 draft/withdrawn/approved/rejected excluded | integration | only submitted-in-scope present |
| 5.3 withdrawn no longer in queue | integration | submit→withdraw→queue empty |
| 5.4 non-accounting denied queue/API | integration | no `request:review` → `GET /review/requests` 403 |
| 5.5 global sees all submitted | integration | unconditioned review → every submitted request |
| 5.6 single-entity: other-entity-only request absent | integration | scope welld_it, request all welld_ch → absent |
| 6.1 full line detail + employee identity | integration | detail fields present for accounting |
| 6.2 view/download attachments | integration | signed GET minted for in-scope accounting |
| 6.3 decided requests inspectable read-only | integration | approved/rejected detail readable, no mutation |
| 6.4 out-of-scope deep link denied | integration | scope matches no line → `GET /requests/:id` 404 |
| 6.5 in-scope sees ALL lines incl. out-of-scope | integration | ≥1 matching line → all lines returned, unfiltered |
| 6.6 per-currency subtotals (accounting) | unit + integration | same subtotal grouping on review detail |
| 7.1 editable approved-total per line, default=requested | integration | PUT approved-total; default applied on approve |
| 7.2 approve → approved, totals recorded, approver+ts | integration | transition + decidedBy/decidedAt + line totals |
| 7.3 reject requires non-empty motivation | unit + integration | empty → 422; valid → rejected + motivation + approver+ts |
| 7.4 decided decision/totals/motivation immutable | integration | any change on decided → 409 |
| 7.5 non-accounting cannot set total/decide | integration | no perm → PUT/approve/reject 403 |
| 7.6 decision whole-request incl. out-of-scope lines | integration | in-scope user decides mixed-entity request wholly |
| 8.1 audit on submit/decide/approved-total | integration | audit rows for each transition + each total-set, w/ actor/ts/detail |
| 8.2 audit immutable to any user incl. admin | integration | DB trigger blocks UPDATE/DELETE; no route exists |
| 8.3 decided request not deletable | integration | DELETE on approved/rejected → 409; onDelete Restrict |

**Headline e2e journeys (Playwright, shell + refund-ui):** employee composes mixed-entity
request → submits → accounting (scoped) reviews, adjusts a total, approves → employee sees
requested-vs-approved + notification + monthly note; and a reject-with-motivation path.

**Adversarial security coverage (feeds the owasp pass):** ownership-404 on every
`/requests/:id` subroute for a foreign user; entity-scope 404 for out-of-scope accounting deep
links (AC-6.4) incl. the mixed-entity boundary (AC-5.6); capability-403 on `/review/*`;
attachment signed-URL minting only after authz (no IDOR on `objectKey`); presigned-POST policy
rejects oversize/wrong-type; audit-immutability trigger under direct SQL; `GET /authz/resolve`
returns only the caller's own resolution.

## Risks

| # | Risk | Mitigation / early check |
|---|---|---|
| R1 | **Two new cross-service seams** (`/authz/resolve`, `/system/notifications`) expand the trust surface and could ship late. | Spike both first (T-early): a thin Bearer-authed resolve endpoint + an internal-token notify endpoint, contract-tested, before refund-api domain work. Both are ADR candidates → decided at Gate 2. |
| R2 | **Entity-scope "global"** modeled via widest-wins union may confuse admins (no explicit "global" toggle). | Document precisely in the admin-facing catalog copy; integration tests cover both single-entity and global; "global" is admin-composed (an unconditioned `review` grant), not a seeded role. |
| R3 | **Per-request auth round-trip** to `/authz/resolve` adds latency/coupling. | `(sub, perm_epoch)` cache + 30 s TTL; auth outage → fail-closed (deny) with 503, never fail-open. Measure; epoch-keyed cache keeps steady-state at zero extra hops after first call. |
| R4 | **Presigned direct upload** leaves orphaned `pending` rows / objects. | Two-phase confirm + reconcile-on-read (only `stored` surfaced); bucket lifecycle rule expires unconfirmed objects; no cron for state (ADR-0013 posture). |
| R5 | **Notification best-effort** — a dropped `/system/notifications` call loses the push. | Decision is the DB source of truth; employee always sees outcome on read (AC-3.2/3.3). Log + optional retry; never block/rollback the decision. |
| R6 | **`withdrawn`** modeled as a transition, not a persisted status — a stray assumption of a 5th state could cause queue/list bugs. | **Decided:** statuses are `draft\|submitted\|approved\|rejected`; withdraw is `submitted→draft` + a `withdrawn` audit event (per AC-2.2). Enforce via the status enum + transition tests; no persisted `withdrawn` value exists to leak into queries. |
| R7 | **Money as cents** mis-formatting in UI (off-by-100). | Single shared cents↔display formatter, unit-tested per currency; API contract fixes cents on the wire. |
| R8 | **Object-storage region drift** (a bucket accidentally provisioned outside EU) violates data residency. | Region pinned in env + ADR; deploy check asserts `REFUND_S3_REGION` ∈ EU allowlist at startup (`env.ts`). |

## Security

**Security-sensitive? YES.** This feature handles **financial data** (reimbursement amounts
that reach an employee's paycheck), **PII inside uploaded receipts** (names, addresses, card
tails), **file upload**, **cross-user authorization** (employee ownership + entity-scoped
accounting review), and an **immutable financial audit trail** — every trigger in the plan's
security rubric fires, and the data is **regulated-sector-adjacent** (wellD serves finance/
healthcare/energy clients; reimbursement ties to payroll). The orchestrator should schedule an
`owasp-reviewer` pass in parallel with QE, at the **frontier tier** given the financial/PII
weight.

**Surfaces to review (named):**
- `GET /requests/:id` and every `/requests/:id/*` subroute — ownership-404 (ADR-0005) and the
  entity-scope 404 boundary (AC-6.4/6.5); IDOR on request/line/attachment ids.
- `GET /review/*` — capability-403 and entity-scope evaluation (the ABAC application);
  the "at least one line matches" predicate and its mixed-entity edge (AC-5.6).
- Attachment upload (presigned POST policy: size/content-type/path traversal in `fileName`)
  and download (signed-GET minting gated by authz; private bucket; no `objectKey` IDOR).
- `auth` `GET /authz/resolve` — Bearer verification (RS256/iss/aud pinning), caller-own-only
  scope, no attribute leak beyond the caller's own.
- `notify-api` `POST /system/notifications` — internal-token (constant-time, ≥32 chars),
  route-exclusive (never accepts a user JWT and `/notifications` never accepts the token —
  ADR-0011 invariant), recipient taken from the trusted internal body only from `auth`/
  refund-api, HTML/template escaping (bilingual, fixed templates).
- Audit immutability (DB trigger) and decided-request retention (`onDelete: Restrict`).

## ADR candidates

1. **refund-api as the suite's first authorization-enforcing resource server** — server-side
   role + condition enforcement via a new Bearer-authed `auth` `GET /authz/resolve` endpoint +
   `(sub, perm_epoch)` cache + **local condition evaluation** in the consuming app. Realizes
   ADR-0007's explicitly-deferred resource-server side; extends ADR-0005/0010.
2. **Entity-scoped ABAC application in refund-api** — request-level "at least one line's entity
   matches the caller's `user.entity`" evaluation of specs/004's entity attribute condition;
   "global" via the resolver's widest-wins unconditioned grant; decisions remain whole-request.
3. **EU-region S3-compatible object storage for financial-document attachments** — the concrete
   provider/region choice, presigned direct-to-bucket upload (policy-enforced size/type),
   private bucket + short-lived authz-gated signed GET, key namespacing, two-phase confirm.
4. **Server-to-server in-app notification trigger** — new internal `POST /system/notifications`
   on notify-api (internal-token, mirrors ADR-0011), enabling cross-user in-app push; realizes
   ADR-0009's reserved cross-user `recipient` seam (the user-JWT `POST /notifications` stays
   self-only, OWASP A01).
5. **Immutable financial audit trail** (optional/combinable with #1) — append-only table +
   DB-level UPDATE/DELETE block + `onDelete: Restrict` retention for decided requests (US-8);
   the pattern for future financial/governance records in the suite.

## Note

`status: draft` — only the human user approves this plan. No ADRs are written here (ADR
candidates above are for the `adr-writer` agent after Gate 2). No source outside this file is
modified.
