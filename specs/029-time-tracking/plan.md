---
spec: 029
status: approved
approved: 2026-11-12
---

# Plan: Time tracking — the hours employees spend on company work

Branch `feat/time-tracking`, from `main` (ledger D11). Nothing here depends on PR #9 (specs/026);
the files both touch are listed under Risks (R3). Review decisions of 2026-11-12: ledger D35
(spec amendment AC-4.10), D36 (own service), D37 (own remote).

## Architecture

### Shape in one paragraph

Time entries are their own domain in a **new backend service, `hours-api`** (Bun + Hono + Prisma,
port 8088, database `hours`, Railway EU) — ADR-0088. It owns entries, categories and work types
and nothing else. Whether a person may book on a project, a deal or a meeting is asked **of the
service that owns it, as the caller**, at write time, failing closed (ADR-0081 posture, ADR-0089):
projects-api's existing host resolve already answers the project manager and team (`assignees`);
crm-api's host resolve learns the entity type `deal` and answers who is `involved` (owner,
technical contact); activities-api's existing list answers whether the caller is the assignee or a
participant of one of the deal's activities, and — with a new `ids` filter — whether a pointed
activity exists and belongs to the same project or deal; meetings-api's own list answers whether
the caller is the meeting's creator or a participant. A meeting's **current deal** — needed to
count its hours under that deal for any viewer (AC-2.6, AC-4.5) — is read live from meetings-api's
first `/system/*` route, content-free, over hours-api's own service credential (ADR-0089).
Reading one's own hours needs only a JWT; reading everyone's is an **oversight path** resolved live
from `auth` only on that path (ADR-0075 shape) behind a new `hours` catalog permission. The screens
are a **new remote, `hours-ui`, mounted ungated at `/hours`** (ADR-0090); the two admin lists are a
page in `admin-ui` calling hours-api directly (ADR-0023 pattern).

