---
spec: 015
status: approved
approved: 2026-10-06
amended: 2026-10-06
---

# Plan: Hardware inventory and depreciation register

## Architecture

Two new deployables and changes to four existing ones. Names used throughout: app id
`inventory`, tool route `/inventory`, devices view `/devices`, backend `inventory-api`
(port 8083), remote `inventory-ui` (port 5178).

### New: `inventory-api` (Bun + Hono + Prisma, own logical DB `inventory`)

A JWKS resource server (ADR-0005/0010) that is also authorization-enforcing, built as a
sibling of `refund-api` and copying its seams rather than sharing code (the repo has no
workspace, ADR-0003):

- `src/auth/jwt.middleware.ts`, `src/auth/authz.middleware.ts`, `src/authz/resolveClient.ts`,
  `src/authz/conditions.ts` — copied from `refund-api/src/auth/*` and `refund-api/src/authz/*`.
  Permissions are resolved live from `auth GET /authz/resolve`, cached by `(sub, perm_epoch)`
  for 30 s, and an `auth` outage fails closed with 503 (ADR-0014).
- Feature directories: `assets/`, `assignments/`, `me/`, `depreciation/` (pure schedule
  maths + rules), `fiscal-years/`, `invoices/`, `history/`, `health/`, `openapi/`, `lib/`.
- `src/lib/storage.ts` + `src/lib/s3Residency.ts` — copied from `refund-api/src/lib/`;
  invoice files use the two-phase presigned upload and the EU allowlist check (ADR-0016).
  Own bucket configuration (`INVENTORY_S3_*`), never refund's credentials.
- `src/lib/identities.ts` — holder and actor display names resolved live from
  `auth POST /authz/users/identities`, failing soft to `status:"unknown"` (ADR-0039).
- `src/lib/notify.ts` — best-effort, after-commit, never-throws push to
  `notify-api POST /system/notifications`, authenticated with a **scoped service JWT**
  (see "Service authentication" below), not `NOTIFY_INTERNAL_TOKEN`.
- `scripts/import-legacy.ts` — the one-off loader for US-12 (not a route).

**Denial taxonomy** (ADR-0014): capability absent → 403; record outside the caller's
entity scope, or not the caller's own on `/me/*` → 404.

### New: `inventory-ui` (Vite + React federated remote)

Same stack and layout as `refund-ui` (`src/pages`, `src/components`, `src/lib/*Api.ts`,
`src/strings.ts` with a `noHardcodedStrings` test, `src/version.ts`). It exposes three
modules: `./App` (the gated tool), `./MyDevices` (the ungated devices view) and
`./version` (ADR-0030). The XLSX export of AC-8.8/8.9 is built in the browser with
`exceljs` from the fiscal-year JSON (the pattern `estimai-ui` already uses); the server
returns data, never a file. Copy is English only at launch, all of it through
`src/strings.ts`; server-composed notification text is English too (as `refund-api`'s is).

### The devices view is a second, ungated entry of the same remote — ADR candidate R2

US-4 must be reachable by users with no `inventory:access` grant, and
`createToolAccessBeforeLoad('inventory')` on `/inventory/$` would redirect them to
`/no-access`. The shell therefore gains a second route, `/devices`, child of `shellRoute`
with **no** `beforeLoad` guard and absent from `TOOLS`, which mounts `inventory/MyDevices`
through `RemoteMount` — the `/notify` shape (ADR-0009) applied to a remote that also has
a gated entry. `UserMenu` gets a "My devices" link next to "My profile". Server-side the
view is backed by `/me/*` routes that require only a valid JWT, skip `authzMiddleware`
entirely, and scope every query to the verified `sub` (the ADR-0042 posture).

Rejected: a shell-native screen like `AccountScreen` (puts confirm/decline business logic
in the shell, against ADR-0009's rule); granting every user `inventory:access` (breaks
AC-9.6 — the tool would appear in everyone's sidebar).

### Authorization model (`auth`)

New catalog `auth/src/authz/catalogs/inventory.ts`, registered by `seed.ts` like
`REFUND_CATALOG`:

| Resource | Action | supportedConditions | Meaning |
|---|---|---|---|
| `inventory` | `access` | `[]` | tool appears in the sidebar |
| `asset` | `manage` | `["entity"]` | **inventory manager** (US-1/2/3, invoice fields) |
| `ledger` | `manage` | `["entity"]` | **hardware accountant** (US-5/6/7/8) |

Entity scope reuses ADR-0015's condition `{key:"entity", match:"user"}` and
`entityScopeForPermission`: a conditioned grant scopes the holder to their own
`user.entity`, an unconditioned grant covers both entities, and the resolver's
widest-wins union applies (ADR-0007). Unlike refund, scope is evaluated per **asset**
(`asset.entity`), which is exact — an asset has one entity for life (AC-1.9).

Seeded grants: `admin` → all three, unconditioned; `accounting` → `inventory:access` +
`ledger:manage` entity-conditioned; a new system role `inventory-manager` →
`inventory:access` + `asset:manage` entity-conditioned.

Read access to an asset is granted by holding **either** `asset:manage` or
`ledger:manage` with scope over its entity. Which fields come back depends on which
(see API contracts).

### User directory for the assign picker — ADR candidate R4

An inventory manager must choose a holder among Operai users, and `auth` has no such read
outside `requireAdmin` (`/admin/users`); `POST /authz/users/identities` is id-keyed by
design (ADR-0039). `auth` gains `GET /authz/users/directory`, on the forwarded-caller-JWT
model, returning active users `{id, name, email, entity}` and gated on the caller holding
`asset:manage` (any scope). Rate-limited with the existing `lib/rateLimiter.ts`.
`inventory-ui` calls it directly through `shell/session`'s `apiFetch`.

Rejected: an exact-email decision endpoint in ADR-0035's style (a manager assigning a
laptop knows a colleague's name, not necessarily their address, and the holder filter of
AC-3.7 needs a list); reusing `/admin/users` (would require making inventory managers
suite admins).

### Service authentication for the notification push — ADR candidate R1

`inventory-api` would be the fourth holder of `NOTIFY_INTERNAL_TOKEN`; ADR-0040's hard
stop requires scoped service JWTs instead. Decision taken at the plan interview: build it
here for the new caller only.

- `auth` gains `POST /system/service-token` (client-credentials): the caller presents
  `clientId` + `clientSecret`; `auth` verifies the secret against a per-client entry in a
  new `SERVICE_CLIENTS` env map and returns a 5-minute RS256 JWT signed with the existing
  keypair: `sub="system:inventory-api"`, `aud=SERVICE_AUDIENCE` (a new value, distinct
  from `AUTH_AUDIENCE`, so a service token is never accepted on a user route and vice
  versa), `scope="notifications.push"`.
- `notify-api`'s `/system/notifications` accepts **either** the legacy `X-Internal-Token`
  **or** `Authorization: Bearer <service JWT>` verified through the existing JWKS with
  `audience: SERVICE_AUDIENCE` and a `scope` check. `/system/emails` is unchanged (the
  new scope does not grant it). `ORIGIN_APPS` gains `"inventory"`.
- `inventory-api` caches the token in memory until 60 s before expiry.
- `auth`, `refund-api` and `estimai-api` keep the shared token; migrating them is a
  named follow-up, not part of this feature.

Rejected: becoming the fourth shared-token holder (forbidden by ADR-0040); forwarding the
acting user's JWT to `notify-api` (the confirm/decline push is triggered by an employee
with no capability, so there is nothing to authorize it against); a keypair per service
with `notify-api` trusting several JWKS (ADR-0040 names the existing JWKS).