ADRs written for this plan: `docs/adr/0088-hours-api-time-entries-own-service-hours-catalog.md`,
`docs/adr/0089-time-bookability-asked-of-owners-meeting-hosts-system-route.md`,
`docs/adr/0090-hours-ui-ungated-remote.md` (numbered after PR #9's 0084–0087).

### Components

| Component | Change |
|---|---|
| `hours-api` (new) | Service skeleton copied from activities-api's shape: `src/index.ts` (CORS with `ALLOWED_ORIGINS`, request logger, 64 KiB body limit, routers, OpenAPI + Scalar, RFC 7807 `onError`/`notFound`), `src/auth/jwt.middleware.ts` (RS256, issuer, `aud=AUTH_AUDIENCE`), `src/lib/{env,db,problem,logger,identities,serviceToken}.ts`, `src/health`. Feature modules: `src/entries/` (CRUD + list), `src/totals/`, `src/lists/` (categories, work types), `src/targets/` (bookability checks), `src/labels/` (fail-soft names and meeting→deal links), `src/oversight/` (read-all, copied from estimai-api `src/estimates/oversight.ts` + `src/lib/authClient.ts`), `src/authz/` (live `time-list:manage`, copied from projects-api `src/auth/authz.middleware.ts` + `src/authz/resolveClient.ts`). Clients: `src/clients/{projects,crm,activities,meetings}.ts` (caller JWT, 2 s, batched; meetings system call with a service JWT). Copied modules registered in `scripts/check-shared-copies.ts`. Test harness: `src/test-support/{env,world,hosts}.ts` (activities-api pattern: one scriptable `Bun.serve` playing projects-api, crm-api, activities-api and meetings-api) and `src/matrix.test.ts`. Env (`src/lib/env.ts`): `DATABASE_URL`, `ALLOWED_ORIGINS`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_BASE_URL`, `PROJECTS_API_URL`, `CRM_API_URL`, `ACTIVITIES_API_URL`, `MEETINGS_API_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`, `SERVICE_AUDIENCE` (≠ `AUTH_AUDIENCE`), `PORT=8088`, `NODE_ENV`. Files: `.env.example`, `.envrc`, `Dockerfile`, `bunfig.toml`, `package.json`, `prisma.config.ts`, `railway.json` (`preDeployCommand: bun run db:deploy`), `tsconfig.json`. |
| `activities-api` | `GET /activities` accepts `ids` (≤ 50, comma-separated) as a fifth "exactly one of" filter. Each id's host is resolved **as the caller**, exactly as today; unreadable or missing ids are omitted (identical); an unreachable host is the existing 503. No new table, no catalog. |
| `crm-api` | `src/activity-host/resolve.routes.ts`: `entityType` becomes `"company" \| "deal"`. For `deal` each id is answered with label/href and `involved: [ownerUserId, technicalUserId?]`, the technical contact taken **as the deal view does** (`estimate?.technical` — an override row with `estimateId: ""` is not a technical contact, `deals.routes.ts:244`). Reader = `crm:access`, as for companies. |
| `meetings-api` | (1) `GET /meetings` gains `ids` (≤ 25) — still the caller's own meetings only (creator or Operai participant, `list.routes.ts:57-62`), so one call is both the booking check and the label. (2) First `/system/*` route, `GET /system/meetings/hosts` (service JWT, `aud=SERVICE_AUDIENCE`, scope `meetings.hosts.read`, sub `system:hours-api` only, one identical 401), answering `{id, host}` and nothing else. Copies crm-api's `src/auth/systemAuth.middleware.ts` (verifies against the existing `AUTH_JWKS_URL`). Env: `SERVICE_AUDIENCE`. |
| `auth` | New catalog `auth/src/authz/catalogs/hours.ts`, appId `hours`, **no `access` resource** (the feature is ungated, AC-5.1): `time-entry:read-all` and `time-list:manage`, both `supportedConditions: []`. `seed.ts`: `DECLARED_CATALOGS`, `seedHoursCatalog`, `seedHoursGrants` (admin only, unconditioned); **not** in `ALL_APP_IDS`. `uniqueResourceKeys.test.ts` appId list; `seed.test.ts` block. `system/serviceClients.ts`: `KNOWN_SERVICE_SCOPES += "meetings.hosts.read"`; documented client `hours-api` with that scope. Not added to `DIRECTORY_GATE_PERMISSIONS` (the person filter is built from the entries' own user ids — ADR-0066 untouched). |
| `hours-ui` (new) | Federated remote, dev port **5184** (5182/5183 are the e2e preview defaults of meetings/projects in `shell/playwright.config.ts`), e2e preview 5185. Exposes `./App` (ungated, the whole hours screen) and `./version` (ADR-0030). Screens: My hours (period list grouped by day with day totals), the entry dialog (target picker, category / work type, note), the global view for holders of `time-entry:read-all` (person filter, grouped totals, export). Pickers search what the person can already search — projects-api `GET /projects?q=`, crm-api `GET /deals?q=`, meetings-api `GET /meetings` — and the server decides. Export: `exceljs`, lazy-loaded, built from the list pages (inventory-ui `yearWorkbook.ts` pattern). `@operai/ui` throughout; `/wellforge:design` runs before tasks. |
| `shell` | `getHoursApiBaseUrl()` in `src/lib/session.ts` (`VITE_HOURS_API_URL`, trusted origin, `vite-env.d.ts`, `.env.example`). Ungated splat route `/hours/$` (child of `shellRoute`, no `beforeLoad`, the `/my-meetings` shape); **not** a `TOOLS` entry. UserMenu link "My hours". Runtime remote `hours` (`runtimeRemotes.ts`, `runtime-config.example.json`, `vite.config.ts`, `federation/remotes.d.ts`, stubs), About-modal version, `index.css @source`, Vercel CSP (`script-src`, `connect-src`), strings en/it. |
| `admin-ui` | Page `/time-lists`: categories (name, requires note, retired) and the two work-type lists; `src/lib/timeListsApi.ts` via `apiFetch` + `getHoursApiBaseUrl` (added to `federation/remotes.d.ts` and the stub). Nav entry shown only with `time-list:manage` (`SectionNav.tsx`, the `rate:read` pattern); a 403 renders `PermissionDenied`. |
| `@operai/ui` | `formatDuration` gains `style: 'short'` → "2 h 30" / "30 min" (AC-4.9), with story and test. |
| Infra / release | `infra/provision-tool.sh hours` (the standard api + ui pair: Railway service `hours-api`, database `hours`, Vercel project `hours-ui`, DNS), `infra/check.sh` (health + 401 probes), `infra/README.md` section; `compose.yaml` service; `mise.toml` (`dev`, `dev:web`, `dev:preview`, `db:migrate`); `tools/env-doctor/manifest.ts` (`SERVICES`, `ORIGINS`, `resourceServers`, `AUTH_*` links, `CORS_REQUIREMENTS` hours-api `mustAllow: ["shell", "admin-ui"]`, `REQUIRED_KEYS`, `INTERNAL_URL_VARS` for the four internal URLs, `SERVICE_CLIENT_LINKS` hours-api `["meetings.hosts.read"]`, meetings-api `SERVICE_AUDIENCE`) + `templates/production/hours-api.env` + its tests; `lerna.json` (`hours-api`, `hours-ui`); changesets (auth, hours-api, hours-ui, activities-api, crm-api, meetings-api, shell, admin-ui, operai-ui); `AGENTS.md`, `README.md`. |

### Sequences

**Record an entry on a deal** (`POST /time-entries`, `on: {type:"deal", id}`):
1. hours-ui → hours-api with the user's JWT.
2. Validate shape, duration, day (today in `Europe/Zurich`), note, category / work type (local).
3. hours-api → crm-api `POST /activity-host/v1/resolve {entityType:"deal", ids:[id]}` with the
   caller's JWT. `reader:false` or `missing` → **404**; unreachable → **503**.
4. Involved if the caller is in `item.involved`; otherwise hours-api → activities-api
   `GET /activities?dealId=<id>` (caller's JWT, paged, ≤ 10 pages) and looks for the caller as a
   task's assignee or in `participants`. Neither → **403 `not_involved_in_deal`**; activities-api
   unreachable → **503**.
5. If `activityId`: activities-api `GET /activities?ids=<activityId>` — absent, or its `deal.id`
   ≠ the deal → **422 `activity_not_allowed`**.
6. Insert; 201 with the view.

**On a project**: step 3 is projects-api `POST /activity-host/v1/resolve {entityType:"project"}`;
the caller must be in `assignees` (PM + team, `activity-host.routes.ts:118`) → else **403
`not_on_project`**. `writable` (false when closed/cancelled) is **ignored**: entries are accepted
in any state (A12). An activity pointer must be a task whose `project.id` is that project.

**On a meeting**: meetings-api `GET /meetings?ids=<id>` with the caller's JWT (selfScoped, works
through an `auth` outage). Absent → **404** (also covers a host-only reader, whom the list never
includes). No activity pointer, no work type.

**On no entity**: no remote call; category required.

**List / totals** (`GET /time-entries`, `GET /time-entries/totals`):
1. `whose=mine` (default): JWT only, scoped to `sub`. `whose=all`: oversight (below).
2. Query entries (SQL; indexes `userId, day`, `projectId, day`, `dealId, day`, `meetingId`).
3. In parallel, fail soft, each source named in `unavailable[]` when it does not answer:
   identities (`auth POST /authz/users/identities`, ≤ 100), project labels (projects resolve, 25),
   deal labels (crm resolve `deal`, 25), pointed activities (activities-api `GET /activities?ids=`,
   50), meeting titles (`GET /meetings?ids=`, 25 — only meetings the **viewer** took part in),
   meeting → deal links (`GET /system/meetings/hosts?ids=`, 100). Labels follow the **viewer's**
   access (AC-4.10): an entity the viewer cannot read is `visibility: "hidden"`, label `null`, and
   the activity subject is `null`.
4. A `dealId` filter also asks `GET /system/meetings/hosts?dealId=` for the meetings linked to that
   deal and includes their entries; grouping by deal places a meeting's entries under its current
   deal (AC-2.6).

**A pointed activity that was deleted** (AC-2.9) is derived on read, not swept (ADR-0013): when
the viewer can read the entry's project or deal and activities-api no longer returns the pointed
id, the view shows `activity: null`. When the owner changes the entry and the pointed activity is
gone, the stored id is cleared in that write (reconcile on write); a changed `activityId` is
validated as in step 5.

**Oversight** (`whose=all`, a `userId` filter, any write on someone else's entry): hours-api asks
`auth GET /authz/resolve` with the caller's JWT for `time-entry:read-all`. A refusal is cached by
`(sub, perm_epoch)` for 30 s, a grant never (ADR-0075). `auth` unreachable → 503
`authz_unavailable` on reads; on a write to someone else's entry the check only decides 403
`owner_only` vs 404, and a failed check answers 404.

**Admin lists**: `time-list:manage` resolved live on every list write (projects-api
`authzMiddleware` shape: cache `(sub, perm_epoch)` 30 s, 503 when `auth` is down, 403 without it).
Reading the lists needs only a JWT.

### Decisions this plan makes (ADR candidates — see the end)

- Own service `hours-api` (ADR-0088; the user's choice, D36).
- Bookability asked as the caller of each owner, plus the meeting→deal link read live (ADR-0089).
- hours-ui as its own ungated remote (ADR-0090; D37).
- **No `If-Match` on time entries.** ADR-0038 protects records several people write; an entry has
  one writer, its person. Two tabs of the same person: last write wins. Recorded in ADR-0088.
- Retiring a category or work type is reversible (`retired: false`); only deleting is forbidden
  (AC-3.2).
- Category and work-type names are unique per list, case-insensitive, retired included (409).

## Data model

New database `hours`, `hours-api/prisma/schema.prisma`:

```prisma
enum TimeTarget   { project deal meeting none }
enum WorkTypeList { project deal }

model TimeEntry {
  id         String        @id @default(cuid())
  userId     String                        // the JWT sub of its creator, never client input
  day        DateTime      @db.Date
  minutes    Int                           // 30..1440, multiple of 30
  target     TimeTarget
  projectId  String?                       // projects-api id (no FK: another service)
  dealId     String?                       // crm-api id
  meetingId  String?                       // meetings-api id
  categoryId String?
  category   TimeCategory? @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  workTypeId String?
  workType   WorkType?     @relation(fields: [workTypeId], references: [id], onDelete: Restrict)
  activityId String?                       // activities-api id; shown only while it still exists
  note       String?
  createdAt  DateTime      @default(now())
  updatedAt  DateTime      @updatedAt

  @@index([userId, day])
  @@index([projectId, day])
  @@index([dealId, day])
  @@index([meetingId])
  @@map("time_entry")
}

model TimeCategory {
  id           String      @id @default(cuid())
  name         String
  requiresNote Boolean     @default(false)
  retiredAt    DateTime?
  createdBy    String
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt
  entries      TimeEntry[]
  @@map("time_category")
}

model WorkType {
  id        String       @id @default(cuid())
  list      WorkTypeList
  name      String
  retiredAt DateTime?
  createdBy String
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
  entries   TimeEntry[]
  @@map("work_type")
}
```

Initial migration `hours-api/prisma/migrations/2026111…_init/migration.sql`, raw SQL after the
generated DDL:

- `time_entry_minutes`: `minutes BETWEEN 30 AND 1440 AND minutes % 30 = 0` (AC-1.2).
- `time_entry_note_length`: `note IS NULL OR char_length(note) <= 1000` (AC-1.7).
- `time_entry_target_shape`: exactly the target's columns — `project` ⇒ `projectId` only; `deal` ⇒
  `dealId` only; `meeting` ⇒ `meetingId` only and `workTypeId IS NULL`; `none` ⇒ `categoryId NOT
  NULL` and `workTypeId IS NULL`; `categoryId IS NULL` unless `none` (AC-2.1, AC-3.5).
- `time_entry_activity_target`: `activityId IS NULL OR target IN ('project','deal')` (AC-2.7).
- Unique indexes `time_category (lower(name))`, `work_type (list, lower(name))`.
- `Restrict` on category / work type backs AC-3.2 at the database.
- Seed rows (A15) with fixed ids `tc-training`, `tc-talk-preparation`, `tc-administration`,
  `tc-other` (`requiresNote = true`); `wt-project-development`, `wt-project-analysis`,
  `wt-project-management`, `wt-project-support`; `wt-deal-analysis`, `wt-deal-estimate`,
  `wt-deal-demo`, `wt-deal-offer`; `createdBy = 'system:migration'`.

Rules in code (not expressible as CHECK): the work type's list matches the target, the activity
belongs to the same project/deal, no retired category or work type on create or change, a
category's `requiresNote`, no future day.

No schema change in activities-api, crm-api, meetings-api or projects-api. No data migration.

## API contracts

All hours-api routes: Bearer JWT (`aud=AUTH_AUDIENCE`), RFC 7807 Problem JSON with `code`. Dates
`YYYY-MM-DD`. Base URL `getHoursApiBaseUrl()`.

### Views

```ts
type Person = { id: string; name: string | null; status: "active" | "deleted" | "unknown" }
type Visibility = "visible" | "hidden" | "unavailable"   // hidden: the viewer may not read it (AC-4.10)

type TimeEntryView = {
  id: string
  day: string                       // YYYY-MM-DD
  minutes: number
  note: string | null
  person: Person
  on:
    | { type: "project"; id: string; label: string | null; href: string | null; visibility: Visibility }
    | { type: "deal"; id: string; label: string | null; href: string | null; visibility: Visibility }
    | { type: "meeting"; id: string; label: string | null; href: string | null; visibility: Visibility;
        deal: { id: string; label: string | null; href: string | null; visibility: Visibility } | null }
    | { type: "none"; category: { id: string; name: string; retired: boolean } }
  workType: { id: string; name: string; retired: boolean } | null
  activity: { id: string; subject: string | null; visibility: Visibility } | null // null: none, or deleted
  createdAt: string
  updatedAt: string
}

type Unavailable = ("projects" | "crm" | "activities" | "meetings" | "identities")[]
```

`href` values are suite paths only: `/projects/<id>`, `/crm/deals/<id>`, `/my-meetings/m/<id>`.

### Entries

```
POST /time-entries
  body: {
    day: string, minutes: number,
    on: { type: "project" | "deal" | "meeting", id: string } | { type: "none", categoryId: string },
    workTypeId?: string | null, activityId?: string | null, note?: string | null
  }                                    // strict: any other key (userId, start, end…) → 400
  201 TimeEntryView

PATCH /time-entries/{id}               // owner only; any subset of POST's members; `on` replaced whole
  200 TimeEntryView                    // the target's bookability is re-checked on every change (A3)

DELETE /time-entries/{id}              // owner only; no bookability check
  204

GET /time-entries?whose=mine|all&from&to&userId&target&projectId&dealId&meetingId&categoryId
                 &workTypeId&cursor&limit
  // from/to required, span ≤ 366 days; limit 1..500 (default 100); order day desc, createdAt desc
  // userId only with whose=all; dealId includes entries on meetings linked to that deal
  200 { items: TimeEntryView[]; nextCursor: string | null; unavailable: Unavailable }

GET /time-entries/totals?groupBy=person|project|deal|category|month&<the list's filters>
  200 { totalMinutes: number;
        groups: { key: string | null; label: string | null; visibility?: Visibility; minutes: number }[];
        unavailable: Unavailable }    // key null = entries outside the grouping (e.g. no deal)
```

Errors:

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | schema violation, unknown key, bad query (span, `userId` without `whose=all`) |
| 422 | `invalid_minutes` | not 30..1440 in steps of 30 |
| 422 | `future_day` | day after today in `Europe/Zurich` |
| 422 | `note_too_long` / `note_required` | > 1000 characters / the category requires a note |
| 422 | `category_not_found` / `category_retired` | |
| 422 | `work_type_not_allowed` | on a meeting or no entity, or from the other list |
| 422 | `work_type_not_found` / `work_type_retired` | |
| 422 | `activity_not_allowed` | not an activity of the same project/deal, or target is meeting/none |
| 403 | `not_on_project` | project readable, caller not PM or team member |
| 403 | `not_involved_in_deal` | deal readable, caller not owner, technical contact, assignee or participant |
| 403 | `owner_only` | holder of `time-entry:read-all` writing someone else's entry |
| 403 | `read_all_required` | `whose=all` or `userId` without the permission |
| 404 | `not_found` | entry not the caller's (non-holder), target missing or not readable, meeting not the caller's — one identical body |
| 503 | `host_unavailable` | projects-api, crm-api, activities-api or meetings-api did not answer a write's check |
| 503 | `authz_unavailable` | `auth` did not answer an oversight read or a list write |

### Lists

```
GET /time-lists?includeRetired=true|false          // any JWT
  200 { categories: { id, name, requiresNote, retired }[];
        workTypes: { project: { id, name, retired }[]; deal: { id, name, retired }[] } }

POST  /time-categories       { name: string (1..80, trimmed), requiresNote?: boolean }   → 201
PATCH /time-categories/{id}  { name?, requiresNote?, retired?: boolean }                 → 200
POST  /work-types            { list: "project" | "deal", name: string (1..80) }          → 201
PATCH /work-types/{id}       { name?, retired?: boolean }                                → 200
  // time-list:manage, live: 403 time_list_manage_required, 503 authz_unavailable,
  // 409 name_taken, 404 not_found; no DELETE route is mounted (AC-3.2)
```

### activities-api (changed)

```
GET /activities?ids=a,b,c          // ≤ 50; exactly-one-filter rule unchanged (ids is the fifth)
  200 { items: Activity[]; total; page; pageSize }   // existing Activity view; unreadable/missing ids omitted
  503 host_unavailable                               // as today
```

### crm-api (changed)

```
POST /activity-host/v1/resolve
  body: { entityType: "company" | "deal"; ids: string[] /* ≤25 */; related?: … /* company only */ }
  200 (deal): { reader: boolean;
                items: ({ id: string; state: "missing" }
                       | { id: string; state: "open"; writable: true; label: string; href: string;
                           may: { write: true; manage: true };
                           involved: string[] /* ownerUserId, + technicalUserId when an estimate is linked */ })[] }
```

### meetings-api (changed / new)

```
GET /meetings?ids=a,b,c             // ≤ 25; selfScoped; only the caller's meetings (creator or participant)
  200 { items: MeetingRow[]; total; page; pageSize }   // MeetingRow unchanged (role, title, startsAt, host)

GET /system/meetings/hosts?ids=a,b,c        // ≤ 100
GET /system/meetings/hosts?dealId=<id>      // the meetings currently linked to that deal
  // service JWT: aud=SERVICE_AUDIENCE, scope meetings.hosts.read, sub system:hours-api; else one identical 401
  200 { items: { id: string; host: { app: "crm"; entityType: "deal"; entityId: string } | null }[] }
  // never a title, participant, duration or any content; unknown ids are omitted
```

### auth (changed)

- Catalog `hours`: `time-entry` → `read-all`; `time-list` → `manage`; both
  `supportedConditions: []`, seeded to `admin` only.
- Scope `meetings.hosts.read` in `KNOWN_SERVICE_SCOPES`; client `hours-api` in `SERVICE_CLIENTS`
  with that scope — in production **only after the new auth is live** (ADR-0076: an unknown scope
  stops auth).

## Test strategy

Backends: `bun test` with each service's harness. hours-api gets its own (`test-support/world.ts`,
and `hosts.ts` playing projects-api, crm-api, activities-api and meetings-api, scriptable per
test), against a scratch `DATABASE_URL` (backend tests truncate dev databases). Frontends: Vitest
component tests. E2E: `shell/e2e/hours.spec.ts` through the host.

| AC | Level | Test |
|---|---|---|
| AC-1.1 | integration + e2e | employee with no tool grant `POST` a `none` entry → 201, listed by `GET whose=mine`; e2e records one from `/hours` |
| AC-1.2 | unit + integration + DB | 0, 15, 45, 1470 → 422 `invalid_minutes`; 30 and 1440 → 201; raw insert breaks `time_entry_minutes` |
| AC-1.3 | unit + integration | `todayIn("Europe/Zurich")` across the UTC midnight boundary; tomorrow → 422 `future_day` |
| AC-1.4 | integration | 6 h on an internal project + 6 h on a client project the same day → both 201; `groupBy=project` gives 6 h each, the person's day total is 12 h |
| AC-1.5 | integration | owner `PATCH`es and `DELETE`s an entry dated 400 days ago → 200 / 204 |
| AC-1.6 | integration | another user (admin included) `PATCH`/`DELETE` → 404; read-all holder → 403 `owner_only`; `POST` with `userId` → 400; row unchanged |
| AC-1.7 | integration + DB | 1001 characters → 422 `note_too_long`; 1000 → 201; CHECK holds |
| AC-1.8 | contract | strict schema: `start`/`end` keys → 400; OpenAPI view has no time-of-day member |
| AC-2.1 | unit + DB | every target / category / work-type combination: allowed → 201, others → 400/422; CHECK rejects raw rows |
| AC-2.2 | integration (fake projects) | caller in `assignees` → 201 in every state, `writable:false` ignored; readable but not in `assignees` → 403 `not_on_project`; `reader:false` → 404 |
| AC-2.3 | integration (fake crm + activities) + crm-api integration | involved as owner, technical contact, task assignee, participant → 201; other CRM reader → 403 `not_involved_in_deal`; won and lost deals accepted. crm-api: resolve `deal` returns owner + technical, leaves out an override row's admin, `reader:false` without `crm:access` |
| AC-2.4 | integration | entry created, caller then removed from `assignees`: still listed and counted; a `PATCH` now → 403; `DELETE` → 204 |
| AC-2.5 | integration (fake meetings) + meetings-api integration | creator or participant → 201; host-only reader (absent from `GET /meetings?ids=`) → 404. meetings-api: the `ids` filter returns only the caller's meetings |
| AC-2.6 | integration + meetings-api integration | meeting entries grouped under deal A; fake system route relinks to B → totals move to B. meetings-api: the system route answers `{id, host}` only; a user JWT, a wrong scope or a wrong sub → identical 401 |
| AC-2.7 | integration + activities-api integration | activity of another project/deal → 422 `activity_not_allowed`; on `meeting`/`none` → 422; a task of the same project → 201. activities-api: `ids` filter returns readable activities only, omits missing and unreadable alike |
| AC-2.8 | integration | two people, three days, one task → all 201, same `activity.id` in the list |
| AC-2.9 | integration | fake activities-api stops returning the pointed id → entry still listed and counted, `activity: null`; owner changes the note → stored pointer cleared, 200 |
| AC-2.10 | integration | missing vs unreadable project, deal, meeting → byte-identical 404 bodies |
| AC-2.11 | integration | each source down / timeout / 500 during a write → 503 `host_unavailable`, no row written |
| AC-3.1 | integration | holder creates, renames, retires a category and a work type in each list |
| AC-3.2 | integration + DB | `DELETE /time-categories/{id}` and `/work-types/{id}` → 404, row present; raw delete of a used row blocked by `Restrict` |
| AC-3.3 | integration | non-holder → 403 `time_list_manage_required`; `auth` down → 503 |
| AC-3.4 | integration | retired item absent from `GET /time-lists`, present with `includeRetired`; new entry with it → 422 `*_retired`; old entry still shows it, `retired: true` |
| AC-3.5 | integration | project entry with a deal work type → 422; meeting / none with a work type → 422; none without → 201 |
| AC-3.6 | integration | `tc-other` without note → 422 `note_required`; with a note → 201 |
| AC-3.7 | migration | a fresh test database holds exactly the A15 rows |
| AC-3.8 | component (hours-ui, admin-ui) | a name typed "Formazione" renders verbatim with `lang=en` and `lang=it` |
| AC-4.1 | component + e2e | list grouped by day with day totals; no "incomplete" marker in the DOM; no notification call |
| AC-4.2 | integration | `whose=all` or `userId` without the permission → 403 `read_all_required`; `whose=mine` never returns another person's row |
| AC-4.3 | integration | holder sees entries of `welld_ch` and `welld_it` users |
| AC-4.4 | integration + component | each filter narrows items and totals alike |
| AC-4.5 | integration | each `groupBy`; meeting entries under their deal; a `key: null` group for the rest |
| AC-4.6 | unit + component | `buildHoursWorkbook(items)` rows = items, the listed columns in order; export walks every page with the active filters |
| AC-4.7 | integration | each source down → entries still listed and counted, `visibility: "unavailable"`, source in `unavailable` |
| AC-4.8 | integration | the identities stub renames a person between two calls → the second list shows the new name |
| AC-4.9 | unit (operai-ui) | `formatDuration` `short`: 150 min → "2 h 30", 30 min → "30 min", both locales |
| AC-4.10 | integration + unit | holder without `crm:access` lists a deal entry → `visibility: "hidden"`, `label: null`, `activity.subject: null`, minutes counted; the workbook writes the type without a name |
| AC-5.1 | e2e + shell unit | a user with only `employee` opens `/hours` (no access redirect) and records a `none` entry; `tools.test` asserts `/hours` is not a tool |
| AC-5.2 | auth seed contract | catalog `hours` has exactly the two actions with `[]` conditions; admin is the only holder, unconditioned; a role rule `time-entry:read-all` is accepted by `roles.routes` |
| AC-5.3 | matrix | every hours-api route is classified and answers 401 without a credential |
| AC-5.4 | integration | `auth` down: `whose=all` → 503 `authz_unavailable`; `whose=mine` → 200 |
| AC-5.5 | component | `catalogGaps` parity and `noHardcodedStrings` in hours-ui, admin-ui, shell |

All 42 ACs of the spec (41 + AC-4.10) have a row.

## Risks

- **R1 A new service to run.** Database, Railway service, env contract, deploy order, on-call.
  *Mitigation:* `provision-tool.sh hours` creates the standard pair; env-doctor carries the
  contract. *Early check:* `provision-tool.sh hours` without `--apply` and `mise run env:doctor`
  green before the first deploy.
- **R2 Write and list latency.** A deal booking may ask crm-api and up to 10 pages of
  activities-api; a list page asks up to six sources. *Mitigation:* the owner/technical answer
  short-circuits the activities scan; per-source batching in parallel, 2 s each, fail soft on
  reads; pages ≤ 500. *Early check:* p95 of `POST` on a deal and of a month's `GET whose=all` in the
  e2e stack; revisit above 800 ms (an activities-api `involvedIn=me` filter is the next step).
- **R3 PR #9 overlap.** Additive edits in files PR #9 also changes: `auth/src/authz/seed.ts`,
  `auth/src/system/serviceClients.ts`, `tools/env-doctor/manifest.ts`, `admin-ui/src/App.tsx`.
  *Mitigation:* edits in new blocks. *Early check:* `git merge-tree` against
  `feat/projects-handoff` before the auth task merges.
- **R4 Managers see less than they expect** (AC-4.10). A holder without CRM or Projects access sees
  hours on deals/projects without names. *Mitigation:* the UI says "not visible to you" with the
  type.
- **R5 Picker offers projects/deals the person may not book on.** Search uses existing list
  endpoints; the server refuses with a clear 403. *Mitigation:* copy names the reason; a member-only
  project filter can follow PR #9 (projects-api is not touched here).
- **R6 Deleted activity vs unreachable activities-api.** Only an answer that omits the id clears a
  pointer; a 503 never does. *Early check:* AC-2.9 test plus a 503 variant.
- **R7 Deploy order.** auth (catalog, scope) → activities-api, crm-api, meetings-api → hours-api →
  admin-ui, hours-ui, shell. hours-api treats a 404 from a not-yet-deployed route as
  `unavailable`, so a wrong order degrades, never breaks.

## Security

**Security-sensitive: YES** — schedule the owasp-reviewer in parallel with QE.

- Personal data about workers (what each person worked on, every day) and a read-everyone
  permission; Italian and Swiss rules on monitoring workers (O3, accepted as risk).
- A new resource server with a new authorization path (oversight) and an admin capability, both
  failing closed; IDOR surface on `PATCH/DELETE /time-entries/{id}` (scoped to `sub`, identical
  404).
- A new service client and scope (`meetings.hosts.read`), and meetings-api's first `/system/*`
  route — it must answer only `{id, host}` (ADR-0058: no content to any role).
- Cross-service bookability checks run as the caller and fail closed; labels follow the viewer's
  own access (AC-4.10).
- The export file is built in the browser from data the viewer can already read; no server file.

## ADR candidates

- **ADR-0088** (`docs/adr/0088-hours-api-time-entries-own-service-hours-catalog.md`) — Time entries
  live in a new service, `hours-api`, with their own database; a new `hours` catalog with **no
  access resource** carries `time-entry:read-all` (an ADR-0075 oversight path, the only `auth` call
  on reads) and `time-list:manage`; no `If-Match` on single-writer records. Rejected: inside
  activities-api (one service and one maintenance switch for two domains — the user's call, D36),
  inside projects-api or crm-api (a deal or a category has no project, a project no company deal),
  a gated `hours:access` (contradicts AC-5.1), `requireAdmin`-style list management (cannot be
  granted, ADR-0075 option C).
- **ADR-0089** (`docs/adr/0089-time-bookability-asked-of-owners-meeting-hosts-system-route.md`) —
  Whether a person may book is asked of each owner as the caller at write time (projects
  `assignees`, crm-api resolve `entityType: "deal"` with `involved`, activities-api's list incl. a
  new `ids` filter, meetings-api `GET /meetings?ids=`), failing closed; a meeting's current deal is
  read live from meetings-api `GET /system/meetings/hosts` (scope `meetings.hosts.read`,
  content-free). Rejected: activities-api's meeting mirror as the source (a failed `linked` notice
  is not retried and the mirror can be deleted by hand), storing the deal on the entry (AC-2.6
  relink), `GET /deals/{id}` per write (no batch, no labels), a new `/time-host/v1/resolve` contract
  next to the host resolve (two contracts for one question), giving read-all holders access to
  meetings.
- **ADR-0090** (`docs/adr/0090-hours-ui-ungated-remote.md`) — Hours get their own remote, mounted
  ungated at `/hours` and absent from `TOOLS` (the ADR-0009/0045 shape without a gated half).
  Rejected: an ungated entry in projects-ui (wrong domain; PR #9 rewrites projects-ui), a
  shell-native screen (ADR-0009: no tool logic in the shell), a `TOOLS` entry behind `hours:access`.