### Schedules are derived on read; only closed years are stored — ADR candidate R3

An asset stores its price, purchase date and entity. Its depreciation rule is the latest
rule for its entity with `effectiveFrom <= purchaseDate` (ties broken by `createdAt`),
resolved on read like `resolveEffectiveRate` (ADR-0013/0023), and its schedule is a pure
function of those inputs. Nothing about an open year is persisted, so AC-5.9 and AC-6.2
need no recomputation job. Closing a fiscal year writes one immutable
`asset_year_figure` row per asset plus one `fiscal_year` row; closed-year reads come
only from those rows (AC-8.6). Imported assets carry their sheet figures as the same
rows with `source='imported'`, and the latest one is the anchor their remaining schedule
is spread from (AC-12.5).

Rejected: persisting each asset's whole schedule at registration (every rule or price
change becomes a rewrite, and AC-6.2 a migration); computing everything live with no
snapshot (a later bug fix or rule would silently change reported years).

### Other decisions (notes, not ADRs)

- **Closed-year guard.** `isClosed(entity, year) = year <= max(fiscal_year.year)` for the
  entity. Every dated write (register, edit price/date, dispose, create rule) and the
  close itself take `pg_advisory_xact_lock` on the entity in the same transaction, so a
  backdated write cannot race a close.
- **State transitions are compare-and-set** on `asset.status` / `assignment.status`
  (ADR-0020's CAS idiom); a lost race is 409. Plain field edits are last-write-wins.
- **History is Tier 1** (ADR-0033): `asset_event`, `depreciation_rule`, `fiscal_year` and
  `asset_year_figure` each get the raising `BEFORE UPDATE/DELETE` trigger of ADR-0018/0024.
- **One rounding function**, `roundHalfUp`, with a shared `schedule-vectors.json` consumed
  by `inventory-api` tests and by `inventory-ui` (which only displays) — ADR-0025's rule.

### Changes to existing apps

| App | Change |
|---|---|
| `auth` | `catalogs/inventory.ts` + seed; `GET /authz/users/directory`; `POST /system/service-token`; env `SERVICE_CLIENTS`, `SERVICE_AUDIENCE` |
| `notify-api` | `/system/notifications` accepts a scoped service JWT; `ORIGIN_APPS += "inventory"`; env `SERVICE_AUDIENCE` |
| `notify-ui`, `shell` | the `NotificationOriginApp` mirrors (`notify-ui/src/lib/severity.ts`, `shell/src/lib/notifications.ts`) gain `"inventory"` (found at task derivation) |
| `shell` | `TOOLS`/`ToolId` += `inventory`; routes `/inventory/$` (guarded) and `/devices` (unguarded); `runtimeRemotes.ts` + `vite.config.ts` remote; `session.ts` `getInventoryApiBaseUrl()`; `UserMenu` link; CSP `connect-src`/`script-src` in `vercel.json`; e2e helper `inventoryFixtures.ts` |
| repo | `compose.yaml` (DB `inventory`), `mise.toml` (dev/db tasks), `lerna.json` (+2 packages), `tools/env-doctor/manifest.ts`, `CLAUDE.md` tables, one changeset selecting `auth`, `notify-api`, `notify-ui`, `shell`, `inventory-api`, `inventory-ui` |

## Data model

New Prisma schema `inventory-api/prisma/schema.prisma`, one initial migration. Money is
`Int` cents throughout; dates are `@db.Date`.

```prisma
enum Entity          { welld_it welld_ch }
enum Currency        { EUR CHF }
enum AssetCategory   { laptop desktop phone tablet monitor peripheral other }   // spec O6
enum AssetStatus     { ordered in_stock assigned in_repair lost disposed }
enum AssignmentStatus{ pending confirmed declined cancelled }
enum DisposalReason  { ceded_to_employee sold scrapped returned_to_vendor lost }
enum FirstYearShare  { full half }
enum FigureSource    { closed imported }
enum UploadStatus    { pending stored }
enum AssetEventAction{ registered received edited assignment_created assignment_confirmed
                       assignment_declined assignment_cancelled returned repair_started
                       repair_finished marked_lost marked_found disposed
                       invoice_file_linked verified fiscal_year_closed imported }

model Asset {
  id                 String   @id @default(cuid())
  entity             Entity
  currency           Currency          // CHECK: welld_ch→CHF, welld_it→EUR (AC-1.2)
  category           AssetCategory
  description        String
  serialNumber       String?
  purchaseDate       DateTime @db.Date
  purchasePriceCents Int               // CHECK > 0
  status             AssetStatus
  holderUserId       String?           // auth user id, not a FK
  locationNote       String?
  supplier           String?
  invoiceRef         String?
  invoiceFileId      String?
  invoiceFile        InvoiceFile? @relation(fields: [invoiceFileId], references: [id])
  toVerify           Boolean  @default(false)
  legacyImported     Boolean  @default(false)   // schedule anchors on latest imported figure
  disposedOn         DateTime? @db.Date
  disposalReason     DisposalReason?
  salePriceCents     Int?
  createdByUserId    String
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  @@index([entity, status])
  @@index([holderUserId])
  @@index([entity, invoiceRef])
  @@index([entity, purchaseDate])
  @@map("asset")
}

model Assignment {
  id               String   @id @default(cuid())
  assetId          String
  assigneeUserId   String
  status           AssignmentStatus @default(pending)
  createdByUserId  String
  createdAt        DateTime @default(now())
  resolvedAt       DateTime?
  resolvedByUserId String?
  @@index([assigneeUserId, status])
  @@index([assetId, createdAt])
  @@map("assignment")
}

model DepreciationRule {                 // append-only (trigger)
  id                     String   @id @default(cuid())
  entity                 Entity
  effectiveFrom          DateTime @db.Date
  usefulLifeYears        Int               // CHECK >= 1
  firstYearShare         FirstYearShare
  lowValueThresholdCents Int?              // CHECK >= 0
  residualCents          Int               // CHECK >= 0
  createdByUserId        String
  createdByEmail         String
  createdAt              DateTime @default(now())
  @@index([entity, effectiveFrom, createdAt])
  @@map("depreciation_rule")
}

model FiscalYear {                       // row exists ⇔ closed; append-only (trigger)
  id                String   @id @default(cuid())
  entity            Entity
  year              Int
  openingCents      Int
  disposalsCents    Int
  purchasesCents    Int
  depreciationCents Int
  closingCents      Int
  source            FigureSource
  closedByUserId    String
  closedAt          DateTime @default(now())
  @@unique([entity, year])
  @@map("fiscal_year")
}

model AssetYearFigure {                  // append-only (trigger)
  id                String   @id @default(cuid())
  assetId           String
  entity            Entity
  year              Int
  openingCents      Int
  purchaseCents     Int
  depreciationCents Int
  disposalCents     Int
  closingCents      Int
  source            FigureSource
  @@unique([assetId, year])
  @@index([entity, year])
  @@map("asset_year_figure")
}

model InvoiceFile {
  id              String   @id @default(cuid())
  entity          Entity
  invoiceRef      String
  objectKey       String   @unique       // inventory/{entity}/{id}/{safeName}
  fileName        String
  contentType     String
  sizeBytes       Int
  uploadStatus    UploadStatus @default(pending)
  createdByUserId String
  createdAt       DateTime @default(now())
  assets          Asset[]
  @@index([entity, invoiceRef])
  @@map("invoice_file")
}

model AssetEvent {                       // append-only (trigger); AC-11.1/11.2
  id          String   @id @default(cuid())
  assetId     String?                    // null only for fiscal_year_closed
  entity      Entity
  action      AssetEventAction
  actorUserId String                     // "system:legacy-import" for the import
  actorEmail  String
  oldValue    Json?
  newValue    Json?
  createdAt   DateTime @default(now())
  @@index([assetId, createdAt])
  @@index([entity, createdAt])
  @@map("asset_event")
}
```

Raw SQL in the same migration (Prisma cannot express these):

- `CREATE UNIQUE INDEX asset_serial_live ON asset (entity, "serialNumber") WHERE "serialNumber" IS NOT NULL AND status <> 'disposed'` (AC-1.5).
- `CREATE UNIQUE INDEX assignment_one_pending ON assignment ("assetId") WHERE status = 'pending'` (AC-2.2).
- The four `CHECK` constraints noted above.
- `*_immutable()` function + `BEFORE UPDATE` / `BEFORE DELETE` triggers on
  `depreciation_rule`, `fiscal_year`, `asset_year_figure`, `asset_event`, copied from
  `refund-api/prisma/migrations/20260720170000_mileage_rate/migration.sql`.
- Seed rows for AC-6.6: `welld_ch` (life 3, `full`, threshold null, residual 100) and
  `welld_it` (life 5, `half`, threshold 51646, residual 0), both `effectiveFrom
  2000-01-01`, actor `system:launch-seed`.

No migration touches `auth` or `notify-api` schemas; `auth`'s changes are catalog seed
data and two routes.

### Schedule function (the contract for `depreciation/schedule.ts`)

```
schedule(priceCents, purchaseYear, rule, anchor?) → [{year, depreciationCents, closingCents}]

D = priceCents − rule.residualCents            (D ≤ 0 → empty schedule)
no anchor:
  threshold set and priceCents ≤ threshold → single entry {purchaseYear, D, residual}
  n    = usefulLifeYears + (firstYearShare = half ? 1 : 0)
  full = roundHalfUp(D / usefulLifeYears)
  y1   = firstYearShare = half ? roundHalfUp(D / (2 × usefulLifeYears)) : full
  years 2..n−1 = full, each capped at what remains; year n = D − Σ(previous)
anchor {year A, bookValueCents V}  (legacyImported assets only):
  k = n − (A − purchaseYear + 1); k ≤ 0 or V ≤ residual → empty
  each of the k years = roundHalfUp((V − residual) / k); the last = remainder
disposal in year Y: entries from Y on are dropped; Y's figure is
  {depreciation 0, disposal = opening(Y) or priceCents if purchased in Y, closing 0}
```

Vectors that must pass (from the spec): 99815 / CH → 33238, 33238, 33239; 100000 / IT →
10000, 20000 ×4, 10000; 51646 / IT → 51646 in year 1; 51647 / IT → multi-year; anchor
V=53255, k=2 → 26578, 26577.

## API contracts

> Amended 2026-10-06 after the design stage (design.md gaps G1–G7, G9, G10), with the
> user's agreement: `GET /scope`, typed history changes, per-asset opening/purchase
> figures, `rule.effectiveFrom`, list order and search, invoice-file link rules,
> `serial_conflict` detail, the `system` identity status, and a lighter list payload.

`inventory-api`, base `http://localhost:8083`. Every route requires `Authorization:
Bearer <JWT>`. Errors are RFC 7807 Problem JSON with a `code` where listed. Money is
integer cents; dates are ISO 8601 (`YYYY-MM-DD` for calendar dates).

### Shared shapes

```ts
type Entity = "welld_ch" | "welld_it"
type Identity = { id: string; name: string | null
                  status: "active" | "deleted" | "unknown" | "system" }
// "system": actor ids starting with "system:" (launch seed, legacy import); never sent to auth

type AssetView = {                       // returned to asset:manage OR ledger:manage
  id: string; entity: Entity; currency: "CHF" | "EUR"
  category: AssetCategory; description: string; serialNumber: string | null
  purchaseDate: string; purchasePriceCents: number
  status: AssetStatus; holder: Identity | null
  pendingAssignment: { id: string; assignee: Identity; createdAt: string } | null
  locationNote: string | null; supplier: string | null; invoiceRef: string | null
  invoiceFile: { id: string; fileName: string } | null
  toVerify: boolean
  disposal: { disposedOn: string; reason: DisposalReason; salePriceCents: number | null } | null
  ledger?: Ledger                        // present ONLY when caller holds ledger:manage;
                                         // on GET /assets list items it is { bookValueCents } only
}
type Ledger = {
  bookValueCents: number                 // as of today
  rule: { id: string; effectiveFrom: string; usefulLifeYears: number
          firstYearShare: "full" | "half"
          lowValueThresholdCents: number | null; residualCents: number }
  schedule: { year: number; depreciationCents: number; closingCents: number
              closed: boolean }[]
}
type MyDevice = { assetId: string; description: string; category: AssetCategory
                  serialNumber: string | null; assignedAt: string }
type MyPending = MyDevice & { assignmentId: string }
```

`MyDevice` has no price or ledger key at all (AC-4.2).

### `/me/*` — JWT only, no catalog permission, always scoped to `sub`

| Route | Success | Errors |
|---|---|---|
| `GET /me/devices` | 200 `{ devices: MyDevice[], pending: MyPending[] }` | — |
| `POST /me/assignments/{id}/confirm` | 200 `{ device: MyDevice }` | 404 not addressed to caller or unknown; 409 `assignment_not_pending` |
| `POST /me/assignments/{id}/decline` | 204 | same as confirm |

### Scope — through `authzMiddleware`, no capability required

| Route | Success | Errors |
|---|---|---|
| `GET /scope` | 200 `{ asset: Entity[], ledger: Entity[] }` — the entities each capability covers for the caller; both empty when the caller holds neither, or holds an entity-conditioned grant with no `user.entity` | 503 `auth` unavailable |

Not under `/me/*`: it needs the resolved permissions, and `/me/*` deliberately skips
that (ADR-0045).

### Assets — `asset:manage` unless stated

| Route | Body | Success | Errors |
|---|---|---|---|
| `GET /assets?entity&status&category&holderUserId&toVerify&invoiceRef&q&cursor&limit` | — | 200 `{ items: AssetView[], nextCursor: string \| null }` (either capability), ordered by `purchaseDate` descending then `id`; `q` is a case-insensitive substring match on `description` or `serialNumber` (AC-3.8) | 403 neither capability |
| `GET /assets/{id}` | — | 200 `AssetView` (either capability) | 404 unknown or out of scope |
| `GET /suppliers` | — | 200 `{ suppliers: string[] }` (either capability) — the distinct supplier names on assets in the caller's entity scope, alphabetical, case and spacing variants folded into the most used spelling; no parameter, the client filters (AC-10.8, ADR-0041 posture) | 403 neither capability |
| `POST /assets` | `{ entity, category, description, purchaseDate, totalPriceCents, quantity?: number (1–200, default 1), serialNumbers?: string[], received?: boolean (default true), supplier?, invoiceRef?, locationNote? }` | 201 `{ assets: AssetView[] }` | 422 validation; 403 entity out of scope; 422 `serial_count_mismatch` (`serialNumbers` must be omitted/empty or exactly `quantity` long, applied in order); 409 `serial_conflict` `{serialNumber, assetId}`; 409 `fiscal_year_closed` `{year}` |
| `PATCH /assets/{id}` | any of `{ category, description, serialNumber, locationNote, supplier, invoiceRef, toVerify, purchaseDate, purchasePriceCents }` | 200 `AssetView` | 409 `asset_disposed`; 409 `fiscal_year_closed` (price/date when any year ≥ purchase year is closed, old or new date); 409 `serial_conflict`; 422 unknown or immutable field (`entity`, `currency`) |
| `POST /assets/{id}/receive` | — | 200 `AssetView` | 409 `invalid_transition` `{from}` |
| `POST /assets/{id}/return` | — | 200 | 409 `invalid_transition` |
| `POST /assets/{id}/repair` · `/repair-done` · `/lost` · `/found` | — | 200 | 409 `invalid_transition`; 409 `assignment_pending` (`/lost`, `/repair`) |
| `POST /assets/{id}/assignments` | `{ assigneeUserId }` | 201 `AssetView` | 409 `invalid_transition` (not `in_stock`); 409 `assignment_pending`; 422 `unknown_user` (identity not `active`) |
| `POST /assignments/{id}/cancel` | — | 200 `AssetView` | 404; 409 `assignment_not_pending` |
| `GET /assets/{id}/history` | — | 200 `{ events: { id, action, actor: Identity, at, changes: { field: string, from: string \| number \| boolean \| null, to: string \| number \| boolean \| null }[] }[] }` (either capability; user ids in `from`/`to` of the `holder` field are returned as `Identity`) | 404 |

`PATCH` of `purchaseDate` / `purchasePriceCents` is allowed to `asset:manage`. An
accountant-only caller gets 403 on every route in this table except the three reads and
a `PATCH` whose body contains only `supplier` and/or `invoiceRef` (AC-10.1); any other
field in that body → 403.
Allowed transitions: `ordered→in_stock` (receive); `assigned→in_stock` (return);
`in_stock|assigned→in_repair`; `in_repair→assigned|in_stock` by holder presence;
`in_stock|assigned|in_repair→lost` (clears holder); `lost→in_stock`.

### Ledger — `ledger:manage`

| Route | Body | Success | Errors |
|---|---|---|---|
| `POST /assets/{id}/dispose` | `{ disposedOn, reason, salePriceCents?: number }` | 200 `AssetView` | 409 `asset_disposed`; 409 `assignment_pending` `{assignmentId}`; 409 `fiscal_year_closed`; 422 `disposed_before_purchase`; 422 `sale_price_not_allowed` (reason not `sold`/`ceded_to_employee`) |
| `GET /rules?entity` | — | 200 `{ rules: Rule[], inForceId: string }` | 403; 404 entity out of scope |
| `POST /rules` | `{ entity, effectiveFrom, usefulLifeYears, firstYearShare, lowValueThresholdCents: number \| null, residualCents }` | 201 `Rule` | 422 with `field`; 409 `fiscal_year_closed` |
| `GET /fiscal-years?entity` | — | 200 `{ years: { year, status: "open" \| "closed", closedAt: string \| null, closable: boolean }[] }` | 403 |
| `GET /fiscal-years/{entity}/{year}` | — | 200 `FiscalYearView` | 404 out of scope or before the entity's first year |
| `POST /fiscal-years/{entity}/{year}/close` | — | 201 `FiscalYearView` | 409 `previous_year_open`; 409 `already_closed`; 409 `nothing_to_close`; 409 `year_in_future` `{year}` (a year after the current UTC year; security review M1) |

```ts
type Rule = { id: string; entity: Entity; effectiveFrom: string; usefulLifeYears: number
              firstYearShare: "full" | "half"; lowValueThresholdCents: number | null
              residualCents: number; createdBy: Identity; createdAt: string }
type FiscalYearView = {
  entity: Entity; year: number; currency: "CHF" | "EUR"
  status: "open" | "closed"; closedAt: string | null
  rollForward: { openingCents: number; disposalsCents: number; purchasesCents: number
                 depreciationCents: number; closingCents: number }
  assets: { assetId: string; purchaseDate: string; description: string
            serialNumber: string | null; holder: Identity | null
            purchasePriceCents: number; openingCents: number; purchaseCents: number
            depreciationCents: number; disposalCents: number; closingCents: number }[]
}
```

There is no reopen route and no update/delete route for rules (AC-6.5, AC-8.7).

### Invoice files — either capability, scoped to `entity`

| Route | Body | Success | Errors |
|---|---|---|---|
| `POST /invoice-files` | `{ entity, invoiceRef, fileName, contentType, sizeBytes }` | 201 `{ id, upload: { url, fields } }` | 413 over 10 MiB; 415 not pdf/jpeg/png |
| `POST /invoice-files/{id}/confirm` | — | 200 `{ id, fileName }` | 409 `upload_not_found` (HEAD miss or size mismatch); 404 for anyone but the uploader (security review L2) |
| `PUT /invoice-files/{id}/assets` | `{ assetIds: string[] }` | 200 `{ linked: string[] }` | 409 `invoice_ref_mismatch` `{assetId}`; 409 `asset_disposed` `{assetId}`; 404 any asset out of scope |
| `GET /invoice-files/{id}/url` | — | 200 `{ url, expiresInSeconds: 60 }` | 404 out of scope, not `stored`, or caller has no capability |

Link rules: linking a file to an asset that already has one replaces that asset's link
(the old `invoice_file` row and object are kept); there is no unlink route. A `PATCH`
that changes an asset's `invoiceRef` clears its `invoiceFileId` in the same transaction.
Both write an `invoice_file_linked` history event.

### `auth`

| Route | Auth | Success | Errors |
|---|---|---|---|
| `GET /authz/users/directory` | user JWT; caller must hold `asset:manage` | 200 `{ users: { id, name: string \| null, email, entity: string \| null }[] }` (active only, name-sorted) | 403; 429 with `Retry-After` |
| `POST /system/service-token` | body `{ clientId, clientSecret }` | 200 `{ token, expiresInSeconds: 300 }` | 401 (identical body for unknown client and wrong secret); 429 |

### `notify-api`

`POST /system/notifications` — body unchanged. Auth is now `X-Internal-Token` **or**
`Authorization: Bearer` with `aud = SERVICE_AUDIENCE` and `scope` containing
`notifications.push`; 401 otherwise; a user JWT (`aud = AUTH_AUDIENCE`) is still 401.
`inventory-api` sends `originApp: "inventory"`, `link.href: "/devices"` to an assignee and
`"/inventory/assets/{id}"` to a manager.

### Environment

`inventory-api`: `DATABASE_URL`, `ALLOWED_ORIGINS`, `AUTH_JWKS_URL`, `AUTH_ISSUER`,
`AUTH_AUDIENCE`, `AUTH_BASE_URL`, `PORT` (8083), `NODE_ENV`, `INVENTORY_S3_ENDPOINT` /
`_REGION` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` /
`_EU_ENDPOINT_HOSTS`, `NOTIFY_INTERNAL_URL`, `SERVICE_CLIENT_ID`,
`SERVICE_CLIENT_SECRET`. `auth`: `SERVICE_CLIENTS`, `SERVICE_AUDIENCE`, plus a
`*_RATE_LIMIT` / `*_RATE_LIMIT_WINDOW_MS` pair with defaults for each of the two new
routes (the `APP_ACCESS_CHECK_RATE_LIMIT` pattern). `notify-api`:
`SERVICE_AUDIENCE`. All added to `tools/env-doctor/manifest.ts` (`SERVICE_AUDIENCE`
under `SHARED_VARS` for `auth` + `notify-api`).

## Test strategy

Levels: **unit** = pure functions (bun test / vitest); **integration** = `inventory-api`
route tests against Postgres with the `test-support/testAuth.ts` pattern; **e2e** =
Playwright in `shell/e2e/inventory-*.spec.ts`; **script** = the import run against a
fixture sheet in an integration test.

| AC | Level | Test |
|---|---|---|
| AC-1.1, 1.6, 1.8 | integration | `POST /assets` creates `in_stock` / `ordered`; missing or non-positive fields → 422, no row; `/receive` |
| AC-1.2, 1.9 | integration | currency follows entity; DB `CHECK` rejects a mismatch; `PATCH entity` → 422 |
| AC-1.3 | unit + integration | `splitPrice(total, n)` sums exactly, remainder on last; N rows created |
| AC-1.4, 1.5 | integration | no serial accepted; duplicate live serial → 409; same serial after disposal accepted |
| AC-1.7 | integration | purchase date in a closed year → 409 `fiscal_year_closed` |
| AC-2.1–2.5, 2.10 | integration | assignment state machine incl. partial-unique-index race (two concurrent assigns → one 409) |
| AC-2.6 | integration | pending row unchanged with clock advanced 30 days; no code path reads `createdAt` to transition |
| AC-2.7 | integration | confirm/decline by a different `sub` → 404 |
| AC-2.8, 2.9 | integration + e2e | notify client called after commit with recipient and link (stubbed `notify-api`); e2e: bell shows the notification and its link opens `/devices` |
| AC-3.1–3.5 | integration | every allowed transition and one disallowed per status → 409 |
| AC-3.6 | integration | `PATCH locationNote` leaves status and holder untouched |
| AC-3.7 | integration | each filter alone and combined returns exactly the matching set |
| AC-3.8 | integration | `q` matches description and serial case-insensitively, combines with filters, and respects entity scope |
| AC-4.1, 4.4 | integration + e2e | `/me/devices` for holder, pending addressee, and empty; e2e as a user with zero grants reaching `/devices` |
| AC-4.2 | integration | response JSON of `/me/devices` contains no key matching `/price|cents|ledger|schedule/i` |
| AC-4.3 | integration | grant-less user on `GET /assets/{id}` of someone else's asset → 404; on `GET /assets` → 403 |
| AC-5.1, 5.4, 5.5, 5.6 | unit | `schedule-vectors.json` |
| AC-5.2 | unit | 1 Jan and 31 Dec purchases give identical year-1 amounts |
| AC-5.3 | unit + integration | book value is `residual` for years after the schedule; unchanged until dispose |
| AC-5.7 | integration | `ordered` asset has a schedule starting in its purchase year |
| AC-5.8 | integration | accountant `GET /assets/{id}` returns `ledger` with every year |
| AC-5.9 | integration | price edit with all years open changes the schedule; with a closed year → 409 |
| AC-6.1 | integration | `GET /rules` lists past, current, future and marks `inForceId` |
| AC-6.2 | integration | new rule at D changes schedules only for assets purchased ≥ D |
| AC-6.3, 6.4 | integration | closed-year effective date → 409; invalid fields → 422 naming the field |
| AC-6.5 | integration | actor and time recorded; raw `UPDATE`/`DELETE` on the table raises |
| AC-6.6 | integration | fresh migration has the two launch rules |
| AC-7.1, 7.5, 7.6 | integration | dispose from each status; pending → 409; every later action → 409 `asset_disposed` |
| AC-7.2, 7.7, 7.8 | unit + integration | disposal-year figure: start-of-year value, and price when bought the same year; zero depreciation after; book value 0 |
| AC-7.3 | integration | sale price stored and returned; roll-forward identical with and without it |
| AC-7.4 | integration | closed-year date → 409; before purchase → 422 |
| AC-8.1, 8.2, 8.3 | unit + integration | property test over generated asset sets: equation holds, lines equal per-asset sums, opening(Y+1) = closing(Y) |
| AC-8.4, 8.5 | integration | close writes `fiscal_year` + figures; closing out of order → 409 |
| AC-8.6 | integration | close, then add a rule / edit an open-year asset; closed-year response byte-identical |
| AC-8.7 | integration | no reopen route (404/405); raw `DELETE` on `fiscal_year` raises |
| AC-8.8, 8.9 | unit (inventory-ui) + e2e | workbook builder: columns, one row per asset, five lines, "provisional" mark for an open year; e2e download has a non-zero `.xlsx` |
| AC-9.1, 9.2, 9.3 | integration | route × capability matrix test generated from the route table; inventory-only response has `purchasePriceCents` and no `ledger` |
| AC-9.4, 9.5 | integration | entity-conditioned vs unconditioned grant on list, detail, rules, fiscal years |
| AC-9.6 | e2e | grant-less user: no Inventory sidebar entry, `/inventory` → `/no-access`, `/devices` works |
| AC-9.7 | integration | covered by the matrix test hitting routes directly; plus `auth` outage → 503 |
| AC-10.1, 10.2, 10.3 | integration | fields stored; multi-unit shares them; `invoiceRef` filter within scope |
| AC-10.4, 10.6 | integration (MinIO) | mint → upload → confirm → url; wrong type 415, oversize 413, nothing stored |
| AC-10.5 | integration | one `invoice_file` row linked to N assets; mismatching ref → 409 |
| AC-10.7 | integration | holder with no capability → 404 on `/invoice-files/{id}/url`; other-entity accountant → 404 |
| AC-11.1 | integration | one event per mutating route, asserted in the matrix test |
| AC-11.2 | integration | raw `UPDATE`/`DELETE` on `asset_event` raises |
| AC-11.3, 11.4 | integration | history order; holder timeline reconstructed from events for an assign → return → assign sequence |
| AC-12.1, 12.6, 12.7, 12.8, 12.9 | script | fixture sheet with a multi-unit row, an unassigned row, a matched and an unmatched assignee, a cession row, an "Ordinato" row |
| AC-12.2, 12.3 | script | imported figures equal the fixture's cents; years ≤ 2025 report closed |
| AC-12.4 | script | import exits non-zero unless Σ closing(2025) equals the `--expected-opening-cents` argument |
| AC-12.5 | unit | anchor vector in `schedule-vectors.json` |
| AC-12.10 | integration | `toVerify=true` filter |

Service-token work has its own tests outside the AC table: `auth` (token claims, wrong
secret, rate limit), `notify-api` (service JWT accepted; user JWT, wrong `aud`, missing
scope and expired all 401; `/system/emails` rejects the service JWT; legacy token still
accepted).

## Risks

- **R-1 The sheet does not reconcile (spec O3/O4/O5).** The import cannot be accepted
  until accounting names the opening balance. Mitigation: AC-12.4 is a hard assertion in
  the script with the figure as an argument, so everything else can be built and tested
  against a fixture now. Early check: send O3–O5 to accounting before task derivation.
- **R-2 The sheet has no per-year depreciation before 2024**, only a value at
  31.12.2023. AC-12.2 is implemented as "every amount the sheet contains"; years before
  2024 are closed with only that closing value. If accounting needs earlier yearly
  figures in the tool, that is a spec amendment.
- **R-3 The wellD IT rule is unconfirmed (O1)** and no IT data exists (O2). Mitigation:
  the rule is a seeded row, not code; a correction before any IT year is closed is a new
  rule row. Early check: O1 answered before the first `welld_it` asset is registered in
  production.
- **R-4 Signing a non-user JWT with auth's keypair.** `auth` issues JWTs through
  better-auth's jwt plugin; minting a token with a system `sub` and a different `aud`
  with the same `kid` is unproven here. Early check: the first `auth` task is a contract
  test that a minted service token verifies through `createRemoteJWKSet` in `notify-api`.
  Fallback: sign directly with `jose` using `JWT_PRIVATE_KEY`.
- **R-5 Two federated entries from one remote** (`./App` and `./MyDevices`) mounted on
  different shell routes have no precedent. Early check: a shell router test plus
  `mf-singleton.spec.ts` extended to `/devices` before any screen is built.
- **R-6 Entity restriction means "own entity".** A conditioned grant scopes a user to
  their `user.entity`; a CH employee cannot be restricted to IT only. This matches
  refund (ADR-0015) and AC-9.4 as written, but is narrower than free choice of entity.
- **R-7 A user with no `entity` and a conditioned grant** resolves to a null scope and
  sees nothing. Mitigation: explicit test; surfaced in the admin role composer as today.
- **R-8 Live roll-forward cost.** Open-year figures are computed per request over all
  assets of an entity (hundreds, not millions). Early signal: integration test with
  2,000 assets must answer `GET /fiscal-years/{e}/{y}` under 500 ms.
- **R-9 Soft-deleted holders.** A deleted user remains `holderUserId`; identity resolves
  to `deleted` and the manager must take the device back by hand. No automatic return.

## Security

**YES.** New authorization-enforcing resource server with two capabilities and entity
scoping; a new ungated route that must never leak price or other users' assets; a new
user-directory endpoint exposing names and emails; file upload to object storage;
personal data (who holds which device, full history); a new service-to-service
credential and token endpoint on the identity service; financial records with
immutability guarantees. Schedules an owasp-reviewer pass in parallel with QE.

## ADR candidates

Recorded as ADR-0044 to ADR-0047 on 2026-10-06.

- **R1** → `docs/adr/0044-scoped-service-jwt-fourth-notify-caller.md` — scoped,
  auth-minted service JWT for `inventory-api`, coexisting with the legacy token; realises
  ADR-0040's hard stop. Rejected: fourth shared-token holder; forwarded user JWT;
  per-service keypairs.
- **R2** → `docs/adr/0045-ungated-second-federated-entry-of-a-gated-remote.md` — a gated
  tool remote may expose a second entry mounted at an unguarded shell route, backed by
  `/me/*` routes scoped to `sub`. Rejected: shell-native screen; universal access grant.
- **R3** → `docs/adr/0046-depreciation-derived-on-read-closed-years-snapshotted.md` —
  schedules derived on read, closed years stored immutably. Rejected: persisted
  schedules; fully live with no snapshot.
- **R4** → `docs/adr/0047-user-directory-endpoint-capability-gated.md` — `auth GET
  /authz/users/directory` gated on a catalog permission; narrows ADR-0039's "no search"
  for capability holders. Rejected: exact-email decision endpoint; reuse of
  `/admin/users`.

## Amendments after the security review (2026-10-08)

Applied in code by commits `da898e8`, `e422feb`, `0c8156c`, `a5f68af`, `eb0f9a2`; where this
section disagrees with earlier text, this section wins.

- **Close (M1):** a year after the current UTC calendar year is refused with 409
  `year_in_future` `{year}`; the list route's `closable` uses the same function. The current
  year itself stays closable (a stricter "year has ended" rule is an open spec decision).
- **Invoice files (L1, L2):** the presigned POST lives 60 s; `invoice_file` gains a nullable
  `etag` recorded at confirm, and the download-URL route re-checks size and ETag (404 on
  mismatch). Only the uploader may confirm. `POST /invoice-files` answers 429
  `too_many_pending_uploads` beyond 20 pending files minted by one user in the last hour.
- **Entity scope (L3):** a grant carrying a condition `inventory-api` does not recognise
  contributes nothing. This is deliberately stricter than refund-api's ADR-0015 helper, which
  treats such a grant as unscoped.
- **Body size (L7):** every request body is capped at 64 KiB (413 Problem); `POST
  /invoice-files` keeps its 8 KiB cap.
